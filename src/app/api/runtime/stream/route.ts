import type { ControlPlaneOutboxEntry } from "@/lib/controlplane/contracts";
import { serializeRuntimeInitFailure } from "@/lib/controlplane/runtime-init-errors";
import { bootstrapDomainRuntime } from "@/lib/controlplane/runtime-route-bootstrap";

export const runtime = "nodejs";

const REPLAY_LIMIT = 2000;
const HEARTBEAT_INTERVAL_MS = 15_000;

const encoder = new TextEncoder();

const parseRawEventId = (raw: string | null): number | null => {
  if (!raw) return null;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

export const parseLastEventIdFromRequest = (request: Request): number => {
  const url = new URL(request.url);
  const queryValue = parseRawEventId(url.searchParams.get("lastEventId"));
  if (queryValue !== null) return queryValue;
  const headerValue = parseRawEventId(request.headers.get("last-event-id"));
  return headerValue ?? 0;
};

const toSseFrame = (entry: ControlPlaneOutboxEntry): Uint8Array => {
  const eventName = entry.event.type === "runtime.status" ? "runtime.status" : "gateway.event";
  return encoder.encode(
    `id: ${entry.id}\nevent: ${eventName}\ndata: ${JSON.stringify(entry.event)}\n\n`
  );
};

const heartbeatFrame = (): Uint8Array => encoder.encode(": heartbeat\n\n");

export async function GET(request: Request) {
  const bootstrap = await bootstrapDomainRuntime();
  if (bootstrap.kind === "mode-disabled") {
    return new Response(
      JSON.stringify({ enabled: false, error: "domain_api_mode_disabled" }),
      { status: 404, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
  if (bootstrap.kind === "runtime-init-failed") {
    return new Response(
      JSON.stringify({
        enabled: true,
        ...serializeRuntimeInitFailure(bootstrap.failure),
      }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
  if (bootstrap.kind === "start-failed") {
    return new Response(
      JSON.stringify({
        enabled: true,
        error: bootstrap.message,
      }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
  const controlPlane = bootstrap.runtime;
  const lastSeenId = parseLastEventIdFromRequest(request);
  let cleanupStream: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: () => void = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let startupPhase = true;
      let lastDeliveredId = lastSeenId;
      const startupLiveBuffer: ControlPlaneOutboxEntry[] = [];
      const abortListener = () => {
        close();
      };
      const cleanup = (): boolean => {
        if (closed) return false;
        closed = true;
        request.signal.removeEventListener("abort", abortListener);
        unsubscribe();
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        cleanupStream = () => {};
        return true;
      };
      const close = () => {
        if (!cleanup()) return;
        try {
          controller.close();
        } catch (err) {
          console.error("Failed to close runtime stream controller.", err);
        }
      };
      cleanupStream = () => {
        cleanup();
      };
      const enqueueFrame = (frame: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(frame);
          return true;
        } catch (err) {
          console.error("Failed to enqueue runtime stream frame.", err);
          close();
          return false;
        }
      };
      const emitEntry = (entry: ControlPlaneOutboxEntry): boolean => {
        if (entry.id <= lastDeliveredId) {
          return true;
        }
        if (!enqueueFrame(toSseFrame(entry))) {
          return false;
        }
        lastDeliveredId = entry.id;
        return true;
      };

      request.signal.addEventListener("abort", abortListener, { once: true });
      if (request.signal.aborted) {
        close();
        return;
      }

      unsubscribe = controlPlane.subscribe((entry) => {
        if (closed) {
          return;
        }
        if (startupPhase) {
          startupLiveBuffer.push(entry);
          return;
        }
        emitEntry(entry);
      });

      const startupSnapshot = controlPlane.snapshot();
      const replayUpperBound =
        lastSeenId > 0 ? startupSnapshot.outboxHead : Number.POSITIVE_INFINITY;
      if (lastSeenId > 0) {
        lastDeliveredId = Math.min(lastSeenId, replayUpperBound);
      } else {
        lastDeliveredId = Math.max(0, startupSnapshot.outboxHead - REPLAY_LIMIT);
      }

      let replayCursor = lastDeliveredId;
      while (true) {
        const replayEntries = controlPlane.eventsAfter(replayCursor, REPLAY_LIMIT);
        if (replayEntries.length === 0) {
          break;
        }

        let reachedReplayUpperBound = false;
        for (const entry of replayEntries) {
          if (entry.id > replayUpperBound) {
            reachedReplayUpperBound = true;
            break;
          }
          if (!emitEntry(entry)) {
            return;
          }
        }

        replayCursor = lastDeliveredId;
        if (
          lastSeenId <= 0 ||
          reachedReplayUpperBound ||
          replayEntries.length < REPLAY_LIMIT ||
          replayCursor >= replayUpperBound
        ) {
          break;
        }
      }

      startupLiveBuffer.sort((left, right) => left.id - right.id);
      for (const entry of startupLiveBuffer) {
        if (!emitEntry(entry)) {
          return;
        }
      }
      startupLiveBuffer.length = 0;

      startupPhase = false;

      heartbeat = setInterval(() => {
        enqueueFrame(heartbeatFrame());
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      cleanupStream();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
