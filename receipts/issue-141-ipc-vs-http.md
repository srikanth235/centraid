# issue-141 — IPC vs HTTP: full remote-gateway support

GitHub issue: [#141](https://github.com/srikanth235/centraid/issues/141)

The desktop talks to the runtime over two channels: Electron IPC
(`centraid:*`, the privileged renderer↔main control plane) and the
gateway's HTTP server (the runtime/data plane reachable by any
non-renderer caller). Issue #141 sets that principle, audits the split,
and documents it.

This PR goes further: make **connecting to a remote gateway actually
work**. Several desktop operations previously ran only against the local
embedded gateway and threw for remote because they read/wrote the
git-store worktree or local SQLite directly. They now go over the
existing (and a few new) HTTP routes, so every renderer→runtime
operation works identically against local or remote gateways while
genuinely Electron-native operations stay on IPC.

v0 pre-release: no backward compatibility, no migrations.

## Checklist

- [x] Builder-harness file-map scaffolders
- [x] Webhook provisioning over a file map
- [x] Session file-delete route + shared route-helpers
- [x] Automation + insights HTTP routes
- [x] Reconcile OS scheduler on publish/delete/rollback
- [x] Desktop scaffold/clone/meta over HTTP
- [x] Desktop automation CRUD over HTTP
- [ ] Desktop automation read/run/analytics over HTTP
- [ ] PROJECTS_OPEN + AGENT_* gated as the only local-only handlers
- [ ] IPC-vs-HTTP concept doc + token audit

## What changed

**Builder-harness file-map scaffolders.** The scaffold / clone / rename /
automation flows can no longer assume a local workspace directory — for a
remote gateway the desktop has no filesystem access to the worktree. Added
filesystem-free `*Files` variants that emit a `{path, content}[]` map the
caller PUTs into a git-store session and publishes over HTTP:
`scaffoldProjectFiles` / `updateProjectMetaFiles` / `appPackageJson` (new
`packages/builder-harness/src/scaffold-files.ts`, with the content
templates moved out of `scaffold.ts`); `cloneTemplateFiles`
(`clone.ts`); `scaffoldAutomationProjectFiles` /
`setAutomationEnabledInFiles` / `deleteAutomationFromFiles`
(`scaffold-automation.ts`). The existing dir-writing helpers now wrap the
pure variants, and `project-rewrites.ts` exposes pure `rewriteTitleInHtml`
/ `applyManifestName` shared by both paths.

**Webhook provisioning over a file map.** `provisionAppPendingWebhooks`
read/rewrote `automation.json` on disk, so it couldn't run for a remote
gateway. Added `provisionPendingWebhooksInFiles(files, ownerApp)` in
`packages/runtime-core/src/automation-webhook.ts`: it scans a draft file
map for pending webhook triggers, mints the route id + secret
desktop-side (crypto), rewrites each trigger to its provisioned
`{kind,id,secretHash}` form, and returns the updated map plus the minted
secrets to show once. Only the hash reaches the gateway.

**Session file-delete route + shared route-helpers.** App-owned automation
delete needs to remove files from a session worktree over HTTP, which the
git-store surface couldn't do (it had GET/PUT files only). Added
`DELETE /centraid/_apps/<appId>/files/<path>?sessionId=` to
`apps-store-routes.ts` `handleFiles` (same path-escape guard as PUT), and
extracted the shared `sendJson` / `readBody` / `readJson` / `fileExists`
HTTP helpers into `packages/gateway-runtime/src/route-helpers.ts` so the
new automations routes can reuse them.

**Automation + insights HTTP routes.** New
`packages/gateway-runtime/src/automations-routes.ts`
(`makeAutomationsRouteHandler`) mounted as a second `extraHandlers` entry
in `serve()`. Serves the automation runtime ops the desktop used to do
against local files/SQLite: `GET /centraid/_automations` (list),
`/read`, `POST /run-now` (fires on the gateway host via an injected
`runAutomationLocal` closure with the gateway's own runner), the run feed
`/runs` + per-run `/run`, `/run/nodes`, `/run/pin`, and
`GET /centraid/_insights/summary`. Code resolves from the materialized
`main`; run ledgers + analytics from the stable `appsDir`. Refs/run ids
ride query params to avoid slash-in-path parsing.

**Reconcile OS scheduler on publish/delete/rollback.** `serve()`'s
`onAppLive` / `onAppDeleted` previously only touched the registry, so a
publish over HTTP never updated the OS scheduler (only a startup reconcile
ran). Added a coalesced, fire-and-forget `reconcileScheduler()` that
re-scans `active-main/apps` and reconciles the full desired set via the
existing `schedulerHostFactory`; it now runs on publish, delete, and
rollback (rollback already calls `onAppLive`) as well as at startup. This
lets the desktop drop its direct scheduler register/unregister calls (next
commit) and makes a remote gateway reconcile its own scheduler. Also fixed
`@centraid/apps-store`'s `SAFE_ID_RE` to allow the `auto.` dot (rejecting
`..`), without which automation-app publish through the git store failed.
(That dot allowance was later removed under issue #98 when the `auto.`
prefix convention was replaced by `app.json#kind` — app ids are plain
slugs again.)

