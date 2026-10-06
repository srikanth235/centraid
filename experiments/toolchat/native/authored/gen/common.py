"""Shared machinery of the phase-5 generators (recover.py, deadend.py, collide.py, rewrite.py).

Not a command. It provides:

  * `load_sessions(w, sessions_dir)`: the sessions of a world as authored/build.py loads them, each turn tagged with its
    source site, so a generator can edit the source text instead of re-emitting the sessions;
  * `Edit` and `apply_edits(src_dir, out_dir, worlds, edits)`: copies every `<W>.py` and `<W>_*.py` of the given worlds
    to `out_dir`, inserting a `bad(...)` step (or replacing a reference element) at the recorded site. Files without an
    edit are copied byte for byte, so the copy is a drop-in `--sessions-dir` for authored/build.py;
  * `render_call` / `render_bad`: a reference call dict as session source (`C("act", verb=..., ...)`);
  * `classify`: the runtime's error text as a family id (`FAMILIES`);
  * `build_world` / `read_records`: run authored/build.py on a sessions directory and read the records back, the way
    every generator verifies its output against the runtime;
  * `rng`: the seeded, order-independent choice every generator uses (same seed and key, same choice).

Environment: NATIVETOOLS (the runtime binary) and EVAL_VAULTS (a scratch vault directory) as for authored/build.py.
"""
from __future__ import annotations

import ast
import concurrent.futures as cf
import dataclasses
import gzip
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
AUTHORED = HERE.parent
NATIVE = AUTHORED.parent
sys.path[:0] = [str(NATIVE / "eval"), str(NATIVE / "train"), str(NATIVE), str(AUTHORED)]

import gold  # noqa: E402

TRAIN_WORLDS = json.loads((AUTHORED / "split.json").read_text())["train"]


def rng(seed: int | str, *key: str) -> random.Random:
    """A generator seeded by (seed, key): the same choice whatever else has been drawn."""
    h = hashlib.sha256("|".join([str(seed), *key]).encode()).hexdigest()
    return random.Random(int(h[:16], 16))


def rank(seed: int | str, *key: str) -> str:
    """A stable sort key: sorting by it shuffles reproducibly."""
    return hashlib.sha256("|".join([str(seed), *key]).encode()).hexdigest()


# --- loading -------------------------------------------------------------------------------------


def session_files(w: str, sessions_dir: Path) -> list[Path]:
    return [sessions_dir / f"{w}.py"] + sorted(sessions_dir.glob(f"{w}_*.py"))


def load_sessions(w: str, sessions_dir: Path = AUTHORED / "sessions") -> list[dict]:
    """The sessions of world `w` (same order and content as build.load_sessions), each turn carrying
    `_site = (file, k)`: the k-th `T(...)` call of that file."""
    import importlib.util

    gold._SESSIONS.clear()
    orig = gold.T
    try:
        for f in session_files(w, sessions_dir):
            seen: list[str] = []

            def T(user, *g, ref, tags=(), _f=str(f), _seen=seen, _orig=orig):
                t = _orig(user, *g, ref=ref, tags=tags)
                t["_site"] = (_f, len(_seen))
                _seen.append(user)
                return t

            gold.T = T
            spec = importlib.util.spec_from_file_location(f"gen_{f.stem}", f)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
    finally:
        gold.T = orig
    return [dict(s) for s in gold.sessions()]


@dataclasses.dataclass
class Edit:
    """One source edit: insert `text` as ref element `step` of the `T(...)` call at `site` (before the element that is
    there; `step == len(ref)` appends), or replace the element at `step` with `text` when `replace` is set. With
    `what="user"` it replaces the message literal of that `T(...)` with `text` (python source of a string); with
    `what="append"` it adds `text` as new lines at the end of the file (`t_index` and `step` are unused)."""

    file: str
    t_index: int
    step: int
    text: str
    replace: bool = False
    what: str = "ref"  # "ref": an element of the ref list; "user": the message literal (replace); "append": text at file end


