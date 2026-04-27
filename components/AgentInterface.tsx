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
          description: 'What you heard that triggered this. Be specific, e.g. "hold music", "pre-recorded advertisement about tennis lessons", "silence", "automated IVR message".'
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
        You are "Ace", a helpful tennis enthusiast assistant calling a local tennis club to book a court.
        LANGUAGE: ALWAYS Speak in English.
        YOUR GOAL: Book a court for ${preferences.name}.
        DETAILS:
        - Calling: ${preferences.tennisCourtPhoneNumber}
        - User Name: ${preferences.name}
        - User Phone: ${preferences.phoneNumber}
        - Match Type: ${preferences.matchType}
        - Preferred Days: ${preferences.preferredDays.join(', ')}.
        - Weekday Availability: After ${preferences.weekdayAfterTime}.
        - Court Type: ${preferences.courtType}.
        - Duration: ${preferences.durationHours} hour(s).
        BEHAVIOR:
        1. LISTEN FIRST. Do not speak until you know who or what you are talking to.
        2. IF you hear an automated phone menu (IVR), listen to ALL options completely, then call 'pressDtmfKey' with the digit for court reservations. Do NOT speak to an IVR.
        3. IF you hear hold music, on-hold music, OR a pre-recorded advertisement/announcement, call 'reportHoldState' immediately and stay completely silent.
           A live human is someone who greets YOU, pauses for YOUR reply, or says something like "Thank you for holding, how can I help you?".
           A recording never pauses for you, never addresses you directly, and loops or ends without expecting a response. When in doubt, call 'reportHoldState'.
        4. WHEN a live human clearly addresses you, greet them and ask for availability.
        5. Once confirmed, say "Please book that for ${preferences.name}."
        6. Provide ${preferences.phoneNumber} if asked.
        7. AFTER booking is confirmed, call the 'confirmBooking' tool.
        8. When the tool returns success, say "Thank you, have a great day. Goodbye." and stop talking.
        TONE: Polite, clear, concise English.
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

        const wsUrl = cleanBackendUrl.replace(/^http/, 'ws') + '/openai-sim';
        const simWs = new WebSocket(wsUrl);
        logSocketRef.current = simWs;

        // OpenAI Realtime uses 24kHz PCM16
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const inputCtx  = new AudioContextClass({ sampleRate: 24000 });
        const outputCtx = new AudioContextClass({ sampleRate: 24000 });
        inputAudioContextRef.current  = inputCtx;
        outputAudioContextRef.current = outputCtx;
        const analyser = outputCtx.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        if (!isActiveRef.current) { endCall(); return; }

        simWs.onopen = () => {
          simWs.send(JSON.stringify({ type: 'init', systemInstruction: getSystemInstruction() }));
        };

        simWs.onmessage = async (e) => {
          if (!isActiveRef.current) return;
          const msg = JSON.parse(e.data);

          if (msg.type === 'connected') {
            onLog({ id: Date.now().toString(), source: 'system', message: 'Connected to OpenAI (simulation).', timestamp: new Date() });
            setCallState(CallState.ON_HOLD);
            onStateChange(CallState.ON_HOLD);

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
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
            const audioBuffer = await decodeAudioData(base64ToUint8Array(msg.data), outputCtx, 24000);
            const src = outputCtx.createBufferSource();
            src.buffer = audioBuffer;
            src.connect(analyser); analyser.connect(outputCtx.destination);
            src.start(nextStartTimeRef.current);
            nextStartTimeRef.current += audioBuffer.duration;
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
                        onLog({ id: Date.now().toString(), source: 'system', message: `[On hold: ${reason}]`, timestamp: new Date() });
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

  return (
    <div className="flex flex-col items-center justify-center p-6 bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl relative overflow-hidden">
      {callState === CallState.TALKING && <div className="absolute inset-0 bg-emerald-500/10 animate-pulse rounded-2xl pointer-events-none" />}
      
      <div className={`mb-6 p-6 rounded-full transition-all duration-500 ${
          callState === CallState.BOOKED ? 'bg-emerald-500/20 ring-2 ring-emerald-500' :
          isActive ? 'bg-amber-500/10 ring-2 ring-amber-500' : 'bg-slate-800'
      }`}>
        {callState === CallState.DIALING ? <Loader2 className="w-12 h-12 text-amber-500 animate-spin" /> :
         callState === CallState.BOOKED ? <CheckCircle2 className="w-12 h-12 text-emerald-500" /> :
         isActive ? (preferences.mode === 'real' ? <Globe className="w-12 h-12 text-red-500 animate-pulse" /> : <Mic className={`w-12 h-12 text-amber-500 transition-opacity ${volume > 0.01 ? 'opacity-100' : 'opacity-50'}`} />) :
         <Phone className="w-12 h-12 text-slate-400" />}
      </div>

      <div className="flex flex-col items-center mb-4">
          <h2 className="text-2xl font-bold text-white mb-2">
            {callState === CallState.IDLE && "Ready to Call"}
            {callState === CallState.DIALING && "Dialing..."}
            {callState === CallState.ON_HOLD && (preferences.mode === 'real' ? "Connecting..." : "On Hold")}
            {callState === CallState.TALKING && "Call in Progress"}
            {callState === CallState.BOOKED && "Booking Confirmed!"}
            {callState === CallState.FAILED && "Call Failed"}
          </h2>
          {isActive && (
              <div className="flex items-center space-x-2 text-slate-400 bg-slate-800/50 px-3 py-1 rounded-full border border-slate-700">
                  <Timer className="w-4 h-4" />
                  <span className="font-mono">{formatDuration(duration)}</span>
              </div>
          )}
      </div>

      {lastError && (
          <div className="mb-4 bg-red-900/50 border border-red-500/50 p-3 rounded-lg max-w-sm text-center">
              <p className="text-red-200 text-sm font-semibold">{lastError.message}</p>
              {lastError.code === 21210 && (
                  <a 
                    href="https://console.twilio.com/us1/develop/phone-numbers/manage/verified-caller-ids"
                    target="_blank"
                    rel="noreferrer"
                    className="block mt-2 text-xs bg-red-600 hover:bg-red-500 text-white py-1 px-2 rounded transition-colors"
                  >
                    Verify Phone Number in Twilio
                  </a>
              )}
          </div>
      )}
      
      <p className="text-slate-400 text-center mb-8 max-w-xs">
         {isActive 
            ? (preferences.mode === 'real' ? "Agent is negotiating on the phone..." : "Simulating. Please Roleplay as the receptionist!") 
            : (preferences.mode === 'real' ? "Ready to call real tennis court." : "Configure preferences and start simulation.")}
      </p>

      <div className="w-full mb-8">
        <AudioVisualizer analyser={analyserRef.current} isActive={isActive && preferences.mode === 'simulation'} />
      </div>

      {!isActive ? (
        <button
          onClick={startCall}
          className={`flex items-center space-x-2 text-white px-8 py-3 rounded-full font-semibold transition-all shadow-lg active:scale-95 ${
              preferences.mode === 'real' ? 'bg-red-600 hover:bg-red-500 shadow-red-500/25' : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-500/25'
          }`}
        >
          <Phone className="w-5 h-5" />
          <span>{preferences.mode === 'real' ? 'Call Phone (Real)' : 'Call Tennis Club'}</span>
        </button>
      ) : (
        <button
          onClick={endCall}
          className="flex items-center space-x-2 bg-slate-700 hover:bg-slate-600 text-white px-8 py-3 rounded-full font-semibold transition-all shadow-lg active:scale-95"
        >
          <PhoneOff className="w-5 h-5" />
          <span>{preferences.mode === 'real' ? 'Hang Up' : 'Hang Up'}</span>
        </button>
      )}
    </div>
  );
};

export default AgentInterface;