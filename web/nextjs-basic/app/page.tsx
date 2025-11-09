'use client';

import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebSocket } from '@openai/agents-realtime';
import { useState, useRef } from 'react';
import { Mic, MicOff } from 'lucide-react';

export default function VoiceAgent() {
  const [status, setStatus] = useState('disconnected');
  const [errorMessage, setErrorMessage] = useState('');
  const [session, setSession] = useState<RealtimeSession | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioQueueRef = useRef<Int16Array[]>([]);
  const isPlayingRef = useRef(false);

  const playAudioQueue = async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    if (!audioContextRef.current) return;

    isPlayingRef.current = true;
    const audioContext = audioContextRef.current;

    while (audioQueueRef.current.length > 0) {
      const pcm16Data = audioQueueRef.current.shift()!;

      const float32Data = new Float32Array(pcm16Data.length);
      for (let i = 0; i < pcm16Data.length; i++) {
        float32Data[i] = pcm16Data[i] / 32768.0;
      }

      const audioBuffer = audioContext.createBuffer(1, float32Data.length, 24000);
      audioBuffer.getChannelData(0).set(float32Data);

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);

      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start();
      });
    }

    isPlayingRef.current = false;
  };

  const connectToAgent = async () => {
    setStatus('connecting');
    setErrorMessage('');

    try {
      // Use WebSocket URL from environment variable
      const wsUrl = process.env.REALTIME_WS_URL;

      const agent = new RealtimeAgent({
        name: 'Assistant',
        instructions: 'You are a nonchalant assistant, who only replies in really short phrases.',
        voice: 'sofia',
      });

      const transport = new OpenAIRealtimeWebSocket({
        useInsecureApiKey: true,
        url: wsUrl
      });

      const newSession = new RealtimeSession(agent, {
        model: 'june-realtime',
        transport: transport,
        config: {
          outputModalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              turnDetection: {
                type: 'semantic_vad',
                interruptResponse: true,
                createResponse: true,
              }
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 }
            }
          }
        }
      });

      newSession.on('audio', (event) => {
        const pcm16 = new Int16Array(event.data);
        audioQueueRef.current.push(pcm16);
        playAudioQueue();
      });

      await newSession.connect({
        apiKey: process.env.REALTIME_API_KEY || "",
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
        }
        newSession.sendAudio(pcm16.buffer);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      setSession(newSession);
      setStatus('connected');
    } catch (error) {
      setStatus('error');
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      setErrorMessage(errorMsg);
      console.error('Connection failed:', error);

      // Provide helpful error messages
      if (errorMsg.includes('WebSocket') || error instanceof Event) {
        setErrorMessage('Cannot connect to localhost:8000. Is the server running? If on HTTPS, the server must support WSS.');
      }
    }
  };

  const disconnect = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (session) {
      session.close();
      setSession(null);
    }
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    setStatus('disconnected');
  };

  const getStatusText = () => {
    switch (status) {
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return 'Listening - Start talking!';
      case 'error':
        return 'Connection failed';
      default:
        return 'Click to start';
    }
  };

  const getStatusSubtext = () => {
    if (status === 'error' && errorMessage) {
      return errorMessage;
    }
    return isConnected ? 'Voice agent is active' : 'Ready to connect';
  };

  const isConnected = status === 'connected';
  const isDisconnected = status === 'disconnected';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-8">
      <div className="text-center">
        {/* Main circle button */}
        <div className="relative inline-block mb-12">
          {/* Pulsing rings when connected */}
          {isConnected && (
            <>
              <div className="absolute inset-0 rounded-full bg-purple-500 opacity-20 animate-ping" style={{ animationDuration: '2s' }}></div>
              <div className="absolute inset-0 rounded-full bg-purple-400 opacity-30 animate-pulse" style={{ animationDuration: '1.5s' }}></div>
            </>
          )}

          {/* Main button */}
          <button
            onClick={isDisconnected ? connectToAgent : undefined}
            disabled={!isDisconnected}
            className={`relative w-48 h-48 rounded-full flex items-center justify-center transition-all duration-300 transform hover:scale-105 active:scale-95 shadow-2xl ${isConnected
              ? 'bg-gradient-to-br from-purple-500 to-pink-500 cursor-default'
              : status === 'connecting'
                ? 'bg-gradient-to-br from-blue-500 to-purple-500 animate-pulse cursor-wait'
                : status === 'error'
                  ? 'bg-gradient-to-br from-red-500 to-pink-500 cursor-pointer'
                  : 'bg-gradient-to-br from-indigo-600 to-purple-600 cursor-pointer hover:from-indigo-500 hover:to-purple-500'
              }`}
          >
            {isConnected ? (
              <Mic className="w-20 h-20 text-white" />
            ) : (
              <MicOff className="w-20 h-20 text-white opacity-80" />
            )}
          </button>
        </div>

        {/* Status text */}
        <div className="mb-8">
          <p className="text-2xl font-semibold text-white mb-2">
            {getStatusText()}
          </p>
          <p className={`text-sm ${status === 'error' ? 'text-red-300' : 'text-purple-200'} max-w-md mx-auto`}>
            {getStatusSubtext()}
          </p>
        </div>

        {/* Disconnect button */}
        <button
          onClick={disconnect}
          disabled={isDisconnected}
          className={`px-8 py-3 rounded-full font-medium transition-all duration-300 ${isDisconnected
            ? 'bg-gray-600 text-gray-400 cursor-not-allowed opacity-50'
            : 'bg-white text-purple-900 hover:bg-purple-50 hover:shadow-lg transform hover:scale-105 active:scale-95'
            }`}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}