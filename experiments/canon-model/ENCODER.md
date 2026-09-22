# Tier A — the encoder-with-heads parser

A small pretrained **encoder** that makes CLASSIFICATIONS over the canonical grammar and TAGS spans of the member's own words. It emits no canonical characters at all: a decoder written in Python fills a template drawn from the training inventory with terminals drawn from `grammar/lexicon.py`'s vocabularies. An invented command name, an unknown field or an ungrammatical string is **impossible by construction** — flan-t5's failure mode (b) is closed outright, and parse rate goes from 34–57% to 99.1–99.8%, where the handful of remaining failures are a malformed _template_, never a malformed token.

Everything here reads `grammar/map.json` for `request`, `corpus/session/turn` and — only in `--mode teacher` and only as CONTEXT — the previous gold canonical. No gold canonical reaches training.

Scripts: `encoder/`. Never committed, never pushed.

**Headline: the parser is legal and fast and still far below the Tier D floor.** Round 2 reaches 12/120 · 8/60 · 16/78 strict sessions against a floor of 53/120 · 34/60 · 31/78. The design is sound and the bottleneck is named below: a flat template classifier whose inventory caps the corpus at 65.7% and whose realised accuracy is 18.7%.

---

## 1. The decomposition, and its round-trip proof

`encoder/canon_decomp.py` turns a canonical into **decision labels + copied spans**, and back. The decomposition is done on CHARACTER SPANS of the canonical string: every lexical terminal a model would have to choose is replaced in place by a typed hole `<TYPE#i>` and every other character is kept verbatim, so reassembly is string substitution and round-trip is exact by construction wherever the scanner covers the string. A canonical whose scan leaves an unknown identifier behind is REPORTED, not silently templated.

| hole | how the model decides it | vocabulary |
| --- | --- | --- |
| `KIND` ×5 | closed classification | 21 |
| `FIELD` ×4 | closed classification | 79 |
| `CMP` ×2 | closed classification | 4 |
| `WIN` ×2 | closed classification | 16 |
| `VERB` ×2 | closed classification | 73 |
| `REF` ×2 | closed classification | 9 |
| `DIR` ×1 | closed classification | 2 |
| `ARG` ×4 | closed classification | 42 |
| `REASON` ×1 | closed classification | 4 |
| `DATE` ×2, `NUM` ×2, `DUR` ×1 | closed classification | 38 / 30 / 6 |
| `LIT` ×5 | **BIO span copy out of the input text** | open |
| template | one class over the 1 200 templates seen in training | 1 200 |

This is the grammar's own decision tree flattened: `check.py`'s `turn` → `value`/`cmd`/`show` choice, its `set_postfix` loop and its `pred_atom` dispatch all live in the template class; every terminal those rules consume is one slot head.

### A finding that had to be fixed before anything could be measured

`data/train.jsonl` writes `show events called "x"`. `grammar/map.json` writes `show (events called "x")`. Both parse to the same tree — the grammar only requires a nested `Set` operand to be parenthesised, and a redundant paren is legal — so **a model trained on the generator's style scores 0 string-exact against the corpus no matter how right it is**. Before normalisation only **3.5%** of the 434 gold canonicals had a template the generator had ever produced; after it, **65.7%**. That is very likely a large part of flan-t5's 0% exact.

`encoder/render.py` is therefore an unparser from `check.py`'s own tree to ONE fixed style — the corpus's — and every canonical is normalised through it before it is decomposed. `normalise` is idempotent, tree-preserving on every row of train, val and map.json, and **429 of the 434 gold canonicals are byte-identical to their own normalisation** (the 5 are `refuse : reason` spacing ×3 and two union paren spellings the corpus itself writes both ways).

### Round-trip results

```
python3 encoder/canon_decomp.py
```

| set                            | rows    | round-trip        | failures |
| ------------------------------ | ------- | ----------------- | -------- |
| `data/train.jsonl`             | 14 043  | 14 023 (99.86%)   | **20**   |
| `data/val.jsonl`               | 2 213   | 2 213 (100.00%)   | 0        |
| `data/distill.jsonl` negatives | 3 479   | 3 479 (100.00%)   | 0        |
| `grammar/map.json` gold        | **434** | **434 (100.00%)** | 0        |

