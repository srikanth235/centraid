# Local assistant evaluation protocol

The frozen evaluation for the Centraid local assistant: the suite, how a run is scored, the ceilings to measure, and the variants each lane runs. It is frozen as of the reference run below, before any model has been touched.

Everything here is CPU-only Python with no external dependency. Model lanes need weights and packages that are **not** installed and **not** approved yet; they are listed at the end.

## The world

One SQLite database, built in memory by `world.py`, seeded deterministically with 15 people, 12 events, 25 tasks, 15 notes, 20 photos, 8 documents, 6 locker items and 20 tally entries, plus the join tables that make cross-app questions answerable. `TODAY` is injected as **2026-09-19** (a Saturday). Nothing reads the wall clock, so a run scored today scores the same in a year.

Two people are called Neha and two are called Marcus, at different companies. That is what makes a clarify outcome reachable rather than theoretical.

Each case runs against its own fresh world: `world.reset()` per case, so a write in one case can never change another's answer.

## The catalogue

45 operations across the eight apps, in `catalogue.py` (source of truth) and `catalogue.json` (generated).

| App       | Operations | Reads  | Writes |
| --------- | ---------- | ------ | ------ |
| agenda    | 8          | 4      | 4      |
| tasks     | 8          | 4      | 4      |
| people    | 6          | 3      | 3      |
| photos    | 5          | 4      | 1      |
| tally     | 6          | 4      | 2      |
| notes     | 5          | 3      | 2      |
| docs      | 4          | 2      | 2      |
| locker    | 3          | 2      | 1      |
| **total** | **45**     | **26** | **19** |

Three catalogue rules the tests enforce:

- **No one-required-string sinks.** An operation whose only required slot is a bare string must declare siblings that contrast it, so the selector has a hard negative rather than a magnet for every noun phrase.
- **Siblings resolve.** Every name in a `siblings` list is a real operation in the same catalogue and is never the operation itself.
- **`none` and `clarify` are not operations.** They are protocol outcomes and never appear in a tool list shown to a model.

Cross-app requests are one call whose argument is a phrase the resolvers expand — `tally_balance_with(people="attendees of the design review")`, `tasks_for_people(people="people at Initech")`, `photos_of_people(people="attendees of the Initech offsite")`. The model never plans a chain to reach them.

`example_utterances` in the catalogue exist for documentation. They are **not** training data and **not** suite cases.

## The suite

74 cases in `suite.json`, authored in `reference.py`.

| Category | Cases | What it isolates |
| --- | --- | --- |
| `single_read` | 18 | one app, one read, one turn |
| `single_write` | 14 | one app, one typed command, one turn |
| `cross_app_one_call` | 10 | a phrase argument resolved across apps in code |
| `chain` | 8 | two turns needing two different operations |
| `follow_up` | 8 | a second turn that re-runs the same operation with a changed slot |
| `reference_into_result` | 8 | "the first one", "those", "only the ones with X" |
| `refusal_none` | 8 | a refusal or a clarification, with no world change |
| **total** | **74** |  |

A multi-turn case is a list of turns; every turn carries its own expected outcome and every turn must pass for the case to pass.

## Scoring

By outcome against the world, never by string-matching a tool call. Three outcome types:

- **`ids`** — the turn returned a set of ids. Compared as a set, or as an ordered list when `ordered` is true (agendas and due-date lists, where order is part of the answer).
- **`write_predicate`** — a named predicate in `scoring.py`, evaluated against the world after the turn. 20 predicates exist; each asserts the change that was asked for **and**, where it matters, the thing that must not have moved (`task_due` also asserts the task is still open; `doc_in_folder` also asserts it is not trashed).
- **`no_action`** — the turn produced no world change, with the expected reason: `refuse` (nothing in the vault answers this) or `clarify` (the referent resolves to more than one thing, or a required slot is missing).

Rules that hold for every lane:

- Raw model output is saved before parsing. A withheld call, a malformed call and a suppressed call are all failures. No patching of model output.
- A wrong operation that happens to produce the right ids still passes: the measurement is the outcome, not the route. Per-operation selector accuracy is measured separately, by the confusion matrix below.
- Every run takes a `--label` and writes `runs/<label>.json`. An existing label is refused, never overwritten. `runs/` is gitignored except for `runs/reference.json`, which is committed as the freeze's evidence.

### Expected ids, and what freezing them means

A read turn's expected ids were computed once, at freeze time, by running that turn's hand-written reference call against a fresh world (`build_suite.py`). From that point the file on disk is the authority: `test_suite_reachable.py::test_the_frozen_file_matches_its_authoring_source` compares the document in `suite.json` against a rebuild, so a change to the world, the resolvers or the executor that moves a read's answer fails the suite instead of silently moving the target with it. Rebuilding the file is a deliberate act and a post-freeze change that the change log below must name.

## Reachability

    python3 run_reference.py --label reference

Plays the hand-written reference `(operation, slots)` sequence for every case through the same executor and the same scorer every model lane will use.

**Result: 74/74, 0 failures** — `runs/reference.json`.

`test_suite_reachable.py` asserts this, so a case that stops being reachable breaks the test run rather than showing up as a model failure.

## Ceilings to measure first

In this order, because each one says whether the next matters:

