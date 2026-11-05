# General Python practices

General typing, error handling, style, files, testing, and performance guidance. Centraid's actual commands and ML data rules in [`../SKILL.md`](../SKILL.md) take precedence.

## 1. Mindset

- **Explicit over clever.** Plain functions and data, obvious control flow, names that say what a thing is. Metaclasses, monkey-patching, reflection and dynamic attribute tricks need a reason: they defeat the type checker and grep.
- **Optimise for the reader.** Code is read far more often than written. Match the surrounding file where no rule speaks, and keep new code at least as clear as its neighbours.
- **Make invalid states unrepresentable.** Frozen dataclasses with validated constructors, `Enum`s or `Literal` types instead of magic strings, one type per meaning, one canonical form of "empty".
- **Pure core, effects at the edges.** Parsing, scoring and transformation are pure functions that take every input as a parameter and return every result; reading files, running processes and reading the clock happen at the edges and are passed in.
- **Reproducible by default.** The same inputs and seed give the same bytes out. A result you cannot reproduce is not a result.
- **The standard library first.** Add a dependency only when it does something the stdlib cannot reasonably do.

## 3. Typing and data modelling

- **Annotate every function signature** and every module-level constant; `from __future__ import annotations` at the top of each module (3.11 does not defer annotations by itself). Do not annotate `self` or `cls`.
- **`@dataclass(frozen=True, slots=True)`** for records; `TypedDict` for dicts that cross a JSON boundary; `Protocol` for a structural interface; `Enum` (`StrEnum` for strings) or `Literal` for closed sets.
- **Name what a position means.** Never return a fixed-length tuple from anything but a sort key; return a frozen dataclass with named fields. Annotate collections of like values as `tuple[X, ...]`.
- **Keyword-only parameters** (a bare `*`) when a function has three or more parameters, two of the same type, or any boolean; the same triggers apply to a dataclass with `kw_only=True`. This ends argument-order and boolean-trap bugs.
- **Precise types for inputs** (`Sequence[str]`, `Mapping[str, int]`, `Iterable[X]` when only iterated), concrete ones for outputs (`list[str]`); `X | None`, never an implicit optional. Widen a parameter instead of converting the caller's container.
- **Parse at the edge.** JSON and CLI input become typed objects once, with errors that name the offending field; inner code trusts the types and does not re-check.
- **Do not leak `Any` through an API.** A value that is truly unknown is `object` and is narrowed with `isinstance` before use.
- **Do not mutate arguments;** copy and return a new value. Prefer immutable containers (`tuple`, `frozenset`) for fixed data and constants.
- **Do not use `typing.cast`, `eval`, `exec`, `compile`, or runtime reflection** (`getattr`/`setattr` by name, `vars`, `globals`, `__dict__`): fix the declared type instead. `type: ignore` is for untyped third-party code, with the error code and a reason.
- **Dispatch on a finite set** with a mapping or `match`; if the same switch appears in two functions, pick the case once and pass the result (one `Protocol` implementation per case).
- **Composition over inheritance;** a base plus one level at most. A class earns its place by owning state; a method that never reads `self` belongs at module level.

### Traceback to fix

Fix the first error first: later ones are often its echo.

| Symptom | Fix |
| --- | --- |
| `ModuleNotFoundError` for a sibling module under `python3 -I` | `-I` leaves both the script's directory and the current directory off `sys.path`. Insert `HERE` (`sys.path.insert(0, str(Path(__file__).resolve().parent))`, as `train/train.py` does), or run the test with `python -m unittest test_x` from inside its directory, as `run_tests.py` does |
| `pip` reports `THESE PACKAGES DO NOT MATCH THE HASHES` or requires pinned versions | Install only from `requirements-ci.txt` with `--require-hashes`. After editing `requirements-ci.in`, recompile the pinned file (its header holds the `uv pip compile` command) instead of installing loose |
| `run_tests.py` red on `skipped:` or a module that ran zero tests | A skip is a failure here. Provide what the test looks for (torch, transformers, peft, zstandard) rather than catching `SkipTest` |
| `check` or `fetch` fails because the data-v7 files are missing | They are held out of the tree: `python3 experiments/toolchat/native/artefacts.py fetch` brings them from the private Hub dataset (`HF_TOKEN`, or `ARTEFACTS_SOURCE`). The tests do not need them |
| A test dirtied the tree (`git status` shows a tracked file changed) | Point the output at a `tempfile` directory; the suite's tests must not write tracked files |

