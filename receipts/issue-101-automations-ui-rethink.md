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
- [x] Commit 3 — run viewer as chat thread
- [x] Commit 4 — overview redesign
- [x] Commit 5 — single-run read API

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

### Commit 3 — run viewer as chat thread

A `run-view` `ShellRoute` and `renderRunView` → `buildRunView` that
render a run as a conversation rather than an n8n step timeline. It
reads the automation, the run record, and its nodes in one `Promise.all`
(commit 5 swaps the run-record read for a dedicated single-run API).

The thread has three nodes on a connecting spine: a **trigger** message
(what fired it + the collapsible instructions prompt), a **work** message
(every run node folded into one collapsible group; each step expands to
its args/output JSON and any error — the n8n detail, tucked away), and a
**reply** message (the run summary + output JSON, or a failure box). A
side rail carries run detail, usage, and a link back to the automation;
"Hide details" collapses it.

Standing-order run rows (`renderAuRunRow`) become buttons that open the
thread, keyed by the run record's own `automationId`.

### Commit 4 — overview redesign

`renderAutomations` is rewritten from the two-tab (Executions / Standing
orders) shell into a single overview: a header with live/paused counts
and the templates + new-automation actions, then two columns — "Your
automations" (each row opens its viewer, with a status spine and a last-
run line) and "Recent runs" (the automation-fire stream, each row opens
its thread). An empty state replaces the list when no automations exist.

The dead `Executions`-tab code is removed: `renderAutomationsRunsInto`,
`renderAutomationsOrdersInto`, `automationsEmpty`, `renderExecutionRow`,
`renderExecutionDetail`, `buildExecutionDetail`, `renderExecPreview`,
`renderExecSteps`, `renderExecStep`, `loadExecChildSteps`, and the
`cd-automations-*` / `cd-exec-*` CSS (~820 lines). `collectAutomationRuns`
is kept and reused for the run stream. The standing-order rendering
(`renderAutomationsSection` / `renderStandingOrder` and its run/node
chain) stays — the app settings panel still uses it.

### Commit 5 — single-run read API

The run viewer originally rebuilt its run record by listing the central
run-summary feed (`listAutomationRuns`, limit 100) and `.find()`-ing the
matching `runId`. Two problems: the central summary row carries no
`inputJson` / `outputJson`, so the reply card's "Output" block never
rendered; and any run older than the 100 most recent resolved to "Run
not found."

A new `AUTOMATIONS_READ_RUN` IPC channel (`readAutomationRun`) reads one
run's full record straight from its own per-app `runtime.sqlite` ledger
via `AutomationRunsStore.getRun` — the same store the node timeline
already uses (`runsStoreForRunId`). That record carries the validated
`outputJson`. `renderRunView` now fetches `readAutomation`,
`readAutomationRun`, and `listAutomationRunNodes` in one `Promise.all`,
dropping the limited list-and-find entirely.

## Out of scope

- A backend template catalog — templates stay front-end seeds.
- A computed "next run" timestamp — no cron-projection API exists, so
  the hero shows the schedule + live status rather than a fake ETA.
- Continuing a run as a live conversation — there is no API to resume a
  finished run, so the thread is read-only (no composer).
- Standing-order rendering is left in place where the app settings panel
  reuses it.

## Verification

- Full monorepo `bun run typecheck` (16/16), `bun run build` (8/8), and
  `bun run test` (12/12) — all turbo tasks green. Format clean.
- The Electron UI was not interactively click-tested; the design was
  validated on a standalone HTML prototype before porting.
