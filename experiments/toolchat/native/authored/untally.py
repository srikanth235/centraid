"""Take Tally's rows out of authored sources: the one-shot migration of #1115 (#1099 removed Tally from v0).

    python3 authored/untally.py builders [FILE ...]          # default: authored/worlds/T*_build.py
    python3 authored/untally.py sessions --worlds-dir DIR    # the world JSON as it was before, to name the removed keys
                                         [--dry] [FILE ...]  # default: authored/sessions/T*.py

`builders` deletes, from each world builder, the top-level statements that define or fill `groups`, `expenses` and `debts`
(and their upper-case and `DEBT_*` spellings, the `group(...)` helper and its calls) and the entries of the final `world`
dict. What it cannot decide is left for the author and listed: the prose of a docstring, the shape checks of a `check()`.

`sessions` deletes every session (`S(...)`, with the `X(...)` turns appended to it) that names a row of a removed section by
key, kind, verb or op: a string literal of the reference calls or the gold that is a removed key (in a gold helper) or
holds `$key`, `debt`, `group`, `settle_up`, `settle_debt`, `balance`, `owes_me`, `i_owe`, `kind: group`, `group: $`.
A name a file defines at the top level (an `OWED = 'direction = "owes_me" ...'`, a `TOP3 = find(kind="debt", ...)`) is tainted
by the same words, or by another tainted name; a session that uses one goes too, and the definitions go with the last of them.
The message and the tags of a session are never read. The sources of the val worlds (T03, T12, T23) and of the eval worlds
are held out: run both commands on them after `python3 artefacts.py fetch`, then rebuild the worlds
(`python3 artefacts.py rebuild`) and `python3 artefacts.py rehash`.

Both commands are idempotent: a second run finds nothing to remove.
"""
from __future__ import annotations

import argparse
import ast
import collections
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

SECTIONS = ("groups", "expenses", "debts")
NAMES = {"groups", "expenses", "debts", "GROUPS", "EXPENSES", "DEBTS", "DEBT_NAMES", "DEBT_PEOPLE"}
HELPERS = {"group", "expense", "debt"}
SESSION_WORDS = re.compile(
    r"\b(?:debts?|settle_up|settle_debt|settle|settled|balance|owes_me|i_owe|owed_to_me)\b|^group$|\bgroup count\b"
    r"|kind: group|group: \$|create a group|\bgroups\b", re.I)
GOLD_HELPERS = {"rows", "ask", "upd", "trash", "restore", "gone", "link", "unlink"}


def _root(node: ast.AST) -> str | None:
    while isinstance(node, (ast.Subscript, ast.Attribute)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def strip_builder(src: str) -> tuple[str, list[str]]:
    """The builder without the statements that define or fill the removed sections, and what is left to read by hand."""
    lines = src.split("\n")
    tree = ast.parse(src)
    dead: set[int] = set()
    for node in tree.body:
        drop = False
        if isinstance(node, ast.Assign) and all(_root(t) in NAMES for t in node.targets):
            drop = True
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and getattr(node.value.func, "id", "") in HELPERS:
            drop = True
        elif isinstance(node, ast.FunctionDef) and node.name in HELPERS:
            drop = True
        elif isinstance(node, ast.For):
            text = "\n".join(lines[node.lineno - 1:node.end_lineno])
            drop = "debts.append" in text or "expenses.append" in text
        if not drop:
            continue
        dead.update(range(node.lineno - 1, node.end_lineno))
        at = node.lineno - 2
        while at >= 0 and lines[at].lstrip().startswith("#"):  # the comment lines that head it
            dead.add(at)
            at -= 1
    text = "\n".join(line for i, line in enumerate(lines) if i not in dead)
    for section in SECTIONS:
        text = re.sub(rf'^\s*"{section}": [A-Za-z_]+,\n', "", text, flags=re.M)
        text = re.sub(rf'"{section}": [A-Za-z_]+, ', "", text)
    text = re.sub(r"^# -{20,}\n# (?:debts|groups and expenses)[^\n]*\n# -{20,}\n\n?", "", text, flags=re.M)  # their banners
    # the shape checks of `check()`: a loop over a removed section, a tuple that lists one, an assert about one
    kept: list[str] = []
    skipping = None
    for line in text.split("\n"):
        if skipping is not None:
            if line.strip() == "" or len(line) - len(line.lstrip()) > skipping:
                continue
            skipping = None
        m = re.match(r'^(\s*)for \w+ in w\["(?:groups|expenses|debts)"\]:\s*$', line)
        if m:
            skipping = len(m.group(1))
            continue
        kept.append(line)
    text = "\n".join(kept)
    for old, new in (('("people", "groups", ', '("people", '), ('"photos", "debts", "locker")', '"photos", "locker")'),
                     ('"groups": (4, 6), ', ""), ('"debts": (10, 15), ', ""), ('("groups", 4, 6), ', ""), ('("debts", 10, 15), ', ""),
                     ('[g["name"] for g in w["groups"]] + ', "")):
        text = text.replace(old, new)
    text = re.sub(r"^\s*assert any\(not (?:g\[\"members\"\] or not )?\[\w+ for \w+ in w\[\"expenses\"\][^\n]*\n", "", text, flags=re.M)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    left = [f"line {i}: {line.strip()[:100]}" for i, line in enumerate(text.split("\n"), 1)
            if re.search(r'\b(?:groups|expenses|debts)\b|"(?:groups|expenses|debts)"', line) and not line.lstrip().startswith("#")]
    return text, left


def _strings(node: ast.AST, removed: set[str]):
    """(value, why) of every string of a session that names a removed row; the message and the tags are skipped."""
    skip: set[int] = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "T" and n.args:
            skip.update(id(m) for m in ast.walk(n.args[0]))
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "S" and len(n.args) > 1:
            skip.update(id(m) for m in ast.walk(n.args[1]))
    gold: set[int] = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in GOLD_HELPERS:
            for arg in n.args:
                gold.update(id(m) for m in ast.walk(arg))
    for n in ast.walk(node):
        if isinstance(n, ast.keyword) and n.arg == "settle":
            yield "settle=", "settle"
        if not (isinstance(n, ast.Constant) and isinstance(n.value, str)) or id(n) in skip:
            continue
        text = n.value
        if id(n) in gold and text in removed:
            yield text, "key"
        for key in re.findall(r"\$([A-Za-z0-9_]+)", text):
            if key in removed:
                yield text, "key"
        if SESSION_WORDS.search(text):
            yield text, "word"


def _tainted(tree: ast.Module, removed: set[str]) -> dict[str, ast.stmt]:
    """The top-level assignments and functions of a session file that hold a removed word or key, or use one that does."""
    defs: dict[str, ast.stmt] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) for t in node.targets):
            defs.update({t.id: node for t in node.targets})
        elif isinstance(node, ast.FunctionDef):
            defs[node.name] = node
    taint = {name for name, node in defs.items() if next(_strings(node, removed), None)}
    grew = True
    while grew:
        grew = False
        for name, node in defs.items():
            if name not in taint and any(isinstance(n, ast.Name) and n.id in taint for n in ast.walk(node)):
                taint.add(name)
                grew = True
    return {name: defs[name] for name in taint}


