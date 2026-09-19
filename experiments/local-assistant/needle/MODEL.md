# Cactus Needle 3 — what it is, how to talk to it, how to tune it

## Identity

| | |
|---|---|
| Repo | `Cactus-Compute/needle3` (Hugging Face) |
| Revision used | `c1fc4d4cb32993156a880ceb8ff171b03b1f166a` |
| Licence | Apache-2.0 |
| Parameters | 121,021,910 (`config.json: total_parameters`), 20 layers, hidden 768, GQA 12/2 heads, vocab 8192 |
| Shipped weights | `needle3.cact` — 35.3 MB, Cactus-Quant 2.125 bit (`embedding=4, mhc=4, default=2`), KV cache 8-bit |
| Fine-tunable weights | `checkpoints/needle3.safetensors` — 242 MB float |
| Runtime | `libneedle.so` per platform (< 1.7 MB), loaded over ctypes; Python package `cactus-needle==3.0.2`, engine `3.0.1` |
| Sibling repos | `Cactus-Compute/needle2` (older, `.pkl`), `Cactus-Compute/needle` (v1, JAX/safetensors encoder-decoder) |

**Needle 3 is not a `transformers` model.** `config.json` declares
`model_type: needle` / `architectures: ["NeedleForToolCalling"]` — a "Laddered
Simple Attention Network" (Monarch-Hadamard MLP, causal-conv QKV taps, engram
n-gram memory, multi-lane hyper-connections). There is no modelling code on the
hub, no `tokenizer_config.json`, no chat template. `AutoModel.from_pretrained`
cannot load it, so **peft is not usable**. Both inference and LoRA training go
through the `cactus-needle` package (the trainer is JAX/flax/optax; see
`needle/model/finetune.py` inside the installed package).

Confirmed running on this box: CPU only, ~124 MB peak RAM at inference, 250-340
tok/s prefill and 170-200 tok/s decode.

## Interface

There is no user-visible prompt string at inference: `needle_init(system, tools_json,
tool_index_path)` fixes the system text and the tool list for a session, and each
`needle_complete(text, max_new_tokens)` appends one user turn. **Conversation
state lives inside the engine**, so multi-turn is "call `_complete` again";
`reset()` clears it. Tools are a JSON array of `{name, description, parameters}`
(standard JSON-Schema `parameters`, with `required` and `enum` honoured — the
engine compiles a byte-level grammar from them, so output always parses).

Every turn returns one envelope:

```json
{"type": "call" | "respond", "success": true, "error": null,
 "function_calls": [{"name": "...", "arguments": {...}}],
 "suppressed_calls": [], "reasoning": "...", "confidence": 0.55,
 "prefill_tps": 334.7, "decode_tps": 169.5, "peak_ram_mb": 124.0,
 "validation": {"ungrounded": [], "negation": false}}
```

- `type: "respond"` with an empty `function_calls` is the model **abstaining** —
  this is how "no tool applies" is expressed, and it is what a refusal case
  should produce.
- `confidence` is a calibrated head. **It reports `None` once you load tuned
  weights** — the head is not fine-tuned. A pipeline that routes on confidence
  therefore cannot also use a LoRA without recalibrating.
- `suppressed_calls` holds calls the engine's own grounding check dropped.
- `validation.ungrounded` flags argument values not evidenced in the input; the
  Python `run()` wrapper refuses to execute those. Our harness calls
  `_complete(..., ground=False)` so we score the model, not the wrapper.

Tool results are fed back as an ordinary `_complete` turn whose text is the JSON
of the result; the engine wraps it. This works: in `probe.py` the model carries
`window="this week"` from turn 1 into the follow-up turn and adds
`project="finance"`.

### The retriever

`Needle(...)` takes `tool_index_path`. Retrieval is **inside the C engine**, not
a separate model file: the same weights expose `needle_embed(text) -> float[3072]`
and the engine embeds tool descriptions to shortlist them when the tool list is
large. It is not trained by `needle finetune` (the trainer only ever sees the
single assistant target — see below). **With 1–4 tools passed to
`needle_init` there is no retrieval step at all**, which is exactly the shape
Centraid deploys, so the untrained retriever can be bypassed entirely by never
handing Needle more than a handful of tools.

### Training format

`needle.model.finetune.render_example` is the only renderer, and it is
**single-turn**:

```
<|im_start|>system\n{system}<|im_end|>
<|im_start|>user\n<tools>{tools_json}</tools>\n{query}<|im_end|>
<|im_start|>assistant\n<think>\n{reasoning}\n</think>\n<tool_call>{answers}</tool_call><|im_end|>
```

Loss is masked to the assistant span only. That single-turn-only renderer is the
most likely cause of the earlier finding that fine-tuning "erased multi-turn
behaviour". The tokenizer does define `<tool_result>`/`</tool_result>` (ids 12,
13) although the renderer never emits them, so `gen_train.py` composes real
multi-turn conversations by writing those markers into the `query` field: the
stock renderer then produces a full user / assistant / tool-result / user
conversation, and the loss mask still covers only the final call.

*Caveat, unverified:* the exact wire format the C engine uses for a result turn
is not published (the "porting Needle" blog post is the reference and was not
read here). If the engine wraps results differently, training and inference are
slightly off-distribution for the tool-result turn only.

### Reproducing

```sh
uv venv experiments/local-assistant/.venv
uv pip install -r experiments/local-assistant/requirements.txt \
   --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match
.venv/bin/python needle/probe.py           # engine + weights fetch to ~/.cache/cactus-needle
```

`torch`/`transformers` are in `requirements.txt` only because they were the
first thing tried; **nothing in this lane uses them** and they can be dropped.
The live dependency set is `cactus-needle`, `sentencepiece`, `jax`, `jaxlib`,
`flax`, `optax`, `huggingface_hub`.
