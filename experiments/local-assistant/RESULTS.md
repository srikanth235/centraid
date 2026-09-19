# Local assistant — results across all lanes

One table per lane, the ceilings measured, the costs, and which pipeline to build into the runtime.

Two evaluations are reported side by side throughout.

- **Frozen suite** — `suite.json`, 74 cases / 98 turns, frozen before any model ran.
- **Blind suite** — `blind/blind_suite.json`, 40 cases / 47 turns, written after the lanes had run by an author who had read the catalogue, the world, the scorer and three suite cases and nothing else: no template file, no generator, no training corpus. It exists because the joint lane's training data gained group-phrase templates written after reading a suite-failure dump, so the frozen number is an in-distribution estimate and the blind one is the transfer estimate. Both suites are proven reachable by hand-written reference calls at 0 failures (`runs/reference.json`, `runs/reference-blind.json`).

**The recommended artifact is the joint encoder `j-06` with word-aware span decoding, exported and dynamically quantised to int8: 61/74 frozen, 26/40 blind, operation accuracy .896, 23.0 MB, 6.5 ms per request.** Every lane loses ground on the blind set; the ranking between lanes does not change.

## Cross-lane summary

| Lane | Artifact | Frozen outcome | Blind outcome | Operation accuracy (frozen / blind) |
| --- | --- | --- | --- | --- |
| **Joint encoder** | **`j-06` int8 ONNX, word-aware decode** | **61/74 (.824)** | **26/40 (.650)** | **.968 / .896** |
| Joint encoder | `j-06` fp32 ONNX / torch | 62/74 (.838) | 26/40 (.650) | .968 / .891 |
| Joint encoder (legacy) | `j-05`, piece-by-piece decode — before the decoder fix | 60/74 (.811) | 24/40 (.600) | .968 / .872 |
| Selector alone | `logreg:fields` (`lr-01`) — selection only, no filler | .837 op accuracy | .646 op accuracy | .837 / .646 |
| Needle 3 as filler | base weights, selector-driven | 34/74 (.459) | 15/40 (.375) | — |

The `j-05` row is kept only as the before/after for word-aware decoding: grouping WordPiece pieces into words before reading BIO tags bought +3 frozen and +1 blind case with no retraining at all.

## Lane 1 — selector alone (operation accuracy)

`logreg:fields` over frozen MiniLM embeddings: the request, the previous request and a one-hot previous operation. Blind numbers use artifact `lr-01` with the selector's own previous prediction fed back.

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

Top confusions: four different reads collapse onto `people_at` (`people_at_company`, `photos_of_people`, `notes_about_people`, `tally_expenses_with`) and three onto the docs writes (`docs_search → docs_star`, `docs_search → docs_move`, `tally_balance_with → docs_star`); the frozen suite's one systematic error, `photos_in_album → photos_add_to_album` (all three "show me the {album} album" turns), recurs once. The pattern is identical on both suites: an operation whose only cue is a noun phrase absorbs any sentence built around that noun phrase, read-versus-write included.

The encoder fine-tune (`ft-01`) buys +2.5 val points, −2 dev points and 0 suite points for 47 minutes of CPU and a 90 MB artifact that goes stale on every catalogue change. Not adopted.

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

The blind run reproduces the lane's two signature failures unchanged: phrase arguments truncated to a head noun (`event="Hooli"` out of "who works at Hooli", `person="the offsite"`) and row ids quoted back out of the replayed tool result (`task="p01"`). `cross_app_one_call` and `reference_into_result` are 0/6 and 0/4.

Needle is the comparison bar, not the target: its runtime cost is a bespoke C engine (`libneedle.so`) per platform over ctypes, a 2.125-bit requantisation on every tune, a confidence head that tuning destroys, and a single-turn training renderer that does not match the deployed multi-turn shape.

## Lane 3 — joint encoder (operation head + BIO span tagger + enum heads)

