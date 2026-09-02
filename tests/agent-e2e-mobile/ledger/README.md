# Mobile run ledger

`durations.json` is the on-disk record of every committed mobile journey run: one entry per `runFlow()` verdict, appended by [`lib/run-ledger.mjs`](../lib/run-ledger.mjs) from the harness's verdict path. It exists so the numbers governing this layer — suite budgets, flake triage, which journey to split — read data instead of arithmetic.

## What it is

**Evidence, not state.** It is append-only in spirit: a run that happened stays in the record. The one thing that removes entries is the window (below), which drops the oldest records of a key mechanically, never selectively. It is never hand-edited, and above all **never edited to make a budget pass** — a budget that disagrees with the ledger is a budget to re-derive or a regression to fix, and rewriting the observations to agree with the ceiling destroys the only thing here worth having.

## Shape

```json
{ "version": 1, "records": [ { "flow": "…", "platform": "ios", "durationMs": 19000, "pass": true, "failureClass": null, … } ] }
```

Each record carries the flow file and slug, the platform and device, the ISO start time and wall-clock `durationMs`, the pass/fail verdict, the `failureClass` / `failureReason` from [`lib/failure-class.mjs`](../lib/failure-class.mjs), and the `lane` / `runId` / `commit` that produced it.

**Bounded window.** At most 500 records per `flow × platform` key, oldest dropped. Two reasons, and both matter: the file is committed, so it cannot grow without limit; and a percentile needs a recent window, not a history — p95 over four years of runs describes a rig that no longer exists.

**Grouped and sorted by key.** The two nightly platform jobs run on different runners against different checkouts, so they never contend for the file — they contend for the same lines when their branches merge. Grouping by `flow::platform` and writing one field per line keeps an iOS append and an Android append in disjoint line ranges, so a conflict is local and resolvable rather than a whole-file rewrite.

## Reading it

```js
import { summarize } from "../lib/run-ledger.mjs";
const summary = summarize(
  JSON.parse(await readFile("ledger/durations.json", "utf8"))
);
// summary["tests/agent-e2e-mobile/flows/home-loads.mjs::ios"]
//   → { runs, p50Ms, p95Ms, maxMs, failureRate, infraFailureRate }
```

`percentile()` is nearest-rank: a returned value is one the rig actually produced, never an interpolation between two it did. That is deliberate — every consumer here is a ceiling.

`failureRate` and `infraFailureRate` are separate on purpose. A suite whose product failure rate is flat while its infrastructure rate climbs has a rig problem, not a regression; the split is only trustworthy because the classifier refuses to call an `assertVisible` timeout infrastructure.

## Where CI runs land

Each device lane writes this file on its own runner and uploads it as the `mobile-run-ledger-<lane>` artifact — `pr-gate-paired`, `pr-gate-resilience` (the PR gate runs as two parallel legs, and an artifact name must be unique per matrix leg), `canary-android`, `nightly-ios`, `nightly-android` — on **every** run, red or green. A red run's durations are the ones worth having, so the upload is unconditional ([#905](https://github.com/srikanth235/centraid/issues/905): before it, ten gate runs left the committed file at `records: []`).

Folding those runs into the committed file is a **deliberate act**, never automatic: download the artifact, merge its records through [`boundedAppend`](../lib/run-ledger.mjs) semantics so the 500-per-key window and the key grouping hold, and commit naming the lane's run id. No workflow commits here — a file that rewrites itself under CI is not evidence anyone chose to keep. Budgets are derived from the committed file only; an artifact nobody folded in has not been observed yet.

## Deriving a budget from it

Every suite budget in [`../flows/`](../flows/) is currently **derived arithmetic** — a rate nobody measured multiplied by a unit count — and each says it must be re-derived from an observed p95 once real runs exist. When you do that:

1. **Cite the sample count.** A budget note that says "p95 = 21 minutes" without saying over how many runs is unreadable; over three runs it is the slowest of three. Write `runs`, `p50Ms` and `p95Ms` into the budget doc.
2. **Tighten only.** Replacing a derived ceiling with a measured one is allowed to lower it, never to raise it. A budget nothing has ever come close to is not a budget; a budget raised to accommodate a breach is not a budget either.
3. **Key by platform.** iOS and Android are different rigs with different drivers; a p95 pooled across both describes neither.
