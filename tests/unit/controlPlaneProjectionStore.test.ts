// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { SQLiteControlPlaneProjectionStore } from "@/lib/controlplane/projection-store";

describe("SQLiteControlPlaneProjectionStore", () => {
  let tempDir: string | null = null;

  const makeDbPath = () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "controlplane-store-"));
    return path.join(tempDir, "runtime.db");
  };

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("reuses same schema across restarts and preserves snapshot", () => {
    const dbPath = makeDbPath();
    const first = new SQLiteControlPlaneProjectionStore(dbPath);
    first.applyDomainEvent({
      type: "runtime.status",
      status: "connected",
      reason: null,
      asOf: "2026-02-28T02:00:00.000Z",
    });
    first.close();

    const second = new SQLiteControlPlaneProjectionStore(dbPath);
    const snapshot = second.snapshot();
    expect(snapshot.status).toBe("connected");
    expect(snapshot.asOf).toBe("2026-02-28T02:00:00.000Z");
    expect(snapshot.outboxHead).toBe(1);
    second.close();
  });

  it("deduplicates reapplied events and keeps outbox ordering", () => {
    const store = new SQLiteControlPlaneProjectionStore(makeDbPath());
    const firstEvent = {
      type: "gateway.event" as const,
      event: "runtime.delta",
      seq: 42,
      connectionEpoch: "conn-1",
      payload: { content: "a" },
      asOf: "2026-02-28T02:01:00.000Z",
    };
    const secondEvent = {
      type: "gateway.event" as const,
      event: "runtime.final",
      seq: 43,
      connectionEpoch: "conn-1",
      payload: { content: "b" },
      asOf: "2026-02-28T02:01:02.000Z",
    };

    const first = store.applyDomainEvent(firstEvent);
    const duplicate = store.applyDomainEvent(firstEvent);
    const replayedWithNewTimestamp = store.applyDomainEvent({
      ...firstEvent,
      asOf: "2026-02-28T02:01:05.000Z",
    });
    const second = store.applyDomainEvent(secondEvent);

    expect(first.id).toBe(1);
    expect(duplicate.id).toBe(1);
    expect(replayedWithNewTimestamp.id).toBe(1);
    expect(second.id).toBe(2);

    const replay = store.readOutboxAfter(0, 10);
    expect(replay.map((entry) => entry.id)).toEqual([1, 2]);
    expect(replay[0]?.event).toEqual(firstEvent);
    expect(replay[1]?.event).toEqual(secondEvent);

    store.close();
  });

  it("stores same event+seq as distinct rows when connection epoch changes", () => {
    const store = new SQLiteControlPlaneProjectionStore(makeDbPath());
    const first = store.applyDomainEvent({
      type: "gateway.event",
      event: "agent",
      seq: 1,
      connectionEpoch: "conn-1",
      payload: { state: "running" },
      asOf: "2026-02-28T02:01:00.000Z",
    });
    const second = store.applyDomainEvent({
      type: "gateway.event",
      event: "agent",
      seq: 1,
      connectionEpoch: "conn-2",
      payload: { state: "idle" },
      asOf: "2026-02-28T02:01:10.000Z",
    });

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);

    const replay = store.readOutboxAfter(0, 10);
    expect(replay.map((entry) => entry.id)).toEqual([1, 2]);

    store.close();
  });

  it("reads outbox pages before a cursor in ascending order", () => {
    const store = new SQLiteControlPlaneProjectionStore(makeDbPath());
    for (let index = 1; index <= 5; index += 1) {
      store.applyDomainEvent({
        type: "gateway.event",
        event: "runtime.delta",
        seq: index,
        payload: { index },
        asOf: `2026-02-28T02:01:0${index}.000Z`,
      });
    }

    const newestTwo = store.readOutboxBefore(6, 2);
    expect(newestTwo.map((entry) => entry.id)).toEqual([4, 5]);

    const olderTwo = store.readOutboxBefore(4, 2);
    expect(olderTwo.map((entry) => entry.id)).toEqual([2, 3]);

    store.close();
  });

  it("reads agent outbox pages before a cursor in ascending order and normalizes casing", () => {
    const store = new SQLiteControlPlaneProjectionStore(makeDbPath());
    store.applyDomainEvent({
      type: "gateway.event",
      event: "runtime.delta",
      seq: 1,
      payload: { sessionKey: "Agent:Alpha:Main", text: "a" },
      asOf: "2026-02-28T02:01:01.000Z",
    });
    store.applyDomainEvent({
      type: "gateway.event",
      event: "runtime.delta",
      seq: 2,
      payload: { sessionKey: "agent:beta:main", text: "b" },
      asOf: "2026-02-28T02:01:02.000Z",
    });
    store.applyDomainEvent({
      type: "gateway.event",
      event: "runtime.delta",
      seq: 3,
      payload: { agentId: "ALPHA", text: "c" },
      asOf: "2026-02-28T02:01:03.000Z",
    });
    store.applyDomainEvent({
      type: "gateway.event",
      event: "runtime.delta",
      seq: 4,
      payload: { sessionKey: "agent:alpha:main", text: "d" },
      asOf: "2026-02-28T02:01:04.000Z",
    });

    const newestTwo = store.readAgentOutboxBefore("ALPHA", 5, 2);
    expect(newestTwo.map((entry) => entry.id)).toEqual([3, 4]);

    const olderOne = store.readAgentOutboxBefore("alpha", 3, 10);
    expect(olderOne.map((entry) => entry.id)).toEqual([1]);

    store.close();
  });

  it("does not index malformed agent ids from gateway event payloads", () => {
    const store = new SQLiteControlPlaneProjectionStore(makeDbPath());
    store.applyDomainEvent({
      type: "gateway.event",
      event: "runtime.delta",
      seq: 1,
      payload: { sessionKey: "agent:../alpha:main", text: "bad session" },
      asOf: "2026-02-28T02:01:01.000Z",
    });
    store.applyDomainEvent({
      type: "gateway.event",
      event: "runtime.delta",
      seq: 2,
      payload: { agentId: "../alpha", text: "bad direct" },
      asOf: "2026-02-28T02:01:02.000Z",
    });
    store.applyDomainEvent({
      type: "gateway.event",
      event: "runtime.delta",
      seq: 3,
      payload: { sessionKey: "agent:alpha:main", text: "good" },
      asOf: "2026-02-28T02:01:03.000Z",
    });

    expect(store.readAgentOutboxBefore("alpha", 4, 10).map((entry) => entry.id)).toEqual([3]);

    store.close();
  });

  it("backfills legacy outbox rows into agent index and marks non-agent rows", () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE runtime_projection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL,
        reason TEXT,
        as_of TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE processed_events (
        event_key TEXT PRIMARY KEY,
        outbox_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (outbox_id) REFERENCES outbox(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_outbox_id ON outbox(id);
    `);
    db.prepare("INSERT INTO outbox (event_type, event_json, created_at) VALUES (?, ?, ?)").run(
      "gateway.event",
      JSON.stringify({
        type: "gateway.event",
        event: "runtime.delta",
        seq: 10,
        payload: { sessionKey: "Agent:Alpha:Main" },
        asOf: "2026-02-28T02:01:01.000Z",
      }),
      "2026-02-28T02:01:01.000Z"
    );
    db.prepare("INSERT INTO outbox (event_type, event_json, created_at) VALUES (?, ?, ?)").run(
      "runtime.status",
      JSON.stringify({
        type: "runtime.status",
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:01:02.000Z",
      }),
      "2026-02-28T02:01:02.000Z"
    );
    db.prepare("INSERT INTO outbox (event_type, event_json, created_at) VALUES (?, ?, ?)").run(
      "gateway.event",
      JSON.stringify({
        type: "gateway.event",
        event: "runtime.delta",
        seq: 11,
        payload: { sessionKey: "agent:beta:main" },
        asOf: "2026-02-28T02:01:03.000Z",
      }),
      "2026-02-28T02:01:03.000Z"
    );
    db.pragma("user_version = 1");
    db.close();

    const store = new SQLiteControlPlaneProjectionStore(dbPath);
    const firstBackfill = store.backfillAgentOutboxBefore(4, 10);
    expect(firstBackfill.scannedRows).toBe(3);
    expect(firstBackfill.updatedRows).toBe(3);

    const alphaRows = store.readAgentOutboxBefore("alpha", 4, 10);
    expect(alphaRows.map((entry) => entry.id)).toEqual([1]);

    const betaRows = store.readAgentOutboxBefore("beta", 4, 10);
    expect(betaRows.map((entry) => entry.id)).toEqual([3]);

    const secondBackfill = store.backfillAgentOutboxBefore(4, 10);
    expect(secondBackfill.scannedRows).toBe(0);
    expect(secondBackfill.exhausted).toBe(true);

    store.close();

    const verifyDb = new Database(dbPath, { readonly: true });
    const runtimeStatusRow = verifyDb
      .prepare("SELECT agent_id FROM outbox WHERE id = 2")
      .get() as { agent_id: string | null };
    expect(runtimeStatusRow.agent_id).toBe("");
    verifyDb.close();
  });

  it("repairs missing agent index on dedupe replay", () => {
    const dbPath = makeDbPath();
    const event = {
      type: "gateway.event" as const,
      event: "runtime.delta",
      seq: 99,
      payload: { sessionKey: "agent:alpha:main", text: "dedupe" },
      asOf: "2026-02-28T02:01:00.000Z",
    };

    const firstStore = new SQLiteControlPlaneProjectionStore(dbPath);
    firstStore.applyDomainEvent(event);
    firstStore.close();

    const mutateDb = new Database(dbPath);
    mutateDb.prepare("UPDATE outbox SET agent_id = NULL WHERE id = 1").run();
    mutateDb.close();

    const secondStore = new SQLiteControlPlaneProjectionStore(dbPath);
    const deduped = secondStore.applyDomainEvent(event);
    expect(deduped.id).toBe(1);
    secondStore.close();

    const verifyDb = new Database(dbPath, { readonly: true });
    const repaired = verifyDb.prepare("SELECT agent_id FROM outbox WHERE id = 1").get() as {
      agent_id: string | null;
    };
    expect(repaired.agent_id).toBe("alpha");
    verifyDb.close();
  });
});
