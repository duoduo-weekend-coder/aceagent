import React, { useState } from 'react';
import { BookingPreferences, CallState, LogEntry } from './types';
import PreferencesForm from './components/PreferencesForm';
import AgentInterface from './components/AgentInterface';
import { Activity, Terminal, ChevronDown } from 'lucide-react';

export default function App() {
  const [preferences, setPreferences] = useState<BookingPreferences>({
    name: 'Sam',
    phoneNumber: '555-0123',
    email: 'lichenge0223@gmail.com',
    tennisCourtPhoneNumber: '555-9999',
    preferredDays: ['Saturday', 'Sunday'],
    weekdayAfterTime: '16:00',
    courtType: 'Hard (Indoor)',
    durationHours: 1,
    matchType: 'Singles',
    mode: 'simulation',
    aiProvider: 'gemini',
    openaiVoice: 'ash',
    backendUrl: window.location.hostname === 'localhost'
      ? 'http://localhost:8080'
      : window.location.origin
  });

  const [callState, setCallState] = useState<CallState>(CallState.IDLE);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  const handleLog = (entry: LogEntry) => {
    setLogs(prev => [entry, ...prev]);
    setShowLogs(true);
  };

  const isCallActive = callState !== CallState.IDLE && callState !== CallState.BOOKED && callState !== CallState.FAILED;

  const logStyle = (source: string) => {
    if (source === 'agent') return { card: 'bg-green-50 border-green-100', label: 'text-green-700', dot: 'bg-green-500' };
    if (source === 'user') return { card: 'bg-sky-50 border-sky-100', label: 'text-sky-600', dot: 'bg-sky-500' };
    return { card: 'bg-stone-50 border-stone-100', label: 'text-stone-400', dot: 'bg-stone-300' };
  };

  return (
    <div className="min-h-screen bg-stone-100">
      <div className="max-w-6xl mx-auto px-4 pt-8 pb-16 lg:px-8 lg:pt-10">

        {/* Header */}
        <header className="mb-8 flex items-center space-x-3">
          <div className="w-11 h-11 bg-green-700 rounded-2xl flex items-center justify-center shadow-sm flex-shrink-0">
            <svg viewBox="0 0 24 24" className="w-6 h-6 text-white" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12c3 0 5-2.5 5-5.5S9 1 12 1" />
              <path d="M22 12c-3 0-5 2.5-5 5.5S15 23 12 23" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-black text-stone-800 leading-tight">AceAgent</h1>
            <p className="text-stone-400 text-sm">AI tennis court booking</p>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

          {/* Left: Agent + Settings */}
          <div className="lg:col-span-2 space-y-5">
            <AgentInterface
              preferences={preferences}
              onStateChange={setCallState}
              onLog={handleLog}
            />
            <PreferencesForm
              preferences={preferences}
              setPreferences={setPreferences}
              disabled={isCallActive}
            />
          </div>

          {/* Right: Logs */}
          <div className="lg:col-span-3 space-y-4">

            {/* Mobile logs toggle */}
            <button
              className="lg:hidden w-full flex items-center justify-between bg-white rounded-2xl px-5 py-4 border border-stone-200 shadow-sm"
              onClick={() => setShowLogs(v => !v)}
            >
              <div className="flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-stone-400" />
                <span className="font-semibold text-stone-700 text-sm">Activity Log</span>
                {logs.length > 0 && (
                  <span className="bg-green-100 text-green-700 text-xs font-bold px-2 py-0.5 rounded-full">
                    {logs.length}
                  </span>
                )}
              </div>
              <ChevronDown className={`w-4 h-4 text-stone-400 transition-transform duration-200 ${showLogs ? 'rotate-180' : ''}`} />
            </button>

            {/* Log panel */}
            <div className={`${showLogs ? 'block' : 'hidden'} lg:block`}>
              <div className="bg-white rounded-3xl border border-stone-100 shadow-sm overflow-hidden lg:sticky lg:top-6">
                <div className="px-5 py-4 border-b border-stone-100 flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Terminal className="w-4 h-4 text-stone-400" />
                    <span className="font-bold text-stone-700 text-sm">Activity Log</span>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <Activity className={`w-3.5 h-3.5 ${isCallActive ? 'text-green-500 animate-pulse' : 'text-stone-300'}`} />
                    <span className={`text-xs font-bold ${isCallActive ? 'text-green-600' : 'text-stone-400'}`}>
                      {isCallActive ? 'LIVE' : 'IDLE'}
                    </span>
                  </div>
                </div>

                <div className="p-4 space-y-2 max-h-[60vh] lg:max-h-[calc(100vh-260px)] overflow-y-auto">
                  {logs.length === 0 ? (
                    <div className="text-center py-16">
                      <div className="w-12 h-12 bg-stone-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                        <Terminal className="w-5 h-5 text-stone-300" />
                      </div>
                      <p className="text-stone-400 text-sm font-medium">No activity yet</p>
                      <p className="text-stone-300 text-xs mt-1">Logs appear once a call starts</p>
                    </div>
                  ) : logs.map(log => {
                    const s = logStyle(log.source);
                    return (
                      <div key={log.id} className={`rounded-2xl border px-4 py-3 ${s.card}`}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center space-x-1.5">
                            <div className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                            <span className={`text-xs font-bold uppercase tracking-wide ${s.label}`}>
                              {log.source}
                            </span>
                          </div>
                          <span className="text-xs text-stone-400 font-mono">
                            {log.timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </span>
                        </div>
                        <p className="text-stone-700 text-sm leading-relaxed">{log.message}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Instructions card */}
            <div className="bg-white rounded-3xl border border-stone-100 shadow-sm p-5">
              <p className="font-bold text-stone-700 text-sm mb-3">
                {preferences.mode === 'simulation' ? 'How to simulate' : 'Real call setup'}
              </p>
              <ol className="space-y-1.5 text-sm text-stone-500 list-decimal pl-4">
                {preferences.mode === 'simulation' && preferences.aiProvider === 'gemini' && (<>
                  <li>Allow microphone access.</li>
                  <li>Click <strong className="text-stone-700">Call Tennis Club</strong>.</li>
                  <li>Roleplay as the receptionist — speak into your mic!</li>
                </>)}
                {preferences.mode === 'simulation' && preferences.aiProvider === 'openai' && (<>
                  <li>Run <code className="bg-stone-100 px-1.5 py-0.5 rounded-lg text-xs">npm start</code> locally.</li>
                  <li>Set <code className="bg-stone-100 px-1.5 py-0.5 rounded-lg text-xs">OPENAI_API_KEY</code> in .env.</li>
                  <li>Allow mic access, then click <strong className="text-stone-700">Call Tennis Club</strong>.</li>
                  <li>Roleplay as the receptionist!</li>
                </>)}
                {preferences.mode === 'real' && (<>
                  <li>Set Twilio & AI API keys in .env.</li>
                  <li>Run <code className="bg-stone-100 px-1.5 py-0.5 rounded-lg text-xs">npm start</code> + ngrok or deploy to Railway.</li>
                  <li>Click <strong className="text-stone-700">Call Phone (Real)</strong>.</li>
                  <li>Transcript is emailed after the call.</li>
                </>)}
              </ol>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
