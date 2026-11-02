---
name: python
description: >-
  Write idiomatic, typed, reproducible Python. Use this skill whenever you write, review, refactor, debug or explain Python: scripts and CLIs, data pipelines, model training and evaluation code, subprocess calls, file and JSON/JSONL handling, and unittest suites. Trigger on .py files, tracebacks, flaky or skipped tests, nondeterministic output, dataset or eval-set questions, even when the user does not ask for "best practices". Closes with how Centraid's on-device model pipeline applies them.
---

# Python best practices

Where common advice disagrees, this file says which to follow and why.

## 1. Mindset

- **Explicit over clever.** Plain functions and data, obvious control flow, names that say what a thing is. Metaclasses, monkey-patching and dynamic attribute tricks need a reason.
- **Make invalid states unrepresentable.** Frozen dataclasses with validated constructors, `Enum`s or `Literal` types instead of magic strings, one type per meaning.
- **Pure core, effects at the edges.** Parsing, scoring and transformation are pure functions; reading files, running processes and reading the clock happen at the edges and are passed in.
- **Reproducible by default.** The same inputs and seed give the same bytes out. A result you cannot reproduce is not a result.
- **The standard library first.** Add a dependency only when it does something the stdlib cannot reasonably do.

## 2. Before you hand back code

- Tests pass, with no skips; the module runs on the interpreter version the project pins.
- No bare `except:`, no `except Exception: pass`.
- No mutable default arguments, no wildcard imports, no `print` debugging left behind.

## 3. Typing and data modelling

- **Annotate every function signature** and every module-level constant; `from __future__ import annotations` at the top of each module.
- **`@dataclass(frozen=True, slots=True)`** for records; `TypedDict` for dicts that cross a JSON boundary; `Protocol` for a structural interface; `Enum` or `Literal` for closed sets.
- **Prefer precise types** (`Sequence[str]`, `Mapping[str, int]`) for inputs and concrete ones (`list[str]`) for outputs; `X | None` for optional values.
- **Parse at the edge.** JSON and CLI input become typed objects once, with errors that name the offending field; inner code trusts the types and does not re-check.
- **No `Any` leaking through an API;** if a value is truly unknown, say `object` and narrow.

## 4. Errors

- Raise specific exceptions with messages that name the bad value; chain with `raise NewError(...) from err` to keep the cause.
- Catch only to recover, add context or report at the top of a script. Never catch to keep going after a failure that makes the output wrong.
- `assert` is for internal invariants in tests and development; it disappears under `-O`. Validate inputs with an explicit check and exception.
- A script's `main()` returns an exit code; failures print one clear line to stderr and exit non-zero.

## 5. Files, processes and data formats

- **`pathlib.Path`** for paths, resolved from the script's location (`Path(__file__).resolve().parent`), never from the current directory.
- **Context managers** for every file, lock and temporary directory; `tempfile` for scratch space, removed even on failure.
- **Write atomically:** write to a temporary file in the same directory, then `os.replace` it into place, so a crash never leaves half a file.
- **Explicit encodings:** `encoding="utf-8"` on every text open.
- **JSON/JSONL:** one record per line, `sort_keys=True` and stable separators when the output is compared or hashed; stream large JSONL files line by line instead of loading them whole.
- **Subprocesses:** `subprocess.run([...], check=True, capture_output=True, text=True)` with an argument list, never `shell=True` with interpolated strings; set a `timeout`; pass the binary's path explicitly (from an environment variable or argument), not via a search.
- **Run scripts isolated** (`python3 -I`) so the current directory and user site-packages cannot shadow modules.

## 6. Determinism and data hygiene for ML work

- **Seed every source of randomness** (`random`, NumPy, the ML framework) from one seed passed in, and record it with the output. Use a local `random.Random(seed)` instead of the global generator.
- **Iterate in a defined order:** sort directory listings, dictionary keys and sets before they shape output.
- **No wall-clock time, hostnames or absolute paths in data or artefacts.**
- **Held-out data stays held out.** Training, authoring and tuning code never reads validation or test sets; a split is fixed once and checked by hash, and changing it is a deliberate, recorded act. Metrics you steer by come from validation; test is read only at milestones.
- **One implementation of anything training and inference share** (prompt rendering, tokenisation, scoring). A second copy in another language drifts and silently breaks "train equals inference".
- **Version data and checkpoints by content hash**, with the command that produced them.

## 7. Idioms

- Comprehensions for simple transforms; a loop when there are several steps or side effects. Generators for large or streamed data.
- `enumerate`, `zip(strict=True)`, `itertools` and `collections` (`Counter`, `defaultdict`) instead of index arithmetic.
- f-strings for formatting; `logging` with a module logger for diagnostics, `print` only for a CLI's real output.
- `argparse` with typed arguments and a `main(argv: list[str] | None = None) -> int` entry point guarded by `if __name__ == "__main__":`.
- Constants in `UPPER_CASE` at module level, with a comment saying where the value comes from.
- Modules named for what they do; no `utils.py` grab-bags.

## 8. Testing

- `unittest` (or the project's chosen framework), one module per unit, tests named for the behaviour. Each test builds its own fixtures in a temporary directory.
- **No skipped tests in a green run.** A test that cannot find what it needs fails loudly; a skip is a silent pass that tests nothing.
- Deterministic: fixed seeds, no network, no real clock, no reliance on test order.
- Tests never write tracked files.
- Test the error paths and the boundaries (empty input, one item, malformed records), not only the happy path.

## 9. Dependencies and environments

- Pin exact versions, with hashes, for anything CI installs (`pip install --require-hashes`). Adding or bumping a dependency updates the pinned file in the same change.
- Keep the import surface small: import heavy libraries (ML frameworks) inside the functions that need them when most callers don't.

## 10. Performance

Profile (`cProfile`, `time.perf_counter`) before optimising. Then: stream instead of loading, batch work, move hot loops into vectorised library calls, and cache pure results keyed by their inputs. Parallelise independent processes with a bounded pool.

## 11. Final checklist

- Signatures typed; records are frozen dataclasses; inputs parsed once at the edge.
- Specific exceptions with context; no swallowed errors; non-zero exit on failure.
- Paths from `pathlib`, explicit UTF-8, atomic writes, argument-list subprocesses with timeouts.
- Seeds recorded, orders sorted, no wall-clock in outputs.
- Held-out data untouched; shared logic has one implementation.
- Tests deterministic, no skips, no tracked-file writes.

## 12. In this repo

Python lives in `experiments/toolchat/native`: the authoring, training and evaluation pipeline for the on-device model.

- **The Rust runtime is the one implementation.** Prompt rendering, the tool schemas and the transcript come from the `nativetools` binary (named by `NATIVETOOLS`) and the committed export under `contracts/assist/export/`; `render.py` is a thin wrapper. Never re-implement them in Python.
- **Held-out worlds and the frozen eval sets are never read** by authoring or training code. The frozen sets change only through `eval/build_sets.py`, and their hashes are checked against `eval/FROZEN.md`.
- **Tests are `unittest` modules,** run as CI runs them: `python3 experiments/toolchat/native/run_cpu_tests.py --jobs 4`. It needs `NATIVETOOLS`, an offline tokenizer cache and the public worlds (see the script's docstring); no test may skip, and none may write a tracked file.
- **Dependencies are pinned by hash** in `requirements-ci.txt`.
- Scripts run with `python3 -I`. GPU and VM jobs under `train/` are outside CI.
