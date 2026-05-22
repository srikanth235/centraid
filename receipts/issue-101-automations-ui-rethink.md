# issue-101 — Automations UI rethink: templates, automation viewer, run-as-thread, overview

GitHub issue: [#101](https://github.com/srikanth235/centraid/issues/101)

Rethinks the Automations surface around one simplifying idea: **a run is
just a chat thread, and an automation is a saved conversation that fires
on a trigger.** This collapses the two-tab shell (Executions + Standing
orders) and the n8n-style step-timeline run viewer into a calmer,
conversation-native model. Approved off a standalone prototype.

## Checklist

- [x] Commit 1 — templates gallery
- [x] Commit 2 — automation viewer
- [ ] Commit 3 — run viewer as chat thread
- [ ] Commit 4 — overview redesign

## What changed

### Commit 1 — templates gallery

A `templates` `ShellRoute` and gallery page. Automations have no backend
template concept — a template is a front-end seed (`AutomationTemplate`:
emoji, name, category, description, trigger, integrations, prompt). Ten
templates span four categories (Daily rhythm, Inbox & comms, Engineering,
Reliability).

Adopting a template (`adoptTemplate`) scaffolds a *disabled* automation
via `createAutomation` with the template's prompt + triggers, then opens
the conversational builder so the user reviews before enabling — the same
hand-off `createAndOpenAutomationBuilder` already uses.

The Automations topbar gains a "Browse templates" button beside "New
automation". Cards are `cd-au-*`-prefixed so the new CSS coexists with
the legacy `cd-exec-*` / `cd-app-order-*` rules during the migration.

### Commit 2 — automation viewer

An `automation-view` `ShellRoute` and a per-automation detail page
(`renderAutomationView` → `buildAutomationView`), reached by clicking a
standing-order card's name. It reads the automation + its last 40 runs
in one `Promise.all`.

Layout: breadcrumb + title with a live/paused status pill; a trigger
hero that renders the schedule as a sentence (`triggersSummary` /
`cronToHuman`) with the raw cron expr / webhook endpoint in mono, plus an
enable/disable switch wired to `setAutomationEnabled`; an Instructions
card showing `manifest.prompt`; a Runs card with All/Scheduled/Manual/
Webhook filter chips; and a side rail — About (owner, model, linked
apps, MCPs) and Lifetime KPIs (runs, success rate, avg time, total cost)
derived from the run records.

Run rows are display-only here; commit 3 makes each one open as a thread.

## Out of scope

- A backend template catalog — templates stay front-end seeds.
- A computed "next run" timestamp — no cron-projection API exists, so
  the hero shows the schedule + live status rather than a fake ETA.
- Standing-order rendering is left in place where the app settings panel
  reuses it.

## Verification

- `bun run typecheck` + `bun run build` — full monorepo turbo tasks
  green. Lint + format clean.
- The Electron UI was not interactively click-tested; the design was
  validated on a standalone HTML prototype before porting.
