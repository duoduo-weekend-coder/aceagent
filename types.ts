export interface BookingPreferences {
  name: string;
  phoneNumber: string;
  email: string;               // New field
  tennisCourtPhoneNumber: string;
  preferredDays: string[]; // e.g., ["Saturday", "Sunday"]
  weekdayAfterTime: string; // e.g., "16:00"
  courtType: string;
  durationHours: number;
  matchType: 'Singles' | 'Doubles';
  mode: 'simulation' | 'real';
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