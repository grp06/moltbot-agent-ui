import { NextResponse } from "next/server";

import { isSafeAgentId } from "@/lib/agents/agentIds";
import { ensureDomainIntentRuntime, parseIntentBody } from "@/lib/controlplane/intent-route";
import { ControlPlaneGatewayError } from "@/lib/controlplane/openclaw-adapter";
import {
  resolveOptionalCronSessionKey,
  type CronDelivery,
  type CronPayload,
  type CronSchedule,
} from "@/lib/cron/types";

export const runtime = "nodejs";

type CronJobRestoreInput = {
  name: string;
  agentId: string;
  sessionKey?: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payload: CronPayload;
  delivery?: CronDelivery;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseRestoreJob = (value: unknown, index: number): CronJobRestoreInput => {
  if (!isRecord(value)) {
    throw new Error(`jobs[${index}] must be an object.`);
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) {
    throw new Error(`jobs[${index}].name is required.`);
  }
  const agentId = typeof value.agentId === "string" ? value.agentId.trim() : "";
  if (!agentId) {
    throw new Error(`jobs[${index}].agentId is required.`);
  }
  if (!isSafeAgentId(agentId)) {
    throw new Error(`jobs[${index}].agentId is invalid.`);
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error(`jobs[${index}].enabled must be boolean.`);
  }
  const sessionTarget = value.sessionTarget;
  if (sessionTarget !== "main" && sessionTarget !== "isolated") {
    throw new Error(`jobs[${index}].sessionTarget is invalid.`);
  }
  const wakeMode = value.wakeMode;
  if (wakeMode !== "next-heartbeat" && wakeMode !== "now") {
    throw new Error(`jobs[${index}].wakeMode is invalid.`);
  }
  const schedule = value.schedule;
  if (!isRecord(schedule)) {
    throw new Error(`jobs[${index}].schedule is required.`);
  }
  const payload = value.payload;
  if (!isRecord(payload)) {
    throw new Error(`jobs[${index}].payload is required.`);
  }

  const sessionKey = resolveOptionalCronSessionKey(
    value.sessionKey,
    agentId,
    `jobs[${index}].sessionKey`
  );
  const description = typeof value.description === "string" ? value.description : undefined;
  const deleteAfterRun = typeof value.deleteAfterRun === "boolean" ? value.deleteAfterRun : undefined;
  const delivery = isRecord(value.delivery) ? (value.delivery as CronDelivery) : undefined;

  return {
    name,
    agentId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(description ? { description } : {}),
    enabled: value.enabled,
    ...(typeof deleteAfterRun === "boolean" ? { deleteAfterRun } : {}),
    schedule: schedule as CronSchedule,
    sessionTarget,
    wakeMode,
    payload: payload as CronPayload,
    ...(delivery ? { delivery } : {}),
  };
};

const mapIntentError = (error: unknown): NextResponse => {
  if (error instanceof ControlPlaneGatewayError) {
    if (error.code.trim().toUpperCase() === "GATEWAY_UNAVAILABLE") {
      return NextResponse.json(
        {
          error: error.message,
          code: "GATEWAY_UNAVAILABLE",
          reason: "gateway_unavailable",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        details: error.details,
      },
      { status: 400 }
    );
  }
  const message = error instanceof Error ? error.message : "intent_failed";
  return NextResponse.json({ error: message }, { status: 500 });
};

export async function POST(request: Request) {
  const bodyOrError = await parseIntentBody(request);
  if (bodyOrError instanceof Response) {
    return bodyOrError as NextResponse;
  }

  const jobsRaw = bodyOrError.jobs;
  if (!Array.isArray(jobsRaw)) {
    return NextResponse.json({ error: "jobs must be an array." }, { status: 400 });
  }
  let jobs: CronJobRestoreInput[];
  try {
    jobs = jobsRaw.map((job, index) => parseRestoreJob(job, index));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid cron restore payload.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const runtimeOrError = await ensureDomainIntentRuntime();
  if (runtimeOrError instanceof Response) {
    return runtimeOrError as NextResponse;
  }

  try {
    for (const job of jobs) {
      await runtimeOrError.callGateway("cron.add", job);
    }
    return NextResponse.json({
      ok: true,
      payload: {
        restored: jobs.length,
      },
    });
  } catch (error) {
    return mapIntentError(error);
  }
}
