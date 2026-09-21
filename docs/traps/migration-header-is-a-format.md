# Trap: a migration's comment header is part of the backup format

## What goes wrong

You edit a comment at the top of `contracts/migrations/001_baseline.sql` — fixing a typo, repointing a stale issue link, adding a line saying what a rung now drops. Every test passes. Then a build that ships after your edit cannot open a backup generation a build before it sealed, and the failure reads `DictionaryMismatch` from somewhere in `crates/vault/src/backup`, nowhere near a migration.

**The zstd dictionary a backup is compressed against is trained from the migration ladder's text, and the training corpus is the file's _bytes_ — comment lines included.** A one-character edit to a header moves the trained dictionary, the dictionary's id is its BLAKE3, and every base and segment header names the id it was sealed against. So a comment is a format decision, and nothing about the file says so.

Paid for by [#1029](https://github.com/srikanth235/centraid/issues/1029) W19, deviation 3: an edit to `001_baseline.sql`'s header moved the shipped dictionary's id, and the file was restored to its committed bytes rather than the dictionary being re-shipped.

## Why it is built this way

The corpus has to be something both ends already hold, or the dictionary would have to travel — and a dictionary that can be absent is a generation that can be unopenable ([R-1029-6](../decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)). The migration ladder is the one text every build of a given schema version has byte-identically, which is exactly what makes it a good corpus and exactly what makes it fragile: nothing distinguishes the SQL from the prose around it, because the trainer does not read SQL.

The second half of the guard is that the dictionary **also** rides inside each generation manifest, so a generation sealed against an older dictionary still opens. That is what turns this trap from data loss into a fixture churn — but only for generations already sealed. A rung edited between two builds still means two builds that compress differently.

## The rule

- **Rungs one to four are byte-immutable.** `contracts/migrations/00{1,2,3,4}_*.sql` are not edited, for any reason, including a comment. A correction is a new rung.
- **Rung five and anything above it is appended, never inserted and never edited** once it has shipped in a build that sealed anything.
- If a rung's prose is genuinely wrong, say so **in `docs/`**, next to the schema it describes, and link the rung. Docs are free; the ladder is not.
- Regenerating `contracts/schema/vault-ddl.sql` (`cargo run -p centraid-vault --bin export-ladder-ddl`) is safe and expected — that file is derived and is not the corpus.

## How to tell you have done it

```sh
git diff --stat contracts/migrations/
```

Non-empty against an already-released rung is the finding, whether or not the diff is all `--` lines. `crates/vault/tests/ladder_ddl.rs` checks that the DDL is regenerable; it does **not** check that the ladder's bytes did not move, because the ladder's bytes are the input.

## Related

- [../decisions.md](../decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21) — R-1029-5, R-1029-6
- [wal-checkpoint.md](wal-checkpoint.md)
- `crates/vault/src/backup/` — seal, manifest, dictionary recovery
