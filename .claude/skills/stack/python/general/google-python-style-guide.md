# Google Python Style Guide (digest)

Source: https://google.github.io/styleguide/pyguide.html . Google's Python style guide, licensed [CC-BY 3.0](../licenses/google-styleguide-LICENSE). This file is a condensed and adapted digest of that guide, not its text: rules and their reasons, with the parts that assume Google's internal tooling (Pylint config, Blaze, Python 2 compatibility, `google3` paths) left out. The guide's governing idea: be consistent with the code around you, and optimise for the reader.

## Language rules

### Lint

Run a linter over all code. It catches the bugs and style slips that are easy to miss (unused names, shadowed builtins, wrong arguments). Suppress a warning only on the line it applies to, with a comment saying why, and prefer fixing the code. Delete unused names rather than suppressing them.

### Imports

- Import packages and modules, not individual classes or functions: `from pkg import mod`, then `mod.func()`. The namespace then shows where a name comes from.
- Use `import x` for packages and modules, `from x import y` when `x` is a package prefix and `y` a module, `from x import y as z` only for a clash or a long name, and `import y as z` only for standard abbreviations (`import numpy as np`).
- Exempt from the module-only rule: names from `typing`, `collections.abc`, and `typing_extensions`.
- Use full package paths; no relative imports, and no assumption about `sys.path` or the current directory.

### Packages

Import each module by its full package name, so two modules with the same file name never collide and a reader can find the file.

### Exceptions

- Raise with `raise ValueError("message")`, never the two-argument form. Use built-in exception types where one fits (`ValueError` for a bad argument value); never use `assert` for validation of inputs or preconditions in library code, because it vanishes under `-O` and is not an error contract.
- Library modules may define their own exception types, named `...Error`, inheriting from an existing exception class, and not shadowing built-ins.
- Never use a bare `except:`, and avoid catching `Exception` unless you re-raise, are at an isolation point (a thread boundary, a top-level handler), or are logging and about to exit. A broad catch hides bugs.
- Keep the `try` body minimal; use `finally` or a context manager for cleanup.
- When re-raising a different exception, chain it (`raise X from err`) so the cause survives.

### Mutable global state

Avoid it: it breaks encapsulation, makes tests order-dependent, and can change behaviour at import time. When needed, make it a module-level constant (`_UPPER_CASE`, internal if not part of the API). Module-level caches and registries are the acceptable exceptions; make them private and document them.

### Nested functions and classes

Fine to close over a name when it helps (a small helper, a decorator). Do not nest a function only to hide it from tests; if it needs testing, make it module-level. Nested classes are allowed but rarely worth it.

### Comprehensions and generator expressions

Use them for simple cases: one `for` clause and an optional `if`. Multiple `for` clauses or filter expressions make a comprehension hard to read; use a loop. Prefer a generator expression when the result is consumed once.

### Default iterators and operators

Iterate over containers and files directly: `for k in d`, `for line in f`, `if k in d`, not `d.keys()`, `readlines()` or `has_key`. This is shorter, and works for any container, including lazy ones. Do not mutate a container while iterating over it.

### Generators

Use them freely. They keep memory flat for large or streamed data. Use `Yields:` in the docstring instead of `Returns:`. Clean up in a `try/finally` if the generator holds a resource.

### Lambdas

Fine for one-liners (a `key=` function). If it spans more than a line or is reused, write a `def`. Prefer `operator.itemgetter`/`mul` over `lambda x: x[1]` where one exists.

### Conditional expressions

`x if cond else y` is fine for one short line. Each part (the value, the condition, the alternative) must fit on one line; otherwise use `if`.

### Default argument values

- Never use a mutable object (`[]`, `{}`, a new instance) as a default: it is created once and shared across calls. Default to `None` and create inside the function.
- Do not call functions in a default (evaluated at definition time, not call time).

### Properties

Use `@property` to guard a simple computation or validation on attribute access, with the access staying cheap and unsurprising. Do not use it to hide an expensive call or a side effect; use a method.

### True/False evaluations

- Use the implicit falsiness of sequences: `if seq:` and `if not seq:`, not `if len(seq)`.
- Test `None` with `is None` / `is not None`, never `== None`; and never compare booleans with `==`: write `if x:`.
- Beware that `0`, `""`, `[]` and `None` are all falsy: when `0` or empty is a valid value, test `is None` explicitly (`if x is None`, not `if not x`).
- Numpy arrays and similar types may raise on truthiness; compare explicitly there.

### Lexical scoping

