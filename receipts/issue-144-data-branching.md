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
- [ ] Rename `@centraid/code-store` → `@centraid/worktree-store`
- [ ] `.gitignore` draft data in the canonical repo (main + every worktree)
- [ ] Draft data dir = draft code dir (dispatcher + `_sql` + describe schema)
- [ ] Seed-on-first-draft-access (VACUUM INTO live + replay pending migrations)
- [ ] Preview-pane "Reset data from prod" endpoint + control

## What changed

- **Fix migrations-on-publish in the git-store backend.** `runPendingMigrations`
  was wired only into the legacy tarball-upload path
  (`app-engine/route-handlers.ts`); the git-store publish path only committed +
  ff-merged code, so a published schema change never reached live `data.sqlite`.
  A new gateway-side `publish-migrations.ts` (`runPublishMigrations`) runs the
  session worktree's committed migrations against the live `data.sqlite` —
  the composition root is the one layer that sees both the worktree's
  `migrations/` and the live data path, so the pure git store stays
  data-agnostic. Called **before the ff-merge** in both publish chokepoints
  (the `_apps/<id>/publish` route and the lifecycle `publishAndReconcile`),
  mirroring the legacy migrate-then-commit ordering: a failing migration rolls
  back inside `BEGIN IMMEDIATE`, aborts the publish (422 `sql_failed`), and
  leaves live data untouched + code unmerged. The publish response reports
  `migrationsApplied`. `runPendingMigrations` is now exported from
  `@centraid/app-engine`.

## Out of scope

- Row-level data merge. This is schema-safe editing only: a draft may read
  stale data; branch rows are throwaway and never merged back.
- `runtime.sqlite` (chat sessions, run ledger, automation state) and logs are
  operational, not app data — not branched; they stay at `appsDir/<id>`.

## Verification

- New `publish-migrations-over-http.test.ts`: publishing a session that added a
  migration applies it to live `data.sqlite` (rows preserved, `user_version`
  advanced) and reports `migrationsApplied`; a migration incompatible with live
  rows (NOT NULL column, no default) aborts the publish with 422 `sql_failed`,
  live data + code untouched.
- `turbo run typecheck` green; gateway suite green.
