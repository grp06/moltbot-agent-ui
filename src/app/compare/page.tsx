"use client";

import React, { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { AgentAvatar } from "@/features/agents/components/AgentAvatar";
import {
  createAgentFilesState,
  type AgentFileName,
} from "@/lib/agents/agentFiles";
import { parsePersonalityFiles } from "@/lib/agents/personalityBuilder";
import { readDomainAgentFile, writeDomainAgentFile } from "@/lib/controlplane/domain-runtime-client";
import { fetchJson } from "@/lib/http";
import type { GatewayStatus } from "@/lib/gateway/gateway-status";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type AgentSeed = {
  agentId: string;
  name: string;
  sessionKey: string;
  avatarSeed?: string | null;
  avatarUrl?: string | null;
};

type AgentFilesState = ReturnType<typeof createAgentFilesState>;

type AgentCompareEntry = {
  agent: AgentSeed;
  files: AgentFilesState;
  loading: boolean;
  error: string | null;
};

/* The four behavior files we compare */
const COMPARE_FILES: { key: AgentFileName; label: string }[] = [
  { key: "SOUL.md", label: "Persona" },
  { key: "AGENTS.md", label: "Directives" },
  { key: "USER.md", label: "Context" },
  { key: "IDENTITY.md", label: "Identity" },
];

/* ------------------------------------------------------------------ */
/*  Gateway status probe (lightweight)                                */
/* ------------------------------------------------------------------ */

type RuntimeSummaryEnvelope = {
  summary?: {
    status?: unknown;
  } | null;
  error?: unknown;
};

const probeGatewayStatus = async (): Promise<GatewayStatus> => {
  try {
    const envelope = await fetchJson<RuntimeSummaryEnvelope>("/api/runtime/summary", {
      cache: "no-store",
    });
    const raw = envelope?.summary?.status;
    const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (normalized === "connected") return "connected";
    if (normalized === "connecting") return "connecting";
    if (normalized === "reconnecting") return "reconnecting";
    if (normalized === "error") return "error";
    return "disconnected";
  } catch {
    return "disconnected";
  }
};

/* ------------------------------------------------------------------ */
/*  Fleet loading (reuses /api/runtime/fleet)                         */
/* ------------------------------------------------------------------ */

const loadFleetSeeds = async (): Promise<AgentSeed[]> => {
  const response = await fetchJson<{
    result?: {
      seeds?: AgentSeed[];
    };
    error?: string;
  }>("/api/runtime/fleet", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  /* The fleet API can return usable result.seeds together with an error
     in degraded mode (see buildDegradedFleetResponse in route.ts).
     Only throw when seeds are truly missing. */
  const seeds = response.result?.seeds;
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new Error(response.error ?? "No agents returned from fleet.");
  }

  return seeds;
};

/* ------------------------------------------------------------------ */
/*  Load behavior files for one agent                                 */
/* ------------------------------------------------------------------ */

const loadAgentBehaviorFiles = async (
  agentId: string
): Promise<AgentFilesState> => {
  const state = createAgentFilesState();
  const results = await Promise.all(
    COMPARE_FILES.map(async ({ key }) => {
      const file = await readDomainAgentFile({ agentId, name: key });
      return { name: key, content: file.content, exists: file.exists };
    })
  );
  for (const file of results) {
    state[file.name] = { content: file.content ?? "", exists: Boolean(file.exists) };
  }
  return state;
};

/* ------------------------------------------------------------------ */
/*  Compare Page                                                      */
/* ------------------------------------------------------------------ */

export default function ComparePage() {
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>("connecting");
  const [entries, setEntries] = useState<AgentCompareEntry[]>([]);
  const [globalLoading, setGlobalLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const loadInflightRef = useRef(false);

  /* ---- agent filter ---- */
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  /* ---- collapsible rows ---- */
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(new Set());
  /* ---- per-row height (px) ---- */
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({});

  /* ---- load everything ---- */
  const loadAll = useCallback(async () => {
    if (loadInflightRef.current) return;
    loadInflightRef.current = true;
    setGlobalLoading(true);
    setGlobalError(null);

    try {
      /* 1. Check gateway */
      const status = await probeGatewayStatus();
      setGatewayStatus(status);

      if (status !== "connected") {
        setGlobalError(
          status === "connecting" || status === "reconnecting"
            ? "Gateway is connecting… please wait."
            : "Gateway is not connected. Return to the main page to configure your connection."
        );
        setGlobalLoading(false);
        loadInflightRef.current = false;
        return;
      }

      /* 2. Load fleet */
      const seeds = await loadFleetSeeds();
      if (seeds.length === 0) {
        setGlobalError("No agents found in fleet.");
        setGlobalLoading(false);
        loadInflightRef.current = false;
        return;
      }

      /* 3. Scaffold entries with loading state */
      const scaffold: AgentCompareEntry[] = seeds.map((agent) => ({
        agent,
        files: createAgentFilesState(),
        loading: true,
        error: null,
      }));
      setEntries(scaffold);

      /* 4. Load files for each agent in parallel */
      const settled = await Promise.allSettled(
        seeds.map((agent) => loadAgentBehaviorFiles(agent.agentId))
      );

      const final: AgentCompareEntry[] = seeds.map((agent, idx) => {
        const result = settled[idx];
        if (result.status === "fulfilled") {
          return { agent, files: result.value, loading: false, error: null };
        }
        return {
          agent,
          files: createAgentFilesState(),
          loading: false,
          error: result.reason instanceof Error ? result.reason.message : "Failed to load files.",
        };
      });
      setEntries(final);
      setSelectedAgents((prev) => {
        if (prev.size === 0) return new Set(seeds.map((s) => s.agentId));
        return prev;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load agents.";
      setGlobalError(message);
    } finally {
      setGlobalLoading(false);
      loadInflightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  /* ---- derive emoji from IDENTITY.md for display ---- */
  const resolveEmoji = (entry: AgentCompareEntry): string => {
    try {
      const draft = parsePersonalityFiles(entry.files);
      return draft.identity.emoji.trim() || "";
    } catch {
      return "";
    }
  };

  /* ---- resolve display name ---- */
  const resolveDisplayName = (entry: AgentCompareEntry): string => {
    try {
      const draft = parsePersonalityFiles(entry.files);
      const parsed = draft.identity.name.trim();
      if (parsed) return parsed;
    } catch {
      /* fall through */
    }
    return entry.agent.name || entry.agent.agentId;
  };

  /* ---- toggle agent selection ---- */
  const toggleAgent = (agentId: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  /* ---- toggle collapsed row ---- */
  const toggleRow = (key: string) => {
    setCollapsedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /* ---- row height helpers ---- */
  const DEFAULT_HEIGHTS: Record<string, number> = { "SOUL.md": 400, "AGENTS.md": 500 };
  const getDefaultHeight = (key: string) => DEFAULT_HEIGHTS[key] ?? 208;
  const getRowHeight = (key: string) => rowHeights[key] ?? getDefaultHeight(key);
  const adjustRowHeight = (key: string, delta: number) => {
    setRowHeights((prev) => {
      const cur = prev[key] ?? getDefaultHeight(key);
      const next = Math.min(1200, Math.max(100, cur + delta));
      return { ...prev, [key]: next };
    });
  };

  /* ---- dirty tracking ---- */
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());

  const updateFileContent = useCallback((agentId: string, fileName: AgentFileName, content: string) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.agent.agentId === agentId
          ? { ...e, files: { ...e.files, [fileName]: { ...e.files[fileName], content } } }
          : e
      )
    );
    setDirtyKeys((prev) => new Set(prev).add(`${agentId}:${fileName}`));
  }, []);

  const saveFile = useCallback(async (agentId: string, fileName: AgentFileName, content: string) => {
    const k = `${agentId}:${fileName}`;
    /* Snapshot the content we are about to persist so we can detect
       whether the user made additional edits while the request was
       in-flight. Only clear the dirty flag when the current content
       still matches the saved snapshot. */
    const savedContent = content;
    setSavingKeys((prev) => new Set(prev).add(k));
    try {
      await writeDomainAgentFile({ agentId, name: fileName, content: savedContent });
      setDirtyKeys((prev) => {
        /* Re-read current content from entries state to check for edits during save */
        const next = new Set(prev);
        /* We rely on the caller passing the content at save-time.
           If the textarea content has changed since then, updateFileContent
           will have re-added the dirty key, so we only clear if still present
           AND the current entries content matches what we saved. */
        next.delete(k);
        return next;
      });
      /* Re-check: if the content was modified during save, mark dirty again */
      setEntries((prev) => {
        const entry = prev.find((e) => e.agent.agentId === agentId);
        if (entry && entry.files[fileName].content !== savedContent) {
          setDirtyKeys((dk) => new Set(dk).add(k));
        }
        return prev;
      });
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSavingKeys((prev) => { const next = new Set(prev); next.delete(k); return next; });
    }
  }, []);

  /* ---- synchronized textarea scrolling ---- */
  const scrollSyncGroupRef = useRef<Map<string, HTMLTextAreaElement[]>>(new Map());
  const isScrollSyncing = useRef(false);

  const registerTextarea = useCallback((groupKey: string, el: HTMLTextAreaElement | null, idx: number) => {
    const group = scrollSyncGroupRef.current.get(groupKey) ?? [];
    if (el) {
      group[idx] = el;
    }
    scrollSyncGroupRef.current.set(groupKey, group);
  }, []);

  const handleSyncScroll = useCallback((groupKey: string, sourceIdx: number) => {
    if (isScrollSyncing.current) return;
    isScrollSyncing.current = true;
    const group = scrollSyncGroupRef.current.get(groupKey) ?? [];
    const source = group[sourceIdx];
    if (source) {
      for (let i = 0; i < group.length; i++) {
        if (i !== sourceIdx && group[i]) {
          group[i].scrollTop = source.scrollTop;
        }
      }
    }
    isScrollSyncing.current = false;
  }, []);

  /* ---- filtered entries ---- */
  const filteredEntries = entries.filter((e) => selectedAgents.has(e.agent.agentId));

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  const isConnected = gatewayStatus === "connected";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {/* ---- Header ---- */}
      <div className="ui-topbar relative z-[180]">
        <div className="grid h-10 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-3 sm:px-4 md:px-5">
          <div className="flex items-center">
            <Link
              href="/"
              className="ui-btn-icon ui-btn-icon-xs"
              aria-label="Back to main page"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Link>
          </div>
          <p className="truncate text-sm font-semibold tracking-[0.01em] text-foreground">
            Agents Behavior Comparison
          </p>
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              className="ui-btn-icon ui-btn-icon-xs"
              aria-label="Refresh"
              disabled={globalLoading}
              onClick={() => void loadAll()}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${globalLoading ? "animate-spin" : ""}`} />
            </button>
            <ThemeToggle />
          </div>
        </div>
      </div>

      {/* ---- Agent filter chips ---- */}
      {entries.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-1.5 border-b border-border bg-sidebar/50 px-3 py-1.5 sm:px-4 md:px-5">
          {entries.map((entry) => {
            const emoji = resolveEmoji(entry);
            const displayName = resolveDisplayName(entry);
            const isActive = selectedAgents.has(entry.agent.agentId);
            return (
              <button
                key={entry.agent.agentId}
                type="button"
                onClick={() => toggleAgent(entry.agent.agentId)}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-foreground/20 bg-foreground/10 text-foreground ring-1 ring-foreground/20"
                    : "border-border bg-sidebar text-muted-foreground opacity-50"
                }`}
              >
                {emoji ? <span>{emoji}</span> : null}
                <span className="max-w-[120px] truncate">{displayName}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ---- Body ---- */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Global loading / error states */}
        {globalLoading && entries.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="glass-panel flex flex-col items-center gap-4 px-10 py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="console-title text-lg text-muted-foreground">Loading agents…</p>
            </div>
          </div>
        ) : globalError && entries.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="glass-panel flex flex-col items-center gap-4 px-10 py-12">
              <p className="console-title text-lg text-destructive">{globalError}</p>
              {!isConnected ? (
                <Link
                  href="/"
                  className="ui-btn-secondary px-4 py-1.5 font-mono text-[10px] font-semibold tracking-[0.06em]"
                >
                  Go to main page
                </Link>
              ) : (
                <button
                  type="button"
                  className="ui-btn-secondary px-4 py-1.5 font-mono text-[10px] font-semibold tracking-[0.06em]"
                  onClick={() => void loadAll()}
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        ) : (
          /* ---- Comparison layout (flex rows) ---- */
          <div className="flex min-h-0 flex-1 overflow-auto">
            <div className="w-full min-w-fit">
              {/* Header row */}
              <div className="sticky top-0 z-20 flex">
                <div className="w-[120px] min-w-[120px] border-b border-r border-border bg-sidebar px-4 py-3" />
                {filteredEntries.map((entry) => {
                  const emoji = resolveEmoji(entry);
                  const displayName = resolveDisplayName(entry);
                  return (
                    <div
                      key={entry.agent.agentId}
                      className="min-w-[320px] flex-1 border-b border-r border-border bg-sidebar px-4 py-3 last:border-r-0"
                    >
                      <div className="flex items-center gap-3">
                        <AgentAvatar
                          seed={entry.agent.avatarSeed ?? entry.agent.agentId}
                          name={displayName}
                          avatarUrl={entry.agent.avatarUrl}
                          size={32}
                        />
                        <div className="flex flex-col items-start gap-0.5">
                          <span className="font-sans text-sm font-semibold text-foreground">
                            {emoji ? `${emoji} ` : ""}
                            {displayName}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {entry.agent.agentId}
                          </span>
                        </div>
                        {entry.loading ? (
                          <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Data rows — each row is an independent flex container */}
              {COMPARE_FILES.map(({ key, label }, rowIdx) => {
                const isCollapsed = collapsedRows.has(key);
                const height = getRowHeight(key);
                return (
                  <div key={key} className={`flex ${rowIdx % 2 === 1 ? "bg-muted/30" : ""}`}>
                    {/* Row label */}
                    <div className={`w-[120px] min-w-[120px] border-b border-r border-border px-4 ${isCollapsed ? "py-1" : "py-3"} ${rowIdx % 2 === 1 ? "bg-sidebar/80" : "bg-sidebar"}`}>
                      <button
                        type="button"
                        className="flex items-center gap-1 text-left"
                        onClick={() => toggleRow(key)}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span className="console-title whitespace-nowrap text-xs text-muted-foreground">
                          {label}
                        </span>
                      </button>
                      <span className="mt-0.5 block pl-[18px] font-mono text-[9px] text-muted-foreground/60">
                        {key}
                      </span>
                      {!isCollapsed && (
                        <div className="mt-2 flex items-center gap-1 pl-[18px]">
                          <button
                            type="button"
                            className="flex h-6 w-6 items-center justify-center rounded border border-border bg-background text-sm font-bold text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                            onClick={() => adjustRowHeight(key, -50)}
                            aria-label="Decrease row height"
                          >
                            −
                          </button>
                          <button
                            type="button"
                            className="flex h-6 w-6 items-center justify-center rounded border border-border bg-background text-sm font-bold text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                            onClick={() => adjustRowHeight(key, 50)}
                            aria-label="Increase row height"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Data cells */}
                    {filteredEntries.map((entry, colIdx) => {
                      const dk = `${entry.agent.agentId}:${key}`;
                      const isDirty = dirtyKeys.has(dk);
                      const isSaving = savingKeys.has(dk);
                      return (
                        <div
                          key={entry.agent.agentId}
                          className={`min-w-[320px] flex-1 border-b border-r border-border last:border-r-0 ${isDirty ? "bg-yellow-500/10" : ""}`}
                          style={isCollapsed ? {} : { height: `${height}px` }}
                        >
                          {isCollapsed ? (
                            <div className="truncate px-3 py-1 font-mono text-[10px] text-muted-foreground/40 italic">
                              collapsed
                            </div>
                          ) : entry.error ? (
                            <div className="rounded-md bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
                              {entry.error}
                            </div>
                          ) : entry.loading ? (
                            <div className="flex items-center justify-center" style={{ height: `${height}px` }}>
                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            </div>
                          ) : (
                            <div className="relative h-full w-full">
                              <textarea
                                ref={(el) => registerTextarea(key, el, colIdx)}
                                className="h-full w-full resize-none border-0 bg-transparent px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none"
                                value={entry.files[key].content}
                                onChange={(e) => updateFileContent(entry.agent.agentId, key, e.target.value)}
                                onScroll={() => handleSyncScroll(key, colIdx)}
                              />
                              <div className="absolute right-1 top-1 flex items-center gap-1">
                                {isSaving && (
                                  <span className="font-mono text-[9px] text-muted-foreground">saving…</span>
                                )}
                                {isDirty && !isSaving && (
                                  <>
                                    <span className="font-mono text-[9px] text-yellow-500">unsaved</span>
                                    <button
                                      type="button"
                                      className="rounded border border-yellow-500/40 bg-yellow-500/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-yellow-500 hover:bg-yellow-500/30"
                                      onClick={() => void saveFile(entry.agent.agentId, key, entry.files[key].content)}
                                    >
                                      Save
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
