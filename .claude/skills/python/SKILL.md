---
name: python
description: >-
  Write, review, refactor, debug, or explain Python in Centraid's GPU trainer (experiments/toolchat/native: SFT/DPO on datagen records, the GGUF export, the data-v7 pin and model publishing). Python is the trainer and nothing else: data, render, eval and rollouts are Rust. Trigger on Python modules/scripts, unittest, tracebacks, typing, or training. Prioritizes held-out-data hygiene and the actual runner; typing and style are review guidance only because no ruff or mypy gate is configured.
---

# Python in Centraid

## Workflow and done criteria

Run `python3 experiments/toolchat/native/run_tests.py --jobs 2` for this pipeline (the trainer's CPU tests: `train/` and `artefacts.py`; no GPU, no weights, no network, `HF_HUB_OFFLINE=1`). No test may skip or modify tracked files. It is not a pull-request check: `.github/workflows/trainer.yml` runs it on `main` when the trainer changes, so run it yourself before calling a trainer change done.

Python 3.11 is pinned. CI dependencies come from `requirements-ci.txt` with `pip install --require-hashes`; scripts run with `python3 -I`. There is no pytest, ruff, or mypy gate: typing and style rules below are review guidance, not automated checks.

**Done** when the canonical runner exits 0 with no skips or tracked-file changes. GPU and VM jobs under `train/` are outside CI; use their runtime environment when those are in scope. The CPU tests do not prove the CUDA path: say so when a change touches it.

## Centraid constraints

- Python is the GPU trainer and nothing else. Data (messages, render, mix), eval and rollouts are Rust (`crates/datagen`, `crates/assist-eval`); the trainer reads datagen's rendered `input_ids` and `weights` as they are (`train/datagen.py`) and never renders, tokenises or decides what is trained. The Python renderer, data builders and eval (`render.py`, `authored/`, `eval/`) were retired in #1171.
- Keep held-out worlds and frozen evaluation sets out of training. data-v7's sets are fetched, not kept (`artefacts.json`, `data/v7/FROZEN.md`); a new version is made only by `cargo run -p centraid-datagen -- build --version vN`.
- Keep outputs reproducible: seed and record randomness, sort output-driving collections, avoid wall-clock time, hostnames, and absolute paths, and version data/checkpoints by content hash.
- Keep dependencies pinned with hashes; install only from the compiled CI requirements.

### Traceback table

Fix the first failure first; later messages often follow from it.

| Symptom | Fix |
| --- | --- |
| `ModuleNotFoundError` for a sibling module under `python3 -I` | `-I` leaves both the script's directory and the current directory off `sys.path`. Insert `HERE` (`sys.path.insert(0, str(Path(__file__).resolve().parent))`, as `train/train.py` does), or run the test with `python -m unittest test_x` from inside its directory, as `run_tests.py` does |
| `pip` reports `THESE PACKAGES DO NOT MATCH THE HASHES` or requires pinned versions | Install only from `requirements-ci.txt` with `--require-hashes`. After editing `requirements-ci.in`, recompile the pinned file (its header holds the `uv pip compile` command) instead of installing loose |
| `run_tests.py` red on `skipped:` or a module that ran zero tests | A skip is a failure here. Provide what the test looks for (torch, transformers, peft, zstandard) rather than catching `SkipTest` |
| `check` or `fetch` fails because the data-v7 files are missing | They are held out of the tree: `python3 experiments/toolchat/native/artefacts.py fetch` brings them from the private Hub dataset (`HF_TOKEN`, or `ARTEFACTS_SOURCE`). The tests do not need them |
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

Read these when you need the reasoning behind a rule. Two of the sources recommend tools this tree does not use (pytest, ruff, uv, mypy as a gate, Pydantic, pandas); take the rule, not the tool. The tree uses `unittest`, pip with `--require-hashes`, and `run_cpu_tests.py`.

- [`references/google-python-style-guide.md`](references/google-python-style-guide.md) (https://google.github.io/styleguide/pyguide.html): a condensed, adapted digest of the Google Python Style Guide, covering language rules (imports, exceptions, defaults, comprehensions, decorators), style rules (docstrings, naming, strings, logging) and type annotations. Read when a style question has no answer here.
- [`references/code-style.md`](references/code-style.md) (https://github.com/owenlamont/skills): Owen Lamont's code-style skill, copied. Type hints, no reflection, keyword-only parameters, no fixed-length tuple returns, dispatch, comments and docstrings, imports, idioms. Read when designing signatures and data types. Its "no `from __future__ import annotations`" line does not apply to 3.11.
- [`references/error-handling.md`](references/error-handling.md) (https://github.com/owenlamont/skills): the error-handling skill, copied. Custom exceptions, narrow catches, fail-fast, log severity. Read when designing an exception hierarchy or a catch.
- [`references/datetime.md`](references/datetime.md) (https://github.com/owenlamont/skills): the datetime skill, copied. Aware datetimes, `zoneinfo`, ISO 8601, the calendar-day pitfall. Read before parsing, storing or comparing times.

Adapted from the [Google Python Style Guide](https://google.github.io/styleguide/pyguide.html) (CC-BY 3.0, [license](licenses/google-styleguide-LICENSE); condensed and adapted here) and [Owen Lamont's skills](https://github.com/owenlamont/skills) (MIT, [license](licenses/owenlamont-skills-LICENSE)). The traceback table and the measuring loop adapt the Swift and performance skills of [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [license](licenses/Bama-LICENSE)).
