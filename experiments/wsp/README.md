# Weight-space programming harness

This harness tests whether a frontier model, Astra, can improve Qwen3.5-0.8B at Centraid's tool
calls by editing its weights directly, with no training. The design is in `DESIGN.md`. The brief
you hand to Astra is `ASTRA.md`.

| file | what it is |
| --- | --- |
| `catalog.py` → `catalog/schemas.json` | the model-facing catalog, generated from `crates/apps/*/manifest.json`: 154 actions and 55 views, of which 29 are cards |
| `retrieve.py`, `prompt.py` | BM25 top-8 candidates; the prompt rendered with Qwen's chat template, thinking on |
| `probe/src/*.jsonl` → `split.py` → `probe/dev.jsonl`, `probe/hold.jsonl`, `probe/sets.json` | 318 hand-authored member messages with gold calls across the 8 apps, split by hash into 177 dev and 141 hold |
| `run.py`, `parse.py`, `score.py` | generation (HF or GGUF; greedy; `--think-cap`, default 200), call parsing, and scoring with paired comparison |
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

Run every command for both models (base `Qwen/Qwen3.5-0.8B` and edited
`RikiyaT/Qwen3.5-0.8B-weight-space-programming`), on both sets, at think caps 200, 512, 1024 and 2048.

```bash
python3 run.py --model Qwen/Qwen3.5-0.8B --items probe/dev.jsonl --out runs/base-dev-c200.jsonl --think-cap 200
python3 score.py runs/base-dev-c200.jsonl --items probe/dev.jsonl --json runs/base-dev-c200.score.json
python3 score.py --pair runs/base-dev-c200.jsonl runs/rikiya-dev-c200.jsonl --items probe/dev.jsonl
```

## 2. Astra

Give Astra `ASTRA.md`, this directory without `probe/hold.jsonl`, and a model directory. It works
through `lab.py` and returns `edits/<name>/`.

## 3. Judge an edit

```bash
python3 apply_edit.py --base MODEL_DIR --edit edits/<name> --out out/<name>
python3 run.py --model out/<name> --items probe/hold.jsonl --out runs/<name>-hold.jsonl
python3 score.py --pair runs/base-hold.jsonl runs/<name>-hold.jsonl --items probe/hold.jsonl
python3 gguf.py --model out/<name> --out out/<name>-Q4_0.gguf
python3 run.py --backend gguf --gguf out/<name>-Q4_0.gguf --model out/<name> --items probe/hold.jsonl --out runs/<name>-hold-q4.jsonl
```

Keep an edit only if all three hold:
- hold improves with |z| ≥ 2;
- `wrong_write` does not rise;
- the gain survives Q4_0.

## Measured here

These numbers are from a CPU smoke run, not a baseline.
- The base model on two items hit the 200-token think cap both times, then asked instead of acting.
- A forward pass with MLP capture and a one-item generate ran through the lab and were logged.
- The no-op edit reproduced the base weights byte for byte.
- `gguf.py` and the gguf backend have not been run yet.
