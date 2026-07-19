import { runSshJson } from "@/lib/ssh/gateway-host";
import { resolveSafeAgentId } from "@/lib/agents/agentIds";

type GatewayAgentStateMove = { from: string; to: string };

type TrashAgentStateResult = {
  trashDir: string;
  moved: GatewayAgentStateMove[];
};

type RestoreAgentStateResult = {
  restored: GatewayAgentStateMove[];
};

const TRASH_SCRIPT = `
set -euo pipefail

python3 - "$1" <<'PY'
import datetime
import json
import os
import pathlib
import re
import shutil
import sys
import uuid

agent_id = sys.argv[1].strip()
if not agent_id:
  raise SystemExit("agentId is required.")
if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", agent_id):
  raise SystemExit(f"Invalid agentId: {agent_id}")

base = pathlib.Path.home() / ".openclaw"
trash_root = base / "trash" / "studio-delete-agent"
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
trash_dir = trash_root / f"{stamp}-{agent_id}-{uuid.uuid4()}"
(trash_dir / "agents").mkdir(parents=True, exist_ok=True)
(trash_dir / "workspaces").mkdir(parents=True, exist_ok=True)

moves = []

def path_exists(path: pathlib.Path):
  return path.exists() or path.is_symlink()

def rollback_moves():
  errors = []
  for move in reversed(moves):
    src = pathlib.Path(move["from"])
    dest = pathlib.Path(move["to"])
    try:
      if not path_exists(dest):
        continue
      if path_exists(src):
        errors.append(f"Rollback target already exists: {src}")
        continue
      src.parent.mkdir(parents=True, exist_ok=True)
      shutil.move(str(dest), str(src))
    except Exception as exc:
      errors.append(f"Failed to rollback {dest} -> {src}: {exc}")
  return errors

def move_if_exists(src: pathlib.Path, dest: pathlib.Path):
  if not path_exists(src):
    return
  dest.parent.mkdir(parents=True, exist_ok=True)
  shutil.move(str(src), str(dest))
  moves.append({"from": str(src), "to": str(dest)})

try:
  move_if_exists(base / f"workspace-{agent_id}", trash_dir / "workspaces" / f"workspace-{agent_id}")
  move_if_exists(base / "agents" / agent_id, trash_dir / "agents" / agent_id)
except Exception as exc:
  rollback_errors = rollback_moves()
  message = str(exc)
  if rollback_errors:
    message = f"{message} Rollback also failed: {'; '.join(rollback_errors)}"
  raise SystemExit(message)

print(json.dumps({"trashDir": str(trash_dir), "moved": moves}))
PY
`;

const RESTORE_SCRIPT = `
set -euo pipefail

python3 - "$1" "$2" <<'PY'
import json
import os
import pathlib
import re
import shutil
import sys

agent_id = sys.argv[1].strip()
trash_dir_raw = sys.argv[2].strip()

if not agent_id:
  raise SystemExit("agentId is required.")
if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", agent_id):
  raise SystemExit(f"Invalid agentId: {agent_id}")
if not trash_dir_raw:
  raise SystemExit("trashDir is required.")

base = pathlib.Path.home() / ".openclaw"
trash_root = base / "trash" / "studio-delete-agent"
trash_dir = pathlib.Path(trash_dir_raw).expanduser()

try:
  resolved_trash = trash_dir.resolve(strict=True)
except FileNotFoundError:
  raise SystemExit(f"trashDir does not exist: {trash_dir_raw}")

resolved_base = base.resolve(strict=False)
resolved_trash_root = trash_root.resolve(strict=False)
if resolved_trash != resolved_trash_root and resolved_trash_root not in resolved_trash.parents:
  raise SystemExit(f"trashDir is not under {trash_root}: {trash_dir_raw}")

moves = []

def path_exists(path: pathlib.Path):
  return path.exists() or path.is_symlink()

def rollback_moves():
  errors = []
  for move in reversed(moves):
    src = pathlib.Path(move["from"])
    dest = pathlib.Path(move["to"])
    try:
      if not path_exists(dest):
        continue
      if path_exists(src):
        errors.append(f"Rollback target already exists: {src}")
        continue
      src.parent.mkdir(parents=True, exist_ok=True)
      shutil.move(str(dest), str(src))
    except Exception as exc:
      errors.append(f"Failed to rollback {dest} -> {src}: {exc}")
  return errors

def path_under(root: pathlib.Path, candidate: pathlib.Path):
  return candidate == root or root in candidate.parents

def resolve_restored_symlink_target(dest: pathlib.Path, link_target: str):
  target = pathlib.Path(link_target)
  if target.is_absolute():
    return target.resolve(strict=False)
  return (dest.parent / target).resolve(strict=False)

def ensure_source_allowed(src: pathlib.Path, dest: pathlib.Path):
  if src.is_symlink():
    restored_target = resolve_restored_symlink_target(dest, os.readlink(src))
    if not path_under(resolved_base, restored_target):
      raise RuntimeError(f"Refusing to restore symlink outside stateDir: {src}")
    return
  resolved_src = src.resolve(strict=True)
  if not path_under(resolved_trash, resolved_src):
    raise RuntimeError(f"Refusing to restore source outside trashDir: {src}")

def restore_if_exists(src: pathlib.Path, dest: pathlib.Path):
  if not path_exists(src):
    return
  ensure_source_allowed(src, dest)
  if path_exists(dest):
    raise RuntimeError(f"Refusing to restore over existing path: {dest}")
  dest.parent.mkdir(parents=True, exist_ok=True)
  shutil.move(str(src), str(dest))
  moves.append({"from": str(src), "to": str(dest)})

try:
  restore_if_exists(
    resolved_trash / "workspaces" / f"workspace-{agent_id}",
    base / f"workspace-{agent_id}",
  )
  restore_if_exists(
    resolved_trash / "agents" / agent_id,
    base / "agents" / agent_id,
  )
except Exception as exc:
  rollback_errors = rollback_moves()
  message = str(exc)
  if rollback_errors:
    message = f"{message} Rollback also failed: {'; '.join(rollback_errors)}"
  raise SystemExit(message)

print(json.dumps({"restored": moves}))
PY
`;

export const trashAgentStateOverSsh = (params: {
  sshTarget: string;
  agentId: string;
}): TrashAgentStateResult => {
  const agentId = resolveSafeAgentId(params.agentId);
  if (!agentId) {
    throw new Error(`Invalid agentId: ${params.agentId}`);
  }
  const result = runSshJson({
    sshTarget: params.sshTarget,
    argv: ["bash", "-s", "--", agentId],
    input: TRASH_SCRIPT,
    label: `trash agent state (${agentId})`,
  });
  return result as TrashAgentStateResult;
};

export const restoreAgentStateOverSsh = (params: {
  sshTarget: string;
  agentId: string;
  trashDir: string;
}): RestoreAgentStateResult => {
  const agentId = resolveSafeAgentId(params.agentId);
  if (!agentId) {
    throw new Error(`Invalid agentId: ${params.agentId}`);
  }
  const result = runSshJson({
    sshTarget: params.sshTarget,
    argv: ["bash", "-s", "--", agentId, params.trashDir],
    input: RESTORE_SCRIPT,
    label: `restore agent state (${agentId})`,
  });
  return result as RestoreAgentStateResult;
};
