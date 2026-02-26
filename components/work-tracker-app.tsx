"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { jsPDF } from "jspdf";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { auth, googleProvider, isFirebaseConfigured } from "@/lib/firebase";
import {
  addManualLog,
  clockOut,
  createProject,
  endBreak,
  ensureUserProfile,
  saveUserProfile,
  startBreak,
  startTimerLog,
  subscribeProjects,
  subscribeTimeLogs,
  subscribeUserProfile,
} from "@/lib/tracker-data";
import {
  DEFAULT_USER_SETTINGS,
  PROJECT_COLOR_PRESETS,
  SUPPORTED_CURRENCIES,
  type TimeLog,
  type UserProfile,
} from "@/lib/tracker-types";
import {
  buildLastDaysReport,
  calculateWorkedMilliseconds,
  downloadText,
  formatClock,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDuration,
  formatTime,
  getLogMinutes,
  parseDateAndTime,
  toDayKey,
  toInputDateValue,
  toInputTimeValue,
} from "@/lib/tracker-utils";

const IDLE_CHECK_INTERVAL_MS = 30_000;

const PDF_FIELD_OPTIONS = [
  { key: "date", label: "Date" },
  { key: "timeIn", label: "Time In" },
  { key: "timeOut", label: "Time Out" },
  { key: "duration", label: "Duration" },
  { key: "project", label: "Project" },
  { key: "task", label: "Task" },
  { key: "status", label: "Status" },
  { key: "earnings", label: "Earnings" },
  { key: "note", label: "Note" },
] as const;

type PdfFieldKey = (typeof PDF_FIELD_OPTIONS)[number]["key"];
type PdfFieldSelection = Record<PdfFieldKey, boolean>;
type CalendarCell = {
  key: string;
  date: Date | null;
};

type WorkWeekGroup = {
  key: string;
  startDate: Date;
  endDate: Date;
  logs: TimeLog[];
  totalMinutes: number;
};

function defaultPdfFieldSelection(): PdfFieldSelection {
  return {
    date: true,
    timeIn: true,
    timeOut: true,
    duration: true,
    project: false,
    task: false,
    status: false,
    earnings: false,
    note: false,
  };
}

function toMonthInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

function parseMonthInputValue(value: string): { year: number; monthIndex: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
    return null;
  }

  return {
    year,
    monthIndex: month - 1,
  };
}

function getWorkWeekStartMonday(date: Date): Date {
  const mondayStart = new Date(date);
  mondayStart.setHours(0, 0, 0, 0);
  if (mondayStart.getDay() === 0) {
    mondayStart.setDate(mondayStart.getDate() - 1);
  }

  const mondayIndex = (mondayStart.getDay() + 6) % 7;
  mondayStart.setDate(mondayStart.getDate() - mondayIndex);
  return mondayStart;
}

function getWorkWeekEndSaturday(startDate: Date): Date {
  const saturdayEnd = new Date(startDate);
  saturdayEnd.setDate(saturdayEnd.getDate() + 5);
  saturdayEnd.setHours(23, 59, 59, 999);
  return saturdayEnd;
}

function groupLogsByWorkWeek(logs: TimeLog[], now: Date): WorkWeekGroup[] {
  const groups = new Map<string, WorkWeekGroup>();
  const sortedLogs = [...logs].sort(
    (left, right) => left.startTime.getTime() - right.startTime.getTime(),
  );

  for (const log of sortedLogs) {
    const weekStart = getWorkWeekStartMonday(log.startTime);
    const weekKey = toDayKey(weekStart);
    let group = groups.get(weekKey);

    if (!group) {
      group = {
        key: weekKey,
        startDate: weekStart,
        endDate: getWorkWeekEndSaturday(weekStart),
        logs: [],
        totalMinutes: 0,
      };
      groups.set(weekKey, group);
    }

    group.logs.push(log);
    group.totalMinutes += getLogMinutes(log, now);
  }

  return Array.from(groups.values()).sort(
    (left, right) => left.startDate.getTime() - right.startDate.getTime(),
  );
}

function buildCalendarCells(monthValue: string): CalendarCell[] {
  const parsed = parseMonthInputValue(monthValue);
  const fallback = new Date();
  const year = parsed?.year ?? fallback.getFullYear();
  const monthIndex = parsed?.monthIndex ?? fallback.getMonth();
  const firstOfMonth = new Date(year, monthIndex, 1);
  const firstWeekdayMondayIndex = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const totalCells = Math.ceil((firstWeekdayMondayIndex + daysInMonth) / 7) * 7;

  const cells: CalendarCell[] = [];
  for (let index = 0; index < totalCells; index += 1) {
    const day = index - firstWeekdayMondayIndex + 1;
    if (day < 1 || day > daysInMonth) {
      cells.push({ key: `empty-${index}`, date: null });
      continue;
    }

    cells.push({
      key: `${monthValue}-${day}`,
      date: new Date(year, monthIndex, day, 0, 0, 0, 0),
    });
  }

  return cells;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong.";
}

