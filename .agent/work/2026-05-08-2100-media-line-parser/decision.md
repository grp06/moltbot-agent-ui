# Decision: Hide Media-Line Consumption Policy

## Chosen Refactor

Add a private media-line parser inside `src/lib/text/media-markdown.ts` that returns the detected image path and whether the next line was consumed. Keep the public API as `rewriteMediaLinesToMarkdown(text: string): string`.

## Why It Beats The Alternatives

Candidate 1 wins because the helper can hide the only non-obvious sequencing in the module: a `MEDIA:` line can either include its image path inline or consume the following line. The existing loop mutates `idx` after rendering, so readers have to keep detection and consumption policy in their head while also reading rendering code.

Characterization tests alone are useful but do not reduce complexity. A generic fenced-code scanner is too broad because no second clean caller exists. Doing nothing is plausible because the file is small, but the private helper is small enough to improve local reasoning without adding a public concept. Renaming locals is cosmetic.

## Evidence That Changed Confidence

- `rg` found `rewriteMediaLinesToMarkdown` has one production caller area in `AgentChatPanel.tsx` and one focused test file.
- `media-markdown.ts` is clean in the dirty worktree.
- The helper state can be represented by one private type: `{ mediaPath: string; consumesNextLine: boolean } | null`.
- No other clean fenced-code scanner caller was found, so a generic scanner would be speculative.

## Success Criteria

- Public API remains unchanged.
- Media-line detection and next-line consumption are owned by one private helper.
- Existing tests pass.
- Tests pin non-image media lines and mixed-case image extensions so the helper's policy is visible.

## First Safe Slice

Create a private `ParsedMediaLine` type and `parseMediaLine(lines, idx)` helper. Keep rendering in `rewriteMediaLinesToMarkdown`.

## Abandonment Conditions

- The helper needs to be exported.
- The helper requires more than one private type or starts handling fenced-code state.
- Validation shows behavior changes for existing direct, next-line, or fenced media cases.

## Hard Constraints For ExecPlan

Do not modify `~/openclaw`; do not touch existing dirty unrelated files; keep the diff isolated to `src/lib/text/media-markdown.ts`, `tests/unit/mediaMarkdown.test.ts`, and this work item.