Nested functions can read enclosing variables; use `nonlocal` to rebind. Beware late-binding closures in loops: the closure sees the variable's final value, not each iteration's. Bind with a default argument or `functools.partial`.

### Decorators

Use them where there is a clear benefit (`@property`, `@staticmethod`, `@classmethod`, `@functools.wraps` inside your own). Write decorators with `functools.wraps`. Avoid `staticmethod` unless it is required to fit an existing API; write a module-level function instead. Use `classmethod` only for named constructors and for class-level state. Do not let a decorator depend on a hidden external state or do slow work at import time.

### Threading

Do not rely on the atomicity of built-in types; use `queue.Queue` for communicating between threads, and `threading` locks or conditions for shared state.

### Power features

Avoid custom metaclasses, access to bytecode, import hacks, reflection-heavy code, dynamic inheritance and `__del__` tricks. They are fine inside a library that hides them from the rest of the code; they are a cost for every reader of application code.

### Modern Python and `__future__`

Use `from __future__ import ...` to turn on a newer semantic in a file when the interpreter supports the statement. For this tree's 3.11 CI, `from __future__ import annotations` is the useful one: annotations become lazy strings, so forward references work and annotation cost disappears.

### Type annotations

Annotate public APIs and anything whose type is not obvious; run a type checker. Annotations are documentation that is checked. Details in "Type annotations" below.

## Style rules

### Layout

