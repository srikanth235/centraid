# `distill.jsonl` — the paraphrase corpus

**Why it exists.** `train.jsonl` is 14 043 rows instantiated from `skeletons.json` by `surface.py`: a few hundred hand-written surface templates with the literals swapped. A model trained on it learns the TEMPLATE GENERATOR, not English — flan-t5-base reached 41.4% exact on the generator's own held-out templates and **0.0%** on real member utterances, and never once copied a world handle out of a request. Wording diversity is the gap, so the sentences in this corpus are written by a build-time LLM instead of by a template, and the canonicals they are written against are the ones the template corpus already covers.

**Schema — the same as `train.jsonl`**, so a trainer needs no new reader:

```json
{"input": "<previous canonical or NONE> ||| <utterance>",
 "target": "<canonical>", "template_id": "d_<skel_id>_<n>", "move": ...,
 "register": "distilled", "family": ..., "skel_id": ...}
```

## How it was built

| step | file |
| --- | --- |
| 1. pick the canonicals | `distill_prep.py` — up to 2 distinct `(prev, target)` pairs per SKELETON of `train.jsonl` (6 for the scarce families: the declinations, `same?`, sequences, `balance`, `create`) |
| 2. move them to a second world | `distill_world.py` — every name, place, title, notebook and date replaced 1:1 by an invented cast, and every date shifted 243 days |
| 3. re-check the canonical | `crates/evalsuite/grammar/check.py` `parse()`, before a task is ever sent |
| 4. generate | `distill/PROMPT.md` + `distill/run_batch.sh` — `claude -p --output-format json`, 50 canonicals per call, 9 utterances each, 12–18 calls in parallel (`distill/pool.sh`, `mkdir` as the atomic claim). Declinations get their own prompt and pool: `distill/NEG_PROMPT.md`, `distill/drive_neg.sh`, 12 utterances per task |
| 5. validate, dedupe, split | `distill_assemble.py` |
| 6. gate | `distill/gate.sh` — `overlap-check` plus three delete-only strippers |

**Generator: `claude -p` (Claude Code CLI, `/opt/node22/bin/claude`, host-managed auth), model `claude-sonnet-5`.** It was option (1) of the lane's three and it worked on the first try, so neither the in-context fallback nor the local Qwen was used.

### The prompt

`distill/PROMPT.md` in full; its shape is: a one-screen description of the dialect so the generator can READ a canonical, then the job — "for each task, write nine different things a person might have said to mean exactly `target`, given that `prev` was the previous turn" — then seven rules:

1. write English, never the dialect's operator syntax;
2. cover the meaning exactly — no dropped filter, no invented one;
3. a non-`NONE` `prev` means this is a FOLLOW-UP and must read as one (`and what about…`, `no, the other one`, `scrap that`, bare fragments), and a `Ref` in the target must be a pronoun in the sentence;
4. **copy every quoted literal verbatim** — a write's `title`, `description`, `summary`, `name`, `label`, `reason` word for word (DEFECTS #35), numbers and dates said naturally;
5. **4b — put the literal in a different PLACE and a different DRESS each time** (start, middle, end; quoted, bare, wrapped in "the … note"), with read filters allowed to shorten to the distinctive words of the handle;
6. one of each register — terse / plain question / blunt imperative / verbose polite / spoken with hesitation / typo'd / colloquial — plus a vocabulary list to rotate (task ≈ job ≈ errand, photo ≈ picture ≈ snap ≈ frame, delete ≈ bin ≈ chuck ≈ scrub…);
7. never repeat yourself; lower case and fragments welcome.

Rule 4b is the answer to the training lane's finding that no model output ever quoted a handle out of the request: 40.6% of the rows carry a quoted literal in the target, and in 92.6% of those the literal is present verbatim in the request text. (The remaining 7.4% are read filters shortened under 4b, e.g. `photos called "Terns over the cut"` asked for as "the Terns over the cut pics" — the verbatim rule is ENFORCED, not merely asked for, on the write arguments, where it is a defect if broken.)

Vocabulary drift is structurally impossible on the target side: every canonical comes from `train.jsonl`, is re-parsed by `check.py` before generation and again at assembly, and the generator never writes one.

## Counts

|  |  |
| --- | --- |
| generated | **50 922** |
| dropped, canonical failed to parse | **0** |
| dropped, the utterance was the dialect (braces, `that (`, a command name) | 120 |
| dropped, a write's content-bearing arg not in the request (DEFECTS #35) | 28 |
| dropped, duplicate `(utterance, target)` | 1 705 |
| dropped by the leakage gate (exact / proper noun / 4-gram) | 6 / 27 / 1 098 |
| **kept** | **47 938** — `distill.jsonl` 45 779, `distill_val.jsonl` 2 159 |

