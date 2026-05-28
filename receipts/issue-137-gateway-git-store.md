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