## 4. Errors

- Raise specific exceptions with messages that name the bad value: `raise ValueError(f"bad seed {seed!r}")`. Chain with `raise NewError(...) from err` to keep the cause.
- A package defines its own exceptions in one module, named for the failure (`...Error`), subclassing `Exception` and kept shallow. Do not subclass a built-in like `ValueError` unless callers should catch it that way.
- Catch the narrowest type you actually handle, with a `try` body of a line or two. A broad `except Exception` is correct only at a top-level entry point that reports and exits non-zero.
- Catch only to recover or add context. Never catch to keep going after a failure that makes the output wrong, and never log-and-swallow. Log once, where the error is acted on, with `logger.exception` or `exc_info=True` (`str(exc)` is often empty for timeouts).
- Write a deliberate swallow as `with contextlib.suppress(SpecificError):`, never `try/except: pass`.
- **Fail fast.** A reached "can't happen" branch raises. Let `subprocess.run(check=True)` and `raise_for_status()` fire. A set of sibling lookups all raise on "not found" or all return `None`; prefer raising.
- `assert` is for internal invariants in tests and development; it disappears under `-O`. Validate inputs with an explicit check and exception.
- A script's `main()` returns an exit code; failures print one clear line to stderr and exit non-zero. Log severity follows recoverability: `error` needs attention, `warning` is a recovered path.

## 5. Style

Formatting is the formatter's job; these are the rules a formatter cannot enforce.

- **Imports:** at the top, absolute, one per line, grouped `__future__`, stdlib, third party, project, each sorted. Import modules and packages, not individual functions or classes (`from pkg import mod`, then `mod.func()`), except from `typing` and `collections.abc`. Never import another module's `_private` name. Keep `__init__.py` empty unless the package is a curated public API.
- **Names:** `snake_case` functions, variables and modules; `CapWords` classes; `UPPER_CASE` constants, `Final` and with a comment saying where the value comes from; a leading underscore for internal names. Names say meaning, not type (`prices`, not `prices_df`); units go in the name (`timeout_ms`, `size_bytes`); acronyms stay upper-case. No `utils.py` grab-bags, no single-letter names outside short loops.
- **Comments are prose that explains why,** never a restatement of the code. Prefer an extracted, well-named variable to a comment on a complex expression. A TODO links an issue.
- **Docstrings** (triple double quotes, one-line summary ending in a period) on public functions and anything non-obvious: say what it does, the side effects, the exceptions it raises, and whether range bounds are inclusive. Parameters need documenting only when name and type leave semantics open. A module or class docstring earns its place only by carrying what the name does not (a unit, an invariant); one that restates the name is noise.
- **Strings:** f-strings for formatting (a plain literal when nothing is interpolated); `"".join(parts)` instead of `+=` in a loop; `logging` calls take a pattern and arguments (`logger.info("rows %d", n)`), not an f-string.
- **Truthiness:** `if seq:` for emptiness, `is None` / `is not None` for `None`, never `== None` or `== True`. When `0` or `""` is a valid value, test `is None` explicitly.
- **Comprehensions** for one `for` and at most one `if`; a loop when there are several steps or side effects. Generators for large or streamed data, and a generator (not a list) into `join`, `sum`.
- **Iterate directly** (`for k in d`, `for line in f`), with `enumerate`, `zip(strict=True)`, `itertools`, `Counter`, `defaultdict` instead of index arithmetic. Never mutate a container while iterating it.
- **Compare floats** with `math.isclose`, not `==`; write float literals where a float is meant.
- **Closures in loops bind late;** bind with a default argument or `functools.partial`.
- **Functions stay short and single-purpose;** past about 40 lines, look for a split, but not at the cost of a worse interface.
- **Entry points:** `argparse` with typed arguments and `main(argv: list[str] | None = None) -> int` under `if __name__ == "__main__":`. An importable module does nothing at import time except define names.

## 6. Files, processes, time and data formats

