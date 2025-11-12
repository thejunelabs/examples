import asyncio
from dotenv import load_dotenv
import os
import threading
from typing import Any
import sys
import queue

import numpy as np
import sounddevice as sd
from agents import function_tool
from agents.realtime import (
    RealtimeAgent,
    RealtimePlaybackTracker,
    RealtimeRunner,
    RealtimeSession,
    RealtimeSessionEvent,
)
from agents.realtime.model import RealtimeModelConfig

# Audio configuration
CHUNK_LENGTH_S = 0.04  # 40ms aligns with realtime defaults
SAMPLE_RATE = 24000
FORMAT = np.int16
CHANNELS = 1
ENERGY_THRESHOLD = 0.015  # RMS threshold for barge‑in while assistant is speaking
PREBUFFER_CHUNKS = 3  # initial jitter buffer (~120ms with 40ms chunks)
FADE_OUT_MS = 12  # short fade to avoid clicks when interrupting

# Set up logging for OpenAI agents SDK
# logging.basicConfig(
#     level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
# )
# logger.logger.setLevel(logging.ERROR)


@function_tool
def get_weather(city: str) -> str:
    """Get the weather in a city.
    Args:
        city (str): The name of the city to get the weather for.
    """
    return f"The weather in {city} is sunny."


agent = RealtimeAgent(
    name="Assistant",
    instructions="You are a nonchalant assistant, who only replies in really short phrases.",
    tools=[get_weather],
)


def _truncate_str(s: str, max_length: int) -> str:
    if len(s) > max_length:
        return s[:max_length] + "..."
    return s


