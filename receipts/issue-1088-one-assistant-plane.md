# Issue #1088 — one assistant plane: the phone and the fine-tuning loop run the same harness

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section below and never edits a section above it. Rulings: the #1088 section of [docs/decisions.md](../docs/decisions.md#one-assistant-plane-1088) (R-1088-1 to R-1088-10).

## Checklist

- [x] **Wave 1, L1 — derive and export**: enums equal the vault's CHECK lists, every mapped write is exercised, one model-identity constant, the export committed and drift-checked.
- [x] **Wave 1, L2 — one compiler**: the stateless think compiler and the v3.1 to v4 rewrite in Rust; Python calls it; `trace.py`'s copy deleted.
- [x] **Wave 1, census A**: both assistant stacks mapped for the fusion; fourteen open decisions put to the owner or settled by recommendation (R-1088-6 to R-1088-10).
- [ ] **Wave 2a — the runtime folds into `crates/assist`** behind a `Door` over the core's vault, Locker off on the phone surface; the transcript renderer and the free decode step in Rust.
- [ ] **Wave 2b — park and the turn loop**: writes plan against a patched `World` and park as one card (R-1088-6); events read in local days (R-1088-8); the assist/core turn loop with cards (R-1088-7) and runtime-composed words.
- [ ] **Wave 2c — the confirm card and the deletions**: additive proto, the KMP machine and the iOS card; the 18-tool registry, its grammar, router prompt and eval cases deleted.
- [ ] **Wave 3 — close**: docs pass; phase E (promotion out of `experiments/`, and the data move, on the owner's go); phase B after #1044's training steps (R-1088-1).

## Evidence: wave 1 (2026-10-07)

Two lanes in worktrees, Sonnet workers, merged into `claude/qwen-sanity-harness` at `a403eaf0e`. On the merged tree: `cargo xtask gate --profile local` passes (fmt, clippy, the workspace tests in 1,188 s, restore-drill, rules, ledgers); val v7.4 refreezes byte-identical on the release runtime (655 / 655, UNEXPLAINED 0; the refreeze report is identical line for line to the one before the wave).

| lane | commits | what it proves |
| --- | --- | --- |
| L1 derive + export | `1429d616f`, `a21caa49b`, `5c9850b26`, `495ffd17b`, `0fb0f51d0` | nativetools 892 tests (887 + 5); 50 train records render byte-identical (sha256 `32d6b986…`); the `cells.py` universe unchanged |
| L2 one compiler | `b4b006f32`, `dad025f38`, `4eab11c4a`, merge `a403eaf0e` | 67,889 thinks compile identically in Python and Rust (md5 equal), refusals (20,846) and v4 skips (12,398) included; nativetools 912 tests; free decoding identical (case B, 12 steps); T33 builds identically with the old code and the new |

- **Enums.** `tests/meta.rs` holds each enum equal to its CHECK list, gaps declared in `meta::UNEXPOSED` (empty), and the task status against `schedule.set_task_status`'s schema; `LOCKER_TYPES` is built from the vault's `ITEM_TYPES`. Debt direction and status have no CHECK to hold them to.
- **Writes.** `tests/verb_coverage.rs` drives all 64 `(verb, kind, command)` pairs of `meta::VERBS` against the fixture world; each lands in the invocation journal, so the registry validated its input against `input_schema`.
- **Identity.** `identity::MODEL` names the tokenizer and the chat and tool-call markers once; the prompt and the parser use it, `nativetools export` writes `identity.json`, and `render.py` reads it (fmt, decode, batching and hf_backend take their strings from `render`). `crates/assist` still spells the same tokens in six files; the fusion moves it onto the constant.
- **Export.** `contracts/assist/export/` holds the eleven export files; `tests/export_fixture.rs` diffs them against a live export on every run. oxfmt ignores the directory (`495ffd17b`, its own commit because `oxfmt.config.ts` is law), since the bytes are held by the drift test.
- **One compiler.** `crates/nativetools/src/think.rs` compiles a think and its `dates:` line to the call under either trace mode, and rewrites a v3.1 think as v4; `nativetools think` serves both as JSON lines with no vault, and `runtime_think.py` is the Python client (one locked process, cached). The session `compile` op and `think.rs` share `compile.rs`'s facts (call order, date spellings, default tool, rows placement, the kind a verb fixes); their assembly bodies stay apart because one validates against a world and the other must refuse exactly as Python did. `trace.py` lost `compile_call`, `v4_think`, `v4_slots` and their helpers.
- **Known gap.** The runtime reads a `dates:` entry that carries a parenthesis note (`2027-02-08 (the eighth, turn 2)`); Python's authoring reader `reading_expr` does not. The Rust compiler follows the runtime. No train think hits it.
- **Falsification.** L1: dropping `tentative` from `EVENT_STATUS` fails the enum test naming it; one byte flipped in the committed `tools.json` fails the drift test with the regeneration command; an invalid pair in `complete` fails on the schema error. L2: 240,000 grammar-generated thinks found 20 differences in the first 60,000 (14 harness bugs, 6 the known gap), then 0; 410,000 fuzzed pick reasons and time phrases found 297 differences, all the letter `ſ` that Python's `re.I` reads as `s`, then 0 once that case folding was mapped.

## Evidence: census A, both stacks mapped (2026-10-07)

A read-only census of `crates/assist`, `crates/assist-llama`, `crates/core/src/assist`, `crates/core-ffi`, the KMP chat machine, the iOS Chat tab and `crates/nativetools`, with `file:line` for every claim. What it changed in the plan:

- The runtime's read model `World` is not harness-only: it loads the vault at open and after every write, in floating UTC with no recurrence (R-1088-8). Only `seed.rs`, `export.rs`, the CLI and most of `vaultio.rs` are harness-only.
- `Session` owns a vault file handle and writes without an `invoke_key` or the core's change feed, so on the phone it must reach the vault through the core (a `Door`), or no screen would refresh.
- The vault has no machinery to park an owner's write; a pending write is new state in the core (R-1088-6, R-1088-10).
- Every proto change must be additive (`buf breaking` in the gate); the stored chat schema hard-codes seven apps, so new card kinds take migration 012 (R-1088-7).
- Android has no chat view; the confirm card lands in the shared KMP machine and on iOS.
- The 18-tool shape is pinned by about a hundred tests in `crates/assist`, the 65 cases of `contracts/assist/eval-cases.json`, three core test files, `core-ffi/tests/assist.rs` and three KMP specs; wave 2c retires them with the registry.
