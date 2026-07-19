import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import { isSafeAgentId } from "@/lib/agents/agentIds";
import { parseAgentIdFromSessionKey } from "@/lib/gateway/session-keys";

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";

type CronDeliveryMode = "none" | "announce";
export type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: string;
  to?: string;
  bestEffort?: boolean;
};

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      deliver?: boolean;
      channel?: string;
      to?: string;
      bestEffortDeliver?: boolean;
    };

type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
};

export type CronJobSummary = {
  id: string;
  name: string;
  agentId?: string;
  sessionKey?: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  state: CronJobState;
  delivery?: CronDelivery;
};

type CronJobsResult = {
  jobs: CronJobSummary[];
};

export const sortCronJobsByUpdatedAt = (jobs: CronJobSummary[]) =>
  [...jobs].sort((a, b) => b.updatedAtMs - a.updatedAtMs);

export type CronJobCreateInput = {
  name: string;
  agentId: string;
  sessionKey?: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  delivery?: CronDelivery;
};

const normalizeCronAgentId = (value: unknown): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || !isSafeAgentId(trimmed)) return "";
  return trimmed.toLowerCase();
};

export const cronAgentIdsEqual = (left: unknown, right: unknown): boolean => {
  const normalizedLeft = normalizeCronAgentId(left);
  const normalizedRight = normalizeCronAgentId(right);
  return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
};

export const filterCronJobsForAgent = (jobs: CronJobSummary[], agentId: string): CronJobSummary[] => {
  if (!normalizeCronAgentId(agentId)) return [];
  return jobs.filter((job) => cronAgentIdsEqual(job.agentId, agentId));
};

export const resolveLatestCronJobForAgent = (
  jobs: CronJobSummary[],
  agentId: string
): CronJobSummary | null => {
  const filtered = filterCronJobsForAgent(jobs, agentId);
  if (filtered.length === 0) return null;
  return [...filtered].sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] ?? null;
};

const formatEveryMs = (everyMs: number) => {
  if (everyMs % 3600000 === 0) {
    return `${everyMs / 3600000}h`;
  }
  if (everyMs % 60000 === 0) {
    return `${everyMs / 60000}m`;
  }
  if (everyMs % 1000 === 0) {
    return `${everyMs / 1000}s`;
  }
  return `${everyMs}ms`;
};

export const formatCronSchedule = (schedule: CronSchedule) => {
  if (schedule.kind === "every") {
    return `Every ${formatEveryMs(schedule.everyMs)}`;
  }
  if (schedule.kind === "cron") {
    return schedule.tz ? `Cron: ${schedule.expr} (${schedule.tz})` : `Cron: ${schedule.expr}`;
  }
  const atDate = new Date(schedule.at);
  if (Number.isNaN(atDate.getTime())) return `At: ${schedule.at}`;
  return `At: ${atDate.toLocaleString()}`;
};

export const formatCronPayload = (payload: CronPayload) => {
  if (payload.kind === "systemEvent") return payload.text;
  return payload.message;
};

export const formatCronJobDisplay = (job: CronJobSummary) => {
  const lines = [job.name, formatCronSchedule(job.schedule), formatCronPayload(job.payload)].filter(
    Boolean
  );
  return lines.join("\n");
};

type CronListParams = {
  includeDisabled?: boolean;
};

export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; ran: false; reason: "not-due" }
  | { ok: false };

type CronRemoveResult = { ok: true; removed: boolean } | { ok: false; removed: false };

export type CronJobRestoreInput = {
  name: string;
  agentId: string;
  sessionKey?: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  delivery?: CronDelivery;
};

type CronJobRemovalPlan = {
  id: string;
  restoreInput: CronJobRestoreInput;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const resolveJobId = (jobId: string): string => {
  const trimmed = jobId.trim();
  if (!trimmed) {
    throw new Error("Cron job id is required.");
  }
  return trimmed;
};

const resolveAgentId = (agentId: string): string => {
  const trimmed = agentId.trim();
  if (!trimmed) {
    throw new Error("Agent id is required.");
  }
  if (!isSafeAgentId(trimmed)) {
    throw new Error(`Invalid agentId: ${trimmed}`);
  }
  return trimmed;
};

const resolveCronJobName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Cron job name is required.");
  }
  return trimmed;
};

