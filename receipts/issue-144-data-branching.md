# issue-144 — Data branching for schema-safe app editing

GitHub issue: [#144](https://github.com/srikanth235/centraid/issues/144)

Editing an app branches **code** (a per-session git worktree, #137/#141) but
not **data**: a draft's writes land on live `data.sqlite`, and there is no
isolated place to exercise a not-yet-published migration. This gives a draft
an isolated, prod-seeded copy of its data, and makes schema changes reach
live only on publish.

Plus a standalone correctness fix: under the git-store backend, publish never
ran migrations against live data, so a published schema change never landed.

v0 pre-release: no backward compatibility, no migrations of existing stores.

## Design principle: the worktree **is** the agent's single directory

The session git worktree already is the one self-contained directory for code.
So the draft's `data.sqlite` lives **inside it**, next to the handlers and
migrations the agent edits, rather than in a parallel data tree:

```
worktrees/sessions/<id>/apps/<appId>/
    app.json, actions/, queries/, migrations/   ← tracked — the agent edits these
    data.sqlite  (+ -wal, -shm)                  ← gitignored — seeded from live, throwaway
```

Data was only ever separated from code because **live** code version-swaps
(`worktrees/main/<sha>` rotates per publish to bust the require cache) and
data must survive the swap. A **session worktree never swaps**, so that
constraint does not apply to drafts. In draft mode **data dir = code dir**, so
the existing `overrideCodeDir` seam already yields the data location — no
parallel resolver, no separate prune, no orphan sweep.

Live `data.sqlite` stays at `appsDir/<id>/data.sqlite` — it can't live in the
swapping `main/<sha>` dir, and it's the publish target.

## Checklist

- [x] Fix migrations-on-publish in the git-store backend
- [x] Rename `@centraid/code-store` → `@centraid/worktree-store`
- [x] `.gitignore` draft data in the canonical repo (main + every worktree)
- [x] Draft data dir = draft code dir (dispatcher + `_sql` + describe schema)
- [x] Seed-on-first-draft-access (VACUUM INTO live + replay pending migrations)
- [x] "Reset data from prod" endpoint + renderer client method

## What changed

- **Fix migrations-on-publish in the git-store backend.** `runPendingMigrations`
  was wired only into the legacy tarball-upload path
  (`app-engine/route-handlers.ts`); the git-store publish path only committed +
  ff-merged code, so a published schema change never reached live `data.sqlite`.
  A new gateway-side `publish-migrations.ts` (`runPublishMigrations`) runs the
  session worktree's committed migrations against the live `data.sqlite` —
  the composition root is the one layer that sees both the worktree's
  `migrations/` and the live data path, so the pure git store stays
  data-agnostic. Both publish chokepoints (the `_apps/<id>/publish` route and
  the lifecycle `publishAndReconcile`) pass it as the store's `migrate` hook,
  which fires inside the publish mutex **post-rebase, pre-ff-merge** (see
  Review fixes for why ordering matters): a failing migration rolls back
  inside `BEGIN IMMEDIATE`, aborts the publish (422 `sql_failed`), and leaves
  live data untouched + code unmerged. The publish response reports
  `migrationsApplied`. `runPendingMigrations` is now exported from
  `@centraid/app-engine`.

- **Rename `@centraid/code-store` → `@centraid/worktree-store`.** With draft
  data now living inside the session worktree, the module owns both planes of
  an editing session, not just code. `git mv` of `packages/code-store` →
  `packages/worktree-store` (+ `src/apps-store.ts` → `src/worktree-store.ts`),
  class `AppsStore` → `WorktreeStore`, `AppsStoreError`/`AppsStoreOptions`/
  `AppsStoreErrorCode` → `WorktreeStore*`, the `package.json#name`, the gateway
  dependency + all importers, and `bun.lock` repointed. The gateway's `_apps`
  HTTP-namespace handler keeps its `apps-store-routes`/`makeAppsStoreRouteHandler`
  names (they describe the `/centraid/_apps` URL surface, not the store class).
  No behavior change.

- **`.gitignore` draft data in the canonical repo (main + every worktree).**
  `WorktreeStore.init()` plants a repo-level `.gitignore` (`data.sqlite`,
  `data.sqlite-wal`, `data.sqlite-shm`) on `main` via a forward commit
  (`ensureGitignore`, idempotent, transient-worktree like rollback/delete).
  Session worktrees branch off `main` and inherit it, so publish's path-scoped
  `git add apps/<id>` skips a draft's branched data without any per-file
  handling. The basename patterns match at any depth (`apps/<id>/data.sqlite`).

- **Draft data dir = draft code dir (dispatcher + `_sql` + describe schema).**
  The dispatcher now resolves `dataDir = overrideCodeDir ?? appDataDir(entry)`:
  in draft mode the handler `app.dir`, the `_sql` built-ins (which take an
  explicit `dataDir` now instead of deriving it from the registry entry), and
  the whole-app `describe` schema read all open the session worktree's
  `data.sqlite`. The runtime's `app-schema` + `app-index` routes read the
  draft's branched data/settings in draft mode too. The agent's chat tools
  branch as well: `ToolContext` gained `overrideCodeDir`, threaded from the
  turn's cwd via a new `cwdIsDraftWorktree` flag on `makeChatRunnerCore`
  (set by the unified/builder runner, left off the data-only backend), so an
  agent authoring a migration can exercise it against the draft without
  touching live rows.

- **Seed-on-first-draft-access (VACUUM INTO live + replay pending migrations).**
  A new gateway `draft-data.ts` (`seedDraftData`) copies the app's live
  `data.sqlite` into the session worktree via `VACUUM INTO` (preserves
  `user_version`, copies rows) and replays the draft's pending migrations on
  top — so a seeded copy starts at live's schema version and applies only the
  draft's *new* migrations. It's lazy + idempotent (a no-op once the copy
  exists). Wired at the two seams that resolve a draft worktree for data: the
  runtime's draft code-dir resolver (`makeDraftCodeDirResolver`, which the
  composition root injects, replacing the inline closure in `serve.ts`) and
  the unified chat runner's `resolveCwd`. A brand-new app with no live data
  seeds from empty + a full migration run.

- **"Reset data from prod" endpoint + renderer client method.** A new
  `POST /centraid/_apps/<id>/reset-data` route re-seeds a draft session's data
  via `seedDraftData({ force: true })` — a fresh prod snapshot + replayed
  pending migrations — and reports `{ seeded, migrationsApplied }`. It doubles
  as a publish dress rehearsal: a migration incompatible with prod rows fails
  here and the SQL error surfaces inline (422 `sql_failed`) so the author hits
  it in preview, not at publish. The renderer's `gateway-client-editing.ts`
  gains `resetAppData(...)`, the client method a preview-pane control calls;
  wiring the visible button into `builder.ts` is the one remaining renderer
  step (see Out of scope).

## Review fixes (post-PR)

- **Migrations run against the post-rebase tree.** Originally the gateway ran
  migrations against the session worktree *before* `WorktreeStore.publish`
  rebased it onto current `main`. A stale session could validate/apply against
  its pre-rebase tree, then publish a different final tree (skipping a
  migration, or leaving a duplicate id when another session published the same
  number first). Migrations now run via a `migrate` hook on `PublishInput`,
  fired inside the publish mutex **after** the rebase and **before** the
  ff-merge — against the exact tree going live. The store stays data-agnostic
  (the gateway injects the SQLite runner). Regression test: two sessions adding
  the same migration number — the second aborts with `duplicate`, main never
  advances.
- **Failed seed migration leaves no draft DB.** If `VACUUM INTO` succeeded but
  the pending-migration replay threw, the copied-but-unmigrated draft
  `data.sqlite` was left behind and treated as seeded — so preview ran against
  it. `seedDraftData` now deletes the draft copy on a migration failure, so the
  next access re-seeds from scratch. Regression test: a failed seed leaves no
  DB and a fix-forward retry seeds cleanly.
- **`.gitignore` self-heals missing patterns.** `ensureGitignore` no longer
  treats any existing `.gitignore` as success — it verifies the three
  draft-data patterns and merges in whichever are missing (preserving existing
  lines), so an older store / a template-committed ignore can't leave draft
  DBs stage-able.

## Out of scope

- Row-level data merge. This is schema-safe editing only: a draft may read
  stale data; branch rows are throwaway and never merged back.
- `runtime.sqlite` (chat sessions, run ledger, automation state) and logs are
  operational, not app data — not branched; they stay at `appsDir/<id>`.
- **The visible "Reset data from prod" button** in the builder preview pane.
  The endpoint + `resetAppData(...)` client method ship here; hanging the
  button (with a destructive-action confirm) off the preview toolbar in
  `builder.ts` is a follow-up renderer task, deferred because it can't be
  verified without running the desktop UI.

## Verification

- `publish-migrations-over-http.test.ts`: publishing a session that added a
  migration applies it to live `data.sqlite` (rows preserved, `user_version`
  advanced) and reports `migrationsApplied`; a migration incompatible with live
  rows (NOT NULL column, no default) aborts the publish with 422 `sql_failed`,
  live data + code untouched.
- `worktree-store.test.ts`: a draft's `data.sqlite` (+ WAL/SHM) is gitignored —
  never staged into the published tree.
- `dispatcher.test.ts`: with an override, a `_sql` write lands in the worktree
  data.sqlite (live untouched) and `describe` reads the branched schema.
- `seed-draft-data-over-http.test.ts`: first draft access seeds from prod and
  replays the draft's pending migration (draft sees prod rows under the branched
  schema, live unchanged); a draft write never touches live rows; `reset-data`
  re-seeds from a fresh snapshot and surfaces an incompatible migration inline
  (422). Together these cover all five acceptance criteria.
- `turbo run typecheck` green across all packages; app-engine + agent-runtime +
  worktree-store + gateway suites green; desktop typecheck green.
