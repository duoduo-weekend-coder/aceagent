import React from 'react';
import { BookingPreferences } from '../types';
import { Settings, Clock, Calendar, User, Phone, Users, Server, Globe, Mail } from 'lucide-react';

interface Props {
  preferences: BookingPreferences;
  setPreferences: (prefs: BookingPreferences) => void;
  disabled: boolean;
}

const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="space-y-2.5">
    <p className="text-xs font-bold text-stone-400 uppercase tracking-wider">{label}</p>
    {children}
  </div>
);

const PreferencesForm: React.FC<Props> = ({ preferences, setPreferences, disabled }) => {
  const handleChange = (field: keyof BookingPreferences, value: any) => {
    setPreferences({ ...preferences, [field]: value });
  };

  const inputClass = `w-full bg-stone-50 border border-stone-200 rounded-2xl px-4 py-3 text-sm text-stone-800 placeholder-stone-400
    focus:ring-2 focus:ring-green-500 focus:border-transparent focus:outline-none transition-all
    disabled:opacity-50 disabled:cursor-not-allowed`;

  const pillBase = `py-2.5 rounded-2xl text-sm font-semibold transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed`;

  return (
    <div className="bg-white rounded-3xl border border-stone-100 shadow-sm p-6 space-y-6">
      <div className="flex items-center space-x-2">
        <Settings className="w-4 h-4 text-stone-400" />
        <h2 className="font-black text-stone-800 text-base">Settings</h2>
      </div>

      {/* Mode */}
      <Section label="Mode">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => handleChange('mode', 'simulation')}
            disabled={disabled}
            className={`${pillBase} ${preferences.mode === 'simulation'
              ? 'bg-green-700 text-white shadow-sm shadow-green-200'
              : 'bg-stone-100 text-stone-500 hover:bg-stone-200'}`}
          >
            Simulation
          </button>
          <button
            onClick={() => handleChange('mode', 'real')}
            disabled={disabled}
            className={`${pillBase} ${preferences.mode === 'real'
              ? 'bg-rose-500 text-white shadow-sm shadow-rose-200'
              : 'bg-stone-100 text-stone-500 hover:bg-stone-200'}`}
          >
            Real Call
          </button>
        </div>
      </Section>

      {/* AI Model */}
      <Section label="AI Model">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => handleChange('aiProvider', 'gemini')}
            disabled={disabled}
            className={`${pillBase} ${preferences.aiProvider === 'gemini'
              ? 'bg-green-700 text-white shadow-sm shadow-green-200'
              : 'bg-stone-100 text-stone-500 hover:bg-stone-200'}`}
          >
            Gemini Flash
          </button>
          <button
            onClick={() => handleChange('aiProvider', 'openai')}
            disabled={disabled}
            className={`${pillBase} ${preferences.aiProvider === 'openai'
              ? 'bg-violet-600 text-white shadow-sm shadow-violet-200'
              : 'bg-stone-100 text-stone-500 hover:bg-stone-200'}`}
          >
            GPT-4o mini
          </button>
        </div>
      </Section>

      {/* Voice picker (OpenAI only) */}
      {preferences.aiProvider === 'openai' && (
        <Section label="Voice (changes apply mid-call)">
          <div className="grid grid-cols-5 gap-1.5">
            {['ash', 'coral', 'sage', 'alloy', 'shimmer', 'echo', 'ballad', 'verse', 'marin', 'cedar'].map(v => (
              <button
                key={v}
                onClick={() => handleChange('openaiVoice', v)}
                className={`py-2 rounded-xl text-xs font-semibold transition-all capitalize active:scale-95 ${
                  preferences.openaiVoice === v
                    ? 'bg-violet-600 text-white shadow-sm'
                    : 'bg-stone-100 text-stone-500 hover:bg-stone-200'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <p className="text-xs text-stone-400">ash · coral · sage are warmest</p>
        </Section>
      )}

      {/* Backend URL (real mode only) */}
      {preferences.mode === 'real' && (
        <Section label="Backend URL">
          <div className="relative">
            <Globe className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input
              type="text"
              value={preferences.backendUrl}
              onChange={e => handleChange('backendUrl', e.target.value)}
              disabled={disabled}
              placeholder="https://your-app.up.railway.app"
              className={`${inputClass} pl-10`}
            />
          </div>
        </Section>
      )}

      <div className="border-t border-stone-100 pt-5 space-y-5">
        <div className="flex items-center space-x-2">
          <Calendar className="w-4 h-4 text-stone-400" />
          <h3 className="font-bold text-stone-700 text-sm">Booking Details</h3>
        </div>

        {/* Club phone + court type */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Section label="Club Phone">
            <div className="relative">
              <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input
                type="tel"
                value={preferences.tennisCourtPhoneNumber}
                onChange={e => handleChange('tennisCourtPhoneNumber', e.target.value)}
                disabled={disabled}
                placeholder="555-9999"
                className={`${inputClass} pl-10`}
              />
            </div>
          </Section>
          <Section label="Court Type">
            <select
              value={preferences.courtType}
              onChange={e => handleChange('courtType', e.target.value)}
              disabled={disabled}
              className={inputClass}
            >
              <option value="Hard (Indoor)">Hard (Indoor)</option>
              <option value="Hard">Hard (Outdoor)</option>
              <option value="Clay">Clay</option>
              <option value="Grass">Grass</option>
              <option value="Any">Any</option>
            </select>
          </Section>
        </div>

        {/* Name */}
        <Section label="Your Name">
          <div className="relative">
            <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input
              type="text"
              value={preferences.name}
              onChange={e => handleChange('name', e.target.value)}
              disabled={disabled}
              placeholder="Your name"
              className={`${inputClass} pl-10`}
            />
          </div>
        </Section>

        {/* Callback + Email */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Section label="Callback Number">
            <div className="relative">
              <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input
                type="tel"
                value={preferences.phoneNumber}
                onChange={e => handleChange('phoneNumber', e.target.value)}
                disabled={disabled}
                placeholder="555-0123"
                className={`${inputClass} pl-10`}
              />
            </div>
          </Section>
          <Section label="Email">
            <div className="relative">
              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input
                type="email"
                value={preferences.email}
                onChange={e => handleChange('email', e.target.value)}
                disabled={disabled}
                placeholder="you@example.com"
                className={`${inputClass} pl-10`}
              />
            </div>
          </Section>
        </div>

        {/* Preferred days */}
        <Section label="Preferred Days">
          <div className="flex flex-wrap gap-2">
            {['Friday', 'Saturday', 'Sunday'].map(day => (
              <button
                key={day}
                onClick={() => {
                  const newDays = preferences.preferredDays.includes(day)
                    ? preferences.preferredDays.filter(d => d !== day)
                    : [...preferences.preferredDays, day];
                  handleChange('preferredDays', newDays);
                }}
                disabled={disabled}
                className={`px-4 py-2 rounded-full text-sm font-semibold transition-all active:scale-95 disabled:opacity-50 ${
                  preferences.preferredDays.includes(day)
                    ? 'bg-green-700 text-white shadow-sm shadow-green-200'
                    : 'bg-stone-100 text-stone-500 hover:bg-stone-200'
                }`}
              >
                {day}
              </button>
            ))}
          </div>
        </Section>

        {/* Time + Match type */}
        <div className="grid grid-cols-2 gap-3">
          <Section label="Earliest Weekday">
            <div className="relative">
              <Clock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <select
                value={preferences.weekdayAfterTime}
                onChange={e => handleChange('weekdayAfterTime', e.target.value)}
                disabled={disabled}
                className={`${inputClass} pl-10`}
              >
                <option value="16:00">4:00 PM</option>
                <option value="17:00">5:00 PM</option>
                <option value="18:00">6:00 PM</option>
                <option value="19:00">7:00 PM</option>
              </select>
            </div>
          </Section>
          <Section label="Match Type">
            <div className="flex bg-stone-100 rounded-2xl p-1">
              {['Singles', 'Doubles'].map(type => (
                <button
                  key={type}
                  onClick={() => handleChange('matchType', type)}
                  disabled={disabled}
                  className={`flex-1 py-2 text-sm rounded-xl font-semibold transition-all disabled:opacity-50 ${
                    preferences.matchType === type
                      ? 'bg-white text-stone-800 shadow-sm'
                      : 'text-stone-400 hover:text-stone-600'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
};

export default PreferencesForm;
