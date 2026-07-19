# Refactor Candidates: Media Text Rendering

## Scope And Constraints

Target repo: `/Users/georgepickett/openclaw-studio`. Cycle 2 starts after commit `b2dd992244b4cb1eacf3c6535eb94f389032873c`. The worktree still contains broad pre-existing dirty work unrelated to this cycle. `src/lib/text/media-markdown.ts` and `tests/unit/mediaMarkdown.test.ts` are clean and isolated.

Hard constraints: do not modify `~/openclaw`; do not touch secrets, deploy, push, branch switch, or destructive-delete; keep the commit isolated to this cycle's files and work-item artifacts.

## Repo Model

OpenClaw Studio renders assistant/runtime text in the browser. `src/lib/text/media-markdown.ts` rewrites tool-style `MEDIA:` lines into markdown image syntax for inline chat rendering. It normalizes line endings, tracks fenced code blocks, detects inline and next-line media paths, checks image extensions, emits markdown plus the original media line, and mutates the loop index when the next line is consumed. `tests/unit/mediaMarkdown.test.ts` covers direct media lines, next-line media paths, and fenced code blocks.

## Ranked Shortlist

1. Extract media-line detection into a small internal parser result.
2. Add characterization tests only for non-image and mixed-case image paths.
3. Extract fence scanning into a generic line scanner.
4. Do nothing.
5. Minimal surgical change: rename local variables only.

## Candidate 1: Internal Media-Line Parser

Refactor class: hide sequencing and special cases in the owning module.

Scope: `src/lib/text/media-markdown.ts`, `tests/unit/mediaMarkdown.test.ts`.

Problem: `rewriteMediaLinesToMarkdown` owns fence state, media-line detection, next-line consumption, image validation, URL construction, output rendering, and index mutation in one loop. The subtle part is not URL rendering; it is deciding whether the current line is a media image and whether the next line is consumed.

Supporting evidence: the loop has two separate media patterns and an index mutation branch. Tests already isolate this module.

Contradictory evidence: the file is only 80 lines, so extraction could become shallow if it exposes too many helper concepts.

Falsifier: if the helper needs public exports or more than one new type, this is too much.

Expected payoff: modest but real; the loop can read as scan fence, parse media candidate, render image or keep original line.

Blast radius: very low.

Reversibility: high.

Cheapest probe: inspect whether all helper state can be represented as `{ mediaPath, consumesNextLine }`.

## Candidate 2: Characterization Tests Only

Refactor class: minimal surgical safety improvement.

Scope: `tests/unit/mediaMarkdown.test.ts`.

Problem: current tests do not explicitly pin non-image `MEDIA:` lines or case-insensitive image extensions.

Supporting evidence: `isImagePath` lowercases values and non-image lines intentionally fall through.

Contradictory evidence: tests alone do not simplify the implementation.

Falsifier: if implementation is already clear enough and no production edit is justified, tests are the safest useful work.

Expected payoff: low.

Blast radius: very low.

Reversibility: high.

Cheapest probe: add tests without production changes.

## Candidate 3: Generic Fence Scanner

Refactor class: extract repeated line-scanning policy.

Scope: `src/lib/text/media-markdown.ts` and possibly other markdown/text helpers.

Problem: fenced-code skipping may recur across text transformations.

Supporting evidence: `media-markdown.ts` has explicit fence state.

Contradictory evidence: no current duplicate scanner was found in the clean target surface; a generic scanner would likely be premature.

Falsifier: if no second caller exists, do not add this abstraction.

Expected payoff: low to medium only with another caller.

Blast radius: medium.

Reversibility: medium.

Cheapest probe: search for other fenced-code scanners before planning.

## Candidate 4: Do Nothing

Refactor class: avoid churn.

Scope: no changes.

Supporting evidence: the module is short and already tested.

Contradictory evidence: the detection/consumption policy is the exact sort of hidden sequencing that benefits from a tiny internal helper.

## Candidate 5: Minimal Rename

Refactor class: cosmetic readability.

Scope: local names only.

Supporting evidence: lower risk than extraction.

Contradictory evidence: renaming does not hide policy or reduce change amplification.

## Provisional Leader

Candidate 1 is the provisional leader if the helper remains private and tiny. Candidate 2 is the fallback if extraction proves to add concepts. Candidate 3 is likely over-broad without another caller. Candidate 4 remains plausible because the file is small. Candidate 5 is not worth a full cycle.

## Next Step

Run `select-refactor`; pressure-test whether Candidate 1 is a real simplification or whether Candidate 2/do-nothing dominates.
