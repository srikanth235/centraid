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
- [ ] Reconcile OS scheduler on publish/delete/rollback
- [ ] Desktop scaffold/clone/meta over HTTP
- [ ] Desktop automation CRUD over HTTP
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

## Verification

- `@centraid/builder-harness` typecheck + lint clean;
  `scaffold-files.test.ts` adds 15 cases (52 package tests pass).
- `@centraid/runtime-core` typecheck + lint clean;
  `automation-webhook.test.ts` adds 3 cases (343 package tests pass).
- `@centraid/gateway-runtime` typecheck + lint clean;
  `apps-store-routes.test.ts` adds the DELETE-file + path-escape cases;
  `automations-routes.test.ts` adds 8 cases (run-now invokes the stubbed
  `runAutomation`; list/read/runs/run/insights shapes). 36 package tests pass.

## Out of scope

Deferred to the agreed follow-up sequence:

- Migrating `@centraid/openclaw-plugin` and the standalone `gateway-runtime`
  daemon CLI onto `serve()` + `appsStoreRoot` (git store), then deleting
  the legacy `VersionStore` / `current.json` / `appCodeDir` machinery.
- Remote builds via the in-process codex/claude agent — `AGENT_*` stays
  local-only; remote gateways build through the chat surface.
- A batch file-write route (the desktop currently loops single PUTs).
