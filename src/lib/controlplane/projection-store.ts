import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import type {
  ControlPlaneDomainEvent,
  ControlPlaneOutboxEntry,
  ControlPlaneRuntimeSnapshot,
} from "@/lib/controlplane/contracts";
import { resolveSafeAgentId } from "@/lib/agents/agentIds";
import { deriveControlPlaneEventKey } from "@/lib/controlplane/outbox";
import { resolveStateDir } from "@/lib/clawdbot/paths";
import { parseAgentIdFromSessionKey } from "@/lib/gateway/session-keys";

const require = createRequire(import.meta.url);

const RUNTIME_DB_DIRNAME = "openclaw-studio";
const RUNTIME_DB_FILENAME = "runtime.db";

const DEFAULT_STATUS = "stopped" as const;
const NO_AGENT_SENTINEL = "";
const DEFAULT_BACKFILL_BATCH_LIMIT = 500;

type OutboxRow = {
  id: number;
  event_json: string;
  created_at: string;
  agent_id: string | null;
};

type LegacyBackfillRow = {
  id: number;
  event_json: string;
};

type ProjectionRow = {
  status: string;
  reason: string | null;
  as_of: string | null;
};

type OutboxColumnInfo = {
  name: string;
};

type BetterSqlite3Factory = typeof BetterSqlite3;
type BetterSqlite3Database = BetterSqlite3.Database;
type BetterSqlite3Statement<BindParams extends unknown[] = unknown[], Result = unknown> =
  BetterSqlite3.Statement<BindParams, Result>;

const loadBetterSqlite3 = (): BetterSqlite3Factory =>
  require("better-sqlite3") as BetterSqlite3Factory;

const parseDomainEvent = (raw: string): ControlPlaneDomainEvent => {
  return JSON.parse(raw) as ControlPlaneDomainEvent;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const resolveEventAgentId = (value: unknown): string | null => {
  const resolved = resolveSafeAgentId(value);
  return resolved ? resolved.toLowerCase() : null;
};

const resolveEventSessionAgentId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const resolved = parseAgentIdFromSessionKey(value);
  return resolved ? resolved.toLowerCase() : null;
};

const resolveAgentIdFromControlPlaneEvent = (event: ControlPlaneDomainEvent): string | null => {
  if (event.type !== "gateway.event") return null;
  const payload = event.payload;
  if (!isObject(payload)) return null;
  const directAgentId = resolveEventAgentId(payload.agentId);
  if (directAgentId) return directAgentId;
  return (
    resolveEventSessionAgentId(payload.sessionKey) ??
    resolveEventSessionAgentId(payload.key) ??
    resolveEventSessionAgentId(payload.runSessionKey)
  );
};

const toOutboxEntry = (row: OutboxRow): ControlPlaneOutboxEntry => {
  return {
    id: row.id,
    event: parseDomainEvent(row.event_json),
    createdAt: row.created_at,
  };
};

const resolveControlPlaneRuntimeDbPath = (): string =>
  path.join(resolveStateDir(), RUNTIME_DB_DIRNAME, RUNTIME_DB_FILENAME);

export type BackfillAgentOutboxResult = {
  scannedRows: number;
  updatedRows: number;
  exhausted: boolean;
};

export class SQLiteControlPlaneProjectionStore {
  private readonly db: BetterSqlite3Database;
  private readonly readProjectionStmt: BetterSqlite3Statement<[], ProjectionRow | undefined>;
  private readonly readOutboxHeadStmt: BetterSqlite3Statement<[], { head: number }>;
  private readonly readOutboxAfterStmt: BetterSqlite3Statement<[number, number], OutboxRow>;
  private readonly readOutboxBeforeStmt: BetterSqlite3Statement<[number, number], OutboxRow>;
  private readonly readAgentOutboxBeforeStmt: BetterSqlite3Statement<[string, number, number], OutboxRow>;
  private readonly readOutboxByIdStmt: BetterSqlite3Statement<[number], OutboxRow | undefined>;
  private readonly readBackfillCandidatesStmt: BetterSqlite3Statement<[number, number], LegacyBackfillRow>;
  private readonly readProcessedStmt: BetterSqlite3Statement<
    [string],
    { outbox_id: number | null } | undefined
  >;
  private readonly insertProcessedStmt: BetterSqlite3Statement<[string, string]>;
  private readonly insertOutboxStmt: BetterSqlite3Statement<[string, string, string, string]>;
  private readonly updateProcessedOutboxStmt: BetterSqlite3Statement<[number, string]>;
  private readonly updateOutboxAgentIdIfNullStmt: BetterSqlite3Statement<[string, number]>;
  private readonly upsertStatusProjectionStmt: BetterSqlite3Statement<
    [string, string | null, string, string]
  >;
  private readonly upsertGatewayProjectionStmt: BetterSqlite3Statement<[string, string]>;
  private readonly applyEventTx: (
    event: ControlPlaneDomainEvent,
    eventKey: string
  ) => ControlPlaneOutboxEntry;
  private readonly backfillOutboxAgentIdsTx: (rows: LegacyBackfillRow[]) => number;

