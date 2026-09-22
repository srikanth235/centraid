# Tier C — status, cut short by two direction changes

**This is a status, not the model x mode x corpus table the lane was briefed for.** The lane ran roughly two hours of its five-hour budget and was then redirected twice: first off Qwen2.5 onto the Qwen3.5 / granite-4.2 line, and then — while the replacement weights were still downloading — off model-shipping altogether, with a ~100 MB ceiling that no candidate in the brief comes near. What follows is what is on disk, what actually ran, the one measurement that is a real result, and what was skipped with the reason.

Nothing here was committed, and nothing on disk was deleted at close.

## 1. What actually ran, and the one real result

### The compiled mask bridges to a byte-level tokenizer — gold sweep PASSES

This is the lane's one durable finding. `llg_mask.py`'s tokenizer bridge is written for T5: SentencePiece/Metaspace, where a piece's text is the piece with `▁` respelled as a space (MASK.md §4). Qwen3.5 is byte-level BPE, where that mapping is wrong twice over — `Ġ` is the space marker, and a piece can be a partial UTF-8 sequence. `qwen_mask.py` bridges it through llguidance's own HF tokenizer reader instead, and rebuilds `piece_texts` from the tokenizer's byte decoder rather than by string surgery, so the mask and the text the decoder assembles still cannot disagree.

Re-running MASK.md §1's sweep under the new tokenizer:

|                                 | flan-t5 (MASK.md §1) | **Qwen3.5-0.8B** |
| ------------------------------- | -------------------- | ---------------- |
| canonicals checked              | 434 of 434           | **434 of 434**   |
| token steps                     | 8,505                | **6,733**        |
| gold tokens blocked             | 0                    | **0**            |
| EOS blocked at the end          | 0                    | **0**            |
| not tokenizable without `<unk>` | 0                    | **0**            |
| wall time                       | 4.5 s                | **6.2 s**        |

Fewer steps for the same 434 strings because the BPE vocabulary is coarser than T5's. **0 blocked, 0 EOS-blocked**: the grammar in `canon_lark.py` is not narrower than the gold language under this tokenizer either, so the mask is reusable across tokenizer families and the bridge is the only part that is model-specific. Command:

```
cd experiments/canon-model
HF_HOME=$PWD/hf ./.venv-tierc/bin/python -u -c "<gold sweep, §5>"
```

### Everything downstream of that: NOT MEASURED

No accuracy number was produced. No parse rate, no per-turn accuracy, no strict sessions, no exact-match, no hybrid cascade, no training throughput. The reason is in §3.

## 2. What is on disk

| path | size | state |
| --- | --- | --- |
| `hf/hub/models--Qwen--Qwen3.5-0.8B` | 1.7 GB | complete, loads, generates |
| `.venv-tierc/` | ~1.4 GB | torch **2.14.0+cpu**, transformers **5.17.0**, llguidance 1.8.0 |
| `qwen_mask.py` | — | byte-level tokenizer bridge + prompt-slicing LogitsProcessor |
| `qwen_prompt.py` | — | grammar summary + 20 exemplars, selected from `data/train.jsonl` |
| `qwen_infer.py` | — | the 434-turn runner, teacher and free |

The smoke-run JSONLs were removed when the run was killed: two copies of `qwen_infer.py` had raced onto the same path (a backgrounding mistake, §3), so the file held interleaved bytes from both and was not evidence of anything. No row of it is quoted here, and there are no wrong-output examples in this document for that reason.

**The 0.8B run was cut for box contention, not finished and not scored** — the load average was 7.9 with three other lanes on four cores, and the coordinator stopped it. That is the last state: no output JSONL under `out/` carries a Qwen3.5 generation.

The transformers upgrade was unavoidable: Qwen3.5's `model_type` is `qwen3_5`, which `transformers` 4.57.1 does not carry, and `transformers` 5.17 requires `torch >= 2.5`. Both went into a **separate** `.venv-tierc`; the shared `.venv` was put back to `transformers==4.44.2` so the flan-t5 lane is untouched.

Not on disk: Qwen3.5-2B (partial download deleted), Qwen3.5-4B, granite-4.2-3b, any Qwen2.5 model.

## 3. Why no accuracy number: the box, not the method

Two hard walls, in order.