class NoUIDemo:
    def __init__(self) -> None:
        self.session: RealtimeSession | None = None
        self.audio_stream: sd.InputStream | None = None
        self.audio_player: sd.OutputStream | None = None
        self.recording = False

        # Playback tracker lets the model know our real playback progress
        self.playback_tracker = RealtimePlaybackTracker()
        self.playback_tracker.set_audio_format("pcm16")

        # Audio output state for callback system
        # Store tuples: (samples_np, item_id, content_index)
        # Use an unbounded queue to avoid drops that sound like skipped words.
        self.output_queue: queue.Queue[Any] = queue.Queue(maxsize=0)
        self.interrupt_event = threading.Event()
        self.current_audio_chunk: (
            tuple[np.ndarray[Any, np.dtype[Any]], str, int] | None
        ) = None
        self.chunk_position = 0
        self.bytes_per_sample = np.dtype(FORMAT).itemsize

        # Jitter buffer and fade-out state
        self.prebuffering = False
        self.prebuffer_target_chunks = PREBUFFER_CHUNKS
        self.fading = False
        self.fade_total_samples = 0
        self.fade_done_samples = 0
        self.fade_samples = int(SAMPLE_RATE * (FADE_OUT_MS / 1000.0))

    def _output_callback(self, outdata, frames: int, time, status) -> None:
        """Callback for audio output - handles continuous audio stream from server."""
        if status:
            print(f"Output callback status: {status}")

        # CRITICAL: Add comprehensive debug logging FIRST
        print(
            f"[CALLBACK] queue_size={self.output_queue.qsize()}, "
            f"prebuffering={self.prebuffering}, "
            f"has_chunk={self.current_audio_chunk is not None}, "
            f"chunk_pos={self.chunk_position}"
        )

        # Handle interruption
        if self.interrupt_event.is_set():
            outdata.fill(0)
            while not self.output_queue.empty():
                try:
                    self.output_queue.get_nowait()
                except queue.Empty:
                    break
            self.current_audio_chunk = None
            self.chunk_position = 0
            # DON'T set prebuffering=True here
            self.interrupt_event.clear()
            return

        # Check prebuffering ONCE at the start, not in the loop
        if self.prebuffering:
            if self.output_queue.qsize() < self.prebuffer_target_chunks:
                outdata.fill(0)
                return
            self.prebuffering = False
            print("[CALLBACK] Prebuffering complete, starting playback")

        # Now fill the output buffer
        outdata.fill(0)
        samples_filled = 0

        while samples_filled < len(outdata):
            # Get next chunk if needed
            if self.current_audio_chunk is None:
                try:
                    self.current_audio_chunk = self.output_queue.get_nowait()
                    self.chunk_position = 0
                    print(
                        f"[CALLBACK] Got new chunk from queue, remaining: {self.output_queue.qsize()}"
                    )
                except queue.Empty:
                    print(
                        f"[CALLBACK] Queue empty, filled {samples_filled}/{len(outdata)} samples"
                    )
                    break

            # Copy data from current chunk
            samples, item_id, content_index = self.current_audio_chunk
            remaining_output = len(outdata) - samples_filled
            remaining_chunk = len(samples) - self.chunk_position
            samples_to_copy = min(remaining_output, remaining_chunk)

            if samples_to_copy > 0:
                chunk_data = samples[
                    self.chunk_position : self.chunk_position + samples_to_copy
                ]
                outdata[samples_filled : samples_filled + samples_to_copy, 0] = (
                    chunk_data
                )
                samples_filled += samples_to_copy
                self.chunk_position += samples_to_copy

                # Report to playback tracker
                try:
                    self.playback_tracker.on_play_bytes(
                        item_id=item_id,
                        item_content_index=content_index,
                        bytes=chunk_data.tobytes(),
                    )
                except Exception as e:
                    print(f"[CALLBACK] Playback tracker error: {e}")

                # Reset if chunk fully consumed
                if self.chunk_position >= len(samples):
                    print("[CALLBACK] Chunk fully consumed")
                    self.current_audio_chunk = None
                    self.chunk_position = 0

    async def run(self) -> None:
        print("Connecting, may take a few seconds...")

        # Initialize audio player with callback
        chunk_size = int(SAMPLE_RATE * CHUNK_LENGTH_S)
        self.audio_player = sd.OutputStream(
            channels=CHANNELS,
            samplerate=SAMPLE_RATE,
            dtype=FORMAT,
            callback=self._output_callback,
            blocksize=chunk_size,  # Match our chunk timing for better alignment
        )
        self.audio_player.start()

        try:
            runner = RealtimeRunner(agent)
            # Attach playback tracker and enable server‑side interruptions + auto response.

            model_config: RealtimeModelConfig = {
                "url": os.environ.get("REALTIME_WS_URL"),
                "headers": {"custom-auth": os.environ.get("REALTIME_API_KEY")},
                "playback_tracker": self.playback_tracker,
                "initial_model_settings": {
                    "model_name": "june-realtime",
                    "voice": "sofia",
                    "input_audio_format": "pcm16",
                    "output_audio_format": "pcm16",
                    "modalities": ["audio"],
                    "turn_detection": {
                        "type": "semantic_vad",
                        "interrupt_response": True,
                        "create_response": True,
                    },
                },
            }
            async with await runner.run(model_config=model_config) as session:
                self.session = session
                print("Connected. Starting audio recording...")

                # Start audio recording
                await self.start_audio_recording()
                print(
                    "Audio recording started. You can start speaking - expect lots of logs!"
                )

                # Process session events
                async for event in session:
                    await self._on_event(event)

        finally:
            # Clean up audio player
            if self.audio_player and self.audio_player.active:
                self.audio_player.stop()
            if self.audio_player:
                self.audio_player.close()

        print("Session ended")

    async def start_audio_recording(self) -> None:
        """Start recording audio from the microphone."""
        # Set up audio input stream
        self.audio_stream = sd.InputStream(
            channels=CHANNELS,
            samplerate=SAMPLE_RATE,
            dtype=FORMAT,
        )

        self.audio_stream.start()
        self.recording = True

        # Start audio capture task
        asyncio.create_task(self.capture_audio())

    async def capture_audio(self) -> None:
        """Capture audio from the microphone and send to the session."""
        if not self.audio_stream or not self.session:
            return

        # Buffer size in samples
        read_size = int(SAMPLE_RATE * CHUNK_LENGTH_S)

        try:
            # Simple energy-based barge-in: if user speaks while audio is playing, interrupt.
            def rms_energy(samples: np.ndarray[Any, np.dtype[Any]]) -> float:
                if samples.size == 0:
                    return 0.0
                # Normalize int16 to [-1, 1]
                x = samples.astype(np.float32) / 32768.0
                return float(np.sqrt(np.mean(x * x)))

            while self.recording:
                # Check if there's enough data to read
                if self.audio_stream.read_available < read_size:
                    await asyncio.sleep(0.01)
                    continue

                # Read audio data
                data, _ = self.audio_stream.read(read_size)

                # Convert numpy array to bytes
                audio_bytes = data.tobytes()

                # Smart barge‑in: if assistant audio is playing, send only if mic has speech.
                assistant_playing = (
                    self.current_audio_chunk is not None
                    or not self.output_queue.empty()
                )
                if assistant_playing:
                    # Compute RMS energy to detect speech while assistant is talking
                    samples = data.reshape(-1)
                    if rms_energy(samples) >= ENERGY_THRESHOLD:
                        # Locally flush queued assistant audio for snappier interruption.
                        self.interrupt_event.set()
                        await self.session.send_audio(audio_bytes)
                else:
                    await self.session.send_audio(audio_bytes)

                # Yield control back to event loop
                await asyncio.sleep(0)

        except Exception as e:
            print(f"Audio capture error: {e}")
        finally:
            if self.audio_stream and self.audio_stream.active:
                self.audio_stream.stop()
            if self.audio_stream:
                self.audio_stream.close()

    async def _on_event(self, event: RealtimeSessionEvent) -> None:
        """Handle session events."""
        try:
            if event.type == "agent_start":
                print(f"Agent started: {event.agent.name}")
            elif event.type == "agent_end":
                print(f"Agent ended: {event.agent.name}")
            elif event.type == "handoff":
                print(f"Handoff from {event.from_agent.name} to {event.to_agent.name}")
            elif event.type == "tool_start":
                print(f"Tool started: {event.tool.name}")
            elif event.type == "tool_end":
                print(f"Tool ended: {event.tool.name}; output: {event.output}")
            elif event.type == "audio_end":
                print("Audio ended")
            elif event.type == "audio":
                # Enqueue audio for callback-based playback with metadata
                np_audio = np.frombuffer(event.audio.data, dtype=np.int16)
                # Non-blocking put; queue is unbounded, so drops won’t occur.
                self.output_queue.put_nowait(
                    (np_audio, event.item_id, event.content_index)
                )
            elif event.type == "audio_interrupted":
                print("Audio interrupted")
                # Begin graceful fade + flush in the audio callback and rebuild jitter buffer.
                # self.prebuffering = True
                self.interrupt_event.set()
            elif event.type == "error":
                print(f"Error: {event.error}")
            elif event.type == "history_updated":
                pass  # Skip these frequent events
            elif event.type == "history_added":
                pass  # Skip these frequent events
            elif event.type == "raw_model_event":
                print(f"Raw model event: {_truncate_str(str(event.data), 200)}")
            else:
                print(f"Unknown event type: {event.type}")
        except Exception as e:
            print(f"Error processing event: {_truncate_str(str(e), 200)}")


if __name__ == "__main__":
    load_dotenv()
    demo = NoUIDemo()
    try:
        asyncio.run(demo.run())
    except KeyboardInterrupt:
        print("\nExiting...")
        sys.exit(0)