  constructor(dbPath: string = resolveControlPlaneRuntimeDbPath()) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const BetterSqlite3 = loadBetterSqlite3();
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();

    this.readProjectionStmt = this.db.prepare(
      "SELECT status, reason, as_of FROM runtime_projection WHERE id = 1"
    );
    this.readOutboxHeadStmt = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS head FROM outbox");
    this.readOutboxAfterStmt = this.db.prepare(
      "SELECT id, event_json, created_at, agent_id FROM outbox WHERE id > ? ORDER BY id ASC LIMIT ?"
    );
    this.readOutboxBeforeStmt = this.db.prepare(
      "SELECT id, event_json, created_at, agent_id FROM outbox WHERE id < ? ORDER BY id DESC LIMIT ?"
    );
    this.readAgentOutboxBeforeStmt = this.db.prepare(
      "SELECT id, event_json, created_at, agent_id FROM outbox WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
    );
    this.readOutboxByIdStmt = this.db.prepare(
      "SELECT id, event_json, created_at, agent_id FROM outbox WHERE id = ?"
    );
    this.readBackfillCandidatesStmt = this.db.prepare(
      "SELECT id, event_json FROM outbox WHERE agent_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?"
    );
    this.readProcessedStmt = this.db.prepare(
      "SELECT outbox_id FROM processed_events WHERE event_key = ?"
    );
    this.insertProcessedStmt = this.db.prepare(
      "INSERT OR IGNORE INTO processed_events (event_key, created_at) VALUES (?, ?)"
    );
    this.insertOutboxStmt = this.db.prepare(
      "INSERT INTO outbox (event_type, event_json, created_at, agent_id) VALUES (?, ?, ?, ?)"
    );
    this.updateProcessedOutboxStmt = this.db.prepare(
      "UPDATE processed_events SET outbox_id = ? WHERE event_key = ?"
    );
    this.updateOutboxAgentIdIfNullStmt = this.db.prepare(
      "UPDATE outbox SET agent_id = ? WHERE id = ? AND agent_id IS NULL"
    );
    this.upsertStatusProjectionStmt = this.db.prepare(`
      INSERT INTO runtime_projection (id, status, reason, as_of, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        as_of = excluded.as_of,
        updated_at = excluded.updated_at
    `);
    this.upsertGatewayProjectionStmt = this.db.prepare(`
      INSERT INTO runtime_projection (id, status, reason, as_of, updated_at)
      VALUES (1, '${DEFAULT_STATUS}', NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        as_of = excluded.as_of,
        updated_at = excluded.updated_at
    `);

    this.applyEventTx = this.db.transaction((event: ControlPlaneDomainEvent, eventKey: string) => {
      const existing = this.readProcessedStmt.get(eventKey);
      const nextAgentId = resolveAgentIdFromControlPlaneEvent(event) ?? NO_AGENT_SENTINEL;
      if (existing?.outbox_id) {
        const row = this.readOutboxByIdStmt.get(existing.outbox_id);
        if (!row) {
          throw new Error(`Outbox row missing for processed event key: ${eventKey}`);
        }
        if (row.agent_id == null) {
          this.updateOutboxAgentIdIfNullStmt.run(nextAgentId, row.id);
        }
        return toOutboxEntry(row);
      }

      const now = new Date().toISOString();
      this.insertProcessedStmt.run(eventKey, now);

      if (event.type === "runtime.status") {
        this.upsertStatusProjectionStmt.run(event.status, event.reason ?? null, event.asOf, now);
      } else {
        this.upsertGatewayProjectionStmt.run(event.asOf, now);
      }

      const info = this.insertOutboxStmt.run(event.type, JSON.stringify(event), now, nextAgentId);
      const outboxId = Number(info.lastInsertRowid);
      this.updateProcessedOutboxStmt.run(outboxId, eventKey);

      const row = this.readOutboxByIdStmt.get(outboxId);
      if (!row) {
        throw new Error(`Failed to read inserted outbox row id=${outboxId}`);
      }
      return toOutboxEntry(row);
    });

