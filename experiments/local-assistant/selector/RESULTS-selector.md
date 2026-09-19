# Selector lane — results

Stage [1] of the pipeline: a closed-set classifier over the 45 catalogue
operations plus `none` and `clarify`, whose input is the protocol's JSON object
`{request, previous_request, previous_operation}`.

**Outcome: a logistic regression over frozen MiniLM embeddings, given the
previous operation as an explicit one-hot, selects the reference operation on
83.7% of the 98 suite turns** (val 70.1%, hand-written dev paraphrases 81.0%),
against 41.8% for the honest zero-shot baseline (cosine to the catalogue
descriptions) and 68.4% for k-NN retrieval over the generated data. It trains
in seconds on four CPU cores and predicts in about 5 ms per turn plus one
embedding pass.

Embedder: `sentence-transformers/all-MiniLM-L6-v2` — 22.7M parameters, 384
dimensions, ~90 MB on disk, ~0.8 s to encode a batch of short utterances on
this machine, 5.5 s to load.

## What was built

| File | What it is |
| --- | --- |
| `world_synthetic.py` | The training world: people, companies, events, projects, albums, notebooks, folders, groups, places, topics. No name is shared with `world.py`. |
| `templates.py` | 313 request templates across the 47 labels in mixed registers, plus continuation and previous-operation-dependent follow-up templates. Templates marked `!` deliberately borrow a sibling's frame. |
| `gen_selector_data.py` | Template × paraphrase × slot-value generator. Writes `train.jsonl` (5,477 rows) and `val.jsonl` (1,416 rows) with **whole templates** held out. |
| `dev_paraphrase.jsonl` | 153 hand-written paraphrases, ~3 per label, terse/chatty/typo'd/indirect, including 12 context-dependent follow-ups. |
| `overlap_check.py` | Token-Jaccard guard (> 0.8 rejected) against every suite utterance and every catalogue `example_utterance`, plus a suite-proper-noun leak check. Also called *during* generation, so a colliding sample is never written. |
| `overlap_report.json` | Its output: **0 offenders, 0 proper-noun leaks** over 6,925 unique generated utterances against 211 reference utterances. |
| `suite_labels.py` → `suite_selector.jsonl` | The test set: 98 turns, gold label = the reference operation for that turn, `previous_operation` = the previous turn's reference operation. Never trained on. |
| `run_zero_shot.py` | Description-cosine and k-NN baselines over three input renderings. |
| `run_trained.py` | Logistic regression over three feature layouts, calibration sweep, optional encoder fine-tune. |
| `coverage_check.py` | Top-1 / top-1+siblings / top-3 coverage for the saved artifact. |
| `report.py` | Renders a run JSON as the tables below. |
| `predict.py` | `select(request, previous_request, previous_operation) -> (label, top_k)` over the saved artifact. |

Data-shape rules the generator holds:

- **Whole templates are held out.** A template id never appears in both
  `train.jsonl` and `val.jsonl`; the generator raises if one does.
- **Sibling hard negatives.** Templates marked `!` phrase an operation in its
  sibling's frame (`tasks_about` as "what's on my list about X",
  `photos_at_place` as "what do I have from X"), so the surface frame alone
  cannot decide the label.
- **Multi-turn is 33% of training rows**: `with_context` (stale context that
  must be ignored, 1,407 rows), `continuation` (the label *is* the previous
  operation, 385 rows), `dependent` (the label is a function of the previous
  operation, 401 rows — "only the ones with X" is `people_profile` after
  `people_at` but `photos_of_people` after `photos_in_album`; no lexical cue
  exists).

## Accuracy

