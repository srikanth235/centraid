# Brief for Astra

You are editing the weights of **Qwen3.5-0.8B** directly, with no gradients and no training, so that
it turns a member's phone message into the right **call on the Centraid catalog**.

## The task the model must do

The model sees a system prompt with up to 8 candidate actions and views, then the member's message.
It emits **one** call, directly. Thinking is off: the goal is the call itself, not reasoning.

| tool | meaning |
| --- | --- |
| `act(action, input)` | change the vault, e.g. `agenda.edit-event` with `{"target": "dentist", "starts": "thursday 4pm"}` |
| `load(view, params)` | read, e.g. `money.spending` with `{"month": "october"}` |
| `ask(question)` | the message does not decide |
| `decline(reason)` | out_of_scope · never_mind · fabricated_secret · unbounded_destruction |

Arguments are copied as the member said them: names stay mentions and dates stay phrases. The
runtime resolves them later. The exact rules are in `DESIGN.md`, §1 to §5.

**The objective is the call:**
- the right tool: act, load, ask or decline;
- the right action or view among the candidates;
- the right arguments, as spans of the member's words.

Every metric you steer by is about the emitted call.

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
- Thinking is off by default (`think_cap=0`). Do not optimise reasoning traces; only the call is scored.
- A row's `score` carries `correct`, `valid`, `tool_ok`, `name_ok`, `args_ok`, `wrong_write`,
  `over_ask` and `under_ask`.

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

On dev, compared with the unedited model:
- `correct` goes up, and with it `tool_ok`, `name_ok` and `args_ok`;
- `wrong_write` does not go up;
- `over_ask` and `under_ask` do not grow.

The owner then applies your edit with `apply_edit.py` and judges it on hold, in bf16 and in the
phone's Q4_0 GGUF. You will not see that result before the owner decides.

## Starting points

These are leads, not instructions. Look at where calls go wrong first: a generate pass shows which
of `tool_ok`, `name_ok` and `args_ok` fails most.
- **Tool choice:** is there a direction that separates act, load, ask and decline at the first
  call token? Is it biased toward one tool on clear messages?
- **Action choice:** the candidates are in the prompt. Does the model attend to the candidate line
  that fits the message? Where does the right id lose to a neighbour, for example edit vs reschedule?
- **Argument copying:** does the model copy the member's span verbatim into the arg, or
  paraphrase, translate or invent it (ISO dates, ids)? Which heads copy from the user turn?
- **Format:** are calls well-formed: one `<tool_call>`, valid JSON in `input` or `params`, and
  param names from the entry?