    this.backfillOutboxAgentIdsTx = this.db.transaction((rows: LegacyBackfillRow[]) => {
      let updatedRows = 0;
      for (const row of rows) {
        let nextAgentId = NO_AGENT_SENTINEL;
        try {
          nextAgentId = resolveAgentIdFromControlPlaneEvent(parseDomainEvent(row.event_json)) ?? NO_AGENT_SENTINEL;
        } catch (error) {
          console.error("Failed to parse outbox event while backfilling agent history index.", error);
        }
        const result = this.updateOutboxAgentIdIfNullStmt.run(nextAgentId, row.id);
        updatedRows += Number(result.changes ?? 0);
      }
      return updatedRows;
    });
  }

  applyDomainEvent(
    event: ControlPlaneDomainEvent,
    eventKey: string = deriveControlPlaneEventKey(event)
  ): ControlPlaneOutboxEntry {
    return this.applyEventTx(event, eventKey);
  }

  readOutboxAfter(lastSeenId: number, limit: number = 500): ControlPlaneOutboxEntry[] {
    const safeLastSeen = Number.isFinite(lastSeenId) && lastSeenId >= 0 ? lastSeenId : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
    return this.readOutboxAfterStmt.all(safeLastSeen, safeLimit).map(toOutboxEntry);
  }

  readOutboxBefore(beforeOutboxId: number, limit: number = 500): ControlPlaneOutboxEntry[] {
    const safeBeforeOutboxId =
      Number.isFinite(beforeOutboxId) && beforeOutboxId > 0 ? Math.floor(beforeOutboxId) : 0;
    if (safeBeforeOutboxId <= 0) return [];
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
    return this.readOutboxBeforeStmt
      .all(safeBeforeOutboxId, safeLimit)
      .reverse()
      .map(toOutboxEntry);
  }

  readAgentOutboxBefore(
    agentId: string,
    beforeOutboxId: number,
    limit: number = 500
  ): ControlPlaneOutboxEntry[] {
    const normalizedAgentId = agentId.trim().toLowerCase();
    if (!normalizedAgentId) return [];
    const safeBeforeOutboxId =
      Number.isFinite(beforeOutboxId) && beforeOutboxId > 0 ? Math.floor(beforeOutboxId) : 0;
    if (safeBeforeOutboxId <= 0) return [];
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
    return this.readAgentOutboxBeforeStmt
      .all(normalizedAgentId, safeBeforeOutboxId, safeLimit)
      .reverse()
      .map(toOutboxEntry);
  }

  backfillAgentOutboxBefore(
    beforeOutboxId: number,
    limit: number = DEFAULT_BACKFILL_BATCH_LIMIT
  ): BackfillAgentOutboxResult {
    const safeBeforeOutboxId =
      Number.isFinite(beforeOutboxId) && beforeOutboxId > 0 ? Math.floor(beforeOutboxId) : 0;
    if (safeBeforeOutboxId <= 0) {
      return {
        scannedRows: 0,
        updatedRows: 0,
        exhausted: true,
      };
    }
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_BACKFILL_BATCH_LIMIT;
    const candidates = this.readBackfillCandidatesStmt.all(safeBeforeOutboxId, safeLimit);
    if (candidates.length === 0) {
      return {
        scannedRows: 0,
        updatedRows: 0,
        exhausted: true,
      };
    }
    const updatedRows = this.backfillOutboxAgentIdsTx(candidates);
    return {
      scannedRows: candidates.length,
      updatedRows,
      exhausted: candidates.length < safeLimit,
    };
  }

  outboxHead(): number {
    const row = this.readOutboxHeadStmt.get();
    return row?.head ?? 0;
  }

  snapshot(): ControlPlaneRuntimeSnapshot {
    const projection = this.readProjectionStmt.get();
    const outboxHead = this.outboxHead();
    if (!projection) {
      return {
        status: DEFAULT_STATUS,
        reason: null,
        asOf: null,
        outboxHead,
      };
    }
    return {
      status: projection.status as ControlPlaneRuntimeSnapshot["status"],
      reason: projection.reason,
      asOf: projection.as_of,
      outboxHead,
    };
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_projection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL,
        reason TEXT,
        as_of TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_events (
        event_key TEXT PRIMARY KEY,
        outbox_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (outbox_id) REFERENCES outbox(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_id ON outbox(id);
    `);

    const columns = this.db.prepare("PRAGMA table_info(outbox)").all() as OutboxColumnInfo[];
    const hasAgentId = columns.some((column) => column.name === "agent_id");
    if (!hasAgentId) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN agent_id TEXT");
    }

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_agent_id_id ON outbox(agent_id, id DESC)");

    const version = Number(this.db.pragma("user_version", { simple: true }));
    if (version < 2) {
      this.db.pragma("user_version = 2");
    }
  }
}
