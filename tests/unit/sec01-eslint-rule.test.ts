import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

/**
 * SEC-01 regression test (PR #106 review feedback).
 *
 * `eslint.config.mjs` `globalIgnores` excludes `tests/eslint-rules/**` from
 * default `npm run lint` so the deliberate forbidden-token violation in
 * `sandbox-allow-same-origin.fixture.tsx` does NOT fail CI under normal
 * lint runs. Without this test, weakening or removing the SEC-01 rule
 * (`no-restricted-syntax` over the forbidden sandbox token) would
 * silently land.
 *
 * The fix: drive ESLint via its Node API with `ignore: false` so the
 * fixture is linted regardless of `globalIgnores`, then assert the rule
 * fires with severity 2 (error) and the expected message text.
 *
 * Note: the forbidden token text is built via runtime concatenation
 * (`["allow","same","origin"].join("-")`) so the SEC-01 rule does not
 * fire on this assertion file itself — same idiom as
 * `tests/unit/inlineWidget.test.ts`.
 */
describe("SEC-01: forbidden sandbox-token lint rule", () => {
  const forbiddenToken = ["allow", "same", "origin"].join("-");

  it(
    "fires on the deliberate fixture violation",
    async () => {
      const eslint = new ESLint({
        ignore: false,
        errorOnUnmatchedPattern: false,
        warnIgnored: false,
      });
      // Construct the fixture path at runtime so the SEC-01 rule
      // (which matches Literal[value=/allow-same-origin/]) does not
      // fire on this assertion file itself. The fixture's actual file
      // name on disk is the canonical violation; here we just point
      // ESLint at it without embedding the token as a string literal.
      const fixturePath = `tests/eslint-rules/sandbox-${[
        "allow",
        "same",
        "origin",
      ].join("-")}.fixture.tsx`;
      const results = await eslint.lintFiles([fixturePath]);
      expect(results).toHaveLength(1);
      const messages = results[0]?.messages ?? [];
      const sec01 = messages.find(
        (m) =>
          m.ruleId === "no-restricted-syntax" &&
          typeof m.message === "string" &&
          m.message.includes(forbiddenToken),
      );
      expect(sec01).toBeDefined();
      expect(sec01?.severity).toBe(2);
    },
    10_000,
  );
});
