# Spec: Analytics accelerator, initial scope

Status: **draft, partly decided.** Decided on 2026-11-13: the accelerator is an **analytics screen** with a metrics
dashboard (see `.claude/steering/product.md`). Still open: where the data comes from and what is measured.

## 1. Goal

A screen where a user sees the key metrics of the NooblyJS accelerators on a rich, readable dashboard, and can drill into
a metric to see how it changed over time.

## 2. Requirements

**R1 Screen in the launcher.** The screen mounts at `/analytics` the way the infrastructure accelerator mounts at
`/infrastructure`: a module file the launcher's frame loads, and a navigation entry in the frame.
- Acceptance: `GET /analytics` (deep link and refresh) shows the dashboard inside the frame; a missing static file returns 404.

**R2 Dashboard panels.** The first version shows:
- a row of KPI tiles (each with value, change against the previous period, and the period label);
- at least one trend chart per source (value over time, selectable period: 24 h, 7 d, 30 d, custom);
- one breakdown chart (a metric by category, for example orders by status or messages by outcome).
- Acceptance: every panel renders with the seeded demo data, and with an empty store (an empty state, not an error).

**R3 Metric definitions.** Each metric is defined once, in a single file, with: name, unit, source, how it is computed,
and the period it is reported over. The dashboard reads from these definitions.
- Acceptance: adding a metric is one definition entry plus its source; no panel code changes.

**R4 Sources, in order.** (1) Commerce: orders, sales, stock moves, deliveries. (2) Customers: marketing sends, engagement
(opens, clicks, unsubscribes) and consent. (3) Infrastructure: VM and operation counts, cost estimate. Each source is added with
a test that checks its computed values against fixed data.

**R5 Freshness.** Each panel shows "updated at HH:MM". A manual refresh button re-reads the data.
- Acceptance: with the clock fixed in a test, the timestamp matches the data read.

**R6 Accessibility and responsiveness.** Keyboard usable; charts have a text summary or a table alternative; works at phone
width with no horizontal page scroll; readable in light and dark.

**R7 Tests.** Replace the placeholder `test` script (`--passWithNoTests`) with real tests: metric definitions, the summary
functions, and the screen rendering with seeded data. Add the package to the monorepo CI (spec `.claude/specs/01-monorepo-launcher.md`
R7).

## 3. Out of scope for the first version

- Alerts and notifications on thresholds.
- Exporting to spreadsheets or PDF.
- Writing data back to the sources.
- Forecasting.

## 4. Open questions

1. **Sources:** decided (R4).
2. **Storage of the analytics data:** read live from each source's store, or copy the metrics into the analytics store on
   a schedule? Live reads are simpler; copies are needed if the sources are on separate machines.
3. **Metrics list:** which metrics matter most? A starting list is needed before R2's panels can be designed.
4. **Access:** who may see the dashboard? (Probably the same roles the launcher uses for infrastructure.)
5. **Personal data:** do any metrics involve customer identities? If so, they must be aggregated, never shown per person.
