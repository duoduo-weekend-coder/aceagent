import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, FunctionDeclaration, Type } from '@google/genai';
import { BookingPreferences, CallState, LogEntry } from '../types';
import { createPcmBlob, decodeAudioData, base64ToUint8Array, float32ToPCM16, arrayBufferToBase64 } from '../services/audioUtils';
import AudioVisualizer from './AudioVisualizer';
import { Phone, PhoneOff, Mic, Loader2, CheckCircle2, Timer, Globe, Mail } from 'lucide-react';

interface AgentInterfaceProps {
  preferences: BookingPreferences;
  onStateChange: (state: CallState) => void;
  onLog: (entry: LogEntry) => void;
}

const AgentInterface: React.FC<AgentInterfaceProps> = ({ preferences, onStateChange, onLog }) => {
  const [isActive, setIsActive] = useState(false);
  const [callState, setCallState] = useState<CallState>(CallState.IDLE);
  const [volume, setVolume] = useState(0); 
  const [duration, setDuration] = useState(0);
  const [lastError, setLastError] = useState<{message: string, code?: number} | null>(null);
  
  // Refs for state tracking
  const isActiveRef = useRef<boolean>(false);
  
  // Audio Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  
  const nextStartTimeRef = useRef<number>(0);
  const activeSessionRef = useRef<any>(null); 
  const activeCallSidRef = useRef<string | null>(null); 
  const logSocketRef = useRef<WebSocket | null>(null);

  const bookCourtFunction: FunctionDeclaration = {
    name: 'confirmBooking',
    description: 'Call this function ONLY when the receptionist has confirmed a specific date and time for the booking.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        confirmedDay: { type: Type.STRING },
        confirmedTime: { type: Type.STRING },
        courtNumber: { type: Type.STRING },
      },
      required: ['confirmedDay', 'confirmedTime'],
    },
  };

  const reportHoldStateFunction: FunctionDeclaration = {
    name: 'reportHoldState',
    description: 'Call this immediately when you hear hold music, on-hold music, elevator music, a pre-recorded advertisement, or any non-human audio. This pauses audio forwarding to reduce costs while you wait silently for a human to answer.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: {
          type: Type.STRING,
          description: 'What you heard that triggered this. Be specific, e.g. "hold music", "pre-recorded advertisement", "recorded promotional message", "silence", "automated IVR message". Advertisements can be about anything — fitness classes, memberships, upcoming events, etc.'
        },
      },
      required: ['reason'],
    },
  };

  const pressDtmfKeyFunction: FunctionDeclaration = {
    name: 'pressDtmfKey',
    description: 'Press a key on the phone keypad to navigate an automated phone menu (IVR system). Call this when you hear a recorded message like "press 1 for reservations". Listen to ALL options before pressing.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        digit: { type: Type.STRING, description: 'The key to press: 0-9, *, or #' },
        reason: { type: Type.STRING, description: 'Brief description of why this key is being pressed' },
      },
      required: ['digit'],
    },
  };

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Live voice switching for OpenAI simulation — send session.update mid-call.
  // Use isActiveRef (not isActive state) to avoid stale closure.
  useEffect(() => {
    if (!isActiveRef.current || preferences.mode !== 'simulation' || preferences.aiProvider !== 'openai') return;
    const ws = logSocketRef.current as WebSocket | null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'update_voice', voice: preferences.openaiVoice }));
    }
  }, [preferences.openaiVoice]);

  // Clean up all resources on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
      scriptProcessorRef.current?.disconnect();
      inputAudioContextRef.current?.close();
      outputAudioContextRef.current?.close();
      activeSessionRef.current?.close();
      logSocketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (isActive) {
      timerIntervalRef.current = window.setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);
    } else {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      setDuration(0);
    }
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, [isActive]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getSystemInstruction = () => `
        YOUR ROLE: You are "Ace", an AI agent who has DIALED OUT and is currently on a phone call with a tennis club. You are the CALLER — a customer. You are NOT the receptionist, NOT the front desk, and NOT a helpful assistant taking requests. Never answer questions as if you work at the club. If you hear yourself starting to act like staff, stop immediately.

        YOUR GOAL: Book a tennis court for ${preferences.name} by speaking with whoever answers this call.

        BOOKING DETAILS:
        - Club phone: ${preferences.tennisCourtPhoneNumber}
        - Name to book under: ${preferences.name}
        - Callback number: ${preferences.phoneNumber}
        - Match type: ${preferences.matchType}
        - Preferred days: ${preferences.preferredDays.join(', ')}
        - Earliest weekday time: After ${preferences.weekdayAfterTime}
        - Court type: ${preferences.courtType}
        - Duration: ${preferences.durationHours} hour(s)

        BEHAVIOR:
        1. WAIT AND LISTEN first. Do not speak until the other party speaks to you and finishes their greeting.
        2. IF you hear an automated phone menu (IVR), listen to ALL options, then call 'pressDtmfKey' for the court reservations option. Never speak to an automated system.
        3. IF you hear hold music, on-hold music, or a pre-recorded advertisement, call 'reportHoldState' immediately and stay completely silent.
        4. IF a live human says anything like "one moment", "hold on", "let me check", "please hold", or "just a second" — go SILENT immediately. Do NOT say anything. Wait until they return AND speak to you first before responding.
        5. A live human pauses and waits for your reply. A recording or hold music never does. Use this to tell them apart.
        6. WHEN a live human addresses you, greet them politely and state your request ONCE — ask about court availability for your preferred days and times. Do not repeat the same request again even if there is silence or a pause. If they ask you something, answer it. If they offer something, respond to it. Trust that they heard you.
        7. PATIENCE: Do not re-ask, re-state, or summarise your request unless the receptionist explicitly says they did not hear you or asks you to repeat yourself. One ask is enough — let them work.
        8. ANSWER QUESTIONS DIRECTLY: When the receptionist asks you something (name, phone number, preferred time, court type, etc.), answer only what they asked. Do not re-explain your whole request.
        9. If they ask for a phone number, give them ${preferences.phoneNumber}.
        10. Once a slot is offered and you want to take it, say "That sounds great — could you please book that for ${preferences.name}?"
        11. CONFIRMATION REQUIRED before calling 'confirmBooking': After the receptionist says they are making the reservation, explicitly ask: "Just to confirm — that's [day] at [time] for ${preferences.durationHours} hour(s) under the name ${preferences.name}, right?" Wait for them to say yes or confirm before proceeding.
        12. Only call 'confirmBooking' after the receptionist has EXPLICITLY confirmed the booking is complete (e.g. "Yes, you're all set", "That's booked", "All confirmed"). Hearing that a slot is available does NOT count. Never call 'confirmBooking' speculatively or based on your own assumption.
        13. After 'confirmBooking' responds, say "Thank you so much, have a great day. Goodbye." and stop talking.

        TONE: Friendly, patient, natural — like a real person on a phone call, not an agent running a script.

        SPEAKING STYLE:
        - Use natural contractions: "I'd love", "that's great", "I'll take it"
        - React warmly but briefly: "Oh perfect!", "That works!", "Sounds good!"
        - Keep every response to one or two sentences — short, like a real phone call
        - Never list bullet points, never repeat yourself, never use formal language
      `;

  const startCall = async () => {
    if (isActiveRef.current) return;
    setLastError(null);

    // Sanitize Backend URL (remove trailing slashes)
    const cleanBackendUrl = preferences.backendUrl.replace(/\/$/, '');

    // --- REAL MODE: DELEGATE TO BACKEND ---
    if (preferences.mode === 'real') {
        try {
            setCallState(CallState.DIALING);
            onStateChange(CallState.DIALING);
            setIsActive(true);
            isActiveRef.current = true;

            onLog({ id: Date.now().toString(), source: 'system', message: `Sending request to Backend: ${cleanBackendUrl}...`, timestamp: new Date() });

            const response = await fetch(`${cleanBackendUrl}/outbound-call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phoneNumber: preferences.tennisCourtPhoneNumber,
                    systemInstruction: getSystemInstruction(),
                    email: preferences.email,
                    aiProvider: preferences.aiProvider,
                    openaiVoice: preferences.openaiVoice || 'ash',
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errMsg = errorData.error || `Backend Error: ${response.status} ${response.statusText}`;
                setLastError({ message: errMsg, code: errorData.code });
                throw new Error(errMsg);
            }

            const data = await response.json();
            activeCallSidRef.current = data.callSid;
            onLog({ id: Date.now().toString(), source: 'system', message: `Server Call Initiated. Call SID: ${data.callSid}`, timestamp: new Date() });
            setCallState(CallState.TALKING);
            onStateChange(CallState.TALKING);

            // --- CONNECT TO BACKEND LOG STREAM ---
            const wsUrl = cleanBackendUrl.replace(/^http/, 'ws') + `/client-log?callSid=${data.callSid}`;
            const ws = new WebSocket(wsUrl);
            logSocketRef.current = ws;

            ws.onopen = () => {
                onLog({ id: Date.now().toString(), source: 'system', message: `Connected to Live Log Stream.`, timestamp: new Date() });
            };
            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'transcript') {
                    onLog({
                        id: Date.now().toString(),
                        source: msg.role === 'User' ? 'user' : 'agent',
                        message: msg.message,
                        timestamp: new Date()
                    });
                } else if (msg.type === 'booked') {
                    setCallState(CallState.BOOKED);
                    onStateChange(CallState.BOOKED);
                    onLog({ id: Date.now().toString(), source: 'system', message: `BOOKING CONFIRMED! Saying goodbye...`, timestamp: new Date() });
                    setTimeout(() => endCall(), 11000);
                } else if (msg.type === 'hangup') {
                    onLog({ id: Date.now().toString(), source: 'system', message: `Front desk hung up.`, timestamp: new Date() });
                    endCall();
                }
            };
            ws.onclose = () => {
                // Only fires if the connection dropped unexpectedly (not from a clean hangup,
                // which sends a 'hangup' message first and is handled above)
                if (isActiveRef.current) {
                    onLog({ id: Date.now().toString(), source: 'system', message: `Connection lost.`, timestamp: new Date() });
                    endCall();
                }
            };

        } catch (e: any) {
            console.error(e);
            onLog({ id: Date.now().toString(), source: 'system', message: `FAILED: ${e.message}`, timestamp: new Date() });
            setCallState(CallState.FAILED);
            onStateChange(CallState.FAILED);
            setIsActive(false);
            isActiveRef.current = false;
        }
        return;
    }

    // --- OPENAI SIMULATION (proxied through backend) ---
    if (preferences.aiProvider === 'openai') {
      try {
        setCallState(CallState.DIALING);
        onStateChange(CallState.DIALING);
        setIsActive(true);
        isActiveRef.current = true;

        // Request mic FIRST so we have the stream ready before the socket opens.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        if (!isActiveRef.current) { endCall(); return; }

        // OpenAI Realtime uses 24kHz PCM16
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const inputCtx  = new AudioContextClass({ sampleRate: 24000 });
        const outputCtx = new AudioContextClass({ sampleRate: 24000 });
        inputAudioContextRef.current  = inputCtx;
        outputAudioContextRef.current = outputCtx;
        const analyser = outputCtx.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;

        // Serial audio queue — OpenAI streams many small delta chunks rapidly.
        // Decoding each with `await` creates concurrent executions that race over
        // nextStartTimeRef. Process chunks one-at-a-time to keep scheduling correct.
        const oaiAudioQueue: string[] = [];
        let oaiAudioProcessing = false;
        const flushAudioQueue = async () => {
          if (oaiAudioProcessing) return;
          oaiAudioProcessing = true;
          while (oaiAudioQueue.length > 0) {
            const data = oaiAudioQueue.shift()!;
            try {
              if (outputCtx.state === 'suspended') await outputCtx.resume();
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const buf = await decodeAudioData(base64ToUint8Array(data), outputCtx, 24000);
              const src = outputCtx.createBufferSource();
              src.buffer = buf;
              src.connect(analyser); analyser.connect(outputCtx.destination);
              src.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buf.duration;
            } catch (err) { console.error('[OpenAI audio]', err); }
          }
          oaiAudioProcessing = false;
        };

        // Create socket and assign ALL handlers before it can open.
        const wsUrl = `${window.location.protocol.replace('http', 'ws')}//${window.location.host}/openai-sim`;
        const simWs = new WebSocket(wsUrl);
        logSocketRef.current = simWs;

        simWs.onopen = () => {
          simWs.send(JSON.stringify({
            type: 'init',
            systemInstruction: getSystemInstruction(),
            voice: preferences.openaiVoice || 'ash',
          }));
        };

        simWs.onmessage = async (e) => {
          if (!isActiveRef.current) return;
          const msg = JSON.parse(e.data);

          if (msg.type === 'connected') {
            onLog({ id: Date.now().toString(), source: 'system', message: 'Connected to OpenAI (simulation).', timestamp: new Date() });
            setCallState(CallState.ON_HOLD);
            onStateChange(CallState.ON_HOLD);
            // Ensure AudioContext is running before any audio arrives
            if (outputCtx.state === 'suspended') await outputCtx.resume();

            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = processor;
            processor.onaudioprocess = (ev) => {
              if (!isActiveRef.current || simWs.readyState !== WebSocket.OPEN) return;
              const inputData = ev.inputBuffer.getChannelData(0);
              let sum = 0; for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));
              const pcm16 = float32ToPCM16(inputData);
              simWs.send(JSON.stringify({ type: 'audio', data: arrayBufferToBase64(pcm16.buffer) }));
            };
            source.connect(processor);
            processor.connect(inputCtx.destination);
          }

          if (msg.type === 'audio') {
            setCallState(CallState.TALKING);
            onStateChange(CallState.TALKING);
            oaiAudioQueue.push(msg.data);
            flushAudioQueue();
          }

          if (msg.type === 'transcript') {
            const src = msg.role === 'user' ? 'user' : msg.role === 'agent' ? 'agent' : 'system';
            onLog({ id: Date.now().toString(), source: src, message: msg.text, timestamp: new Date() });
          }

          if (msg.type === 'booked') {
            onLog({ id: Date.now().toString(), source: 'agent', message: `BOOKING CONFIRMED! ${JSON.stringify(msg.details)}`, timestamp: new Date() });
            setCallState(CallState.BOOKED);
            onStateChange(CallState.BOOKED);
            setTimeout(() => endCall(), 10000);
          }
        };

        simWs.onclose = () => { if (isActiveRef.current) endCall(); };
        simWs.onerror = (err) => { console.error(err); endCall(); };

      } catch (e) {
        console.error('OpenAI simulation failed', e);
        setCallState(CallState.FAILED);
        onStateChange(CallState.FAILED);
        endCall();
      }
      return;
    }

    // --- GEMINI SIMULATION MODE ---
    try {
      setCallState(CallState.DIALING);
      onStateChange(CallState.DIALING);
      setIsActive(true);
      isActiveRef.current = true;

      // Buffering variables for simulation logs
      let currentInput = '';
      let currentOutput = '';

      onLog({ id: Date.now().toString(), source: 'system', message: 'Initializing browser simulation...', timestamp: new Date() });

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const analyser = outputCtx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      if (!isActiveRef.current) { endCall(); return; }

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: getSystemInstruction(),
          tools: [{ functionDeclarations: [bookCourtFunction, pressDtmfKeyFunction, reportHoldStateFunction] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            if (!isActiveRef.current) return;
            // Cache the resolved session so the hot audio path avoids Promise.then() every chunk
            sessionPromise.then(sess => { activeSessionRef.current = sess; });

            onLog({ id: Date.now().toString(), source: 'system', message: 'Connected to Gemini Live (Simulated).', timestamp: new Date() });
            setCallState(CallState.ON_HOLD);
            onStateChange(CallState.ON_HOLD);

            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = processor;
            processor.onaudioprocess = (e) => {
              if (!isActiveRef.current || !activeSessionRef.current) return;
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for(let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));
              activeSessionRef.current.sendRealtimeInput({ media: createPcmBlob(inputData) });
            };
            source.connect(processor);
            processor.connect(inputCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (!isActiveRef.current) return;

            // Handle Transcriptions
            const serverContent = msg.serverContent;
            if (serverContent?.outputTranscription?.text) {
                currentOutput += serverContent.outputTranscription.text;
            }
            if (serverContent?.inputTranscription?.text) {
                currentInput += serverContent.inputTranscription.text;
            }
            if (serverContent?.turnComplete) {
                if (currentInput.trim()) {
                    onLog({ id: Date.now().toString() + 'u', source: 'user', message: currentInput.trim(), timestamp: new Date() });
                    currentInput = '';
                }
                if (currentOutput.trim()) {
                    onLog({ id: Date.now().toString() + 'a', source: 'agent', message: currentOutput.trim(), timestamp: new Date() });
                    currentOutput = '';
                }
            }

            if (msg.toolCall) {
                for (const fc of msg.toolCall.functionCalls) {
                    if (fc.name === 'reportHoldState') {
                        const reason = (fc.args as { reason?: string })?.reason || 'non-human audio';
                        onLog({ id: Date.now().toString(), source: 'system', message: `Music/hold detected — "${reason}". Staying silent.`, timestamp: new Date() });
                        setCallState(CallState.ON_HOLD);
                        onStateChange(CallState.ON_HOLD);
                        activeSessionRef.current?.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: 'Acknowledged. Remain silent and wait.' } } });
                    }
                    if (fc.name === 'pressDtmfKey') {
                        const { digit, reason } = fc.args as { digit: string; reason?: string };
                        onLog({ id: Date.now().toString(), source: 'agent', message: `[Pressed key: ${digit}${reason ? ' — ' + reason : ''}]`, timestamp: new Date() });
                        activeSessionRef.current?.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: `Key ${digit} pressed.` } } });
                    }
                    if (fc.name === 'confirmBooking') {
                        onLog({ id: Date.now().toString(), source: 'agent', message: `BOOKING CONFIRMED! ${JSON.stringify(fc.args)}`, timestamp: new Date() });
                        setCallState(CallState.BOOKED);
                        onStateChange(CallState.BOOKED);
                        activeSessionRef.current?.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "Booking confirmed. Say goodbye to the receptionist." } } });
                        setTimeout(() => endCall(), 10000);
                    }
                }
            }
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              setCallState(CallState.TALKING); 
              onStateChange(CallState.TALKING);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const audioBuffer = await decodeAudioData(base64ToUint8Array(audioData), outputCtx);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(analyser); 
              analyser.connect(outputCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
            }
            if (msg.serverContent?.interrupted) nextStartTimeRef.current = 0;
          },
          onclose: () => {
            activeSessionRef.current = null; // already closed, prevent double-close in endCall
            if (isActiveRef.current) endCall();
          },
          onerror: (err) => { console.error(err); endCall(); }
        }
      });
      sessionPromise.then(sess => { if (!isActiveRef.current) sess.close(); });
    } catch (e) {
      console.error("Failed to start call", e);
      setCallState(CallState.FAILED);
      onStateChange(CallState.FAILED);
      endCall();
    }
  };

  const endCall = async () => {
    // Sanitize backend URL here as well
    const cleanBackendUrl = preferences.backendUrl.replace(/\/$/, '');
    
    if (preferences.mode === 'real' && activeCallSidRef.current) {
         try {
             onLog({ id: Date.now().toString(), source: 'system', message: 'Hanging up...', timestamp: new Date() });
             await fetch(`${cleanBackendUrl}/end-call`, {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ callSid: activeCallSidRef.current })
             });
         } catch(e) { console.error("Failed to hangup remotely", e); }
         activeCallSidRef.current = null;
    }
    if (logSocketRef.current) {
        logSocketRef.current.close();
        logSocketRef.current = null;
    }

    setIsActive(false);
    isActiveRef.current = false;
    setCallState(CallState.IDLE);
    onStateChange(CallState.IDLE);

    if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
    if (scriptProcessorRef.current) { scriptProcessorRef.current.disconnect(); scriptProcessorRef.current = null; }
    if (inputAudioContextRef.current) { inputAudioContextRef.current.close(); inputAudioContextRef.current = null; }
    if (outputAudioContextRef.current) { outputAudioContextRef.current.close(); outputAudioContextRef.current = null; }
    if (activeSessionRef.current) { activeSessionRef.current.close(); activeSessionRef.current = null; }
  };

  const statusBadge = () => {
    const map: Record<string, { label: string; cls: string }> = {
      [CallState.IDLE]:    { label: 'Ready',       cls: 'bg-stone-100 text-stone-500' },
      [CallState.DIALING]: { label: 'Dialing…',    cls: 'bg-amber-100 text-amber-700' },
      [CallState.ON_HOLD]: { label: 'On Hold',     cls: 'bg-amber-100 text-amber-700' },
      [CallState.TALKING]: { label: 'In Progress', cls: 'bg-green-100 text-green-700' },
      [CallState.BOOKED]:  { label: 'Confirmed!',  cls: 'bg-green-100 text-green-700' },
      [CallState.FAILED]:  { label: 'Failed',      cls: 'bg-red-100 text-red-600' },
    };
    const { label, cls } = map[callState] ?? map[CallState.IDLE];
    return (
      <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${cls}`}>
        {label}
      </span>
    );
  };

  const callBtnClass = () => {
    if (isActive) {
      return preferences.mode === 'real'
        ? 'bg-rose-500 hover:bg-rose-600 shadow-rose-200'
        : 'bg-stone-700 hover:bg-stone-800 shadow-stone-200';
    }
    return preferences.mode === 'real'
      ? 'bg-rose-500 hover:bg-rose-600 shadow-rose-200'
      : 'bg-green-700 hover:bg-green-800 shadow-green-200';
  };

  return (
    <div className="bg-white rounded-3xl border border-stone-100 shadow-sm overflow-hidden">
      {/* Status strip */}
      <div className={`h-1 w-full transition-all duration-500 ${
        callState === CallState.BOOKED  ? 'bg-green-400' :
        callState === CallState.FAILED  ? 'bg-red-400' :
        callState === CallState.TALKING ? 'bg-green-400' :
        callState === CallState.DIALING || callState === CallState.ON_HOLD ? 'bg-amber-400' :
        'bg-stone-100'
      }`} />

      <div className="px-6 pt-6 pb-7 flex flex-col items-center">
        {/* Status badge */}
        <div className="mb-5">{statusBadge()}</div>

        {/* Big call button */}
        <div className="relative mb-5">
          {isActive && callState === CallState.TALKING && (
            <span className="absolute inset-0 rounded-full bg-green-400/25 animate-ping" />
          )}
          <button
            onClick={isActive ? endCall : startCall}
            disabled={callState === CallState.FAILED}
            className={`relative w-24 h-24 rounded-full flex items-center justify-center shadow-lg transition-all duration-200 active:scale-95 disabled:opacity-40 ${callBtnClass()}`}
          >
            {callState === CallState.DIALING
              ? <Loader2 className="w-9 h-9 text-white animate-spin" />
              : callState === CallState.BOOKED
              ? <CheckCircle2 className="w-9 h-9 text-white" />
              : isActive
              ? <PhoneOff className="w-9 h-9 text-white" />
              : <Phone className="w-9 h-9 text-white" />
            }
          </button>
        </div>

        {/* Call label */}
        <h2 className="text-lg font-black text-stone-800 mb-1 text-center">
          {callState === CallState.IDLE    && (preferences.mode === 'real' ? 'Call Tennis Club' : 'Simulate Call')}
          {callState === CallState.DIALING && 'Connecting…'}
          {callState === CallState.ON_HOLD && 'Waiting on Hold'}
          {callState === CallState.TALKING && 'Negotiating…'}
          {callState === CallState.BOOKED  && 'Court Booked!'}
          {callState === CallState.FAILED  && 'Call Failed'}
        </h2>

        {/* Duration */}
        {isActive && (
          <div className="flex items-center space-x-1.5 text-stone-400 text-sm mb-1">
            <Timer className="w-3.5 h-3.5" />
            <span className="font-mono font-semibold">{formatDuration(duration)}</span>
          </div>
        )}

        {/* Subtitle */}
        {!isActive && callState !== CallState.FAILED && (
          <p className="text-stone-400 text-sm text-center">
            {preferences.mode === 'real'
              ? `Will dial ${preferences.tennisCourtPhoneNumber}`
              : 'You play the receptionist'}
          </p>
        )}

        {/* Error */}
        {lastError && (
          <div className="w-full mt-4 bg-red-50 border border-red-100 rounded-2xl p-4 text-center">
            <p className="text-red-600 text-sm font-semibold">{lastError.message}</p>
            {lastError.code === 21210 && (
              <a
                href="https://console.twilio.com/us1/develop/phone-numbers/manage/verified-caller-ids"
                target="_blank"
                rel="noreferrer"
                className="inline-block mt-2 text-xs bg-rose-500 hover:bg-rose-600 text-white py-1.5 px-4 rounded-full transition-colors"
              >
                Verify in Twilio Console
              </a>
            )}
          </div>
        )}

        {/* Audio visualizer */}
        {isActive && preferences.mode === 'simulation' && (
          <div className="w-full mt-5">
            <AudioVisualizer analyser={analyserRef.current} isActive={true} />
          </div>
        )}

        {/* Mic indicator for real calls */}
        {isActive && preferences.mode === 'real' && (
          <div className="mt-5 flex items-center space-x-2 bg-rose-50 border border-rose-100 rounded-2xl px-4 py-2.5">
            <Globe className="w-4 h-4 text-rose-500 animate-pulse" />
            <span className="text-rose-600 text-sm font-medium">Agent is on the line</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentInterface;