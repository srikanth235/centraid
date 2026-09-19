# Local assistant — results across all lanes

The brief's deliverable 6: one table per lane, the ceilings measured, the costs, and which pipeline to build into the runtime.

Two evaluations are reported side by side throughout.

- **Frozen suite** — `suite.json`, 74 cases / 98 turns, frozen before any model ran.
- **Blind suite** — `blind/blind_suite.json`, 40 cases / 48 turns, written after the lanes had run, by an author who read the catalogue, the world, the scorer and three suite cases and nothing else: no template file, no generator, no training corpus. It exists because `j-05`'s training data gained group-phrase templates written after reading `j-03`'s suite failures, so the frozen suite's `.811` is not a blind estimate. Both suites are proven reachable by hand-written reference calls at 0 failures (`runs/reference.json`, `runs/reference-blind.json`).

**The blind set does not hold `.811`. The joint model scores `.600` on it (`.667` excluding a case shape the frozen suite does not contain), and every lane loses ground: selector-alone operation accuracy falls .837 → .646, Needle falls .459 → .375.** The ranking between lanes is unchanged, and the joint model remains the recommendation, but its shippable accuracy is two thirds of the suite, not four fifths.

## Lane 1 — selector alone (operation accuracy)

`logreg:fields` over frozen MiniLM embeddings; the request, the previous request and a one-hot previous operation. Blind numbers use artifact `lr-01` with the selector's own previous prediction fed back.

| Category              | Frozen           | Blind            |
| --------------------- | ---------------- | ---------------- |
| single_read           | .83 (15/18)      | .70 (7/10)       |
| single_write          | .71 (10/14)      | .75 (6/8)        |
| cross_app_one_call    | .60 (6/10)       | .17 (1/6)        |
| chain                 | .88 (14/16)      | .25 (1/4)        |
| follow_up             | .88 (14/16)      | .75 (6/8)        |
| reference_into_result | .94 (15/16)      | .88 (7/8)        |
| refusal_none          | 1.00 (8/8)       | .75 (3/4)        |
| **all turns**         | **.837 (82/98)** | **.646 (31/48)** |

Coverage on the blind turns: top-1 + catalogue siblings .688, top-3 .812 (frozen: .867 and .908).

Top blind confusions — four different reads collapse onto `people_at` (`people_at_company`, `photos_of_people`, `notes_about_people`, `tally_expenses_with`), and three onto the docs writes (`docs_search → docs_star`, `docs_search → docs_move`, `tally_balance_with → docs_star`). The frozen suite's one systematic error, `photos_in_album → photos_add_to_album`, recurs once. The pattern is the same in both: an operation whose only cue is a noun phrase absorbs any sentence built around that noun phrase, read-versus-write included.

## Lane 2 — Needle 3 as filler (outcome accuracy, end to end)

Selector-driven (`lr-3b`, margin 0.3), the model's own previous operation, one fresh world per case.

| Category              | Frozen           | Blind            |
| --------------------- | ---------------- | ---------------- |
| single_read           | .61 (11/18)      | .60 (6/10)       |
| single_write          | .43 (6/14)       | .38 (3/8)        |
| cross_app_one_call    | .20 (2/10)       | .00 (0/6)        |
| chain                 | .38 (3/8)        | .25 (1/4)        |
| follow_up             | .38 (3/8)        | .50 (2/4)        |
| reference_into_result | .12 (1/8)        | .00 (0/4)        |
| refusal_none          | 1.00 (8/8)       | .75 (3/4)        |
| **total**             | **.459 (34/74)** | **.375 (15/40)** |

Ceilings (frozen suite only): oracle single operation **.486 (36/74)**, oracle operation + catalogue siblings **.284 (21/74)**. Showing Needle more tools is strictly worse even when the extra tools contain the answer, so the top-3 fallback the selector's calibration recommends cannot be used with this filler.

The blind run reproduces the lane's two signature failures unchanged: phrase arguments truncated to a head noun (`event="Hooli"` out of "who works at Hooli", `person="the offsite"`), and row ids quoted back out of the replayed tool result (`task="p01"`). `cross_app_one_call` and `reference_into_result` are 0/6 and 0/4.

## Lane 3 — joint encoder (operation head + BIO span tagger + enum heads)

Artifact `j-05`, `run_suite_joint.py --suite blind`, the model's own previous prediction, margin 0.0.

