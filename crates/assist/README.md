# `centraid-assist` — the on-device chat plane

Centraid is visual-first, and so is its chat: an answer is **one short line of model text and result cards** — real rows (a task, a photograph, a ledger line, a person) that the app's own tile draws and taps through to. The model routes and phrases; the apps draw the data. The model is a small language model that runs **on the phone** (llama.cpp, in [`crates/assist-llama`](../assist-llama/src/lib.rs), over a GGUF file the shell downloaded), and v1 is **read-only**: it may name a read an app already answers, and say one sentence about what came back.

This crate is the plane, and none of the engine or the vault. The vault side is [`crates/core`](../core/README.md)'s `assist` module (`Request::Assist`, `assist.proto`); the engine side is a [`Model`](src/model.rs) implementation.

| Module | What it owns |
| --- | --- |
| [`tool`](src/tool.rs) | The registry: one `<app>.<verb>` row per read, 18 today. Names are the fine-tune's training target and are pinned by a test. **Locker has no `App` variant**, so no tool, scope or prompt can name it. |
| [`call`](src/call.rs) | A route — a call, `none`, or a direct answer — and its one canonical JSON spelling. |
| [`grammar`](src/grammar.rs) | The GBNF the engine decodes under, generated from the same registry, with a small matcher in its tests so the grammar's meaning is proven here and not discovered by an engine. |
| [`prompt`](src/prompt.rs) | Qwen3.5's ChatML and the 2K-token budget: system prompt, the tool list (the scoped app's first), the last two turns that read or answered (a refusal is never shown), one read's digest, and the phrase prompt. **`PromptStyle`** is the one switch for how much the prompt coaches: `Stock` (the default: tool hints, rules, worked routes) or `FineTuned` (the compact prompt a trained model is exported with). Every generation prompt ends with the empty thinking block Qwen3.5's own template renders when thinking is off (`ASSISTANT_TURN`). |
| [`model`](src/model.rs), [`host`](src/host.rs) | The `Model` trait (prompt, grammar, token ceiling, stop strings, a streaming callback and a cancel token) and the slot a loaded model lives in. |
| [`turn`](src/turn.rs) | The loop: route → one read → phrase → cards, every way out a typed `Refusal`. |
| [`result`](src/result.rs) | What a read answers: cards, and a deterministic digest for the model. |
| [`suggest`](src/suggest.rs) | Three questions the current vault can answer, with its own names and titles in them. |
| [`eval`](src/eval.rs), [`cli`](src/cli.rs), [`bin/assist-eval`](src/bin/assist-eval.rs) | The routing eval set, its JSONL export, the accuracy harness and the `assist-eval` command line. This crate links no engine; [`assist-eval-llama`](../assist-llama/src/bin/assist-eval-llama.rs) is the same command line with llama.cpp, and the only one that takes `--model`. |
| [`native`](src/native.rs) | The native tool runtime, moved here from `crates/nativetools` (#1088, R-1088-4): eight flat tools over a vault, one metadata table they are all generated from, the date-expression evaluator, observations, the system prompt and the `Session` that runs a call. The fine-tuning loop and the phone run this one runtime; `crates/nativetools` keeps its binary, the world seeder and the export. `native::transcript` renders a session as the one text the model is trained, scored and prompted on (`render.py` is its Python client), and `native::step::decode_step` writes one assistant message through any [`model::Model`] (the think guard, the call rendered from the think, one call per message; no grammar). It holds no vault and no path: every read and write goes through its [`Door`](src/native/door.rs) trait (paged table reads, typed commands, ids, the clock, sealed cells), which the harness implements over a vault file and the core implements over the phone's vault. It never writes SQL. `Flags::locker` is the Locker policy: on for the harness, off on the phone, where no Locker table or sealed column is read and a call that names a Locker kind or `reveal` ends in `decline sealed_egress` (R-1088-3). `Flags::writes` is the write policy: `Run` (the harness: the vault runs every step) or `Park` (the phone, [`park`](src/native/park.rs)): the steps of a turn's writes are applied to an in-memory patched copy of the world and the turn ends in one `PendingWrite` that `Session::confirm` runs through the door under a key per step and `Session::dismiss` (or any new message) drops (R-1088-2, R-1088-6, R-1088-10). Events are read in the person's own zone through `Door::events`, which is Agenda's `occurrences` (R-1088-8). |
| [`native_turn`](src/native_turn/mod.rs) | The native turn loop (#1088): `NativePlane` drives a `native::Session` the way the fine-tuning driver does (`user`, render the log, `decode_step`, `call_text`, up to `STEP_CAP` steps, a cancel checked between steps), with an `Activity` event per looking step. A turn ends in the chat's existing `Card` (the one kind to app and entity table, [`cards`](src/native_turn/cards.rs): thirteen kinds into the seven apps, row routes for the kinds the shell opens and the app's home for the rest) and in a line the runtime composes from the final effect out of `copy/chat.json` ([`words`](src/native_turn/words.rs), the `SAID_` keys; a count, a value, the ask's question, a decline reason): no second generation (R-1088-10). [`log`](src/native_turn/log.rs) is the conversation the model reads, rendered with `native::transcript`. A `NativeChat` is one chat's session in memory; the caller opens a fresh one for a reopened thread, a retry or a failed turn, and between kept turns the session's clock follows the request (`Session::set_clock`: the person's now and zone, the world read again). The session runs `Writes::Park` (R-1088-2): a write is planned against a patched world and the turn ends in one pending write that has touched nothing, said as "Proposed: …" and sunk as `Event::Pending(PendingCard)` for the core to surface; `NativeChat::confirm` runs its steps through the door, one key per step, and `dismiss` or a new message drops it. A Locker call never parks: the session declines it `sealed_egress`. |
| [`testing`](src/testing.rs) | Deterministic stand-ins: a scripted model, an oracle that says what a case expects, one that stalls until cancelled, a canned reader. |

## What a turn is

1. **Route.** The model, under the route grammar, emits `{"tool":NAME,"args":{…}}`, `{"tool":"none"}` or `{"answer":TEXT}`. A tool the budget dropped is unsayable.
2. **Read.** One call, once, through [`Reader`](src/turn.rs) — which `crates/core` implements over the query path a screen uses. This crate holds no SQL and no connection.
3. **Phrase.** The model, under a one-line grammar that cannot open with `{`, a quote or a bracket, says one sentence over the read's digest (a stock model gets a short conversation of its own for this, not the route's). An empty or unusable sentence — talk about the model's own task, a banned copy word, or a number the read does not hold — falls back to the read's own headline.
4. **Cards.** The first six rows, streamed as soon as the read returns.

**One read per turn in v1.** A write would be a second kind of route that parks behind a confirm card; nothing here can express one yet, on purpose.

## The eval set

[`contracts/assist/eval-cases.json`](../../contracts/assist/eval-cases.json) — 65 questions over the sample vault's Tahoe weekend, each with the call a correct model makes (`none` and direct answers included), the apps' scoped variants and follow-ups that depend on the last two turns. It is read four ways: by the plane's end-to-end test in `crates/core`, by `assist-eval`, as the fine-tune's eval set (`--export-jsonl`: the prompt exactly as the phone sends it, the completion exactly as the grammar spells it), and by the grammar test.

```sh
cargo run -p centraid-assist --bin assist-eval -- --oracle                  # the plane, against a model that reads the fixture
cargo run -p centraid-assist --bin assist-eval -- --export-jsonl out.jsonl  # prompt/completion pairs, in the style the phone sends (stock)
cargo run -p centraid-assist --bin assist-eval -- --style fine-tuned --export-jsonl out.jsonl  # the compact prompt, for a fine-tune that does not want the coaching
cargo run -p centraid-assist --bin assist-eval -- --grammar tally           # the route GBNF, Tally's tools first
cargo run --release -p centraid-assist-llama --bin assist-eval-llama -- --model FILE.gguf   # a real model: accuracy, real token counts, latency
```

## What stops this crate doing more

| Not allowed | What stops it |
| --- | --- |
| SQL, in any form | `sql-confinement` scans this crate; a read is a name and arguments handed to `Reader` |
| Locker in a prompt, a tool list or a scope | `App` has no such variant; `tests::locker_is_in_no_tool_and_in_no_scope`, and the eval fixture refuses it |
| Locker on the phone surface | `native::Flags::locker` off: `World::load_with` skips the Locker table and its sealed columns, and `Session::locker_off_decline` ends any call naming a Locker kind or `reveal` in `declined: sealed_egress` (`crates/nativetools/tests/locker_off.rs`) |
| A write, in the read-only plane | nothing in `ToolSpec` or `Route` can carry one; the `native` runtime writes through typed vault commands only, and on the phone only when the member confirms a card (`Writes::Park`; the core's door refuses a bare `run`) |
| A write on the phone before the member's tap | `Flags::writes` = `Park`: no step reaches the door until `Session::confirm`, which refuses a stale card (`crates/nativetools/tests/park_confirm.rs`); the patch is held to the vault by `tests/park.rs` and `experiments/toolchat/native/authored/park_oracle.py` |
| A persisted transcript | a `Session` is a `Vec<Turn>` in memory; there is no table and no file |
| A tool name that drifts | `tests::the_tool_names_are_the_fine_tunes_targets` |
