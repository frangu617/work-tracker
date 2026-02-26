import type {
  DailyReportPoint,
  SupportedCurrency,
  TimeLog,
} from "@/lib/tracker-types";

type TimestampLike = {
  toDate: () => Date;
};

function isTimestampLike(value: unknown): value is TimestampLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { toDate?: unknown };
  return typeof candidate.toDate === "function";
}

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (isTimestampLike(value)) {
    const dateValue = value.toDate();
    return Number.isNaN(dateValue.getTime()) ? null : dateValue;
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

export function parseDateAndTime(dateText: string, timeText: string): Date | null {
  const parsed = new Date(`${dateText}T${timeText}:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}

export function toInputDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toInputTimeValue(date: Date): string {
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function toDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function calculateWorkedMilliseconds(log: TimeLog, now: Date = new Date()): number {
  const end = log.endTime ?? now;
  const durationMs = Math.max(0, end.getTime() - log.startTime.getTime());
  const storedBreakMs = Math.max(0, log.breakMinutes) * 60_000;
  const runningBreakMs =
    log.status === "on-break" && log.breakStartedAt
      ? Math.max(0, now.getTime() - log.breakStartedAt.getTime())
      : 0;

  return Math.max(0, durationMs - storedBreakMs - runningBreakMs);
}

export function calculateWorkedMinutes(log: TimeLog, now: Date = new Date()): number {
  return Math.floor(calculateWorkedMilliseconds(log, now) / 60_000);
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

export function formatDuration(minutes: number): string {
  const wholeMinutes = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(wholeMinutes / 60);
  const remainder = wholeMinutes % 60;
  return `${hours}h ${remainder}m`;
}

export function formatCurrency(amount: number, currency: SupportedCurrency): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function getLogMinutes(log: TimeLog, now: Date = new Date()): number {
  if (log.endTime) {
    return Math.max(log.totalMinutes, calculateWorkedMinutes(log, now));
  }

  return calculateWorkedMinutes(log, now);
}

export function sumLogMinutes(logs: TimeLog[], now: Date = new Date()): number {
  return logs.reduce((total, log) => total + getLogMinutes(log, now), 0);
}

export function buildLastDaysReport(
  logs: TimeLog[],
  days: number,
  hourlyRate: number,
  now: Date = new Date(),
): DailyReportPoint[] {
  const minuteByDay = new Map<string, number>();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setDate(now.getDate() - offset);
    minuteByDay.set(toDayKey(date), 0);
  }

  for (const log of logs) {
    const dayKey = toDayKey(log.startTime);
    if (!minuteByDay.has(dayKey)) {
      continue;
    }

    const logMinutes = getLogMinutes(log, now);
    const current = minuteByDay.get(dayKey) ?? 0;
    minuteByDay.set(dayKey, current + logMinutes);
  }

  return Array.from(minuteByDay.entries()).map(([dayKey, minutes]) => {
    const date = new Date(`${dayKey}T00:00:00`);
    const hours = minutes / 60;
    return {
      dayKey,
      dayLabel: date.toLocaleDateString(undefined, { weekday: "short" }),
      minutes,
      hours,
      earnings: hours * hourlyRate,
    };
  });
}

export function downloadText(filename: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
