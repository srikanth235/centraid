# Brief for Astra

Edit the weights of **Qwen3.5-0.8B** directly, starting from
`RikiyaT/Qwen3.5-0.8B-weight-space-programming` (your earlier edit that removed the thinking-loop
direction), with no gradient training, so that it emits the right
**tool call** for a member's phone message. **The one objective is call accuracy:** the share of items
whose call is fully correct (`correct`). Everything else is yours to choose.

## The task

The model sees a system prompt with up to 8 candidate actions and views from the Centraid catalog,
then the member's message (sometimes after earlier turns). It must emit one call:

| tool | meaning |
| --- | --- |
| `act(action, input)` | change the vault, e.g. `agenda.edit-event` with `{"target": "dentist", "starts": "thursday 4pm"}` |
| `load(view, params)` | read, e.g. `money.spending` with `{"month": "october"}` |
| `ask(question)` | the message does not decide |
| `decline(reason)` | out_of_scope · never_mind · fabricated_secret · unbounded_destruction |

A call is correct when the tool, the action or view, and every argument match the gold. Arguments
are spans of the member's words: names stay mentions and dates stay phrases. The prompt, the
catalog and the scoring rules are fixed: `DESIGN.md` §1 to §5, `prompt.py`, `score.py`.

## Your freedom

- **Any weights, any size of edit.** Any tensor, any layer, any method that reads the weights or
  forward-pass statistics: directions, rank-1 or low-rank writes, head or neuron edits, scaling,
  merging with the published edited model, or writing new structure.
- **Thinking, your call.** The regime is thinking on: `lab.generate(items)` thinks up to 32768
  tokens with your post's sampling (temperature 0.6, top-p 0.95, top-k 20), seeded. `think_cap=0`
  emits the call directly. Analyse the think tokens, steer them, cut them, or turn thinking off.
  Pass `sample=None` for greedy, deterministic comparisons. Declare the regime your edit runs in.
- **Any analysis.** Activations, attention, logits, think text, failure classes, comparisons
  between the base and the published edited model.

## Your lab

```python
import sys; sys.path.insert(0, "experiments/wsp")
from lab import Lab
lab = Lab("<starting model dir>", run="<run name>", budget=50)   # attn_implementation="eager" for attention weights
items = lab.dev()                           # 496 dev items: all you may see
rows = lab.generate(items)                  # scored rows; one pass = up to 512 items
out = lab.forward(texts, capture=["model.layers.15.mlp"], attn_layers=[3])   # one pass = up to 1,024 texts
lab.tensors["model.language_model.layers.15.mlp.down_proj.weight"]          # read freely, edit in place
lab.passes_left
lab.save_edit("<name>", code, notes, regime={"think_cap": 0, "greedy": False})
```

A scored row carries:
- the call: `raw`, `call` and `candidates`;
- the think: `think` and `think_tokens`;
- `score`: `correct`, `tool_ok`, `name_ok`, `args_ok`, `valid`, `wrong_write`, `over_ask`,
  `under_ask`, `capped` and `loop`.

## The only rules

1. **No gradient training.** No optimiser, no loss backpropagated into the weights. Reading,
   forward passes and arithmetic on weights and activations are all allowed.
2. **Dev only.** Never open, request or infer `probe/hold.jsonl`: hold is the judge.
3. **Budget:** 50 forward passes per run, unless the owner gives more. Reading weights is free.
4. **Reproducible.** `edits/<name>/edit.py` defines `apply(tensors) -> None`, deterministic, with any
   vectors it needs written in or computed from the weights. `regime.json` says how to run it.
   `NOTES.md` gives the mechanism, the evidence, and dev accuracy before and after.

## How it is judged

The owner:
1. applies your edit with `apply_edit.py`;
2. runs hold in your declared regime, both in bf16 and in the phone's Q4_0 GGUF;
3. compares it, paired, with the starting model, thinking on.

The edit is kept when hold `correct` rises with |z| ≥ 2 and the gain survives Q4_0.
