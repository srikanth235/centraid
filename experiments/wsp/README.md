# Weight-space programming harness

This harness tests whether a frontier model, Astra, can improve Qwen3.5-0.8B at Centraid's tool
calls by editing its weights directly, with no training. The design is in `DESIGN.md`. The brief
you hand to Astra is `ASTRA.md`.

| file | what it is |
| --- | --- |
| `catalog.py` → `catalog/schemas.json` | the model-facing catalog, generated from `crates/apps/*/manifest.json`: 154 actions and 55 views, of which 29 are cards |
| `retrieve.py`, `prompt.py` | BM25 top-8 candidates; the prompt rendered with Qwen's chat template, thinking off by default |
| `probe/src/*.jsonl` → `split.py` → `probe/dev.jsonl`, `probe/hold.jsonl`, `probe/sets.json` | 992 member messages with gold calls, about 124 per app, every action and view at least twice; stratified by app and tool into 496 dev and 496 hold |
| `run.py`, `parse.py`, `score.py` | generation (HF or GGUF; thinking on by default, `--think-cap 0` off; seeded sampling), call parsing, and scoring with paired comparison |
| `lab.py`, `budget.py` | Astra's sandbox: dev only, a forward-pass budget, live tensors, activation and attention capture |
| `apply_edit.py`, `edits/` | an edit is a script; applying one records the sha256 before and after and the elements changed |
| `gguf.py` | converts a model directory to Q4_0 GGUF, the phone's format, with the llama.cpp commit the engine vendors |

## Set up (the Codex machine; a GPU helps)

```bash
cd experiments/wsp
pip install -r requirements.txt          # plus llama-cpp-python for the gguf backend
python3 -m unittest                      # 66 tests, no weights needed
python3 split.py --check                 # the probe sets are the frozen ones
```

## 1. Baselines

The starting model is `RikiyaT/Qwen3.5-0.8B-weight-space-programming`: the post's edit removed the
0.8B's thinking-loop direction. Answers hitting the 32k cap fell from 93% to 33%, so thinking is
usable. The regime is **thinking on** with the post's sampling, over 3 seeds. The plain base model
and thinking off are reference rows.

```bash
for m in RikiyaT/Qwen3.5-0.8B-weight-space-programming Qwen/Qwen3.5-0.8B; do
  n=$(basename $m)
  for cap in 32768 0; do for seed in 0 1 2; do
    python3 run.py --model $m --items probe/dev.jsonl --out runs/$n-dev-c$cap-s$seed.jsonl --think-cap $cap --seed $seed
    python3 score.py runs/$n-dev-c$cap-s$seed.jsonl --items probe/dev.jsonl --json runs/$n-dev-c$cap-s$seed.score.json
  done; done
done
```

Repeat on hold. The metric is `correct`, the call accuracy, averaged over seeds. Every edit is
compared with the starting model, thinking on. `--greedy` gives one deterministic run when a paired
comparison needs it.

## 2. Astra

Give Astra `ASTRA.md`, this directory without `probe/hold.jsonl`, and a model directory. It works
through `lab.py` and returns `edits/<name>/`.

## 3. Judge an edit

```bash
python3 apply_edit.py --base MODEL_DIR --edit edits/<name> --out out/<name>
python3 run.py --model out/<name> --items probe/hold.jsonl --out runs/<name>-hold.jsonl --think-cap $(python3 -c "import json;print(json.load(open('edits/<name>/regime.json'))['think_cap'])")
python3 score.py --pair runs/base-hold.jsonl runs/<name>-hold.jsonl --items probe/hold.jsonl
python3 gguf.py --model out/<name> --out out/<name>-Q4_0.gguf
python3 run.py --backend gguf --gguf out/<name>-Q4_0.gguf --model out/<name> --items probe/hold.jsonl --out runs/<name>-hold-q4.jsonl --think-cap <same>
```

Keep an edit only if both hold:
- hold `correct` improves with |z| ≥ 2 against the starting model, thinking on;
- the gain survives Q4_0.

## Measured here

These come from CPU smoke runs on the base Qwen3.5-0.8B, not from a full baseline.

**First 12 dev items, thinking off, greedy:** 0 of 12 calls correct, and 5 of 12 valid.
- The model now acts and loads instead of asking: 2 asks, against 0 gold asks.
- The right action was among the candidates for 9 of the 11 items that have one.
- Calls fail on:
  - **Parameter names:** `task` where the catalog says `target`.
  - **Invented arguments:** "moved to 5", `currency: USD`.
  - **Pasting a summary** into an argument.
  - **Malformed JSON.**
  - **Wrong tool:** `load` on an action.
  - **Wrong action:** 4 wrong writes.

**Two items, thinking on, greedy, 200-token cap** (an early regime, since replaced): both hit the
cap and then asked.

**Tooling:**
- A forward pass with MLP capture and a one-item generate ran through the lab and were logged.
- The no-op edit reproduced the base weights byte for byte.
- `gguf.py` and the gguf backend have not run yet.
