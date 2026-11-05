# The M6 Kaggle kit

[#1171](https://github.com/srikanth235/centraid/issues/1171), M6: train one arm (`../arms.py`: A stock full SFT, B edited full SFT, C edited LoRA that skips the two edited tensors) on a datagen data version, export a Q4_0 GGUF, score it on val.

**Status: written without a GPU and without Kaggle. Nothing here has been run on either, and nothing has been pushed.** The CPU tests (`../test_datagen.py`, `../test_kaggle_kit.py`) cover the trainer's input and loss, the arms and the report scripts, not the kernel. It sits beside the eval kit (`crates/assist-eval/kaggle/`, also never run) and builds `assist-eval` the same way, so run that kit first.

| file | what |
| --- | --- |
| `kernel.py` | the Kaggle script kernel (GPU, internet on, private) |
| `kernel-metadata.json` | its metadata; `KAGGLE_OWNER` is replaced by the owner's Kaggle name |
| `make_kit.sh` | writes the input dataset `centraid-m6-src`: `src.tar.gz` (the repository at HEAD) and `params.json`. Writes files only |
| `arm_report.py` | `assist-eval`'s `report.json` to one arm's val report (`arm-<ARM>.val.json`) |
| `compare_arms.py` | the arms' reports to a table and the chosen arm |

## Kernel parameters

Kaggle script kernels take no arguments, so they live in `params.json` in the input dataset (`make_kit.sh OUT KAGGLE_OWNER ARM DATA_FOLDER [KEY=VALUE ...]`). The token is not a parameter: it is the Kaggle secret **`HF_TOKEN`**, attached to the kernel (Add-ons, Secrets); the kernel never prints or writes it.

| key | default | meaning |
| --- | --- | --- |
| `arm` | required | `A`, `B` or `C` |
| `data_folder` | required | the data version's folder in the private HF dataset, e.g. `datagen/v1` |
| `hf_repo` | `srikanth235/centraid-native-data` | the dataset |
| `hf_revision` | `null` (main) | pin a commit of the dataset |
| `epochs`, `bs`, `max_len` | 2, 16, 8192 | trainer flags |
| `lr` | `null` | the arm's default (2e-5 full, 2e-4 LoRA) |
| `hours` | 9.0 | the trainer's wall-clock budget (Kaggle stops a kernel at 12 h) |
| `checkpoints` | `"1.0"` | fractions at which a checkpoint is saved (1.6 GB each) |
| `mark` | `final` | which checkpoint is exported: `final`, or `best` (`best.json`: lowest val decision loss) |
| `s2_baseline` | `false` | also score the public S2 GGUF (`srikanth235/centraid-native-gguf@s2-q4_0`) under `--tools s2`. The baseline is deferred by the owner, so it is off |
| `shards` | `null` | scoring processes, one per GPU by default |

## Steps

1. `pip install` (transformers 5.17.0, the version `bundle.py` stages, peft, zstandard, huggingface_hub; the fused linear-attention kernels best effort).
2. Pull `train.jsonl.zst`, `val.jsonl.zst`, `manifest.json` and the version's `worlds/` from the HF dataset. **Test and noise are never fetched**: test is read at milestones only.
3. `train.py --arm X --save-every 200 --resume` (`torchrun` with more than one GPU). A stopped run is resumed by running the kernel again with its output attached.
4. `to_gguf.py`: llama.cpp at the commit the phone's engine vendors, `--no-mtp`, Q4_0, output tensor Q8_0.
5. Build `assist-eval --features cuda` and score val under the default tools (the eight tools), sharded one process per GPU. With `s2_baseline`, score S2 under `--tools s2`.
6. `arm_report.py` writes `arm-<ARM>.val.json` (and `arm-S2.val.json`).

Output in `/kaggle/working`: `arm-*.val.json`, `report-*.json`, `summary-*.txt`, `gguf/` (the GGUF and its sidecar), `train.log`, `marks.json`, `best.json`, `train_meta.json`, `manifest.json`, `run.log`. Checkpoints are deleted before scoring.

## The owner's steps (not done)

```bash
# per arm, on a machine with ~/.kaggle/kaggle.json, after committing:
experiments/toolchat/native/train/kaggle/make_kit.sh /tmp/m6-A KAGGLE_OWNER A datagen/v1
kaggle datasets create -p /tmp/m6-A                     # private; later arms: `datasets version`
mkdir -p /tmp/m6-kernel && sed 's/KAGGLE_OWNER/your-name/' experiments/toolchat/native/train/kaggle/kernel-metadata.json > /tmp/m6-kernel/kernel-metadata.json
cp experiments/toolchat/native/train/kaggle/kernel.py /tmp/m6-kernel/
# attach the secret HF_TOKEN to the kernel in the Kaggle UI, then push (this starts the run)
kaggle kernels push -p /tmp/m6-kernel
kaggle kernels output your-name/centraid-m6-arm -p out-A
# with the three outputs:
python3 experiments/toolchat/native/train/kaggle/compare_arms.py out-A/arm-A.val.json out-B/arm-B.val.json out-C/arm-C.val.json
```

## What the report holds, and the chosen-arm rule

Per arm: session pass, turn pass (all and clean), per-argument accuracy (rows, date, filters, amount), the fail rate by constraint count 1 / 2 / 3 / 4+ against S2's 13 / 22 / 37 / 67 %, and the Money and Health slices on their own. `compare_arms.py` prints them and applies the rule in its docstring: highest val session pass; arms inside the winner's 95% Wilson interval are tied and go to turn pass, then the lower 4+ constraint fail rate, then the lowest letter; an arm with engine errors is not a candidate. The rule is a proposal; the choice is the owner's, and the reason is printed so it can be recorded.

## Unverified

- Every step of `kernel.py`: the pip installs, the HF pull, the trainer on a T4 or P100 (no bf16 there, so the trainer runs fp32), memory at 8192 tokens with the PyTorch fallback of the linear-attention kernels, `to_gguf.py` on Kaggle (a blobless llama.cpp clone and a CPU cmake build), the CUDA build of `assist-eval`, the scoring.
- That the data version carries a `worlds/` folder next to `val.jsonl.zst` (the kernel stops with a message if not; M4 has not fixed where the worlds live), and that `assist-eval` reads the val sessions with the `render` field removed (the kernel strips it).
- The app ids `money` and `health` as keys of `by_app` (matched case-insensitively).
- That the `render.text` of M4's records tokenizes to their `input_ids` (the trainer warns, on the first records, when it does not).
