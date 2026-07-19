# Decision: Centralize Thinking Tag Parsing

## Chosen Refactor

Centralize thinking-tag parsing in a dedicated text helper while preserving the existing public imports from `message-extract.ts`. The implementation should move the tag grammar and stream helpers out of the mixed message extraction module and reuse the same helper from runtime agent stream handling.

## Why This Beats The Alternatives

This wins because the selected policy is cohesive, clean in the current worktree, and already covered by focused tests. It is not just file shuffling: `src/features/agents/state/runtimeAgentEventWorkflow.ts` currently duplicates the same thinking-tag open/close regex logic that `src/lib/text/message-extract.ts` owns. A small shared helper can hide that grammar in one place while keeping callers on the existing `message-extract.ts` API where that is the natural high-level interface.

The media-line parser alternative is safer but likely too small; the current `media-markdown.ts` loop is only 80 lines and readable. The UI subview extraction from `AgentInspectPanels.tsx` may be valuable, but it risks shallow prop plumbing and visual regression. Test-only characterization is useful if implementation gets risky, but it does not remove complexity. Do nothing is too conservative because this boundary is clean and isolated from the broad dirty runtime/control-plane work.

## Evidence That Changed Confidence

- `message-extract.ts` contains unrelated concerns: user envelope stripping, assistant text cleanup, thinking extraction, tool markdown, meta markdown, and UI metadata cleanup.
- `extractThinkingFromTaggedText` and `extractThinkingFromTaggedStream` already form a cohesive helper surface with dedicated tests in `tests/unit/extractThinking.test.ts`.
- `runtimeAgentEventWorkflow.ts` has a local `hasUnclosedThinkingTag` helper using duplicated thinking-tag regexes.
- No production caller needs to import a new module for normal extraction if `message-extract.ts` continues to re-export the same public helpers.
- Target files are not part of the pre-existing dirty worktree, so the final diff should be isolatable.

## Runner-Up Outcomes

- Media-line scanning loses because its current implementation is short enough that added helpers may add concepts.
- Agent inspect subview extraction loses because it needs a separate UI-focused pass and could spread state through props.
- Minimal surgical tests lose because they do not deliver a complexity dividend on their own.
- Do nothing loses because the chosen refactor has low blast radius and clear duplicated policy.

## Success Criteria

- Thinking tag open/close grammar lives in one helper module.
- `message-extract.ts` remains the public compatibility boundary for existing imports.
- `runtimeAgentEventWorkflow.ts` uses the shared helper instead of local duplicated regex logic.
- Existing thinking extraction, assistant stream, chat rendering, and runtime event tests still pass.
- The diff touches only this work item plus the selected text/runtime workflow files and tests.

## First Safe Slice

Create `src/lib/text/thinking-tags.ts` with `extractThinkingFromTaggedText`, `extractThinkingFromTaggedStream`, and `hasUnclosedThinkingTag`. Re-export the two existing public extraction helpers from `message-extract.ts`, then replace the local workflow helper with the shared import.

## Abandonment Conditions

- The new module forces broad import churn outside the selected files.
- Tests reveal that message extraction and runtime stream handling intentionally use different tag grammars.
- The current dirty worktree overlaps the selected files before implementation starts.
- Validation failures point to behavior changes outside the intended tag parsing boundary.

## Hard Constraints For ExecPlan

- Do not modify `~/openclaw`.
- Do not change public imports for existing callers unless the plan proves it is necessary.
- Keep the helper deep: the tag grammar and last-open/last-close sequencing should be internal to the helper module.
- Preserve all current behavior unless a test exposes a clear bug and the plan records the decision.
