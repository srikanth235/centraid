---
name: vault-change
description: How to change the Centraid vault model: add or change a kind, table, column, edge relation, typed command, or read, and keep the schema digest, generated contracts, search index, backup census and app manifests in step. Use when touching contracts/migrations/001_baseline.sql, crates/vault (commands/, migrations.rs, format.rs, log/guard.rs), crates/ontology, crates/search indexing, an app's manifest.json or queries, or when asked to "add a table", "add a column", "add a command", "new kind", "new edge", or "change the schema". For SQL craft itself use the sqlite skill.
---

# Changing the vault model

The vault is one SQLite file on the phone. The Rust core is its only writer. Every app is a projection of it, and every write is a typed command that goes through one commit guard. A model change touches many layers that must agree, and most of the agreement is held by tests that fail until you update the matching generated file. Use the `sqlite` skill for SQL, DDL and transaction craft; this skill is about the repo's shape and what bites.

## 1. What a change touches, in order

1. **The model**: `crates/vault/src/model.rs` (`Kind`, `Rel`, `Flag`, `Kind::host()`, `Kind::CONCEPTS`, `Kind::CONTAINERS`) and `crates/ontology` (the `Vault` type, DDL helpers, the text tokenizer `text::index_words`).
2. **The baseline DDL**: `contracts/migrations/001_baseline.sql`, a hand-written file that founds a new vault and seeds its rows. It is reached with `include_str!` by `crates/vault/src/migrations.rs`.
3. **The format identity**: `crates/vault/src/format.rs` `SCHEMA_DIGEST`, a BLAKE3 over `sqlite_schema`. Open and restore refuse a file whose digest differs.
4. **Generated contracts**: `contracts/schema/vault-ddl.sql` (`export-ladder-ddl`), `contracts/schema/vault-commands.txt` (`export-commands`), and the published ontology page's schema section (`export-ontology-page`, with a sentence per table in `ontology_doc::TABLES`).
5. **Commands**: `crates/vault/src/commands/<area>.rs`, registered in `commands/mod.rs`. A command runs inside `Vault::execute`, which runs the commit guard in `crates/vault/src/log/guard.rs`.
6. **Search**: `crates/vault/src/index.rs` (re-indexing at commit, `DEPENDENTS`), `crates/search` (reading, matching).
7. **Apps**: `crates/apps/<app>/` (queries, actions, `manifest.json`) over `crates/apps/kit`, which owns the read vocabulary.
8. **Backup**: the snapshot census in `crates/vault/src/backup/snapshot.rs`. It is derived from the file, so it rarely needs editing, but a restore compares it table by table.

## 2. The steps, in order

1. **Decide the table's place in the model first.** A new thing with a title and a trash is a new _kind_: one value in `entity.kind`'s CHECK, one in `Kind`, a host table (its own, `concept` or `container`), and nothing else. A new relation between entities is a CHECK value, a `Rel`, and `edge_shape` rows saying which kinds it may join. A thing that is none of these is a _child row_ of one kind and cascades from it. A star, a pin or an archive is a `tagged` edge to a flag, never a column. Why: the model has one supertype and one cascade; a parallel mechanism is a second truth.
2. **Edit the baseline.** `001_baseline.sql` is the schema a new vault founds and the only rung; change it directly.
3. **Write the DDL to the doctrine** (section 3): generated `kind` column and composite `(id, kind)` foreign key for a kind row, an explicit `ON DELETE` on every foreign key, every FK's first child column leading an index (a partial index `WHERE col IS NOT NULL` when mostly NULL), CHECK values that match the Rust enum, `STRICT` where the neighbours are.
4. **Run the digest test and paste the value.** `cargo test -p centraid-vault the_schema_digest_is_the_founded_files` fails printing `found: <hex>`; put it in `SCHEMA_DIGEST`. Any baseline change, even a column comment that changes a statement, needs this. Comments and whitespace do not change the digest; statements do.
5. **Regenerate the generated files.** `cargo run -p centraid-vault --bin export-ladder-ddl` for `vault-ddl.sql`, `export-commands` for `vault-commands.txt` (when commands change), `export-ontology-page` for the page after adding a sentence for the table in `ontology_doc::TABLES`. Never hand-edit them. Add the new table to the list in the "no table outside the spec" commitment test (`crates/vault/tests/commitments.rs`).
6. **Write the commands.** One typed command per verb, named `<kind>.<verb>`, in the owning app's file. A per-kind verb that duplicates a shared verb (`entity.*`, `tag.*`, `flag.*`, `edge.*`, `container.*`, `blob.*`, `derivative.*`) is not written. Every command that changes an entity's row, its kind row or its child rows calls `ctx.touch(id)` (stamps `updated_at` and queues the re-index); a create uses `insert_entity` and `born`. Refuse with a sentence, not a SQL error. Add or remove of an `about` or `links` edge touches the note at the edge's start.
7. **Make search see it.** Text a member searches goes in `text_of`; a link written without touching either end calls `mark_for_index` on the labelled end; a title that labels other things (a tag, list, project, calendar, account) belongs in `DEPENDENTS`. The incremental-index-equals-rebuild commitment must stay green for your command.
8. **Teach the apps.** Add the read to the app's queries (paged, keyset, bounded) and to its `manifest.json` (section 4). Add a year-3 scale test if the read is hot (section 5).
9. **Update the shell contracts if the wire changes** (commands the shell quotes, `app_query` numbers, proto fields). Read `crates/core-ffi/CONTRACT.md` before touching an ABI or wire field; removed wire fields are `reserved` by number and name, never reused.