def t_calls(path: Path) -> list[ast.Call]:
    tree = ast.parse(path.read_text())
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "T"]
    return sorted(calls, key=lambda n: (n.lineno, n.col_offset))


def ref_nodes(path: Path) -> list[ast.List | None]:
    """The `ref=[...]` list node of every `T(...)` call in a session file, in source order (None when the ref is not
    a plain list literal without a starred element)."""
    tree = ast.parse(path.read_text())
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "T"]
    calls.sort(key=lambda n: (n.lineno, n.col_offset))
    out: list[ast.List | None] = []
    for c in calls:
        node = next((k.value for k in c.keywords if k.arg == "ref"), None)
        ok = isinstance(node, ast.List) and not any(isinstance(e, ast.Starred) for e in node.elts)
        out.append(node if ok else None)
    return out


def sites_ok(path: Path, users: list[str]) -> bool:
    """True when the T(...) calls of the file in source order are the turns the loader saw in execution order."""
    tree = ast.parse(path.read_text())
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "T"]
    calls.sort(key=lambda n: (n.lineno, n.col_offset))
    if len(calls) != len(users):
        return False
    for c, u in zip(calls, users):
        a = c.args[0] if c.args else None
        if isinstance(a, ast.Constant) and a.value != u:
            return False
    return True


def usable_sites(w: str, sessions: list[dict], sessions_dir: Path) -> dict[str, list[ast.List | None]]:
    """Per file with a verified site mapping, its ref nodes; the other files are not edited."""
    users: dict[str, list[str]] = {}
    for s in sessions:
        for t in s["turns"]:
            f, k = t["_site"]
            lst = users.setdefault(f, [])
            lst += [""] * (k + 1 - len(lst))
            lst[k] = t["user"]
    out = {}
    for f, us in users.items():
        if sites_ok(Path(f), us):
            out[f] = ref_nodes(Path(f))
    return out


# --- rendering and editing ------------------------------------------------------------------------


def render_call(call: dict) -> str:
    args = ", ".join(f"{k}={v!r}" for k, v in call.get("args", {}).items())
    return f"C({call['tool']!r}, {args})" if args else f"C({call['tool']!r})"


def render_bad(call: dict) -> str:
    return f"bad({render_call(call)})"


def apply_edits(src_dir: Path, out_dir: Path, worlds: list[str], edits: list[Edit]) -> None:
    """Copy the session files of `worlds` to `out_dir` with `edits` applied."""
    out_dir.mkdir(parents=True, exist_ok=True)
    by_file: dict[str, list[Edit]] = {}
    for e in edits:
        by_file.setdefault(e.file, []).append(e)
    for w in worlds:
        for f in session_files(w, src_dir):
            if not f.exists():
                continue
            es = by_file.get(str(f), [])
            if not es:
                shutil.copyfile(f, out_dir / f.name)
                continue
            nodes = ref_nodes(f)
            calls = t_calls(f)
            lines = f.read_bytes().split(b"\n")
            placed = []
            appended = [e for e in es if e.what == "append"]
            for e in es:
                if e.what == "append":
                    continue
                if e.what == "user":
                    a0 = calls[e.t_index].args[0]
                    placed.append(((a0.lineno, a0.col_offset, a0.end_lineno, a0.end_col_offset), e))
                    continue
                node = nodes[e.t_index]
                if node is None:
                    raise ValueError(f"{f.name}: T #{e.t_index} has no plain ref list")
                if e.step < len(node.elts):
                    el = node.elts[e.step]
                    pos = (el.lineno, el.col_offset, el.end_lineno, el.end_col_offset)
                else:  # append after the last element
                    el = node.elts[-1]
                    pos = (el.end_lineno, el.end_col_offset, el.end_lineno, el.end_col_offset)
                placed.append((pos, e))
            for (l0, c0, l1, c1), e in sorted(placed, key=lambda p: (p[0][0], p[0][1]), reverse=True):
                text = e.text.encode()
                if e.what == "user":
                    lines[l0 - 1:l1] = [lines[l0 - 1][:c0] + text + lines[l1 - 1][c1:]]
                elif e.replace:
                    lines[l0 - 1:l1] = [lines[l0 - 1][:c0] + text + lines[l1 - 1][c1:]]
                elif e.step >= len(nodes[e.t_index].elts):  # append after the last element
                    lines[l1 - 1] = lines[l1 - 1][:c1] + b", " + text + lines[l1 - 1][c1:]
                else:
                    line = lines[l0 - 1]
                    prefix = line[:c0]
                    if prefix.strip() == b"":  # the element starts its own line: the new one gets a line above it
                        lines[l0 - 1] = prefix + text + b",\n" + prefix + line[c0:]
                    else:
                        lines[l0 - 1] = prefix + text + b", " + line[c0:]
            body = b"\n".join(lines)
            if appended:
                body = body.rstrip(b"\n") + b"\n" + b"".join(e.text.encode() + b"\n" for e in appended)
            (out_dir / f.name).write_bytes(body)


