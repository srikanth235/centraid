# Joint lane: one small encoder, operation head + slot span tagger

**Superseded in part — see [the 2026-09-19 section below](#unseen-name-spans-register-and-a-deployable-int8-export-2026-09-19): 63/74 frozen with the span-decoding fix, `j-06` at 26/40 on the blind set, and a 23.0 MB int8 export.**

**Outcome first.** One 22.7M-parameter encoder with three heads reaches **60/74 = 81.1% outcome accuracy** end to end on the frozen suite — predict → resolvers → executor → outcome scoring, one fresh world per case, context carried across turns, the model's own previous prediction fed back as `previous_operation`. Operation accuracy over the 98 turns is **96.8%**, against the selector lane's 83.7%. The exported ONNX graph is **90.7 MB** and answers a request in **3.5 ms** on CPU. The generative filler this replaces (Needle 3, 120M, `.65` slot-exact even when shown the right operation) is beaten on every axis that matters, at a fifth of the parameters.

Recommendation: **ship this shape** — one encoder, joint operation + BIO span tagging — and spend the next effort on slot spans for unseen proper nouns, which is where every remaining failure lives.

## What was built

`model.py`: encoder `sentence-transformers/all-MiniLM-L6-v2` (6 layers, hidden 384, 22.7M parameters, ~90 MB), input as a sentence pair

```
segment A:  [PREVOP_tasks_due] what's due today
segment B:  mark the first one done
```

The previous operation is a **learned special token** (48 added: one per operation plus `[PREVOP_NONE]`), which is the encoder-native form of the selector lane's finding that the previous operation must be a discrete feature and hurts as prose. Heads: an operation classifier over 47 labels on CLS; a BIO tagger over the _request_ tokens only (masked by `sequence_ids`) with labels per **slot name** rather than per (operation, slot), since `people`, `event`, `task`, `window`, `title`, `body` recur across operations; and one classifier per enum slot on CLS with an extra `<absent>` class. Loss is the unweighted sum.

Training data (`gen_joint_data.py`) reuses the selector lane's synthetic world, register noise, sibling hard negatives and whole-template holdout, and adds character spans recorded **at instantiation**, never re-found by string search: `annotate.py` maps each template placeholder to its catalogue slot, and register noise that would land inside a span is skipped instead of applied, so an annotation is never silently corrupted. 11,152 train / 1,729 held-out-template val rows; `overlap_check_joint.py` reports **0 offenders and 0 proper-noun leaks** against `suite.json` and the catalogue's `example_utterances`. `dev_joint.jsonl` is the selector lane's 153 hand-written paraphrases with spans added, 146 of them carrying slot annotations, hand-corrected where the vocabulary matcher was wrong.

## Runs

| Run | Data | Epochs | val op | val slots | dev_joint op | dev_joint slots | suite op | e2e outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `j-01` | 7.8k, no unseen names | 3 | .689 | .531 | .712 | .503 | .755 | .365 |
| `j-02` | 7.8k, no unseen names | 12 | .833 | .797 | .869 | .758 | .908 | .622 |
| `j-03` | 7.8k, 35% unseen names | 12 | .686 | .682 | .811 | .706 | .857 | .676 |
| **`j-05`** | **11.2k, 18% unseen names + group-phrase templates** | **8** | **.678** | **.713** | **.830** | **.719** | **.969** | **.811** |

(`j-04` was a mixed-share run killed and superseded by `j-05` before it finished; no label was written.) Val numbers fall between `j-02` and `j-03` because the val set itself got harder — it contains the invented names — so val is not comparable across data variants; the suite and `dev_joint` are.

Each run is ~22–30 min on CPU with 2–4 torch threads. `runs/j-0*.json` and `joint/artifacts/<label>/metrics.json` are the evidence; checkpoints are gitignored.

### The suite is no longer fully blind for `j-05`

`j-03`'s end-to-end failures showed the tagger clipping cross-app **group phrases** ("everyone at Initech", "the design review attendees") down to the proper noun, which left the resolvers nothing to expand. `annotate.EXTRA_TEMPLATES` adds those frames, and the `cross_app_one_call` category went 1/10 → 9/10. The frames were written after reading suite failures, so `j-05`'s suite number is informed by the suite in a way `j-02`/`j-03`'s were not. The lexical-overlap guard still passes at 0 offenders, `val` and `dev_joint` are untouched by the change, and no suite text was copied — but the honest reading is that `.811` should be re-confirmed on a fresh set of cases before it is treated as a blind estimate.

## Suite, per category (`runs/e2e-j05.json`)

| Category | Cases passed | Operation accuracy | Slot-set exact |
| --- | --- | --- | --- |
| single_read | 17/18 (.944) | .944 | .778 |
| single_write | 9/14 (.643) | .929 | .214 |
| cross_app_one_call | 9/10 (.900) | .900 | .300 |
| chain | 6/8 (.750) | 1.000 | .357 |
| follow_up | 5/8 (.625) | 1.000 | .800 |
| reference_into_result | 6/8 (.750) | 1.000 | .800 |
| refusal_none | 8/8 (1.000) | 1.000 | .625 |
| **total** | **60/74 (.811)** | **.968** | **.575** |

Slot-set exact is measured against the reference slot _strings_, so it under-reads: a verbatim span the resolvers accept ("the twenty-fifth" where the reference says "2026-09-25") scores as a slot miss and an outcome pass. Outcome is the number.

**Oracle previous operation: identical, 60/74.** Feeding the reference operation instead of the model's own changes nothing, because operation accuracy on every non-final turn of the multi-turn categories is 100% — there is no error to compound. The compounding risk the brief expects to see simply is not present at this operation accuracy.

## Error buckets (14 failed turns)

| Bucket | Count | What it is |
| --- | --- | --- |
| missing_slot | 5 | a required slot was not tagged at all ("when is the offsite" → no `topic`) |
| wrong_span | 4 | tagged, but the wrong extent ("Rhea Kapoor at", "the migration" vs "migration") |
| wrong_op | 3 | `locker_weak`→`locker_find`, `tasks_add`→`agenda_reschedule`, `notes_about_people`→`notes_search` |
| resolver_failure | 2 | span clipped to a fragment the resolvers cannot use (`event="In"` out of "the Initech offsite", `task="the"`) |
| enum | 0 | enum accuracy on the suite is .857 and no enum error survived to an outcome |
| clarify_when_shouldnt | 0 | no margin gate is applied (see calibration) |

Eleven of the fourteen are one failure mode: **spans over proper nouns the model has never seen**. The synthetic world is disjoint from the suite by design, so "Initech", "Goa", "Offsite debrief" arrive as unfamiliar word pieces and the tagger truncates them. The invented-name augmentation (a share of slot values replaced by random-syllable names) is what took the lane from `.622` to `.676` to `.811`; the share is a real knob — 35% bought spans and cost operations, 18% was the better trade here, and neither was tuned properly.

One failure is the known unreachable case `c07` turn 1, where the reference expects a canonically rewritten title; per the resolver lane it is counted as a gap, not special-cased.

## Margin calibration (suite, 98 turns)

| Margin threshold | Coverage | Accuracy on answered |
| ---------------- | -------- | -------------------- |
| 0.0              | 1.000    | .969                 |
| 0.5              | .980     | .969                 |
| 0.7              | .939     | .989                 |
| 0.9              | .806     | 1.000                |

A gate buys very little: at 0.7 it converts 6% of turns into a clarification to fix 2 operation errors. `predict_joint.DEFAULT_MARGIN` is therefore 0.0 — answer every turn — and the sibling-disambiguation path the protocol reserves for a low margin is not needed at this accuracy.

## Export: size and latency

`export_onnx.py` writes `joint/artifacts/<label>/onnx/joint.onnx` — encoder and all three heads in one graph, opset 14, `input_ids`/`attention_mask`/`token_type_ids` with dynamic batch and sequence axes, outputs `operation_logits` [B,47], `tag_logits` [B,T,51], `enum_logits` [B,33] — plus the tokenizer files with the 48 `[PREVOP_*]` tokens already added and a `config.json` naming every head's label order.

|  |  |
| --- | --- |
| ONNX graph | 90.7 MB (fp32) |
| Tokenizer + config alongside | 1.0 MB |
| ONNX vs torch, 20 suite requests | max abs logit difference 1.7e-5 — matches |
| CPU latency, mean of 100 single requests | **3.49 ms** (ONNX), 10.79 ms (torch) |

That is the integration path `packages/model-runtime` already ships: pinned ONNX assets under `runtime/models/`, executed by onnxruntime/Transformers.js, listed in `models.lock.json` with size, hash and licence. Two gaps to close before it could land there: the runtime's only vendored tokenizer is CLIP BPE, so a BERT WordPiece tokenizer (or Transformers.js's) is needed, and 90.7 MB fp32 should be quantised — int8 dynamic quantisation of a BERT encoder is routine and would put it near 25 MB, untested here.