def sessions_to_drop(path: Path, removed: set[str]) -> tuple[set[str], list[tuple[str, int, int]], dict[str, ast.stmt]]:
    """(ids to drop, every session statement of the file as (id, first line, last line), the tainted definitions)."""
    tree = ast.parse(path.read_text())
    taint = _tainted(tree, removed)
    flagged: set[str] = set()
    spans: list[tuple[str, int, int]] = []
    for node in tree.body:
        if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)):
            continue
        if node.value.func.id not in ("S", "X"):
            continue
        sid = node.value.args[0].value
        spans.append((sid, node.lineno, node.end_lineno))
        if next(_strings(node, removed), None) or any(isinstance(n, ast.Name) and n.id in taint for n in ast.walk(node)):
            flagged.add(sid)
    return flagged, spans, taint


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("builders")
    b.add_argument("files", nargs="*", type=Path)
    s = sub.add_parser("sessions")
    s.add_argument("files", nargs="*", type=Path)
    s.add_argument("--worlds-dir", type=Path, required=True)
    s.add_argument("--dry", action="store_true")
    args = parser.parse_args()
    if args.cmd == "builders":
        files = args.files or sorted((HERE / "worlds").glob("T*_build.py"))
        for path in files:
            text, left = strip_builder(path.read_text())
            if text != path.read_text():
                path.write_text(text)
                print(f"stripped {path.name}")
            for line in left:
                print(f"  left for the author, {path.name} {line}")
        return 0
    files = args.files or sorted((HERE / "sessions").glob("T*.py"))
    removed: dict[str, set[str]] = {}
    for world in sorted({re.match(r"T\d+", f.name).group(0) for f in files}):
        source = args.worlds_dir / f"{world}.json"
        data = json.loads(source.read_text()) if source.is_file() else {}
        removed[world] = {r["key"] for section in SECTIONS for r in data.get(section, []) if "key" in r}
    per_file: dict[Path, tuple[set[str], list, dict]] = {}
    drop: set[str] = set()
    for path in files:
        flagged, spans, taint = sessions_to_drop(path, removed[re.match(r"T\d+", path.name).group(0)])
        per_file[path] = (flagged, spans, taint)
        drop |= flagged
    total = collections.Counter()
    for path, (_flagged, spans, taint) in per_file.items():
        lines = path.read_text().split("\n")
        gone: set[int] = set()
        for node in taint.values():
            gone.update(range(node.lineno - 1, node.end_lineno))
            if node.end_lineno < len(lines) and lines[node.end_lineno].strip() == "":
                gone.add(node.end_lineno)
            total["definitions"] += 1
        for sid, first, last in spans:
            if sid in drop:
                gone.update(range(first - 1, last))
                if last < len(lines) and lines[last].strip() == "":
                    gone.add(last)
                total["sessions" if lines[first - 1].startswith("S(") else "turns appended"] += 1
        if gone and not args.dry:
            path.write_text("\n".join(line for i, line in enumerate(lines) if i not in gone))
    print(f"{'would drop' if args.dry else 'dropped'} {len(drop)} session ids: {dict(total)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
