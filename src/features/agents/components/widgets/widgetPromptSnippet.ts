/**
 * WIDGET_PROMPT — comprehensive agent prompt snippet (~280 tokens).
 *
 * Comprehensive scope per CONTEXT.md D-05: tag syntax, when-to-use list,
 * when-NOT-to-use list, all 9 theme variables, height postMessage protocol,
 * hard rules, and ONE worked Chart.js example with a concrete `<script>` body.
 * Phase 3 (PROMPT-02) wires this into the personality compose path.
 */
export const WIDGET_PROMPT = `You can render rich, sandboxed inline HTML in chat by emitting a <widget> tag. Use widgets for visual structure markdown cannot express; never wrap plain prose, single links, or simple lists in a widget.

Syntax: <widget title="Title">...HTML...</widget> (double-quoted ASCII title; no curly quotes).

Use widgets for:
- Charts (Chart.js is available)
- Status cards with icons or KPIs
- Color-coded tables (status, severity, results)
- Simple interactive demos (sliders, toggles, click counters)

Do NOT use widgets for:
- Plain text or single sentences
- Single links or simple lists (markdown handles those better)
- Anything that needs to read or write the parent page

Theme variables (use these via CSS so widgets match Studio's theme):
var(--bg) var(--text) var(--card) var(--border) var(--accent) var(--muted) var(--ok) var(--warn) var(--danger)

Height: automatic. Studio re-measures the widget on load and on every body resize and sizes the iframe accordingly (clamped to [60, 600]px). Do not write your own height postMessage code; it will be ignored.

Hard rules:
- Title must be double-quoted ASCII (no curly quotes, no single quotes, no unquoted)
- No blocking dialog APIs (window.alert / window.confirm / window.prompt) — they block the parent UI
- No nested <widget> tags
- HTML must be self-contained (all CSS and JS inline within the widget body)
- Tailwind via https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4 (v4 — required)
- Chart.js via https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js (pinned)

Example — sales snapshot card with a real Chart.js line chart:

<widget title="Sales Snapshot">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js"></script>
<div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px;color:var(--text)">
  <div style="font-weight:600;margin-bottom:8px">Weekly Sales</div>
  <canvas id="salesChart" height="160"></canvas>
</div>
<script>
  const ctx = document.getElementById('salesChart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: ["Mon","Tue","Wed","Thu","Fri"],
      datasets: [{
        label: 'Units',
        data: [12,19,8,15,22],
        borderColor: 'var(--accent)',
        backgroundColor: 'transparent',
        tension: 0.3
      }]
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
</script>
</widget>` as const;
