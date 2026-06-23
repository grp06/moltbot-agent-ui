// SEC-01 ESLint regression fixture (CONTEXT.md D-24..D-27).
//
// This file intentionally contains the forbidden `allow-same-origin` sandbox
// token so the SEC-01 lint rule has a guaranteed regression test. The fixture
// is excluded from the default `npm run lint` invocation via globalIgnores in
// `eslint.config.mjs`; verify the rule by running:
//
//   npm run lint -- tests/eslint-rules/sandbox-allow-same-origin.fixture.tsx
//
// Expected: lint exits non-zero with the SEC-01 message referencing
// 02-CONTEXT.md D-24. Any time SEC-01 is removed or weakened, this fixture
// stops failing — and the regression is caught at PR review.

export const SandboxFixture = () => (
  <iframe sandbox="allow-scripts allow-same-origin" title="fixture" />
);
