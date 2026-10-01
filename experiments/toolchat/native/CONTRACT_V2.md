# Contract v2

Status: implemented. Trace grammar, guard, runtime fixes and data are built; SPEC.md carries the final text (sections 3.3, 4.4, 4.5, 7, 14.1). The eval sets stay frozen. Sections 1 to 6 record the evidence at wave 0; section 7 is the plan and its gates. Measured on val with the round-2 runtime, checkpoint final1 (65.2% sessions, 83.7% turns).

## 1. What the evidence says

| Finding | Number | Consequence |
| --- | --- | --- |
| Writes fail equally by `#n` and by selector | 25% (85 of 338) vs 24% (87 of 369) | Mandatory find-before-write is dropped. It would not move the needle. |
| Dates are already structured expressions (SPEC §4.4), not ISO strings | 20 of 213 failed turns (9%) after the runtime fix | A `when` phrase field is dropped. The bare-weekday convention is a data and trace matter, and the runtime override stays. |
| Failures are conversational reference | "both" (→ rows of the last result), "twenty-seventh", "3 is fine", "my side" (= `i_owe`) | The trace must resolve the reference before the call. This is the main change. |
| Coverage is not the gap | 4 red tags, each with 250 to 1,175 train uses and val pass 70 to 80% | Quota fill is a weak gate. The trace, not more data, is the lever. |
| Phrasing gate and hardness already pass | AUC 0.51 (line 0.55), min hardness 0.38 (line 0.30) | Keep as regression gates. |

## 2. Trace grammar (replaces SPEC §7)

Fixed slot order. Each slot depends only on the message, the context and the slots above it. Every value is from a closed set or is a quoted span of the message. Nothing the runtime can compute.

```
intent: read|count|write|ask|decline "<deciding phrase>"
verb:   <closed verb set>                       (writes only)
scope:  one|some|all "<qualifier>"              (writes only; "except the padel one" is some)
refer:  it|both|that|nth "<phrase>" -> @k       (follow-ups only; k is a handle in context)
target: "<name or attribute as said>"           (when the rows are not a follow-up)
when:   "<date phrase as said>"                 (when a date is involved)
pick:   #n ok | #n no (<reason>) ...            (only after a result with more than one row)
```

The call is rendered from the slots. `refer` is what fixes "bring both back": the model writes `refer: both "both" -> @3` and the call is `rows=@3`, not two `#n` it has to guess.

Guard (runtime): reject a call that contradicts its own trace, as an error observation, the same way a repeated call is rejected. `intent: write` with an `answer` call, `scope: one` with a several-row write, `refer -> @k` with rows other than `@k`.

## 3. Contract changes

Additive only. Every existing gold call stays valid.

- `refer -> @k` slot and the guard (new).
- `rows=@k` already exists, so no grammar change is needed for follow-ups.
- No `target` or `when` parameter on `act`. The selector and §4.4 expressions stay as they are.

Schema coverage: `authored/contract_check.py` reports 18,541 of 18,541 gold calls (val plus train worlds) inside the contract, 100%.

## 4. Runtime changes, tagged

| Change | Tag | Reason |
| --- | --- | --- |
| Loop breaker, shorter candidate lists, compaction fix, parameter salvage | keep | Contract-independent; measured. |
| Date override (ground.rs) | keep | Dates are still 9% of failures. The override recovers part of them. Not deleted. |
| Focus pick and bulk-write guard | kept, narrowed (landed) | The focus pick now counts a result's rows only when the result has at most 4 rows (`FOCUS_RESULT_MAX = 4`); val parity held at 255/391 sessions and 1,095/1,308 turns. With a trace, the bulk guard lets more than 12 rows through only for `scope: all`. |
| ground.rs reads the user message | amend SPEC §3.3 | Real exception, stated as one. The spec sentence "does not look at the message" is rewritten to say the runtime reads it only to repair a stated date and to pick the in-focus row. |

## 5. SPEC edits (applied)

- §7 replaced by the grammar in section 2.
- §3.3 amended as in the table above.
- §14.1 gains a line per slot: what counts as a deciding phrase, what counts as a follow-up.

## 6. Baselines, recorded

| Metric | Value |
| --- | --- |
| Val sessions and turns | 65.2% (255 of 391), 83.7% (1,095 of 1,308) |
| Wrong writes | 46 |
| Phrasing gate AUC | 0.511 (line 0.55) |
| Min hardness share | 0.383 at rows:0 (line 0.30) |
| Schema coverage | 100% of 18,541 calls |
| Failed turns by class, top five | act differs 19%, wrong filter 12%, loops 10%, wrong target rows 10%, wrong date 9% |

Snapshot: scratchpad `w0/w0-baseline.json`.

## 7. Final plan

| Phase | Scope | Status |
| --- | --- | --- |
| P1 | Trace generator and runtime guard (intent, scope, refer; bulk guard reads `scope`). | done |
| P2 | Audit of authored sessions against the trace and argument-source checks. | done; 355 sessions fixed |
| P3 | Decision and hard-token weighting in the loss: W=3; the hard tier is 8.95% of label tokens on v1 data; `saw` dropped from the hard tier. | done |
| P4 | 150 new sessions (follow-up reference, owe direction, except/besides, bare weekdays). 126 sessions fixed so every call argument has a source. Weekday and relative phrases converted to the structured date form (SPEC 4.4). | done |
| P5 | Retrain on a GCP Spot H100 with resume flags `--epochs 6 --bs 16 --max-len 8192 --save-every 30 --resume`. | planned |
| P6 | Final eval reporting loss and decision/hard-token accuracy on train, val and test. | planned |

Gates.

- Global, every phase: gold replay 100%; phrasing AUC at most 0.55; min hardness at least 0.30; overlap with val and test 0; train tokens within +-10% of the last run; crate tests green.
- Local, per phase: P1 trace-call consistency 100% and guard false rejections 0; P2 and P4 every call argument has a source (argument-source check) and converted sessions green; P3 the hard share and weight are recorded; P5 and P6 have no gate beyond the acceptance below.

Acceptance for the retrain: val at least 90% sessions (target), at least 85% acceptable; test at least 85% sessions; train fit at least 95%.

Coverage stays a report, not a gate.

### Open items

- T02-126 to T02-131.
- T02-038 and T02-063.
- T02-206.
- Unconverted val sessions.
- fp32 training path.
- Python 3.10 versus 3.11 on the VM image.
