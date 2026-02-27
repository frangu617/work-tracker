import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  DEFAULT_USER_SETTINGS,
  SUPPORTED_CURRENCIES,
  type BreakRecord,
  type GeoTag,
  type LogStatus,
  type ManualLogInput,
  type StartTimerInput,
  type SupportedCurrency,
  type TimeLog,
  type TimeProject,
  type UpdateTimeLogInput,
  type UserProfile,
  type UserSettings,
} from "@/lib/tracker-types";

const USERS_COLLECTION = "users";
const PROJECTS_COLLECTION = "projects";
const TIME_LOGS_COLLECTION = "timeLogs";

function requireDb() {
  if (!db) {
    throw new Error("Firebase is not configured. Add NEXT_PUBLIC_FIREBASE_* values first.");
  }
  return db;
}

function readString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value;
}

function readNumber(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return value;
}

function readDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (value instanceof Timestamp) {
    return value.toDate();
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === "object" && value !== null) {
    const maybeTimestamp = value as { toDate?: unknown };
    if (typeof maybeTimestamp.toDate === "function") {
      const parsed = (maybeTimestamp.toDate as () => Date)();
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }

  return null;
}

function normalizeCurrency(value: unknown): SupportedCurrency {
  if (
    typeof value === "string" &&
    SUPPORTED_CURRENCIES.includes(value as SupportedCurrency)
  ) {
    return value as SupportedCurrency;
  }
  return DEFAULT_USER_SETTINGS.currency;
}

function normalizeSettings(value: unknown): UserSettings {
  const raw = typeof value === "object" && value !== null ? value : {};
  const typed = raw as Partial<UserSettings>;
  const idleMinutes = readNumber(typed.idleMinutes, DEFAULT_USER_SETTINGS.idleMinutes);

  return {
    currency: normalizeCurrency(typed.currency),
    darkMode:
      typeof typed.darkMode === "boolean"
        ? typed.darkMode
        : DEFAULT_USER_SETTINGS.darkMode,
    idleMinutes: Math.max(1, Math.floor(idleMinutes)),
  };
}

function normalizeStatus(value: unknown): LogStatus {
  if (value === "active" || value === "on-break" || value === "completed") {
    return value;
  }
  return "completed";
}

function normalizeBreaks(value: unknown): BreakRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry): BreakRecord | null => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }

      const raw = entry as Partial<BreakRecord>;
      if (typeof raw.startTime !== "string" || typeof raw.endTime !== "string") {
        return null;
      }

      return {
        startTime: raw.startTime,
        endTime: raw.endTime,
        durationMinutes: Math.max(0, Math.floor(readNumber(raw.durationMinutes, 0))),
      };
    })
    .filter((entry): entry is BreakRecord => entry !== null);
}

function normalizeLocation(value: unknown): GeoTag | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const raw = value as Partial<GeoTag>;
  if (typeof raw.latitude !== "number" || typeof raw.longitude !== "number") {
    return null;
  }

  return {
    latitude: raw.latitude,
    longitude: raw.longitude,
    accuracy:
      typeof raw.accuracy === "number" && !Number.isNaN(raw.accuracy)
        ? raw.accuracy
        : null,
    capturedAt:
      typeof raw.capturedAt === "string" ? raw.capturedAt : new Date().toISOString(),
    label: typeof raw.label === "string" ? raw.label : undefined,
  };
}

function normalizeUser(uid: string, data: DocumentData | undefined): UserProfile {
  return {
    uid,
    email: readString(data?.email),
    displayName: readString(data?.displayName),
    hourlyRate: Math.max(0, readNumber(data?.hourlyRate)),
    settings: normalizeSettings(data?.settings),
  };
}

function normalizeProject(id: string, data: DocumentData): TimeProject {
  return {
    id,
    userId: readString(data.userId),
    name: readString(data.name, "General"),
    color: readString(data.color, "#0ea5e9"),
    createdAt: readDate(data.createdAt),
  };
}