Distinct utterances 47 815 of 47 938; distinct targets 3 988; 5 279 template ids. Vocabulary 3 888 word types against `train.jsonl`'s 2 751, over a third of the sentence length (10.9 words a sentence against 14.6) — the template corpus is long-winded in one voice, this one is short in many.

**The split is by SKELETON** (every 20th skeleton, ~5%), so no validation row shares a shape with a training row: skeleton overlap 0, and `overlap-check` reports no shared template id between the two files. The declination skeletons are exempt — each is one target, not a shape to generalise to, so holding one out would simply delete it from training.

## Coverage

2 754 skeletons, every skeleton `train.jsonl` has.

| rows for that skeleton | skeletons |
| ---------------------- | --------- |
| 1–4                    | 15        |
| 5–8                    | 122       |
| 9–12                   | 448       |
| 13–18                  | 2 109     |
| 19+                    | 60        |

Median 18, minimum 2, maximum 733 (a declination). **2 674 of 2 754 skeletons carry 8 or more paraphrases**; the 137 below that are skeletons whose second instance collided on wording and deduped away.

By head: show 14 245 · cmd 7 818 · count 7 697 · project 4 338 · min 3 291 · max 3 256 · refuse 2 711 · sum 1 227 · nothing 768 · seq 699 · seqref 659 · create 343 · same 300 · balance 237 · due 200 · outstanding 96 · onday 53.

By move: new 28 126 · act 10 169 · refine 7 109 · substitute 1 766 · undo 768. **Follow-ups are 50.3% of the corpus** (`train.jsonl`: 43%), which is the half the tiny model was worst at.

**Negatives are 3 479 rows, 7.3%**: `refuse: fabricated_secret` 760, `refuse: unbounded_destruction` 742, `refuse: sealed_egress` 741, `refuse: out_of_ontology` 468, `nothing` 768. The grammar reserves `clarify` but does not EMIT it from a parse — §4 makes `clarify` the executor's, decided at run time — so there is no clarify target to train and the negatives are the four refusals and the withdrawal.

## Leakage

`crates/evalsuite/{suite,blind,holdout}.json` and `grammar/map.json` were never read by anything that wrote a sentence, and no eval text was ever shown to the generator or quoted into this file. The gate's three strippers read the report (and, for 4-grams, the two corpora) and only DELETE rows; nothing they read is printed.

`cargo run -p centraid-evalsuite --bin overlap-check -- <corpus>`:

| measure | `distill.jsonl` | `train.jsonl` (the baseline) |
| --- | --- | --- |
| requests | 45 779 | 14 043 |
| suite — exact collisions | **0** | 3 (fatal) |
| suite — 4-gram collisions | **29 of 248 (11.7%)**, 21 distinct | 38 of 248 (15.3%), 37 distinct |
| suite — proper-noun leaks | **4 of 33 (12.1%)** | 4 of 33 (12.1%) |
| blind — exact collisions | **0** | 2 (fatal) |
| blind — 4-gram collisions | **5 of 72 (6.9%)**, 5 distinct | 6 of 72 (8.3%), 7 distinct |
| blind — proper-noun leaks | **3 of 23 (13.0%)** | 3 of 23 (13.0%) |
| shared template ids with the val file | **0** | — |

Better on every measure at 3.3× the size, and the run PASSES where the baseline fails. The mechanism is three delete-only rules in `distill/gate.sh`:

- **exact** — any request colliding with a corpus turn is deleted;
- **proper noun** — any row containing a name the BASELINE does not already leak is deleted, which pins the leak rate to the baseline's exactly;
- **4-gram** — any row sharing a four-word run with a corpus turn that `train.jsonl` does not already share is deleted, which forces the shared-gram set to be a SUBSET of the baseline's.

The residual overlap is the 41 four-word runs `train.jsonl` already shares — "what's on my calendar", "delete every note in" — which is what ordinary English costs.

## Twenty rows, quoted

