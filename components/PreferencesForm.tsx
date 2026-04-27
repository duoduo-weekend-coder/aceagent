import React from 'react';
import { BookingPreferences } from '../types';
import { Settings, Clock, Calendar, User, Phone, Users, Server, Globe, Mail } from 'lucide-react';

interface Props {
  preferences: BookingPreferences;
  setPreferences: (prefs: BookingPreferences) => void;
  disabled: boolean;
}

const PreferencesForm: React.FC<Props> = ({ preferences, setPreferences, disabled }) => {
  const handleChange = (field: keyof BookingPreferences, value: any) => {
    setPreferences({ ...preferences, [field]: value });
  };

  return (
    <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-xl space-y-6">
      
      {/* Mode Selection */}
      <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700">
         <div className="flex items-center space-x-2 mb-3">
            <Server className="w-5 h-5 text-amber-400" />
            <h3 className="text-sm font-semibold text-slate-200">System Mode</h3>
         </div>
         <div className="flex space-x-2 mb-3">
             <button
                onClick={() => handleChange('mode', 'simulation')}
                disabled={disabled}
                className={`flex-1 py-2 text-sm rounded-md transition-colors ${
                    preferences.mode === 'simulation' 
                    ? 'bg-amber-600 text-white font-medium' 
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
             >
                Browser Simulation
             </button>
             <button
                onClick={() => handleChange('mode', 'real')}
                disabled={disabled}
                className={`flex-1 py-2 text-sm rounded-md transition-colors ${
                    preferences.mode === 'real' 
                    ? 'bg-red-600 text-white font-medium' 
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                }`}
             >
                Real Phone Call
             </button>
         </div>
         
         {/* AI Provider — only meaningful for real calls */}
         <div className="mb-3">
            <p className="text-xs font-medium text-slate-400 mb-2">AI Model (real calls only)</p>
            <div className="flex space-x-2">
                <button
                   onClick={() => handleChange('aiProvider', 'gemini')}
                   disabled={disabled}
                   className={`flex-1 py-2 text-sm rounded-md transition-colors ${
                       preferences.aiProvider === 'gemini'
                       ? 'bg-emerald-700 text-white font-medium'
                       : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                   } disabled:opacity-50`}
                >
                   Gemini 2.5 Flash
                </button>
                <button
                   onClick={() => handleChange('aiProvider', 'openai')}
                   disabled={disabled}
                   className={`flex-1 py-2 text-sm rounded-md transition-colors ${
                       preferences.aiProvider === 'openai'
                       ? 'bg-violet-600 text-white font-medium'
                       : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                   } disabled:opacity-50`}
                >
                   GPT-4o-mini
                </button>
            </div>
            {preferences.mode === 'simulation' && (
                <p className="text-xs text-slate-500 mt-1">Simulation always uses Gemini (browser-based)</p>
            )}
         </div>

         {preferences.mode === 'real' && (
             <div>
                <label className="flex items-center text-xs font-medium text-slate-400 mb-1">
                    <Globe className="w-3 h-3 mr-1" />
                    Backend Server URL (e.g. Railway / Ngrok)
                </label>
                <input
                    type="text"
                    value={preferences.backendUrl}
                    onChange={(e) => handleChange('backendUrl', e.target.value)}
                    disabled={disabled}
                    placeholder="https://your-app.up.railway.app"
                    className="w-full bg-slate-950 border border-slate-600 rounded px-2 py-1.5 text-sm text-white focus:ring-1 focus:ring-red-500 focus:outline-none"
                />
             </div>
         )}
      </div>

      <div className="space-y-4">
        <div className="flex items-center space-x-2 border-b border-slate-700 pb-2">
            <Settings className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">Booking Details</h2>
        </div>

        {/* Club Details */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
             <div>
                <label className="flex items-center text-sm font-medium text-slate-400 mb-1">
                    <Phone className="w-4 h-4 mr-2" />
                    Club Phone Number
                </label>
                <input
                    type="tel"
                    value={preferences.tennisCourtPhoneNumber}
                    onChange={(e) => handleChange('tennisCourtPhoneNumber', e.target.value)}
                    disabled={disabled}
                    placeholder="555-9999"
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none disabled:opacity-50"
                />
            </div>
            <div>
                 <label className="flex items-center text-sm font-medium text-slate-400 mb-1">
                    Court Type
                 </label>
                 <select
                    value={preferences.courtType}
                    onChange={(e) => handleChange('courtType', e.target.value)}
                    disabled={disabled}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none disabled:opacity-50"
                  >
                    <option value="Hard (Indoor)">Hard Court (Indoor)</option>
                    <option value="Hard">Hard Court (Outdoor)</option>
                    <option value="Clay">Clay</option>
                    <option value="Grass">Grass</option>
                    <option value="Any">Any</option>
                  </select>
            </div>
        </div>

        {/* User Details */}
        <div>
          <label className="flex items-center text-sm font-medium text-slate-400 mb-1">
            <User className="w-4 h-4 mr-2" />
            Your Name
          </label>
          <input
            type="text"
            value={preferences.name}
            onChange={(e) => handleChange('name', e.target.value)}
            disabled={disabled}
            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none disabled:opacity-50"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="flex items-center text-sm font-medium text-slate-400 mb-1">
                <Phone className="w-4 h-4 mr-2" />
                Callback Number
              </label>
              <input
                type="tel"
                value={preferences.phoneNumber}
                onChange={(e) => handleChange('phoneNumber', e.target.value)}
                disabled={disabled}
                placeholder="555-0123"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none disabled:opacity-50"
              />
            </div>
            <div>
              <label className="flex items-center text-sm font-medium text-slate-400 mb-1">
                <Mail className="w-4 h-4 mr-2" />
                Email Confirmation
              </label>
              <input
                type="email"
                value={preferences.email}
                onChange={(e) => handleChange('email', e.target.value)}
                disabled={disabled}
                placeholder="you@example.com"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none disabled:opacity-50"
              />
            </div>
        </div>

        <div>
          <label className="flex items-center text-sm font-medium text-slate-400 mb-1">
            <Calendar className="w-4 h-4 mr-2" />
            Preferred Days
          </label>
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
                className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                  preferences.preferredDays.includes(day)
                    ? 'bg-emerald-500 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                } disabled:opacity-50`}
              >
                {day}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="flex items-center text-sm font-medium text-slate-400 mb-1">
                <Clock className="w-4 h-4 mr-2" />
                Earliest (Weekday)
              </label>
              <select
                value={preferences.weekdayAfterTime}
                onChange={(e) => handleChange('weekdayAfterTime', e.target.value)}
                disabled={disabled}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none disabled:opacity-50"
              >
                <option value="16:00">4:00 PM</option>
                <option value="17:00">5:00 PM</option>
                <option value="18:00">6:00 PM</option>
                <option value="19:00">7:00 PM</option>
              </select>
            </div>

            <div>
               <label className="flex items-center text-sm font-medium text-slate-400 mb-1">
                <Users className="w-4 h-4 mr-2" />
                Match Type
              </label>
               <div className="flex bg-slate-900 border border-slate-600 rounded-lg p-1">
                 {['Singles', 'Doubles'].map((type) => (
                   <button
                     key={type}
                     onClick={() => handleChange('matchType', type)}
                     disabled={disabled}
                     className={`flex-1 text-sm py-1 rounded transition-colors ${
                       preferences.matchType === type
                         ? 'bg-emerald-600 text-white font-medium shadow-sm'
                         : 'text-slate-400 hover:text-white'
                     } disabled:opacity-50`}
                   >
                     {type}
                   </button>
                 ))}
               </div>
            </div>
        </div>

      </div>
    </div>
  );
};

export default PreferencesForm;