function csvEscape(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function WorkTrackerApp() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string; color: string }>>(
    [],
  );
  const [logs, setLogs] = useState<TimeLog[]>([]);
  const [authLoading, setAuthLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [showProjectsPanel, setShowProjectsPanel] = useState(false);
  const [showSettingsToast, setShowSettingsToast] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => toMonthInputValue(new Date()));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(() =>
    toInputDateValue(new Date()),
  );
  const [showPdfExportModal, setShowPdfExportModal] = useState(false);
  const [pdfStartDate, setPdfStartDate] = useState(() => toInputDateValue(new Date()));
  const [pdfEndDate, setPdfEndDate] = useState(() => toInputDateValue(new Date()));
  const [pdfFieldSelection, setPdfFieldSelection] = useState<PdfFieldSelection>(
    () => defaultPdfFieldSelection(),
  );
  const [now, setNow] = useState(new Date());

  const [hourlyRateInput, setHourlyRateInput] = useState("0");
  const [currencyInput, setCurrencyInput] = useState(DEFAULT_USER_SETTINGS.currency);
  const [idleMinutesInput, setIdleMinutesInput] = useState("10");
  const [darkModeEnabled, setDarkModeEnabled] = useState(false);

  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectColor, setNewProjectColor] = useState(PROJECT_COLOR_PRESETS[0]);

  const [sessionProjectId, setSessionProjectId] = useState("");
  const [sessionTaskName, setSessionTaskName] = useState("");
  const [sessionNote, setSessionNote] = useState("");

  const [manualDate, setManualDate] = useState(() => toInputDateValue(new Date()));
  const [manualStartTime, setManualStartTime] = useState(() => toInputTimeValue(new Date()));
  const [manualEndTime, setManualEndTime] = useState(() => {
    const nextHour = new Date();
    nextHour.setHours(nextHour.getHours() + 1);
    return toInputTimeValue(nextHour);
  });
  const [manualProjectId, setManualProjectId] = useState("");
  const [manualTaskName, setManualTaskName] = useState("");
  const [manualNote, setManualNote] = useState("");

  const lastActivityRef = useRef(Date.now());
  const idlePromptedRef = useRef(false);
  const settingsToastTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) {
      setAuthLoading(false);
      return;
    }
    return onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthLoading(false);
      setError(null);
      if (!user) {
        setProfile(null);
        setProjects([]);
        setLogs([]);
        return;
      }
      void ensureUserProfile(user.uid, user.email, user.displayName).catch((nextError) => {
        setError(getErrorMessage(nextError));
      });
    });
  }, []);

  useEffect(() => {
    if (!currentUser) {
      return;
    }
    const unsubscribers = [
      subscribeUserProfile(currentUser.uid, setProfile, (nextError) => {
        setError(getErrorMessage(nextError));
      }),
      subscribeProjects(
        currentUser.uid,
        (nextProjects) =>
          setProjects(nextProjects.map((item) => ({ id: item.id, name: item.name, color: item.color }))),
        (nextError) => setError(getErrorMessage(nextError)),
      ),
      subscribeTimeLogs(currentUser.uid, setLogs, (nextError) => {
        setError(getErrorMessage(nextError));
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [currentUser]);

  useEffect(() => {
    if (!sessionProjectId && projects[0]) {
      setSessionProjectId(projects[0].id);
    }
    if (!manualProjectId && projects[0]) {
      setManualProjectId(projects[0].id);
    }
  }, [manualProjectId, projects, sessionProjectId]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    return () => {
      if (settingsToastTimeoutRef.current) {
        window.clearTimeout(settingsToastTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (selectedCalendarDate.startsWith(`${calendarMonth}-`)) {
      return;
    }

    const parsed = parseMonthInputValue(calendarMonth);
    if (!parsed) {
      return;
    }

    const firstDay = new Date(parsed.year, parsed.monthIndex, 1, 0, 0, 0, 0);
    setSelectedCalendarDate(toInputDateValue(firstDay));
  }, [calendarMonth, selectedCalendarDate]);

  useEffect(() => {
    const trackActivity = () => {
      lastActivityRef.current = Date.now();
      idlePromptedRef.current = false;
    };
    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "keydown",
      "click",
      "scroll",
      "touchstart",
    ];
    for (const eventName of events) {
      window.addEventListener(eventName, trackActivity, { passive: true });
    }
    return () => {
      for (const eventName of events) {
        window.removeEventListener(eventName, trackActivity);
      }
    };
  }, []);

  useEffect(() => {
    if (!profile) {
      return;
    }
    setHourlyRateInput(profile.hourlyRate.toString());
    setCurrencyInput(profile.settings.currency);
    setIdleMinutesInput(profile.settings.idleMinutes.toString());
    setDarkModeEnabled(profile.settings.darkMode);
  }, [profile]);

  useEffect(() => {
    document.body.dataset.theme = darkModeEnabled ? "dark" : "light";
  }, [darkModeEnabled]);

  const activeLog = useMemo(() => logs.find((log) => log.endTime === null) ?? null, [logs]);
  const hourlyRate = profile?.hourlyRate ?? 0;
  const currency = profile?.settings.currency ?? DEFAULT_USER_SETTINGS.currency;
  const activeWorkedMs = activeLog ? calculateWorkedMilliseconds(activeLog, now) : 0;
  const activeMinutes = Math.floor(activeWorkedMs / 60_000);
  const activeEarnings = (activeMinutes / 60) * hourlyRate;

  const reportData = useMemo(
    () => buildLastDaysReport(logs, 7, hourlyRate, now),
    [hourlyRate, logs, now],
  );
  const todayMinutes = reportData.find((item) => item.dayKey === toDayKey(now))?.minutes ?? 0;
  const lastSevenDaysMinutes = useMemo(
    () => reportData.reduce((total, day) => total + day.minutes, 0),
    [reportData],
  );
  const lastSevenDaysWorkedCount = useMemo(
    () => reportData.filter((day) => day.minutes > 0).length,
    [reportData],
  );

  const calendarCells = useMemo(() => buildCalendarCells(calendarMonth), [calendarMonth]);
  const calendarMonthLabel = useMemo(() => {
    const parsed = parseMonthInputValue(calendarMonth);
    const fallback = new Date();
    const year = parsed?.year ?? fallback.getFullYear();
    const monthIndex = parsed?.monthIndex ?? fallback.getMonth();
    return new Date(year, monthIndex, 1).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }, [calendarMonth]);

  const daySummaryByKey = useMemo(() => {
    const summary = new Map<
      string,
      { minutes: number; sessions: number; firstIn: Date | null; lastOut: Date | null }
    >();

    for (const log of logs) {
      const dayKey = toDayKey(log.startTime);
      const workedMinutes = getLogMinutes(log, now);
      const endTime = log.endTime ?? now;
      const existing = summary.get(dayKey) ?? {
        minutes: 0,
        sessions: 0,
        firstIn: null,
        lastOut: null,
      };

      existing.minutes += workedMinutes;
      existing.sessions += 1;
      if (!existing.firstIn || log.startTime < existing.firstIn) {
        existing.firstIn = log.startTime;
      }
      if (!existing.lastOut || endTime > existing.lastOut) {
        existing.lastOut = endTime;
      }

      summary.set(dayKey, existing);
    }

    return summary;
  }, [logs, now]);

  const lastSevenDaysSessions = useMemo(() => {
    let sessions = 0;
    for (const day of reportData) {
      sessions += daySummaryByKey.get(day.dayKey)?.sessions ?? 0;
    }
    return sessions;
  }, [daySummaryByKey, reportData]);

  const selectedDaySummary = useMemo(
    () =>
      daySummaryByKey.get(selectedCalendarDate) ?? {
        minutes: 0,
        sessions: 0,
        firstIn: null,
        lastOut: null,
      },
    [daySummaryByKey, selectedCalendarDate],
  );
  const selectedCalendarDateLabel = useMemo(() => {
    const parsed = new Date(`${selectedCalendarDate}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      return selectedCalendarDate;
    }
    return formatDate(parsed);
  }, [selectedCalendarDate]);

  const triggerSettingsToast = useCallback(() => {
    if (settingsToastTimeoutRef.current) {
      window.clearTimeout(settingsToastTimeoutRef.current);
    }
    setShowSettingsToast(true);
    settingsToastTimeoutRef.current = window.setTimeout(() => {
      setShowSettingsToast(false);
      settingsToastTimeoutRef.current = null;
    }, 2600);
  }, []);

  const handleBreakToggle = useCallback(async () => {
    if (!activeLog) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (activeLog.status === "on-break") {
        await endBreak(activeLog, new Date());
      } else {
        await startBreak(activeLog.id, new Date());
      }
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }, [activeLog]);

  useEffect(() => {
    if (!activeLog || activeLog.status !== "active") {
      idlePromptedRef.current = false;
      return;
    }
    const idleMinutes = profile?.settings.idleMinutes ?? DEFAULT_USER_SETTINGS.idleMinutes;
    const idleThresholdMs = idleMinutes * 60_000;
    const interval = window.setInterval(() => {
      if (idlePromptedRef.current || Date.now() - lastActivityRef.current < idleThresholdMs) {
        return;
      }
      idlePromptedRef.current = true;
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("Still working?", {
          body: `No activity for ${idleMinutes} minutes. Press OK to keep tracking or Cancel for break.`,
        });
      } else if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission();
      }
      const keepTracking = window.confirm(
        `No activity for ${idleMinutes} minutes. Press OK to stay clocked in, Cancel to start a break.`,
      );
      if (!keepTracking) {
        void handleBreakToggle();
      }
    }, IDLE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [activeLog, handleBreakToggle, profile?.settings.idleMinutes]);

  const handleClockToggle = useCallback(async () => {
    if (!currentUser) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!activeLog) {
        const selectedProject = projects.find((project) => project.id === sessionProjectId);
        await startTimerLog({
          userId: currentUser.uid,
          projectId: selectedProject?.id ?? null,
          projectName: selectedProject?.name ?? "General",
          taskName: sessionTaskName,
          note: sessionNote,
          location: null,
          startTime: new Date(),
        });
      } else {
        await clockOut(activeLog, new Date());
      }
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }, [
    activeLog,
    currentUser,
    projects,
    sessionNote,
    sessionProjectId,
    sessionTaskName,
  ]);

  const handleSaveSettings = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!currentUser || !profile) {
        return;
      }
      const hourlyRate = Number.parseFloat(hourlyRateInput);
      const idleMinutes = Number.parseInt(idleMinutesInput, 10);
      if (Number.isNaN(hourlyRate) || hourlyRate < 0) {
        setError("Hourly rate must be zero or more.");
        return;
      }
      if (Number.isNaN(idleMinutes) || idleMinutes < 1) {
        setError("Idle reminder must be at least 1 minute.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await saveUserProfile(currentUser.uid, hourlyRate, {
          ...profile.settings,
          currency: currencyInput,
          idleMinutes,
          darkMode: darkModeEnabled,
        });
        triggerSettingsToast();
      } catch (nextError) {
        setError(getErrorMessage(nextError));
      } finally {
        setBusy(false);
      }
    },
    [
      currencyInput,
      currentUser,
      darkModeEnabled,
      hourlyRateInput,
      idleMinutesInput,
      profile,
      triggerSettingsToast,
    ],
  );

  const handleCreateProject = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!currentUser) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await createProject(currentUser.uid, newProjectName, newProjectColor);
        setNewProjectName("");
      } catch (nextError) {
        setError(getErrorMessage(nextError));
      } finally {
        setBusy(false);
      }
    },
    [currentUser, newProjectColor, newProjectName],
  );

  const handleManualSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!currentUser) {
        return;
      }
      const startTime = parseDateAndTime(manualDate, manualStartTime);
      const endTime = parseDateAndTime(manualDate, manualEndTime);
      if (!startTime || !endTime || endTime <= startTime) {
        setError("Manual log needs a valid date and an end time after start time.");
        return;
      }
      const selectedProject = projects.find((project) => project.id === manualProjectId);
      setBusy(true);
      setError(null);
      try {
        await addManualLog({
          userId: currentUser.uid,
          projectId: selectedProject?.id ?? null,
          projectName: selectedProject?.name ?? "General",
          taskName: manualTaskName,
          note: manualNote,
          location: null,
          startTime,
          endTime,
        });
        setManualTaskName("");
        setManualNote("");
      } catch (nextError) {
        setError(getErrorMessage(nextError));
      } finally {
        setBusy(false);
      }
    },
    [
      currentUser,
      manualDate,
      manualEndTime,
      manualNote,
      manualProjectId,
      manualStartTime,
      manualTaskName,
      projects,
    ],
  );

  const handleSignIn = useCallback(async () => {
    if (!auth || !googleProvider) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    if (!auth) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signOut(auth);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleThemeToggle = useCallback(async () => {
    const nextDarkMode = !darkModeEnabled;
    setDarkModeEnabled(nextDarkMode);

    if (!currentUser || !profile) {
      return;
    }

    try {
      await saveUserProfile(currentUser.uid, profile.hourlyRate, {
        ...profile.settings,
        darkMode: nextDarkMode,
      });
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    }
  }, [currentUser, darkModeEnabled, profile]);

  const exportCsv = useCallback(() => {
    if (logs.length === 0) {
      setError("No logs available to export.");
      return;
    }

    const groupedLogs = groupLogsByWorkWeek(logs, now);
    const header = [
      "Date",
      "Project",
      "Task",
      "Start",
      "End",
      "Worked Minutes",
      "Break Minutes",
      "Status",
      "Source",
      "Earnings",
      "Note",
    ].join(",");
    const rows: string[] = [];

    for (const group of groupedLogs) {
      rows.push(
        csvEscape(
          `Week ${formatDate(group.startDate)} - ${formatDate(group.endDate)} (Monday-Saturday)`,
        ),
      );
      rows.push(header);

      for (const log of group.logs) {
        const workedMinutes = getLogMinutes(log, now);
        const earnings = formatCurrency((workedMinutes / 60) * hourlyRate, currency);
        rows.push(
          [
            csvEscape(formatDate(log.startTime)),
            csvEscape(log.projectName),
            csvEscape(log.taskName || "-"),
            csvEscape(formatDateTime(log.startTime)),
            csvEscape(log.endTime ? formatDateTime(log.endTime) : "-"),
            workedMinutes.toString(),
            log.breakMinutes.toString(),
            csvEscape(log.status),
            csvEscape(log.source),
            csvEscape(earnings),
            csvEscape(log.note || ""),
          ].join(","),
        );
      }

      rows.push(
        [
          csvEscape("Week Total"),
          "",
          "",
          "",
          "",
          group.totalMinutes.toString(),
          "",
          "",
          "",
          csvEscape(formatCurrency((group.totalMinutes / 60) * hourlyRate, currency)),
          "",
        ].join(","),
      );
      rows.push("");
    }

    downloadText(
      `timesheet-${toDayKey(new Date())}.csv`,
      rows.join("\n"),
      "text/csv;charset=utf-8",
    );
  }, [currency, hourlyRate, logs, now]);

  const openPdfExportModal = useCallback(() => {
    if (logs.length === 0) {
      setError("No logs available to export.");
      return;
    }

    let earliest = logs[0].startTime;
    let latest = logs[0].startTime;
    for (const log of logs) {
      if (log.startTime < earliest) {
        earliest = log.startTime;
      }
      if (log.startTime > latest) {
        latest = log.startTime;
      }
    }

    setPdfStartDate(toInputDateValue(earliest));
    setPdfEndDate(toInputDateValue(latest));
    setPdfFieldSelection(defaultPdfFieldSelection());
    setError(null);
    setShowPdfExportModal(true);
  }, [logs]);

  const closePdfExportModal = useCallback(() => {
    setShowPdfExportModal(false);
  }, []);

  const togglePdfField = useCallback((field: PdfFieldKey) => {
    setPdfFieldSelection((current) => ({
      ...current,
      [field]: !current[field],
    }));
  }, []);

  const resetPdfFields = useCallback(() => {
    setPdfFieldSelection(defaultPdfFieldSelection());
  }, []);

  const exportPdf = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (logs.length === 0) {
        setError("No logs available to export.");
        return;
      }

      const startDate = new Date(`${pdfStartDate}T00:00:00`);
      const endDate = new Date(`${pdfEndDate}T23:59:59.999`);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        setError("Select a valid start and end date.");
        return;
      }

      if (startDate > endDate) {
        setError("Start date must be before or equal to end date.");
        return;
      }

      const selectedFields = PDF_FIELD_OPTIONS.filter(
        (fieldOption) => pdfFieldSelection[fieldOption.key],
      );
      if (selectedFields.length === 0) {
        setError("Select at least one field for PDF export.");
        return;
      }

      const filteredLogs = logs
        .filter((log) => log.startTime >= startDate && log.startTime <= endDate)
        .sort((left, right) => left.startTime.getTime() - right.startTime.getTime());
      if (filteredLogs.length === 0) {
        setError("No logs found in that date range.");
        return;
      }
      const groupedLogs = groupLogsByWorkWeek(filteredLogs, now);

      const doc = new jsPDF({ unit: "pt", format: "letter" });
      let y = 40;
      doc.setFontSize(18);
      doc.text("Work Tracker Timesheet", 40, y);
      y += 20;
      doc.setFontSize(11);
      doc.text(`Generated: ${formatDateTime(new Date())}`, 40, y);
      y += 14;
      doc.text(`Range: ${formatDate(startDate)} - ${formatDate(endDate)}`, 40, y);
      y += 14;
      const fieldText = `Columns: ${selectedFields.map((field) => field.label).join(", ")}`;
      const wrappedFieldText = doc.splitTextToSize(fieldText, 520);
      doc.text(wrappedFieldText, 40, y);
      y += wrappedFieldText.length * 12 + 10;

      for (const group of groupedLogs) {
        const groupHeading =
          `Week ${formatDate(group.startDate)} - ${formatDate(group.endDate)} ` +
          `(Monday-Saturday) | Total: ${formatDuration(group.totalMinutes)}`;
        const wrappedHeading = doc.splitTextToSize(groupHeading, 520);
        if (y + wrappedHeading.length * 12 > 740) {
          doc.addPage();
          y = 40;
        }
        doc.setFontSize(11);
        doc.text(wrappedHeading, 40, y);
        y += wrappedHeading.length * 12 + 6;

        for (const log of group.logs) {
          const workedMinutes = getLogMinutes(log, now);
          const values = selectedFields.map((fieldOption) => {
            switch (fieldOption.key) {
              case "date":
                return `${fieldOption.label}: ${formatDate(log.startTime)}`;
              case "timeIn":
                return `${fieldOption.label}: ${formatTime(log.startTime)}`;
              case "timeOut":
                return `${fieldOption.label}: ${log.endTime ? formatTime(log.endTime) : "-"}`;
              case "duration":
                return `${fieldOption.label}: ${formatDuration(workedMinutes)}`;
              case "project":
                return `${fieldOption.label}: ${log.projectName}`;
              case "task":
                return `${fieldOption.label}: ${log.taskName || "-"}`;
              case "status":
                return `${fieldOption.label}: ${log.status}`;
              case "earnings":
                return `${fieldOption.label}: ${formatCurrency(
                  (workedMinutes / 60) * hourlyRate,
                  currency,
                )}`;
              case "note":
                return `${fieldOption.label}: ${log.note || "-"}`;
              default:
                return "";
            }
          });

          const wrapped = doc.splitTextToSize(values.join(" | "), 520);
          if (y + wrapped.length * 12 > 740) {
            doc.addPage();
            y = 40;
          }
          doc.setFontSize(10);
          doc.text(wrapped, 40, y);
          y += wrapped.length * 12 + 8;
        }

        y += 4;
      }

      doc.save(`timesheet-${pdfStartDate}-to-${pdfEndDate}.pdf`);
      setShowPdfExportModal(false);
      setError(null);
    },
    [
      currency,
      hourlyRate,
      logs,
      now,
      pdfEndDate,
      pdfFieldSelection,
      pdfStartDate,
    ],
  );

  const statusLabel = !activeLog
    ? "Clocked Out"
    : activeLog.status === "on-break"
      ? "On Break"
      : "Clocked In";
  const chartAxisColor = darkModeEnabled ? "#cbd5e1" : "#102240";
  const chartGridColor = darkModeEnabled ? "rgba(148, 163, 184, 0.2)" : "rgba(21, 34, 61, 0.12)";
  const accountDisplayName =
    currentUser?.displayName?.trim() ||
    profile?.displayName?.trim() ||
    currentUser?.email?.trim() ||
    "User";

  return (
    <div className="tracker-app">
      <header className="tracker-header">
        <div>
          <p className="tracker-kicker">Work Tracker</p>
          <h1>Welcome {accountDisplayName}!</h1>
        </div>
        {currentUser && (
          <div className="account-block">
            <p>{accountDisplayName}</p>
            <button type="button" className="btn btn-ghost" onClick={handleThemeToggle}>
              {darkModeEnabled ? "Light Mode" : "Night Mode"}
            </button>
            <details className="menu-dropdown">
              <summary>Menu</summary>
              <div className="menu-dropdown-items">
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => setShowSettingsPanel((current) => !current)}
                >
                  {showSettingsPanel ? "Hide Settings" : "Show Settings"}
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => setShowProjectsPanel((current) => !current)}
                >
                  {showProjectsPanel ? "Hide Projects" : "Show Projects"}
                </button>
                <a className="menu-item-link" href="/about">
                  About
                </a>
              </div>
            </details>
            <button type="button" className="btn btn-ghost" onClick={handleSignOut}>
              Sign Out
            </button>
          </div>
        )}
      </header>

      {!isFirebaseConfigured && (
        <section className="panel warning">
          <h2>Firebase config missing</h2>
          <p>Add these to `.env.local`:</p>
          <code>
            NEXT_PUBLIC_FIREBASE_API_KEY
            <br />
            NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
            <br />
            NEXT_PUBLIC_FIREBASE_PROJECT_ID
            <br />
            NEXT_PUBLIC_FIREBASE_APP_ID
            <br />
            NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
            <br />
            NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
          </code>
        </section>
      )}

      {isFirebaseConfigured && authLoading && (
        <section className="panel">
          <p>Checking sign-in status...</p>
        </section>
      )}

      {isFirebaseConfigured && !authLoading && !currentUser && (
        <section className="panel auth-panel">
          <h2>Sign in with Google</h2>
          <p>Authentication uses Firebase Auth.</p>
          <button type="button" className="btn btn-primary" onClick={handleSignIn} disabled={busy}>
            Continue with Google
          </button>
        </section>
      )}

      {isFirebaseConfigured && currentUser && (
        <main className="dashboard-grid">
          {error && <p className="status-banner error">{error}</p>}

          <section className="panel timer-panel">
            <div className="timer-top">
              <p className={`status-chip ${activeLog ? "active" : "inactive"}`}>{statusLabel}</p>
              <h2>{formatClock(activeWorkedMs)}</h2>
            </div>
            <div className="timer-actions">
              <button
                type="button"
                className={`btn ${activeLog ? "btn-danger" : "btn-primary"}`}
                onClick={handleClockToggle}
                disabled={busy}
              >
                {activeLog ? "Clock Out" : "Clock In"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleBreakToggle}
                disabled={!activeLog || busy}
              >
                {activeLog?.status === "on-break" ? "End Break" : "Start Break"}
              </button>
            </div>
            <div className="field-grid">
              <label>
                Project
                <select
                  value={sessionProjectId}
                  onChange={(event) => setSessionProjectId(event.target.value)}
                  disabled={Boolean(activeLog)}
                >
                  {projects.length === 0 && <option value="">General</option>}
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Task
                <input
                  type="text"
                  value={sessionTaskName}
                  onChange={(event) => setSessionTaskName(event.target.value)}
                  placeholder="Feature work, admin, planning"
                  disabled={Boolean(activeLog)}
                />
              </label>
              <label className="full-row">
                Note
                <textarea
                  rows={2}
                  value={sessionNote}
                  onChange={(event) => setSessionNote(event.target.value)}
                  placeholder="Optional note"
                  disabled={Boolean(activeLog)}
                />
              </label>
            </div>
            <p className="earnings-line">
              Session Earnings: <strong>{formatCurrency(activeEarnings, currency)}</strong>
            </p>
          </section>

          <section className="panel stats-panel">
            <h2>Last 7 Days Worked</h2>
            <div className="stats-grid">
              <article>
                <p>Total Worked</p>
                <h3>{formatDuration(lastSevenDaysMinutes)}</h3>
              </article>
              <article>
                <p>Days With Work</p>
                <h3>{lastSevenDaysWorkedCount}</h3>
                <small>Out of the last 7 calendar days</small>
              </article>
              <article>
                <p>Sessions Logged</p>
                <h3>{lastSevenDaysSessions}</h3>
                <small>Today: {formatDuration(todayMinutes)}</small>
              </article>
            </div>
          </section>

          <section className="panel calendar-panel">
            <div className="panel-heading">
              <h2>Daily Calendar</h2>
              <label className="calendar-month-picker">
                Month
                <input
                  type="month"
                  value={calendarMonth}
                  onChange={(event) => setCalendarMonth(event.target.value)}
                />
              </label>
            </div>
            <p className="calendar-month-label">{calendarMonthLabel}</p>
            <div className="calendar-weekdays">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((dayLabel) => (
                <span key={dayLabel}>{dayLabel}</span>
              ))}
            </div>
            <div className="calendar-grid">
              {calendarCells.map((cell) => {
                if (!cell.date) {
                  return <div key={cell.key} className="calendar-day empty" />;
                }

                const dayKey = toDayKey(cell.date);
                const summary = daySummaryByKey.get(dayKey);
                const isSelected = selectedCalendarDate === dayKey;
                const hasWorkedTime = (summary?.minutes ?? 0) > 0;

                return (
                  <button
                    type="button"
                    key={cell.key}
                    className={`calendar-day${isSelected ? " selected" : ""}${
                      hasWorkedTime ? " has-work" : ""
                    }`}
                    onClick={() => setSelectedCalendarDate(dayKey)}
                  >
                    <span className="calendar-day-number">{cell.date.getDate()}</span>
                    <span className="calendar-day-minutes">
                      {hasWorkedTime ? formatDuration(summary?.minutes ?? 0) : "-"}
                    </span>
                  </button>
                );
              })}
            </div>
            <article className="calendar-detail">
              <h3>{selectedCalendarDateLabel}</h3>
              <p>
                Worked: <strong>{formatDuration(selectedDaySummary.minutes)}</strong>
              </p>
              <p>
                Sessions: <strong>{selectedDaySummary.sessions}</strong>
              </p>
              <p>
                Time In: <strong>{selectedDaySummary.firstIn ? formatTime(selectedDaySummary.firstIn) : "-"}</strong>
              </p>
              <p>
                Time Out: <strong>{selectedDaySummary.lastOut ? formatTime(selectedDaySummary.lastOut) : "-"}</strong>
              </p>
            </article>
          </section>

          {showSettingsPanel && (
            <section className="panel settings-panel">
              {showSettingsToast && <div className="settings-toast">Settings saved</div>}
              <h2>Settings</h2>
              <form className="field-grid" onSubmit={handleSaveSettings}>
                <label>
                  Hourly Rate
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={hourlyRateInput}
                    onChange={(event) => setHourlyRateInput(event.target.value)}
                  />
                </label>
                <label>
                  Currency
                  <select
                    value={currencyInput}
                    onChange={(event) =>
                      setCurrencyInput(
                        event.target.value as (typeof DEFAULT_USER_SETTINGS)["currency"],
                      )
                    }
                  >
                    {SUPPORTED_CURRENCIES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Idle Minutes
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={idleMinutesInput}
                    onChange={(event) => setIdleMinutesInput(event.target.value)}
                  />
                </label>
                <label className="full-row toggle-row">
                  <input
                    type="checkbox"
                    checked={darkModeEnabled}
                    onChange={(event) => setDarkModeEnabled(event.target.checked)}
                  />
                  Night Mode
                </label>
                <div className="full-row">
                  <button type="submit" className="btn btn-secondary" disabled={busy}>
                    Save Settings
                  </button>
                </div>
              </form>
            </section>
          )}

          {showProjectsPanel && (
            <section className="panel project-panel">
              <h2>Projects</h2>
              <form className="field-grid" onSubmit={handleCreateProject}>
                <label>
                  New Project
                  <input
                    type="text"
                    value={newProjectName}
                    onChange={(event) => setNewProjectName(event.target.value)}
                  />
                </label>
                <label>
                  Color
                  <select
                    value={newProjectColor}
                    onChange={(event) => setNewProjectColor(event.target.value)}
                  >
                    {PROJECT_COLOR_PRESETS.map((color) => (
                      <option key={color} value={color}>
                        {color}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="full-row">
                  <button type="submit" className="btn btn-secondary" disabled={busy}>
                    Add Project
                  </button>
                </div>
              </form>
              <ul className="project-list">
                {projects.length === 0 && <li>No projects yet.</li>}
                {projects.map((project) => (
                  <li key={project.id}>
                    <span style={{ backgroundColor: project.color }} />
                    {project.name}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel manual-panel">
            <h2>Manual Log</h2>
            <form className="field-grid" onSubmit={handleManualSubmit}>
              <label>
                Date
                <input type="date" value={manualDate} onChange={(event) => setManualDate(event.target.value)} />
              </label>
              <label>
                Start
                <input
                  type="time"
                  value={manualStartTime}
                  onChange={(event) => setManualStartTime(event.target.value)}
                />
              </label>
              <label>
                End
                <input
                  type="time"
                  value={manualEndTime}
                  onChange={(event) => setManualEndTime(event.target.value)}
                />
              </label>
              <label>
                Project
                <select
                  value={manualProjectId}
                  onChange={(event) => setManualProjectId(event.target.value)}
                >
                  {projects.length === 0 && <option value="">General</option>}
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Task
                <input
                  type="text"
                  value={manualTaskName}
                  onChange={(event) => setManualTaskName(event.target.value)}
                />
              </label>
              <label className="full-row">
                Note
                <textarea rows={2} value={manualNote} onChange={(event) => setManualNote(event.target.value)} />
              </label>
              <div className="full-row">
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  Add Manual Entry
                </button>
              </div>
            </form>
          </section>

          <section className="panel chart-panel">
            <div className="panel-heading">
              <h2>Last 7 Days</h2>
              <p>Hours worked by day</p>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={reportData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
                  <XAxis dataKey="dayLabel" tick={{ fill: chartAxisColor }} />
                  <YAxis tick={{ fill: chartAxisColor }} />
                  <Tooltip
                    formatter={(value: number | string | undefined) =>
                      `${Number(value ?? 0).toFixed(2)} hours`
                    }
                  />
                  <Bar dataKey="hours" fill="#f97316" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="panel logs-panel">
            <div className="panel-heading">
              <h2>Recent Logs</h2>
              <div className="inline-actions">
                <button type="button" className="btn btn-ghost" onClick={exportCsv}>
                  Export CSV
                </button>
                <button type="button" className="btn btn-ghost" onClick={openPdfExportModal}>
                  Export PDF
                </button>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Project</th>
                    <th>Task</th>
                    <th>Duration</th>
                    <th>Break</th>
                    <th>Earnings</th>
                    <th>Status</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.slice(0, 30).map((log) => {
                    const workedMinutes = getLogMinutes(log, now);
                    return (
                      <tr key={log.id}>
                        <td>{formatDate(log.startTime)}</td>
                        <td>{log.projectName}</td>
                        <td>{log.taskName || "-"}</td>
                        <td>{formatDuration(workedMinutes)}</td>
                        <td>{formatDuration(log.breakMinutes)}</td>
                        <td>{formatCurrency((workedMinutes / 60) * hourlyRate, currency)}</td>
                        <td>{log.status}</td>
                        <td>{log.source}</td>
                      </tr>
                    );
                  })}
                  {logs.length === 0 && (
                    <tr>
                      <td colSpan={8}>No logs yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      )}

      {isFirebaseConfigured && currentUser && showPdfExportModal && (
        <div className="modal-overlay" role="presentation" onClick={closePdfExportModal}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pdf-export-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="pdf-export-title">Export PDF</h2>
            <p>
              Select date range and columns. Export output is grouped by Monday-Saturday work weeks.
            </p>
            <form onSubmit={exportPdf}>
              <div className="field-grid">
                <label>
                  Start Date
                  <input
                    type="date"
                    value={pdfStartDate}
                    onChange={(event) => setPdfStartDate(event.target.value)}
                  />
                </label>
                <label>
                  End Date
                  <input
                    type="date"
                    value={pdfEndDate}
                    onChange={(event) => setPdfEndDate(event.target.value)}
                  />
                </label>
              </div>

              <fieldset className="pdf-fieldset">
                <legend>Include Columns</legend>
                <div className="pdf-option-grid">
                  {PDF_FIELD_OPTIONS.map((fieldOption) => (
                    <label key={fieldOption.key} className="pdf-option-row">
                      <input
                        type="checkbox"
                        checked={pdfFieldSelection[fieldOption.key]}
                        onChange={() => togglePdfField(fieldOption.key)}
                      />
                      <span>{fieldOption.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={resetPdfFields}>
                  Default Fields
                </button>
                <button type="button" className="btn btn-ghost" onClick={closePdfExportModal}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Export PDF
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
