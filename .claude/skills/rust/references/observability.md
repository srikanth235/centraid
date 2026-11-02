# Logging and tracing

Open this when adding a log line, a subscriber, or a diagnostic id. Where logs land per host, and the first step of every debug session, is [docs/logs.md](../../../../docs/logs.md). Pack rules: [obs-tracing-over-log](rules/obs-tracing-over-log.md), [obs-library-facade](rules/obs-library-facade.md), [obs-structured-fields](rules/obs-structured-fields.md), [obs-levels-filter](rules/obs-levels-filter.md), [obs-error-chain](rules/obs-error-chain.md), [obs-no-sensitive-data](rules/obs-no-sensitive-data.md), [obs-instrument-spans](rules/obs-instrument-spans.md) (see the override in [CENTRAID.md](../CENTRAID.md)).

## How the tree does it

| Fact | Where |
| --- | --- |
| `tracing` is the only facade (`tracing::warn!(...)` fully qualified; about 70 call sites). `tracing-subscriber` is a dependency of binaries only: `centraid` and the gateway | `Cargo.toml` of `centraid`, `gateway` |
| A binary installs the subscriber to **stderr** with an `EnvFilter`: `--log`/`CENTRAID_LOG` for `centraid` (default `centraid=info`), `RUST_LOG` for the gateway (default `info`). Stdout is the interface and stays parseable | `install_tracing` in `crates/centraid/src/run.rs`, [logs.md](../../../../docs/logs.md) |
| `centraid-core-ffi` emits events and installs no subscriber, so on a device they are dropped; what a caller must know travels in the returned error | [logs.md](../../../../docs/logs.md#mobile) |
| The gateway writes fields: `tracing::warn!(%error, "purge sweep failed")`, `tracing::info!(purged, "purge sweep")`. A sweep logs counts only | `crates/gateway/src/server/sweeps.rs` |
| No `#[tracing::instrument]` and no spans in the tree |  |
| Integration tests print nothing unless they install a subscriber; `tracing` caches an `Interest` per callsite process-wide, so a thread-local dispatcher from one test can leave a callsite disabled for another (`rebuild_interest_cache`) | [logs.md](../../../../docs/logs.md) |

## Always

- Use fields for values (`%error`, `?value`, `count`), a short static message, lowercase.
- Pick the level by who acts: `error` is rare and means the product is broken, `warn` a degraded step that was handled, `info` an operator event, `debug` for diagnosis.
- Log once, where the error is handled. If you return it, do not log it as well.
- Log with enough to find the cause (ids, counts, which step) and nothing that is the member's.

## Never

- A seed, key, token, pairing secret, passphrase word, file path of an original, or vault content in a log line or an error message.
- `println!`, `eprintln!` or `dbg!` in library `src`.
- A subscriber installed from a library, or a global one from a test without `rebuild_interest_cache`.
- A new span or `#[instrument]` without a reason a field cannot carry, and never one that records arguments (they may hold secrets).
