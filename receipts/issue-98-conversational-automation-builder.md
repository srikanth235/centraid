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

## Out of scope

- Scheduling and execution of app-owned automations — the OS scheduler
  host + `centraid run-automation` CLI + cloud gateway. This commit
  lands only the *discovery* foundation; the runtime wiring is the
  tracked follow-up on the checklist above.
- Bidirectional form editing — the config pane is a read-only rendered
  view of the manifest; chat is the only input.
- Commit 3 reworks only the runtime-core discovery layer. Its consumers
  — builder-harness scaffold/publish, the openclaw-plugin gateway, the
  agent-runtime scheduler host + CLI, and the desktop IPC/renderer —
  still reference the deleted `automationsDir` API and are updated in
  the follow-on commits of this PR (4–6). The repo typechecks
  end-to-end only once commit 6 lands.

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
