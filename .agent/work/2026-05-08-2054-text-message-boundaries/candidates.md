# Refactor Candidates: Text And Runtime Message Boundaries

## Scope And Constraints

Target repo: `/Users/georgepickett/openclaw-studio`.

Hard constraints:
- Improve OpenClaw Studio only; do not modify `~/openclaw`.
- Current branch is `main` at `7dee5ec52bdb71ada1696fef4c968ee4e35ddca7`, ahead of `origin/main` by 1.
- The worktree has broad pre-existing edits across runtime/control-plane, routes, UI state, and tests. This cycle should avoid those files unless the selected refactor proves the diff can still be isolated.
- Do not push, deploy, create branches, switch branches, touch secrets, or run destructive cleanup.

## First-Principles Repo Model

OpenClaw Studio is a Next/React frontend plus a server-owned gateway/control-plane layer. The browser talks to Studio routes and SSE; Studio owns the gateway WebSocket and persists runtime projection state. Core flows:

1. Runtime events enter through SSE or history hydration, then move through `runtimeEventBridge`, `gatewayRuntimeEventHandler`, and transcript helpers.
2. Chat and transcript rendering depend on text extraction, metadata parsing, thinking extraction, and tool-call formatting.
3. Runtime/intents routes proxy control-plane reads and mutations through server-side modules.
4. Agent settings and creation flows assemble gateway config and local agent files.
5. Tests are broad but many central files are large, so small boundary improvements should happen where tests can pin behavior tightly.

Light evidence:
- `src/lib/text/message-extract.ts` is 552 lines and test-covered by `tests/unit/messageExtract.test.ts`, `tests/unit/extractThinking.test.ts`, `tests/unit/chatItems.test.ts`, and runtime event tests.
- `src/lib/text/media-markdown.ts` is a small isolated parser with focused tests, but it embeds fence scanning and media-line normalization in one loop.
- `src/features/agents/components/AgentInspectPanels.tsx` is 1475 lines, clean in the worktree, and mixes settings panels, cron controls, and personality parsing UI.
- Runtime/control-plane files have stronger architectural payoff but are already dirty, making isolated commits risky in this cycle.

## Ranked Shortlist

1. Split thinking-tag extraction out of `message-extract.ts`.
2. Consolidate media-line scanning into a small parser inside `media-markdown.ts`.
3. Extract a focused subview from `AgentInspectPanels.tsx`.
4. Minimal surgical change: add missing edge-case tests around message extraction with no production refactor.
5. Do nothing.

## Candidate 1: Split Thinking-Tag Extraction

Refactor class: deepen a module by moving one cohesive internal policy out of a mixed utility file.

Scope: `src/lib/text/message-extract.ts`, new `src/lib/text/thinking-tags.ts`, `tests/unit/extractThinking.test.ts`, `tests/unit/messageExtract.test.ts`.

Problem: `message-extract.ts` owns envelope stripping, assistant prefix stripping, text extraction, thinking extraction, tool markdown, meta markdown, and UI metadata stripping. Thinking-tag parsing has its own tag grammar and streaming behavior but is embedded beside unrelated formatting policy.

Supporting evidence: constants and functions for `THINKING_*` are clustered, exported helpers already form a coherent public surface, and tests already isolate thinking behavior.

Contradictory evidence: moving code can create a shallow module if the new file merely re-exports helpers without hiding policy. The current single file keeps message formatting knowledge in one place.

Falsifier: if callers need to import multiple modules to do normal message extraction, the refactor made the interface worse.

Expected payoff: lower cognitive load in `message-extract.ts` while preserving its public API; thinking grammar becomes easier to change without touching tool/meta formatting.

Blast radius: low if exports remain from `message-extract.ts` and tests stay green.

Reversibility: high.

Cheapest probe: inspect imports and verify only tests import the thinking helpers directly.

## Candidate 2: Consolidate Media-Line Scanning

Refactor class: hide sequencing inside a focused parser loop.

Scope: `src/lib/text/media-markdown.ts`, `tests/unit/mediaMarkdown.test.ts`.

Problem: `rewriteMediaLinesToMarkdown` mixes fence state, two-line `MEDIA:` detection, image-path policy, output rendering, and index mutation in one loop.

Supporting evidence: the file is small and isolated; tests cover direct media lines, next-line paths, and fenced blocks.

Contradictory evidence: the current code is short and readable, so extraction may create more concepts than it removes.

Falsifier: if the helper API is larger than the current loop logic, do nothing.

Expected payoff: modest but very safe; easier to add more media kinds later.

Blast radius: very low.

Reversibility: high.

Cheapest probe: inspect whether expected future media variants exist in routes/tests.

## Candidate 3: Extract Agent Inspect Subview

Refactor class: reduce UI cognitive load by keeping related UI state together.

Scope: `src/features/agents/components/AgentInspectPanels.tsx` plus focused component tests.

Problem: a 1475-line component mixes multiple panels and several workflows, making local reasoning expensive.

Supporting evidence: file size and references to personality parsing, cron controls, and settings are large enough to hide unrelated knowledge together.

Contradictory evidence: extracting UI subviews can become shallow prop plumbing, and the file may intentionally keep panel state local.

Falsifier: if extraction requires passing many props or duplicating state, it is not a complexity win.

Expected payoff: medium.

Blast radius: medium, with visual/regression risk.

Reversibility: medium.

Cheapest probe: inspect component boundaries and prop needs before planning.

## Candidate 4: Minimal Surgical Change

Refactor class: test-only characterization.

Scope: `tests/unit/messageExtract.test.ts` or `tests/unit/extractThinking.test.ts`.

Problem: message parsing is central and subtle; edge cases can be pinned before refactoring.

Supporting evidence: tests already exist and are cheap to extend.

Contradictory evidence: tests alone do not remove complexity.

Falsifier: if current tests already cover the selected behavior, added tests are redundant.

Expected payoff: low to medium.

Blast radius: very low.

Reversibility: high.

Cheapest probe: compare current test coverage with helper branches.

## Candidate 5: Do Nothing

Refactor class: avoid churn.

Scope: no changes.

Problem solved: avoids adding churn on top of a broad dirty worktree.

Supporting evidence: many high-value files are already dirty, and isolated commits matter for this goal.

Contradictory evidence: clean, test-covered text modules offer a low-risk improvement.

Falsifier: if the selected candidate can be isolated and validated, doing nothing is too conservative.

Expected payoff: none.

Blast radius: none.

Reversibility: immediate.

Cheapest probe: inspect candidate 1 imports and tests.

## Provisional Leader

Candidate 1 is the provisional leader because it improves a central clean file with focused tests and a small public-surface-preserving move. Candidate 2 is the safest runner-up but may be too small to justify a full cycle. Candidate 3 may be valuable but has more UI regression risk. Candidate 4 is useful only if production refactoring proves too risky. Candidate 5 remains alive because the dirty worktree is broad.

## Next Step

Run `select-refactor` against this work item. Challenge whether Candidate 1 is a real information-hiding improvement or just file shuffling, and verify the import/test surface before locking the decision.
