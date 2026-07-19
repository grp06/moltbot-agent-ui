import type {
  CronJobCreateInput,
  CronPayload,
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
} from "@/lib/cron/types";
import { isSafeAgentId } from "@/lib/agents/agentIds";

export type CronCreateTemplateId =
  | "morning-brief"
  | "reminder"
  | "weekly-review"
  | "inbox-triage"
  | "custom";

export type CronCreateDraft = {
  templateId: CronCreateTemplateId;
  name: string;
  taskText: string;
  scheduleKind: "at" | "every";
  scheduleAt?: string;
  everyAmount?: number;
  everyUnit?: "minutes" | "hours" | "days";
  everyAtTime?: string;
  everyTimeZone?: string;
  deliveryMode?: "announce" | "none";
  deliveryChannel?: string;
  deliveryTo?: string;
  advancedSessionTarget?: CronSessionTarget;
  advancedWakeMode?: CronWakeMode;
};

type TimeOfDay = { hour: number; minute: number };
type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const resolveName = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Cron job name is required.");
  }
  return trimmed;
};

const resolveAgentId = (agentId: string) => {
  const trimmed = agentId.trim();
  if (!trimmed) {
    throw new Error("Agent id is required.");
  }
  if (!isSafeAgentId(trimmed)) {
    throw new Error(`Invalid agentId: ${trimmed}`);
  }
  return trimmed;
};

const resolveTaskText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Task text is required.");
  }
  return trimmed;
};

const resolveAtSchedule = (raw: string): CronSchedule => {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error("Invalid run time.");
  }
  return { kind: "at", at: new Date(ms).toISOString() };
};

const resolveTimeZone = (timeZoneRaw: string | undefined): string => {
  const trimmed = (timeZoneRaw ?? "").trim();
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timeZone = trimmed || fallback;
  try {
    // Validate IANA timezone.
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error("Invalid timezone.");
  }
  return timeZone;
};

const resolveTimeOfDay = (raw: string | undefined): TimeOfDay => {
  const value = (raw ?? "").trim();
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error("Daily schedule time is required.");
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("Daily schedule time is required.");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("Daily schedule time is required.");
  }
  return { hour, minute };
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (timeZone: string) => {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
};

const resolveZonedParts = (ms: number, timeZone: string): ZonedParts => {
  const parts = getFormatter(timeZone).formatToParts(new Date(ms));
  const values: Partial<ZonedParts> = {};
  for (const part of parts) {
    if (part.type === "year") values.year = Number.parseInt(part.value, 10);
    if (part.type === "month") values.month = Number.parseInt(part.value, 10);
    if (part.type === "day") values.day = Number.parseInt(part.value, 10);
    if (part.type === "hour") values.hour = Number.parseInt(part.value, 10);
    if (part.type === "minute") values.minute = Number.parseInt(part.value, 10);
    if (part.type === "second") values.second = Number.parseInt(part.value, 10);
  }
  if (
    !values.year ||
    !values.month ||
    !values.day ||
    values.hour === undefined ||
    values.minute === undefined ||
    values.second === undefined
  ) {
    throw new Error("Invalid timezone.");
  }
  return values as ZonedParts;
};

const resolveTimeZoneOffsetMs = (utcMs: number, timeZone: string): number => {
  const zoned = resolveZonedParts(utcMs, timeZone);
  const zonedAsUtcMs = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second,
    0
  );
  return zonedAsUtcMs - Math.floor(utcMs / 1000) * 1000;
};

const resolveZonedDateTimeToUtcMs = (
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string
): number => {
  const localAsUtcMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
  let guess = localAsUtcMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offsetMs = resolveTimeZoneOffsetMs(guess, timeZone);
    const nextGuess = localAsUtcMs - offsetMs;
    if (nextGuess === guess) {
      return nextGuess;
    }
    guess = nextGuess;
  }
  return guess;
};

