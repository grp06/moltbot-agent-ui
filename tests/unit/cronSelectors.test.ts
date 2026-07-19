import { describe, expect, it } from "vitest";

import {
  filterCronJobsForAgent,
  formatCronJobDisplay,
  formatCronPayload,
  formatCronSchedule,
  resolveLatestCronJobForAgent,
} from "@/lib/cron/types";
import type { CronJobSummary } from "@/lib/cron/types";

const buildJob = (input: {
  id: string;
  agentId?: string;
  updatedAtMs: number;
}): CronJobSummary => ({
  id: input.id,
  name: input.id,
  enabled: true,
  updatedAtMs: input.updatedAtMs,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "hello" },
  state: {},
  ...(input.agentId ? { agentId: input.agentId } : {}),
});

describe("cron selectors", () => {
  it("filters_jobs_to_selected_agent", () => {
    const jobs = [
      buildJob({ id: "one", agentId: "agent-1", updatedAtMs: 10 }),
      buildJob({ id: "two", agentId: "agent-2", updatedAtMs: 20 }),
      buildJob({ id: "three", updatedAtMs: 30 }),
    ];

    expect(filterCronJobsForAgent(jobs, "agent-1").map((job) => job.id)).toEqual(["one"]);
    expect(filterCronJobsForAgent(jobs, "agent-2").map((job) => job.id)).toEqual(["two"]);
    expect(filterCronJobsForAgent(jobs, "missing")).toEqual([]);
  });

  it("resolves_latest_agent_job_by_updated_at", () => {
    const jobs = [
      buildJob({ id: "older", agentId: "agent-1", updatedAtMs: 10 }),
      buildJob({ id: "newer", agentId: "agent-1", updatedAtMs: 30 }),
      buildJob({ id: "other", agentId: "agent-2", updatedAtMs: 40 }),
    ];

    expect(resolveLatestCronJobForAgent(jobs, "agent-1")?.id).toBe("newer");
    expect(resolveLatestCronJobForAgent(jobs, "agent-2")?.id).toBe("other");
    expect(resolveLatestCronJobForAgent(jobs, "missing")).toBeNull();
  });

  it("matches_agent_ids_after_trimming_whitespace", () => {
    const jobs = [
      buildJob({ id: "trimmed", agentId: "agent-1", updatedAtMs: 20 }),
      buildJob({ id: "other", agentId: "agent-2", updatedAtMs: 30 }),
    ];

    expect(filterCronJobsForAgent(jobs, "  agent-1  ").map((job) => job.id)).toEqual(["trimmed"]);
    expect(resolveLatestCronJobForAgent(jobs, "  agent-1  ")?.id).toBe("trimmed");
  });

  it("matches_agent_ids_case_insensitively_after_gateway_normalization", () => {
    const jobs = [
      buildJob({ id: "owned", agentId: "Agent-1", updatedAtMs: 20 }),
      buildJob({ id: "other", agentId: "agent-2", updatedAtMs: 30 }),
    ];

    expect(filterCronJobsForAgent(jobs, "agent-1").map((job) => job.id)).toEqual(["owned"]);
    expect(resolveLatestCronJobForAgent(jobs, "AGENT-1")?.id).toBe("owned");
  });
});

describe("cron formatting", () => {
  it("formats_every_schedule_with_h_m_s_ms_suffixes", () => {
    expect(formatCronSchedule({ kind: "every", everyMs: 3_600_000 })).toBe("Every 1h");
    expect(formatCronSchedule({ kind: "every", everyMs: 60_000 })).toBe("Every 1m");
    expect(formatCronSchedule({ kind: "every", everyMs: 1_000 })).toBe("Every 1s");
    expect(formatCronSchedule({ kind: "every", everyMs: 1_500 })).toBe("Every 1500ms");
  });

  it("formats_cron_schedule_with_optional_tz", () => {
    expect(formatCronSchedule({ kind: "cron", expr: "0 0 * * *" })).toBe("Cron: 0 0 * * *");
    expect(formatCronSchedule({ kind: "cron", expr: "0 0 * * *", tz: "UTC" })).toBe(
      "Cron: 0 0 * * * (UTC)"
    );
  });

  it("formats_at_schedule_as_raw_when_not_parseable", () => {
    expect(formatCronSchedule({ kind: "at", at: "not-a-date" })).toBe("At: not-a-date");
  });

  it("formats_cron_payload_text", () => {
    expect(formatCronPayload({ kind: "systemEvent", text: "hello" })).toBe("hello");
    expect(formatCronPayload({ kind: "agentTurn", message: "hi" })).toBe("hi");
  });

  it("formats_cron_job_display_as_three_lines", () => {
    const job: CronJobSummary = {
      id: "job-1",
      name: "Job name",
      enabled: true,
      updatedAtMs: 10,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hi" },
      state: {},
    };

    expect(formatCronJobDisplay(job)).toBe("Job name\nEvery 1m\nhi");
  });
});
