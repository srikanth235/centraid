# issue-129 — Fold app-template migrations into single 0001_init for v0

GitHub issue: [#129](https://github.com/srikanth235/centraid/issues/129)

Centraid is pre-release (v0) with no migration-compatibility guarantee.
The three template apps (`todos`, `hydrate`, `journal`) each shipped a
`0001_init.sql` plus a `0002_*.sql` introducing a digest/recap table.
Since no user base needs the second migration as a separate step, the
two are folded into a single `0001_init.sql` per template.

## Checklist

- [x] `todos`: fold `0002_digests.sql` (`todo_digests`) into `0001_init.sql`
- [x] `hydrate`: fold `0002_recaps.sql` (`hydrate_weekly_recaps`) into `0001_init.sql`
- [x] `journal`: fold `0002_recaps.sql` (`journal_recaps`) into `0001_init.sql`
- [x] Regenerate `packages/app-templates/manifest.json`
- [x] `runtime-core` migrate tests still pass (330/330)

## What changed

Each template's `0001_init.sql` now contains every `CREATE TABLE`
statement the template ever needed. The `0002_*.sql` files are deleted.
The `migrations/` directory layout stays valid for the runner — it
already accepts a single contiguous `0001_*.sql` and writes
`PRAGMA user_version = 1` on success.

**`todos`: fold `0002_digests.sql` (`todo_digests`) into `0001_init.sql`.**
`packages/app-templates/todos/migrations/0001_init.sql` now creates the
`todos` table, the `idx_todos_done_created` index, and the
`todo_digests` table in one file. `0002_digests.sql` is deleted.

**`hydrate`: fold `0002_recaps.sql` (`hydrate_weekly_recaps`) into `0001_init.sql`.**
`packages/app-templates/hydrate/migrations/0001_init.sql` now creates
both `hydrate_daily` and `hydrate_weekly_recaps`. `0002_recaps.sql` is
deleted.

**`journal`: fold `0002_recaps.sql` (`journal_recaps`) into `0001_init.sql`.**
`packages/app-templates/journal/migrations/0001_init.sql` now creates
both `journal_entries` and `journal_recaps`. `0002_recaps.sql` is
deleted.

**Regenerate `packages/app-templates/manifest.json`.** Ran
`bun run build:manifest`. The `files[]` entries for `todos`, `hydrate`,
and `journal` now reference only `migrations/0001_init.sql`.

## What did not change

- `packages/runtime-core/src/migrate.ts` — runner is untouched.
- `packages/runtime-core/src/migrate.test.ts` — fixtures already used
  single-file migration sets; nothing to update.
- `packages/builder-harness/src/system-prompt.ts` — the system prompt
  still teaches contiguous-from-0001 numbering, which holds.

## Out of scope

- Runtime migration runner (`packages/runtime-core/src/migrate.ts`) —
  unchanged; the runner's contiguous-from-0001 contract is what makes
  single-file migration sets valid.
- Agent system-prompt guidance on never editing a *published* migration
  — still correct for end-user apps after 1.0; templates are repo-owned
  pre-release scaffolding so the rule doesn't apply yet.
- Any other migration-bearing surface in the repo (gateway DBs,
  analytics DB) — those use code-driven schema, not the template
  migrations runner.

## Verification

- [x] `runtime-core` migrate tests still pass (330/330) — verified via
      `cd packages/runtime-core && npm test`.
- [x] `bun run format` — clean.
- [x] `bun run build:manifest` — manifest regenerated; the three
      template `files[]` entries reference only
      `migrations/0001_init.sql`.
