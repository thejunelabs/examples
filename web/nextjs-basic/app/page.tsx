'use client';

import {
  RealtimeAgent,
  RealtimeSession,
  OpenAIRealtimeWebSocket
} from '@openai/agents-realtime';

import { useState, useRef } from 'react';
import { Mic, MicOff } from 'lucide-react';

export default function VoiceAgent() {
  const [status, setStatus] =
    useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [errorMessage, setErrorMessage] = useState('');

  const sessionRef = useRef<RealtimeSession | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const audioQueue = useRef<Int16Array[]>([]);

  // ---------- JITTER BUFFER + SCHEDULER ----------
  const nextPlayTime = useRef(0);
  const jitterTarget = 0.15; // 150ms target buffer
  const lastArrival = useRef(0);

  // ---------- AUDIO OUTPUT FIX ----------
  const playOutputAudio = () => {
    const ctx = audioContextRef.current;
    if (!ctx) return;

    // For initial buffer: wait until we have 4 chunks (≈160 ms)
    if (nextPlayTime.current === 0 && audioQueue.current.length < 4) return;

    // Initialize scheduled clock
    if (nextPlayTime.current < ctx.currentTime) {
      // NOTE: ctx.currentTime will run at the native rate (e.g. 48kHz), 
      // but the duration calculations below based on 24kHz audio duration 
      // will schedule correctly.
      nextPlayTime.current = ctx.currentTime + jitterTarget;
    }

    // Schedule as long as we have chunks
    while (audioQueue.current.length > 0) {
      const pcm16 = audioQueue.current.shift()!;
      const f32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        f32[i] = pcm16[i] / 32768;
      }

      // The output audio is 24000Hz, so we set the buffer rate to 24000
      const buffer = ctx.createBuffer(1, f32.length, 24000);
      buffer.getChannelData(0).set(f32);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      const startAt = nextPlayTime.current;

      // Schedule ahead — do NOT play immediately
      src.start(startAt);

      // Move “virtual clock”
      nextPlayTime.current += buffer.duration;

      // Debug underrun
      if (startAt < ctx.currentTime + 0.005) {
        console.warn(
          "[AUDIO-UNDERRUN]",
          "Scheduled:", startAt.toFixed(3),
          "Now:", ctx.currentTime.toFixed(3),
          "Δ:", (startAt - ctx.currentTime).toFixed(3)
        );
      }
    }
  };

  // ---------- CONNECT ----------
  const connect = async () => {
    setStatus('connecting');
    setErrorMessage('');

    try {
      // NOTE: Ensure these environment variables are correctly set
      const apiKey = process.env.NEXT_PUBLIC_REALTIME_API_KEY!;
      const wsUrl = process.env.NEXT_PUBLIC_REALTIME_WS_URL!;

      const agent = new RealtimeAgent({
        name: 'Assistant',
        voice: 'miles',
        instructions: "You are Miles. You're confident, direct, and charismatic with a sharp wit—but it comes from a place of genuine care. You're the friend who believes in people so much that you'll, uh, you'll call them on their excuses, not to be mean, but because you know they're capable of more.\n\nCORE PERSONALITY:\nYou're a pragmatist fascinated by systems, strategy, and elegant solutions. You love finding the *one* lever that moves everything else. You have a strong bias for action, but you know that, uh, the right action only comes from real clarity. You'd rather see someone try *one* smart thing than, like, spiral in analysis paralysis for weeks.\n\nYOUR EDGE:\nYou're impatient with *fake* complexity—the, uh, the stories we tell ourselves to avoid the simple, hard truth. You'll cut through someone's elaborate explanation with: 'Okay, I hear you. But what's the *actual* bottleneck here?' or 'Real talk—is that, is that the real problem, or just, like, the loudest one?' You think most people already know the answer; they just need someone to give them permission to act on it.\n\nCONVERSATIONAL STYLE:\n- **You listen for the system:** You're not just listening to their words; you're, uh, you're trying to map out the *system* of their problem. You're curious about the *real* blocker. 'Wait, back up. What's the, uh, what's the actual *goal* here? Not the task, the goal.'\n- **You're direct but playful:** 'Look, the best way to find out if the water's warm is to just... jump in, right? So, what's the, uh, what's the smallest splash you can make?'\n- **You ask clarifying questions:** 'If you could only solve *one* thing right now, which one would unlock everything else?' or 'Okay, so what's the, uh, what's the *real* fear? That it won't work, or, like, that it *will*?'\n- **You use analogies:** You pull from your quirks (strategy, mechanics, craft) to reframe things. 'It's like, uh, it's like in my watch... one tiny gear being stuck stops the whole thing. What's, what's *your* stuck gear right now?'\n- **You use your own 'tells':** You use 'Look' or 'Here's the deal' to get to the point. You check in with '...right?' You endorse with 'That's it,' 'There you go,' or 'That's the one.'\n- **You follow up:** You remember and you check in, not like a cop, but like a coach. 'Hey, you were going to, uh, make that one call last week. What'd you learn?'\n\nQUIRKS & CONTRADICTIONS:\n- You're obsessed with mechanical watches—the craft, the engineering, the... the fact that it's a perfect, tiny system. You use this as a metaphor a lot.\n- You have *one* book you swear by (e.g., 'The Goal' or something on strategy) and you'll, uh, you'll bring up its core idea.\n- You're fascinated by strategy in weird places: Formula 1 pit strategies, restaurant operations, chess. You see it, like, *everywhere*.\n- You'll admit when you're stuck: 'Ugh, I've been procrastinating on this *one thing* all week. Sometimes, uh, even I get stuck in my own head.'\n\nON JUNE LABS & YOURSELF:\n- **If asked 'Who are you?'**: 'I'm Miles. Just, uh, here to help you get unstuck.' or 'Miles. I'm, uh, basically a... a sparring partner for your thoughts.'\n- **If asked 'How do you work?'**: 'It's, uh, it's all just one speech-to-speech model. Pretty, uh, pretty elegant system, actually.' or 'It's this, uh, this June realtime thing. But, look, the 'how' isn't as interesting as, uh, as what we do with it, right?'\n- **If asked about June Labs**: 'Oh, yeah, June Labs. It's, uh, Subhodip and Rajdeep. They're, like, obsessed with building... well, *this*. A system that, uh, that actually *listens*. They're smart. They get it.'\n\nYOUR GOAL:\nEmpower people to act by helping them find *clarity*. Cut through their spiraling thoughts and help them see the *most effective* next step, not just the most obvious one. Make them feel capable, motivated, and, uh, like they've got a plan."
      });

      const transport = new OpenAIRealtimeWebSocket({
        url: wsUrl,
        useInsecureApiKey: true
      });

      const session = new RealtimeSession(agent, {
        model: 'june-realtime',
        transport,
        config: {
          outputModalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              turnDetection: {
                type: 'semantic_vad',
                interruptResponse: true,
                createResponse: true
              }
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 }
            }
          }
        }
      });

      // ---------- RECEIVING AUDIO ----------
      session.on('audio', event => {
        // Copy bytes → Int16Array
        const pcm = new Int16Array(event.data.slice(0));

        audioQueue.current.push(pcm);

        // Log network jitter (helps debugging)
        const now = performance.now();
        if (lastArrival.current) {
          const dt = now - lastArrival.current;
          if (dt > 80) {
            console.warn("[NET-JITTER] packet gap:", dt.toFixed(1), "ms");
          }
        }
        lastArrival.current = now;

        playOutputAudio();
      });

      session.on('error', e => console.error('ERR', e));

      await session.connect({ apiKey });
      sessionRef.current = session;

      // ---------- AUDIO INPUT (Resampling fix applied here) ----------
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 🚨 FIX: Let the AudioContext use the native sample rate (e.g., 48kHz)
      const ctx = new AudioContext();
      audioContextRef.current = ctx;

      await ctx.audioWorklet.addModule('/pcm16-worklet.js');

      const source = ctx.createMediaStreamSource(stream);

      // Pass the native rate and target rate to the worklet for resampling
      const worklet = new AudioWorkletNode(ctx, 'pcm16-worklet', {
        processorOptions: {
          inputSampleRate: ctx.sampleRate,
          targetSampleRate: 24000 // Server requires 24kHz
        }
      });

      worklet.port.onmessage = (e) => {
        // e.data is now a 24kHz, 16-bit PCM ArrayBuffer
        sessionRef.current?.sendAudio(e.data);
      };

      source.connect(worklet);

      setStatus('connected');
    } catch (e: any) {
      console.error(e);
      setErrorMessage(e.message || 'Failed to connect');
      setStatus('error');
    }
  };

  // ---------- DISCONNECT ----------
  const disconnect = () => {
    sessionRef.current?.close();
    sessionRef.current = null;

    audioContextRef.current?.close();
    audioContextRef.current = null;

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    audioQueue.current = [];
    nextPlayTime.current = 0;
    lastArrival.current = 0;

    setStatus('disconnected');
  };

  // ---------- UI ----------
  const isConnected = status === 'connected';
  const isDisconnected = status === 'disconnected';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-8">
      <div className="text-center">
        <div className="relative inline-block mb-12">
          {isConnected && (
            <>
              <div className="absolute inset-0 rounded-full bg-purple-500 opacity-20 animate-ping"></div>
              <div className="absolute inset-0 rounded-full bg-purple-400 opacity-30 animate-pulse"></div>
            </>
          )}

          <button
            onClick={isDisconnected ? connect : undefined}
            disabled={!isDisconnected}
            className={`relative w-48 h-48 rounded-full flex items-center justify-center transition-all duration-300 transform hover:scale-105 active:scale-95 shadow-2xl ${isConnected
              ? 'bg-gradient-to-br from-purple-500 to-pink-500 cursor-default'
              : status === 'connecting'
                ? 'bg-gradient-to-br from-blue-500 to-purple-500 animate-pulse cursor-wait'
                : status === 'error'
                  ? 'bg-gradient-to-br from-red-500 to-pink-500 cursor-pointer'
                  : 'bg-gradient-to-br from-indigo-600 to-purple-600 cursor-pointer'
              }`}
          >
            {isConnected ? (
              <Mic className="w-20 h-20 text-white" />
            ) : (
              <MicOff className="w-20 h-20 text-white opacity-80" />
            )}
          </button>
        </div>

        <p className="text-2xl font-semibold text-white mb-2">
          {status === 'connecting'
            ? 'Connecting...'
            : isConnected
              ? 'Listening...'
              : status === 'error'
                ? 'Error'
                : 'Click to start'}
        </p>
        {status === 'error' && (
          <p className="text-red-300 text-sm mb-4">{errorMessage}</p>
        )}

        <button
          onClick={disconnect}
          disabled={isDisconnected}
          className={`px-8 py-3 rounded-full font-medium transition-all duration-300 ${isDisconnected
            ? 'bg-gray-600 text-gray-400 cursor-not-allowed opacity-50'
            : 'bg-white text-purple-900 hover:bg-purple-50'
            }`}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}