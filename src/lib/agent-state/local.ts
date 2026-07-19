import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { isSafeAgentId } from "@/lib/agents/agentIds";
import { resolveStateDir } from "@/lib/clawdbot/paths";

type GatewayAgentStateMove = { from: string; to: string };

type TrashAgentStateResult = {
  trashDir: string;
  moved: GatewayAgentStateMove[];
};

type RestoreAgentStateResult = {
  restored: GatewayAgentStateMove[];
};

const utcStamp = (now: Date = new Date()) => {
  const iso = now.toISOString(); // 2026-02-11T00:24:00.123Z
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); // 20260211T002400Z
};

const pathExists = (target: string): boolean => {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const moveIfExists = (src: string, dest: string, moves: GatewayAgentStateMove[]) => {
  if (!pathExists(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  moves.push({ from: src, to: dest });
};

const rollbackMoves = (moves: GatewayAgentStateMove[]): Error[] => {
  const errors: Error[] = [];
  for (const move of [...moves].reverse()) {
    try {
      if (!pathExists(move.to)) continue;
      if (pathExists(move.from)) {
        errors.push(new Error(`Rollback target already exists: ${move.from}`));
        continue;
      }
      fs.mkdirSync(path.dirname(move.from), { recursive: true });
      fs.renameSync(move.to, move.from);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(new Error(`Failed to rollback ${move.to} -> ${move.from}: ${message}`));
    }
  }
  return errors;
};

const throwWithRollbackContext = (error: unknown, rollbackErrors: Error[]): never => {
  if (rollbackErrors.length === 0) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    `${message} Rollback also failed: ${rollbackErrors.map((entry) => entry.message).join("; ")}`
  );
};

export const trashAgentStateLocally = (params: { agentId: string }): TrashAgentStateResult => {
  const agentId = params.agentId.trim();
  if (!agentId) {
    throw new Error("agentId is required.");
  }
  if (!isSafeAgentId(agentId)) {
    throw new Error(`Invalid agentId: ${agentId}`);
  }

  const base = resolveStateDir();
  const trashRoot = path.join(base, "trash", "studio-delete-agent");
  const stamp = utcStamp();
  const trashDir = path.join(trashRoot, `${stamp}-${agentId}-${randomUUID()}`);
  fs.mkdirSync(path.join(trashDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(trashDir, "workspaces"), { recursive: true });

  const moves: GatewayAgentStateMove[] = [];
  try {
    moveIfExists(
      path.join(base, `workspace-${agentId}`),
      path.join(trashDir, "workspaces", `workspace-${agentId}`),
      moves
    );
    moveIfExists(path.join(base, "agents", agentId), path.join(trashDir, "agents", agentId), moves);
  } catch (error) {
    throwWithRollbackContext(error, rollbackMoves(moves));
  }

  return { trashDir, moved: moves };
};

const ensureUnderRoot = (root: string, candidate: string, label: string) => {
  const resolvedBase = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const resolvedCandidate = fs.realpathSync(candidate);
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : `${resolvedBase}${path.sep}`;
  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(prefix)) {
    throw new Error(`${label} is not under ${root}: ${candidate}`);
  }
  return { resolvedBase, resolvedCandidate };
};

const resolveSymlinkTarget = (linkPath: string, linkTarget: string): string => {
  if (path.isAbsolute(linkTarget)) return path.resolve(linkTarget);
  return path.resolve(path.dirname(linkPath), linkTarget);
};

const resolvePathForBoundaryCheck = (candidate: string, symlinkDepth = 0): string => {
  if (symlinkDepth > 32) {
    throw new Error(`Too many symlinks while resolving path: ${candidate}`);
  }

  let current = path.resolve(candidate);
  const missingParts: string[] = [];
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(current);
        const resolvedTarget = resolveSymlinkTarget(current, linkTarget);
        const resolvedCandidate = path.join(resolvedTarget, ...missingParts.reverse());
        return resolvePathForBoundaryCheck(resolvedCandidate, symlinkDepth + 1);
      }
      return path.join(fs.realpathSync(current), ...missingParts.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(candidate);
      }
      missingParts.push(path.basename(current));
      current = parent;
    }
  }
};

const pathResolvesUnderRoot = (root: string, candidate: string): boolean => {
  const resolvedRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const resolvedCandidate = resolvePathForBoundaryCheck(candidate);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(prefix);
};

const ensureRestoreSourceUnderTrash = (params: {
  trashDir: string;
  candidate: string;
  dest: string;
  stateRoot: string;
}) => {
  const stat = fs.lstatSync(params.candidate);
  if (stat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(params.candidate);
    const restoredTarget = resolveSymlinkTarget(params.dest, linkTarget);
    if (!pathResolvesUnderRoot(params.stateRoot, restoredTarget)) {
      throw new Error(
        `Refusing to restore symlink outside stateDir: ${params.candidate}`
      );
    }
    return;
  }

  const resolvedCandidate = fs.realpathSync(params.candidate);
  const prefix = params.trashDir.endsWith(path.sep)
    ? params.trashDir
    : `${params.trashDir}${path.sep}`;
  if (resolvedCandidate !== params.trashDir && !resolvedCandidate.startsWith(prefix)) {
    throw new Error(`Refusing to restore source outside trashDir: ${params.candidate}`);
  }
};

export const restoreAgentStateLocally = (params: {
  agentId: string;
  trashDir: string;
}): RestoreAgentStateResult => {
  const agentId = params.agentId.trim();
  const trashDirRaw = params.trashDir.trim();
  if (!agentId) {
    throw new Error("agentId is required.");
  }
  if (!isSafeAgentId(agentId)) {
    throw new Error(`Invalid agentId: ${agentId}`);
  }
  if (!trashDirRaw) {
    throw new Error("trashDir is required.");
  }

  const base = resolveStateDir();
  const trashRoot = path.join(base, "trash", "studio-delete-agent");
  if (!fs.existsSync(trashDirRaw)) {
    throw new Error(`trashDir does not exist: ${trashDirRaw}`);
  }
  const { resolvedCandidate: resolvedTrashDir } = ensureUnderRoot(
    trashRoot,
    trashDirRaw,
    "trashDir"
  );

  const moves: GatewayAgentStateMove[] = [];
  const restoreIfExists = (src: string, dest: string) => {
    if (!pathExists(src)) return;
    ensureRestoreSourceUnderTrash({
      trashDir: resolvedTrashDir,
      candidate: src,
      dest,
      stateRoot: base,
    });
    if (pathExists(dest)) {
      throw new Error(`Refusing to restore over existing path: ${dest}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    moves.push({ from: src, to: dest });
  };

  try {
    restoreIfExists(
      path.join(resolvedTrashDir, "workspaces", `workspace-${agentId}`),
      path.join(base, `workspace-${agentId}`)
    );
    restoreIfExists(
      path.join(resolvedTrashDir, "agents", agentId),
      path.join(base, "agents", agentId)
    );
  } catch (error) {
    throwWithRollbackContext(error, rollbackMoves(moves));
  }

  return { restored: moves };
};