def edit_session(src: dict, turn_idx: int, step: int, call: dict) -> Edit:
    t = src["turns"][turn_idx]
    f, k = t["_site"]
    return Edit(f, k, step, render_bad(call))


# --- the runtime's error families ----------------------------------------------------------------

# id -> regex over the first line of the error text. Order matters (first match wins). The families are the classes of
# `error:` constructors of crates/nativetools/src (act.rs, session.rs, dates.rs, whr.rs, search.rs), grouped by what a
# model has to change to repair the call.
FAMILIES: list[tuple[str, str]] = [
    ("repeated_call", r"^error: repeated call"),
    ("undo_nothing", r"^error: nothing to undo"),
    ("rows_needed", r"^error: act needs rows=#n or a selector"),
    ("balance_person", r"^error: (balance is for one person|a group's balance is one person's|balance is defined for)"),
    ("args_not_taken", r"^error: \w+ takes no args"),
    ("param_not_taken", r"^error: \w+ (has no parameter|takes no \w+ parameter)"),
    ("verb_unknown", r"^error: no verb"),
    ("verb_not_apply", r"^error: \w+ does not apply to"),
    ("date_via_edit", r"^error: a date changes with reschedule"),
    ("date_expr", r"^error: could not read the date expression"),
    ("field_wrong_kind", r"^error: ([\w ]+ have no field|create \w+ args take)"),
    ("bad_value", r"^error: \w+ has no value"),
    ("number_field", r"^error: (effort|duration|cadence|priority|amount) (is|cannot)"),
    ("op_needs_field", r"^error: (sum|min|max) needs field"),
    ("where_name", r"^error: where has no name field"),
    ("where_syntax", r"^error: could not read \""),
    ("create_kind", r"^error: create (takes kind as the top-level|needs the kind parameter)"),
    ("unshown_row", r"^error: #\d+ was never shown"),
    ("vault_refusal", r"^error: .* was refused"),
    ("add_slot", r"^error: ((add_to|remove_from) takes (to|from): #n|\"[^\"]*\" is not a row)"),
]
_FAM = [(i, re.compile(r)) for i, r in FAMILIES]


def classify(text: str) -> str:
    """The family of a runtime reply ('' when it is not an error)."""
    if not text.startswith("error"):
        return ""
    for fid, rx in _FAM:
        if rx.search(text):
            return fid
    return "other"


def why_dropped_text(entry: dict) -> str:
    """The first problem of a report entry, short (build.why_dropped names the class; this the text)."""
    for p in entry.get("problems", []):
        for t in p.get("problems", []) or []:
            return str(t)[:120]
        if "trace" in p:
            return f"trace {p['trace']}: {str(p.get('detail', ''))[:80]}"
        if "error" in p:
            return str(p["error"])[:120]
    return "dropped"


