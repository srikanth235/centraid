# The model pin, the adapter, the debug-only loaders

The assistant is the pinned model (the base) plus, when the release names one, a small adapter that is on for vault turns only. Cloud and upload rules are in [safety.md](./safety.md).

## The record

- [`crates/assist/model.json`](../../../crates/assist/model.json) holds `current`, `previous` (the two-model window) and an optional `adapter`. [`record.rs`](../../../crates/assist/src/record.rs) reads it, and nothing else types a URL, hash or size.
- An entry has: a Hugging Face URL pinned to a 40-character commit, file name, SHA-256, size in bytes, `tools_mode`, `tools_hash`, `prompt_hash`, the sorted `special_tokens` and where they came from (`file` or `declared`), and a score.
- An adapter entry has the URL, SHA-256 and size, `base_sha256` (the base it was trained against), the same two hashes, and a score.
- Today the record names a base, no `previous` and no adapter. Its token list is `declared`, and the release profile refuses a declared list, so a release needs a re-pin from the file.
- Only `cargo xtask model-pin` writes it ([`model_pin.rs`](../../../crates/xtask/src/model_pin.rs)). It fetches and uploads nothing.
  - Base: `--url --file --tools-mode [--score] [--replace]`. Size and SHA-256 come from the file. The hashes come from `cargo run -p centraid-assist --example runtime_hashes`. The tokens are read from the GGUF metadata. The standing entry becomes `previous` unless `--replace`.
  - Adapter: `--adapter-url --adapter-file [--adapter-score]`, written against the base the record then pins. `--no-adapter` removes it. Pinning a new base drops an adapter made for the old one.
- The gate step `model-record` runs [`tests/model_record.rs`](../../../crates/assist/tests/model_record.rs). It refuses a hash that differs from the runtime's, a URL that is not a commit, an adapter made for another base or catalogue, and the same file pinned twice. On the `release` profile it also refuses a declared token list. What moves the hashes: [contract.md](./contract.md).

## What the phone does with it

- The shell fetches a pinned file only when the member asks. A phone holding `previous` keeps chatting and is offered `current` in a row above the composer. The new file is fetched beside the old, loaded, then the old one is deleted. An older model says an update is needed.
- [`adapter::decide`](../../../crates/assist/src/adapter.rs) is the one rule. The adapter is used only while the release names one, it was trained against the base in use, it was trained on this build's catalogue and prompt, and its file is on the phone at the recorded size. Anything else is the stock model under the same grammar, with no error shown.
- The local name is `centraid-adapter-<first 12 hex of the SHA-256>.gguf`, so a newer adapter is a different file. Cases are in `contracts/assist/adapter-cases.json` and `adapter-offer-cases.json`.
- `adapter::for_vault_turn` is the per-turn switch. The core wraps the model in `Switched` for a native turn only. An attached or free reply never turns it on.
- The download quotes base plus adapter as one size and runs through one `ModelDownload` effect. An adapter that does not arrive or will not load leaves the base alone.
- The engine reads the adapter header first ([`assist-llama/src/adapter.rs`](../../../crates/assist-llama/src/adapter.rs)) and refuses a file that is not an adapter or is for another architecture. The host then loads the base alone.
- A model loaded before its adapter arrived counts as not ready. It reloads when no turn is running, or the next time the tab opens.
- An adapter file the release does not name is removed as a leftover when the model in use is the current one.

## Debug-only loaders that cannot ship

- `CENTRAID_DEV_MODEL=<repo>@<commit>/<file>`, with `CENTRAID_DEV_MODEL_SHA256` and `CENTRAID_DEV_MODEL_BYTES`, swaps in a named file for the pin. It keeps the pinned entry's hashes and clears `previous` and the adapter. It lives in `record.rs`.
- `CENTRAID_DEV_CHAT_SCRIPT=<json>`, or on Android the file `/data/local/tmp/centraid-dev-chat-script.json`, puts a scripted model in the slot with no weights. It lives in [`assist-llama/src/lib.rs`](../../../crates/assist-llama/src/lib.rs). The mobile Maestro flows use both.
- Each read sits in a function under `debug_assertions`, with a release twin that looks at nothing.
- [`dev_paths.rs`](../../../crates/xtask/src/dev_paths.rs) proves it two ways. `source_gaps` fails when any name in `NEEDLES` is read in a function that is not gated. The `release-build` step then scans the release build's linked outputs for the names, and fails when it finds no core library to look in.
- A new debug-only name goes into `NEEDLES` in the same change.