export const resolveOptionalCronSessionKey = (
  value: unknown,
  agentId: string,
  label = "sessionKey"
): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be string.`);
  }
  const sessionKey = value.trim();
  if (!sessionKey) {
    return undefined;
  }
  const explicitAgentId = parseAgentIdFromSessionKey(sessionKey);
  if (explicitAgentId) {
    if (explicitAgentId.trim().toLowerCase() !== agentId.trim().toLowerCase()) {
      throw new Error(`${label} does not match agentId.`);
    }
    return sessionKey;
  }
  if (/^agent:/i.test(sessionKey)) {
    throw new Error(`${label} is invalid.`);
  }
  return sessionKey;
};

export const listCronJobs = async (
  client: GatewayClient,
  params: CronListParams = {}
): Promise<CronJobsResult> => {
  const includeDisabled = params.includeDisabled ?? true;
  return client.call<CronJobsResult>("cron.list", {
    includeDisabled,
  });
};

export const runCronJobNow = async (client: GatewayClient, jobId: string): Promise<CronRunResult> => {
  const id = resolveJobId(jobId);
  return client.call<CronRunResult>("cron.run", {
    id,
    mode: "force",
  });
};

export const removeCronJob = async (
  client: GatewayClient,
  jobId: string
): Promise<CronRemoveResult> => {
  const id = resolveJobId(jobId);
  return client.call<CronRemoveResult>("cron.remove", {
    id,
  });
};

export const createCronJob = async (
  client: GatewayClient,
  input: CronJobCreateInput
): Promise<CronJobSummary> => {
  const name = resolveCronJobName(input.name);
  const agentId = resolveAgentId(input.agentId);
  const sessionKey = resolveOptionalCronSessionKey(input.sessionKey, agentId);
  return client.call<CronJobSummary>("cron.add", {
    ...input,
    name,
    agentId,
    ...(input.sessionKey !== undefined ? { sessionKey } : {}),
  });
};

const toCronJobRestoreInput = (job: CronJobSummary, agentId: string): CronJobRestoreInput => {
  const id = resolveJobId(job.id);
  const name = typeof job.name === "string" ? job.name.trim() : "";
  if (!name) {
    throw new Error(`Cron job ${id} is missing name.`);
  }
  if (typeof job.enabled !== "boolean") {
    throw new Error(`Cron job ${id} is missing enabled flag.`);
  }
  if (job.sessionTarget !== "main" && job.sessionTarget !== "isolated") {
    throw new Error(`Cron job ${id} has invalid sessionTarget.`);
  }
  if (job.wakeMode !== "next-heartbeat" && job.wakeMode !== "now") {
    throw new Error(`Cron job ${id} has invalid wakeMode.`);
  }
  if (!isRecord(job.schedule)) {
    throw new Error(`Cron job ${id} is missing schedule.`);
  }
  if (!isRecord(job.payload)) {
    throw new Error(`Cron job ${id} is missing payload.`);
  }

  const sessionKey = resolveOptionalCronSessionKey(
    job.sessionKey,
    agentId,
    `Cron job ${id} sessionKey`
  );
  const description = typeof job.description === "string" ? job.description : undefined;
  const deleteAfterRun = typeof job.deleteAfterRun === "boolean" ? job.deleteAfterRun : undefined;
  const delivery = isRecord(job.delivery) ? job.delivery : undefined;

  return {
    name,
    agentId,
    sessionKey,
    description,
    enabled: job.enabled,
    deleteAfterRun,
    schedule: job.schedule,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload,
    delivery: delivery as CronDelivery | undefined,
  };
};

const toCronJobRemovalPlan = (job: CronJobSummary, agentId: string): CronJobRemovalPlan => {
  const id = resolveJobId(job.id);
  return {
    id,
    restoreInput: toCronJobRestoreInput(job, agentId),
  };
};

const restoreRemovedJobsBestEffort = async (
  client: GatewayClient,
  removedJobs: CronJobRestoreInput[]
): Promise<void> => {
  if (removedJobs.length === 0) return;
  try {
    await restoreCronJobs(client, removedJobs);
  } catch (restoreErr) {
    console.error("Failed to restore cron jobs after partial deletion failure.", restoreErr);
  }
};

export const restoreCronJobs = async (
  client: GatewayClient,
  jobs: CronJobRestoreInput[]
): Promise<void> => {
  for (const job of jobs) {
    try {
      await createCronJob(client, job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to restore cron job "${job.name}" (${job.agentId}): ${message}`);
    }
  }
};

export const removeCronJobsForAgentWithBackup = async (
  client: GatewayClient,
  agentId: string
): Promise<CronJobRestoreInput[]> => {
  const id = resolveAgentId(agentId);
  const result = await listCronJobs(client, { includeDisabled: true });
  const jobs = result.jobs.filter((job) => cronAgentIdsEqual(job.agentId, id));
  const plans = jobs.map((job) => toCronJobRemovalPlan(job, id));
  const removedJobs: CronJobRestoreInput[] = [];
  for (const plan of plans) {
    let removeResult: CronRemoveResult;
    try {
      removeResult = await removeCronJob(client, plan.id);
    } catch (err) {
      await restoreRemovedJobsBestEffort(client, removedJobs);
      throw err;
    }
    if (!removeResult.ok) {
      await restoreRemovedJobsBestEffort(client, removedJobs);
      throw new Error(`Failed to delete cron job "${plan.restoreInput.name}" (${plan.id}).`);
    }
    if (removeResult.removed) {
      removedJobs.push(plan.restoreInput);
    }
  }
  return removedJobs;
};

export const removeCronJobsForAgent = async (client: GatewayClient, agentId: string): Promise<number> => {
  const removedJobs = await removeCronJobsForAgentWithBackup(client, agentId);
  return removedJobs.length;
};
