# Receipt — issue #792: Memories idle sweeps write no projection rows

## Checklist

- [x] Give `rebuildMemories` an input-fingerprint memo and compare-then-write
      behavior equivalent to the duplicate-cluster projection.
- [x] Preserve deterministic rebuilds and repair after projection deletion.
- [x] Prove a no-change sweep writes zero rows without weakening the G2 scale
      law or budget.

## What changed

`packages/vault/src/enrich/memories.ts` now passes the ordered live asset
signals, populated phash clusters, and resolved home place through the focused
`packages/vault/src/enrich/memories-fingerprint.ts` projection-memo helper. The
helper fingerprints that source together with the persisted logical
projection. A byte-identical pass reuses its per-connection memo before
regrouping. After a restart or any fingerprint change, it derives the desired
rows and compares their fingerprint before opening the repair transaction.
`computed_at` is deliberately excluded from logical projection identity, so a
new sweep clock alone cannot dirty the WAL.

Persisted `media_memory` and `media_memory_member` rows participate in the
fingerprint. Deleting or corrupting either table therefore invalidates the
memo, and the next pass deterministically restores the projection rather than
mistaking unchanged sources for a safe short circuit.

`packages/vault/src/enrich/memories.test.ts` measures SQLite `total_changes()`
around an idle rebuild and requires zero writes. It also keeps the drop-and-
rebuild regression and now requires that path not report reuse.

`docs/photos/derived-ledger.md` records the fingerprint, logical comparison,
zero-write idle behavior, and repair invariant as current state.

### Checklist crosswalk

- **Give `rebuildMemories` an input-fingerprint memo and compare-then-write
  behavior equivalent to the duplicate-cluster projection.** The source plus
  projection state is hashed per connection, and desired rows are compared
  before any `BEGIN IMMEDIATE` or projection mutation.
- **Preserve deterministic rebuilds and repair after projection deletion.**
  Deterministic keys and ordering are unchanged; persisted rows invalidate the
  memo, and the existing deletion test proves restoration.
- **Prove a no-change sweep writes zero rows without weakening the G2 scale law
  or budget.** The focused unit test observes zero `total_changes()`, and the
  unchanged 90k G2 rig recorded `idle rows written = 0`; its cold-time ceiling
  was not changed.

- **Input-fingerprint memo and compare-then-write** — source plus projection
  state is hashed per connection, and desired rows are compared before any
  `BEGIN IMMEDIATE` or projection mutation.
- **Preserve deterministic rebuilds and repair after projection deletion** —
  deterministic keys and ordering are unchanged; persisted rows invalidate
  the memo, and the existing deletion test proves restoration.
- **Prove a no-change sweep writes zero rows** — the focused unit test observes
  zero `total_changes()`, and the unchanged 90k G2 rig recorded `idle rows
  written = 0`; its cold-time ceiling was not changed.

## Out of scope

Gateway sweep scheduling/timing, scale budgets, test-matrix ownership, and the
other filed issues are unchanged. The repair transaction still replaces the
whole projection when logical rows differ; issue #792 requires eliminating
idle churn, not designing a row-level incremental Memories engine.

## Decisions

The fingerprint includes persisted logical rows as well as source inputs. A
source-only memo would make deletion repair incorrect on the same connection.
`computed_at` is omitted because it is an audit timestamp, not a grouping
input; treating each new clock value as identity would recreate the defect.

## Verification

```sh
bun install --frozen-lockfile
bun run build --filter=@centraid/vault
bun run --cwd packages/vault test -- src/enrich/memories.test.ts
bun run --cwd packages/vault typecheck
bun run test:scale -- tests/scale/phash-clustering.scale.test.ts
```

- Frozen install: passed, no lockfile changes.
- Targeted build: 4/4 dependency tasks passed.
- Memories unit regression: 1 file, 10/10 tests passed.
- Vault package typecheck: passed.
- Unchanged 90k G2 scale rig: recorded `idle rows written = 0` and an idle
  sweep of 774.67 ms. The command exited red only on the independent cold
  budget assertion (51.50 s measured versus the unchanged 30 s ceiling while
  concurrent work was active); the ceiling and rig were not edited.
- The first unit-test attempt could not resolve unbuilt `@centraid/blob-format`
  output in the fresh worktree; the documented filtered build fixed the
  environment, after which the exact test command passed.

## Audit

PASS — fresh-context audit by `/root/receipt_audit_792_796`: the receipt mirrors
issue #792, names every issue-owned changed file, and its no-write/repair claims
match the implementation and focused 10/10 regression run.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-15 | codex | 01a003d7-1e6b-7d00-86a3-4831e330af63 |
