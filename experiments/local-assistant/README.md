# Local assistant experiment

An offline experiment, outside the TypeScript workspace on purpose: Python 3 standard library only for everything below `selector/`, which is the first model lane and has its own virtualenv (`.venv-selector`, gitignored) with CPU torch, sentence-transformers and scikit-learn. Turbo, knip, oxlint and oxfmt do not own `.py` files, so nothing here is picked up by a repo gate.

The question it exists to answer: can a small local pipeline turn a user turn plus short conversation context into the right vault query or typed command, across the eight system apps, reliably enough to ship — without a frontier model in the loop?

This directory holds the parts that must exist **before** any model is run: the operation catalogue, a seeded world, the resolvers and executor that turn a chosen operation into a query or a command, and the frozen evaluation.

## Layout

| File | What it is |
| --- | --- |
| `catalogue.py` | The 45 operations, their schemas, siblings and descriptions. Source of truth. |
| `catalogue.json` | Generated from `catalogue.py`; what model lanes read. |
| `world.py` | The seeded SQLite world. `build_world()` / `reset()`; `TODAY` is injected. |
| `resolvers.py` | Phrases to ids: names, group phrases, events, relative dates, references into the last result. |
| `executor.py` | `execute(op_name, slots, context, conn)` — parameterised reads and typed writes. |
| `reference.py` | The 74 cases and the hand-written reference call sequence for each. Authoring source for the suite. |
| `build_suite.py` | Lowers `reference.py` into `suite.json`. |
| `suite.json` | The frozen evaluation. |
| `scoring.py` | Outcome scoring and the write predicates; writes `runs/<label>.json`. |
| `run_reference.py` | Plays the reference sequences; must report 0 failures. |
| `protocol.md` | The frozen protocol: suite, scoring, ceilings, variants, change log. |
| `runs/reference.json` | The reference run's report, committed as the freeze's evidence. |
| `test_*.py` | Unit tests for the resolvers, the executor and the suite. |
| `selector/` | Pipeline stage [1], the operation selector: synthetic training world, data generator with sibling hard negatives, overlap guard, zero-shot and trained runs, `predict.select(...)`. Results and reproduce commands in [`selector/RESULTS-selector.md`](selector/RESULTS-selector.md). |

## Running it

From the repository root:

```sh
python3 -m unittest discover -s experiments/local-assistant -p 'test_*.py'
python3 experiments/local-assistant/run_reference.py --label reference
```

Regenerating the two generated files (a deliberate act — see the change log rules in `protocol.md`):

```sh
python3 experiments/local-assistant/catalogue.py --write
python3 experiments/local-assistant/build_suite.py --write
```

`runs/` is append-only and gitignored apart from `runs/reference.json`: a run label is never overwritten, and a changed run is a new label.

## The shape being tested

```
user turn + last K turns
  → [1] operation selector   closed set of 45 operations + none/clarify
  → [2] slot filler          shown the selected operation, or it plus siblings
  → [3] resolvers (code)     names, groups, dates, references into results
  → [4] query or command     parameterised SQL read, or a typed write
  → [5] rendering            by template, with a clarification path
```

Steps 3 and 4 are what this directory implements and tests. Step 1 has run: `selector/` reaches 83.7% operation accuracy on the suite's 98 turns with a logistic regression over frozen MiniLM embeddings. Step 2 is still a model lane that has not run; it needs weights listed under "Models and packages required" in `protocol.md`.

Two constraints the code holds, not the model:

- The model never writes SQL. It names an operation and fills slots; every value reaches the database bound, never formatted into a statement.
- Cross-app requests are composed in code. An operation takes a phrase — `people="attendees of the design review"` — and the resolvers do the join. The model is never asked to plan a multi-hop chain.

## Relationship to the product

Nothing here imports from `packages/`. The world mirrors the real vault's vocabulary (party, event, attendee, task, note, asset, album, document, locker item, tally expense) so the catalogue is realistic against [`docs/vault-ontology.md`](../../docs/vault-ontology.md) and the handler surfaces in `packages/blueprints/apps/*/app.json`, but it is a stand-in fixture and shares no schema with `packages/vault`.
