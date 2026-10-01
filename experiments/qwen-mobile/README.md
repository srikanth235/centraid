# `qwen-mobile` — the on-device model lane

**Status: fine-tuning is PARKED.** The owner wants vanilla (no fine-tune) numbers on the frame task before any LoRA work continues. What is here is the research and the reusable machinery from the parked bake-off, not a finished experiment.

| file | what it is | state |
| --- | --- | --- |
| [MODELS.md](MODELS.md) | the 2026-09 small on-device model landscape: sizes, licences, GGUF support, dense vs hybrid, **measured** Q4 on-disk sizes, and the prior art on capacity and on encoder-decoder | **verified**, primary sources marked |
| [frame_schema.py](frame_schema.py) | the flat frame as a JSON Schema, derived from `frame.py` + `lexicon.py`; the basis of the decoding grammar | **proved**: 434/434 gold wire frames, 8 000/8 000 sampled training frames |
| [verify_corpus.py](verify_corpus.py) | corpus verification: frame round-trip through the real renderer, plus handle recoverability, with the drop-rate report | **run**: numbers in its docstring are measured |
| [lora_targets.py](lora_targets.py) | per-architecture LoRA target-module resolution by module inspection, with the trainable-fraction assertion | written, not executed |
| [kaggle_lora.ipynb](kaggle_lora.ipynb) | the parked Kaggle bake-off notebook | **never executed**; ends before the sweep driver |
| [KAGGLE.md](KAGGLE.md) | how the notebook was meant to be run, the quota arithmetic, and every spot expected to need a fix | hand-off |

Nothing here reads a secret from a file. The notebook takes its GitHub token from a Kaggle Secret and scrubs it from `.git/config` after cloning.

## The three things worth knowing

1. **Q4 on-disk size tracks resident parameters, not "effective" parameters.** Gemma 4 E2B's smallest published artefact is 2.67 GB and its Q4_K_M GGUF is 3.1 GB — 14x Granite 4.0 Nano's 223 MB and 5.8x Qwen3.5-0.8B's 533 MB. MODELS.md §1.
2. **Qwen3.5 is still the newest Qwen with a small tier.** Qwen3.6 and Qwen3.8 ship nothing under 27 B, and both still report `model_type: qwen3_5`. Gemma 4 has no ~1 B at all. MODELS.md §2.
3. **The distilled corpus is ~16x cleaner than the template corpus** on the one gate that can be measured mechanically — handle recoverability. The generator's _semantic_ error rate remains unmeasured and no gate in this repository settles it. `verify_corpus.py`.

Related: [`../afm-spike/`](../afm-spike/HANDOFF.md) holds `frame.py`, the authoritative frame definition and renderer, and `HANDOFF.md`; [`../canon-model/data/DISTILL.md`](../canon-model/data/DISTILL.md) describes the training corpus and its leakage gate.
