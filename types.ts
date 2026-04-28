export interface BookingPreferences {
  name: string;
  phoneNumber: string;
  email: string;
  tennisCourtPhoneNumber: string;
  preferredDays: string[];
  weekdayAfterTime: string;
  courtType: string;
  durationHours: number;
  matchType: 'Singles' | 'Doubles';
  mode: 'simulation' | 'real';
  aiProvider: 'gemini' | 'openai';
  openaiVoice: string;
  backendUrl: string;
}

export interface LogEntry {
  id: string;
  source: 'user' | 'agent' | 'system';
  message: string;
  timestamp: Date;
}

export enum CallState {
  IDLE = 'IDLE',
  DIALING = 'DIALING',
  ON_HOLD = 'ON_HOLD', // Listening for music/human
  TALKING = 'TALKING', // Negotiating
  BOOKED = 'BOOKED',
  FAILED = 'FAILED'
}