One 22.7M-parameter MiniLM with three heads, `run_suite_joint.py`, the model's own previous prediction fed back as a learned `[PREVOP_*]` token, margin 0.0.

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

The per-category breakdown above is the `j-05` legacy-decode run — the last one scored category by category, and the before-the-decoder-fix comparison. The recommended artifact scores **62/74 frozen and 26/40 blind in fp32, 61/74 and 26/40 in int8**; the gains over the table land in the categories the span failures lived in (`single_read`, `cross_app_one_call`, `chain`).

Error buckets, `j-06` on the blind set (14 failed turns): `wrong_op` 4, `missing_slot` 4, `enum` 2, `wrong_span` 2, `resolver_failure` 1, `other` 1. Spans are no longer the plurality; operation selection and optional slots under indirect phrasing are. On the frozen suite the word-aware decoder empties the `resolver_failure` bucket entirely — spans clipped to `"In"` and `"the"` were exactly what the resolvers could not use.

Two further probes were measured and **not adopted**: a wider phrasing register (`j-07`, blind 25/40, operation .870 — slot accuracy rose to .652 but whole-request lowercasing destroys the capitalisation cue the operation head uses) and first-subword-only tag supervision (`j-08`/`j-09`, blind 25/40 both times — once the decoder is word-aware it no longer reads continuation pieces, so supervising them costs nothing either way).

A margin gate buys very little: at 0.7 it converts 6% of turns into a clarification to fix 2 operation errors, so `predict_joint.DEFAULT_MARGIN` is 0.0.

## Ceilings

| Ceiling | Measured | Where |
| --- | --- | --- |
| Needle, oracle operation shown alone | .486 (36/74) outcome | needle lane, frozen |
| Needle, oracle operation + catalogue siblings | .284 (21/74) outcome | needle lane, frozen |
| Selector alone, top-1 | .837 / .646 op accuracy (frozen / blind) | selector lane |
| Selector alone, top-1 + siblings | .867 / .688 coverage | selector lane |
| Selector alone, top-3 | .908 / .812 coverage | selector lane |
| Joint, oracle previous operation | identical to the model's own prediction | joint lane, frozen |

Three of these are load-bearing.

- **Showing Needle more tools is strictly worse, even when the extra tools contain the answer** (.486 → .284 with siblings; 34 → 31 cases with top-3). So the top-3 fallback the selector's calibration recommends cannot be used with a generative filler, and the selector-driven run is already within two cases of Needle's oracle ceiling — the gap is not selection.
- **The oracle-previous-operation run changes nothing.** Operation accuracy on every non-final turn of the multi-turn categories is 100%, so there is no error to compound: multi-turn state is not the problem.
- **Nine of the eleven frozen proper-noun failures were decoder bugs, not tagging failures.** Per-token dumps showed the tagger had found `Initech` (`in/B-event ##ite/O ##ch/I-event`) and `Offsite debrief` (a spurious `B-` on each piece) and the piece-by-piece decoder threw them away. Only one over-extension and the four turns where nothing was tagged at all were genuine tagging errors.

## Costs

| Candidate | Params | Artifact on disk | ms / request | Training wall clock | Runtime dependencies |
| --- | --- | --- | --- | --- | --- |
| **Joint encoder `j-06`, int8 ONNX** | 22.7M | **23.0 MB** graph + 977 KB tokenizer/config | **6.5** | ~25 min, 3–4 CPU threads | `onnxruntime` and `@huggingface/transformers` `AutoTokenizer`, both already pinned in `packages/model-runtime` |
| Joint encoder `j-06`, fp32 ONNX | 22.7M | 90.7 MB + 977 KB | 13.4 on the same contended cores as the int8 row; 3.5 measured on quiet cores | same weights | as above |
| Selector only (`logreg:fields`) | 22.7M encoder | ~90 MB MiniLM + 313 KB pickle | ~5 + one embedding pass | ~20 s fit (data + embed ≈ 3 min) | sentence-transformers or ONNX MiniLM, scikit-learn |
| Selector encoder fine-tune (`ft-01`) | 22.7M | ~90 MB | as above | 47 min for +0.0 suite points | as above |
| Needle 3 | ~121M | 2.125-bit `.cact`; 242 MB float checkpoint for tuning | ~900 (full turn, history replayed) | n/a (base weights) | `libneedle.so` per platform over ctypes; no `transformers`, no peft |
| Qwen3 4B comparison lane | 4B | ~2.5 GB GGUF | not measured | n/a | llama.cpp build |

Integration state for the joint model, checked against `packages/model-runtime` (no change was made to `packages/`):

- **ONNX execution is already there.** `src/onnx.ts` resolves `onnxruntime-node` out of the sibling `runtime/` and caches sessions by path. The graph is opset 14, three int64 inputs, three float outputs, dynamic on batch and sequence — nothing the shipped models do not already exercise.
- **Tokenization is already available, though not in the package's own code.** `src/tokenizer.ts` is a CLIP BPE tokenizer and cannot tokenize for a BERT encoder; `@huggingface/transformers` 3.7.5 is pinned in `runtime/package.json` and its `AutoTokenizer` reads the WordPiece `tokenizer.json` the export writes. Shipping beside the graph: `tokenizer.json`, `tokenizer_config.json`, `vocab.txt`, `special_tokens_map.json`, `added_tokens.json` (the last two carry the 48 `[PREVOP_*]` tokens, without which the previous-operation feature degrades to unknown-token noise) and this lane's own `config.json`, which names the label order of all three heads and is not an encoder config.
- **The one integration gap is character offsets.** `decode_spans` needs each token's `[start, end)` in the original request, because slot values are returned as verbatim substrings for the resolvers; the Python side gets them from `return_offsets_mapping` and the Transformers.js tokenizer output does not carry an offset mapping. Either reconstruct offsets while tokenizing (exact for WordPiece: pretokenizer word boundaries plus `##` piece lengths) or port the word-aware decoder to work from token strings. This is the single piece of new tokenizer code the lane requires, and it must be verified against 3.7.5.
- **Pinning is an owner decision.** `models.lock.json` is `{model, path, capabilities, bytes, sha256, license, url}` per file, with `whisper-tiny.en-q8@1` as the precedent for an int8 graph pinned alongside its tokenizer. These weights are trained here and have no upstream `url`, so landing them needs either a published release asset to point `url` at or a schema decision about locally built weights. Licence is Apache-2.0, inherited from `all-MiniLM-L6-v2`.

## Caveats

- **Blind is below frozen, and the reason is known.** The joint lane's `j-05` training data gained group-phrase templates written after reading a suite-failure dump, which took `cross_app_one_call` from 1/10 to 9/10 on the frozen suite. The blind set exists to measure exactly that, and it does. Treat the blind figure as the transfer estimate and the frozen one as in-distribution. The same drop appears in lanes with no such contamination (selector .837 → .646, Needle .459 → .375), so post-hoc templates are not the whole story: the blind author phrases enums and optional slots far more obliquely than the frozen suite does.
- **Four blind chain cases need two calls from one utterance** ("find the Acme paperwork and star it"). The pipeline emits exactly one call per turn and cannot express them by construction. Both figures are reported: **26/40 (.650)** overall, and **26/36 (.722)** excluding those four. The gap is itself a finding, not an excuse — users write such utterances.
- **The blind set is one author's 40 cases**, written in a day against the same world and scorer. Not a user study; category counts are small enough that one case is 10–25 points in a category row.
- **`c07` canonical-rewrite gap.** One frozen case is unreachable by a verbatim span tagger: its reference predicate asserts a canonically rewritten task title ("Book offsite flights again") that no span of the user's words produces. It is counted as a failure in every lane rather than special-cased; closing it means editing frozen reference data, which is an owner decision. The blind set marks the same class with `"note": "needs canonical"` (6 of 40) rather than hiding it; all six are enum slots, which the joint model can produce because enums are classified, not tagged.
- **The Qwen3 4B lane was not run.** It needs a ~2.5 GB download plus a llama.cpp build and neither was authorised. The consequence is that "what a small generative model buys" is unmeasured: the recommendation rests on beating Needle 3, not on beating every generative option.
- **Two measured negatives.** Wide-register training data and first-subword-only tag supervision were both run and both failed to pay for themselves (above). Neither is adopted; neither should be re-tried without a changed hypothesis.
- **Scoring is by outcome**, so a slot value the resolvers accept passes even when it is not the reference string; `slot_accuracy` in the run JSONs under-reads for that reason and is not a headline.