| Category | Frozen outcome | Blind outcome | Frozen op acc | Blind op acc |
| --- | --- | --- | --- | --- |
| single_read | .944 (17/18) | .700 (7/10) | .944 | .900 |
| single_write | .643 (9/14) | .625 (5/8) | .929 | .875 |
| cross_app_one_call | .900 (9/10) | .667 (4/6) | .900 | 1.000 |
| chain | .750 (6/8) | .000 (0/4) | 1.000 | .500 |
| follow_up | .625 (5/8) | .500 (2/4) | 1.000 | .875 |
| reference_into_result | .750 (6/8) | .500 (2/4) | 1.000 | .857 |
| refusal_none | 1.000 (8/8) | 1.000 (4/4) | 1.000 | 1.000 |
| **total** | **.811 (60/74)** | **.600 (24/40)** | **.968** | **.872** |

Blind error buckets (16 failed turns): `wrong_op` 6, `missing_slot` 4, `wrong_span` 2, `enum` 2, `resolver_failure` 1, `other` 1.

**The chain row is a shape difference, not only a capability difference.** The frozen suite writes a chain as two turns; the blind set writes four of them as one utterance that needs two calls ("find the Acme paperwork and star it"). The runtime emits exactly one call per turn, so those four cases cannot pass by construction — and that is itself a finding: nothing in the proposed pipeline composes two calls from one utterance, and users write such utterances. Excluding them, the blind score is **.667 (24/36)** against a comparable frozen figure of **.818 (54/66)**.

**What the remaining 12 non-chain blind failures are.** Six are operations the training data never shaped: `whos at initech` → `people_at{event:"in"}` (a span clipped inside the word, the known unseen-name failure mode), `push Draft the migration plan to next friday` → `agenda_reschedule`, `find the events about migration` → `tasks_about`, `the Ideas one now` → `clarify`. Four are optional slots simply not tagged (`when="yesterday"`, `company="Acme"`, `direction="i_owe"` twice, the last two being enum heads answering `<absent>` or the wrong value on an indirect phrasing — "who am i in the red with", "other way round?"). Two are spans of the wrong extent (`topic="the Acme paperwork"`, `people="Lena"` where the resolvers needed the filter form "only the ones with Lena").

Eleven of the fourteen frozen failures were unseen proper nouns; on the blind set that mode accounts for roughly a third, and **indirect phrasing of enums and optional slots is the new plurality**. The frozen suite phrases its enum turns more directly than the blind set does.

## Ceilings

| Ceiling | Measured | Where |
| --- | --- | --- |
| Needle, oracle operation shown alone | .486 outcome | needle lane, frozen |
| Needle, oracle operation + siblings | .284 outcome | needle lane, frozen |
| Selector alone, top-1 | .837 / .646 op accuracy (frozen / blind) | selector lane |
| Selector alone, top-1 + siblings | .867 / .688 coverage | selector lane |
| Selector alone, top-3 | .908 / .812 coverage | selector lane |
| Joint, oracle previous operation | .811, identical to the model's own | joint lane, frozen |

The oracle-previous run changing nothing is the load-bearing ceiling: at this operation accuracy there is no error to compound across turns, so multi-turn state is not the problem — slot extent and enum inference are.

## Costs

| Candidate | Params | Artifact on disk | ms / request | Training wall clock | Runtime dependencies |
| --- | --- | --- | --- | --- | --- |
| Joint encoder (`j-05`) | 22.7M | 90.7 MB ONNX fp32 + 1.0 MB tokenizer | 3.5 (ONNX), 10.8 (torch) | ~25 min, 4 CPU threads | onnxruntime + a WordPiece tokenizer |
| Selector only (`logreg:fields`) | 22.7M encoder | ~90 MB MiniLM + 313 KB pickle | ~5 + one embedding pass | ~20 s fit (data + embed ≈ 3 min) | sentence-transformers or ONNX MiniLM, scikit-learn |
| Selector encoder fine-tune (`ft-01`) | 22.7M | ~90 MB | as above | 47 min for +0.0 suite points | as above |
| Needle 3 | ~121M | 2.125-bit `.cact`; 242 MB float checkpoint for tuning | ~900 (full turn, history replayed) | n/a (base weights) | `libneedle.so` per platform over ctypes; no `transformers`, no peft |
| Qwen3 4B comparison lane | 4B | ~2.5 GB GGUF | not measured | n/a | llama.cpp build |

