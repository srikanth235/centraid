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
| A write | nothing in `ToolSpec` or `Route` can carry one |
| A persisted transcript | a `Session` is a `Vec<Turn>` in memory; there is no table and no file |
| A tool name that drifts | `tests::the_tool_names_are_the_fine_tunes_targets` |
