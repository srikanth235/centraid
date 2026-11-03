# Brief for Astra

Edit the weights of **Qwen3.5-0.8B** by **pure weight manipulation**: read the tensors, reason about
what they compute, and write new values. Start from
`RikiyaT/Qwen3.5-0.8B-weight-space-programming` (your earlier edit that removed the thinking-loop
direction). The goal is a model that emits the right **tool call** for a member's phone message.
**The one objective is call accuracy:** the share of items whose call is fully correct.

## The task the weights must do

The model sees a system prompt with up to 8 candidate actions and views from the Centraid catalog,
then the member's message (sometimes after earlier turns). It must emit one call:

| tool | meaning |
| --- | --- |
| `act(action, input)` | change the vault, e.g. `agenda.edit-event` with `{"target": "dentist", "starts": "thursday 4pm"}` |
| `load(view, params)` | read, e.g. `money.spending` with `{"month": "october"}` |
| `ask(question)` | the message does not decide |
| `decline(reason)` | out_of_scope · never_mind · fabricated_secret · unbounded_destruction |

A call is correct when the tool, the action or view, and every argument match the gold. Arguments
are spans of the member's words: names stay mentions and dates stay phrases. The call is written
in Qwen's native format (`<tool_call><function=act><parameter=action>…`).

You may read, as a description of the task:
- `catalog/schemas.json`: every action and view, with its params;
- `prompt.py`: exactly how the prompt is built;
- `score.py`: how a call is judged;
- `probe/dev.jsonl`: 496 example messages with their gold calls.

The prompt, the catalog and the scoring rules are fixed.

## What you have

```python
import sys; sys.path.insert(0, "experiments/wsp")
from lab import Lab
lab = Lab("models/start", run="<run name>", budget=0)   # budget 0: no forward passes
lab.tensors                                   # name -> tensor, read and write in place
lab.tokenizer                                 # token ids for any word, call marker or catalog id
lab.dev()                                     # the dev items, as data
lab.save_edit("<name>", code, notes, regime={"think_cap": 0})
```

Reading weights and the tokenizer, and doing arithmetic on them, is unlimited: embeddings, unembedding
rows, attention and MLP matrices, SVD, projections, directions built from token embeddings. Running
the model is not part of this brief.

## Your freedom

- **Any tensor, any layer, any size of edit.** Directions, rank-1 or low-rank writes, head or neuron
  edits, scaling, writing new structure, merging with the base model's weights.
- **Thinking, your call.** Declare the regime your edit runs in. `think_cap: 0` emits the call
  directly; `think_cap: N` lets the model think up to N tokens first.

## Rules

1. **Pure weights.** No gradients, no training, no forward passes.
2. **Dev only.** Never open, request or infer `probe/hold.jsonl`: hold is the judge.
3. **Reproducible.** `edits/<name>/edit.py` defines `apply(tensors) -> None`, deterministic, with
   any vectors it needs written in or computed from the weights. `regime.json` says how to run it.
   `NOTES.md` gives the mechanism you targeted and why the edit should move it.

## How it is judged

The owner:
1. applies your edit with `apply_edit.py`;
2. converts it to the phone's Q4_0 GGUF;
3. runs hold in your declared regime;
4. compares call accuracy, paired, with the starting model in the same regime.

The edit is kept when hold accuracy rises with |z| ≥ 2. You hear back whether it was kept, and
which dev failure classes it addressed, never hold items.

## Starting points

These are leads, not instructions.
- **Tool choice:** the first token after `<tool_call>` and `<function=` decides act, load, ask or
  decline. What in the last layers' unembedding geometry favours each?
- **Action ids:** the catalog ids (`agenda.edit-event`, …) appear in the prompt's candidate lines.
  What in the weights would copy the right id rather than a neighbour's?
- **Argument copying:** arguments must be verbatim spans of the member's message. Which heads look
  like copy heads?
- **Format:** param names and JSON structure, e.g. `target` rather than `task`.