- **Semicolons:** none; one statement per line.
- **Line length:** at most 80 characters, with the exceptions of long imports, URLs and paths in comments, and long string constants that cannot be split. Break with implicit continuation inside brackets, not backslashes. (This tree's scripts use wider lines; follow the file you are editing.)
- **Parentheses:** only where needed. Not around `return` or `if` conditions unless the condition spans lines or needs grouping.
- **Indentation:** 4 spaces, never tabs. Hanging indents either align with the opening bracket or use a further 4 spaces with nothing after the opening bracket.
- **Trailing commas:** use them when the closing bracket is on its own line, so adding an item is a one-line diff; formatters then keep one item per line.
- **Blank lines:** two between top-level definitions, one between methods; none after a `def` line.
- **Whitespace:** none inside brackets or before a comma, colon or call paren; one space around assignment and comparison operators; no alignment of tokens across lines; no spaces around `=` in a keyword argument or default unless the parameter is annotated (`def f(x: int = 0)`).
- **Shebang:** only for files meant to be executed directly, `#!/usr/bin/env python3`.

### Comments and docstrings

- **Docstrings** use triple double quotes. A one-line summary (fits on one line, ends with a period, question mark or exclamation mark), a blank line, then the rest, indented like the first quote.
- **Modules:** start with a docstring saying what the module is and how it is used; for test modules, one is needed only when it adds information (how to run, unusual setup).
- **Functions and methods:** a docstring is mandatory for public API, non-trivial size, or non-obvious logic. Describe what the function does and how it is called, not how it is implemented. Sections: `Args:` (every parameter, `name: description`; the type goes in the annotation), `Returns:` (or `Yields:`), `Raises:` (the exceptions that are part of the interface, not those from violating the docs). A short, obvious function can have a one-line docstring. A function that overrides a base method with `@override` needs no docstring unless it changes behaviour.
- **Classes:** a docstring under the `class` line saying what an instance represents; public attributes in an `Attributes:` section.
- **Block comments** precede the code and explain the non-obvious (a why, not a what); **inline comments** sit at least two spaces after the code, are used sparingly, and never restate it. Do not describe the code to a reader who knows Python.
- Use proper grammar, spelling and punctuation: comments are prose.
- **TODOs:** `# TODO: <link to issue> - <what and why>`; a TODO without a reference to an issue is noise.

### Strings

- Use f-strings, `%`-formatting or `.format()` for formatting; do not build a string with `+` in a loop (quadratic): append to a list and `"".join`.
- Be consistent in the quote character within a file; use triple double quotes for multi-line strings and docstrings (never `'''`). Multi-line strings do not flow with indentation; prefer adjacent literals in parentheses where it matters.
- **Logging:** use the `logging` module (and `absl.logging` where that is the house choice), with a pattern string and arguments as separate parameters, not an f-string: `logger.info("Fetched %d rows", n)`. The record is then lazily formatted and the template can be grouped.
- **Error messages** should match the actual condition, name the offending value, be clearly an error, and be easy to find by search or diff.

### Files, sockets and stateful resources

Close every file, socket, lock or connection explicitly; use `with` (and `contextlib.closing` for objects that only have `close()`). Relying on the garbage collector to close them leaks descriptors and delays flushing.

### Imports formatting

Imports go at the top, after the module docstring, one per line (a `from` import may list several names, or wrap them). Group them: `__future__`; standard library; third-party; this project; each group sorted lexicographically, ignoring case, by full module path.

### Statements, getters and setters

- One statement per line; an `if`/`for`/`while` body goes on its own line (a one-line `if x: y` is tolerated only when the whole statement fits and there is no `else`).
- Do not write trivial getters and setters; use plain attributes, and switch to a property if a computation is later needed. Keep real accessor names `get_foo()`/`set_foo()` for when the access is expensive or has a side effect.

### Naming

- `module_name`, `package_name`, `ClassName`, `method_name`, `ExceptionName`, `function_name`, `GLOBAL_CONSTANT_NAME`, `global_var_name`, `instance_var_name`, `function_parameter_name`, `local_var_name`, `query_proj_id`, `TypeVar` as `CamelCase` (short, or with a `_co`/`_contra` suffix), and `_leading_underscore` for internal use. Do not use a double underscore for privacy.
- A name describes meaning, not type: no `id_to_name_dict`; avoid single-character names except in short loops or comprehensions (`i`, `j`, `k`, `e` for exceptions, `f` for files), dashes in module names, and names that duplicate the package. Avoid needlessly abbreviated names; abbreviations the project knows are fine.
- File names end in `.py` with no dashes; test files `test_*.py` or `*_test.py`.
- Math-heavy code may use the formula's own short names, with a comment linking to the source of the formula.

### Main

Executable modules guard their entry point with `if __name__ == "__main__":` calling a `main()`. All top-level code runs at import time, so nothing with side effects (parsing arguments, starting work) lives at the top of an importable module. An importable module must be importable without running anything.

### Function length

Prefer short, focused functions. There is no hard cap, but once a function passes about 40 lines, consider splitting it, unless it stays easy to follow. Do not split a long function that is clearer whole, and never at the cost of a worse name or a worse interface: it must be readable and testable by others.

## Type annotations

- **General:** annotate public functions, and anything unclear. Do not annotate `self` or `cls` (use `Self` when needed). Use `Any` only when it is truly necessary, and use `object` sparingly. Prefer abstract container types for parameters (`Sequence`, `Mapping`, `Iterable`) and concrete ones for returns. Prefer `X | None` over `Optional[X]` (and over `Union`) in new code; never use an implicit optional (a `None` default with a non-optional type).
- **Line breaking:** follow the same rules as other code; break after the opening bracket and keep one parameter per line, with the annotations inline. A long annotation may get a type alias.
- **Forward declarations:** a class used before its definition in a file goes in quotes, or the module uses `from __future__ import annotations`.
- **Default values:** write `a: int = 0` with spaces around `=`.
- **NoneType:** write `X | None`; never leave `None` out of a possibly-`None` value.
- **Aliases:** give a complex type a `CamelCase` alias; mark it `TypeAlias` when public. Keep private aliases `_Private`.
- **Ignoring types:** a `# type: ignore` (or the checker's own form) goes on one line with the specific error code and a reason. Prefer to fix the type.
- **Typing variables:** annotate a variable when its type cannot be inferred (an empty container) with a plain `x: list[int] = []`; do not use type comments.
- **Tuples vs lists:** a list is homogeneous and variable-length (`list[int]`); a tuple is fixed-length (`tuple[int, str]`) or homogeneous with `tuple[int, ...]`.
- **TypeVars:** give a TypeVar a descriptive name or a single capital letter; constrain it only when needed (`bound=`), and do not use a type variable that appears once in a signature (use the bound type instead). Use `Self` for methods returning their own type.
- **String types:** use `str` for text and `bytes` for binary data; `AnyStr` only for functions that accept both and return the same kind.
- **Imports for typing:** import typing symbols individually (`from typing import Any`), and `from collections.abc import Sequence`. Use built-in generics (`list`, `dict`) over `typing.List` in code that can use them. Break type-only cycles with `if TYPE_CHECKING:` imports and quoted or deferred annotations (`from __future__ import annotations`); better, restructure to remove the cycle.
- **Generics:** always give type parameters: `Sequence[str]`, not bare `Sequence`, which means `Sequence[Any]`.

## Parting words

Be consistent. Where the guide is silent, match the surrounding file. Code that follows the rules but is unreadable is still bad code: the rules serve the reader, so use judgment, and keep new code at least as clear as the code around it.
