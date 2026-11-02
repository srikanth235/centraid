---
name: python
description: >-
  Write, review, refactor, debug, or explain Python in Centraid's on-device model authoring, training, and evaluation pipeline. Trigger on Python modules/scripts, unittest, tracebacks, typing, data preparation, or model evaluation. Prioritizes held-out-data hygiene and the actual runner; typing and style are review guidance only because no ruff or mypy gate is configured.
---

# Python in Centraid

## Workflow and done criteria

Run `python3 experiments/toolchat/native/run_cpu_tests.py --jobs 4` for this pipeline. It needs the environment documented by the runner: `NATIVETOOLS`, `HF_HOME` with `HF_HUB_OFFLINE=1`, `EVAL_VAULTS`, and the integration switches. No test may skip or modify tracked files.

Python 3.11 is pinned. CI dependencies come from `requirements-ci.txt` with `pip install --require-hashes`; scripts run with `python3 -I`. There is no pytest, ruff, or mypy gate: typing and style rules below are review guidance, not automated checks.

**Done** when the canonical runner exits 0 with no skips or tracked-file changes. GPU and VM jobs under `train/` are outside CI; use their runtime environment when those are in scope.

## Centraid constraints

- The Rust runtime is the single implementation of prompt rendering, tool schemas, and transcript behavior. Python `render.py` is a thin wrapper around `nativetools` and the committed export.
- Keep held-out worlds and frozen evaluation sets out of authoring and training. Change frozen sets only through `eval/build_sets.py`, then verify and record them in `eval/FROZEN.md`.
- Keep outputs reproducible: seed and record randomness, sort output-driving collections, avoid wall-clock time, hostnames, and absolute paths, and version data/checkpoints by content hash.
- Keep dependencies pinned with hashes; install only from the compiled CI requirements.

### Traceback table

Fix the first failure first; later messages often follow from it.

| Symptom | Fix |
| --- | --- |
| `ModuleNotFoundError` for a sibling module under `python3 -I` | `-I` leaves both the script's directory and the current directory off `sys.path`. Insert `HERE` the way `eval/build_sets.py` does (`sys.path.insert(0, str(HERE))`), or run the test with `python -m unittest test_x` from inside its directory, as `run_cpu_tests.py` does |
| `NATIVETOOLS` unset, or `FileNotFoundError` for `target/debug/nativetools` | `eval/lib.py` defaults to `target/debug/nativetools`. Build it (`cargo build -p centraid-nativetools --bin nativetools`) or export `NATIVETOOLS` as an absolute path |
| Tokenizer or config not found with `HF_HUB_OFFLINE=1` | Point `HF_HOME` at a cache holding the tokenizer and config of Qwen/Qwen3.5-0.8B (no weights). The suite raises `SkipTest`, which the runner reports as `skipped:` and fails |
| `build_sets.py check` says `sets/<file> is not the file FROZEN.md records` | The frozen set changed. Restore it; a new freeze goes through `build_sets.py` into another directory, is checked, and is recorded in `FROZEN.md`. Never edit the hash to match |
| `check` fails because held-out files are missing | Those files are held out of a public checkout; the check says so by failing. Run it where the private data version is fetched |
| `pip` reports `THESE PACKAGES DO NOT MATCH THE HASHES` or requires pinned versions | Install only from `requirements-ci.txt` with `--require-hashes`. After editing `requirements-ci.in`, recompile the pinned file (its header holds the `uv pip compile` command) instead of installing loose |
| `run_cpu_tests.py` red on `skipped:` or a module that ran zero tests | A skip is a failure here. Provide what the test looks for (binary, tokenizer cache, public worlds via `python3 artefacts.py fetch --public-only`) rather than catching `SkipTest` |
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