## 3. What must stay true

- **The commit guard is the only writer.** `Vault::commit` is `BEGIN IMMEDIATE`, body, `COMMIT`, one transaction. The read connection is `query_only`. Nothing writes outside it; nesting is a no-op inside the outer pair.
- **Upsert, never REPLACE.** No command writer resolves a conflict with `INSERT OR REPLACE` or `REPLACE INTO`. SQLite's REPLACE fast path does not report the displaced row to the update hook and fires no delete trigger, so the commit census would disagree with the file (a restore refuses a file whose counts disagree) and the displaced row's entity would be orphaned. Write `INSERT ... ON CONFLICT (...) DO UPDATE`.
- **A refused or failed command writes nothing anywhere.** Gate order: schema validation (errors scrubbed of sealed values), authority, preconditions, the handler in the commit, postconditions (a failure rolls the commit back), then the action key in the same transaction. There is no journal and no replay ledger; an `act` carrying a key is answered `replayed` and runs nothing, a command without one that arrives twice runs twice. A write a shell may re-offer must be idempotent by its own content or by an id the phone minted.
- **The write counter.** The guard bumps `vault.writes` / `vault.written_at` once per commit that changed something a screen reads, in the same transaction, muted in the census. Takeover compares it. Do not bump it yourself.
- **Delete rules are decisions.** Kind rows, child rows, edge ends, `revision.entity_id` and a category's budgets and rules cascade; only `source.entity_id` and `message_attachment.entity_id` set NULL; every other pointer into an entity has no action and needs a purge rule (`PURGE_RULES`, `DETACH`) saying what a purge does with it. A purge is one DELETE of the entity row plus those rules, never a foreign-key walk that deletes whatever it reaches.
- **Trash lives on `entity` only** (`deleted_at`, `purge_at`). A holder (notebook, folder, project, account, person) trashes its members with its own stamp and a restore brings back only those carrying that stamp. `purge_at` says when the launch pass may empty a row, not when it stops being restorable.
- **Hashes are BLAKE3 and only ever a foreign key into `blob(hash)`.** Garbage collection finds references from `PRAGMA foreign_key_list` alone. A column that rents a blob says whose the bytes are (the backup skips what only a lapsed entity holds). Any command that can drop the last reference to a blob collects and returns `released`; the gate deletes those files after commit.
- **Sealed cells stay sealed.** Locker's secret cells are `lk1:` ciphertext no entity-wide reader carries; never add a column that copies, indexes or logs one. Search and `text_of` hold plain text only.
- **Edges are shaped.** An edge joins only the kinds `edge_shape` allows, and an edge's ends never change. Favorite is a flag, not a mirror column. Revisions use the one `revision` table.
- **No dormant schema.** A table, column or wire field with no producer and no consumer leaves; intent lives in an issue. A wire field no table can fill is `reserved`.
- **Time and identity.** Ids are UUIDv7 minted from the injected clock, so fixtures stay deterministic. Civil time is the vault's zone, never the host's. Money keeps its currency (minor units plus a code); a bare amount is not a balance.
- **Reads paginate by keyset** (`(sort_key, pk)`), never `OFFSET`, and always take a window. A keyset cannot continue over a NULLABLE sort column; the kit refuses it.
- **Follow is a three-way merge** against `source.stated`: the member's edit wins per field, the system's change lands on the rest. A new followed field needs its map entry.
- **There is no backwards compatibility with a file before the #1135 model** (`CEN1`): it is refused with a sentence at open and restore, never migrated.

## 4. What an app must declare

An app is a first-party screen, not a principal. It holds no credential and declares its reach at build time in `crates/apps/<app>/manifest.json`:

- `vault.scopes`: one entry per table it reads (`"verbs": "read"`, schema `vault`) and one per command it invokes (`"schema": "<area>"`, `"table": "<verb>"`, `"verbs": "act"`, e.g. `note` / `create`). A tripwire fails the build when an app touches an entity or command it did not declare. Add the table or command here in the same change, with a `why` a member would accept.
- `actions` (each naming its `command`, an `inverse` where one exists, `sealed` cells, and a `confirmation` level) and `queries` (each with an input and output schema and `figures`). A new read is a query entry; a new write is an action whose command exists in the registry.
- `states.designed` plus `excluded`: a closed partition of the seven canonical states. Forgetting one fails to parse.
- Apps hold no SQL and no connection: statements are data run by the kit's one assembler. The `sql-confinement` rule keeps SQL under `crates/{ontology,vault,search}` and `crates/apps/kit`, tests included.
- Every app invocation carries an `invoke_key`. A denial is a value in the payload, not an error.

