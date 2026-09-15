# `contracts/apps/docs` — Docs' parity fixtures

Generated from the pinned v0 tree by `contracts/tools/export-docs-parity.ts` (with `docs-parity-bundle.ts` and `docs-parity-share-plane.ts`), and asserted in both directions by `tests/quality/docs-parity.contract.test.ts`. Never typed by hand: a fixture typed by hand says what its author believed the handlers do.

| File | What it is |
| --- | --- |
| `rows.json` | every row of the twenty tables the four queries read, by table, with the committed DDL as its schema (D-1020-D3-11: rows, not a `.db.gz`) |
| `queries.json` | `{query, input, output}` for `drive`, `search`, `history` and `activity`, at fixed inputs — the declared window, its floor, its ceiling and both clamps |
| `commands.json` | the ordered `core.*` **script**, with every id the run minted replaced by `{"$from": "<step>.<key>"}` so a Rust replay resolves it against its own ids |
| `scenarios.json` | the three ontology drifts a document is subject to: ONT-22 (two byte-identical files keep separate histories), ONT-26 (the sha's shape), ONT-28 (one byte row read two ways) |

## Regenerating

```
bun install && bun run build
CENTRAID_WRITE_CONTRACTS=1 node node_modules/vitest/vitest.mjs run \
  --config vitest.quality.config.ts tests/quality/docs-parity.contract.test.ts
bun run format && git diff --exit-code contracts/apps/docs
```

The last line is the idempotency check and it is part of the contract: a generator whose second run writes different bytes is not a generator, it is a clock. Verified for this bundle.

## What the corpus deliberately contains

Each of these is a fold that would otherwise agree with a port that does nothing.

- **A nested folder that survives to the final state.** The drive's rail is a tree and a share walks up it; a corpus of flat folders cannot tell a working chain from a chain of length one — which is the v0 defect this lane fixed at source (R-1020-35, the `broader_concept_id` projection).
- **A share on the GRANDPARENT of a filed document**, so the walk is two steps, plus a share on a document itself: the two `via` values in one corpus.
- **A circle audience and a person audience**, so the label is the circle's name in one row and the person's in the other.
- **A delivered pass and a pass still syncing**, so `pending_count` is a number the fold computed rather than a zero.
- **A revoked answer**, which the READ must filter rather than the fold.
- **An inbound subscription** whose lineage names a document with no folders-scheme tag of its own — the whole reason the origin read is a second door into the drive.
- **Eight refusals in the command script**, because a script of only happy paths cannot tell a port that reproduces the gates from one that has none.

## Two things the fixture states rather than hides

**`activity` is refused for every caller, the owner included.** The gateway's paged door serves only tables registered as entities and `access_provenance` is not one, so `docs.activity.provenance` is refused at `packages/vault/src/gateway/paged-door.ts:436` and Docs' activity rail has never shown an event. The `activity` cases carry that exact refusal; the Rust side reads the events that are actually there. The day the door admits the audit band, the oracle fails and the finding is re-judged rather than quietly carried.

**The share plane is written directly, not through commands.** `share.*` has three commands in v0 and all three are container-routed writes belonging to the peer plane, which is a later lane (census §Cross-lane: `share_*` is read-only for Docs). The rows are written with the vault's own DDL, the way the ontology-scenario fixtures are.

## The instants

Every case is stamped at `2099-06-01T09:00:00.000Z` and after. The epoch is in the far future because the vault has TWO clocks: a condition comparing `purge_at` against SQLite's own `now` cannot be held still by a JS proxy, and `core.restore_document`'s precondition is exactly such a comparison. The Rust port took the other road — its conditions read `:ctx_now` — so the same fixture is reproducible at any instant. Instants SQLite wrote itself are tokenised as `(host-clock)`, parenthesised because `(` sorts below every digit under BINARY collation and a tokenised instant must still sort where the real one did.