**Disk.** The box has ~250 GB nominal and **4–6 GB actually free** (`df -h /` reports 90% used; `target/debug` alone is 13 GB). Qwen3.5-2B is 4.5 GB and 4B is 9.3 GB, so the primary candidate could not be co-resident with the 0.8B, let alone with granite. Two downloads died on `ENOSPC` before this was understood. Freeing 1.2 GB of re-downloadable hub cache (`models--google--flan-t5-base`, `models--t5-small` — the flan-t5 lane's _checkpoints_ under `runs/` were not touched) bought one model, not two.

**Throughput.** Qwen3.5 is a hybrid linear-attention architecture, and on this box `transformers` falls back to reference PyTorch for both fused kernels:

```
`causal_conv1d_fn` is falling back to its reference PyTorch implementation …
`chunk_gated_delta_rule` is falling back to its reference PyTorch implementation …
```

With a ~1,800-token few-shot prompt, fp32, 4 cores, no GPU, **a single turn did not finish in 2.5 minutes**. At that rate the briefed run — 434 turns x 2 modes — is >30 hours, against a 5-hour budget that had ~2.5 hours left when the smoke test returned. The prefix-KV reuse that would have cut most of the prompt cost was designed and not written, because the redirect landed first.

So the honest statement is: **the pipeline is built and verified end to end except for the decode itself, which this box cannot run at the scale the measurement needs.** Nothing about that is evidence for or against the accuracy of a masked instruct model on this task.

## 4. What I did not do

- **No accuracy, hybrid or latency table.** See §3. The floor this was to be judged against (Tier D: suite 53/120, blind 34/60, holdout 31/78 strict sessions) stands unchallenged and unconfirmed by this lane.
- **No fine-tuning of any kind.** No LoRA throughput measurement, no epoch sizing, no GPU ask. Stopped on the owner's instruction before it started. For the record, the un-run measurement was to be 20 steps on the 0.8B in bf16 on CPU, and nothing in §3 suggests it would have been fast.
- **No Qwen2.5.** Downloaded and then deleted on the model-line correction; it appears nowhere in any number here.
- **Qwen3.5-2B, Qwen3.5-4B, granite-4.2-3b: never loaded.** Disk (§3). The 4B at ~9.3 GB bf16 could not have been stored on this box at all.
- **No overlap check run**, because no training data was built. `map.json` was read for `request` and `canonical` only, as inputs and gold context.
- **No int8 path.** `torch.ao` dynamic quantization was the intended route (bitsandbytes is not usable on CPU); it was never reached.
- **No leakage number.** Exact-match against gold is only meaningful over a scored run, and there is none.

## 5. Every command

```
# environment
cd experiments/canon-model
python3 -m venv .venv-tierc
./.venv-tierc/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
./.venv-tierc/bin/pip install transformers llguidance numpy accelerate
#   -> torch 2.14.0+cpu, transformers 5.17.0, llguidance 1.8.0

# weights
HF_HOME=$PWD/hf HF_HUB_DISABLE_XET=1 ./.venv-tierc/bin/python -c \
  "from huggingface_hub import snapshot_download; \
   snapshot_download('Qwen/Qwen3.5-0.8B', allow_patterns=['*.json','*.safetensors','*.txt'])"

# the gold sweep of §1 (434 golds, teacher-forced through the mask)
HF_HOME=$PWD/hf ./.venv-tierc/bin/python -u - <<'PY'
import json, numpy as np
from transformers import AutoTokenizer
import qwen_mask
tok = AutoTokenizer.from_pretrained('Qwen/Qwen3.5-0.8B')
c = qwen_mask.QwenConstraint(tok)
rows = json.load(open('../../crates/evalsuite/grammar/map.json'))['turns']
blocked = eos = steps = 0
for r in rows:
    ids = tok(r['canonical'], add_special_tokens=False).input_ids
    c.reset(); pre = []; ok = True
    for s in ids:
        bits = np.unpackbits(c.mask_for(pre).numpy().view(np.uint8), bitorder='little')
        steps += 1
        if not bits[s]: blocked += 1; ok = False; break
        pre.append(int(s))
    if not ok: continue
    bits = np.unpackbits(c.mask_for(pre).numpy().view(np.uint8), bitorder='little')
    if not bits[c.eos] or not c.is_accepting(): eos += 1
print(steps, blocked, eos)
PY
#   -> 6733 0 0   (6.2 s)

# the smoke run of §3 (did not finish six turns)
HF_HOME=$PWD/hf ./.venv-tierc/bin/python -u qwen_infer.py \
    --model Qwen/Qwen3.5-0.8B --mode free --out out/_smoke.jsonl --limit 6

# the full run, NOT RUN
HF_HOME=$PWD/hf ./.venv-tierc/bin/python -u qwen_infer.py \
    --model Qwen/Qwen3.5-0.8B --mode free --out out/qwen3.5-0.8b.free.jsonl
cargo run -p centraid-candidates --bin run-model -- \
    --outputs experiments/canon-model/out/qwen3.5-0.8b.free.jsonl --corpus all
```

## 6. Contradictions found in the existing files

1. **`infer.py`'s docstring is stale.** It says _"Decoding is UNCONSTRAINED greedy — the grammar mask is not ready (VERIFY.md)"_. MASK.md then lands a compiled mask that passes the gold sweep and closes the leak, and `decode.generate_canonicals` is offered as the drop-in. So every number in `logs/score-*.txt` and `out/*.jsonl` is UNMASKED, and nothing in those files says so. Anyone reading `out/flan-t5-base.free.jsonl`'s 54.6% parse rate as a masked figure would be wrong by construction — under the mask a parse rate is near-100% and means almost nothing (MASK.md §5).

2. **MASK.md §4 records a defect in `check.py` that is still owed.** `first N of Set`, `count of Kind Cmp N` and `next N days` call `int()` on a `number` terminal lexed as `-?\d+(\.\d+)?`, so `first 1956.00 of (it)` raises `ValueError`, not `ParseError` — and `canon_grammar.complete` catches `ValueError` and reads it as "not a whole turn", so the parser that decides legality was absorbing its own crash. `canon_lark.py` routes around it with an `INT` terminal; the fix in `check.py` has not been made, and every other caller (`canon.rs`'s round trip, `validate-suite`) reaches the same line. This lane confirms it is still open.

3. **BENCH.md's 250 ms p95 budget has no measured turn latency to compare against**, for any model. MASK.md §3 says turn latency is NOT MEASURED because the box was never idle and tells the reader to re-run `llg_bench.py --n 50` once training is done. That re-run has not happened — `bench_llg.json` and `bench_llg_contended.json` are both from the contended window. The one datum this lane can add is not encouraging: a 0.8B hybrid-attention model on 4 CPU cores with reference kernels is ~10^3 x over that budget, not ~10 x.
