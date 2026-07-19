# Centralize Thinking Tag Parsing

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan follows `.agent/PLANS.md` in this repository.

## Purpose / Big Picture

OpenClaw Studio receives assistant messages from several runtime paths. Some messages include hidden thinking or analysis text wrapped in tags such as `<thinking>...</thinking>` or streaming chunks such as `<think>partial`. Today that tag grammar is split across `src/lib/text/message-extract.ts` and `src/features/agents/state/runtimeAgentEventWorkflow.ts`. After this refactor, the grammar for recognizing thinking tags will live in one helper module, while existing callers can keep importing from `message-extract.ts`. The observable behavior should not change: the same tests for thinking extraction, assistant stream handling, and message display should still pass.

## Progress

- [x] (2026-05-09 04:00Z) Created candidate shortlist and locked the decision to centralize thinking-tag parsing.
- [x] (2026-05-09 04:08Z) Improved plan pass 1/3 for factual accuracy: verified target paths, test files, existing helper references, and Vitest filter syntax.
- [x] (2026-05-09 04:11Z) Improved plan pass 2/3 for completeness and sequencing: made the move order explicit and added fallback validation/recovery notes.
- [x] (2026-05-09 04:13Z) Improved plan pass 3/3 for design quality: constrained the helper to hide tag grammar without exporting regexes or adding configuration.
- [x] (2026-05-09 04:17Z) Added `src/lib/text/thinking-tags.ts` with private tag regexes and public extraction/unclosed-tag helpers.
- [x] (2026-05-09 04:17Z) Kept compatibility exports from `message-extract.ts` and removed duplicated local regex logic from `runtimeAgentEventWorkflow.ts`.
- [x] (2026-05-09 04:17Z) Added tests for the shared unclosed-tag helper.
- [x] (2026-05-09 04:58Z) Ran targeted validation: 3 test files passed, 41 tests passed.
- [x] (2026-05-09 04:58Z) Ran `npm run typecheck`; it passed.
- [x] (2026-05-09 04:58Z) Recorded outcomes and final validation.
- [x] (2026-05-09 05:01Z) Review pass 1/4 checked correctness and behavioral regressions; no code issue found.
- [x] (2026-05-09 05:03Z) Review pass 2/4 checked edge cases and added alias coverage for `hasUnclosedThinkingTag`.
- [x] (2026-05-09 05:05Z) Review pass 3/4 checked the simplicity boundary; no extra knobs, exported regexes, or broad import churn were introduced.
- [x] (2026-05-09 05:07Z) Review pass 4/4 checked validation and regression surface; adjacent runtime event tests and typecheck passed.

## Surprises & Discoveries

- Observation: `runtimeAgentEventWorkflow.ts` duplicates the same open/close thinking tag regex policy that `message-extract.ts` already uses for stream extraction.
  Evidence: the local `hasUnclosedThinkingTag` helper scans `<think>`, `<thinking>`, `<analysis>`, `<thought>`, and `<antthinking>` tags independently.

- Observation: The targeted Vitest command can accept file filters after `npm run test --`.
  Evidence: `npm run test -- --help` reports Vitest's positional `...filters` usage.

## Decision Log

- Decision: Preserve `message-extract.ts` as the public import boundary for existing callers.
  Rationale: Many UI and runtime files already import text, thinking, meta, and tool helpers from that module. Moving public imports broadly would increase churn without improving the interface.
  Date/Author: 2026-05-09 / Codex

- Decision: Create a focused `src/lib/text/thinking-tags.ts` helper for the tag grammar.
  Rationale: The tag names and last-open/last-close sequencing are one hidden policy. Putting them in one helper removes duplicate regex knowledge while keeping the implementation small.
  Date/Author: 2026-05-09 / Codex

- Decision: Do not make the tag set configurable in this refactor.
  Rationale: A knob would push policy back onto callers and make the interface easier to misuse. The known tag set is an internal Studio parsing policy and should stay inside the helper.
  Date/Author: 2026-05-09 / Codex

## Outcomes & Retrospective

Implemented. The thinking tag grammar and stream-open detection now live in `src/lib/text/thinking-tags.ts`, with private regex policy and a small public helper surface. `src/lib/text/message-extract.ts` remains the compatibility boundary for existing text helper imports. `src/features/agents/state/runtimeAgentEventWorkflow.ts` no longer carries a duplicated local `hasUnclosedThinkingTag` regex implementation. Targeted unit tests and typecheck passed.