const addDays = (year: number, month: number, day: number, days: number) => {
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  date.setUTCDate(date.getUTCDate() + days);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

const resolveNextDailyAnchorMs = (params: {
  nowMs: number;
  timeZone: string;
  timeOfDay: TimeOfDay;
}): number => {
  const { nowMs, timeZone, timeOfDay } = params;
  const nowZoned = resolveZonedParts(nowMs, timeZone);
  let candidate = resolveZonedDateTimeToUtcMs(
    {
      year: nowZoned.year,
      month: nowZoned.month,
      day: nowZoned.day,
      hour: timeOfDay.hour,
      minute: timeOfDay.minute,
    },
    timeZone
  );

  if (candidate > nowMs) {
    return candidate;
  }

  const tomorrow = addDays(nowZoned.year, nowZoned.month, nowZoned.day, 1);
  candidate = resolveZonedDateTimeToUtcMs(
    {
      year: tomorrow.year,
      month: tomorrow.month,
      day: tomorrow.day,
      hour: timeOfDay.hour,
      minute: timeOfDay.minute,
    },
    timeZone
  );
  return candidate;
};

const resolveEverySchedule = (
  draft: Pick<CronCreateDraft, "everyAmount" | "everyUnit" | "everyAtTime" | "everyTimeZone">,
  nowMs: number
): CronSchedule => {
  const amount = Number.isFinite(draft.everyAmount) ? Math.floor(draft.everyAmount ?? 0) : 0;
  if (amount <= 0) {
    throw new Error("Invalid interval amount.");
  }

  const unit = draft.everyUnit ?? "minutes";
  const multiplier =
    unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;

  if (unit !== "days") {
    return { kind: "every", everyMs: amount * multiplier };
  }

  const timeZone = resolveTimeZone(draft.everyTimeZone);
  const timeOfDay = resolveTimeOfDay(draft.everyAtTime);
  const anchorMs = resolveNextDailyAnchorMs({ nowMs, timeZone, timeOfDay });
  return {
    kind: "every",
    everyMs: amount * multiplier,
    anchorMs,
  };
};

const resolveSchedule = (draft: CronCreateDraft, nowMs: number): CronSchedule => {
  if (draft.scheduleKind === "at") {
    return resolveAtSchedule(draft.scheduleAt ?? "");
  }
  return resolveEverySchedule(draft, nowMs);
};

const resolvePayload = (sessionTarget: CronSessionTarget, text: string): CronPayload => {
  if (sessionTarget === "main") {
    return { kind: "systemEvent", text };
  }
  return { kind: "agentTurn", message: text };
};

export const buildCronJobCreateInput = (
  agentIdRaw: string,
  draft: CronCreateDraft,
  nowMs = Date.now()
): CronJobCreateInput => {
  const agentId = resolveAgentId(agentIdRaw);
  const name = resolveName(draft.name);
  const taskText = resolveTaskText(draft.taskText);
  const sessionTarget = draft.advancedSessionTarget ?? "isolated";
  const wakeMode = draft.advancedWakeMode ?? "now";
  const schedule = resolveSchedule(draft, nowMs);
  const payload = resolvePayload(sessionTarget, taskText);

  if (sessionTarget === "main") {
    return {
      name,
      agentId,
      enabled: true,
      schedule,
      sessionTarget,
      wakeMode,
      payload,
    };
  }

  const deliveryMode = draft.deliveryMode ?? "none";
  const deliveryChannel = (draft.deliveryChannel ?? "").trim() || "last";
  const deliveryTo = (draft.deliveryTo ?? "").trim();

  return {
    name,
    agentId,
    enabled: true,
    schedule,
    sessionTarget,
    wakeMode,
    payload,
    delivery:
      deliveryMode === "none"
        ? { mode: "none" }
        : {
            mode: "announce",
            channel: deliveryChannel,
            to: deliveryTo || undefined,
          },
  };
};
