# `contracts/applier/` — the three gates as language-neutral fixtures

The replica plane's correctness is three claims, and each is a fixture here rather than an assertion buried in one language's test ([#1020](https://github.com/srikanth235/centraid/issues/1020), **D-1020-D1-11**).

| Gate | Fixture | The claim |
| --- | --- | --- |
| **ORACLE** | `oracle.json` | A scripted commit list, with the `replica_log` rows it must produce. The Rust log must produce **equal rows** — values, not seqs. |
| **CONVERGENCE** | `convergence.json` | A copy taken at seq _S_ and fed rows _S..N_ equals the gateway at the watermark, **every replicated table, values not bytes**. The fixture declares the script and the tables to compare; the applier under test is `crates/vault::log::apply_log_page`, which `crates/seat` reuses. |
| **ATOMICITY** | `atomicity.json` | A crash mid-batch is completed by the next attempt, and a duplicate delivery lands once. |

## Why "values, not seqs" and "values, not bytes"

A `seq` is a position in one file's log and says nothing portable: two vaults founded from the same baseline allocate the same numbers only by accident, and the bootstrap commits differ. What has to agree is the DECODE — which table, which op, which key, which image, which prior, which flags. Byte equality is required only where the format demands it, per the umbrella's Compatibility rules, and a log row's JSON is one of those places, so the images are compared as parsed values with the spelling checked separately in `crates/vault/src/value.rs`.

## Where each fixture comes from

`oracle.json` is a **frozen golden**: it was captured once from the TypeScript vault's own replica-commit path before that tree was removed in [#1020](https://github.com/srikanth235/centraid/issues/1020), so it is an independent implementation's answer and not a transcription of the Rust one. Its generator went with that tree; a change to the file is a reviewed change in expected behaviour, not a regeneration.

`convergence.json` and `atomicity.json` are hand-authored scripts: they declare what to DO and what must hold afterwards, and the "afterwards" is a comparison between two files, which is not a row dump.

## Read by

- `crates/vault/tests/gates.rs` — all three.
- `crates/seat/tests/convergence.rs` — the convergence and atomicity scripts, through the seat's applier.
