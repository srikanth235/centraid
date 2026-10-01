# Running `kaggle_lora.ipynb` — and every spot that will need a fix

**This notebook is PARKED and has never been executed.** Fine-tuning was stopped so that vanilla (no fine-tune) numbers could be established first. Nothing below has been observed; the wall-clock figures are derived, not measured. Read this as a hand-off for whoever restarts the work, not as a runbook that has been walked.

---

## 1. What you do, in order

1. **kaggle.com → Create → Notebook.**
2. **Notebook options → Accelerator → `GPU P100`.** (`T4 x2` also works and is the fallback if the torch wheel has dropped `sm_60` — see §4.1. The notebook uses one GPU either way.)
3. **Notebook options → Internet → On.** Without it the clone, the model download and the Rust and llama.cpp builds all fail.
4. **Add-ons → Secrets → Add a secret.**
   - Label **exactly** `CENTRAID_GITHUB_TOKEN`.
   - Value: a GitHub **fine-grained personal access token**, scoped to the **single repository** `srikanth235/centraid`, with **Contents: Read-only** and nothing else. The repository is private; this is the only thing the notebook needs from GitHub. Do not use a classic token and do not grant `repo` broadly — the notebook only clones. (The optional last cell that pushes results back needs Contents: Read _and write_; it is off by default for exactly this reason.)
   - Tick **Attach to notebook**.
   - The notebook reads it through `kaggle_secrets.UserSecretsClient`, strips it out of `.git/config` immediately after the clone, and scrubs it from any git error text. It is never printed and never written to a file.
5. _(Only if you enable a gated base — `gemma-3-1b-it`, `Llama-3.2-1B-Instruct`.)_ Add a second secret labelled `HF_TOKEN`, from a Hugging Face account that has **accepted that model's terms on the model page**. Without it those arms are **skipped with a message**, not failed. None of the four default arms is gated.
6. Paste the notebook in (File → Import Notebook, or paste cell by cell).
7. **First run: set `SMOKE = True` in the CONFIG cell.** 2 000 rows, 1 epoch, 80 eval rows, 40 decode sessions. It exercises every stage — clone, Rust build, self-test, leakage gate, schema proof, llama.cpp build, train, merge, GGUF, constrained decode — in roughly 90 minutes. Do not spend a real session before a smoke run is green.
8. Set `SMOKE = False` and run for real. Pick your arms with the `enabled` flags (§3).
9. Download `/kaggle/working/out/`.

## 2. Quota, and why one session is not enough

Kaggle free tier: **30 GPU-hours a week**, and a **single session is killed at 12 hours** (a notebook left idle dies sooner). The CONFIG cell prints its own budget estimate before anything is spent.

Derived cost, at `SYSTEM_PROMPT_MODE='none'` and ~5.9 M training tokens an epoch: **~3.3 GPU-hours per billion compute-relevant parameters per epoch** on a P100. (From ~8 x N FLOP per training token with gradient checkpointing, at ~5 TFLOP/s realised.)

| phase | estimate |
| --- | --- |
| clone + pip | 5–8 min |
| Rust toolchain + `cargo build --release` (run-model, overlap-check) | 10–20 min |
| `make selftest` — gold frames through the real scorer, all three corpora | 8–15 min |
| corpus verification (45 779 rows, pure Python) | ~15 s |
| leakage gate (`overlap-check`) | 2–5 min |
| schema proof (434 gold frames) | ~10 s |
| llama.cpp clone + CUDA build | 15–25 min |
| **train, per arm** | **3.3 h x (compute-B) x epochs** |
| eval per epoch (2 x `EVAL_N` rows, batched greedy) | ~5–10 min |
| merge + GGUF convert + quantise | 5–10 min |
| constrained decode of 434 turns x 2 modes under llama-server | 15–40 min |
| `run-model` scoring, twice (free + teacher) | 16–30 min |

At `EPOCHS = 2` the four default arms come to roughly **30 GPU-hours** — the whole weekly quota, and nowhere near one session. Results are written to `out/results/<slug>.json` as each arm finishes, so an eviction costs the arm in flight and nothing else. Suggested split:

| session | arms                                  | ~hours |
| ------- | ------------------------------------- | ------ |
| 1       | `granite4-nano-350m` + `qwen3.5-0.8b` | ~7     |
| 2       | `gemma4-e2b`                          | ~15    |
| 3       | `lfm2.5-2.6b`                         | ~11    |

