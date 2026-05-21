# issue-91 — Re-architect automations as first-class versioned projects

GitHub issue: [#91](https://github.com/srikanth235/centraid/issues/91)

Supersedes the #90 model-B migration. An automation is no longer a row
in a SQLite `automations` table driven by a prompt-only agent turn — it
is a first-class **project**: its own directory under `automationsDir`,
`automation.json` as the manifest, a generated `handler.js`, structurally
a sibling of an app project. The directory is the source of truth.

## Checklist

- [x] Commit 1 — runtime-core: automations as first-class projects
- [x] Commit 2 — agent-runtime: local handler execution path
- [x] Commit 3 — openclaw-plugin: cloud handler execution path
- [x] Commit 4 — builder-harness: automation scaffold
- [x] Commit 5 — desktop main: `automationsDir` setting + project IPC
- [x] Commit 6 — desktop renderer: Automations screen + preload + d.ts
- [x] Commit 7 — desktop renderer: new-automation creation sheet
- [x] Commit 8 — desktop: apps + automations as `projectsDir` subdirs

## What changed

### Commit 1 — runtime-core: automations as first-class projects

Moves the automation definition off SQLite and onto disk.

- **Manifest.** `AutomationManifest` is reshaped to the `automation.json`
  project shape — `name` / `version` / `description` / `enabled` join
  `prompt` / `trigger` / `requires`, plus a new `apps` association list.
  The pre-#90 `action` handler-reference field is gone: the handler is a
  single conventional `handler.js`. `isValidAutomationName` →
  `isValidAutomationId` (the directory slug).
- **Directory model.** New `automation-project.ts` is the read/write
  boundary over `<automationsDir>/<id>/` — `listAutomationProjects`,
  `readAutomationProject`, `writeAutomationManifest`,
  `setAutomationEnabled`, `deleteAutomationProject`. There is no SQLite
  definition store.
- **Handler runtime restored.** The JS-handler runtime #90 deleted is
  restored from `13ae3b5^` (`automation-handler-runner` /
  `-ctx` / `-audit`, `worker/automation-runner`) and re-adapted to the
  standalone-project model: runs are keyed by automation id, and there
  is **no app `db` proxy** — a standalone automation has no owning app,
  so `ctx` exposes `tool` / `agent` / `state` / `runs` / `invoke` only.
  Cross-run persistence is `ctx.state` (the `automation_state` KV).
- **Deletions.** The model-B `automation-store` (SQLite table + store)
  and `automation-agent-runner` are removed, as is `sync-automations`.
  `ACTIVITY_MIGRATIONS[0]` is edited in place (v0, no backfill) to drop
  the now-dead `automations` table; `InsightsStore` no longer joins it.

The unified `runs` / `run_nodes` ledger is unchanged — an automation
fire still records there.

### Commit 2 — agent-runtime: local handler execution path

Rewires the local desktop fire path onto the restored handler runtime.

- `runAutomationLocal` now reads the automation project from
  `automationsDir` (`readAutomationProject`) and runs its generated
  `handler.js` via `runAutomationHandler`, instead of driving an
  agent turn off the manifest prompt.
- Restores `run-automation-live-dispatch.ts` (the mock-LLM-server +
  CLI-spawn `ctx.tool` / `ctx.agent` dispatch) and the pre-#90
  `run-automation-cli-spawn.ts`, re-adapted to the standalone-project
  model — the CLI runs with the automation project dir as cwd, and the
  dispatch context carries the automation id.
- Deletes the model-B `run-automation-agent-dispatch.ts`.
- The `centraid run-automation` CLI verb reads `CENTRAID_AUTOMATIONS_DIR`
  (the OS scheduler bakes it into the launchd/systemd/Task Scheduler
  artifact alongside `CENTRAID_AUTOMATION_DB`).

`os-scheduler.ts` / `os-scheduler-host.ts` are unchanged — they already
key everything by automation id. agent-runtime build + 80 tests pass.

### Commit 3 — openclaw-plugin: cloud handler execution path

The openclaw counterpart of Commit 2.

- `runOpenclawFire` reads the automation project from an on-disk
  `automationsDir` (a sibling of the gateway's apps dir) and runs its
  `handler.js` via `runAutomationHandler`. `ctx.tool` routes through
  `callGatewayTool` (the harness MCP routing); `ctx.agent` through the
  user's real provider via the simple-completion runtime; `ctx.invoke`
  re-enters for a sibling automation id.
- `automations-provider.ts` / `index.ts` pass `automationsDir` through;
  the `gateway_start` reconcile diffs `listAutomationProjects` against
  openclaw's cron store instead of the dropped `automations` table.
- `automations-cron.ts` / `automation-host.ts` were already keyed by
  automation id — unchanged.

openclaw-plugin build + 21 tests pass.

### Commit 4 — builder-harness: automation scaffold

`scaffoldAutomationProject(automationsDir, id, opts)` writes the minimal
automation project layout — a validator-checked `automation.json`, a
starter `handler.js`, and a `versions/` dir — the sibling of
`scaffoldProject` for apps. The builder agent rewrites both files
during the build conversation. builder-harness build + tests pass.

### Commit 5 — desktop main: `automationsDir` setting + project IPC

- New `automationsDir` desktop setting (default `~/centraid-automations`,
  a sibling of `projectsDir`).
- The automation IPC handlers are rewritten over the on-disk project
  model: `AUTOMATIONS_LIST` / `READ` / `CREATE` (scaffold + host
  register) / `RUN_NOW` / `SET_ENABLED` (rewrite the manifest) /
  `DELETE` / `LIST_RUNS` (now accepts an optional `automationId` and
  filters to `kind:'automation'`) / `LIST_RUN_NODES` / `PIN_RUN`.
- `OsSchedulerHost` bakes `CENTRAID_AUTOMATIONS_DIR` into the scheduler
  artifact; `localRuntimeAutomationHost` takes the dir; the startup
  reconcile diffs `listAutomationProjects` instead of the SQLite store.

desktop main typecheck + build pass; the renderer side is still model-A
(updated in Commit 6).

### Commit 6 — desktop renderer: Automations screen + preload + d.ts

- `centraid-api.d.ts` + `preload.ts` migrated to the project-shaped
  automation API (`listAutomations()` / `readAutomation` /
  `createAutomation` / `runAutomationNow` / `setAutomationEnabled` /
  `deleteAutomation` / `listAutomationRuns` (optional `automationId`) /
  `listAutomationRunNodes` / `pinAutomationRun`). New types:
  `CentraidAutomationManifest`, reshaped `CentraidAutomationRow` /
  `RunRecord` / `RunNode` — both the module exports and the
  `declare global` mirror.
- The Automations screen drops the per-app grouping
  (`resolveAutomationApps` / `renderAutomationsGroupHead` / the per-app
  run fan-out): "Standing orders" is a flat user-owned list, "Executions"
  reads the global ledger, and the execution detail loses the app-icon
  lockup. `step` nodes + per-step cost render in the timeline.
- The per-app Settings → Automations tab and the builder's Cloud →
  Automations panel become a `manifest.apps` reverse lookup.

desktop typecheck + build pass.

### Commit 7 — desktop renderer: new-automation creation sheet

A "New automation" button on the Automations topbar opens a creation
sheet — name, a natural-language "what should it do?" prompt, and a
schedule (cron presets that translate intent → expression, plus a
custom-cron escape hatch). Submitting calls `createAutomation`, which
scaffolds the project (`automation.json` + a starter `handler.js`) and
registers its schedule; the screen refreshes to show it.

### Commit 8 — desktop: apps + automations as `projectsDir` subdirs

Replaces the separate top-level `automationsDir` setting with a single
workspace root. `projectsDir` is the persisted root; `appsDir`
(`<projectsDir>/apps`) and `automationsDir` (`<projectsDir>/automations`)
are derived on `DesktopSettings`. App-project IPC + the preview
protocol read `appsDir`; automation IPC + the startup reconcile read
the derived `automationsDir`. The builder-harness functions are
unchanged — they operate on whatever directory the caller passes.

## Out of scope

- A backfill that migrates pre-#91 automations out of the dropped
  `automations` SQLite table onto disk — this is a v0 cutover with no
  backfill, consistent with the #90 migration approach.
- Webhook / event triggers — `trigger` keeps the shape-room but only
  `cron` is wired.
- The fully conversational automation builder — a chat surface that
  reuses the builder-harness agent to iteratively rewrite `handler.js`
  with a live run-now pane — remains follow-up work. Commit 7 ships the
  creation sheet (intent prompt + schedule) that scaffolds the project;
  the agent-driven handler authoring loop is not wired yet.

## Verification

- Each commit was verified for its own package(s): runtime-core
  typecheck + 271 tests; agent-runtime build + 80 tests; openclaw-plugin
  build + 21 tests; builder-harness build + tests; desktop typecheck +
  build. The monorepo build is intentionally red between commits (no
  compatibility shims); the branch tip builds green end to end.