**The 434 gold canonicals all round-trip.** The decomposition is therefore not a grammar-coverage finding — it covers the whole corpus.

The 20 train failures are a **DATA finding, not a grammar one**: 20 rows of `train.jsonl` carry the literal target string `Unparsed`. They are dropped from training here and should be dropped at the source.

A second proof, of the decoder rather than the decomposition: feeding the **gold** labels of all 434 turns through `task.assemble_from` reproduces a tree-equal canonical **434/434**. Any corpus turn is reachable by this decoder; what remains is whether the heads pick the right labels.

### A scanner bug the abstention audit turned up

`refuse: out_of_ontology` was first scanned as `<ARG#0>: <REASON#0>` — the identifier rule saw an identifier followed by `:` and called it an argument NAME, so "refuse" and "clarify" landed in the ARG vocabulary and the refuse/clarify distinction left the template. Round-trip still passed (the word is recoverable from ARG0), which is exactly why a round-trip proof is necessary and not sufficient. Fixed: at turn position 0, `refuse`/`clarify` are structure. Only those two need the guard — every other STRUCT word that can precede `:` (`to:`, `by:`, `from:`) really is an argument name. The round-2 checkpoint was trained before the fix, so `encoder/score_heads.py` maps the old spelling back when it scores that run; the decision is identical either way and the emitted string was always correct.

### The ceiling this design imposes

The template head is a flat classifier over the templates the training data contains, so corpus turns whose template the generator never produced are **unreachable**:

| template inventory    | templates | gold turns covered  |
| --------------------- | --------- | ------------------- |
| `train.jsonl`         | 1 200     | 285/434 (**65.7%**) |
| `data/skeletons.json` | 793       | 265/434 (61.1%)     |
| `data/merged.jsonl`   | 1 386     | 291/434 (67.1%)     |
| all three together    | 1 387     | 291/434 (67.1%)     |
| **+ `distill.jsonl`** | **1 200** | **285/434 (65.7%)** |

**67% is the whole generator's ceiling, not this model's** — and the distilled corpus does not move it at all, because it paraphrases the SURFACE of the same 1 200 templates and adds no new canonical shape. A compositional template decoder (emitting the template as a sequence of structural decisions under a grammar mask, instead of choosing one of 1 200 classes) is the way past it, and is the single highest-value thing I did not have budget to build.

`data/val.jsonl` and `data/distill_val.jsonl` hold out TEMPLATES / skeletons — only 27.5% of val rows have a template train has seen — so the val template accuracies below are measured on the in-vocabulary subset and are not comparable to the corpus number.

---

## 2. Model card

|  |  |
| --- | --- |
| encoder | `sentence-transformers/all-MiniLM-L6-v2` (6 layers, hidden 384) |
| encoder params | 22.71 M |
| total params with heads | **23.40 M** |
| heads | 1 template (1 200-way) + 28 slot heads + 1 BIO tagger (11 labels), over mean-pooled / per-token states |
| input | `infer.py`'s exact convention: previous canonical (or `NONE`), three pipes, the utterance |
| size fp32 | 93.7 MB |
| **size int8 dynamic** | **23.9 MB** (Linear `default_dynamic_qconfig`, Embedding `float_qparams_weight_only_qconfig`) |

Prev is kept as the **canonical string**, not as its decision labels. That is deliberate and it earns its place: the BIO tagger runs over the WHOLE input, so a `refine` or `act` turn can COPY its literal out of the previous canonical when the member's new words do not contain it ("keep the ones under 30" after `… called "Tahoe Trip"`). Feeding prev as labels would put that literal out of the tagger's reach. The code decoder also falls back to the previous canonical's LIT slot when the tagger finds nothing — that fallback is code reading a parsed prior canonical, not string repair of model output.

---

## 3. The two rounds

