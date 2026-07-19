import type { CronJobSummary } from "@/lib/cron/types";
import {
  buildLatestUpdatePatch,
  resolveLatestUpdateIntent,
} from "@/features/agents/operations/latestUpdateWorkflow";
import type { AgentState } from "@/features/agents/state/store";
import { extractText, isHeartbeatPrompt, stripUiMetadata } from "@/lib/text/message-extract";
import type {
  DomainAgentHistoryResult,
  DomainChatHistoryMessage,
} from "@/lib/controlplane/domain-runtime-client";

const findLatestHeartbeatResponse = (messages: DomainChatHistoryMessage[]) => {
  let awaitingHeartbeatReply = false;
  let latestResponse: string | null = null;
  for (const message of messages) {
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "user") {
      const text = stripUiMetadata(extractText(message) ?? "").trim();
      awaitingHeartbeatReply = isHeartbeatPrompt(text);
      continue;
    }
    if (role === "assistant" && awaitingHeartbeatReply) {
      const text = stripUiMetadata(extractText(message) ?? "").trim();
      if (text) {
        latestResponse = text;
      }
    }
  }
  return latestResponse;
};

type SpecialLatestUpdateDeps = {
  loadAgentHistoryWindow: (params: {
    agentId: string;
    sessionKey: string;
    view?: "semantic" | "raw";
    limit?: number;
    turnLimit?: number;
    scanLimit?: number;
  }) => Promise<DomainAgentHistoryResult>;
  listCronJobs: () => Promise<{ jobs: CronJobSummary[] }>;
  resolveCronJobForAgent: (jobs: CronJobSummary[], agentId: string) => CronJobSummary | null;
  formatCronJobDisplay: (job: CronJobSummary) => string;
  dispatchUpdateAgent: (
    agentId: string,
    patch: { latestOverride: string | null; latestOverrideKind: "heartbeat" | "cron" | null }
  ) => void;
  isDisconnectLikeError: (err: unknown) => boolean;
  logError: (message: string) => void;
};

type SpecialLatestUpdateOperation = {
  update: (agentId: string, agent: AgentState, message: string) => Promise<void>;
  clearInFlight: (agentId: string) => void;
};

export function createSpecialLatestUpdateOperation(
  deps: SpecialLatestUpdateDeps
): SpecialLatestUpdateOperation {
  const inFlightTokenByAgent = new Map<string, number>();
  let nextInFlightToken = 1;

  const dispatchIfCurrent = (
    agentId: string,
    token: number,
    patch: { latestOverride: string | null; latestOverrideKind: "heartbeat" | "cron" | null }
  ) => {
    if (inFlightTokenByAgent.get(agentId) !== token) return;
    deps.dispatchUpdateAgent(agentId, patch);
  };

  const update: SpecialLatestUpdateOperation["update"] = async (agentId, agent, message) => {
    const intent = resolveLatestUpdateIntent({
      message,
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      hasExistingOverride: Boolean(agent.latestOverride || agent.latestOverrideKind),
    });
    if (intent.kind === "noop") return;
    if (intent.kind === "reset") {
      inFlightTokenByAgent.delete(agentId);
      deps.dispatchUpdateAgent(agent.agentId, buildLatestUpdatePatch(""));
      return;
    }

    const key = agentId;
    if (inFlightTokenByAgent.has(key)) return;
    const token = nextInFlightToken;
    nextInFlightToken += 1;
    inFlightTokenByAgent.set(key, token);

    try {
      if (intent.kind === "fetch-heartbeat") {
        const history = await deps.loadAgentHistoryWindow({
          agentId: intent.agentId,
          sessionKey: agent.sessionKey,
          view: "raw",
          limit: intent.historyLimit,
        });
        const content = findLatestHeartbeatResponse(history.messages) ?? "";
        dispatchIfCurrent(agent.agentId, token, buildLatestUpdatePatch(content, "heartbeat"));
        return;
      }

      if (intent.kind === "fetch-cron") {
        const cronResult = await deps.listCronJobs();
        const job = deps.resolveCronJobForAgent(cronResult.jobs, intent.agentId);
        const content = job ? deps.formatCronJobDisplay(job) : "";
        dispatchIfCurrent(agent.agentId, token, buildLatestUpdatePatch(content, "cron"));
      }
    } catch (err) {
      if (!deps.isDisconnectLikeError(err)) {
        const message =
          err instanceof Error ? err.message : "Failed to load latest cron/heartbeat update.";
        deps.logError(message);
      }
    } finally {
      if (inFlightTokenByAgent.get(key) === token) {
        inFlightTokenByAgent.delete(key);
      }
    }
  };

  const clearInFlight: SpecialLatestUpdateOperation["clearInFlight"] = (agentId) => {
    inFlightTokenByAgent.delete(agentId);
  };

  return { update, clearInFlight };
}