- **`pathlib.Path`** for paths, resolved from the script's location (`Path(__file__).resolve().parent`), never from the current directory.
- **Context managers** for every file, lock, socket and temporary directory; `tempfile` for scratch space, removed even on failure.
- **Write atomically:** write to a temporary file in the same directory, then `os.replace` it into place, so a crash never leaves half a file.
- **Explicit encodings:** `encoding="utf-8"` on every text open.
- **JSON/JSONL:** one record per line, `sort_keys=True` and stable separators when the output is compared or hashed; stream large JSONL line by line.
- **Subprocesses:** `subprocess.run([...], check=True, capture_output=True, text=True, timeout=...)` with an argument list, never `shell=True` with interpolated strings; pass the binary's path explicitly (an environment variable or argument), not via a search.
- **Run scripts isolated** (`python3 -I`) so the current directory and user site-packages cannot shadow modules.
- **Time:** timezone-aware datetimes only, attached where a value enters the system; `zoneinfo`, not `pytz`; `isoformat()` and `fromisoformat()` for formats you own, `strptime` with an explicit format only for third-party input. A calendar day from an aware timestamp belongs to that timestamp's zone: convert with `astimezone()` before comparing it with `date.today()`. Take the clock as a parameter (see section 7).

## 8. Testing

- `unittest`, one module per unit, tests named for the behaviour. Each test builds its own fixtures in a temporary directory.
- **No skipped tests in a green run.** A test that cannot find what it needs fails loudly; a skip is a silent pass that tests nothing.
- Deterministic: fixed seeds, no network, no real clock, no reliance on test order.
- Tests never write tracked files.
- Test the error paths and the boundaries (empty input, one item, malformed records), not only the happy path.

## 9. Dependencies, environments and performance

- Pin exact versions, with hashes, for anything CI installs (`pip install --require-hashes`). Adding or bumping a dependency updates the pinned file in the same change.
- Keep the import surface small: import heavy libraries (ML frameworks) inside the functions that need them when most callers don't. Avoid mutable module-level state; a cache or registry is the acceptable kind, and private.

### Performance: a measuring loop

```text
reproduce -> measure (same interpreter, same inputs) -> find the line -> fix -> measure again -> commit with the numbers
```

1. **Reproduce** with one command on fixed input and a fixed seed, so two runs are comparable.
2. **Measure** with `time.perf_counter()` around the step, several runs, the median. Do not time the first run: imports and caches distort it.
3. **Find the line** with the tool for the symptom:

   | Symptom | Tool |
   | --- | --- |
   | Which function is slow | `python3 -m cProfile -o out.prof script.py args`, then `python3 -m pstats out.prof` (`sort cumtime`, `stats 20`) |
   | One loop or call is slow | `time.perf_counter()` before and after; `timeit` for a pure expression |
   | Memory grows | `tracemalloc.start()`, then `tracemalloc.take_snapshot().statistics("lineno")[:10]` |
   | Many interpreters run slower than one | Oversubscribed threads: `run_tests.py` gives each interpreter `cores // jobs` of `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, `OPENBLAS_NUM_THREADS`; set them the same way for your own parallel runs |

4. **Fix:** stream instead of loading, batch, move hot loops into vectorised library calls, cache pure results keyed by their inputs, parallelise independent processes with a bounded pool.
5. **Measure again** with the same command and put before and after in the commit message: "eval pass 9 s, was 31 s".

A `.prof` file or profiler output can capture the environment, and a shell started by an agent carries its tokens. Write it to the scratchpad, delete it after reading, never commit it. The training and VM jobs under `train/` are outside CI; measure them where they run.

## 10. Final checklist

- Signatures typed; records are frozen dataclasses; inputs parsed once at the edge; no reflection, `cast` or leaked `Any`.
- Specific exceptions with context; no swallowed errors; non-zero exit on failure.
- Paths from `pathlib`, explicit UTF-8, atomic writes, argument-list subprocesses with timeouts, aware datetimes.
- Seeds recorded, orders sorted, no wall-clock in outputs.
- Held-out data untouched; shared logic has one implementation.
- Tests deterministic, no skips, no tracked-file writes.
- Imports are modules, names say meaning and unit, comments say why.
