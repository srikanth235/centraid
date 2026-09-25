# `contracts/apps/docs` — Docs' parity fixtures

A **frozen golden**, read by `crates/apps/docs/tests/parity.rs`. It was captured by running the TypeScript tree's own Docs handlers before that tree was removed in [#1020](https://github.com/srikanth235/centraid/issues/1020), so it records what an independent implementation answered rather than what an author believed the handlers do. Its generator went with that tree: a change to these files is a reviewed change in expected behaviour, never a hand-typed convenience.

| File | What it is |
| --- | --- |
| `rows.json` | every row of the twenty tables the four queries read, by table, with the committed DDL as its schema (D-1020-D3-11: rows, not a `.db.gz`) |
| `queries.json` | `{query, input, output}` for `drive`, `search`, `history` and `activity`, at fixed inputs — the declared window, its floor, its ceiling and both clamps |
| `commands.json` | the ordered `core.*` **script**, with every id the run minted replaced by `{"$from": "<step>.<key>"}` so a Rust replay resolves it against its own ids |
| `scenarios.json` | the three ontology drifts a document is subject to: ONT-22 (two byte-identical files keep separate histories), ONT-26 (the sha's shape), ONT-28 (one byte row read two ways) |

## What the corpus deliberately contains

Each of these is a fold that would otherwise agree with a port that does nothing.

- **A nested folder that survives to the final state.** The drive's rail is a tree and a share walks up it; a corpus of flat folders cannot tell a working chain from a chain of length one — a defect fixed at source (R-1020-35, the `broader_concept_id` projection).
- **A share on the GRANDPARENT of a filed document**, so the walk is two steps, plus a share on a document itself: the two `via` values in one corpus.
- **A circle audience and a person audience**, so the label is the circle's name in one row and the person's in the other.
- **A delivered pass and a pass still syncing**, so `pending_count` is a number the fold computed rather than a zero.
- **A revoked answer**, which the READ must filter rather than the fold.
- **An inbound subscription** whose lineage names a document with no folders-scheme tag of its own — the whole reason the origin read is a second door into the drive.
- **Eight refusals in the command script**, because a script of only happy paths cannot tell a port that reproduces the gates from one that has none.

## Two things the fixture states rather than hides

**`activity` is refused for every caller, the owner included.** The captured implementation's paged door served only tables registered as entities and `access_provenance` is not one, so `docs.activity.provenance` was refused and the `activity` cases carry that exact refusal. The Rust side reads the events that are actually there.

**The share plane is written directly, not through commands.** `share.*` had three commands in the captured implementation and all three were container-routed writes belonging to the peer plane, which is a later lane (census §Cross-lane: `share_*` is read-only for Docs). The rows are written with the vault's own DDL, the way the ontology-scenario fixtures are.

## The instants

Every case is stamped at `2099-06-01T09:00:00.000Z` and after. The epoch is in the far future because the vault has TWO clocks: a condition comparing `purge_at` against SQLite's own `now` could not be held still while capturing, and `core.restore_document`'s precondition is exactly such a comparison. The Rust side's conditions read `:ctx_now`, so the same fixture is reproducible at any instant. Instants SQLite wrote itself are tokenised as `(host-clock)`, parenthesised because `(` sorts below every digit under BINARY collation and a tokenised instant must still sort where the real one did.
