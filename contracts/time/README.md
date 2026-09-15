# `contracts/time` — the civil-time corpus

Generated from `packages/core/src/time` by `contracts/tools/export-time-corpus.ts`, and compared in Rust by `crates/vault/tests/time_corpus.rs`. **Nothing here is typed by hand, and nothing is regenerated from the Rust side**: a fixture a port could rewrite proves nothing.

| File | v0 functions | What it would falsify |
| --- | --- | --- |
| `rrule-cases.json` | `inspectRrule`, `rruleRefusalMessage`, `canonicalizeRrule`, `describeRecurrence` | that a part this engine cannot honour is REFUSED with v0's own sentence, and that the one summariser says v0's words |
| `dst-cases.json` | `expandRecurrence`, `resolveWallTime` | the three DST sentences, in six zones including a 30-minute shift, a negative-DST zone and a `:45` offset |
| `occurrence-cases.json` | `occurrenceExceptionsOf`, `overrideAt`, `applyRecurrenceExceptions`, `occurrenceSearchWindow`, `nextOccurrence`, `collapseMissedOccurrences`, `classifyTemporal` | that the occurrence key is `original_start_local` — the series-local wall clock, never the resolved instant (#996 R21, drift ONT-25) |

## Regenerating

```sh
CENTRAID_WRITE_CONTRACTS=1 node node_modules/vitest/vitest.mjs run \
  tests/quality/time-corpus.contract.test.ts
bun run format && git diff --exit-code contracts/time
```

The emitter is also the oracle: without `CENTRAID_WRITE_CONTRACTS=1` the same test rebuilds the corpus from the live v0 tree and asserts equality with what is committed, so "the fixture passes in v0 too" is that test and it fails the moment a v0 function's answer moves.

## The cautionary case, by name

`FREQ=MONTHLY;BYSETPOS=-1` is in `rrule-cases.json` with its refusal and its sentence. It is why the refusal exists: it used to parse as a plain monthly rule and a "last Friday of the month" reminder fired on the wrong date forever.
