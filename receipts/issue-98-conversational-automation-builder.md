# issue-98 — Conversational automation builder + app-owned automations

GitHub issue: [#98](https://github.com/srikanth235/centraid/issues/98)

Supersedes #95. Replaces the form-based automation creation flow with a
chat-driven builder, and widens the definition of "app" from a UI bundle
to a **capability bundle** the builder can fill with automations as well
as UI.

## Checklist

- [x] Commit 1 — conversational automation builder + app-owned automations
- [x] Commit 2 — builder-minted webhook triggers

Unified folder model (the [#98 revision](https://github.com/srikanth235/centraid/issues/98) — every automation is an app):

- [x] Commit 3 — runtime-core: unified automation discovery
- [x] Commit 4 — builder-harness: automation apps scaffold + publish
- [x] Commit 5 — openclaw-plugin: gateway fires automations as apps
- [x] Commit 6 — agent-runtime: local fire path under appsDir
- [x] Commit 7 — desktop: unified app/automation surface
- [x] Commit 8 — runtime-core: per-app runtime.sqlite + central analytics

Follow-up (tracked on #98, not in this commit):

- [ ] Schedule/execute app-owned automations — OS scheduler host + the
      `centraid run-automation` CLI resolving under `appsDir`,
      `runAutomationLocal` resolution, cloud `openclaw-plugin` host.
- [ ] Sibling resolution (`onFailure` / `ctx.invoke`) scoped per app.
- [ ] OS scheduler job labels namespaced by `ownerApp` to stay unique
      across apps.

## What changed

### Commit 1 — conversational automation builder + app-owned automations

#### builder-harness — automation-aware system prompts

- New `AUTOMATION_APPEND_PROMPT` describes the first-class automation
  project layout (`automation.json` + `handler.js`), the manifest
  schema, and the guardrails — never self-enable, never mint webhook
  secrets. `createCentraidAgentSession` takes a `projectKind`
  (`'app' | 'automation'`) that selects the prompt and skips the app
  UI-grounding blocks for automations.
- `CENTRAID_APPEND_PROMPT`'s stale automations section (the pre-#91
  `automations/<name>.json` + `actions/<name>.js` model) is rewritten:
  an app is a capability bundle, the app builder recognizes trigger
  intent ("every morning", "remind me", "weekly"…) and authors
  `automations/<id>/automation.json` + `handler.js` *inside the app*,
  alongside the UI. An app may own several automations — distinct slug
  per automation; reuse a slug to revise, new slug to add.
- `scaffoldAutomationProject` takes an `enabled` option so the builder
  can scaffold a disabled draft.

#### runtime-core — discovery foundation for app-owned automations

- `AutomationRow` gains `ownerApp?` — set when an automation lives at
  `<appsDir>/<appId>/automations/<id>/` rather than as a standalone
  project under `automationsDir`. `dir` stays the authoritative path.
- `readAutomationProjectAt(dir, ownerApp?)` reads from an explicit
  directory; `readAutomationProject` delegates to it.
- `listAppOwnedAutomations(appsDir)` scans every app's `automations/`
  subdir; `listAllAutomationProjects` returns the standalone + app-owned
  union. `APP_AUTOMATIONS_SUBDIR` names the subdirectory.

#### desktop — automation builder mode

- `builder.ts` gains an automation mode (`projectKind: 'automation'`):
  the right pane becomes a read-only **Config** view rendered from
  `automation.json` (intent, schedule with a plain-English gloss +
  next-3 fire times computed by a small in-renderer cron evaluator,
  behavior, connected apps) plus a **Runs** test-fire pane. The publish
  button becomes a draft Enable/Disable gate. The manifest is the
  source of truth; the form is a rendered view, re-read after each
  agent turn — not an editor.
- The `agent:start` IPC threads `projectKind`, routing automation
  sessions to `automationsDir` and skipping the app-only live-schema /
  preview-snapshot steps. `createAutomation` accepts `enabled`.
- The Automations page "New automation" button scaffolds a disabled
  draft and opens the builder; the old `openNewAutomationSheet` form
  (and its `CRON_PRESETS` / `RETENTION_PRESETS` helpers) is removed.

### Commit 2 — builder-minted webhook triggers

The chat builder previously could not author webhook automations — the
prompts told the agent to avoid them, because minting a route id +
secret is a privileged step the LLM cannot do. This commit splits that
responsibility: the **agent declares** a webhook, the **builder mints**
it.

#### runtime-core — pending-webhook manifest form + provisioning pass

- New `PendingWebhookTrigger` (`{ kind: 'webhook', pending: true }`) —
  the handoff form the builder agent writes. `AutomationTrigger` is now
  `CronTrigger | WebhookTrigger | PendingWebhookTrigger`.
  `validateManifest` accepts the pending form; a webhook trigger with
  neither a minted `id`/`secretHash` nor `pending: true` is still
  rejected. `webhookTriggerOf` returns only *provisioned* webhooks (it
  guards on `'id' in t`); `pendingWebhookTriggerOf` /
  `isPendingWebhookTrigger` cover the pending form.
- `provisionPendingWebhookAt(dir, ownerApp?)` mints a crypto-random
  `id` + `secret`, rewrites the pending trigger to its provisioned
  shape, and persists the manifest — returning the plaintext secret
  once (`ProvisionedWebhook`). `provisionAppPendingWebhooks(appDir)`
  runs it across an app's `automations/` subdir.
  `writeAutomationManifestAt(dir, manifest)` is the by-directory write
  primitive `writeAutomationManifest` now delegates to.

#### desktop — post-turn provisioning + one-time secret surfacing

- The `agent:start` IPC's per-turn `prompt` wrapper runs a provisioning
  pass *after* `session.prompt` resolves: an automation project
  provisions itself, an app project scans its `automations/`. The
  `agent:prompt` IPC returns the minted webhooks; the builder renderer
  surfaces each as a one-time assistant message carrying the endpoint
  URL + plaintext secret (never persisted — the manifest keeps only the
  hash). The config pane renders a pending webhook as
  "provisioning…" until the next turn mints it.

#### builder-harness — prompts declare, not refuse

- Both `CENTRAID_APPEND_PROMPT` and `AUTOMATION_APPEND_PROMPT` now tell
  the agent to declare `{ "kind": "webhook", "pending": true }` when the
  user wants an inbound-HTTP trigger, and never to invent an `id` or
  `secretHash`.

### Commit 3 — runtime-core: unified automation discovery

First commit of the [#98 revision](https://github.com/srikanth235/centraid/issues/98)
big-bang refactor: the standalone-vs-app-owned automation duality is
collapsed. There is no `automationsDir` — every automation lives inside
an app folder, and the app folder is the unit of upload and versioning.

#### runtime-core — `automation-project.ts` rewrite

- `automationsDir`-based functions are deleted (`readAutomationProject`,
  `listAutomationProjects`, `listAppOwnedAutomations`,
  `listAllAutomationProjects`, `writeAutomationManifest`,
  `setAutomationEnabled`, `deleteAutomationProject`).
- `listAutomations(appsDir)` is the single discovery entry point. It
  scans every app folder, resolves each app's *active version* code dir
  via `readActiveCodeDir` (which falls back to the flat folder for an
  editable desktop draft), and reads every `<codeDir>/automations/<id>/`.
  One scan covers both the versioned gateway and the flat desktop draft.
- `AutomationRow.ownerApp` is now required (every automation is
  app-owned) and a `ref` field carries the `<appId>/<id>` handle.
- `readAppOwnedAutomation(appsDir, appId, id)` resolves one automation
  through the active version. `readAutomationProjectAt`,
  `writeAutomationManifestAt`, `setAutomationEnabledAt`, and
  `deleteAutomationAt` are the by-directory primitives;
  `automationManifestPath` / `automationHandlerPath` take a project dir.

#### runtime-core — automation identity module

- New `automation-ref.ts` holds the automation-identity surface:
  `isValidAutomationId` (moved here), `isValidAppId` (permits the
  `auto.` prefix's dot, excludes `_`-prefixed / path-unsafe ids), the
  `AutomationRef` type, and `formatAutomationRef` / `parseAutomationRef`
  / `isValidAutomationRef`. `manifest.onFailure` now validates against
  `isValidAutomationRef`, so a `<appId>/<id>` handle (or a bare sibling
  id) is accepted. The split also keeps `automation-manifest.ts` under
  the 500-line repo-hygiene limit.

#### runtime-core — webhook discovery

- `automation-webhook.ts`: `WebhookRouteOptions` takes `appsDir` (not
  `automationsDir`); the route handler resolves a slug via
  `listAutomations` against active versions. `WebhookFireFn` now
  receives an `automationRef` handle. `provisionPendingWebhookAt`'s
  `ownerApp` and `ProvisionedWebhook.ownerApp` are now required.

### Commit 4 — builder-harness: automation apps scaffold + publish

Second commit of the [#98 revision](https://github.com/srikanth235/centraid/issues/98):
the builder-harness scaffolds and publishes an automation as an app.

#### builder-harness — `scaffold-automation.ts` rewrite

- `scaffoldAutomationProject(appsDir, appId, opts)` now scaffolds a whole
  *automation app*: an `auto.`-prefixed app folder with an `app.json`
  plus a single automation under `automations/<autoId>/`
  (`automation.json` + `handler.js`). No root-level `automation.json`,
  no `versions/` at scaffold time.
- `validateAutomationAppId` enforces the `auto.` prefix (the listing-
  level kind hint); `AUTOMATION_APP_PREFIX` is exported.
  `opts.automationId` defaults to the app id with the prefix stripped,
  falling back to `main`.

#### builder-harness — app id grammar + publish excludes

- `scaffold.ts`'s `validateAppId` / `ID_RE` now permit dots so an
  automation app can carry the `auto.` prefix; a `..` sequence is still
  rejected.
- `publish.ts` adds `runtime.sqlite` to the upload-exclude set — the new
  per-app run ledger is runtime-managed and never shipped.

#### builder-harness — prompts for the unified model

- `AUTOMATION_APPEND_PROMPT` describes the automation-app layout
  (`app.json` + `automations/<id>/automation.json` + `handler.js`),
  tells the agent to leave `app.json` alone, and lists `runtime.sqlite`
  among the never-create files. `CENTRAID_APPEND_PROMPT` adds
  `runtime.sqlite` to its never-create list.

### Commit 5 — openclaw-plugin: gateway fires automations as apps

Third commit of the [#98 revision](https://github.com/srikanth235/centraid/issues/98):
the gateway resolves and fires automations by their `<appId>/<id>`
handle, reading the owning app's active version. The separate
`centraid-automations` directory is gone.

#### openclaw-plugin — fire by handle, off the active version

- `runOpenclawFire` takes an `automationRef` + `appsDir` (was
  `automationId` + `automationsDir`). It parses the handle and resolves
  the automation via `readAppOwnedAutomation`, which reads the owning
  app's *active version*. `ctx.invoke` and `onFailure` resolve a handle
  (a bare id resolves within the calling automation's app).
- `automations-provider.ts` — the cron StreamFn's `<<<centraid:…>>>`
  sentinel now carries the `<appId>/<id>` handle; the provider resolves
  under `appsDir`.

#### openclaw-plugin — cron names + discovery

- `automations-cron.ts` names every cron job `centraid:<appId>/<id>`
  (was `centraid:<id>`) — unique across apps. `automation-host.ts`'s
  `unregister` takes the handle.
- `index.ts` drops the `centraid-automations` directory; the
  `gateway_start` reconcile and the `/_centraid-hook` webhook route both
  resolve automations via `listAutomations(appsDir)`.

### Commit 6 — agent-runtime: local fire path under appsDir

Fourth commit of the [#98 revision](https://github.com/srikanth235/centraid/issues/98):
the desktop's OS scheduler + the `centraid run-automation` CLI fire
automations by their handle, resolved under `appsDir`.

#### agent-runtime — fire by handle

- `runAutomationLocal` takes an `automationRef` + `appsDir` and resolves
  via `readAppOwnedAutomation`; `onFailure` resolves a handle.
  `AutomationRunRecord.automationId` becomes `automationRef`.
- `centraid-cli.ts` — `run-automation <appId>/<automationId>`; the OS
  scheduler env var is `CENTRAID_APPS_DIR` (was `CENTRAID_AUTOMATIONS_DIR`).

#### agent-runtime — OS scheduler job labels

- `os-scheduler.ts` gains the reversible `automationSlug` /
  `automationRefFromSlug` codec: a handle's `/` (unsafe in a launchd
  label / artifact filename) maps to `_s`, `_` escapes to `_u`. Job
  labels are `com.centraid.<slug>`, unique across apps; `list()` decodes
  the slug back to the handle so reconcile round-trips.
- `os-scheduler-host.ts` bakes `row.ref` into the spec and
  `CENTRAID_APPS_DIR` into the artifact env.

### Commit 7 — desktop: unified app/automation surface

Final commit of the [#98 revision](https://github.com/srikanth235/centraid/issues/98):
the desktop resolves every automation under `appsDir`, and the whole
repo typechecks + builds + tests end-to-end.

#### desktop — settings + local runtime

- `settings.ts` drops the derived `automationsDir` — every project
  (UI app or automation app) lives under `appsDir`.
- `local-runtime.ts`: `localRuntimeAutomationHost(appsDir)` and the
  startup OS-scheduler reconcile use `listAutomations(appsDir)`.

#### desktop — IPC

- `ipc.ts`: the `AUTOMATIONS_*` handlers resolve automations by their
  `<appId>/<id>` handle under `appsDir` — `listAutomations`,
  `readAppOwnedAutomation`, `runAutomationLocal({ automationRef })`,
  `setAutomationEnabledAt`. `AUTOMATIONS_CREATE` scaffolds an `auto.`-
  prefixed automation app; `AUTOMATIONS_DELETE` removes the whole app
  folder for an `auto.` app, or just the `automations/<id>/` subdir for
  a UI-app-owned automation. `agent:start` routes every project under
  `appsDir`; the post-turn webhook provisioning always scans the
  project's `automations/`.

#### desktop — renderer

- `centraid-api.d.ts`: `CentraidAutomationRow` gains `ownerApp` + `ref`;
  an `automationId` IPC argument is documented as the `<appId>/<id>`
  handle. `CentraidMintedWebhook.ownerApp` is now required.
- `builder.ts` / `app.ts`: every automation IPC call passes `row.ref`.
  The automation builder resolves its app folder id to the owned
  automation via `listAutomations`; "New automation" scaffolds an
  `auto.`-prefixed app.

### Commit 8 — runtime-core: per-app runtime.sqlite + central analytics

Decisions 3 + 4 of the [#98 revision](https://github.com/srikanth235/centraid/issues/98):
the automation run ledger goes per-app, and analytics is push-based.

#### runtime-core — per-app `runtime.sqlite`

- `gateway-db.ts` gains `RUNTIME_MIGRATIONS` + `makeRuntimeDbProvider` /
  `openRuntimeDb`. An app's automation run ledger (`runs` / `run_nodes`
  / `automation_state`) is its own `<appRoot>/runtime.sqlite` — a
  separate file from the handler-owned `data.sqlite`. The schema drops
  `chat_sessions` and the `parent_run_id` / `chat_session_id` foreign
  keys (a cross-app `ctx.invoke` sub-run's `parent_run_id` points into
  a different app's file — a SQLite FK cannot span files).

#### runtime-core — central analytics DB

- New `analytics-store.ts`: `AnalyticsStore` over
  `centraid-analytics.sqlite` (`ANALYTICS_MIGRATIONS` +
  `makeAnalyticsDbProvider`). One `run_summary` row per run, every kind.
  `recordRunSummary` upserts; `listSummaries` / `getSummary` read.
- `AutomationRunsStore` takes an optional `AnalyticsStore`; `finishRun`
  write-throughs the finished run's summary (with its dominant model)
  best-effort — an analytics-DB failure never fails the run.
  `ChatHistoryStore` threads the analytics store into its internal runs
  store, so chat turns get a summary too.
- `InsightsStore` now reads only the central `run_summary` table — one
  source, no `run_nodes` descent; the by-model breakdown keys off each
  run's dominant model.

## Out of scope

- Scheduling and execution of app-owned automations — the OS scheduler
  host + `centraid run-automation` CLI + cloud gateway. This commit
  lands only the *discovery* foundation; the runtime wiring is the
  tracked follow-up on the checklist above.
- Bidirectional form editing — the config pane is a read-only rendered
  view of the manifest; chat is the only input.
- Commits 3–7 of the #98 revision land the unified folder model
  incrementally, one package per commit; commits 8–10 land decisions
  3 + 4 (per-app `runtime.sqlite` + push-based analytics). Each commit
  leaves its own package green; the repo typechecks + builds + tests
  end-to-end at commits 7 and 10.
- Decision 3's per-app `runtime.sqlite` ledger and decision 4's central
  analytics DB land in commits 8–10. Commit 8 builds the runtime-core
  layer (schema + `AnalyticsStore` + write-through + `InsightsStore`
  rewrite); commits 9–10 wire the fire paths + desktop to it.
- Desktop "fire the active version" (decision 2) is realized on the
  gateway (commit 5 resolves versioned apps); the desktop's local OS
  scheduler still fires the editable draft folder via
  `CENTRAID_APPS_DIR = <projectsDir>/apps` — `readActiveCodeDir` falls
  back to the flat draft. Wiring the desktop to publish into its own
  local runtime is a follow-up.

## Verification

- `typecheck` green across the runtime-core / builder-harness /
  openclaw-plugin / agent-runtime / desktop chain (15/15 turbo tasks).
  `build` for the desktop chain green. Lint (`oxlint`) + format
  (`oxfmt`) clean across all changed files.
- runtime-core `automation-manifest` tests — 23/23 pass, including new
  cases for the pending webhook form and the
  neither-provisioned-nor-pending rejection. `automation-project`
  tests — 6/6 pass.
- The worktree had no `node_modules`; a worktree-local `bun install`
  was run so cross-package imports resolve to the worktree's own
  sources rather than the parent checkout's stale builds.
- The Electron builder UI was not interactively click-tested — the
  automation builder mode, chat→config-pane sync, test-fire, the Enable
  gate, and the webhook-secret one-time chat message are
  type/build-verified only.

### Commit 3 verification

- `runtime-core` typechecks clean (`tsc --noEmit`).
- `runtime-core` full test suite — 283/283 pass, including the rewritten
  `automation-project` tests (7 — flat draft + versioned-app discovery,
  the `<appId>/<id>` handle, by-dir mutators) and new
  `automation-manifest` ref-helper tests (`isValidAppId`, the
  `formatAutomationRef` / `parseAutomationRef` / `isValidAutomationRef`
  round-trip).
- Downstream packages do not yet typecheck — expected; see Out of scope.

### Commit 4 verification

- `builder-harness` typechecks clean against the rebuilt `runtime-core`.
- `builder-harness` test suite — 10/10 pass, including the rewritten
  `scaffoldAutomationProject` tests (app-folder layout, derived vs
  explicit automation id, `auto.`-prefix enforcement, duplicate
  rejection).
- The openclaw-plugin / agent-runtime / desktop packages still
  reference the old discovery + scaffold APIs — updated in commits 5–6.

### Commit 5 verification

- `openclaw-plugin` typechecks clean against the rebuilt `runtime-core`.
- `openclaw-plugin` test suite — 21/21 pass.
- The agent-runtime local fire path and the desktop still reference the
  old discovery API — updated in the remaining commits.

### Commit 6 verification

- `agent-runtime` typechecks clean against the rebuilt `runtime-core`.
- `agent-runtime` test suite — 84/84 pass, including the rewritten
  `OsSchedulerHost` tests (handle-based job labels, `list()` decoding)
  and a new round-trip test for the `automationSlug` codec.
- Only the desktop still references the old discovery API — commit 7.

### Commit 7 verification

- Whole repo green end-to-end: `turbo typecheck` 16/16, `turbo test`
  12/12, `turbo build` 8/8. Lint (`oxlint`) + format (`oxfmt`) clean
  across every changed file.
- The Electron automation surface — the builder's automation mode, the
  Automations page (Standing orders + Executions), "New automation",
  Run-now, Enable/Disable, per-automation Runs — was not interactively
  click-tested; it is type/build-verified only.

### Commit 8 verification

- `runtime-core` typechecks clean; full suite 287/287 pass.
- New `analytics-store` tests (record / upsert / scoped list) + the
  rewritten `insights-store` tests, which now exercise the write-through
  end-to-end: an `AutomationRunsStore` built with an `AnalyticsStore`
  populates `run_summary`, and `InsightsStore` reads it back.
- The fire paths (openclaw / agent-runtime) and the desktop still
  construct the ledger over the global activity DB — wired to the
  per-app `runtime.sqlite` + analytics DB in commits 9–10.