function normalizeTimeLog(id: string, data: DocumentData): TimeLog {
  const startTime = readDate(data.startTime) ?? readDate(data.createdAt) ?? new Date();
  const endTime = readDate(data.endTime);

  return {
    id,
    userId: readString(data.userId),
    projectId: typeof data.projectId === "string" ? data.projectId : null,
    projectName: readString(data.projectName, "General"),
    taskName: readString(data.taskName),
    startTime,
    endTime,
    totalMinutes: Math.max(0, Math.floor(readNumber(data.totalMinutes))),
    breakMinutes: Math.max(0, Math.floor(readNumber(data.breakMinutes))),
    breaks: normalizeBreaks(data.breaks),
    note: readString(data.note),
    status: normalizeStatus(data.status),
    location: normalizeLocation(data.location),
    breakStartedAt: readDate(data.breakStartedAt),
    source: data.source === "manual" ? "manual" : "timer",
    createdAt: readDate(data.createdAt),
    updatedAt: readDate(data.updatedAt),
  };
}

export async function ensureUserProfile(
  uid: string,
  email: string | null,
  displayName: string | null,
): Promise<void> {
  const database = requireDb();
  const userRef = doc(database, USERS_COLLECTION, uid);
  const existing = await getDoc(userRef);

  if (!existing.exists()) {
    await setDoc(userRef, {
      uid,
      email: email ?? "",
      displayName: displayName ?? "",
      hourlyRate: 0,
      settings: DEFAULT_USER_SETTINGS,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return;
  }

  await setDoc(
    userRef,
    {
      email: email ?? "",
      displayName: displayName ?? "",
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export function subscribeUserProfile(
  uid: string,
  onData: (profile: UserProfile) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const database = requireDb();
  const userRef = doc(database, USERS_COLLECTION, uid);
  return onSnapshot(
    userRef,
    (snapshot) => {
      onData(normalizeUser(uid, snapshot.data()));
    },
    (error) => onError(error),
  );
}

export async function saveUserProfile(
  uid: string,
  hourlyRate: number,
  settings: UserSettings,
): Promise<void> {
  const database = requireDb();
  await setDoc(
    doc(database, USERS_COLLECTION, uid),
    {
      hourlyRate: Math.max(0, hourlyRate),
      settings: {
        currency: settings.currency,
        darkMode: settings.darkMode,
        idleMinutes: Math.max(1, Math.floor(settings.idleMinutes)),
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function createProject(
  userId: string,
  name: string,
  color: string,
): Promise<void> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Project name is required.");
  }

  const database = requireDb();
  await addDoc(collection(database, PROJECTS_COLLECTION), {
    userId,
    name: trimmedName,
    color,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export function subscribeProjects(
  userId: string,
  onData: (projects: TimeProject[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const database = requireDb();
  const projectsQuery = query(
    collection(database, PROJECTS_COLLECTION),
    where("userId", "==", userId),
  );

  return onSnapshot(
    projectsQuery,
    (snapshot) => {
      const projects = snapshot.docs
        .map((item) => normalizeProject(item.id, item.data()))
        .sort((left, right) => left.name.localeCompare(right.name));
      onData(projects);
    },
    (error) => onError(error),
  );
}

export function subscribeTimeLogs(
  userId: string,
  onData: (logs: TimeLog[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  const database = requireDb();
  const logsQuery = query(
    collection(database, TIME_LOGS_COLLECTION),
    where("userId", "==", userId),
    limit(600),
  );

  return onSnapshot(
    logsQuery,
    (snapshot) => {
      const logs = snapshot.docs
        .map((item) => normalizeTimeLog(item.id, item.data()))
        .sort((left, right) => right.startTime.getTime() - left.startTime.getTime());
      onData(logs);
    },
    (error) => onError(error),
  );
}

export async function startTimerLog(input: StartTimerInput): Promise<void> {
  const database = requireDb();
  await addDoc(collection(database, TIME_LOGS_COLLECTION), {
    userId: input.userId,
    projectId: input.projectId,
    projectName: input.projectName,
    taskName: input.taskName.trim(),
    startTime: Timestamp.fromDate(input.startTime),
    endTime: null,
    totalMinutes: 0,
    breakMinutes: 0,
    breaks: [],
    note: input.note.trim(),
    status: "active",
    location: input.location,
    breakStartedAt: null,
    source: "timer",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function addManualLog(input: ManualLogInput): Promise<void> {
  const database = requireDb();
  const durationMinutes = Math.max(
    0,
    Math.floor((input.endTime.getTime() - input.startTime.getTime()) / 60_000),
  );

  await addDoc(collection(database, TIME_LOGS_COLLECTION), {
    userId: input.userId,
    projectId: input.projectId,
    projectName: input.projectName,
    taskName: input.taskName.trim(),
    startTime: Timestamp.fromDate(input.startTime),
    endTime: Timestamp.fromDate(input.endTime),
    totalMinutes: durationMinutes,
    breakMinutes: 0,
    breaks: [],
    note: input.note.trim(),
    status: "completed",
    location: input.location,
    breakStartedAt: null,
    source: "manual",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function startBreak(logId: string, breakStartedAt: Date): Promise<void> {
  const database = requireDb();
  await updateDoc(doc(database, TIME_LOGS_COLLECTION, logId), {
    status: "on-break",
    breakStartedAt: Timestamp.fromDate(breakStartedAt),
    updatedAt: serverTimestamp(),
  });
}

export async function endBreak(log: TimeLog, breakEndedAt: Date): Promise<void> {
  if (!log.breakStartedAt) {
    throw new Error("Break start time is missing.");
  }

  const database = requireDb();
  const breakDurationMinutes = Math.max(
    0,
    Math.floor((breakEndedAt.getTime() - log.breakStartedAt.getTime()) / 60_000),
  );
  const nextBreakMinutes = log.breakMinutes + breakDurationMinutes;
  const nextBreaks: BreakRecord[] = [
    ...log.breaks,
    {
      startTime: log.breakStartedAt.toISOString(),
      endTime: breakEndedAt.toISOString(),
      durationMinutes: breakDurationMinutes,
    },
  ];

  await updateDoc(doc(database, TIME_LOGS_COLLECTION, log.id), {
    status: "active",
    breakStartedAt: null,
    breakMinutes: nextBreakMinutes,
    breaks: nextBreaks,
    updatedAt: serverTimestamp(),
  });
}

export async function clockOut(log: TimeLog, clockOutAt: Date): Promise<void> {
  const database = requireDb();
  let nextBreakMinutes = Math.max(0, log.breakMinutes);
  const nextBreaks = [...log.breaks];

  if (log.status === "on-break" && log.breakStartedAt) {
    const inProgressBreakMinutes = Math.max(
      0,
      Math.floor((clockOutAt.getTime() - log.breakStartedAt.getTime()) / 60_000),
    );
    nextBreakMinutes += inProgressBreakMinutes;
    nextBreaks.push({
      startTime: log.breakStartedAt.toISOString(),
      endTime: clockOutAt.toISOString(),
      durationMinutes: inProgressBreakMinutes,
    });
  }

  const grossMinutes = Math.max(
    0,
    Math.floor((clockOutAt.getTime() - log.startTime.getTime()) / 60_000),
  );
  const totalMinutes = Math.max(0, grossMinutes - nextBreakMinutes);

  await updateDoc(doc(database, TIME_LOGS_COLLECTION, log.id), {
    endTime: Timestamp.fromDate(clockOutAt),
    totalMinutes,
    breakMinutes: nextBreakMinutes,
    breaks: nextBreaks,
    breakStartedAt: null,
    status: "completed",
    updatedAt: serverTimestamp(),
  });
}

export async function updateTimeLog(log: TimeLog, input: UpdateTimeLogInput): Promise<void> {
  if (input.endTime <= input.startTime) {
    throw new Error("End time must be later than start time.");
  }

  const database = requireDb();
  const grossMinutes = Math.max(
    0,
    Math.floor((input.endTime.getTime() - input.startTime.getTime()) / 60_000),
  );
  const breakMinutes = Math.max(0, log.breakMinutes);
  const totalMinutes = Math.max(0, grossMinutes - breakMinutes);

  await updateDoc(doc(database, TIME_LOGS_COLLECTION, log.id), {
    projectId: input.projectId,
    projectName: input.projectName,
    taskName: input.taskName.trim(),
    note: input.note.trim(),
    startTime: Timestamp.fromDate(input.startTime),
    endTime: Timestamp.fromDate(input.endTime),
    totalMinutes,
    status: "completed",
    breakStartedAt: null,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteTimeLog(logId: string): Promise<void> {
  const database = requireDb();
  await deleteDoc(doc(database, TIME_LOGS_COLLECTION, logId));
}
