# Product: nooblyjs-accelerator-analytics

Status: **not started.** The folder holds a `package.json`, its lockfile and placeholder scripts. No source code, tests or
README yet.

## What it is

An **analytics screen**: a dashboard where a user tracks metrics and reads them on a rich, interactive dashboard. It is
the place to see how the other accelerators are performing.

The user decided this on 2026-11-13. It answers the earlier question about shape: the accelerator is a screen, not only a
library. It follows the pattern of the infrastructure accelerator (Noobly Cloud), which is a screen module the launcher
mounts into its frame.

## Who uses it

Operators and owners who want to see metrics, not write code. Developers integrate it, but the primary user is the person
reading the dashboard.

## What it shows (to be confirmed)

Metrics are read from the other NooblyJS applications. Candidate sources, from the existing accelerators:

- Commerce: orders, sales, stock moves, deliveries.
- Customers: customers created, consent state, campaign sends, engagement (opens, clicks, unsubscribes).
- Infrastructure: VM and operation counts, cost estimate, activity.

The set of metrics and the source of each is an open decision (see `.claude/specs/initial-scope.md`).

## Design rules (proposed)

- Charts and KPI tiles use the dataviz conventions (one palette, readable in light and dark, values formatted consistently).
- Every number on the screen comes from a stored record or a query, never a hard-coded total.
- Each panel says when its data was last updated.
- Works on phone width (16px gutter, no horizontal page scroll).