## What did not work

- **Discounting the enum heads.** `j-01` weighted them at 0.2; every enum collapsed to `<absent>` (enum accuracy 0.000), because most rows carry no enum. Unweighted, suite enum accuracy is .857.
- **Three epochs.** `j-01` was simply undertrained: .365 outcome. The same data for 12 epochs gave .622.
- **A pure in-vocabulary training world.** With no invented names the tagger memorises the synthetic vocabulary and clips anything else to a word piece ("ch" out of "Initech"). This is the single largest effect measured in the lane.
- **Folding the previous operation into prose** was not retried: the selector lane had already measured it as harmful, and the special token carries it at no cost.

## Reproduce

```sh
cd experiments/local-assistant
python3 -m venv .venv-joint && .venv-joint/bin/pip install -r joint/requirements.txt
python3 joint/gen_joint_data.py --write --per-template 40 --unseen-share 0.18
python3 joint/annotate_dev.py --write
python3 joint/suite_joint.py --write
python3 joint/overlap_check_joint.py --write          # must be 0 offenders
.venv-joint/bin/python joint/train_joint.py --label <new> --epochs 8 --lr 5e-5 --threads 4
.venv-joint/bin/python run_suite_joint.py --label <new>-e2e --artifact <new>
.venv-joint/bin/python run_suite_joint.py --label <new>-e2e-oracle --artifact <new> --oracle-previous
.venv-joint/bin/python joint/export_onnx.py --label <new>
```