**Desktop scaffold/clone/meta over HTTP.** The three project-lifecycle IPC
handlers that still computed a local worktree path now go entirely over
the git-store HTTP surface, so they work against a remote gateway:
- `PROJECTS_CREATE` builds the file map with `scaffoldProjectFiles`,
  rejects an id already on `main`, then `ensureProjectSession` →
  `writeDraftFiles` → `publishApp`.
- `PROJECTS_UPDATE_META` reads the app's draft over HTTP, applies the
  `{name,description}` patch with `updateProjectMetaFiles` (duplicate-name
  guard checks the published apps list), and writes back only the changed
  files.
- `TEMPLATES_CLONE` reads the desktop-bundled template's files via a new
  `readTemplateFiles` (`@centraid/app-templates`), rewrites them with
  `cloneTemplateFiles`, provisions pending webhooks with
  `provisionPendingWebhooksInFiles` (secret minted desktop-side, only the
  hash published), then PUTs + publishes. The remote gateway never needs
  the catalog.
All three drop `ensureProjectSessionAppsParent`; the local-worktree
helpers (`ensureProjectSessionDir`/`…AppsParent`) now survive only for the
genuinely-local PROJECTS_OPEN + AGENT_* paths (gated in a later commit).
A new `writeDraftFiles` batch helper (`apps-store-client.ts`) loops the
single-file PUT, and `httpProjectInfo` synthesizes the `ProjectInfo`
return (no local dir to stat — the canonical metadata flows back through
`listProjects()`).

**Desktop automation CRUD over HTTP.** The three automation-mutation IPC
handlers move off the local worktree onto the git-store HTTP surface, and
the desktop stops touching the OS scheduler directly:
- `AUTOMATIONS_CREATE` builds the file map with
  `scaffoldAutomationProjectFiles`, rejects an id already on `main`, mints
  webhook secrets desktop-side (hash only published), then session-PUT +
  publish. (The created `row` is still read back from the local
  materialized tree until C8 moves automation reads over HTTP.)
- `AUTOMATIONS_SET_ENABLED` reads the app's draft over HTTP, flips the flag
  via `setAutomationEnabledInFiles`, writes back only the changed manifest,
  and publishes.
- `AUTOMATIONS_DELETE`'s app-owned branch reads the draft, computes the
  removed paths with `deleteAutomationFromFiles`, DELETEs them through the
  session file-delete route (new `deleteDraftFiles` client helper), and
  republishes; the whole-automation-app branch already used the HTTP app
  delete.
All four direct `localRuntimeAutomationHost(...).register/unregister` calls
(create, set-enabled, delete, and the template-clone post-publish block)
are removed — the local gateway's `serve()` is wired with
`schedulerHostFactory`, so its `onAppLive`/`onAppDeleted` reconcile the
scheduler on publish/delete (C5); a remote gateway reconciles its own.
Drops the now-unused `ensureProjectSessionAppsParent`,
`localRuntimeAutomationHost`, `APP_AUTOMATIONS_SUBDIR`,
`readAutomationProjectAt`, `setAutomationEnabledAt`, `deleteAutomationAt`
imports from `ipc.ts`.

## Verification

- `@centraid/builder-harness` typecheck + lint clean;
  `scaffold-files.test.ts` adds 15 cases (52 package tests pass).
- `@centraid/runtime-core` typecheck + lint clean;
  `automation-webhook.test.ts` adds 3 cases (343 package tests pass).
- `@centraid/gateway-runtime` typecheck + lint clean;
  `apps-store-routes.test.ts` adds the DELETE-file + path-escape cases;
  `automations-routes.test.ts` adds 8 cases (run-now invokes the stubbed
  `runAutomation`; list/read/runs/run/insights shapes);
  `serve-scheduler-reconcile.test.ts` asserts a publish triggers a
  reconcile carrying the scanned rows.
- `@centraid/apps-store` adds an `auto.`-id publish + `..`-rejection case.
- Desktop scaffold/clone/meta: full `turbo run build typecheck lint test`
  green across all 28 tasks; `@centraid/desktop` typechecks + builds with
  the rewritten handlers. New `clone-over-http.test.ts` (gateway-runtime)
  boots a real git-store gateway and drives the desktop's exact clone wire
  path — `cloneTemplateFiles` → `provisionPendingWebhooksInFiles` → session
  PUT → publish — asserting the app lands on `main` with a plain-slug id,
  `kind: 'automation'`, and a provisioned webhook (hashed secret, no
  plaintext, no `pending`). The component pieces (file-map scaffolders,
  webhook provisioning, session PUT/publish) keep their own unit coverage.
- Desktop automation CRUD: full suite green; new
  `automation-lifecycle-over-http.test.ts` (gateway-runtime) drives the
  toggle + app-owned-delete wire paths end to end against a real gateway —
  toggling `enabled` republishes the manifest, and deleting the subdir via
  the file-DELETE route + republish removes the automation while the owning
  app survives on `main`.

## Out of scope

Deferred to the agreed follow-up sequence:

- Migrating `@centraid/openclaw-plugin` and the standalone `gateway-runtime`
  daemon CLI onto `serve()` + `appsStoreRoot` (git store), then deleting
  the legacy `VersionStore` / `current.json` / `appCodeDir` machinery.
- Remote builds via the in-process codex/claude agent — `AGENT_*` stays
  local-only; remote gateways build through the chat surface.
- A batch file-write route (the desktop currently loops single PUTs).
