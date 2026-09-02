# Sharing journey budget

`sharing-reach` runs alone as the `sharing` suite on the nightly Android lane. The runner fails when aggregate wall time is **five minutes or more**, measured from the flow's process start through its verdict.

## Why this file exists at all

Until [#915](https://github.com/srikanth235/centraid/issues/915) Wave 2 this journey was a **bare `node tests/agent-e2e-mobile/flows/sharing-reach.mjs` line** in `apps/mobile/scripts/android-emulator-roster.sh` — the one member of the roster that no suite priced. That is precisely the shape [#890](https://github.com/srikanth235/centraid/issues/890) W0 wrapped six other standalone journeys to end (Grid G: "nothing could say what the roster as a whole was allowed to cost"), and this one was missed because it was added in the same change that wrapped the others. A one-member suite is not ceremony; it is the only way the aggregate ceiling on rung 4 can be a sum rather than an estimate.

It also has history worth keeping in view: `tests/claims.json` named this flow three times as an evidence owner while nothing ran it, which is the defect `scripts/lint-e2e-wiring.mjs` was written for.

## Where five minutes came from

**Derived arithmetic, not yet observed** — the ledger holds no samples. Built from the two rates the sibling budgets use: a fresh pairing at roughly **four minutes** on the reviewed CI runner (`lib/harness.mjs`), and a navigation unit at **fifteen seconds** (`home-apps-budget.md`'s two-minutes-across-eight-units rate).

|  | Pairing | Units | Derived |
| --- | --- | --- | --- |
| `sharing-reach` | 4 min | the Tally cover, the share sheet, the reachability surface, the linked/unlinked pair, and the Android offline withholding | 5 min |

It pairs for itself: the suite has one member, so there is no earlier profile to reuse.

**It becomes a measured ratchet.** Once **three real runs** exist, re-derive from the observed p95 in [`../ledger/durations.json`](../ledger/durations.json) and **tighten**, citing the sample count; `scripts/check-mobile-suite-budgets.mjs` enforces that automatically at three samples.

## When it is breached

Never raise it to buy time. First combine adjacent Maestro chunks and remove duplicate arrival assertions — the same first move every sibling budget makes. If that is insufficient, the pairing is the four minutes to attack: fold this journey into the `home-apps` suite so it reuses that suite's profile, which costs one ceiling re-derivation on both sides and is a decision to record rather than a tidy-up.