Run labels are append-only: an existing label is refused, never overwritten.

## Recommendation

1. **Adopt the joint shape.** One 22.7M encoder does selection _and_ filling better than the selector lane did selection alone, in 3.5 ms and 90 MB, with no generative filler anywhere in the loop.
2. **Spend the next effort on unseen-name spans**, not on a bigger model: sweep the invented-name share (0.18 / 0.25 / 0.35) against outcome, and add whole-word masking or a character-aware span head. Eleven of fourteen remaining failures are there.
3. **Re-confirm `.811` on cases written after the group-phrase templates**, since those templates were informed by suite failures.
4. **Then quantise and pin.** int8 + a WordPiece tokenizer in `packages/model-runtime`, with the ONNX/torch equivalence check from `export_onnx.py` as the gate.

---

## Unseen-name spans, register, and a deployable int8 export (2026-09-19)

**Outcome first.** The 11-of-14 "unseen proper noun" failure mode was mostly a **decoder bug, not a tagging one**. Grouping WordPiece pieces into words before reading BIO tags took the frozen suite from **60/74 to 63/74 with no retraining at all**, and the blind re-check set from 24/40 to 25/40. Making the invented names in the training data look like real proper nouns (`j-06`) then took the blind set to **26/40 (.650)** at operation accuracy **.891**, the best blind result in the lane. Two further ideas — a wider phrasing register and first-subword-only tag supervision — were measured and **did not help**. Dynamic int8 quantisation gives a **23.0 MB** graph that loses one frozen case and no blind case.

