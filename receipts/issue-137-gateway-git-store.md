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
- `cd packages/apps-store && bun run test` — all 17 tests pass.
