# `contracts/applier/` — the three gates as language-neutral fixtures

The replica plane's correctness was three claims in v0's test file header ([`packages/vault/src/replica/log.test.ts:1-16`](../../packages/vault/src/replica/log.test.ts)), and a claim asserted only by a TypeScript test is a claim the Rust core cannot be held to. So each is now a fixture, and both trees read the same file ([#1020](https://github.com/srikanth235/centraid/issues/1020), **D-1020-D1-11**).

| Gate | Fixture | The claim |
| --- | --- | --- |
| **ORACLE** | `oracle.json` | A scripted commit list, run through v0's own `withReplicaCommit` on a fresh v0 vault, with the `replica_log` rows it produced. The Rust log must produce **equal rows** — values, not seqs. |
| **CONVERGENCE** | `convergence.json` | A copy taken at seq _S_ and fed rows _S..N_ equals the gateway at the watermark, **every replicated table, values not bytes**. The fixture declares the script and the tables to compare; the applier under test is `crates/vault::log::apply_log_page`, which `crates/seat` reuses. |
| **ATOMICITY** | `atomicity.json` | A crash mid-batch is completed by the next attempt, and a duplicate delivery lands once. |

## Why "values, not seqs" and "values, not bytes"

A `seq` is a position in one file's log and says nothing portable: a v0 vault and a v1 vault founded from the same baseline allocate the same numbers only by accident, and the bootstrap commits differ. What has to agree is the DECODE — which table, which op, which key, which image, which prior, which flags. Byte equality is required only where the format demands it, per the umbrella's Compatibility rules, and a log row's JSON is one of those places, so the images are compared as parsed values with the spelling checked separately in `crates/vault/src/value.rs`.

## Regenerating

```sh
node --experimental-strip-types contracts/tools/export-applier-oracle.ts \
  > contracts/applier/oracle.json
bun run format
```

**`node`, not `bun`** (D-1020-D1-16): v0's vault package is built on `node:sqlite` and Bun does not provide that module, which is also why v0's own freezer is invoked as `node scripts/golden-vault/build.mjs`. The generator runs the scripted statements through **v0's** `withReplicaCommit` against a freshly founded v0 vault, then dumps the `replica_log` rows above the watermark the bootstrap left — so the fixture is v0's answer and not a transcription of one. `git diff --exit-code contracts/applier` is the check that it is current.

`convergence.json` and `atomicity.json` are hand-authored scripts rather than generated: they declare what to DO and what must hold afterwards, and the "afterwards" is a comparison between two files, which is not a row dump.

## Read by

- Rust: `crates/vault/tests/gates.rs`.
- TypeScript, while the v0 tree exists: the generator itself is the oracle side — it produces `oracle.json` from v0's own capture path, so a v0 regression shows up as a diff in the fixture rather than as a silently passing test.