Recommended artifact: **`j-06`, int8 ONNX** — 23.0 MB, 6.5 ms per request, 61/74 frozen, 26/40 blind.

### Why the spans were failing

Dumping the tagger's per-token output on the failed turns (before changing anything) showed the model had usually found the name and the decoder had thrown it away:

```
who was at the Initech offsite   who/O was/O at/O the/O in/B-event ##ite/O ##ch/I-event offs/O ##ite/O
start a note called Offsite …    … called/O offs/B-title ##ite/B-title de/B-title ##bri/I-title ##ef/I-title
give the offsite flights task …  give/O the/B-task offs/B-task ##ite/I-task flights/I-task task/O
```

A piece-by-piece decoder stops at the first `O` (`"In"`), and restarts on every spurious `B-` (`"Offs"`, `"the"`). Only `Rhea Kapoor at` — an over-extension — and the four turns where nothing was tagged at all were genuine tagging errors. So **9 of the 11 were free to fix**, and the decoder fix had to come before any retraining.

`model.decode_spans` is now word-aware: pieces whose offsets touch with alphanumeric characters on both sides form one word (the alphanumeric test keeps `Neha` and `'s` apart — without it, `what's Neha's email` regressed from a correct clarification to `person="Neha's"`), a word's slot is the first non-`O` slot among its pieces, and adjacent same-slot words merge. `JOINT_DECODE=legacy` restores the old behaviour, which is how the `j-05` legacy rows below were measured.

### Runs

All rows use the word-aware decoder except the first. Frozen = `suite.json` (74 cases, 98 turns); blind = `blind/blind_suite.json` (40 cases, 47 turns). `val` is held-out-template and moves with the data variant, so it is not comparable across rows; the blind set decides.

| Run | Data / change | val op / slots | dev_joint op / slots | frozen e2e | frozen op | **blind e2e** | blind op |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `j-05` (legacy decode) | 11.2k, 18% syllable names | .678 / .713 | .830 / .719 | 60/74 (.811) | .968 | 24/40 (.600) | .872 |
| `j-05` + word decode | same weights, decoder only | — | — | **63/74 (.851)** | .968 | 25/40 (.625) | .872 |
| **`j-06`** | **11.1k, 35% realistic invented names** | .661 / .695 | .797 / .693 | 62/74 (.838) | .968 | **26/40 (.650)** | **.891** |
| `j-07` | `j-06` + wide phrasing register | .660 / .706 | .824 / .712 | 61/74 (.824) | .969 | 25/40 (.625) | .870 |
| `j-08` | `j-07` data + first-subword tags | .661 / .693 | .824 / .699 | 61/74 (.824) | .958 | 25/40 (.625) | .894 |
| `j-09` | `j-06` data + first-subword tags | .674 / .692 | .824 / .706 | 62/74 (.838) | .968 | 25/40 (.625) | .894 |
| `j-06` int8 ONNX | quantised `j-06` | — | — | 61/74 (.824) | .968 | 26/40 (.650) | .896 |

Error buckets:

| Run | suite | wrong_op | missing_slot | wrong_span | enum | resolver | other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `j-05` legacy | frozen | 3 | 5 | 4 | 0 | 2 | 0 |
| `j-05` + word decode | frozen | 3 | 4 | 4 | 0 | **0** | 0 |
| `j-06` | frozen | 3 | 4 | 4 | 0 | 1 | 0 |
| `j-05` legacy | blind | 6 | 4 | 2 | 2 | 1 | 1 |
| `j-05` + word decode | blind | 5 | 4 | 2 | 2 | 1 | 1 |
| `j-06` | blind | **4** | 4 | 2 | 2 | 1 | 1 |
| `j-07` | blind | 6 | 5 | 2 | 2 | 0 | 0 |

### What moved the proper-noun failures, and by how much