The complexity dividend is small but real: the tag names and last-open/last-close sequencing now have one owner, so future changes to supported hidden-thinking tags do not require coordinating separate regex copies across text extraction and runtime stream planning.

## Context and Orientation

The relevant files are all inside OpenClaw Studio; do not modify `~/openclaw`.

`src/lib/text/message-extract.ts` is a mixed text utility module. It extracts visible text from runtime message objects, strips hidden thinking blocks from assistant-visible text, extracts thinking traces, formats thinking traces for transcript output, formats tool call/result markdown, parses metadata markdown, and strips UI-only metadata from user prompts. The phrase "thinking tag grammar" in this plan means the exact tag names and matching rules used to decide which text is hidden reasoning: `think`, `thinking`, `analysis`, `thought`, and `antthinking`, with optional closing tags.

`src/features/agents/state/runtimeAgentEventWorkflow.ts` plans how runtime agent stream events update local agent state. It currently has a local `hasUnclosedThinkingTag` function so that a streaming assistant chunk like `<thinking>planning` is treated as hidden reasoning rather than visible answer text.

`tests/unit/extractThinking.test.ts` covers thinking extraction and formatting helpers. `tests/unit/runtimeAgentEventWorkflow.test.ts` covers streaming event behavior, including open thinking chunks. `tests/unit/messageExtract.test.ts` covers assistant-visible text cleanup.

## Plan of Work

First, add `src/lib/text/thinking-tags.ts`. This module should own the regexes for thinking tag names and export three functions:

    extractThinkingFromTaggedText(text: string): string
    extractThinkingFromTaggedStream(text: string): string
    hasUnclosedThinkingTag(text: string): boolean

Keep the implementation deep: callers should not know the regexes, tag set, or last-open/last-close comparison. They should only ask for extracted thinking text or whether a stream currently has an unclosed thinking tag. Do not export regex constants, tag-name arrays, parser options, or callbacks.

Second, update `src/lib/text/message-extract.ts` to import `extractThinkingFromTaggedText`, `extractThinkingFromTaggedStream`, and `hasUnclosedThinkingTag` from the new module. Re-export all three helpers from `message-extract.ts` so existing imports keep working and runtime code can continue treating `message-extract.ts` as the text boundary. Remove the old inline helper implementations and regex constant that become redundant. Keep `stripThinkingTagsFromAssistantText` behavior unchanged unless tests prove a bug.

Third, update `src/features/agents/state/runtimeAgentEventWorkflow.ts` to import `hasUnclosedThinkingTag` from `message-extract.ts`. Delete the local duplicate `hasUnclosedThinkingTag`.

Fourth, update tests. Add focused assertions in `tests/unit/extractThinking.test.ts` for `hasUnclosedThinkingTag`, covering an open tag, a closed tag, and a later close before a later open. Existing runtime workflow tests should continue to prove that open thinking chunks do not leak into visible assistant text.

The implementation order matters. Add the helper module first, then add compatibility exports from `message-extract.ts`, then switch `runtimeAgentEventWorkflow.ts`. This keeps TypeScript import errors localized: if the workflow import fails, the compatibility boundary is the first place to inspect.

## Concrete Steps

Work from `/Users/georgepickett/openclaw-studio`.

1. Confirm the selected files are not pre-existing dirty:

    git status --short -- src/lib/text/message-extract.ts src/features/agents/state/runtimeAgentEventWorkflow.ts tests/unit/extractThinking.test.ts

   Expected result before editing: no output for those paths.

2. Add `src/lib/text/thinking-tags.ts` with the shared helper functions.

3. Update `src/lib/text/message-extract.ts` to use and re-export the helper functions.

4. Update `src/features/agents/state/runtimeAgentEventWorkflow.ts` to remove the local duplicated helper.

5. Update `tests/unit/extractThinking.test.ts` with direct coverage for the unclosed-tag helper.

6. Run targeted validation:

    npm run test -- tests/unit/extractThinking.test.ts tests/unit/messageExtract.test.ts tests/unit/runtimeAgentEventWorkflow.test.ts

7. Run broader validation if targeted tests pass:

    npm run typecheck

