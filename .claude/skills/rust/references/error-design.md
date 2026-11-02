# Error design

Open this when adding an error enum, a variant, a conversion, or a refusal that reaches a shell. The decision table is in [SKILL.md](../SKILL.md#errors-and-panics); the pack rules are [err-thiserror-lib](rules/err-thiserror-lib.md), [err-source-chain](rules/err-source-chain.md), [err-from-impl](rules/err-from-impl.md), [err-doc-errors](rules/err-doc-errors.md), [err-lowercase-msg](rules/err-lowercase-msg.md), [err-context-chain](rules/err-context-chain.md); the Rust API Guidelines' error items (C-GOOD-ERR, C-FAILURE) are in [guides/rust-api-guidelines.md](guides/rust-api-guidelines.md).

## How the crates do it

1. **One `thiserror` enum per crate (or per plane), and a `Result<T>` alias** beside it: `CoreError` in `crates/core/src/error.rs`, `VaultError` in `crates/vault/src/error.rs` (plus `BlobError`, `PlaneError`), `StoreError` in `crates/blobs`, `OntologyError`, `ProtocolError`.
2. **A variant per distinct remedy.** `Unpaired` ("create one, or restore one"), `Unavailable` (wake the gateway) and a gateway that answered and refused are separate variants because the caller's next step differs. A variant a caller would handle identically to another is merged.
3. **The module header states the rules the enum is written to.** `crates/vault/src/error.rs` opens with "a deny is an outcome, not an exception" and "a refusal a caller must act on differently gets its own variant". Do the same when adding a plane's errors.
4. **The wire mapping is one function.** `CoreError::code()` maps every variant to exactly one `ErrorCode`; it is a `match` rather than a `#[repr]` so a new variant has to choose. Adding a variant means adding an arm, and an `ErrorCode` a shell cannot branch on differently is not added.
5. **Messages are for a person**, lowercase, no trailing punctuation, with the offending value (`"this file already holds vault {vault_id}; found into a fresh file"`). They never carry a secret.
6. **A panic is a different channel.** It poisons the handle at the C ABI and is reported with a diagnostic id; it is not an error variant.

## Always

- Put the cause in the chain: `#[from]` for a plain wrap, `#[source]` plus a context field when you add information. A conversion that discards the underlying error (`map_err(|_| ...)`) loses the one thing a reviewer needs.
- Document the failure modes of each fallible `pub fn` under `# Errors`, naming the variant.
- Return a value, not an error, for an expected outcome (a deny, an empty page, "not found" a caller branches on).
- Keep `anyhow` and `.context()` to binaries and xtask; a library error is matchable.
- Add `#[non_exhaustive]` only to an enum that crosses a published seam; the crates are `publish = false` and in one workspace, so exhaustive `match` in callers is the safety net you want.

## Never

- A catch-all `Other(String)` variant, a `Box<dyn Error>` field, or matching on a message string.
- Logging an error and also returning it ([observability.md](observability.md)).
- A new `ErrorCode` for convenience; the enum is closed and wire-versioned ([protobuf-prost.md](protobuf-prost.md)).