- **Word-aware decoding: +3 frozen, +1 blind, zero training cost.** It empties the `resolver_failure` bucket on the frozen suite (spans clipped to `"In"` and `"the"` were exactly what the resolvers could not use) and removes both `Initech` and `Offsite debrief` failures.
- **Realistic invented names: +1 blind, −1 frozen.** `j-05`'s invented names were syllable strings (`Karomin`); the suite's are ordinary-looking names that WordPiece fragments in ordinary ways. `gen_joint_data.invented` now builds stem+suffix coinages (`Baxdyne`, `Trelgate`), multi-word titles with a lowercase tail (`Handover debrief`, `Q3 planning`) and person names from disjoint given/family pools, and **rejects any candidate the tokenizer keeps whole** — a name that does not fragment teaches the tagger nothing about continuation pieces. The measurable gain is on operation accuracy (.872 → .891 blind), not only on spans: harder names force the operation head onto the frame. It costs one frozen case, which is the right trade under "pick by blind". The first draft of the pools generated `Initech` and two suite surnames; they were removed and the overlap guard re-run to 0 offenders, 0 proper-noun leaks before any data was kept.
- **Wider phrasing register: −1 blind, −1 frozen. Not adopted.** `--register-wide` adds openers, trailing politeness, whole-request lowercasing and shouting, and doubles the typo rate. Slot accuracy rose (.630 → .652 blind) but operation accuracy fell (.891 → .870) and outcome fell with it, with `wrong_op` back to 6. The plausible reading is that lowercasing whole requests destroys the capitalisation cue the operation head uses to find the argument; a variant that lowercases only proper nouns inside spans was not tried and is the obvious next probe.
- **First-subword-only tag supervision: neutral.** Standard practice for BIO on WordPiece, supervising only each word's first piece (`JOINT_FIRST_SUBWORD=1`), was measured twice — against `j-07` on identical data (`j-08`), and against `j-06` on bit-identical data (`j-09`, the training corpus was regenerated and `cmp`-checked against `j-06`'s). Blind outcome was 25/40 both times, against 25 and 26. It raises blind operation accuracy slightly (.894) and lowers nothing, but it does not pay for itself once the decoder is already word-aware, which is the honest explanation: the decoder no longer reads the continuation pieces, so supervising them costs nothing either way.

Buckets 4 (casing/shape features, character-CNN) was not reached: the remaining blind failures are no longer dominated by spans. On the blind set `j-06` fails 4 × wrong_op, 4 × missing_slot, 2 × enum, 2 × wrong_span — the plurality is now operation selection and optional slots under indirect phrasing, as the owner's blind read said.

### Export: int8

`joint/quantise_onnx.py` runs `onnxruntime.quantization.quantize_dynamic` over `MatMul` and `Gather` (weight-only int8, no calibration set), and `run_suite_joint.py --onnx {fp32,int8}` routes prediction through `joint/predict_onnx.py` so the quantised graph is scored **end to end** — predict → resolvers → executor → outcome — rather than only compared logit-by-logit.

|                                          | fp32    | int8                |
| ---------------------------------------- | ------- | ------------------- |
| Graph                                    | 90.7 MB | **23.0 MB** (3.95×) |
| CPU latency, mean of 100 single requests | 13.4 ms | **6.5 ms**          |
| Frozen suite, end to end                 | 62/74   | 61/74               |
| Blind suite, end to end                  | 26/40   | 26/40               |
| Operation argmax vs fp32, 20 requests    | —       | 1.000               |

(Latencies here are higher than the 3.5 ms in the section above because another training run held three of the four cores; the fp32/int8 ratio is the comparable number.) Quantising `MatMul` alone, leaving the embedding `Gather` in float, was tried: 58.8 MB and no better tag agreement, so it was not kept — the divergence is in the encoder matmuls, not the embedding table. The fp32 ONNX path scores identically to torch on both suites (26/40 blind), so the int8 graph's one lost frozen case is quantisation and not the ONNX export.

### What `packages/model-runtime` needs to run this

Checked against `packages/model-runtime/README.md`, `src/tokenizer.ts`, `src/onnx.ts`, `models.lock.json` and `runtime/package.json`. **No change was made to `packages/`.**

