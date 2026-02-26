export type SupportedCurrency = "USD" | "EUR" | "GBP" | "CAD";
export type LogStatus = "completed" | "active" | "on-break";
export type LogSource = "timer" | "manual";

export interface GeoTag {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt: string;
  label?: string;
}

export interface BreakRecord {
  startTime: string;
  endTime: string;
  durationMinutes: number;
}

export interface UserSettings {
  currency: SupportedCurrency;
  darkMode: boolean;
  idleMinutes: number;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  hourlyRate: number;
  settings: UserSettings;
}

export interface TimeProject {
  id: string;
  userId: string;
  name: string;
  color: string;
  createdAt: Date | null;
}

export interface TimeLog {
  id: string;
  userId: string;
  projectId: string | null;
  projectName: string;
  taskName: string;
  startTime: Date;
  endTime: Date | null;
  totalMinutes: number;
  breakMinutes: number;
  breaks: BreakRecord[];
  note: string;
  status: LogStatus;
  location: GeoTag | null;
  breakStartedAt: Date | null;
  source: LogSource;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface StartTimerInput {
  userId: string;
  projectId: string | null;
  projectName: string;
  taskName: string;
  note: string;
  location: GeoTag | null;
  startTime: Date;
}

export interface ManualLogInput {
  userId: string;
  projectId: string | null;
  projectName: string;
  taskName: string;
  note: string;
  location: GeoTag | null;
  startTime: Date;
  endTime: Date;
}

export interface DailyReportPoint {
  dayKey: string;
  dayLabel: string;
  minutes: number;
  hours: number;
  earnings: number;
}

export const SUPPORTED_CURRENCIES: SupportedCurrency[] = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
];

export const DEFAULT_USER_SETTINGS: UserSettings = {
  currency: "USD",
  darkMode: false,
  idleMinutes: 10,
};

export const PROJECT_COLOR_PRESETS = [
  "#f97316",
  "#16a34a",
  "#0ea5e9",
  "#eab308",
  "#ef4444",
  "#6366f1",
];