```
# round 1
HF_HOME=$PWD/hf OMP_WAIT_POLICY=PASSIVE OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
  KMP_BLOCKTIME=0 setsid nohup ./.venv/bin/python -u encoder/train_encoder.py \
    --base sentence-transformers/all-MiniLM-L6-v2 \
    --out runs/enc-minilm --epochs 4 > logs/train-enc-minilm.log

# round 2
HF_HOME=$PWD/hf OMP_WAIT_POLICY=PASSIVE OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 \
  KMP_BLOCKTIME=0 setsid nohup ./.venv/bin/python -u encoder/train_encoder.py \
    --base sentence-transformers/all-MiniLM-L6-v2 --threads 4 \
    --out runs/enc-minilm-distill --epochs 4 --extra data/distill.jsonl \
    > logs/train-enc-minilm-distill.log

# both rounds, both modes
./.venv/bin/python encoder/infer_encoder.py --model runs/<run> --mode free \
    --out out/<name>.free.jsonl
./.venv/bin/python score_outputs.py out/<name>.free.jsonl
./.venv/bin/python encoder/score_heads.py out/<name>.free.jsonl
cargo run -p centraid-candidates --bin run-model -- \
    --outputs out/<name>.free.jsonl --corpus all
./.venv/bin/python encoder/quantise.py --model runs/<run> --threads 2
```

|  | round 1 | round 2 |
| --- | --- | --- |
| data | `train.jsonl` (14 023 usable) | `train.jsonl` + `distill.jsonl` = **59 802** |
| epochs / batch | 4 / 32 | 4 / 32 |
| threads | 2 | 4 |
| **wall** | **1 890 s (31.5 min)** | **4 638 s (77 min)** |
| best checkpoint | epoch 2 | epoch 2 |

### Validation, per epoch (template accuracy on the in-vocabulary subset)

| round | epoch | `val.jsonl` template / slots / tags | `distill_val.jsonl` template / slots / tags |
| --- | --- | --- | --- |
| 1 | 0 | 47.7 / 92.8 / 98.0 | — |
| 1 | 1 | 60.4 / 95.3 / 98.7 | — |
| 1 | **2** | **63.3 / 96.0 / 98.8** | — |
| 1 | 3 | 62.3 / 96.2 / 98.8 | — |
| 2 | 0 | 60.9 / 95.3 / 98.8 | 41.2 / 96.7 / 98.1 |
| 2 | 1 | 64.0 / 96.5 / 99.2 | 63.6 / 98.0 / 98.3 |
| 2 | **2** | **69.6 / 97.0 / 99.4** | **71.9 / 98.5 / 98.4** |
| 2 | 3 | 67.8 / 97.2 / 99.4 | 72.8 / 98.5 / 98.4 |

---

## 4. Corpus results — mode × corpus, against the Tier D floor

**Round 1** (`train.jsonl` only):

| mode | corpus | parse | per-turn passed | strict sessions | graded | string exact | tree exact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| free | suite | 100.0% | 18/248 (7.3%) | 6/120 | 9.9% | 2.8% | 2.8% |
| free | blind | 98.6% | 5/72 (6.9%) | 4/60 | 8.2% | 1.4% | 1.4% |
| free | holdout | 100.0% | 11/114 (9.6%) | 7/78 | 12.0% | 2.6% | 4.4% |
| teacher | suite | 99.6% | — | 6/120 | 10.6% | 3.2% | 3.2% |
| teacher | blind | 98.6% | — | 4/60 | 8.2% | 1.4% | 1.4% |
| teacher | holdout | 100.0% | — | 7/78 | 11.6% | 4.4% | 6.1% |

**Round 2** (`train.jsonl` + `distill.jsonl`) — **the deliverable table**:

| mode | corpus | parse | per-turn passed | strict sessions | graded | string exact | tree exact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| free | suite | 98.8% | 32/248 (12.9%) | **12/120** | 18.7% | 7.7% | 7.7% |
| free | blind | 100.0% | 11/72 (15.3%) | **8/60** | 14.7% | 12.5% | 12.5% |
| free | holdout | 99.1% | 23/114 (20.2%) | **16/78** | 24.1% | 7.0% | 9.6% |
| teacher | suite | 99.6% | — | 12/120 | — | 9.3% | 9.3% |
| teacher | blind | 100.0% | — | 8/60 | — | 12.5% | 12.5% |
| teacher | holdout | 99.1% | — | 16/78 | — | 8.8% | 11.4% |
| **Tier D floor** |  |  |  | **53/120 · 34/60 · 31/78** |  |  |  |

