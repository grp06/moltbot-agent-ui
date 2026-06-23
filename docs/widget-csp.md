# Widget CSP Guidance

## Purpose

OpenClaw Studio's inline-widget feature renders agent-generated HTML
inside a sandboxed `<iframe srcdoc>`. The iframe loads two CDN-hosted
resources at runtime — Tailwind CSS v4 and Chart.js — and runs
inline `<script>` tags inside the srcDoc.

If Studio ever adds a `Content-Security-Policy` header (today it does
not), the policy MUST permit these resources. This doc spells out the
minimum directives so future CSP work does not silently break widgets.

> **Scope.** This is *widget-specific* CSP guidance — directives required
> if Studio adds CSP and wants the inline-widget feature to keep working.
> The permissive tokens below (`'unsafe-inline'`, `img-src *`) apply
> inside the iframe `srcdoc` context, where the iframe
> `sandbox="allow-scripts allow-popups"` attribute is the trust boundary.
> They are NOT recommended for any non-widget surface of Studio. For
> nonce/hash-based alternatives, see "Stricter alternatives" at the end.

## When this applies

- Studio currently ships **no CSP header**. The widget feature works
  by default. This doc is a forward-looking guide for whoever adds CSP
  later.
- The widget iframe runs with `sandbox="allow-scripts allow-popups"`
  and no `allow-same-origin`. The sandbox is the widget's trust
  boundary; CSP is an *additional* layer that must be configured
  cooperatively with the sandbox, not as a replacement for it.

## Required directives

### `script-src 'unsafe-inline' https://cdn.jsdelivr.net`

Widgets execute inline `<script>` tags inside their srcDoc. Browsers
treat `about:srcdoc` document CSP inheritance unevenly — Chrome and
Firefox have historically differed on which directives flow into the
srcDoc context. To stay compatible, the parent page's `script-src`
must allow inline scripts AND the jsdelivr CDN that hosts the widget
runtime libraries.

- `'unsafe-inline'` — required for `<script>` blocks in widget HTML.
  The sandbox prevents these scripts from reaching parent-origin
  resources, so `'unsafe-inline'` here does **not** weaken Studio's
  own attack surface.
- `https://cdn.jsdelivr.net` — origin for the pinned Tailwind v4
  browser CDN (`@tailwindcss/browser@4`) and Chart.js
  (`chart.js@4.5.1/dist/chart.umd.min.js`). Both are loaded inside
  the iframe at widget-mount time.

### `frame-src 'self'`

Studio embeds widgets via `<iframe srcdoc>`, which navigates to the
synthetic URL `about:srcdoc`. Browsers consistently allow `srcdoc`
iframes when `frame-src` permits the embedding origin (`'self'`).
Adding `'self'` is sufficient — do **not** add `data:` or `about:`
schemes; they don't apply to `srcdoc` and add unrelated attack
surface.

### `img-src *`

Widget HTML may reference user-supplied or agent-generated image URLs
from arbitrary origins (chart screenshots, status icons, external
assets). Restricting `img-src` would block legitimate widget content.
Images load from the iframe context only, where the sandbox prevents
them from reading parent storage; allowing `*` here is consistent with
the sandbox boundary.

## Optional / situational

### `connect-src`

If a widget uses `fetch()` to a third-party API (e.g., a real-time
quotes endpoint), the parent CSP must permit that origin. The default
Studio widgets ship today do not perform fetch — they visualize
agent-supplied data inline. Adding allowlisted `connect-src` origins
is opt-in per deployment.

### `style-src`

Tailwind v4's browser runtime injects styles into the iframe document
via inline `<style>` tags. If a future CSP restricts `style-src`,
include `'unsafe-inline'` in the same way as `script-src`. Most
deployments do not need to tighten `style-src`.

## What NOT to do

- **Do not add `'unsafe-eval'`** — Tailwind v4 browser runtime no
  longer requires it. Adding it broadens the parent-page attack
  surface for marginal widget benefit. If you observe CSP errors
  blocking `eval`, audit which library version is loaded; pin to the
  documented Tailwind v4 browser build at
  `cdn.jsdelivr.net/npm/@tailwindcss/browser@4`.
- **Do not relax the iframe sandbox** to compensate for a strict CSP.
  The sandbox is the widget trust boundary; loosening it (e.g.,
  adding `allow-same-origin`) opens documented sandbox-escape paths
  via `iframe.removeAttribute('sandbox')` followed by self-reload.
- **Do not allowlist `cdn.tailwindcss.com`** (the v3 Play CDN). The
  widget code path uses `cdn.jsdelivr.net/npm/@tailwindcss/browser@4`
  for Tailwind v4 semantics. Mixing the two CDNs would render widgets
  with the wrong Tailwind version.

## Background

Widgets render inside a sandboxed iframe to keep agent-generated HTML
isolated from Studio's origin. The sandbox blocks DOM access, cookie
reads, and storage access; it does not block network requests to
allowed origins. CSP at the parent layer is the second line of
defence — it determines which origins the iframe can fetch from.

The sandbox token set is locked at the source level to the literal
string `allow-scripts allow-popups`. A custom ESLint rule (SEC-01,
defined in `eslint.config.mjs`) prevents introducing dangerous tokens
like `allow-same-origin`, `allow-forms`, or `allow-top-navigation`
into the sandbox attribute via `no-restricted-syntax`.

## Verification

To check that a CSP change does not break widgets, run the Playwright
e2e suite:

```bash
npm run e2e -- tests/e2e/widget-replay-parity.spec.ts
```

The spec asserts that the iframe `sandbox` attribute is the literal
`"allow-scripts allow-popups"`, that the 9 mapped Studio theme CSS
variables are injected into the srcDoc, that iframe attributes are
byte-equal between live render and replay, that forged
`window.parent` postMessage calls cannot resize widgets, and that no
new accessibility violations appear vs a baseline transcript with no
widgets.

## Stricter alternatives

Deployments that want tighter `script-src` than `'unsafe-inline'` can
use CSP nonces or hashes — but those mechanisms require widget-side
coordination:

- **Nonces** — the parent CSP issues `script-src 'nonce-<value>'`, and
  every `<script>` inside widget HTML must carry
  `<script nonce="<value>">`. Agents emitting widget HTML would need to
  be informed of the per-request nonce, which Studio's current
  architecture does not propagate.
- **Hashes** — the parent CSP issues `script-src 'sha256-<digest>'`
  for each known script body. Works only for stable, build-time
  scripts — agent-generated dynamic scripts cannot be hashed in
  advance.

Until widget HTML can participate in nonce/hash coordination,
`'unsafe-inline'` inside the sandboxed `srcdoc` is the simplest path.
The sandbox prevents inline scripts from reaching parent-origin
resources, so the security property comes from the sandbox, not from
CSP.
