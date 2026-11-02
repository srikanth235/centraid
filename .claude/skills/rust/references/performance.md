# Performance and budgets

Open this before optimising, before adding work to a request path, or when a budget step is red. The diff rules are in [centraid-engineering](../../centraid-engineering/SKILL.md#state-and-cost); the pack rules are the `perf-`, `mem-`, `opt-` and `anti-premature-optimize` files in [rules-index.md](rules-index.md) (several are overridden, see [CENTRAID.md](../CENTRAID.md)). Background: [The Rust Performance Book](https://nnethercote.github.io/perf-book/) (MIT/Apache-2.0).

## How this repository measures

| Question | Instrument |
| --- | --- |
| Is a bounded read through `call` still fast? | `cargo test --workspace --test call_budget`: p95 of one page request over a seeded vault, against `contracts/ledgers/call-budget.json` (a down-only ceiling, per hardware profile). It catches a regression in the call path, such as a lock held too long |
| Is search still fast at year-3 volume? | `cargo test --release --workspace --test search_budget -- --nocapture --include-ignored`, against `contracts/ledgers/search-budget.json`, over the corpus in `crates/apps/kit/src/search_corpus.rs` |
| Does a query still use its index? | `crates/core/tests/query_plans.rs`, against `contracts/ledgers/query-plans.json` |
| Did the edit-run loop get slower? | `cargo xtask measure --write` into `contracts/ledgers/compile-time.json` |
| Does a write cost what it did? | `crates/core/tests/write_costs.rs` |

Both budget steps are in the `pr` gate. A ceiling moves down with the measurement and never up to make a run pass; a ceiling with no stated volume is not a budget ([centraid-engineering](../../centraid-engineering/SKILL.md#state-and-cost)).

## Always

- Measure first with the instrument above; a perf change states the volume and the number before and after.
- Bound the work: `LIMIT`, a cursor, a fixed digest, a cap per pass. Move unbounded work to a worker, a paged job or a streaming API.
- Compute a shared derived value once and fan it out.
- Prefer iterators and borrowing to indexing and cloning; `with_capacity` when the size is known; reuse a buffer in a loop. These are cheap and local.
- Keep the release profile as `Cargo.toml` states it; do not change `lto`, `codegen-units`, `panic` or debuginfo in a feature change.

## Never

- An O(vault-size) scan, a whole-blob hash or a re-index on a request path or an event loop.
- A comment that says "the table is small" as the bound.
- A new dependency, `unsafe`, or a thread pool for a speed-up nobody measured.
- A second SQLite connection to "parallelise" reads ([threads-and-locks.md](threads-and-locks.md)).
