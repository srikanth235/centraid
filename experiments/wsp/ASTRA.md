# Brief for Astra

You are editing the weights of **Qwen3.5-0.8B** directly, with no gradients and no training, so that
it turns a member's phone message into the right **call on the Centraid catalog**.

## The task the model must do

The model sees a system prompt with up to 8 candidate actions and views, then the member's message.
It thinks in `<think>`, then emits **one** call:

| tool | meaning |
| --- | --- |
| `act(action, input)` | change the vault, e.g. `agenda.edit-event` with `{"target": "dentist", "starts": "thursday 4pm"}` |
| `load(view, params)` | read, e.g. `money.spending` with `{"month": "october"}` |
| `ask(question)` | the message does not decide |
| `decline(reason)` | out_of_scope · never_mind · fabricated_secret · unbounded_destruction |

Arguments are copied as the member said them: names stay mentions and dates stay phrases. The
runtime resolves them later. The exact rules are in `DESIGN.md`, §1 to §5.

**What the base model does today:** it thinks until the 200-token cap, then **asks** instead of
acting, even when the message is clear and the right action is among the candidates. Check this
yourself with a baseline generate pass.

## Your lab

```python
import sys; sys.path.insert(0, "experiments/wsp")
from lab import Lab
lab = Lab("<model dir>", run="<your run name>", budget=50)   # add attn_implementation="eager" for attention
items = lab.dev()                       # 177 dev items; this is all you may see
rows = lab.generate(items)              # costs passes: one pass = up to 512 items. Returns scored rows
out = lab.forward(texts, capture=["model.layers.15.mlp"], attn_layers=[3])   # one pass = up to 1,024 texts
W = lab.tensors["model.language_model.layers.15.mlp.down_proj.weight"]      # read freely, edit in place
lab.passes_left
lab.save_edit("<name>", code, notes)    # writes edits/<name>/edit.py + NOTES.md
```

- Reading weights is free. Running the model costs passes, and every pass is logged in
  `runs/<run>/ledger.jsonl`.
- Pass `think_cap=` to `lab.generate` to study how thinking behaves past 200 tokens. The phone's
  current cap is 200, but that number is open.
- A row's `score` carries `correct`, `valid`, `tool_ok`, `name_ok`, `args_ok`, `wrong_write`,
  `over_ask`, `under_ask`, `capped`, `think_tokens` and `loop`.

## Rules

1. **No gradients.** No optimiser, no training loop, no fitting on data. You may compute
   statistics from forward passes (activations, attention, means, differences, SVD, projections).
2. **Dev only.** Never open, request or infer `probe/hold.jsonl`. Hold is the judge.
3. **Budget: 50 passes** per run, unless the owner gives a different number.
4. **An edit is a deterministic script.** `edits/<name>/edit.py` defines
   `apply(tensors: dict[str, torch.Tensor]) -> None`, edits in place, and uses no data files and no
   randomness. Any direction or vector it needs is written into the script as literal numbers, or
   computed from the weights alone.
5. **Small and explained.** State every tensor and column you touch. `NOTES.md` says what
   mechanism you found, the evidence for it (which passes showed what), and the dev numbers before
   and after.
6. **The guardrail is wrong writes.** An edit that turns asks into acts must not create wrong
   writes: an `act` on the wrong action or the wrong target is worse than an ask.

## What a good result looks like

On dev, compared with the unedited model under the same think cap:
- `correct` goes up,
- `wrong_write` does not go up,
- `capped` and `loop` go down, or stay level when the edit is about something else.

The owner then applies your edit with `apply_edit.py` and judges it on hold, in bf16 and in the
phone's Q4_0 GGUF. You will not see that result before the owner decides.

## Starting points

These are leads, not instructions.
- **Over-asking:** is there a direction in the residual stream that separates "ask" from "act" at
  the first call token? Does it fire on clear messages?
- **Runaway thinks:** the published edit
  (`RikiyaT/Qwen3.5-0.8B-weight-space-programming`) removed a looping direction from the MLPs of
  layers 15 and 19 for math. Does the same direction drive our capped thinks?
- **Copying spans:** does the model copy the member's words into args, or paraphrase them?
