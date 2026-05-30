# issue-137 — Model app code as a gateway-owned git store

GitHub issue: [#137](https://github.com/srikanth235/centraid/issues/137)

Replace the desktop-owned workspace + tarball-upload publish pipeline
with a single bare git repo owned by the gateway. Worktrees are the
editing/serving primitive: per-session worktrees for agent edits,
exactly one materialized-`main` worktree the runtime reads from, and
forward-only commits + per-app tags for the version-history surface.
Export/import to the user's GitHub falls out as `push`/`clone`.

This is a multi-slice refactor. This receipt covers **slice 1**: the
foundational `@centraid/apps-store` package. Subsequent slices are
listed under [Out of scope](#out-of-scope) with the file lists they
will touch.

## Checklist

- [x] Slice 1 — `@centraid/apps-store` foundation package
  - [x] Package scaffold + workspace wiring
  - [x] Git CLI wrapper
  - [x] AppsStore class
  - [x] Unit tests
  - [x] Workspace checks green
- [x] Slice 5 — GitHub export/import
  - [x] Export push and import clone
  - [x] listApps and bareRepoDir surface
- [x] Slice 2 — gateway wiring + runtime read-path swap
  - [x] Code-dir resolver seam
  - [x] Gateway constructs the apps-store
  - [x] Git-store serve integration test
- [x] Slice 3 — publish endpoint replaces tarball upload
  - [x] extraHandlers seam on the runtime HTTP server
  - [x] Apps-store route module
  - [x] Gateway-side manifest validation
  - [x] Publish/session HTTP test
- [x] Slice 4 — desktop Code tab cutover
  - [x] Apps-store HTTP client + per-project session manager
  - [x] Code tab reads/writes through the gateway session
  - [x] Explicit Publish replaces auto-publish-on-save for the Code tab
  - [x] Versions UI reads from git tags
  - [x] Gateway-swap drops cached sessions
- [x] Slice 4b — projects + agent flows off workspaceDir
  - [x] AppsStore.deleteApp + listAppsWithMeta
  - [x] Gateway routes for app list + delete
  - [x] PROJECTS_* IPC cut over
  - [x] AGENT_START writes directly into the session worktree
  - [x] publish-on-save.ts retired
- [x] Slice 4c — templates + automations off workspaceDir (full cutover)
  - [x] AppsStore stable `active-main` symlink (`getActiveMainLink`)
  - [x] Code/data split in run-automation (CLI + host `codeAppsDir`)
  - [x] serve() scans + bakes the stable code path
  - [x] TEMPLATES_CLONE + AUTOMATIONS_* IPC cut over
  - [x] codeDir fallback removed; workspaceDir deleted
- [x] Review fixes (PR #138)
  - [x] App delete tears down the per-app data dir, not just the git-store code
  - [x] Whole automation-app delete deregisters and cleans data instead of re-registering it
  - [x] Unified chat resolves the manifest catalog via the git-store code-dir override

## What changed

### Slice 1 — `@centraid/apps-store` foundation package

**Package scaffold + workspace wiring.** New package at
`packages/apps-store/` with `package.json` (typedef-only deps:
`@centraid/tsconfig`, `tsx`, `typescript`; no runtime deps),
`tsconfig.json` matching the gateway-runtime shape, and a re-export
barrel at `src/index.ts`. The workspace globs in the root
`package.json` already pick up `packages/*`, so `bun install` wires
the package into the monorepo automatically.

**Git CLI wrapper.** `src/git.ts` is a thin promisified wrapper around
the system `git` binary. One `run()` / `runRaw()` entry point that
spawns `git -C <cwd> <args>` with stdin/stdout/stderr buffered and a
scrubbed environment that pins the agent identity
(`Centraid Agent <bot@centraid>` — per the issue's "Commit
authorship" decision) and disables every interactive prompt
(`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`, `GIT_EDITOR=true`).
Non-zero exits throw `GitError(args, code, stdout, stderr)`; callers
that expect a non-zero exit (a `revParse` probe for a missing ref,
for instance) pass `allowNonZero` and inspect the result directly.

**AppsStore class.** `src/apps-store.ts` is the public surface — the
on-disk layout the issue's "Gateway-local state" section sketches:

```
<gatewayDir>/
  apps.git/              ← bare repo (the thing pushed to GitHub)
  worktrees/
    main/<sha>/          ← read-only materialization, swapped on publish
    sessions/<id>/       ← per-session mutable editing
```

The full git surface used is: `init --bare`, `commit-tree`,
`update-ref`, `worktree add`, `worktree remove`, `worktree prune`,
`add`, `commit`, `tag`, `rebase`, `rev-parse`, `merge-base`,
`for-each-ref`, `checkout`, `log`, `branch -D`. Embedded Electron
already ships git; the standalone daemon can document the git
binary requirement or swap to `isomorphic-git` later if it matters.

Public API:

- `init()` — `git init --bare apps.git/`, plant an empty `main`
  branch via an initial empty commit (so worktrees can branch from
  it), materialize `worktrees/main/<sha>/`.
- `openSession(sessionId)` — `git worktree add worktrees/sessions/<id>
  -b sessions/<id> main`. Returns the worktree path the agent + UI
  read/write through.
- `closeSession(sessionId)` — `git worktree remove --force` +
  `git branch -D sessions/<id>`. Idempotent.
- `listSessions()` — returns active session ids. Used by gateway
  bootstrap to prune orphaned worktrees on restart.
- `publish({ sessionId, appId, message })` — path-scoped commit
  (`git add apps/<appId>/` then `commit`), tag `<appId>/v<n>` where
  `n` is one greater than the highest existing tag for that app,
  fast-forward `main` (under a per-store mutex; rebase + retry if
  `main` advanced), materialize `worktrees/main/<sha-new>/`, repoint
  the active-main pointer, schedule deletion of the previous
  materialization. Returns `{ versionTag, sha, materializedDir }`.
- `rollback({ appId, versionTag })` — forward-only:
  `git checkout <tag> -- apps/<appId>/` on a temp worktree, commit
  the overlay onto `main` with message `rollback: <appId> -> <tag>`,
  *without* a new tag (tags are reserved for forward publishes;
  `git log main` stays a chronological audit of everything live).
- `listVersions(appId)` — walks `refs/tags/<appId>/v*`, returns
  `{ tag, sha, uploadedAt }` sorted newest-first.
- `resolveActiveAppDir(appId)` — `<materializedMainDir>/apps/<appId>/`
  if it exists, else `undefined`. This is the call the runtime will
  use to load handlers.
- `getActiveMainDir()` — the currently-active materialization root,
  for the static-server and other surfaces that want the whole tree.
- `snapshotSessionAppDir(sessionId, appId)` — convenience: absolute
  path to `apps/<appId>/` inside a session worktree, mkdir'd if
  missing. Used by the agent's `writeProjectFile`.

Per-store mutex on publish — the issue's "concurrent publish" decision:
two sessions publishing different apps still serialize the
merge-into-main step so the fast-forward stays correct. Different
*apps store* instances (different gateways) run independently.

Atomic main-worktree swap — the issue's "GC is a swap, not a sweep"
section: each publish materializes a fresh `worktrees/main/<sha>/`,
flips the in-memory active pointer, then `rm -rf`s the previous
materialization. Fresh-path-per-publish means `require()` cache lines
naturally rotate (the runtime's `require()` is keyed on absolute
path), no manual invalidation needed. At any instant at most two
materializations exist (outgoing draining + incoming).

**Unit tests.** `src/apps-store.test.ts` uses `tsx --test` (matches
the rest of the repo) against a per-test tempdir. Each test
constructs a fresh `AppsStore` at `os.tmpdir()/apps-store-*/`,
exercises the public surface, and `rm -rf`s on teardown. Coverage:

- `init` is idempotent; second call reuses bare repo and existing
  materialization.
- `openSession` creates a worktree branched off main; multiple
  sessions coexist independently.
- `closeSession` removes the worktree + branch; idempotent on a
  vanished session id.
- `publish` of a brand-new app creates `<appId>/v1`, materializes a
  new main worktree, the previous one is removed, `resolveActiveAppDir`
  returns the new path.
- `publish` of an existing app increments to `<appId>/v2`.
- `publish` is path-scoped: a session that edits two apps but
  publishes only one leaves the other's edits in the session
  worktree.
- Concurrent publishes against the same store serialize (two parallel
  `publish()` calls both succeed, second one rebases on top of the
  first).
- `rollback` overlays `<appId>/v1` onto a current main that has
  `<appId>/v2`, produces a new commit on `main`, does **not** tag
  it, leaves both prior tags reachable.
- `listVersions` returns tags newest-first and includes the rolled-
  back-from tag (it stayed reachable).
- `resolveActiveAppDir` returns undefined for an app never published.

### Slice 5 — GitHub export/import

**Export push and import clone.** New `src/remote.ts`.
`exportToRemote(bareDir, remoteUrl)` (re)points a remote (`origin`
by default; idempotent via `get-url` probe → `set-url` or `add`) and
pushes `refs/heads/main` + `refs/tags/*` — the production trunk plus
every `<app>/v<n>` version tag. Session branches are deliberately
left behind (ephemeral local state). `importFromRemote(root,
remoteUrl)` does a `git clone --bare` into `<root>/apps.git`, after
which `new AppsStore({ root }).init()` materializes `main` and the
runtime serves immediately. Import refuses if `apps.git` already
exists — it targets a fresh gateway, not a merge.

**listApps and bareRepoDir surface.** `AppsStore.listApps()` walks
`refs/heads/main:apps` via `ls-tree` and returns the app ids on the
trunk — the git-native replacement for the `_registry.json` walk
(an app "exists" iff it has a subtree on `main`). `bareRepoDir`
getter exposes the bare repo path for `remote.ts` and tests.

`src/remote.test.ts` covers: `listApps` (empty, then sorted ids
after publishes); export-then-import round-trip through a bare
"GitHub" remote (main content + version tags travel, imported store
serves the latest publish); export idempotence across re-runs; and
import refusing a non-empty root.

### Slice 2 — gateway wiring + runtime read-path swap

**Code-dir resolver seam.** `runtime-core`'s `Dispatcher` and
`Runtime` gain an optional `codeDirOverride(appId) =>
Promise<string | undefined>`. When set, it fully replaces the legacy
`versions.getActiveVersion` + `appCodeDir(entry.path, ...)` lookup in
both `resolveCodeDir` methods — every handler dispatch + static serve
+ `app-schema` route now reads from whatever dir the override
returns. When unset, resolution is unchanged, so OpenClaw and any
pre-#137 setup keep working against `<appsDir>/<id>/versions/
<active>/`. The `app-schema` route additionally gates on code-dir
presence (via `resolveCodeDir`) instead of `getActiveVersion`, so the
git backend — which has no `current.json` — still answers. `data.sqlite`
stays at the registry's per-app dir (`entry.path`, under `appsDir`),
keeping app *data* cleanly separated from app *code* (git).

**Gateway constructs the apps-store.** `serve()` takes an optional
`appsStoreRoot`. When given, it constructs + `init()`s an `AppsStore`
there, passes `codeDirOverride = (id) => appsStore.resolveActiveAppDir(id)`
into the `Runtime`, and after `bootstrap()` syncs every app on `main`
(`appsStore.listApps()`) into the registry via `ensureUploaded` so
`registry.get(id)` resolves and each app's data dir exists. The live
`AppsStore` is exposed on the serve handle (`handle.appsStore`) for
the publish endpoint + export/import to drive. `@centraid/apps-store`
is now a dependency of `@centraid/gateway-runtime`.

**Git-store serve integration test.** `serve-git-store.test.ts` seeds
an app through the AppsStore (open session → write app.json + index.html
+ a `ping` query handler → publish), boots `serve()` with
`appsStoreRoot`, and proves the running gateway serves it end-to-end:
registry lists the app, `GET /centraid/<id>/` static-serves
index.html from `worktrees/main/<sha>/`, and `centraid_read` runs the
query handler out of the worktree. A second test confirms the handle
has no `appsStore` when `appsStoreRoot` is omitted (legacy backend).

### Slice 3 — publish endpoint replaces tarball upload

**extraHandlers seam on the runtime HTTP server.**
`startRuntimeHttpServer` gains an optional `extraHandlers` array —
host-supplied `(req, res) => Promise<boolean>` functions run after the
bearer check, before `runtime.handle`, each returning `true` when it
owned the request. This keeps the git-store HTTP surface out of
`runtime-core` (shared with OpenClaw) while letting the gateway mount
it on the same authenticated server.

**Apps-store route module.** New `gateway-runtime/src/apps-store-routes.ts`
exposes the editing + publish lifecycle under the `_apps` namespace,
all driving the live `AppsStore`:

- `POST /centraid/_apps/_sessions` (+ `GET` list, `DELETE /<id>`) —
  session open/close/list.
- `PUT /centraid/_apps/<appId>/files/<path>?sessionId=` — write a
  draft file into the session worktree (path-traversal guarded,
  editable-extension allowlist). `GET .../files?sessionId=` reads them
  back. This replaces builder-harness's `writeProjectFile` /
  `readProjectFiles` against the desktop workspace.
- `POST /centraid/_apps/<appId>/publish` — `{ sessionId, message }` →
  validate then `appsStore.publish`. Replaces the tarball
  `POST .../upload`.
- `POST /centraid/_apps/<appId>/rollback` — `{ versionTag }` →
  `appsStore.rollback`.
- `GET /centraid/_apps/<appId>/git-versions` — the tag-driven history
  for the version UI.

After publish/rollback the route fires `onAppLive(appId)`, which the
gateway wires to `runtime.registry.ensureUploaded` so a brand-new app
published mid-session is registered (data dir created, `registry.get`
resolves) without a restart.

**Gateway-side manifest validation.** `publish` validates the session
worktree's `app.json` (parsed via `parseAppManifest`) and confirms
every declared action/query has a matching handler file *before* the
merge — the check that used to run client-side in
`builder-harness/src/publish.ts`'s `assertManifestValid`, now
gateway-side since the gateway owns the data. An invalid manifest
returns `400 invalid_manifest` and never advances `main`.

**Publish/session HTTP test.** `apps-store-routes.test.ts` drives a
booted `serve({ appsStoreRoot })` over HTTP: open session → PUT draft
files → publish v1 → serve it → second session → publish v2 → assert
`git-versions` lists both → rollback to v1 → assert the served bytes
revert. Two more tests cover the manifest-validation rejection path
and `files` read-back.

The legacy tarball path (`runtime-core`'s `app-upload` route,
`ingestUpload`, `builder-harness/src/publish.ts`) is left in place for
the OpenClaw backend; retiring it for the desktop happens in slice 4.

### Slice 4 — desktop Code tab cutover

**Apps-store HTTP client + per-project session manager.** New
`apps/desktop/src/main/apps-store-client.ts` is the desktop's HTTP
client for the gateway's `_apps` surface — same thin-client + cached-
auth shape as `user-prefs-client.ts`, methods `openSession`,
`closeSession`, `readDraftFiles`, `writeDraftFile`, `publishApp`,
`rollbackApp`, `listGitVersions`. New `apps/desktop/src/main/project-
sessions.ts` is a tiny in-memory cache that lazily opens one editing
session per app id (`desktop-<appId>`) and reuses it across reads,
writes, and Publish, so reopening the Code tab returns the same in-
progress draft worktree. The cache drops on gateway swap
(`resetProjectSessions`) and on project delete (`dropProjectSession`).

**Code tab reads/writes through the gateway session.** The
`PROJECTS_FILES` and `PROJECTS_WRITE_FILE` IPC handlers no longer touch
`settings.workspaceDir`; they route through the HTTP client against
the per-app session. For the transition window, when the session
worktree is empty AND a workspaceDir copy exists (a freshly scaffolded
or agent-written app that hasn't been promoted yet), the handler seeds
the session from that workspace copy before responding — idempotent;
once the session has files, the seed is a no-op. The Local gateway's
URL+token come from the existing local-runtime wiring
(`ensureLocalRuntime` → `setLocalRuntimeInfoProvider` →
`resolveGateway` → `settings.gatewayUrl`/`gatewayToken`), so the
desktop's HTTP requests land on the in-process runtime exactly like
the remote-gateway case.

**Explicit Publish replaces auto-publish-on-save for the Code tab.**
`PROJECTS_WRITE_FILE` no longer fires `requestPublish` after each
write. Edits land in the session worktree only; nothing reaches `main`
until the user clicks Publish. The `PUBLISH` IPC handler drives
`appsStore.publish(sessionId, appId, message)` over HTTP and adapts
the result `{ versionTag, sha }` into the existing
`CentraidPublishResult` the renderer expects (`versionId = versionTag`,
`sha256 = sha`, `activated = true`). The legacy `skipBuild` flag is
accepted for back-compat but ignored — the git backend doesn't bundle.
`publish-on-save.ts` itself stays for the chat-agent flow (which still
syncs workspace writes to the legacy `appsDir` between turns); the
Code tab cutover is independent.

**Versions UI reads from git tags.** `VERSIONS_LIST` calls
`listGitVersions(appId)` over HTTP and maps `{ tag, version, sha,
uploadedAt }` into the renderer's `CentraidVersionRecord` shape
(`versionId = tag`, `declaredVersion = String(version)`,
`uploadedAt`, `current = true` on the newest tag).
`VERSIONS_ACTIVATE` calls `rollbackApp(appId, versionTag)` over HTTP,
where `versionTag` is the same `versionId` the renderer received from
`listVersions` — no renderer-side shape change. Rollback overlays the
tagged subtree on `main` as a fresh commit; the response reports the
requested tag as the new active version.

**Gateway-swap drops cached sessions.** `invalidateGatewayCaches`
already drops the chat-history, user-prefs, and apps-store auth caches
on every gateway-changing IPC path (settings save with a token rotate,
gateway add, gateway remove, gateway switch). It now also calls
`resetProjectSessions` so the per-app session cache — which holds
session ids for worktrees in the *previous* gateway's git store —
empties; the next edit opens a fresh session on the new active
gateway.

The non-Code-tab flows (project list / create / delete metadata, the
chat-agent scaffold + auto-publish, automation create / set-enabled /
delete, template clone) continue to use `workspaceDir` + the legacy
`publishProject` for now — they're independent code paths that
predate the git store and don't block the Code-tab cutover. Folding
them onto the git store is a follow-up.

### Slice 4 follow-up — review fixups

Three blocking issues from PR review, fixed in-place on the slice 4
commit:

**Fallback codeDir resolver instead of git-store-only.** The
`codeDirOverride` was an unconditional replacement: when the gateway
ran with `appsStoreRoot` set, the dispatcher + runtime stopped
consulting `current.json` entirely, which broke the desktop flows
that still publish through the legacy tarball path
(`PROJECTS_CREATE`'s immediate publish, `PROJECTS_UPDATE_META`, the
chat-agent's `requestPublish` after each turn, template clone). Both
`Dispatcher.resolveCodeDir` and `Runtime.resolveCodeDir` now ask the
override first; if it returns `undefined` (app not in the git store
yet) they fall back to the legacy `versions.getActiveVersion` +
`appCodeDir` lookup. Cutover flows light up incrementally as each
desktop path migrates onto the git store, without orphaning the ones
that haven't.

**Active-version signal on `git-versions`.** `VersionEntry` gains an
`active: boolean` computed by comparing each tag's `apps/<appId>/`
subtree sha against main's. Forward publish makes the newest tag
active; rollback flips the active flag to the older tag whose
subtree was re-laid (the newer tag stays in the list, replayable but
`active: false`). The desktop's `VERSIONS_LIST` IPC now returns
`{ activeVersion, versions }` matching the legacy `listVersions`
shape, so the renderer's app-reopen path sets `liveUrl` correctly
again. `PROJECTS_PREVIEW_URL` also probes git-versions as a second
availability source, so a git-store-published app is "available" on
first open without waiting for a legacy `current.json` to appear.

**`snapshotSessionAppDir` rejects phantom sessions.** A stray PUT
files request with an unknown sessionId previously created
`worktrees/sessions/<id>/apps/<app>/` from scratch, after which
`openSession(id)` would 409 with `session_exists` (the dir existed)
and a subsequent `publish()` would `git add` in a plain dir and
fail. The helper now requires a `.git` link file at the worktree
root (the unforgeable marker of a registered worktree) and throws
`session_missing` otherwise — `openSession()` is the only path that
creates session dirs.

Tests added: `apps-store.test.ts` asserts `active: true/false`
across forward publish + rollback; the new
`snapshotSessionAppDir refuses to create phantom dirs` test exercises
the guard. `gateway-runtime/apps-store-routes.test.ts` asserts the
`active` flag flips on the HTTP `git-versions` response after
rollback.

### Slice 4b — projects + agent flows off workspaceDir

The slice-4 fallback resolver in `Dispatcher`/`Runtime` was a v0-
inappropriate workaround — for a no-migration codebase the principled
move is to delete the legacy path, not paper over it. Slice 4b
eliminates the legacy path for everything except the automation
flows (which still need an OS-scheduler appsDir rewire — tracked as a
follow-up).

**AppsStore.deleteApp + listAppsWithMeta.** `deleteApp` runs `git
rm -r apps/<appId>` in a detached worktree, commits forward to main,
reaps every `<appId>/v*` tag, then materializes — same forward-only
audit model as publish/rollback. `listAppsWithMeta` walks main's
`apps/` and reads each `app.json` from the materialized-main worktree,
returning `[{id, name?, description?, hasIndex}]`. The desktop home
shelf no longer scans a workspaceDir to render tiles.

**Gateway routes for app list + delete.** `GET /centraid/_apps`
shadows runtime-core's legacy registry-list with the same flat-array
shape, extended with the new metadata. `DELETE /centraid/_apps/<id>`
calls `deleteApp` + a new `onAppDeleted` callback (wired in serve.ts
to `runtime.registry.deregister`).

**PROJECTS_* IPC cut over.** `PROJECTS_LIST` calls the new HTTP
list. `PROJECTS_CREATE` opens a session, scaffolds into the session
worktree's `apps/<id>/`, and explicit-publishes (so the iframe has
something to preview). `PROJECTS_FILES`/`WRITE_FILE` were already
session-routed (slice 4); the workspace-seeding helper retires.
`PROJECTS_DELETE` drops the session then HTTP-deletes the app.
`PROJECTS_UPDATE_META` writes the new app.json into the session
(user clicks Publish to land it). `PROJECTS_OPEN` opens the session
worktree on disk (local-gateway only). The desktop's `workspaceDir`
is no longer touched on any of these paths.

**AGENT_START writes directly into the session worktree.** The chat
agent's `projectDir` is now the session worktree's `apps/<id>/`. The
agent's native Read/Write tools edit the same dir the gateway's
apps-store-routes read from. The post-turn synchronous `publishApp`
replaces the legacy `requestPublish` debounce — every agent turn ends
with an explicit, ordered publish that drives the iframe + downstream
listeners.

**publish-on-save.ts retired.** With the Code tab on explicit Publish
(slice 4) and the chat-agent on direct session writes + sync publish
(slice 4b), nothing queues a debounced workspace→appsDir publish
anymore. The file is deleted. `getPublishStatus`/`PUBLISH_EVENT_CHANNEL`
stubs remain in `ipc.ts` for renderer API stability — they always
report `inFlight: false` and never fire, since publishes are
synchronous through `PUBLISH`.

### Slice 4c — templates + automations off workspaceDir (full cutover)

Slice 4c finishes the job: `TEMPLATES_CLONE`, `AUTOMATIONS_CREATE`,
`AUTOMATIONS_SET_ENABLED`, `AUTOMATIONS_DELETE`, and the read paths
`AUTOMATIONS_LIST`/`AUTOMATIONS_READ`/`AUTOMATIONS_RUN_NOW` all move
to the git store. `workspaceDir` and the `publishProject` tarball path
are gone from the desktop entirely, and the `Dispatcher`/`Runtime`
codeDir fallback is removed.

**AppsStore stable `active-main` symlink (`getActiveMainLink`).**
`OsSchedulerHost` bakes `CENTRAID_APPS_DIR` into every cron/launchd
entry at register time, but the git-store materialized main rotates
its `worktrees/main/<sha>/` path on every publish — a baked path goes
stale. AppsStore now maintains a stable `<codeStoreDir>/active-main`
symlink, repointed atomically (write-temp-then-rename, before the old
worktree is evicted, so a reader never sees a dangling link) on every
`init` / publish / rollback / delete. `getActiveMainLink()` exposes the
path; external processes bake `<active-main>/apps` once and survive
every swap.

**Code/data split in run-automation (CLI + host `codeAppsDir`).** A fire needs two
trees: the automation's *code* (manifest + handler, in the git store)
and its *data* (`runtime.sqlite` run ledger, under the stable
`<appsDir>/<id>/`). `runAutomationLocal` + the `centraid run-automation`
CLI + `OsSchedulerHost` all gained a `codeAppsDir` (env
`CENTRAID_APPS_CODE_DIR`) distinct from the data `appsDir` — code
resolves from `active-main/apps`, the ledger stays on the data tree
that survives swaps. `codeAppsDir` defaults to `appsDir` so the
legacy/flat layout (OpenClaw) is unaffected.

**serve() scans + bakes the stable code path.** The startup
OS-scheduler reconcile lists automations from `active-main/apps` (not
`paths.appsDir`), and the `schedulerHostFactory` now receives
`{ codeAppsDir, dataAppsDir }`. The desktop's `localRuntimeAutomationHost`
derives both from the gateway id (`active-main/apps` for code,
`gatewayAppsDir` for data), so the cached host and every IPC caller
agree on the two trees.

**TEMPLATES_CLONE + AUTOMATIONS_* IPC cut over.** `TEMPLATES_CLONE` computes a
unique `(id, name)` from `listAppsWithMeta()` via the new
`suggestCloneIdentityFrom` (no filesystem scan), clones into the
session worktree, provisions pending webhooks, then `publishApp`s.
`AUTOMATIONS_CREATE`/`SET_ENABLED`/`DELETE` scaffold/edit/delete inside
the session worktree and publish; `AUTOMATIONS_LIST`/`READ` read from
`active-main/apps`; `RUN_NOW` passes both dirs. A whole-app
(`auto.`-prefixed) delete uses the HTTP `deleteApp`; an app-owned
automation delete drops its `automations/<id>/` subdir and publishes.

**codeDir fallback removed; workspaceDir deleted.** With the whole desktop on the store, the
`Dispatcher`/`Runtime` resolver no longer falls through to legacy
`current.json` when the override returns undefined — when a git-store
override is present it is the *sole* authority (an app it can't resolve
is simply not live). The legacy active-version branch survives only for
backends with *no* override at all (OpenClaw / pre-#137). `workspaceDir`
+ `gatewayWorkspaceDir` are deleted from desktop settings + paths, and
`current.json` is fully retired for desktop.

### Review fixes (PR #138)

Three post-merge review findings on the combined PR:

- App delete tears down the per-app data dir, not just the git-store code.
- Whole automation-app delete deregisters and cleans data instead of re-registering it.
- Unified chat resolves the manifest catalog via the git-store code-dir override.

**App delete tears down the per-app data dir, not just the git-store
code.** `DELETE /centraid/_apps/<id>`'s `onAppDeleted` callback previously
only dropped the registry entry. `store.deleteApp` removes the code from
`main`, but the app's data dir (`<appsDir>/<id>/`, holding `data.sqlite`
+ the run ledger) was left on disk, so recreating the same id resurrected
stale data. serve.ts now runs the same deregister+cleanup the legacy
`registry-deregister` route uses — `registry.deregister` then
`cleanupDeregisteredApp(appsDir, removed, logger)`, newly exported from
`@centraid/runtime-core` — through a shared `deregisterAndCleanup` helper
wired into both the apps-store `onAppDeleted` and a new
`LifecycleRouteOptions.deregister`. (This supersedes the slice-4b note
above that wired `onAppDeleted` to a bare `registry.deregister`.)

**Whole automation-app delete deregisters and cleans data instead of
re-registering it.** `handleAutomationDelete`'s `kind: 'automation'`
branch called `ensureRegistered(appId)` right after `deleteApp`, which
RE-created the registry entry + data dir for the app it had just deleted.
It now calls `opts.deregister(appId)` (deregister + data cleanup),
matching the apps-store DELETE path.

**Unified chat resolves the manifest catalog via the git-store code-dir
override.** The chat route's `safeReadManifest` resolved code via
`versions.getActiveVersion(entry.path)`, which returns undefined under the
git-store backend (no legacy `current.json`) — so every chat turn rendered
"manifest unavailable" and steered the agent at `_sql` even when the
declared handlers were resolvable through the override. `ChatRouteContext`
now carries a `resolveCodeDir` resolver (the runtime's override-aware
`Runtime.resolveCodeDir`), and `safeReadManifest` reads the manifest from
that dir, so the declared-handler catalog reaches the system prompt on the
primary runtime path.

## Out of scope

This PR ships the abstraction without wiring it into the existing
upload/runtime flow. The remaining slices, in the order they need to
land:

1. **Gateway wiring** — `gateway-runtime`/`gateway-paths.ts` learn the
   `apps.git/` + `worktrees/` layout, `serve()` constructs an
   `AppsStore` and exposes it to the runtime.
2. **Runtime read-path swap** — `runtime-core` reads handlers from
   `appsStore.resolveActiveAppDir(appId)` instead of
   `<appsDir>/<appId>/versions/<active>/`. `registry.ts` becomes a
   thin walker over `appsStore.listApps()`. `version-store.ts` +
   `current.json` retire.
3. **Publish endpoint replacement** — replace
   `POST /centraid/_apps/<appId>/upload` with
   `POST /centraid/_apps/<appId>/publish` (body: `{ sessionId,
   message }`). `builder-harness/src/publish.ts`'s tarball logic
   retires; `assertManifestValid` moves gateway-side and runs against
   the session worktree before the merge.
4. **Desktop workspace refactor** — `gatewayWorkspaceDir(id)` retires.
   `writeProjectFile` / `readProjectFiles` IPC handlers redirect to a
   new gateway endpoint that talks to a session worktree. The
   debounced `publish-on-save.ts` retires (the issue's "no more
   auto-on-save" decision).
5. **Export/import** — CLI commands wrapping `git remote add` +
   `git push` for export and `git clone` for import.
6. **`data.sqlite` placement** — keep at
   `runtime/<appId>/data.sqlite` outside `apps.git/` so version swaps
   don't touch user data. Migration story for existing installs
   (today's `<appsDir>/<appId>/data.sqlite`) — punt to slice 2 since
   centraid is pre-release.

Slices 2 + 3 are tightly coupled and likely land in one PR. Slices 4
and 5 are independent.

## Verification

Workspace checks green:

- `bun run typecheck` — green across the workspace.
- `bun run check` (oxfmt + oxlint) — clean.
- `bun run build` — every package builds, including the new
  `@centraid/apps-store`.
- `cd packages/apps-store && bun run test` — all 21 tests pass
  (Slice 5 added the export/import round-trip suite).
- `bun run test` — every workspace test suite passes after the desktop
  Code-tab cutover (Slice 4): 26 gateway-runtime tests including the
  three apps-store HTTP route tests, the runtime-core suite, the
  apps-store git suites, and the legacy desktop suites.

Review fixes (PR #138) — green:

- `bun run build && bun run typecheck && bun run lint && bun run test` —
  all green across the workspace (18 typecheck tasks, 0 lint findings,
  every test suite passing).
- New gateway-runtime test `DELETE /_apps/<id> tears down the app data
  dir, not just the code`, plus the extended automation-delete test that
  asserts the data dir is removed and not resurrected by a stray
  re-register.
- New runtime-core test `chat prompt resolves the manifest via the
  git-store code-dir override (#137)` asserts the declared catalog reaches
  the prompt and "manifest unavailable" does not.
