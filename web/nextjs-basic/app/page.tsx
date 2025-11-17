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
      nextPlayTime.current = ctx.currentTime + jitterTarget;
    }

    // Schedule as long as we have chunks
    while (audioQueue.current.length > 0) {
      const pcm16 = audioQueue.current.shift()!;
      const f32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        f32[i] = pcm16[i] / 32768;
      }

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
      const apiKey = process.env.NEXT_PUBLIC_REALTIME_API_KEY!;
      const wsUrl = process.env.NEXT_PUBLIC_REALTIME_WS_URL!;

      const agent = new RealtimeAgent({
        name: 'Assistant',
        voice: 'lila',
        instructions: 'You are a nonchalant assistant, who only replies in really short phrases.'
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

      // ---------- AUDIO INPUT ----------
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 24000 });
      audioContextRef.current = ctx;

      await ctx.audioWorklet.addModule('/pcm16-worklet.js');

      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, 'pcm16-worklet');

      worklet.port.onmessage = (e) => {
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
