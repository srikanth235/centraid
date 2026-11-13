# Python in Centraid

## Centraid's trainer

The workflow, done criteria, constraints and data-hygiene rules for `experiments/adapter-train` are in [assistant/training.md](../../assistant/training.md). Read it first.

## Traceback table

Fix the first failure first; later messages often follow from it.

| Symptom | Fix |
| --- | --- |
| `ModuleNotFoundError` for a sibling module under `python3 -I` | `-I` leaves both the script's directory and the current directory off `sys.path`. Run the test with `python -m unittest test_x` from inside `experiments/adapter-train`, as `run_tests.py` does, or insert the script's directory into `sys.path` first |
| `pip` reports `THESE PACKAGES DO NOT MATCH THE HASHES` or requires pinned versions | Install only from `requirements-ci.txt` with `--require-hashes`. After editing `requirements-ci.in`, recompile the pinned file (its header holds the `uv pip compile` command) instead of installing loose |
| `run_tests.py` red on `skipped:` or a module that ran zero tests | A skip is a failure here. Provide what the test looks for (torch, transformers, peft, zstandard) rather than catching `SkipTest` |
| A job fails to fetch the data version | The dataset is private: `HF_TOKEN` (or, on AWS, `HF_TOKEN_SECRET_ID`) must be set, and the revision must be a pinned tag or commit, never a branch. The tests read a local directory in the same layout and need no token |
| A test dirtied the tree (`git status` shows a tracked file changed) | Point the output at a `tempfile` directory; the suite's tests must not write tracked files |

## General Python guidance

Typing, style, exceptions, file handling, tests, and performance rules are review guidance. Read [`general/general-practices.md`](general/general-practices.md) for the full checklist. Focused source digests: [`google-python-style-guide.md`](general/google-python-style-guide.md), [`code-style.md`](general/code-style.md), [`error-handling.md`](general/error-handling.md), and [`datetime.md`](general/datetime.md).

## References

Read these when you need the reasoning behind a rule. Two of the sources recommend tools this tree does not use (pytest, ruff, uv, mypy as a gate, Pydantic, pandas); take the rule, not the tool. The tree uses `unittest`, pip with `--require-hashes`, and `experiments/adapter-train/run_tests.py`.

- [`general/google-python-style-guide.md`](general/google-python-style-guide.md) (https://google.github.io/styleguide/pyguide.html): a condensed, adapted digest of the Google Python Style Guide, covering language rules (imports, exceptions, defaults, comprehensions, decorators), style rules (docstrings, naming, strings, logging) and type annotations. Read when a style question has no answer here.
- [`general/code-style.md`](general/code-style.md) (https://github.com/owenlamont/skills): Owen Lamont's code-style skill, copied. Type hints, no reflection, keyword-only parameters, no fixed-length tuple returns, dispatch, comments and docstrings, imports, idioms. Read when designing signatures and data types. Its "no `from __future__ import annotations`" line does not apply to 3.11.
- [`general/error-handling.md`](general/error-handling.md) (https://github.com/owenlamont/skills): the error-handling skill, copied. Custom exceptions, narrow catches, fail-fast, log severity. Read when designing an exception hierarchy or a catch.
- [`general/datetime.md`](general/datetime.md) (https://github.com/owenlamont/skills): the datetime skill, copied. Aware datetimes, `zoneinfo`, ISO 8601, the calendar-day pitfall. Read before parsing, storing or comparing times.

Adapted from the [Google Python Style Guide](https://google.github.io/styleguide/pyguide.html) (CC-BY 3.0, [license](licenses/google-styleguide-LICENSE); condensed and adapted here) and [Owen Lamont's skills](https://github.com/owenlamont/skills) (MIT, [license](licenses/owenlamont-skills-LICENSE)). The traceback table and the measuring loop adapt the Swift and performance skills of [Bama](https://github.com/daveebbelaar/bama) by Dave Ebbelaar (MIT, [license](licenses/Bama-LICENSE)).
