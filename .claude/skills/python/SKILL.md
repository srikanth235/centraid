---
name: python
description: >-
  Write, review, refactor, debug, or explain Python in Centraid's adapter trainer (experiments/adapter-train: LoRA on the stock base from datagen records, cloud launchers, the adapter GGUF export and parity). Python is the trainer and nothing else: data, render, eval and rollouts are Rust. Trigger on Python modules/scripts, unittest, tracebacks, typing, or training. Prioritizes held-out-data hygiene and the actual runner; typing and style are review guidance only because no ruff or mypy gate is configured.
---

# Python in Centraid

## Workflow and done criteria

Run `python3 experiments/adapter-train/run_tests.py` for this pipeline (the trainer's CPU tests; no GPU, no weights, no network, no cloud call, `HF_HUB_OFFLINE=1`). No test may skip or modify tracked files. It is not a pull-request check: `.github/workflows/trainer.yml` runs it on `main` when `experiments/adapter-train/**` changes, so run it yourself before calling a trainer change done.

Python 3.11 is pinned. CI dependencies come from `experiments/adapter-train/requirements-ci.txt` with `pip install --require-hashes`. There is no pytest, ruff, or mypy gate: typing and style rules below are review guidance, not automated checks.

**Done** when the runner exits 0 with no skips or tracked-file changes. The GPU image, the launchers' SDK calls, real S3/GCS/Hugging Face calls and the converter on a real adapter are outside CI; the CPU tests do not prove them, so say so when a change touches them. Launching a job, a GPU run or a bucket upload is the owner's call (`experiments/adapter-train/README.md`, "Rules").

## Centraid constraints

- Python is the adapter trainer and nothing else. Data (messages, render, mix), eval and rollouts are Rust (`crates/datagen`, `crates/assist-eval`); the trainer reads datagen's rendered `input_ids` and `weights` as they are (`adapter_train/datagen.py`) and never renders, tokenises or decides what is trained.
- Keep held-out data out of training. The trainer fetches `train` and `val` of a pinned data version and never `test` (`adapter_train/hf.py` has no key for it); a new data version is made only by `cargo run -p centraid-datagen -- build --version vN`. Authors of training data never open val or test gold.
- Keep outputs reproducible: seed and record randomness, sort output-driving collections, avoid wall-clock time, hostnames, and absolute paths, and version data/checkpoints by content hash. The run record (`run.json`) holds the commit, the job-file hash and the data hashes.
- Keep dependencies pinned with hashes; install only from the compiled CI requirements. Credentials only in environment variables or the platform's secret store, never in a job file, a log or the run record.
- The llama.cpp commit the export converts with is pinned once, in `adapter_train/llama_pin.py`; never master.

### Traceback table

Fix the first failure first; later messages often follow from it.

| Symptom | Fix |
| --- | --- |
| `ModuleNotFoundError` for a sibling module under `python3 -I` | `-I` leaves both the script's directory and the current directory off `sys.path`. Run the test with `python -m unittest test_x` from inside `experiments/adapter-train`, as `run_tests.py` does, or insert the script's directory into `sys.path` first |
| `pip` reports `THESE PACKAGES DO NOT MATCH THE HASHES` or requires pinned versions | Install only from `requirements-ci.txt` with `--require-hashes`. After editing `requirements-ci.in`, recompile the pinned file (its header holds the `uv pip compile` command) instead of installing loose |
| `run_tests.py` red on `skipped:` or a module that ran zero tests | A skip is a failure here. Provide what the test looks for (torch, transformers, peft, zstandard) rather than catching `SkipTest` |
| A job fails to fetch the data version | The dataset is private: `HF_TOKEN` (or, on AWS, `HF_TOKEN_SECRET_ID`) must be set, and the revision must be a pinned tag or commit, never a branch. The tests read a local directory in the same layout and need no token |
| A test dirtied the tree (`git status` shows a tracked file changed) | Point the output at a `tempfile` directory; the suite's tests must not write tracked files |

## ML data hygiene

- **Seed every source of randomness** (`random`, NumPy, the ML framework) from one seed passed in, and record it with the output. Use a local `random.Random(seed)` instead of the global generator.
- **Iterate in a defined order:** sort directory listings, dictionary keys and sets before they shape output.
- **No wall-clock time, hostnames or absolute paths in data or artefacts.**
- **Held-out data stays held out.** Training, authoring and tuning code never reads validation or test sets; a split is fixed once and checked by hash, and changing it is a deliberate, recorded act. Metrics you steer by come from validation; test is read only at milestones.
- **One implementation of anything training and inference share** (prompt rendering, tokenisation, scoring). A second copy in another language drifts and silently breaks "train equals inference".
- **Version data and checkpoints by content hash,** with the command that produced them.

## General Python guidance

Typing, style, exceptions, file handling, tests, and performance rules are review guidance. Read [`references/general-practices.md`](references/general-practices.md) for the full checklist. Focused source digests: [`google-python-style-guide.md`](references/google-python-style-guide.md), [`code-style.md`](references/code-style.md), [`error-handling.md`](references/error-handling.md), and [`datetime.md`](references/datetime.md).

## References

Read these when you need the reasoning behind a rule. Two of the sources recommend tools this tree does not use (pytest, ruff, uv, mypy as a gate, Pydantic, pandas); take the rule, not the tool. The tree uses `unittest`, pip with `--require-hashes`, and `experiments/adapter-train/run_tests.py`.

- [`references/google-python-style-guide.md`](references/google-python-style-guide.md) (https://google.github.io/styleguide/pyguide.html): a condensed, adapted digest of the Google Python Style Guide, covering language rules (imports, exceptions, defaults, comprehensions, decorators), style rules (docstrings, naming, strings, logging) and type annotations. Read when a style question has no answer here.
- [`references/code-style.md`](references/code-style.md) (https://github.com/owenlamont/skills): Owen Lamont's code-style skill, copied. Type hints, no reflection, keyword-only parameters, no fixed-length tuple returns, dispatch, comments and docstrings, imports, idioms. Read when designing signatures and data types. Its "no `from __future__ import annotations`" line does not apply to 3.11.
- [`references/error-handling.md`](references/error-handling.md) (https://github.com/owenlamont/skills): the error-handling skill, copied. Custom exceptions, narrow catches, fail-fast, log severity. Read when designing an exception hierarchy or a catch.
- [`references/datetime.md`](references/datetime.md) (https://github.com/owenlamont/skills): the datetime skill, copied. Aware datetimes, `zoneinfo`, ISO 8601, the calendar-day pitfall. Read before parsing, storing or comparing times.

Adapted from the [Google Python Style Guide](https://google.github.io/styleguide/pyguide.html) (CC-BY 3.0, [license](licenses/google-styleguide-LICENSE); condensed and adapted here) and [Owen Lamont's skills](https://github.com/owenlamont/skills) (MIT, [license](licenses/owenlamont-skills-LICENSE)). The traceback table and the measuring loop adapt the Swift and performance skills of [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [license](licenses/Bama-LICENSE)).
