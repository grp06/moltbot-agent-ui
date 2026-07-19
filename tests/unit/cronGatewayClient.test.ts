import { describe, expect, it, vi } from "vitest";

import {
  createCronJob,
  listCronJobs,
  removeCronJob,
  removeCronJobsForAgent,
  removeCronJobsForAgentWithBackup,
  restoreCronJobs,
  runCronJobNow,
  type CronJobSummary,
} from "@/lib/cron/types";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";

const createListedJob = (params: {
  id: string;
  name: string;
  agentId?: string;
  sessionKey?: string;
  updatedAtMs?: number;
}): CronJobSummary => ({
  id: params.id,
  name: params.name,
  agentId: params.agentId,
  sessionKey: params.sessionKey,
  enabled: true,
  updatedAtMs: params.updatedAtMs ?? 1_700_000_000_000,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Run checks." },
  state: {},
});

describe("cron gateway client", () => {
  it("lists_jobs_via_cron_list_include_disabled_true", async () => {
    const client = {
      call: vi.fn(async () => ({ jobs: [] })),
    } as unknown as GatewayClient;

    await listCronJobs(client);

    expect(client.call).toHaveBeenCalledWith("cron.list", { includeDisabled: true });
  });

  it("runs_job_now_with_force_mode", async () => {
    const client = {
      call: vi.fn(async () => ({ ok: true, ran: true })),
    } as unknown as GatewayClient;

    await runCronJobNow(client, "job-1");

    expect(client.call).toHaveBeenCalledWith("cron.run", { id: "job-1", mode: "force" });
  });

  it("removes_job_by_id", async () => {
    const client = {
      call: vi.fn(async () => ({ ok: true, removed: true })),
    } as unknown as GatewayClient;

    await removeCronJob(client, "job-1");

    expect(client.call).toHaveBeenCalledWith("cron.remove", { id: "job-1" });
  });

  it("throws_when_job_id_missing_for_run_or_remove", async () => {
    const client = {
      call: vi.fn(async () => ({ ok: true })),
    } as unknown as GatewayClient;

    await expect(runCronJobNow(client, "   ")).rejects.toThrow("Cron job id is required.");
    await expect(removeCronJob(client, "")).rejects.toThrow("Cron job id is required.");
  });

  it("removes_all_jobs_for_agent", async () => {
    const client = {
      call: vi.fn(async (method: string, payload: { id?: string }) => {
        if (method === "cron.list") {
          return {
            jobs: [
              createListedJob({ id: "job-1", name: "Job 1", agentId: "agent-1" }),
              createListedJob({ id: "job-2", name: "Job 2", agentId: "agent-2" }),
              createListedJob({ id: "job-3", name: "Job 3", agentId: "agent-1" }),
            ],
          };
        }
        if (method === "cron.remove") {
          return { ok: true, removed: payload.id !== "job-3" };
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await expect(removeCronJobsForAgent(client, "agent-1")).resolves.toBe(1);
    expect(client.call).toHaveBeenCalledWith("cron.list", { includeDisabled: true });
    expect(client.call).toHaveBeenCalledWith("cron.remove", { id: "job-1" });
    expect(client.call).toHaveBeenCalledWith("cron.remove", { id: "job-3" });
  });

  it("throws_when_agent_id_missing_for_bulk_remove", async () => {
    const client = {
      call: vi.fn(async () => ({ jobs: [] })),
    } as unknown as GatewayClient;

    await expect(removeCronJobsForAgent(client, "   ")).rejects.toThrow("Agent id is required.");
  });

  it("throws_when_any_bulk_remove_call_fails", async () => {
    const client = {
      call: vi.fn(async (method: string) => {
        if (method === "cron.list") {
          return {
            jobs: [createListedJob({ id: "job-1", name: "Job 1", agentId: "agent-1" })],
          };
        }
        if (method === "cron.remove") {
          return { ok: false, removed: false };
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await expect(removeCronJobsForAgent(client, "agent-1")).rejects.toThrow(
      'Failed to delete cron job "Job 1" (job-1).'
    );
  });

  it("returns_restore_inputs_when_removing_jobs_with_backup", async () => {
    const client = {
      call: vi.fn(async (method: string, payload: { id?: string }) => {
        if (method === "cron.list") {
          return {
            jobs: [
              createListedJob({ id: "job-1", name: "Job 1", agentId: "agent-1" }),
              createListedJob({ id: "job-2", name: "Job 2", agentId: "agent-2" }),
              createListedJob({ id: "job-3", name: "Job 3", agentId: "agent-1" }),
            ],
          };
        }
        if (method === "cron.remove") {
          return { ok: true, removed: payload.id !== "job-3" };
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await expect(removeCronJobsForAgentWithBackup(client, "agent-1")).resolves.toEqual([
      {
        name: "Job 1",
        agentId: "agent-1",
        sessionKey: undefined,
        description: undefined,
        enabled: true,
        deleteAfterRun: undefined,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Run checks." },
        delivery: undefined,
      },
    ]);
  });

  it("removes_case_normalized_agent_jobs_with_backup", async () => {
    const client = {
      call: vi.fn(async (method: string, payload: { id?: string }) => {
        if (method === "cron.list") {
          return {
            jobs: [
              createListedJob({ id: "job-1", name: "Job 1", agentId: "Agent-1" }),
              createListedJob({ id: "job-2", name: "Job 2", agentId: "agent-2" }),
            ],
          };
        }
        if (method === "cron.remove") {
          return { ok: true, removed: payload.id === "job-1" };
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await expect(removeCronJobsForAgentWithBackup(client, "agent-1")).resolves.toEqual([
      expect.objectContaining({
        name: "Job 1",
        agentId: "agent-1",
      }),
    ]);
    expect(client.call).toHaveBeenCalledWith("cron.remove", { id: "job-1" });
    expect(client.call).not.toHaveBeenCalledWith("cron.remove", { id: "job-2" });
  });

  it("validates_all_restore_payloads_before_deleting_backup_jobs", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs: [
            createListedJob({ id: "job-1", name: "Job 1", agentId: "agent-1" }),
            createListedJob({ id: "job-2", name: "   ", agentId: "agent-1" }),
          ],
        };
      }
      if (method === "cron.remove") {
        return { ok: true, removed: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { call } as unknown as GatewayClient;

    await expect(removeCronJobsForAgentWithBackup(client, "agent-1")).rejects.toThrow(
      "Cron job job-2 is missing name."
    );

    expect(call.mock.calls.map(([method]) => method)).toEqual(["cron.list"]);
  });

  it("validates_backup_session_keys_before_deleting_jobs", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs: [
            createListedJob({
              id: "job-1",
              name: "Job 1",
              agentId: "agent-1",
              sessionKey: "agent:agent-2:main",
            }),
          ],
        };
      }
      if (method === "cron.remove") {
        return { ok: true, removed: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = { call } as unknown as GatewayClient;

    await expect(removeCronJobsForAgentWithBackup(client, "agent-1")).rejects.toThrow(
      "Cron job job-1 sessionKey does not match agentId."
    );

    expect(call.mock.calls.map(([method]) => method)).toEqual(["cron.list"]);
  });

  it("preserves_shorthand_backup_session_keys_for_agent_jobs", async () => {
    const client = {
      call: vi.fn(async (method: string, payload: { id?: string }) => {
        if (method === "cron.list") {
          return {
            jobs: [
              createListedJob({
                id: "job-1",
                name: "Job 1",
                agentId: "agent-1",
                sessionKey: "project-alpha-monitor",
              }),
            ],
          };
        }
        if (method === "cron.remove") {
          return { ok: true, removed: payload.id === "job-1" };
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await expect(removeCronJobsForAgentWithBackup(client, "agent-1")).resolves.toEqual([
      expect.objectContaining({
        name: "Job 1",
        agentId: "agent-1",
        sessionKey: "project-alpha-monitor",
      }),
    ]);
  });

  it("restores_removed_jobs_when_backup_remove_fails_midway", async () => {
    const client = {
      call: vi.fn(async (method: string, payload: { id?: string; name?: string }) => {
        if (method === "cron.list") {
          return {
            jobs: [
              createListedJob({ id: "job-1", name: "Job 1", agentId: "agent-1" }),
              createListedJob({ id: "job-2", name: "Job 2", agentId: "agent-1" }),
            ],
          };
        }
        if (method === "cron.remove") {
          if (payload.id === "job-1") return { ok: true, removed: true };
          return { ok: false, removed: false };
        }
        if (method === "cron.add") {
          return { id: "restored-job-1", name: payload.name };
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await expect(removeCronJobsForAgentWithBackup(client, "agent-1")).rejects.toThrow(
      'Failed to delete cron job "Job 2" (job-2).'
    );

    expect(client.call).toHaveBeenCalledWith("cron.add", {
      name: "Job 1",
      agentId: "agent-1",
      sessionKey: undefined,
      description: undefined,
      enabled: true,
      deleteAfterRun: undefined,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Run checks." },
      delivery: undefined,
    });
  });

  it("restores_removed_jobs_when_remove_call_throws_midway", async () => {
    const thrown = new Error("network interrupted");
    const client = {
      call: vi.fn(async (method: string, payload: { id?: string; name?: string }) => {
        if (method === "cron.list") {
          return {
            jobs: [
              createListedJob({ id: "job-1", name: "Job 1", agentId: "agent-1" }),
              createListedJob({ id: "job-2", name: "Job 2", agentId: "agent-1" }),
            ],
          };
        }
        if (method === "cron.remove") {
          if (payload.id === "job-1") return { ok: true, removed: true };
          throw thrown;
        }
        if (method === "cron.add") {
          return { id: "restored-job-1", name: payload.name };
        }
        throw new Error(`Unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await expect(removeCronJobsForAgentWithBackup(client, "agent-1")).rejects.toBe(thrown);

    expect(client.call).toHaveBeenCalledWith("cron.add", {
      name: "Job 1",
      agentId: "agent-1",
      sessionKey: undefined,
      description: undefined,
      enabled: true,
      deleteAfterRun: undefined,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Run checks." },
      delivery: undefined,
    });
  });

  it("throws_actionable_error_when_restore_fails", async () => {
    const client = {
      call: vi.fn(async (_method: string, payload: { name?: string }) => {
        if (payload.name === "Job 2") {
          throw new Error("cron.add failed");
        }
        return { id: "job-restored", name: payload.name };
      }),
    } as unknown as GatewayClient;

    await expect(
      restoreCronJobs(client, [
        {
          name: "Job 1",
          agentId: "agent-1",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Run checks." },
        },
        {
          name: "Job 2",
          agentId: "agent-1",
          enabled: true,
          schedule: { kind: "every", everyMs: 120_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Run checks again." },
        },
      ])
    ).rejects.toThrow('Failed to restore cron job "Job 2" (agent-1): cron.add failed');
  });

  it("creates_job_via_cron_add", async () => {
    const client = {
      call: vi.fn(async () => ({ id: "job-1", name: "Morning brief" })),
    } as unknown as GatewayClient;

    const input = {
      name: "Morning brief",
      agentId: "agent-1",
      enabled: true,
      schedule: { kind: "cron" as const, expr: "0 7 * * *", tz: "America/Chicago" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "Summarize overnight updates." },
      delivery: { mode: "announce" as const, channel: "last" },
    };

    await createCronJob(client, input);

    expect(client.call).toHaveBeenCalledWith("cron.add", input);
  });

  it("trims_owned_session_key_when_creating_job", async () => {
    const client = {
      call: vi.fn(async () => ({ id: "job-1", name: "Morning brief" })),
    } as unknown as GatewayClient;

    const input = {
      name: "Morning brief",
      agentId: "agent-1",
      sessionKey: " agent:agent-1:main ",
      enabled: true,
      schedule: { kind: "cron" as const, expr: "0 7 * * *", tz: "America/Chicago" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "Summarize overnight updates." },
    };

    await createCronJob(client, input);

    expect(client.call).toHaveBeenCalledWith("cron.add", {
      ...input,
      sessionKey: "agent:agent-1:main",
    });
  });

  it("allows_shorthand_session_key_when_creating_job", async () => {
    const client = {
      call: vi.fn(async () => ({ id: "job-1", name: "Morning brief" })),
    } as unknown as GatewayClient;

    const input = {
      name: "Morning brief",
      agentId: "agent-1",
      sessionKey: " project-alpha-monitor ",
      enabled: true,
      schedule: { kind: "cron" as const, expr: "0 7 * * *", tz: "America/Chicago" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "Summarize overnight updates." },
    };

    await createCronJob(client, input);

    expect(client.call).toHaveBeenCalledWith("cron.add", {
      ...input,
      sessionKey: "project-alpha-monitor",
    });
  });

  it("rejects_foreign_session_key_when_creating_job", async () => {
    const client = {
      call: vi.fn(async () => ({ id: "job-1" })),
    } as unknown as GatewayClient;

    await expect(
      createCronJob(client, {
        name: "Morning brief",
        agentId: "agent-1",
        sessionKey: "agent:agent-2:main",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Run checks." },
      })
    ).rejects.toThrow("sessionKey does not match agentId.");
    expect(client.call).not.toHaveBeenCalled();
  });

  it("throws_when_create_payload_missing_required_name", async () => {
    const client = {
      call: vi.fn(async () => ({ id: "job-1" })),
    } as unknown as GatewayClient;

    await expect(
      createCronJob(client, {
        name: "   ",
        agentId: "agent-1",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Run checks." },
      })
    ).rejects.toThrow("Cron job name is required.");
  });
});