| previous canonical | utterance | target |
| --- | --- | --- |
| `NONE` | pull up the graduation important date | `show important dates called "graduation"` |
| `show albums of (photos)` | get rid of every document except the important dates ones | `core.trash_document{} on (documents) except (important dates)` |
| `show settlements that (to_party is me) that (to_party is me)` | How many of those were paid before March 9th and in GBP? | `count of them that (paid_on < 2027-03-09) that (currency = "GBP")` |
| `show obligations of (parties called "Hrafn Skarsgard") that (settled_at > 2027-02-23)` | amounts, settled ones, incurred asc | `amount_minor of it that (settled_at is not null) ordered by incurred_on asc` |
| `NONE` | earliest contact channel not mine | `min created_at of contact channels that (party_id is not me)` |
| `NONE` | Order more printer paper online. | `refuse: out_of_ontology` |
| `schedule.respond_rsvp{ status: "confirmed" } on it during this week` | Undo that action. | `nothing` |
| `NONE` | flag Borrowed trailer receipt as a favorite, then dump it in Orchard | `core.star_document{} on documents called "Borrowed trailer receipt" then core.move_document{ folder: "Orchard" } on documents called "Borrowed trailer receipt"` |
| `show locker items called "Cello teacher payment account"` | Hrafn Skarsgard — is that the same as this? | `same? (it) (parties called "Hrafn Skarsgard")` |
| `NONE` | Groups — member balances? | `balance of members in groups` |
| `NONE` | what's still open on my to-do list this weekend | `show tasks that (status != "completed") during this weekend` |
| `people.add_person{ display_name: "Ilkka Juntunen" }` | create a new person called Lorcan Tremayne instead | `people.add_person{ display_name: "Lorcan Tremayne" }` |
| `sum amount_minor of settlements called "Pottery kiln crew" that (to_party is me)` | no, I meant Havershaw Bay long weekend, not Pottery kiln crew | `sum amount_minor of settlements called "Havershaw Bay long weekend" that (to_party is me)` |
| `NONE` | Could you tell me whichever was updated more recently, the note called Bread recipe that finally worked or the task called Plane the back door? | `max updated_at of (notes called "Bread recipe that finally worked") and (tasks called "Plane the back door")` |
| `NONE` | things on 2027-02-23 plz | `show things during 2027-02-23` |
| `NONE` | list unpaid obligations due tomorrow | `show obligations that (settled_at is null) during tomorrow` |
| `show documents of (parties called "Babajide Olatunji") that (updated_at during this week)` | star that one, then trash the other one | `core.star_document{} on it then core.trash_document{} on the other one` |
| `show contact channels called "9 Cinderbeck Row" that (created_at during today)` | Could you show me the second one, but only if it's a phone or email, sorted by value from low to high? | `show the 2nd one that (kind in ("phone", "email")) ordered by value asc` |
| `NONE` | remove favorite from photos taken this week summarized as Terns over the cut | `media.set_favorite{ favorite: false } on photos that (captured_at during this week) that (summary contains "Terns over the cut")` |
| `show settlements of (groups) called "Wrackmere Spit weekend"` | just it, if it's already happened, and around £1.20 | `show it that (created_at during before now) that (amount_minor around 120)` |

## Rebuilding it

```sh
cd experiments/canon-model/data
python3 distill_prep.py && python3 distill_neg_prep.py   # tasks + batches
../distill/pool.sh & ../distill/drive_neg.sh &           # generate
python3 distill_assemble.py && ../distill/gate.sh        # validate + gate
```

`run_batch.sh` skips a batch whose output exists and the claim is a `mkdir`, so the pools are resumable and any number may run at once. The generated `distill/out/*.jsonl` are the raw evidence and are kept.

## What I did NOT do

- **I did not touch the eval corpora, and I did not verify meaning by hand.** Every row's canonical parses and every write's content args are checked mechanically, but _whether the sentence really means the canonical_ rests on the generator. A sample of twenty (above) reads correctly; nobody has scored a larger sample, and a fraction of rows will be mislabelled. That fraction is the corpus's real error bar and it is unmeasured.
- **No canonical is new.** The meaning space is exactly `train.jsonl`'s: the same 2 754 skeletons, no shape the template corpus lacked. If the grammar covers a reading no skeleton instantiates, this corpus does not cover it either.
- **No `clarify` rows.** The grammar reserves the production but the executor emits it; there is nothing to train against and I did not invent a convention.
- **The second world is 1:1 with the first.** `distill_world.py` maps each of `literals.py`'s entries to one invented entry, so the corpus has as many distinct people, places and titles as the template corpus did — more variety of WORDING, not of WORLD. A larger cast would probably help the model learn to copy a handle it has never seen; it would need a generator pass of its own.
- **I did not retrain or evaluate anything.** No model has been fitted to this file; the two model lanes own that.
- **I did not merge this with `train.jsonl`.** Whether to train on this alone, on the union, or on the union with the template rows down-weighted is the model lanes' call, and the two files are deliberately separate.
- **I did not commit or push.**
