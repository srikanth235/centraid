# issue-58 — Version chat-history schema via PRAGMA user_version

GitHub issue: [#58](https://github.com/srikanth235/centraid/issues/58)

## Checklist

- [x] Introduce a `MIGRATIONS` ladder in `chat-history.ts` with the current schema as `MIGRATIONS[0]`
- [x] Add a `migrate()` helper that applies the pending tail under a single `BEGIN IMMEDIATE` / `COMMIT`, bumping `PRAGMA user_version` per step
- [x] Add a downgrade guard that throws when the DB's `user_version` exceeds `MIGRATIONS.length`
- [x] Wire `migrate()` into the `ChatHistoryStore` constructor (pragmas first, then migrate, then prepare statements)
- [x] Tests for the fresh-DB happy path, re-open of an already-migrated DB, and the downgrade guard

## What changed

### Introduce a `MIGRATIONS` ladder in `chat-history.ts` with the current schema as `MIGRATIONS[0]`

`packages/runtime-core/src/chat-history.ts` exports a module-level `MIGRATIONS: readonly string[]` whose entries are the SQL to advance the DB from version `i` to `i+1`. `MIGRATIONS[0]` is the baseline schema — the `chat_sessions` / `chat_messages` tables and their indexes, lifted verbatim out of the old constructor body. It retains `IF NOT EXISTS` so DBs that pre-date version tracking adopt cleanly: they open with `user_version=0`, already have the tables, the baseline statements no-op, and `user_version` advances to 1. The hard rule is documented inline — once a slot has shipped, its SQL is never edited; fix-forward by appending a new entry.

### Add a `migrate()` helper that applies the pending tail under a single `BEGIN IMMEDIATE` / `COMMIT`, bumping `PRAGMA user_version` per step

`migrate(db)` (module-scope in the same file) reads `PRAGMA user_version`, short-circuits when nothing is pending, and otherwise opens a single `BEGIN IMMEDIATE` and walks `[current, MIGRATIONS.length)`. Each iteration runs `MIGRATIONS[v]` then `PRAGMA user_version = v+1`; both commit together at the end. Any SQL error rolls the whole batch back so `user_version` stays at its prior value — the next open retries from the same point. Pragmas (`journal_mode=WAL`, `foreign_keys=ON`) intentionally stay outside the transaction since `journal_mode` cannot be set inside one.

### Add a downgrade guard that throws when the DB's `user_version` exceeds `MIGRATIONS.length`

The first check inside `migrate()` compares the observed `user_version` against `MIGRATIONS.length` and throws a descriptive error (`"chat-history DB is at version N but this build only supports up to M… Please update centraid before opening this database."`) when the DB has been advanced by a newer build. Refusing to open is strictly safer than running queries against a schema this build doesn't understand; the caller — currently the lazy `getChatHistoryStore()` closure in `packages/openclaw-plugin/src/index.ts` — surfaces it as a failed HTTP request rather than silently corrupting data.

### Wire `migrate()` into the `ChatHistoryStore` constructor (pragmas first, then migrate, then prepare statements)

The `ChatHistoryStore` constructor no longer inlines `CREATE TABLE IF NOT EXISTS`. It now (1) opens `DatabaseSync`, (2) executes the `journal_mode` / `foreign_keys` pragmas in their own `exec` outside any transaction, (3) calls `migrate(this.db)`, and (4) prepares its cached statements against the migrated schema. The file-header comment was updated to point readers at the `MIGRATIONS` array for any future schema change.

### Tests for the fresh-DB happy path, re-open of an already-migrated DB, and the downgrade guard

`packages/runtime-core/src/chat-history.test.ts` gains a `ChatHistoryStore migrations` suite with three cases. First: constructing a store against a fresh path leaves `PRAGMA user_version` equal to `MIGRATIONS.length` (verified via a throwaway `DatabaseSync` read). Second: opening a store, writing a session + a message, and constructing a second store on the same path returns intact data and leaves `user_version` unchanged — proving the re-open path is a no-op rather than a re-bootstrap. Third: bootstrapping the schema, then manually advancing `user_version` to `MIGRATIONS.length + 1` via a raw `DatabaseSync`, then constructing a new `ChatHistoryStore` — the constructor throws and the error message matches `/newer|update centraid/i`.

## Verification

- `bun run typecheck` (openclaw-plugin) — clean.
- `bun run test` (openclaw-plugin) — 50/50 green; the three new migration tests included.

## Out of scope

- Adopting this for the per-app data DB. That path uses [packages/app-engine/src/migrate.ts](../packages/app-engine/src/migrate.ts), which is filesystem-driven by design (app authors ship their own `NNNN_*.sql` files inside the tarball); the two cases share the same `user_version` engine but legitimately need different shells.
- An actual schema change. This issue is purely the mechanism so future schema edits have a well-defined path; the first real migration will land with whichever feature needs it.