Round 2 **doubles** every strict-session count over round 1 (6→12, 4→8, 7→16) and still reaches only 23%, 24% and 52% of the floor.

Exact-match is the leakage detector and it says there is no leakage: 8.3% free / 9.7% teacher, against a decoder that could reproduce all 434 from gold labels. Teacher and free are within one session of each other everywhere, which says the multi-turn context is barely being used yet — not that it is solved.

### The data-vs-epochs ablation

Round 2 is the ablation. 4.3× the rows at the same epoch count and the same architecture bought:

|                                     | round 1 | round 2     |
| ----------------------------------- | ------- | ----------- |
| val template (in-vocab)             | 63.3%   | **69.6%**   |
| corpus template                     | 12.4%   | **18.7%**   |
| corpus LIT-span exact               | 1.8%    | **17.6%**   |
| turns emitting ≥1 literal           | 27/434  | **160/434** |
| strict sessions (free, all corpora) | 17/258  | **36/258**  |

**Diverse paraphrase is worth far more than epochs** — round 1 had already converged on `train.jsonl` (epoch 3 was worse than epoch 2) at 12.4% corpus template accuracy, and no number of further epochs on that data was going to move it. But distill adds **no new template**, so the 65.7% ceiling is untouched, and the generator-to-real gap is narrowed, not closed: 69.6% on the generator's own held-out templates against 18.7% on real utterances. That is the same shape as flan-t5-base's 41.4%/0%, in a completely different architecture, which makes it a **property of the training distribution, not of the model family**.

### Per-head accuracy on the 434 corpus turns (free mode)

| head         | round 1 | round 2   |     | head  | round 1 | round 2   |
| ------------ | ------- | --------- | --- | ----- | ------- | --------- |
| template     | 12.4%   | **18.7%** |     | KIND  | 32.3%   | **43.1%** |
| **LIT span** | 1.8%    | **17.6%** |     | VERB  | 25.9%   | **34.8%** |
| WIN          | 75.0%   | **80.0%** |     | REF   | 36.2%   | 35.1%     |
| REASON       | 60.0%   | **90.0%** |     | ARG   | 23.5%   | **26.6%** |
| DATE         | 2.0%    | **34.0%** |     | CMP   | 23.0%   | **25.7%** |
| NUM          | 21.4%   | 21.4%     |     | FIELD | 13.1%   | 14.4%     |
| DUR          | 0.0%    | 33.3%     |     | DIR   | 7.7%    | 7.7%      |

Slot accuracies are measured at the gold hole INDEX, so a wrong template shifts the indices and makes them pessimistic; the template row is the one that matters. `FIELD` at 14% and `DIR` at 8% are the next two after the template head.

### Abstention

`val.jsonl` and `distill_val.jsonl` contain **zero** decline rows, so the per-epoch `abstain` column in the training log is `n=0` and means _not measurable_, not _never right_. The cause is (a) from the coordinator's list: the by-skeleton holdout put no negative skeleton in either val split. The 3 479 negatives in `distill.jsonl` (768 `nothing`, 2 711 `refuse: <reason>`) all decompose and all train; the filter and the decomposition are both fine.

Measured on the 434 corpus turns instead (round 2, free mode):

|  |  |
| --- | --- |
| gold decline turns answered with the right decline | **13/17 (76.5%)** |
| **false abstentions** (gold is a real turn, model declined) | **67/417 (16.1%)** |

The false-abstention rate is a real harm introduced by the negatives, and it is the one number in this report that got WORSE in a way that matters: `b08.0` ("did I do the grocery run?") is answered `refuse: out_of_ontology` when the gold is `show (tasks called "grocery run")`. 7.6% negatives in training buys 76.5% recall on declines at the cost of 16.1% of the real turns. That trade needs a threshold, not an argmax — which is easy to add, since the template head already produces a distribution.

### Wrong outputs, quoted (round 2, free)