def table_classifier(errors_json: Path):
    """From the runtime's `errors.json` export (`nativetools export`): a function that maps an error reply to the id of
    the family whose template it instantiates ('' when none does). Templates become regular expressions (`{...}`
    matches anything); the most specific (longest literal text) wins."""
    fams = json.loads(Path(errors_json).read_text())["families"]
    pats = []
    for f in fams:
        t = f["template"]
        lit = len(re.sub(r"\{[^}]*\}", "", t))
        rx = re.sub(r"\\\{[^}]*?\\\}", ".*?", re.escape(t))
        pats.append((lit, f["id"], re.compile("^" + rx, re.S)))
    pats.sort(key=lambda p: -p[0])

    def classify_table(text: str) -> str:
        for _lit, fid, rx in pats:
            if rx.search(text):
                return fid
        return ""
    return classify_table


# --- verifying against the runtime ---------------------------------------------------------------


def build_world(w: str, sessions_dir: Path, out: Path, worlds_dir: Path | None = None, only: list[str] | None = None,
                env: dict | None = None, split: str = "train") -> subprocess.CompletedProcess:
    cmd = [sys.executable, str(AUTHORED / "build.py"), w, "--out", str(out), "--split", split, "--gold-from-ref",
           "--sessions-dir", str(sessions_dir)]
    # GEN_WORLDS_DIR: the worlds the sessions were written against (the collided worlds of authored/gen/collide.py when the
    # sources are rewrite.py's output); without it a rewritten session is verified against the base worlds and fails.
    worlds_dir = worlds_dir or os.environ.get("GEN_WORLDS_DIR") or None
    if worlds_dir:
        cmd += ["--worlds-dir", str(worlds_dir)]
    if only is not None:
        cmd += ["--only", ",".join(only)]
    e = dict(os.environ, **(env or {}))
    return subprocess.run(cmd, capture_output=True, text=True, env=e)


def build_many(jobs: list[tuple[str, list[str] | None]], sessions_dir: Path, out: Path, worlds_dir: Path | None = None,
               n_jobs: int = 4) -> None:
    out.mkdir(parents=True, exist_ok=True)
    with cf.ThreadPoolExecutor(n_jobs) as ex:
        futs = {ex.submit(build_world, w, sessions_dir, out, worlds_dir, only): w for w, only in jobs}
        for fu in cf.as_completed(futs):
            r = fu.result()
            (out / f"{futs[fu]}.log").write_text(r.stdout + r.stderr)


def baseline_failures(sids_by_world: dict[str, list[str]], src: Path, out: Path, jobs: int = 4) -> set[str]:
    """The sessions among `sids_by_world` that already fail to verify in `src` (without any edit of ours): a failure
    there is the tree's, not the generator's."""
    bdir = out / "_baseline"
    build_many([(w, sorted(s)) for w, s in sids_by_world.items() if s], src, bdir, n_jobs=jobs)
    failing: set[str] = set()
    for w, sids in sids_by_world.items():
        rep = read_report(bdir, w)
        failing |= {sid for sid in sids if not rep.get(sid, {"pass": False})["pass"]}
    return failing


def read_records(out: Path, w: str) -> dict[str, list[dict]]:
    """id (without the split prefix) -> messages of the record, for the sessions that verified."""
    p = out / f"{w}.jsonl.gz"
    recs = {}
    if p.exists():
        for line in gzip.open(p, "rt"):
            r = json.loads(line)
            recs[r["id"].split("-", 1)[1]] = r["messages"]
    return recs


def read_report(out: Path, w: str) -> dict[str, dict]:
    p = out / f"{w}.report.json"
    return {e["id"]: e for e in json.loads(p.read_text())} if p.exists() else {}


def turn_steps(msgs: list[dict]) -> list[list[tuple[dict, str]]]:
    """Per turn, the (assistant message, tool reply text) pairs of a record."""
    turns: list[list] = []
    for i, m in enumerate(msgs):
        if m["role"] == "user":
            turns.append([])
        elif m["role"] == "assistant" and turns:
            nxt = msgs[i + 1] if i + 1 < len(msgs) else None
            turns[-1].append((m, nxt["content"] if nxt and nxt["role"] == "tool" else ""))
    return turns