Cheaper levers, in the order they cost you least: `EPOCHS = 1` (halves it), `TRAIN_ROWS = 20000` (halves it again), drop an arm.

## 3. Picking the arms

`BASES` in the CONFIG cell is the sweep. Each entry carries `hf_id`, `family`, `lora_target_modules`, `dtype_notes`, `licence`, `approx_params` (resident) and `train_params` (compute-relevant). Set `enabled` per session. `SWEEP_ORDER = "cheapest-first"` is the default because a 12-hour cap means an eviction should cost the expensive arm, not every arm; the comparison table keeps the priority order regardless of run order.

`MODELS.md` has the full landscape, with licences and with measured Q4 sizes. **Read §1 of it before accepting the default priority**: Gemma 4 E2B is Apache-2.0 and is Google's on-device tier, but its Q4_K_M GGUF is **3.1 GB**, 5.8x Qwen3.5-0.8B and 14x Granite 4.0 Nano, because "effective 2 B" describes compute and not storage.

## 4. Every spot that is likely to need a fix

In likelihood order. Each says what to change.

### 4.1 `torch` has no `sm_60` kernels — the P100 stops working

**Symptom.** The hardware cell aborts with "this torch build has no sm_60 kernels". **Cause.** CUDA 13 dropped Maxwell, Pascal and Volta; a torch wheel built against it cannot drive a P100 at all. This is the single most likely thing to break as Kaggle's base image moves. **Fix.** Switch Accelerator to **T4 x2** (`sm_75`, still supported) — or pin an older wheel in the deps cell: `pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu121`. **Do not** remove the check: it exists because the alternative is six hours of training into NaNs.

### 4.2 `transformers` does not know an architecture

**Symptom.** The probe cell prints "transformers … does not know: …" and reinstalls from git main; if that still fails the arm is **skipped**, not fatal. **Fix.** If a _default_ arm is skipped, check the model card's quickstart for the required version and pin it in `TRANSFORMERS_SPEC`. Qwen 3.5 needed git main at release; Gemma 4 and Granite 4.0 may too.

### 4.3 LoRA targets match nothing, or almost nothing

**Symptom.** "trainable fraction … outside [0.05%, 5%]", and the arm aborts. **Cause.** The family's module names are not what the list assumes — the whole reason `lora_targets.py` exists. Qwen 3.5 has `in_proj_qkvz` / `in_proj_ba` / `out_proj` on 18 of 24 layers; Granite 4.0-H has `in_proj` / `out_proj` / `input_linear` / `output_linear`; LFM2 has `w1` / `w2` / `w3`. **Fix.** The cell prints the real `nn.Linear` leaf names and their counts. Put the right ones in that base's `lora_target_modules`. **Do not widen the assertion band** — it is there to stop an arm from training nothing and reporting a number anyway.

### 4.4 OOM, and Gemma 4 E2B in particular

**Symptom.** `CUDA out of memory` during training. **Cause.** Two things dominate on a 16 GiB card: resident weights (E2B is ~10.3 GiB in fp16 before a single activation) and the logits tensor, which is `batch x seq x vocab` — and these vocabularies are 248 320 (Qwen) and 262 144 (Gemma). **Fix.** Lower that base's `per_device_bs` and raise `grad_accum` to keep the effective batch the same. E2B already ships at 2 x 16 for this reason. If E2B still will not fit, it does not fit: it is 5.12 B resident and this is a 16 GiB card.

### 4.5 A non-finite loss

**Symptom.** The `NanGuard` callback aborts the arm with "loss became nan in fp16". **Cause.** fp16 with no bf16 available. Gemma carries `final_logit_softcapping` and is the known family for this. **Fix.** Lower `LR`, or run that arm on an sm_80+ GPU where bf16 exists. **Do not** catch and continue: the numbers after an overflow are noise.

### 4.6 GGUF conversion fails for an architecture

**Symptom.** "GGUF conversion FAILED"; the arm's GGUF column reads `unsupported`. **This is handled, not fatal** — the arm still trains and still scores, decoding through transformers under the same JSON-schema constraint via `llguidance`. **Fix, if you want the GGUF.** Update the llama.cpp clone (the notebook builds from master; the hybrid operators are recent). For Granite specifically, IBM publish a non-hybrid twin, `ibm-granite/granite-4.0-350m`, precisely for toolchains whose Mamba-2 support is not ready — there is a disabled `BASES` entry for it.

### 4.7 The llama.cpp CUDA build fails