```
b02.0  'do I have anything on Wednesday?'
  got   show (things during 2026-06-17)
  gold  show (events during 2026-06-17)
        -- DATE resolved right, KIND wrong: C3 says `things`, and the corpus
           says `events` here; this one is arguably the grammar's ambiguity

b06.0  "what's due this week?"
  got   show (tasks that (status != "") during this week)
  gold  show (tasks that (due_at during this week and status != "completed"))
        -- right shape, EMPTY literal: the tagger found no span for LIT0 and
           the decoder's fallback had nothing in prev either

b03.0  'what does the rest of the week look like on the calendar?'
  got   show (them that (description during this week))
  gold  show (events during this week)
        -- a `Ref` where a Kind was meant, and a FIELD picked at random

b08.0  'did I do the grocery run?'
  got   refuse: out_of_ontology
  gold  show (tasks called "grocery run")
        -- a false abstention, the cost of the 7.6% negatives
```

The second is the important one: the template was RIGHT and the answer was still wrong because no literal was grounded. It is the residue of flan-t5's failure mode (a) — much smaller (LIT-span 1.8% → 17.6%) and not yet gone.

### What fixed the literal head between the rounds

Round 1's tagger reached 98.8% TOKEN accuracy on val and emitted a literal on **27 of 434** corpus turns, truncated mid-word (`Ta`, `Truck`, `Glass`). `O` outnumbers every span label about 30:1 and the unweighted loss simply learned to say `O`. Two changes: a **10× class weight on non-`O` BIO labels**, and **word-boundary snapping** of a tagged span against the input's own characters (code reading the member's text — no model output is edited). Result: 160/434 turns now ground a literal, 17.6% of them exactly right.

---

## 5. Latency and size (int8 dynamic, on the box)

Per TURN, end to end: tokenise, one encoder pass, all 30 argmaxes, assemble.

| run | threads | load avg |  | p50 | p95 | mean | size |
| --- | --- | --- | --- | --- | --- | --- | --- |
| round 1 | 2 | 3.3 (round 2 training) | fp32 | 22.0 ms | 33.8 ms | 24.0 ms | 93.6 MB |
| round 1 | 2 | 3.3 (round 2 training) | **int8** | **11.4 ms** | **18.5 ms** | 12.3 ms | **23.8 MB** |
| round 2 | 2 | 1.4 (idle box) | fp32 | 18.4 ms | 25.1 ms | 19.5 ms | 93.7 MB |
| round 2 | 2 | 1.4 (idle box) | **int8** | **17.2 ms** | **22.0 ms** | 17.7 ms | **23.9 MB** |

int8 is 2× faster than fp32 when the box is contended and barely faster when it is idle — the quantised path spends less of its time waiting for cores. Either way a turn is **under 25 ms at p95 on two cores**, and the model is **23.9 MB**, a quarter of the ≤100 MB budget.

---

## 6. What I did not do

- **No second encoder.** Only `all-MiniLM-L6-v2` was trained; bert-small, electra-small and bert-mini were not, on the coordinator's instruction to cut round 1 short and get the distill table.
- **No distill-only arm.** The union arm is the one that ran; whether the 14k template rows help or hurt on top of the 46k distilled rows is unmeasured.
- **No compositional template decoder.** The template is one 1 200-way class, which caps the whole approach at 65.7% on the corpus and is realising 18.7%. This is the biggest open item and the one I would do next: emit the template as a sequence of structural decisions under `check.py`'s own rule structure, which keeps legality-by-construction and removes the inventory ceiling.
- **No abstention threshold.** The decline decision is a plain argmax over the template head, which is why false abstentions are at 16.1%.
- **No calendar resolution.** `DATE` is a closed classification over the dates seen in training, so "Wednesday" → `2026-06-17` can only be right by coincidence; the corpus's reference date is never given to the model. A date should be a tagged span plus a CODE resolver against the session's reference date.
- **No money normalisation.** `NUM` is likewise closed, so "$42.50" → `4250` is unreachable — only 21% of gold `NUM`s are in the train vocabulary at all. `NUM` did not move at all between rounds (21.4% → 21.4%), which is what a vocabulary ceiling looks like.
- **No CRF or constrained decode over the BIO tags**; plain per-token argmax.
- **No ablation of the prev encoding.** The prev-as-labels variant was reasoned about (§2) and not measured.
- **No 5-epoch-plus run.** Both rounds ran 4 epochs and both peaked at epoch 2 on val, so convergence is not the binding constraint.
- **Never committed, never pushed.**