1. **`oracle_operation`** — the filler is shown the reference operation alone, with its schema, and fills the slots. This is slot filling by itself. If it is already low, selection is not the bottleneck.
2. **`oracle_operation+siblings`** — the reference operation plus the siblings declared in the catalogue (2–3 per operation). The gap between this and (1) is the cost of sibling confusion at its most favourable.
3. **Selector alone** — accuracy over the closed set of 45 operations plus `none` and `clarify`, reported per operation, with a full confusion matrix. The interesting cells are the declared sibling pairs (`tasks_about` vs `tasks_due`, `notes_search` vs `notes_in_notebook`, `tally_balance_with` vs `tally_expenses_with`, `photos_in_album` vs `photos_by_date` vs `photos_at_place`).

The end-to-end number is (3) composed with (2); reporting it without the ceilings says nothing about where the loss is.

## Selector input format

One JSON object per turn, and nothing else:

```json
{
  "request": "only the ones with Neha",
  "previous_request": "who was at the design review",
  "previous_operation": "people_at"
}
```

`previous_request` and `previous_operation` are `null` on the first turn of a conversation. The selector's output is one operation name from the catalogue, or `none`, or `clarify`, with a calibrated margin. The margin is what routes a turn to `oracle_operation+siblings` rather than single-operation filling.

## Variants to run, per lane

| Lane | Variant | What it answers |
| --- | --- | --- |
| Selector | zero-shot embedding k-NN over operation descriptions + example utterances | how far a retrieval baseline gets with no training |
| Selector | logistic regression over the same embeddings, trained on generated paraphrases with sibling hard negatives | whether a trained closed-set classifier beats retrieval |
| Selector | ModernBERT-base fine-tuned, calibrated (the Laya candidate) | the ceiling for a small trained selector |
| Filler | Needle 3, single operation shown (`oracle_operation`) | slot filling alone |
| Filler | Needle 3, operation + declared siblings | the cost of sibling contrast |
| Comparison | Qwen3-4B GGUF Q4_K_M, all 45 operations as tools, native chat history, thinking off | what a small generative model buys, end to end |

Training data for any trained variant is generated against a **separate** synthetic world and checked for lexical overlap against every suite utterance before use. Whole templates are held out for validation, plus a small hand-written paraphrase dev set. A val loss that falls on shared templates is not a signal.

## Models and packages required (owner approval pending)

Nothing below is installed. Sizes are approximate and, where marked, uncertain — they should be confirmed against the actual release before download.

| Item | Purpose | Approximate size | Confidence |
| --- | --- | --- | --- |
| Cactus Needle 3 weights (~120M params) | the slot filler | ~250 MB fp16, less if a quantised release exists | size uncertain; parameter count is from the brief |
| A small sentence-embedding model — MiniLM-class (e.g. `all-MiniLM-L6-v2`, 22M) or BGE-small-class (33M) | zero-shot k-NN selector and the logreg feature space | ~90 MB and ~130 MB respectively | reasonably confident |
| ModernBERT-base (~150M params) | the trained selector (Laya candidate) | ~600 MB fp32 / ~300 MB fp16 | reasonably confident |
| Qwen3-4B GGUF Q4_K_M | the comparison lane | ~2.5 GB | confident |
| `llama.cpp` / `llama-server` | serving the GGUF with `--jinja` | ~50 MB built, plus a build toolchain | build size uncertain |
| Python: `torch` (CPU wheel) | everything model-side | ~200 MB wheel, ~900 MB installed | installed size uncertain |
| Python: `transformers` | Needle and ModernBERT | ~50 MB | confident |
| Python: `sentence-transformers` | the embedding selector | ~5 MB plus torch | confident |
| Python: `scikit-learn` | logistic regression, confusion matrices | ~40 MB | confident |
| Python: `peft` | LoRA, only if the ceilings show slot filling is the gap | ~5 MB | confident |

Total download if every lane runs: roughly **4–5 GB**, dominated by torch and the Qwen3 GGUF. The machine has 4 CPUs and 15 GB RAM, which is enough to run all of these on CPU, slowly.

Nothing here is downloaded until the owner says so.

## Change log

Every change after the freeze is logged here with its reason. A changed run gets a new label; an existing label is never overwritten. The frozen state is the reference run above.

- **2026-09-19 — selector lane run; nothing in the frozen evaluation changed.** `selector/` was added: a synthetic training world, a template generator, a lexical-overlap guard against the suite and the catalogue's documentation utterances (0 offenders), and the runs `zs-01` (zero-shot embedding baselines), `lr-01` (logistic regression over frozen embeddings) and `ft-01` (encoder fine-tune). `suite.json`, `reference.py`, the world, the resolvers and the executor are untouched; the selector reads the suite only to derive its gold labels (`selector/suite_selector.jsonl`) and never trains on it. Results: [`selector/RESULTS-selector.md`](selector/RESULTS-selector.md).
- **2026-09-19 — the packages the selector lane needs are installed** (CPU torch, sentence-transformers, scikit-learn, numpy, pinned in `selector/requirements.txt`) and one model downloaded: `sentence-transformers/all-MiniLM-L6-v2` (~90 MB). Nothing else on the "Models and packages required" list has been downloaded.