## Recommendation

**Build the joint encoder pipeline into the runtime, with the int8 artifact.** One 22.7M MiniLM carrying an operation head, a BIO span tagger and per-enum classifiers, feeding the existing resolvers and executor — no separate selector, no generative filler anywhere in the loop. It is the only candidate that wins on every axis: 23.0 MB and 6.5 ms against Needle's per-platform C engine at ~900 ms, and .896 blind operation accuracy against the selector's .646 on the same turns. The int8 graph costs one frozen case against fp32 and no blind case, for a 3.95× size reduction.

**Ship it behind write confirmation and a "here is what I understood" rendering.** At `.650` blind — `.722` on the case shapes the runtime can express — the pipeline is good enough to propose an action and show the operation and slots it read out of the turn. It is not good enough to act silently, and nothing below should be read as a plan to remove the confirmation step.

Next levers, in priority order:

1. **Training-data register diversity, by offline paraphrasing with a larger local model.** Indirect phrasing of enums and optional slots is the plurality of remaining blind failures ("who am i in the red with" → `<absent>`, "other way round?" → the wrong class, "yesterday" and "at Acme" untagged). The naive version — `--register-wide`'s mechanical openers, trailers and lowercasing — was measured and lost a case, so the fix is real paraphrase, not surface noise. This is a one-time offline data step and needs the Qwen download authorised.
2. **A deterministic conjunction split in code**, so one utterance can yield two calls. Split on "and then" / "and &lt;verb&gt;", run the model twice, carry the first result as context; measure on the four blind chain cases, which are exactly this shape. A planner is not needed and should not be built.
3. **Optional slots and enums under indirect phrasing**, as the model-side complement to (1): weight the enum heads' loss on the rows that carry one, and generate optional-slot templates in oblique registers.
4. **Unseen-name spans, now secondary.** With a word-aware decoder and realistic invented names this is no longer the plurality. A variant that lowercases only proper nouns inside spans is the obvious next probe; casing/shape features and a character-aware span head are below it.

Running the Qwen3 4B comparison lane would also make the generative bar known rather than assumed, and its download is a prerequisite for lever 1 anyway.

## Reproduce

```sh
cd experiments/local-assistant
python3 blind/run_reference_blind.py --label reference-blind          # must be 0 failures
.venv-joint/bin/python run_suite_joint.py --label <new> --artifact j-06
.venv-joint/bin/python run_suite_joint.py --label <new> --artifact j-06 --suite blind
.venv-joint/bin/python joint/quantise_onnx.py --label j-06
.venv-joint/bin/python run_suite_joint.py --label <new> --artifact j-06 --onnx int8 --suite blind
.venv/bin/python needle/suite_run_selector.py --label <new> --artifact lr-3b --margin 0.3 --suite blind
```

Run labels are append-only. The runs behind this document: `reference-blind`, `j05-blind-e2e`, `j05-blind-legacy`, `j06-frozen`, `j06-blind`, `j05-int8-frozen`, `j05-int8-blind`, `needle-base-blind-m03`. Per-lane detail: [`joint/RESULTS-joint.md`](joint/RESULTS-joint.md), [`selector/RESULTS-selector.md`](selector/RESULTS-selector.md), [`needle/RESULTS-needle.md`](needle/RESULTS-needle.md).