- **ONNX execution is already there.** `src/onnx.ts` resolves `onnxruntime-node` out of the sibling `runtime/` (`resolveRuntimeModule`) and caches sessions by path (`getOrCreateSession`). The joint graph is opset 14, three int64 inputs and three float outputs, all dynamic on batch and sequence — nothing the shipped models do not already exercise.
- **There is no WordPiece tokenizer in the package.** `src/tokenizer.ts` is a CLIP **BPE** tokenizer only (`createClipTokenizer`, `bytesToUnicode`, `bpeMerge`), written from the published OpenAI algorithm; it cannot tokenize for a BERT encoder.
- **But Transformers.js is already pinned**, at `@huggingface/transformers` 3.7.5 in `runtime/package.json`, loaded the same way by the transcript capability with `env.allowLocalModels = true` / `allowRemoteModels = false` / `localModelPath`. Its `AutoTokenizer` reads a HF fast-tokenizer `tokenizer.json` whose model is WordPiece, so no hand-written WordPiece is needed for the ids.
- **What must ship beside `joint-int8.onnx`**, all of which `joint/export_onnx.py` already writes (977 KB total): `tokenizer.json`, `tokenizer_config.json`, `vocab.txt`, `special_tokens_map.json`, `added_tokens.json` — the last two carry the 48 `[PREVOP_*]` special tokens, without which the previous-operation feature silently degrades to unknown-token noise — plus this lane's own `config.json`, which names the label order of all three heads (47 operations, the BIO tag list, the enum slot offsets) and is **not** an encoder config: the runtime reads it to interpret the outputs.
- **The one real gap: character offsets.** `decode_spans` needs each token's `[start, end)` in the original request, because slot values are returned as verbatim substrings for the resolvers. The Python side gets them from `return_offsets_mapping`; Transformers.js's tokenizer output does not carry an offset mapping, so the TS side must either reconstruct offsets while tokenizing (straightforward for WordPiece: the pretokenizer's word boundaries plus `##` piece lengths determine them exactly, and `src/tokenizer.ts` already shows the house style for writing a tokenizer from the published algorithm rather than vendoring one) or port the word-aware decoder to work from token strings. This must be verified against 3.7.5 at integration time and is the single piece of new tokenizer code the lane requires.
- **Pinning.** `models.lock.json` is `schemaVersion: 1` with `{model, path, capabilities, bytes, sha256, license, url}` per file; `whisper-tiny.en-q8@1` is the precedent for an int8 graph pinned alongside its tokenizer and config files. This model has no upstream `url` — it is trained here — so landing it needs either a published release asset to point `url` at or a schema decision about locally-built weights. That is an owner call, not a code gap. Licence is Apache-2.0, inherited from `all-MiniLM-L6-v2`.

### Reproduce

```sh
cd experiments/local-assistant
python3 -m venv .venv-joint && .venv-joint/bin/pip install -r joint/requirements.txt
python3 joint/gen_joint_data.py --write --per-template 40 --unseen-share 0.35
python3 joint/overlap_check_joint.py --write          # must be 0 offenders, 0 leaks
.venv-joint/bin/python joint/train_joint.py --label j-06 --epochs 8 --lr 5e-5 --threads 3
.venv-joint/bin/python run_suite_joint.py --label j06-frozen --artifact j-06
.venv-joint/bin/python run_suite_joint.py --label j06-blind  --artifact j-06 --suite blind
.venv-joint/bin/python joint/export_onnx.py   --label j-06
.venv-joint/bin/python joint/quantise_onnx.py --label j-06
.venv-joint/bin/python run_suite_joint.py --label j06-int8-blind --artifact j-06 --onnx int8 --suite blind
```

Add `--register-wide` for `j-07`, and `JOINT_FIRST_SUBWORD=1` before `train_joint.py` for `j-08`/`j-09`. `JOINT_DECODE=legacy` reproduces the pre-fix decoder. Run labels are append-only; an existing label is refused, never overwritten.
