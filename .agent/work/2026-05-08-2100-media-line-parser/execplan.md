# Hide Media-Line Consumption Policy

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This plan follows `.agent/PLANS.md` in this repository.

## Purpose / Big Picture

OpenClaw Studio can render image paths emitted by tools when assistant text contains `MEDIA:` lines. The user-visible behavior should stay the same: image media lines render as markdown images in chat, fenced code blocks are left alone, and the original `MEDIA:` line remains visible after the image. This refactor makes the implementation easier to change by hiding the subtle "this line consumes the next line" rule behind a private helper.

## Progress

- [x] (2026-05-09 05:10Z) Created candidate shortlist and locked the decision.
- [x] (2026-05-09 05:13Z) Improved plan pass 1/3 for factual accuracy: verified target paths, existing regex names, and focused test file.
- [x] (2026-05-09 05:14Z) Improved plan pass 2/3 for sequencing and acceptance: clarified validation must happen before broader typecheck and failure handling preserves old behavior.
- [x] (2026-05-09 05:15Z) Improved plan pass 3/3 for design quality: constrained the helper to one private type/function and no exported parser surface.
- [x] (2026-05-09 05:16Z) Implemented private parser helper and added non-image/mixed-case tests.
- [x] (2026-05-09 05:18Z) Ran focused validation and typecheck; both passed.
- [x] (2026-05-09 05:20Z) Review pass 1/4 checked correctness and regressions; no code issue found.
- [x] (2026-05-09 05:21Z) Review pass 2/4 checked edge cases and added no-consume coverage for `MEDIA:` followed by non-image text.
- [x] (2026-05-09 05:23Z) Review pass 3/4 checked simplicity and information hiding; parser helper/type are private and only the rewrite API is exported.
- [x] (2026-05-09 05:24Z) Review pass 4/4 reran focused validation and typecheck; both passed.

## Surprises & Discoveries

- Observation: No second clean fenced-code scanner caller was found.
  Evidence: repository search found `rewriteMediaLinesToMarkdown` and its tests as the only direct media-line rewriting surface.

- Observation: The current implementation uses `MEDIA_LINE_RE`, `MEDIA_ONLY_RE`, and `isImagePath` inside `rewriteMediaLinesToMarkdown`.
  Evidence: these symbols are defined in `src/lib/text/media-markdown.ts` and the detection branch starts inside the current loop's media-path block.

## Decision Log

- Decision: Keep `rewriteMediaLinesToMarkdown(text: string): string` as the only public API.
  Rationale: Callers only need rewritten text. Exposing a parser would leak internal detection policy.
  Date/Author: 2026-05-09 / Codex

- Decision: Extract only media-line detection, not fenced-code scanning.
  Rationale: Fenced-code state is straightforward in the loop and has no second caller. The hidden complexity is the inline-versus-next-line media path and index consumption rule.
  Date/Author: 2026-05-09 / Codex

## Outcomes & Retrospective

Implemented. `src/lib/text/media-markdown.ts` now owns media-line detection in a private `parseMediaLine` helper while keeping `rewriteMediaLinesToMarkdown` as the only public API. Non-image `MEDIA:` lines and mixed-case image extensions are characterized in `tests/unit/mediaMarkdown.test.ts`. Focused tests and typecheck passed.

## Context and Orientation

`src/lib/text/media-markdown.ts` exports `rewriteMediaLinesToMarkdown`. It normalizes line endings, iterates lines, skips replacements while inside fenced code blocks, detects `MEDIA: /path/image.png` and `MEDIA:` followed by an image path on the next line, then emits `![](/api/runtime/media?path=<encoded>)`, a blank line, and `MEDIA: <path>`.

The non-obvious policy is that only the `MEDIA:`-alone form consumes the next line, and only when that next line looks like an image path. The implementation should move that decision into one private helper.

`tests/unit/mediaMarkdown.test.ts` is the focused test file for this module.

## Plan of Work

Add a private type in `src/lib/text/media-markdown.ts`:

    type ParsedMediaLine = { mediaPath: string; consumesNextLine: boolean };

Add a private helper:

    const parseMediaLine = (lines: string[], idx: number): ParsedMediaLine | null => { ... };

The helper should inspect the current line, return a path for inline `MEDIA: <path>` when the path is an image, return a path and `consumesNextLine: true` for `MEDIA:` followed by an image path, and return null for non-image media lines. Keep URL creation and output rendering in `rewriteMediaLinesToMarkdown`.

Update `tests/unit/mediaMarkdown.test.ts` with tests that non-image media lines are unchanged and mixed-case image extensions still rewrite.

## Concrete Steps

Work from `/Users/georgepickett/openclaw-studio`.

1. Confirm selected files are clean:

    git status --short -- src/lib/text/media-markdown.ts tests/unit/mediaMarkdown.test.ts

2. Edit `src/lib/text/media-markdown.ts` to add `ParsedMediaLine` and `parseMediaLine`.

3. Replace the inline detection block in `rewriteMediaLinesToMarkdown` with `const parsed = parseMediaLine(lines, idx)`.

4. Add tests in `tests/unit/mediaMarkdown.test.ts`.

5. Run:

    npm run test -- tests/unit/mediaMarkdown.test.ts
    npm run typecheck

Actual validation results:

    npm run test -- tests/unit/mediaMarkdown.test.ts
    Test Files  1 passed (1)
    Tests  5 passed (5)

    npm run test -- tests/unit/mediaMarkdown.test.ts
    Test Files  1 passed (1)
    Tests  6 passed (6)

    npm run typecheck
    Passed with exit code 0.

Run the focused test first. If it fails, stop and compare the helper result to the pre-refactor inline branch for the same input before changing behavior.

## Validation and Acceptance

Acceptance requires `npm run test -- tests/unit/mediaMarkdown.test.ts` and `npm run typecheck` to pass. The final diff must preserve the public function signature and must not introduce exported parser helpers, generic scanner utilities, parser options, callbacks, or changes to `AgentChatPanel.tsx`.

## Idempotence and Recovery

The change is local and safe to rerun. If tests fail, compare the failing input against the old inline detection logic and preserve old behavior unless the test documents a deliberate characterization gap. If the helper grows beyond one private type and one private function, abandon the extraction and keep only the tests.

## Artifacts and Notes

Expected changed files:

- `.agent/work/2026-05-08-2100-media-line-parser/*`
- `src/lib/text/media-markdown.ts`
- `tests/unit/mediaMarkdown.test.ts`

## Interfaces and Dependencies

No new dependency is needed. The only public interface remains:

    export const rewriteMediaLinesToMarkdown = (text: string): string

Revision note, 2026-05-09 05:15Z: three improvement passes verified the plan against current code, tightened validation sequencing, and constrained the abstraction to a private helper rather than a new parser API.

Revision note, 2026-05-09 05:18Z: implementation completed, focused media markdown tests and typecheck passed, and outcomes were recorded.

Revision note, 2026-05-09 05:21Z: review pass 2 added coverage that `MEDIA:` followed by non-image text does not consume the following line.

Revision note, 2026-05-09 05:24Z: review passes 3 and 4 confirmed the parser remains private, then reran focused validation and typecheck successfully.
