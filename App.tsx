import React, { useState } from 'react';
import { BookingPreferences, CallState, LogEntry } from './types';
import PreferencesForm from './components/PreferencesForm';
import AgentInterface from './components/AgentInterface';
import { Activity, Terminal } from 'lucide-react';

export default function App() {
  const [preferences, setPreferences] = useState<BookingPreferences>({
    name: 'Lexi',
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
    backendUrl: window.location.hostname === 'localhost'
      ? 'http://localhost:8080'   // local dev: Vite (5173) → backend (8080)
      : window.location.origin    // production: same origin
  });

  const [callState, setCallState] = useState<CallState>(CallState.IDLE);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const handleLog = (entry: LogEntry) => {
    setLogs(prev => [entry, ...prev]);
  };

  const isCallActive = callState !== CallState.IDLE && callState !== CallState.BOOKED && callState !== CallState.FAILED;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-8">
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8">
        
        {/* Left Column: Config & Agent Interface */}
        <div className="space-y-8">
          <header className="mb-8">
            <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-500 mb-2">
              AceAgent
            </h1>
            <p className="text-slate-400 text-lg">
              Automated Tennis Court Reservation AI
            </p>
          </header>

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

        {/* Right Column: Live Logs */}
        <div className="flex flex-col h-[85vh] sticky top-8">
          <div className="bg-slate-900 rounded-xl border border-slate-700 shadow-xl flex-1 flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-700 bg-slate-800/50 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Terminal className="w-5 h-5 text-slate-400" />
                <h3 className="font-mono text-sm font-semibold text-slate-300">SYSTEM LOGS</h3>
              </div>
              <div className="flex items-center space-x-2">
                 <Activity className={`w-4 h-4 ${isCallActive ? 'text-emerald-400 animate-pulse' : 'text-slate-600'}`} />
                 <span className="text-xs text-slate-500">{isCallActive ? 'LIVE' : 'OFFLINE'}</span>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-3 font-mono text-sm">
              {logs.length === 0 && (
                <div className="text-slate-600 text-center mt-20">
                  <p>Ready to initialize agent...</p>
                  <p className="text-xs mt-2">Logs will appear here during the call.</p>
                </div>
              )}
              {logs.map((log) => (
                <div key={log.id} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <span className="text-slate-500 text-xs mr-3">
                    [{log.timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]
                  </span>
                  <span className={`font-bold mr-2 ${
                    log.source === 'agent' ? 'text-emerald-400' : 
                    log.source === 'user' ? 'text-blue-400' : 'text-amber-400'
                  }`}>
                    {log.source.toUpperCase()}:
                  </span>
                  <span className="text-slate-300">{log.message}</span>
                </div>
              ))}
            </div>
          </div>
          
          <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 text-xs text-slate-400">
            <p className="font-semibold text-slate-300 mb-1">
                {preferences.mode === 'simulation' ? `Simulation (${preferences.aiProvider === 'openai' ? 'GPT-4o-mini' : 'Gemini'}):` : 'Real Call Instructions:'}
            </p>
            {preferences.mode === 'simulation' && preferences.aiProvider === 'gemini' && (
                <ol className="list-decimal pl-4 space-y-1">
                    <li>Allow microphone access.</li>
                    <li>Click <strong>Call Tennis Club</strong>.</li>
                    <li><strong>Roleplay:</strong> You are the receptionist. Speak into your mic!</li>
                </ol>
            )}
            {preferences.mode === 'simulation' && preferences.aiProvider === 'openai' && (
                <ol className="list-decimal pl-4 space-y-1">
                    <li>Run <code>npm start</code> locally (backend must be running).</li>
                    <li>Set <code>OPENAI_API_KEY</code> in <code>.env</code>.</li>
                    <li>Allow microphone access.</li>
                    <li>Click <strong>Call Tennis Club</strong>.</li>
                    <li><strong>Roleplay:</strong> You are the receptionist. Speak into your mic!</li>
                </ol>
            )}
            {preferences.mode === 'real' && (
                <ol className="list-decimal pl-4 space-y-1">
                    <li>Set <code>TWILIO_*</code>, <code>GEMINI_API_KEY</code> or <code>OPENAI_API_KEY</code>, and <code>EMAIL_PASS</code> in .env.</li>
                    <li>Run <code>npm start</code> + <code>ngrok http 8080</code> (or deploy to Railway).</li>
                    <li>Click <strong>Call Phone (Real)</strong>.</li>
                    <li>Transcript is emailed after the call.</li>
                </ol>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}