## 5. Pitfalls

- **Editing `001_baseline.sql` and forgetting the digest.** Four tests go red at once (digest, `ladder_ddl`, `ontology_page`, commitments); fix the digest first, then regenerate.
- **A foreign key with no index on its child column.** Deleting a parent then scans the child once per deleted row. A purge or an emptied trash turns quadratic. The commitment test catches it; the query-plan test catches the read-side twin.
- **A new read that scans or sorts a big table.** `crates/core/tests/query_plans.rs` plans every page and every hand-written statement over the year-3 corpus. The fix is an index in the baseline, not a row in `contracts/ledgers/query-plans.json`.
- **Touching a row without `ctx.touch`.** The row changes but search and `updated_at` do not; the index-equals-rebuild commitment fails, or worse, silently does not for a path no test covers.
- **A command that works on the wrong kind.** Notes and Photos both hold containers; every command states its kind and refuses the other's id with a sentence, and every reader filters on kind.
- **Adding a CHECK value without its writers.** Sweep mechanically (below); a CHECK value nothing writes is dormant schema.
- **Never weaken a test, budget, ledger or allowlist to go green.** Fix the code.

### The mechanical sweeps (part of the review, not extras)

Reading alone found none of the reproduced purge and merge bugs. For any model change run these with grep or a throwaway query against a founded vault:

1. **Every CHECK value against its writers**: each value of each CHECK list has at least one command that writes it and a reader that filters on it, and Rust enums equal the SQL list.
2. **Every FK's delete rule against its siblings**: list `PRAGMA foreign_key_list` for the tables around yours; a sibling with a different rule needs a reason. New pointers into `entity` that delete nothing need a purge rule.
3. **Every table's timestamps**: each mutable table has `created_at` / `updated_at` as its neighbours do, and the command stamps them (an entity's through `touch`). A child row's changes touch its parent.
4. **A citation is not a justification.** If a rule or comment cites a past ruling, re-judge it on its merits for the product now; surface what survives only because someone ruled it.

## 6. Year-3 scale tests

Every app has `crates/apps/<app>/tests/year3.rs` (agenda, docs, health, money, notes, people, photos). Each builds a deterministic, seeded year-3 corpus with `centraid_apps_kit::fixtures` (a `Year3...Shape` struct whose fields are all named so a new field fails the literal), runs the app's real queries through `TestDoor`, and asserts what a count cannot: windows are walked and bounded, truncation is reported, pinned or special rows outlive the window. When your change adds a hot read or grows a table that scales with years of use (notes, transactions, photos, events), extend the fixture shape and the test in the same change. Timings are reported as provenance, never as ceilings.

## 7. How to check it

```sh
cargo test -p centraid-vault the_schema_digest_is_the_founded_files   # prints the new SCHEMA_DIGEST
cargo run -p centraid-vault --bin export-ladder-ddl
cargo run -p centraid-vault --bin export-commands
cargo run -p centraid-vault --bin export-ontology-page
cargo test -p centraid-vault            # commitments, ladder_ddl, command_list, ontology_page, format_identity, restore_drill, backup_snapshot
cargo test -p centraid-apps-<app>       # the app's tests, year3 included
cargo xtask gate --profile pr           # the real gate; one crate green is not enough
```

`export-ddl` in `crates/ontology` prints a vault file's schema; point it at a copy, never a live file. The gate's `mobile-jvm` profile and any Kotlin or Swift build need the Android SDK or Xcode and cannot run in a Linux cloud session. Say so in the PR rather than claiming them green. The search budget and restore drill run in the gate; if you cannot run the full gate, name which profile steps you ran.

## 8. Final checklist

- [ ] Place in the model decided (kind, relation or child row); the baseline edited directly.
- [ ] `SCHEMA_DIGEST` updated; `vault-ddl.sql`, `vault-commands.txt` and the ontology page regenerated, not hand-edited; table added to the commitments spec list.
- [ ] Every FK has an explicit delete rule and an index on its first child column; any no-action pointer has a purge rule.
- [ ] Commands upsert (no REPLACE), call `ctx.touch`, refuse with sentences, collect blobs and return `released` where they can drop one.
- [ ] Search text in `text_of`; `mark_for_index` / `DEPENDENTS` cover linked and labelling rows; incremental index equals rebuild.
- [ ] Sealed cells never indexed, logged or copied.
- [ ] App `manifest.json` scopes (reads and `act` commands), actions and queries updated; no SQL outside the confined crates.
- [ ] Year-3 test extended for any hot or growing read; query-plan test green without a new ledger row.
- [ ] CHECK, delete-rule and timestamp sweeps done.
- [ ] Gate profile run (or the part that cannot run on Linux named).
- [ ] If a commitment changed, the vault-ontology doc updated in the same PR.