Actual validation results:

    npm run test -- tests/unit/extractThinking.test.ts tests/unit/messageExtract.test.ts tests/unit/runtimeAgentEventWorkflow.test.ts
    Test Files  3 passed (3)
    Tests  41 passed (41)

    npm run test -- tests/unit/extractThinking.test.ts tests/unit/messageExtract.test.ts tests/unit/runtimeAgentEventWorkflow.test.ts
    Test Files  3 passed (3)
    Tests  42 passed (42)

    npm run test -- tests/unit/extractThinking.test.ts tests/unit/messageExtract.test.ts tests/unit/runtimeAgentEventWorkflow.test.ts tests/unit/runtimeEventBridge.test.ts tests/unit/runtimeChatEventWorkflow.test.ts
    Test Files  5 passed (5)
    Tests  76 passed (76)

    npm run typecheck
    Passed with exit code 0.

If targeted validation fails, do not continue to broader validation until the failure is understood. If the failure is in `extractThinking.test.ts`, inspect the new helper behavior first. If it is in `runtimeAgentEventWorkflow.test.ts`, compare the previous local `hasUnclosedThinkingTag` logic against the new helper and preserve old behavior unless a test clearly describes a bug.

## Validation and Acceptance

Acceptance requires:

- `extractThinkingFromTaggedText` and `extractThinkingFromTaggedStream` still behave as before through the existing `message-extract.ts` imports.
- `hasUnclosedThinkingTag` is covered by unit tests and replaces the duplicated workflow-local regex logic.
- Runtime agent workflow tests still show that open thinking chunks update thinking trace without leaking into visible stream text.
- `npm run test -- tests/unit/extractThinking.test.ts tests/unit/messageExtract.test.ts tests/unit/runtimeAgentEventWorkflow.test.ts` passes.
- `npm run typecheck` passes, unless it fails for an environmental or pre-existing reason unrelated to this diff and that reason is documented.

The implementation is not accepted if it only creates a new module but leaves the duplicated `hasUnclosedThinkingTag` regex in `runtimeAgentEventWorkflow.ts`; removing that duplication is the core complexity dividend.

## Idempotence and Recovery

The edits are additive plus small deletions. Re-running tests is safe. If the helper split causes broad import churn or behavior differences outside thinking tag parsing, revert only this cycle's selected source/test files plus `src/lib/text/thinking-tags.ts` and return to the decision artifact; do not modify unrelated dirty files. If validation fails, inspect the failing assertion before changing behavior because the goal is a no-behavior-change refactor.

## Artifacts and Notes

The current selected source files are clean in the pre-existing dirty worktree. The final diff should be limited to:

- `.agent/work/2026-05-08-2054-text-message-boundaries/*`
- `src/lib/text/thinking-tags.ts`
- `src/lib/text/message-extract.ts`
- `src/features/agents/state/runtimeAgentEventWorkflow.ts`
- `tests/unit/extractThinking.test.ts`

## Interfaces and Dependencies

New module:

    src/lib/text/thinking-tags.ts

Required exported functions:

    export function extractThinkingFromTaggedText(text: string): string
    export function extractThinkingFromTaggedStream(text: string): string
    export function hasUnclosedThinkingTag(text: string): boolean

The helper module should keep its regexes and tag list private. No new dependency is needed.

Compatibility exports from `src/lib/text/message-extract.ts` must continue to provide:

    extractThinkingFromTaggedText
    extractThinkingFromTaggedStream
    hasUnclosedThinkingTag

Revision note, 2026-05-09 04:08Z: factual accuracy pass verified paths and Vitest command shape, then tightened the import decision so `runtimeAgentEventWorkflow.ts` imports `hasUnclosedThinkingTag` through the existing `message-extract.ts` boundary.

Revision note, 2026-05-09 04:11Z: completeness and sequencing pass clarified the implementation order, the targeted-test failure triage path, and the acceptance rule that duplicated workflow regex logic must be removed.

Revision note, 2026-05-09 04:13Z: design-quality pass made the module boundary deeper by forbidding exported regex/tag configuration and keeping the known tag policy private.

Revision note, 2026-05-09 04:58Z: implementation completed, targeted validation and typecheck passed, and outcomes were recorded.

Revision note, 2026-05-09 05:03Z: review pass 2 added unit coverage proving `hasUnclosedThinkingTag` honors the same `antthinking` and `thought` aliases as tagged stream extraction.

Revision note, 2026-05-09 05:05Z: review pass 3 confirmed the helper keeps regex/tag policy private and the runtime workflow still imports through `message-extract.ts`.

Revision note, 2026-05-09 05:07Z: review pass 4 expanded adjacent validation to runtime event bridge and chat workflow tests, then reran typecheck successfully.