Three input renderings: `request` (the request alone), `json` (the protocol
object verbatim), `context` (a prose rendering: *"after photos in album for
'…'. user says: …"*). `fields` is not a rendering but a feature layout:
embedding(request) ⊕ embedding(previous_request) ⊕ one-hot(previous_operation).

| variant | run | val | dev_paraphrase | suite |
| --- | --- | --- | --- | --- |
| `description:request` (zero-shot) | zs-01 | 0.323 | 0.294 | 0.418 |
| `description:json` (zero-shot) | zs-01 | 0.208 | 0.163 | 0.225 |
| `description:context` (zero-shot) | zs-01 | 0.299 | 0.255 | 0.367 |
| `knn:request` (k=5, no training) | zs-01 | 0.567 | 0.686 | 0.684 |
| `knn:json` | zs-01 | 0.505 | 0.647 | 0.510 |
| `knn:context` | zs-01 | 0.530 | 0.686 | 0.643 |
| `logreg:request` | lr-01 | 0.581 | 0.778 | 0.775 |
| `logreg:context` | lr-01 | 0.594 | 0.791 | 0.694 |
| **`logreg:fields`** | lr-01 | **0.701** | **0.810** | **0.837** |
| `finetune:context` (encoder fine-tune, ~47 min CPU) | ft-01 | 0.727 | 0.791 | 0.837 |

Val is the hardest number and the honest one: held-out templates, and it
includes the context-dependent families where a wrong previous operation is
unrecoverable. The suite scores *higher* than val because the suite's 98 turns
are dominated by plain single-app reads and writes.

### Suite accuracy by category

| variant | single_read | single_write | cross_app_one_call | chain | follow_up | reference_into_result | refusal_none |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `description:request` | 0.61 (11/18) | 0.50 (7/14) | 0.10 (1/10) | 0.44 (7/16) | 0.19 (3/16) | 0.50 (8/16) | 0.50 (4/8) |
| `knn:request` | 0.72 (13/18) | 0.50 (7/14) | 0.50 (5/10) | 0.75 (12/16) | 0.62 (10/16) | 0.81 (13/16) | 0.88 (7/8) |
| `knn:context` | 0.61 (11/18) | 0.43 (6/14) | 0.40 (4/10) | 0.62 (10/16) | 0.81 (13/16) | 0.75 (12/16) | 0.88 (7/8) |
| `logreg:request` | 0.78 (14/18) | 0.71 (10/14) | 0.60 (6/10) | 0.94 (15/16) | 0.56 (9/16) | 0.88 (14/16) | 1.00 (8/8) |
| `logreg:context` | 0.72 (13/18) | 0.71 (10/14) | 0.60 (6/10) | 0.50 (8/16) | 0.75 (12/16) | 0.69 (11/16) | 1.00 (8/8) |
| **`logreg:fields`** | 0.83 (15/18) | 0.71 (10/14) | 0.60 (6/10) | 0.88 (14/16) | 0.88 (14/16) | 0.94 (15/16) | 1.00 (8/8) |
| `finetune:context` | 0.83 (15/18) | 0.71 (10/14) | 0.60 (6/10) | 1.00 (16/16) | 0.88 (14/16) | 0.88 (14/16) | 0.88 (7/8) |

`cross_app_one_call` is the weakest category for every variant (0.60 at best):
"who was at the design review, and do I owe any of them" reads like two
operations, and the catalogue's answer — one operation with a phrase argument —
is exactly the thing no surface cue marks.

Both `none` refusals and all six clarify-outcome turns are selected correctly
by `logreg:fields` (`refusal_none` 8/8). Note that the suite's gold label for a
clarify *outcome* is the real operation (e.g. `people_profile` for "what's
Neha's email", where two Nehas exist): the resolvers raise the clarification,
not the selector. `clarify` is therefore a trained label with zero suite
support, and it costs nothing — it never fires on a suite turn.

### Top confusions on the suite

- `logreg:fields`: `photos_in_album -> photos_add_to_album` ×3,
  `docs_search -> docs_in_folder` ×1, `locker_weak -> locker_add` ×1,
  `notes_create -> tasks_add` ×1, `notes_append -> agenda_create_event` ×1,
  `locker_add -> locker_find` ×1, `tasks_for_people -> people_at` ×1 (four different reads collapse onto `people_at` once, each once).
- `logreg:request`: same head (`photos_in_album -> photos_add_to_album` ×3),
  then a long tail of singletons.
- Zero-shot description: `tasks_due -> agenda_day_context` ×5,
  `tally_balance_with -> tally_who_owes_me` ×4,
  `photos_of_people -> photos_at_place` ×3 — the declared sibling pairs the
  protocol calls out, all of them.

The single systematic error left is `photos_in_album → photos_add_to_album`: all
three "show me the {album} album" turns. The album name carries most of the
sentence embedding and both operations are about an album, so the read/write
distinction is lost. This is the exact shape of the trap the brief names (a
one-noun-phrase operation becoming a sink); it wants either more contrastive
training pairs on read-vs-write-into-an-album, or a cheap imperative-verb
feature.

### Calibration — `logreg:fields` on the suite

A turn whose top-two probability margin is below the threshold is sent to the
`clarify`/"show the operation plus its siblings" path.

| margin | coverage | accuracy on answered | accuracy if a deferral counts wrong |
| --- | --- | --- | --- |
| 0.0 | 1.000 | 0.837 | 0.837 |
| 0.05 | 0.939 | 0.859 | 0.806 |
| 0.1 | 0.878 | 0.872 | 0.765 |
| 0.2 | 0.827 | 0.889 | 0.735 |
| 0.3 | 0.745 | 0.918 | 0.684 |
| 0.5 | 0.531 | 1.000 | 0.531 |
| 0.7 | 0.398 | 1.000 | 0.398 |

Margin is usable but not sharp: at 0.3 the selector is right on 91.8% of the
74.5% of turns it answers. The better use of the margin is not to refuse but to
widen the tool set shown to the filler:

| set shown to the filler | val | dev_paraphrase | suite |
| --- | --- | --- | --- |
| top-1 | 0.701 | 0.810 | 0.837 |
| top-1 + its catalogue siblings | 0.758 | 0.856 | 0.867 |
| top-3 operations | 0.916 | 0.941 | 0.908 |

Top-3 buys far more than top-1+siblings (+7 points on the suite, +21 on val),
because the wrong top-1 is often *not* a declared sibling (`notes_append →
agenda_create_event`). If the filler can be shown three operations, it should be
shown the top three, not the catalogue's sibling list.

## Wall clock and sizes

| Step | Cost |
| --- | --- |
| Data generation + overlap check | ~40 s (pure Python) |
| Embedding 8,144 turns (train + val + dev + suite, ×3 renderings) | ~2 min |
| Logistic-regression fit (5,477 × 816 features, 47 classes) | ~20 s |
| Zero-shot run `zs-01` end to end | 492 s |
| Trained run `lr-01` end to end (3 variants + calibration) | 468 s |
| Encoder fine-tune (`ft-01`, 2 epochs, batch 32, 4 threads) | 3,304 s (~55 min), fine-tune only ≈ 47 min |
| MiniLM-L6-v2 on disk | ~90 MB |
| `logreg_fields.pkl` artifact | 313 KB |

### Encoder fine-tune

`run_trained.py --finetune` (run `ft-01`) trains the encoder itself with a
mean-pooled classification head on the `context` rendering, AdamW 3e-5, 2
epochs over 5,477 rows. It ran in 47 minutes on four cores — roughly 200×
the cost of fitting the logistic regression — and bought this:

| variant | val | dev_paraphrase | suite |
| --- | --- | --- | --- |
| `logreg:fields` | 0.701 | 0.810 | **0.837** |
| `finetune:context` | **0.727** | 0.791 | **0.837** |

Suite accuracy by category, `finetune:context`: single_read 0.83, single_write
0.71, cross_app_one_call 0.60, chain **1.00 (16/16)**, follow_up 0.88,
reference_into_result 0.88, refusal_none 0.88. It is better calibrated —
at a 0.1 margin it answers 80.6% of turns at 93.7% accuracy, against the
logistic regression's 87.8% at 87.2% — and its errors are different singletons
(`tally_group_balance -> tally_balance_with` ×2 is its only repeat), with the
`photos_in_album -> photos_add_to_album` block gone. But it is *not* better on
the held-out paraphrases, it loses one refusal, and it needs the whole encoder
saved and fine-tuned per catalogue change.

Verdict: not worth it yet. Equal suite accuracy, +2.5 points of val, −2 points
of dev, for 47 minutes of CPU and a 90 MB artifact that goes stale whenever an
operation is added. Revisit only if the catalogue stabilises and the runtime
needs the better calibration; the cheaper next move is more contrastive data
on the read-vs-write pairs that remain wrong.

## What did not work

- **Feeding the protocol JSON to the embedder.** `json` is the worst rendering
  in every family (suite 0.225 zero-shot, 0.510 k-NN). Braces, quotes and
  snake_case keys dominate a 384-dimension sentence embedding. The protocol's
  wire format is a wire format, not a model input.
- **Prose context for a linear model.** `logreg:context` is *worse* than
  `logreg:request` on the suite (0.694 vs 0.775): folding the previous turn
  into the same vector as the request blurs the request. The previous operation
  has to arrive as its own feature — that is the whole gap between `context`
  (0.694) and `fields` (0.837).
- **Cosine to catalogue descriptions.** 41.8% at best, and it fails exactly on
  the declared sibling pairs. A description written for a human reader is not a
  class prototype.

## Recommendation for the runtime

1. Carry `logreg:fields`: MiniLM-L6-v2 (~90 MB) + a ~350 KB linear model.
   Selection costs one embedding pass per turn.
2. Feed it three fields separately — never the JSON string: embed the request,
   embed the previous request, one-hot the previous operation over the 45
   operations plus a "no previous turn" slot.
3. Show the filler the **top three** operations when the margin is below ~0.3,
   and the top one above it. That is 74.5% of turns at 91.8% top-1 accuracy,
   and 90.8% gold-in-set on the rest.
4. Treat `clarify` as a selector label but expect the resolvers, not the
   selector, to raise most clarifications: the suite's clarify outcomes all have
   a real operation as their gold label.
5. Fix `photos_in_album` vs `photos_add_to_album` with data, not thresholds.

## Reproduce

```sh
cd experiments/local-assistant
/root/.local/bin/uv venv --python /usr/local/bin/python3 .venv-selector
VIRTUAL_ENV=$PWD/.venv-selector /root/.local/bin/uv pip install -r selector/requirements.txt

python3 selector/gen_selector_data.py --write --per-template 22
python3 selector/suite_labels.py --write
python3 selector/overlap_check.py --write          # must print "offenders: 0"

./.venv-selector/bin/python selector/run_zero_shot.py --label zs-02
./.venv-selector/bin/python selector/run_trained.py --label lr-02 --save-artifact
# optional, ~50 min on 4 CPUs:
./.venv-selector/bin/python selector/run_trained.py --label ft-02 --finetune --epochs 2
./.venv-selector/bin/python selector/coverage_check.py --label lr-02
python3 selector/report.py runs/zs-02.json runs/lr-02.json --per-op logreg:fields
./.venv-selector/bin/python selector/predict.py
```

Run labels are append-only: `runs/<label>.json` is refused if it exists, so a
re-run takes a new label. `runs/` (apart from `runs/reference.json`), the
virtualenv and `selector/artifacts/` are gitignored; the artifact rebuilds from
the commands above in about three minutes.