**The Qwen3 4B lane was not run.** It needs a ~2.5 GB download plus a llama.cpp build, and neither was authorised; the brief's rule is to ask before downloading. The consequence is that the "what does a small generative model buy" bar is unmeasured, and the recommendation below rests on beating Needle 3, not on beating every generative option.

## Caveats

- **Post-hoc templates.** `j-05`'s group-phrase templates were written after reading `j-03`'s suite failures. The blind set exists to measure that, and it does: `cross_app_one_call` goes .900 → .667 and the headline goes .811 → .600. Treat `.60`–`.67` as the transfer estimate and `.811` as the in-distribution one.
- **The blind set is one author's 40 cases**, written in a day against the same world and scorer. It is not a user study, and its category counts are small enough that one case is 10–25 points in a category row.
- **Unseen proper nouns** remain the joint tagger's structural weakness: the synthetic training world shares no name with the evaluation world, so "Initech", "Goa" and "Hooli" arrive as unfamiliar word pieces and the BIO tagger clips them. The invented-name augmentation share (0.18 here) is an untuned knob that moved the lane from .622 to .811 on the frozen suite.
- **`c07` gap.** One frozen case is unreachable by a verbatim span tagger: its reference predicate asserts a canonically rewritten task title ("Book offsite flights again") that no span of the user's words produces. It is counted as a failure in every lane rather than special-cased; closing it means editing frozen reference data, which is an owner decision. The blind set marks the same class of case with `"note": "needs canonical"` (6 of 40) instead of hiding it — all six are enum slots, which the joint model can produce because enums are classified, not tagged.
- **Scoring is by outcome**, so a slot value the resolvers accept passes even when it is not the reference string; `slot_accuracy` in the run JSONs under-reads for that reason and is not a headline.

## Recommendation

**Build the joint encoder pipeline** — one 22.7M MiniLM with an operation head, a BIO span tagger and per-enum classifiers, feeding the existing resolvers and executor — and drop both the separate selector and the generative filler. It is the only candidate that beats its own ceiling comparisons on every axis: 3.5 ms and 90.7 MB against Needle's per-platform C engine at ~900 ms, and .872 blind operation accuracy against the selector's .646 on the same turns.

Measured accuracy to expect per category, on the blind set (frozen in brackets): single_read .70 (.94), single_write .63 (.64), cross_app_one_call .67 (.90), chain .00 (.75, and see the shape caveat), follow_up .50 (.63), reference_into_result .50 (.75), refusal_none 1.00 (1.00). Overall **.600, or .667 on the case shapes the runtime can express**. That is good enough to ship behind a confirmation step for writes and a "show me what you understood" rendering for reads; it is not good enough to act silently.

The next three levers, in priority order:

1. **Optional slots and enums under indirect phrasing** — the new plurality of blind failures (6 of 16 turns). The enum heads answer `<absent>` on "who am i in the red with" and the wrong class on "other way round?", and optional spans ("yesterday", "at Acme") go untagged. This is a data shape problem: generate enum and optional-slot templates in oblique registers, and weight the enum heads' loss on the rows that carry one.
2. **Unseen-name spans** — still a third of failures, and the largest single measured effect in the lane. Sweep the invented-name share (0.18 / 0.25 / 0.35) against blind outcome rather than frozen outcome, and add whole-word masking or a character-aware span head.
3. **Two calls from one utterance** — "find X and star it" is a shape the runtime cannot express at all. The cheapest fix is a deterministic conjunction split before the model (split on "and then" / "and <verb>", run the model twice, carry the first result as context), not a planner; measure it on the blind chain cases, which are exactly this shape.

Below those: quantise the ONNX graph to int8 and vendor a WordPiece tokenizer in `packages/model-runtime`, and run the Qwen3 4B lane if the owner authorises the download, so the bar is known rather than assumed.

## Reproduce

```sh
cd experiments/local-assistant
python3 blind/run_reference_blind.py --write
python3 blind/run_reference_blind.py --label reference-blind     # must be 0 failures
.venv-joint/bin/python run_suite_joint.py --label <new> --artifact j-05 --suite blind
.venv/bin/python needle/suite_run_selector.py --label <new> --artifact lr-3b --margin 0.3 --suite blind
```

Run labels are append-only. The runs behind this document: `reference-blind`, `j05-blind-e2e`, `needle-base-blind-m03`.
