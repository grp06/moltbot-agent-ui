import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

// SEC-01: Ban the `allow-same-origin` sandbox token from any TypeScript/TSX file
// in the repo. The token combined with `allow-scripts` is the canonical iframe
// sandbox escape (WHATWG-documented). Lands here per CONTEXT.md D-24..D-27.
const SANDBOX_ESCAPE_MESSAGE =
  "allow-same-origin sandbox token enables sandbox escape via document reload (WHATWG-documented). See .planning/phases/02-widget-component-security/02-CONTEXT.md D-24.";

const sec01SandboxRule = {
  files: ["**/*.{ts,tsx}"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "Literal[value=/allow-same-origin/]",
        message: SANDBOX_ESCAPE_MESSAGE,
      },
      {
        selector: "TemplateElement[value.raw=/allow-same-origin/]",
        message: SANDBOX_ESCAPE_MESSAGE,
      },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["server/**/*.js", "scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  sec01SandboxRule,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".worktrees/**",

    // Vendored third-party code (kept as-is; linting it adds noise).
    "src/lib/avatars/vendor/**",

    // SEC-01 ESLint fixture path is intentionally ignored at default lint
    // time — its file violates the rule so we have a regression test. Run
    // `npm run lint -- <fixture path> --no-ignore` to confirm the rule
    // fires; default lint excludes it so CI stays green.
    "tests/eslint-rules/**",
  ]),
  prettier,
]);

export default eslintConfig;