**Symptom.** "The CUDA build of llama.cpp FAILED. Falling back to a CPU build." **This is handled.** A Q4_K_M model of ~1 B decodes at tens of tokens a second on Kaggle's four cores; the decode is slower but identical, and sizes and scores are unaffected. **Fix, if you want the speed.** `-DCMAKE_CUDA_ARCHITECTURES=60;75` is already set; the usual cause is a CUDA toolkit/driver mismatch in the base image. Set `LLAMA_CUDA = False` to skip the attempt.

### 4.8 `json_schema_to_grammar.py` has moved or changed signature

**Symptom.** "llama.cpp's json_schema_to_grammar did not convert the schema". **This is handled**: `GRAMMAR_MODE_EFFECTIVE` falls back to `json_schema`, and llama-server performs the same conversion in C++. The constraint is identical.

### 4.9 The chat template is not what the notebook assumed

**Symptom.** Silent — which is why the notebook checks it. `make_prompt_fn` prefers the **checkpoint's own** `apply_chat_template` and falls back to hand-built ChatML only if that raises. **Watch for.** Qwen 3.5's template appends a non-thinking prefix (`<|im_start|>assistant\n<think>\n\n</think>\n\n`) when `add_generation_prompt=True` and `enable_thinking` is unset **[verified from the raw `chat_template.jinja`]**. Gemma uses `<start_of_turn>` / `<end_of_turn>`, not ChatML, so the `stop` list passed to llama-server must cover it — it does, but check it if parse rates collapse for one arm only.

### 4.10 `run-model`'s output format changes

**Symptom.** "run-model printed no corpus report". **Fix.** The regexes in the Rust cell (`SESSIONS PASSED (strict, the headline)`, `GRADED SESSION SCORE`, `TURNS PASSED`). Fix the regexes — **never** the scorer.

### 4.11 `make selftest` is not 120/120 · 60/60 · 78/78

**Stop.** Gold frames are standing in for the model there, so a red self-test is the harness, not the model, and every score afterwards would be measured against a broken renderer. Send the output back rather than continuing.

### 4.12 The leakage gate trips

**Stop.** `overlap-check` fails the run on an exact request collision with suite/blind/holdout, or on a template id shared between the training and validation rows. Either way every score afterwards measures memorisation and reports it as competence — and the scores go **up**, so the leak is invisible. **Do not relax the gate, drop the corpus argument or filter the report.** The fix belongs to whoever owns the data.

### 4.13 Disk

`/kaggle/working` is ~20 GB and is what persists. The notebook keeps only `out/` and the per-epoch adapters there; the clone, the cargo target directory, llama.cpp and the merged fp16 weights all go to `/kaggle/temp`. If `/kaggle/temp` is missing on a future image the notebook falls back to `/tmp/centraid-scratch`.

## 5. Two deliberate departures from the original brief

Both are recorded because they change what the numbers mean.

**The doctrine is not the system prompt by default.** `SYSTEM_PROMPT_MODE = "none"`. `Doctrine.swift` is ~700 tokens; over 45 722 rows that is ~32 M tokens an epoch against ~5.5 M for the rest of the sequence — roughly **11 hours an epoch for a 0.8 B model on a P100, for the prompt alone**. It does not fit a 12-hour session, let alone four arms. A fine-tuned model does not need the instruction block: it has 45 722 worked examples of the same thing. `SYSTEM_PROMPT_MODE = "full"` with `MAX_SEQ_LEN = 1536` restores it; the prompt is built in one place so training, evaluation and llama.cpp decode move together.

**The training-set "execution verification" is not what it was asked to be.** The brief asked for rows to be executed through `run-model` and for the drop rate to be reported as the distillation generator's error rate. Neither part works:

- `distill.jsonl`'s canonicals name an **invented second world** whose handles exist in no vault, so executing them returns nothing for essentially every row. There is no signal.
- The gate that _can_ run — round-trip through the real frame and renderer — drops **1 row in 45 779**, because every distill target already came out of `train.jsonl`, which `frame.py` covers at 100%, and the verbatim rule was already applied at assembly. Reporting 0.002% as a generator error rate would be false.

What the notebook does instead, and what it found, is in `verify_corpus.py`'s docstring and in the notebook's own markdown: a **handle-recoverability** gate, whose value is the **ratio** between corpora — the old template corpus is ~16x more likely than the distilled one to hand a model a target whose handle the sentence never says. Whether each sentence _means_ its canonical stays unmeasured; `DISTILL.md` says so, and no mechanical gate in this repository settles it.
