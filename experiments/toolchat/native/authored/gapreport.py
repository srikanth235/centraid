"""Gap report: where the authored corpus differs from the task, and how the model did there.

    python3 authored/gapreport.py --gold '/tmp/authored-T*/T*.gold.jsonl' \
        --gate GATE.json [--run VAL_REPORT.json] [--seed-red authored/seed_red.json] \
        --label authored2 --out DIR [--prev DIR/old.json]

The authored side is the train worlds only (authored/split.py drops the val worlds from whatever
--gold matches). The reference is `val` (eval/sets/val.jsonl: whole authored worlds held out of
training). Every turn, authored and val alike, is tagged by the same code (`analyse`), so the two
distributions are comparable. Shares, coverage and the AUC gate are measured against val only; this
file never reads eval/sets/test.jsonl (authored/seed_red.py, run once, is the single exception).

A tag is a gap when it is thin against val (share, uses). Coverage is not enough: a tag is RED when it
is covered but the model's pass rate on it is under 0.80 with at least 15 turns, taken from a val run
report (--run) and/or a red list (--seed-red). Gates: names-masked AUC authored vs val (gate.py,
pass <= 0.55) and the hardness share per tag (min over tags with 30+ uses >= 0.30; the axis tags fit:* and
depth:* are excluded from that minimum, since fit:1 and depth:1 are easy by definition).
Writes OUT/<label>.json (the snapshot) and OUT/<label>.html (the report, with deltas vs --prev).
"""
from __future__ import annotations

import argparse
import glob
import html
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVAL = HERE.parent / "eval"
sys.path[:0] = [str(EVAL), str(HERE)]
import conventions  # noqa: E402
import split  # noqa: E402  (authored/split.py: which worlds are val)

VAL = EVAL / "sets" / "val.jsonl"
MIN_USES, MIN_RATIO, OVER_RATIO = 30, 0.5, 3.0
RED_PASS, RED_MIN_TURNS = 0.80, 15  # a covered tag is red below this val pass rate, on at least this many turns
AUC_PASS_LINE = 0.55                # names-masked AUC, authored vs val (gate.py)
HARD_MIN_SHARE = 0.30               # every tag with MIN_USES+ uses has at least this share of hard turns
HARD_EXEMPT = ("fit", "depth")      # axis tags: hardness is what defines them, so they are outside the min-hardness gate
STOP = {"the", "and", "for", "with", "from", "my", "our", "new", "old", "day", "trip", "list"}
PRONOUN = re.compile(r"\b(it|its|that|those|them|these|this one|that one|the (first|second|third|last|other) one|same)\b", re.I)
CORRECTION = re.compile(r"^(no[, ]|actually|wait|sorry|i meant|not that|oops)|\bi meant\b", re.I)
NEVER_MIND = re.compile(r"\b(never ?mind|forget it|cancel that|scratch that|don'?t bother)\b", re.I)

FAMILIES = {
    "outcome": "Gold outcome", "convention": "Conventions (§14 rules)", "value": "Value answers",
    "ask": "Asking", "decline": "Declines", "write": "Writes by verb", "shape": "Turn shape",
    "context": "Conversation", "rows": "Rows returned", "distractor": "Near-miss rows",
    "date": "Date subtypes", "depth": "Call depth", "fit": "Fitting rows at commit", "typo": "Typos",
    "limit": "Order and limit", "flow": "Act then read, compaction",
}


def rows_of(world: dict) -> dict[str, dict]:
    out = {}
    for v in world.values():
        if isinstance(v, list):
            for r in v:
                if isinstance(r, dict) and "key" in r:
                    out[r["key"]] = r
    return out


def tokens(name: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", name.lower()) if len(w) >= 3 and w not in STOP}


def has_distractor(keys: list[str], rows: dict[str, dict]) -> bool:
    """A changed row has a near-miss: another row sharing a name word."""
    for k in keys:
        r = rows.get(k)
        if not r or not r.get("name"):
            continue
        t = tokens(str(r["name"]))
        if any(o is not r and t & tokens(str(o.get("name", ""))) for o in rows.values()):
            return True
    return False


def base_tags(turn: dict, idx: int, rows: dict[str, dict]) -> set[str]:
    g = turn["gold"][0]
    kind = g["type"]
    ref = turn["ref"]
    text = turn["user"]
    tags = {f"outcome:{kind}"}
    tags |= {f"convention:{c}" for c in conventions.detect(turn)}
    acts = [c for c in ref if c["tool"] == "act"]
    for c in ref:
        op = c["args"].get("op") if isinstance(c.get("args"), dict) else None
        if op and c["tool"] in ("answer", "compute"):
            tags.add(f"value:{op}")
    if kind == "ask":
        a = next((c for c in ref if c["tool"] == "ask"), None)
        tags.add("ask:options" if a and a["args"].get("options") else "ask:open")
    if kind == "decline":
        tags |= {f"decline:{r}" for r in g.get("reasons", [])}
    for c in acts:
        tags.add(f"write:{c['args'].get('verb')}")
    if len(acts) >= 2:
        tags.add("shape:multi_write")
    if len(ref) >= 3:
        tags.add("shape:3+_calls")
    words = len(text.split())
    tags.add("shape:fragment_<=3w" if words <= 3 else "shape:long_>=12w" if words >= 12 else "shape:mid_4-11w")
    if idx > 1:
        tags.add("context:followup")
        if PRONOUN.search(text):
            tags.add("context:pronoun")
    if CORRECTION.search(text):
        tags.add("context:correction")
    if NEVER_MIND.search(text):
        tags.add("context:never_mind")
    if kind == "rows":
        n = len(g.get("rows") or [])
        tags.add("rows:0" if n == 0 else "rows:1" if n == 1 else "rows:2-3" if n <= 3 else "rows:4+")
    if kind == "diff":
        keys = [r["key"] for r in g["diff"].get("rows", []) if r.get("change") != "created" and r.get("key")]
        if keys:
            tags.add("distractor:present" if has_distractor(keys, rows) else "distractor:absent")
    return tags


# --- difficulty ---------------------------------------------------------------------------------
# Tags for what makes a turn hard, computed from the turn and its world only, so the same code tags an
# authored turn and a val turn: date subtype, call depth, fitting rows at commit, typo, order/limit,
# act-then-read, compaction. Rulings (convention:*) and message length (shape:*_w) are tagged above.

MONTH_RE = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
WEEKDAY_RE = r"\b(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?\b"
ORDINAL_W = (r"(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|"
             r"sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty[- ]\w+|thirtieth|thirty[- ]first)")
EXPLICIT_DATE = re.compile(
    rf"\d{{4}}-\d\d-\d\d|\b\d{{1,2}}/\d{{1,2}}|\b\d{{1,2}}(?:st|nd|rd|th)?\s+(?:of\s+)?{MONTH_RE}\b|\b{MONTH_RE}\.?\s+(?:the\s+)?\d{{1,2}}(?:st|nd|rd|th)?\b|"
    rf"\bthe\s+\d{{1,2}}(?:st|nd|rd|th)\b|\b{ORDINAL_W}\s+(?:of\s+)?{MONTH_RE}\b|\b{MONTH_RE}\s+{ORDINAL_W}\b|\bthe\s+{ORDINAL_W}\b|\b20\d\d\b", re.I)
MONTH_NAMED = re.compile(rf"\b{MONTH_RE}\b|\bmay\s+(?:\d|the\b|{ORDINAL_W}\b)|\b(?:in|of|since|from|through|until|till|last|next|this)\s+may\b", re.I)
END_OF_MONTH = re.compile(rf"\bend of (?:the\s+|this\s+|next\s+|last\s+)?(?:month|{MONTH_RE})\b|\bmonth[- ]?end\b|\beom\b|\blast day of\b", re.I)
WEEKS_AHEAD = re.compile(r"\b(?:in|within)\s+(?:a|an|one|two|three|four|five|six|\d+)\s+weeks?\b|\bweeks?\s+(?:from|after)\s+(?:now|today|next)\b|\bnext week\b|\bfortnight\b|\bweek after next\b", re.I)
LAST_YEAR = re.compile(r"\b(?:last|previous)\s+year\b", re.I)
THIS_YEAR = re.compile(r"\bthis\s+year\b|\byear[- ]to[- ]date\b", re.I)
ANCHOR_PHRASE = re.compile(r"\b(?:before|after|around|same day as|day of|day after|day before|following|prior to)\s+(?:the\s+|my\s+|our\s+|his\s+|her\s+)?([a-z0-9']+(?:\s+[a-z0-9']+){0,2})", re.I)
BARE_ANCHOR = re.compile(r"\bthe day (?:before|after)\b|\b(?:a|the) (?:day|week)s? (?:before|after)\b|\bsame day\b", re.I)
ISO_DATE = re.compile(r"\d{4}-\d\d-\d\d")
DATE_KEYS = ("when", "date", "due", "to", "from", "on", "start", "end", "taken")
DATE_FIELDS = {"start", "end", "due", "date", "taken", "created"}
# shorthand a person types on purpose; never counted as a typo
SHORTHAND = set("tmrw tmr tmrrw pls plz thx ppl wknd mins hrs msgs info docs pics todo todos cal appt appts sept".split())
# the app's own verbs and kinds, missing from a general vocabulary
APP_WORDS = set("delete deleted rename renamed unpin unstar undelete restore reschedule reschedules resched undo redo "
                "reopen unstarred nickname nicknames notebook notebooks album albums locker wifi".split())
SUFFIX = ("s", "es", "ed", "d", "ing", "ly", "er", "est", "ers", "ings")
_VOCAB: set[str] | None = None
_DEL: dict[str, set[str]] = {}
_BUILD: dict = {}


def _deletes(w: str) -> set[str]:
    return {w[:i] + w[i + 1:] for i in range(len(w))}


def known_words() -> set[str]:
    """Whole-word vocabulary of bge-small (the model gate.py embeds with), every word in every world file
    (names, places, notes) and every word the session sources use three times or more. A word in none of
    them is a spelling candidate."""
    global _VOCAB
    if _VOCAB is None:
        files = glob.glob(str(Path.home() / ".cache/huggingface/hub/models--BAAI--bge-small-en-v1.5/snapshots/*/vocab.txt"))
        if not files:
            raise SystemExit("gapreport: bge-small vocab.txt is not in the HF cache (the typo tag needs it)")
        vocab = {w.strip() for w in open(files[0], encoding="utf-8") if w.strip().isalpha()}
        for f in glob.glob(str(HERE / "worlds" / "T*.json")) + glob.glob(str(EVAL / "worlds" / "[A-Z].json")):
            vocab |= set(re.findall(r"[a-z]+", open(f, encoding="utf-8").read().lower()))
        seen: Counter = Counter()  # words the authors use over and over are vocabulary, not slips
        for f in glob.glob(str(HERE / "sessions" / "*.py")):
            seen.update(re.findall(r"[a-z]+", open(f, encoding="utf-8").read().lower()))
        vocab |= {w for w, n in seen.items() if n >= 3}
        _VOCAB = vocab
        for w in vocab:
            if len(w) >= 4:
                for d in _deletes(w) | {w}:
                    _DEL.setdefault(d, set()).add(w)
    return _VOCAB


def is_typo_word(w: str) -> bool:
    vocab = known_words()
    if len(w) < 4 or w in vocab or w in SHORTHAND or w in APP_WORDS:
        return False
    for x in SUFFIX:
        stem = w[: -len(x)]
        if w.endswith(x) and (stem in vocab or stem + "e" in vocab or (len(stem) > 2 and stem[-1] == stem[-2] and stem[:-1] in vocab)):
            return False
    return any(v != w and abs(len(v) - len(w)) <= 1 for d in _deletes(w) | {w} for v in _DEL.get(d, ()))


def has_typo(text: str, ref: list[dict] | None = None) -> bool:
    """A word that is not in the vocabulary, not shorthand, not a contraction, not spelled the same in the
    reference call (a name typed for a new row), and one edit away from a word that is."""
    typed = set(re.findall(r"[a-z]+", json.dumps([c.get("args") for c in ref or []]).lower()))
    words = [re.sub(r"'s$", "", w) for w in re.findall(r"[a-z']+", text.lower())]
    return any("'" not in w and w not in typed and is_typo_word(w) for w in words)


def _walk_json(v):
    if isinstance(v, str) and v[:1] in ("{", "["):
        try:
            v = json.loads(v)
        except ValueError:
            return
    if isinstance(v, dict):
        yield v
        for x in v.values():
            yield from _walk_json(x)
    elif isinstance(v, list):
        for x in v:
            yield from _walk_json(x)


def date_nodes(ref: list[dict]) -> list[dict]:
    """Date expressions in the reference calls: filter params (`when`, ...) and the JSON after a
    `field: ` line of an act's `args`."""
    out = []
    for c in ref:
        a = c.get("args")
        if not isinstance(a, dict):
            continue
        for k in DATE_KEYS:
            if k in a:
                out += list(_walk_json(a[k]))
        if isinstance(a.get("args"), str):
            for line in a["args"].splitlines():
                key, _, val = line.partition(": ")
                if key.strip() in DATE_KEYS:
                    out += list(_walk_json(val.strip()))
    return out


def date_subtypes(turn: dict, rows: dict[str, dict], today: str | None) -> set[str]:
    """Which kinds of date reading the turn asks for; empty when it involves no date."""
    text = turn["user"].lower()
    nodes = date_nodes(turn["ref"])
    isos = ISO_DATE.findall(json.dumps([c.get("args") for c in turn["ref"]]))
    if not (nodes or isos or EXPLICIT_DATE.search(text) or re.search(WEEKDAY_RE, text) or MONTH_NAMED.search(text)):
        return set()
    out = set()
    if any("weekday" in n for n in nodes) or re.search(WEEKDAY_RE, text):
        out.add("weekday")
    if any("from" in n and "to" in n for n in nodes):
        out.add("span")
    if any("name" in n and "unit" in n for n in nodes) or MONTH_NAMED.search(text):
        out.add("month_name")
    if END_OF_MONTH.search(text):
        out.add("end_of_month")
    if any(n.get("unit") == "week" and isinstance(n.get("rel"), int) and n["rel"] >= 1 and "weekday" not in n for n in nodes) \
            or WEEKS_AHEAD.search(text):
        out.add("weeks_ahead")
    if EXPLICIT_DATE.search(text):
        out.add("explicit")
    year = int(today[:4]) if today else None
    if LAST_YEAR.search(text):
        out.add("last_year")
    elif THIS_YEAR.search(text):
        out.add("this_year")
    elif isos and year and not re.search(r"\b20\d\d\b", text):
        out.add("last_year" if min(int(d[:4]) for d in isos) < year else "this_year")
    dated = {w for r in rows.values() if DATE_FIELDS & set(r) for w in tokens(str(r.get("name", "")))}
    m = ANCHOR_PHRASE.search(text)
    if (nodes or isos) and ((m and tokens(m.group(1)) & dated) or BARE_ANCHOR.search(text)):
        out.add("anchor_row")
    return out


def evidence_fn():
    """build.py's `evidence`, lifted from its source (build.py imports the whole eval stack, torch
    included; the tag needs only these few definitions)."""
    if "evidence" not in _BUILD:
        import ast
        import datetime
        want = {"ROW", "ISO", "NAME_STOP", "DAYS", "RULE_TEXT", "DATE_RULES", "name_tokens", "view", "evidence"}
        body = ast.parse(open(HERE / "build.py", encoding="utf-8").read()).body
        keep = [n for n in body if (isinstance(n, ast.FunctionDef) and n.name in want)
                or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in want for t in n.targets))]
        ns = {"re": re, "json": json, "datetime": datetime, "conventions": conventions}
        exec(compile(ast.Module(keep, []), "build.py", "exec"), ns)
        _BUILD["evidence"] = ns["evidence"]
    return _BUILD["evidence"]


def fitting_rows(text: str, rows: dict[str, dict]) -> int:
    """How many rows the message names: the trace's `saw:` list (rows sharing a name word with the
    message), read over the world's rows as a vault block would list them."""
    key = id(rows)
    if key not in _BUILD:
        _BUILD[key] = "vault: " + " · ".join(
            f'#{n} row "{str(r["name"]).replace(chr(34), "")}"' for n, r in enumerate((r for r in rows.values() if r.get("name")), 1))
    saw = evidence_fn()({}, [{"role": "user", "text": text, "preground": _BUILD[key]}], None)[0]
    if saw.endswith("none"):
        return 0
    extra = re.search(r" \+(\d+)$", saw)
    return len(re.findall(r"#\d+", saw)) + (int(extra.group(1)) if extra else 0)


HANDLE = re.compile(r"\$([A-Za-z0-9_]+)")


def ref_keys(turn: dict) -> set[str]:
    return set(HANDLE.findall(json.dumps([c.get("args") for c in turn["ref"]])))


def target_names(turn: dict, rows: dict[str, dict]) -> list[str]:
    """Names of the rows the turn acts on or reads back: gold diff rows (not created) and `$key` handles in the reference."""
    keys = {r["key"] for g in turn["gold"] if g["type"] == "diff" for r in g["diff"].get("rows", []) if r.get("change") != "created" and r.get("key")}
    return [str(rows[k]["name"]) for k in sorted(keys | ref_keys(turn)) if k in rows and rows[k].get("name")]


def whole_words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) >= 2 and w not in STOP}


def shown_keys(turn: dict) -> set[str]:
    keys = ref_keys(turn)
    for g in turn["gold"][:1]:
        keys |= set(g.get("rows") or [])
        keys |= {r["key"] for r in (g.get("diff") or {}).get("rows", []) if r.get("key")}
    return keys


def analyse(turn: dict, idx: int, rows: dict[str, dict], session: dict | None = None) -> tuple[set[str], bool]:
    """Every tag of a turn, and whether it is hard: two or more fitting rows, a long message (12+ words),
    three or more calls, or a message that shares no whole word with the row it acts on."""
    tags = base_tags(turn, idx, rows)
    ref, text = turn["ref"], turn["user"]
    tags |= {f"date:{d}" for d in date_subtypes(turn, rows, (session or {}).get("today"))}
    depth = len(ref)
    tags.add("depth:1" if depth <= 1 else "depth:2" if depth == 2 else "depth:3+")
    fits = fitting_rows(text, rows)
    if fits:
        tags.add("fit:1" if fits == 1 else "fit:2-3" if fits <= 3 else "fit:4+")
    if has_typo(text, ref):
        tags.add("typo:present")
    if any(k in (c.get("args") or {}) for c in ref for k in ("order", "limit")):
        tags.add("limit:present")
    tools = [c["tool"] for c in ref if not c.get("bad")]
    if "act" in tools and any(t in ("answer", "find", "search", "open", "compute") for t in tools[tools.index("act") + 1:]):
        tags.add("flow:act_then_read")
    if session and idx >= 3:  # rows first shown two or more turns back are compacted; the turn reaches for one
        turns = session["turns"]
        earlier = set().union(*(shown_keys(t) for t in turns[: idx - 2]))
        if ref_keys(turn) & (earlier - shown_keys(turns[idx - 2])):
            tags.add("flow:compaction")
    names = target_names(turn, rows)
    no_shared = bool(names) and not any(whole_words(text) & whole_words(n) for n in names)
    return tags, fits >= 2 or len(text.split()) >= 12 or depth >= 3 or no_shared


def derive_tags(turn: dict, idx: int, rows: dict[str, dict], session: dict | None = None) -> set[str]:
    return analyse(turn, idx, rows, session)[0]


def world_rows(path: Path, cache: dict) -> dict:
    if path not in cache:
        cache[path] = rows_of(json.load(open(path))) if path.exists() else {}
    return cache[path]


def tally(sessions: list[dict], wdir: Path, failed: set | None = None) -> dict:
    cache: dict = {}
    count, worlds, passed, hard = Counter(), defaultdict(set), Counter(), Counter()
    turns = 0
    for s in sessions:
        rows = world_rows(wdir / f"{s['world']}.json", cache)
        for i, t in enumerate(s["turns"], 1):
            turns += 1
            tags, is_hard = analyse(t, i, rows, s)
            for tag in tags:
                count[tag] += 1
                hard[tag] += is_hard
                worlds[tag].add(s["world"])
                if failed is not None and (s["id"], i) not in failed:
                    passed[tag] += 1
    return {"turns": turns, "sessions": len(sessions), "count": dict(count), "hard": dict(hard),
            "worlds": {k: len(v) for k, v in worlds.items()}, "passed": dict(passed)}


def load(pattern: str) -> list[dict]:
    out = []
    for p in sorted(glob.glob(pattern)):
        out += [json.loads(line) for line in open(p)]
    return out


def verdict(a: dict, v: dict, tag: str) -> tuple[str, str]:
    """`a` authored (train worlds), `v` val. A tag is thin when its authored share is under MIN_RATIO of
    val's, or it has under MIN_USES uses."""
    ac, vc = a["count"].get(tag, 0), v["count"].get(tag, 0)
    ash, vsh = ac / a["turns"], vc / v["turns"]
    if vc < 2:
        return "info", "too rare in val to judge"
    reasons = []
    if ash < MIN_RATIO * vsh:
        reasons.append(f"share {ash / vsh:.2f}× val")
    if ac < MIN_USES:
        reasons.append(f"{ac} uses < {MIN_USES}")
    if reasons:
        return "gap", "; ".join(reasons)
    if vsh and ash > OVER_RATIO * vsh:
        return "over", f"share {ash / vsh:.1f}× val"
    return "ok", ""


# --- traces -----------------------------------------------------------------------------------

LABELS = {"intent", "write", "read", "kind", "cond", "where", "when", "linked_to", "plan", "act", "answer",
          "compute", "find", "search", "open", "ask", "needs", "a", "choice", "decline", "retry", "previous",
          "call", "rejected", "count", "sum", "min", "max", "balance", "group", "avg"}
LABELS_SCHEMA: set[str] = set()
END_CLASS = {"rows": {"answer"}, "value": {"answer", "compute"}, "diff": {"act"}, "ask": {"ask"}, "decline": {"decline"}}
THINK = re.compile(r"<think>\s*(.*?)\s*</think>", re.S)
PLAN = re.compile(r"plan:\s*(\w+)")
TOOL = re.compile(r"<function=(\w+)>")


def schema_words(system_prompt: str) -> set[str]:
    """The tool schema's own vocabulary (kinds, fields, verbs, ops, reasons): labels, not evidence."""
    body = system_prompt.split("kinds:", 1)[-1]
    return set(re.findall(r"[a-z0-9_]+", body.lower())) | {w for x in re.findall(r"[a-z_]+", body.lower()) for w in x.split("_")}


def evidence_words(think: str, names: set[str]) -> list[str]:
    """Words in a trace that are evidence from the vault: a row-name word or a number. Kind, verb,
    op and reason labels are vocabulary, not evidence. A slot-label trace has none."""
    return [w for w in re.findall(r"[a-z0-9]+", think.lower()) if w.isdigit() or (w in names and w not in LABELS)]


def name_words(rows: dict[str, dict]) -> set[str]:
    return {w for r in rows.values() for w in tokens(str(r.get("name", "")))}


ROWS_PARAM = re.compile(r"<parameter=rows>\s*([^<]*)")
SEG_SAW = re.compile(r"saw: ([^·]*?)(?: ·|$)")
SEG = re.compile(r"(saw|last): ([^·]*)")
HASH = re.compile(r"#(\d+)")


def evidence_ids(think: str) -> tuple[set[int], set[int]]:
    """Row numbers a trace names: (`saw`: rows matching the message, `last`: rows of the latest reply)."""
    got = {k: {int(n) for n in HASH.findall(v)} for k, v in SEG.findall(think)}
    return got.get("saw", set()), got.get("last", set())


def evidence_checks(step: dict, think: str, acc: Counter) -> None:
    """Tally, for one call, whether its trace names the rows the call goes on to use. `step` = {tool, args}."""
    saw, last = evidence_ids(think)
    named = saw | last
    tool, args = step["tool"], step.get("args") or {}
    if tool in ("act", "ask"):
        acc["write_ask"] += 1
        acc["write_ask_named"] += bool(named)
    rows = args.get("rows") if isinstance(args.get("rows"), str) else None
    if tool == "act" and rows:
        ids = {int(n) for n in HASH.findall(rows)}
        if ids:
            acc["target"] += 1
            acc["target_in"] += ids <= named
    if tool == "act" and args.get("name") and not rows:
        acc["by_name"] += 1
        want = set(re.findall(r"[a-z0-9]+", str(args["name"]).lower()))
        seg = SEG_SAW.search(think)
        fits = [nm for nm in re.findall(r"#\d+ ([^#]*?)(?:, (?=#)| \+\d+$|$)", seg.group(1)) if want <= set(re.findall(r"[a-z0-9]+", nm.lower()))] if seg else []
        acc["by_name_multi"] += len(fits) >= 2   # acted on a bare name that the trace itself shows fitting 2+ rows
    if tool == "ask":
        acc["ask"] += 1
        acc["ask_multi"] += len(saw | last) >= 2


def trace_train(pattern: str, drop: set | None = None) -> dict:
    import gzip
    sys.path.insert(0, str(HERE))
    from build import derive_think, today_of
    import render
    tok = render.tokenizer()
    steps = recon = with_ev = words = 0
    lens: list[int] = []
    distinct: Counter = Counter()
    acc: Counter = Counter()
    cache: dict = {}
    for p in sorted(glob.glob(pattern)):
        for line in gzip.open(p, "rt"):
            r = json.loads(line)
            if split.is_val(r["id"]) or (drop and r["id"].removeprefix("train-") in drop):
                continue
            if not LABELS_SCHEMA:
                LABELS_SCHEMA.update(schema_words(r["messages"][0]["content"]))
                LABELS.update(LABELS_SCHEMA)
            today = today_of(r["messages"][0]["content"])
            for i, m in enumerate(r["messages"]):
                if m["role"] != "assistant":
                    continue
                th = m.get("think", "")
                steps += 1
                distinct[th] += 1
                words += len(th.split())
                lens.append(len(tok(th)["input_ids"]))
                call = {"tool": m["tool"], "args": m.get("args") or {}}
                if th == derive_think(call, "retry: previous" in th, r["messages"][:i], today):
                    recon += 1
                if any(evidence_ids(th)):
                    with_ev += 1
                evidence_checks(call, th, acc)
    lens.sort()
    pct_ = lambda a, b: a / b if b else None  # noqa: E731
    return {"steps": steps, "distinct": len(distinct), "reconstructible": recon / max(1, steps),
            "with_evidence": with_ev / max(1, steps), "mean_words": words / max(1, steps),
            "tokens_mean": sum(lens) / max(1, len(lens)), "tokens_p95": lens[int(len(lens) * .95)] if lens else None,
            "write_ask_named": pct_(acc["write_ask_named"], acc["write_ask"]),
            "target_in_evidence": pct_(acc["target_in"], acc["target"]),
            "ask_saw_multi": pct_(acc["ask_multi"], acc["ask"]),
            "name_act_saw_multi": pct_(acc["by_name_multi"], acc["by_name"]),
            "top": distinct.most_common(8)}


def trace_eval(run_log: str, val: list[dict], failed: set, wdir: Path) -> dict:
    gold = {s["id"]: s for s in val}
    cache: dict = {}
    agree = n_steps = with_ev = 0
    cls: dict[str, Counter] = defaultdict(Counter)
    tgt = {"passed": [0, 0], "failed": [0, 0]}
    for line in open(run_log):
        r = json.loads(line)
        g = gold.get(r["id"])
        if not g:
            continue
        rows = world_rows(wdir / f"{g['world']}.json", cache)
        names = name_words(rows)
        for i, (t, gt) in enumerate(zip(r["turns"], g["turns"]), 1):
            last_plan = last_tool = None
            t_in = t_tot = 0
            for st in t["steps"]:
                m = THINK.search(st["model"] or "")
                tool = TOOL.search(st["model"] or "")
                th = m.group(1) if m else ""
                pl = PLAN.search(th)
                n_steps += 1
                if pl and tool and pl.group(1) == tool.group(1):
                    agree += 1
                if any(evidence_ids(th)):
                    with_ev += 1
                if tool and tool.group(1) == "act":
                    rm = ROWS_PARAM.search(st["model"] or "")
                    if rm:
                        t_tot += 1
                        t_in += {int(n) for n in HASH.findall(rm.group(1))} <= set().union(*evidence_ids(th))
                last_plan = pl.group(1) if pl else None
                last_tool = tool.group(1) if tool else None
            want = END_CLASS.get(gt["gold"][0]["type"], set())
            ok = (r["id"], i) not in failed
            tgt["passed" if ok else "failed"][0] += t_in
            tgt["passed" if ok else "failed"][1] += t_tot
            if ok:
                c = "passed"
            elif last_plan is None:
                c = "no trace"
            elif last_plan not in want:
                c = "trace chose the wrong ending"
            elif last_tool != last_plan:
                c = "trace right, call disagreed"
            else:
                c = "trace chose the right ending, details wrong"
            for tag in derive_tags(gt, i, rows, g) | {"all"}:
                cls[tag][c] += 1
    return {"steps": n_steps, "agree": agree / max(1, n_steps), "with_evidence": with_ev / max(1, n_steps),
            "target_in_evidence": {k: (v[0] / v[1] if v[1] else None) for k, v in tgt.items()},
            "by_tag": {k: dict(v) for k, v in cls.items()}}


# --- the three scores -------------------------------------------------------------------------
# Each has a pass line and a reject line, like the AUC gate. Between them is "watch".
BANDS = {"shift": (0.05, 0.10), "coverage": (0.95, 0.90), "plan": (0.98, 0.95), "exec": (0.985, 0.95),
         "evidence": (0.80, 0.30)}


def band(kind: str, v: float | None) -> str:
    if v is None:
        return "info"
    ok, bad = BANDS[kind]
    hi = ok > bad  # higher is better
    if (v >= ok) if hi else (v <= ok):
        return "ok"
    return "gap" if ((v < bad) if hi else (v > bad)) else "over"


def scorecard(rows: list[dict], traces: dict) -> dict:
    fams: dict[str, list[dict]] = {}
    for t in rows:
        fams.setdefault(t["family"], []).append(t)
    # 1. shift: total variation distance between authored and val shares of the family's tags
    shift = {f: 0.5 * sum(abs(t["a_share"] - t["v_share"]) for t in ts) for f, ts in fams.items()}
    # 2. coverage: share of the family's val turns that sit in a tag that is not a gap
    cov = {}
    for f, ts in fams.items():
        tot = sum(t["v_share"] for t in ts)
        cov[f] = 1 - sum(t["v_share"] for t in ts if t["status"] == "gap") / tot if tot else 1.0
    # 2b. sound coverage: the same, but a red tag (covered, yet the model fails on it) does not count either
    sound = {}
    for f, ts in fams.items():
        tot = sum(t["v_share"] for t in ts)
        sound[f] = 1 - sum(t["v_share"] for t in ts if t["status"] == "gap" or t.get("red")) / tot if tot else 1.0
    thin = sorted((t["a_share"] / t["v_share"], t["tag"]) for t in rows if t["v_share"] >= 0.02)
    # 3. trace efficacy: turn accuracy = plan accuracy x execution accuracy given a right plan
    tr = None
    ev = (traces.get("eval") or {}).get("by_tag", {}).get("all")
    if ev:
        wrong = ev.get("trace chose the wrong ending", 0)
        right = ev.get("trace chose the right ending, details wrong", 0)
        ok = ev.get("passed", 0)
        n = ok + wrong + right
        tt = traces.get("train") or {}
        tr = {"turns": n, "plan": (ok + right) / n, "exec": ok / (ok + right) if ok + right else None, "turn": ok / n,
              "evidence": tt.get("write_ask_named"), "reconstructible": tt.get("reconstructible")}
    return {"shift": {"per_family": shift, "worst": max(shift.items(), key=lambda kv: kv[1])},
            "coverage": {"per_family": cov, "worst": min(cov.items(), key=lambda kv: kv[1]), "sound": sound,
                         "thinnest": list(thin[0][::-1]) if thin else None,
                         "thinnest_ratio": thin[0][0] if thin else None},
            "trace": tr}


def is_red(n: int, pass_rate: float | None) -> bool:
    return pass_rate is not None and n >= RED_MIN_TURNS and pass_rate < RED_PASS


def hardness_gate(rows: list[dict]) -> dict:
    """Every tag with MIN_USES or more authored uses must be at least HARD_MIN_SHARE hard turns.
    Axis tags (fit:*, depth:*) are exempt: their hardness is defined by the axis itself (a turn with
    one fitting row, or a one-call turn, is easy by definition), so a low hard share there is not a gap."""
    shares = sorted((t["a_hard"] / t["a"], t["tag"], t["a"]) for t in rows
                    if t["a"] >= MIN_USES and t["tag"].split(":", 1)[0] not in HARD_EXEMPT)
    low = shares[0] if shares else None
    return {"min_share": low[0] if low else None, "min_tag": low[1] if low else None, "tags": len(shares),
            "lowest": [{"tag": t, "share": sh, "uses": n} for sh, t, n in shares[:8]],
            "pass": bool(low and low[0] >= HARD_MIN_SHARE), "line": HARD_MIN_SHARE}


NARROW = 0.15  # a red tag holding more than this share of val turns is broad (outcome, length, depth, follow-up)


def seed_check(seed: dict | None, rows: list[dict]) -> dict | None:
    """Of the failed turns in the red-list file, how many sit in a tag this report marks red. `narrow`
    counts only red tags holding at most NARROW of val's turns: a broad red tag ("mid-length message")
    catches most failures by size alone."""
    if not seed:
        return None
    red = {t["tag"] for t in rows if t["red"]}
    narrow = {t["tag"] for t in rows if t["red"] and t["v_share"] <= NARROW}
    failed = seed["failed_turns"]
    hit = sum(bool(set(f) & red) for f in failed.values())
    fine = sum(bool(set(f) & narrow) for f in failed.values())
    return {"failed": len(failed), "in_red": hit, "share": hit / max(1, len(failed)), "narrow_max_val_share": NARROW,
            "narrow_red_tags": len(narrow), "in_red_narrow": fine, "share_narrow": fine / max(1, len(failed)),
            "source": seed.get("provenance", "")[:200]}


def snapshot(a: argparse.Namespace) -> dict:
    authored = split.drop_val(load(a.gold))  # train worlds only
    drop = set(json.load(open(a.drop))["drop"]) if a.drop else set()
    n_all = len(authored)
    authored = [s for s in authored if s["id"] not in drop]
    val = load(str(VAL))
    failed = run = None
    if a.run:
        run = json.load(open(a.run))
        failed = {(f["id"], f["turn"]) for f in run["failed"]}
        if not {f[0] for f in failed} <= {s["id"] for s in val}:
            raise SystemExit("--run is not a val run: it names sessions that are not in eval/sets/val.jsonl")
    seed = json.load(open(a.seed_red)) if a.seed_red else None
    A = tally(authored, HERE / "worlds")
    V = tally(val, HERE / "worlds", failed)
    tags = sorted(set(A["count"]) | set(V["count"]))
    rows = []
    for t in tags:
        st, why = verdict(A, V, t)
        rn = V["count"].get(t, 0)
        rp = V["passed"].get(t, 0) / rn if failed is not None and rn else None
        sd = (seed or {}).get("tags", {}).get(t)
        src = [k for k, hit in (("val run", is_red(rn, rp)), ("seed", bool(sd) and is_red(sd["n"], sd["pass"]))) if hit]
        rows.append({"tag": t, "family": t.split(":")[0], "a": A["count"].get(t, 0), "v": rn,
                     "a_share": A["count"].get(t, 0) / A["turns"], "v_share": rn / V["turns"],
                     "a_hard": A["hard"].get(t, 0), "v_hard": V["hard"].get(t, 0),
                     "worlds": A["worlds"].get(t, 0), "run_n": rn, "run_pass": rp,
                     "seed_n": sd["n"] if sd else None, "seed_pass": sd["pass"] if sd else None,
                     "status": st, "why": why,
                     "red": st in ("ok", "over") and bool(src), "red_src": src if st in ("ok", "over") else []})
    gate = json.load(open(a.gate)) if a.gate else {}
    traces = {"train": trace_train(a.records, drop) if a.records else None,
              "eval": trace_eval(a.run_log, val, failed, HERE / "worlds") if a.run_log and failed is not None else None}
    lens = lambda S: Counter(min(len(s["turns"]), 7) for s in S)  # noqa: E731
    auc = gate.get("auc_authored_vs_val")
    red = {t["tag"] for t in rows if t["red"]}
    return {"label": a.label, "authored": {"sessions": A["sessions"], "turns": A["turns"]},
            "val": {"sessions": V["sessions"], "turns": V["turns"]},
            "auc": {k: gate.get(k) for k in ("auc_authored_vs_val", "auc_baseline_val_halves", "auc_raw_authored_vs_val")},
            "gates": {"auc": {"value": auc, "line": AUC_PASS_LINE, "pass": auc is not None and auc <= AUC_PASS_LINE},
                      "hardness": hardness_gate(rows)},
            "red": {"tags": sorted(red), "count": len(red), "rule": f"covered and pass < {RED_PASS} on >= {RED_MIN_TURNS} turns",
                    "seed_check": seed_check(seed, rows)},
            "run": {k: run.get(k) for k in ("session_pass", "sessions", "turn_pass", "turns", "precision", "recall")} if run else None,
            "session_len": {"authored": dict(lens(authored)), "val": dict(lens(val))},
            "rules": {"min_uses": MIN_USES, "min_ratio": MIN_RATIO, "over_ratio": OVER_RATIO, "red_pass": RED_PASS,
                      "red_min_turns": RED_MIN_TURNS, "hard_min_share": HARD_MIN_SHARE, "auc_pass": AUC_PASS_LINE},
            "selection": {"dropped": len(drop), "of": n_all} if drop else None,
            "tags": rows, "traces": traces, "score": scorecard(rows, traces)}


# --- rendering --------------------------------------------------------------------------------

CSS = """
:root{--bg:#F4F6F5;--surface:#FFFFFF;--ink:#172024;--muted:#56636A;--faint:#8A969C;--rule:#D9DFDD;
--accent:#2F5D8C;--ochre:#B07426;--good:#2E7D4F;--good-t:#DDEFE3;--warn:#9A6A00;--warn-t:#F6EBCB;
--bad:#B23A32;--bad-t:#F6DEDB;--info:#56636A;--info-t:#E6EAE9;
--sans:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#111618;--surface:#182024;
--ink:#E4E9EA;--muted:#9AA7AD;--faint:#6F7C82;--rule:#2B363B;--accent:#7FA9D8;--ochre:#D9A45B;--good:#6CC191;
--good-t:#1C3326;--warn:#E0B54E;--warn-t:#3A3018;--bad:#EE8078;--bad-t:#3E2220;--info:#9AA7AD;--info-t:#232C30}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#111618;--surface:#182024;--ink:#E4E9EA;--muted:#9AA7AD;--faint:#6F7C82;
--rule:#2B363B;--accent:#7FA9D8;--ochre:#D9A45B;--good:#6CC191;--good-t:#1C3326;--warn:#E0B54E;--warn-t:#3A3018;
--bad:#EE8078;--bad-t:#3E2220;--info:#9AA7AD;--info-t:#232C30}
body{background:var(--bg);color:var(--ink);font:15px/1.55 var(--sans);padding-inline:20px;padding-block:36px 64px}
.wrap{max-width:1040px;margin:0 auto;display:flex;flex-direction:column;gap:44px}
h1,h2,h3{margin:0;line-height:1.2;text-wrap:balance}h1{font-size:2rem}h2{font-size:1.25rem}
p{margin:0;max-width:72ch}.muted{color:var(--muted)}
.eyebrow{font:500 .72rem/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
section{display:flex;flex-direction:column;gap:14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.tile .v{font:500 1.6rem/1.1 var(--mono);font-variant-numeric:tabular-nums}.tile .k{font-size:.85rem;color:var(--muted)}
.tile .dl{font:.75rem var(--mono);color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:18px;font-size:.85rem;color:var(--muted)}
.sw{display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:-2px;margin-right:6px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.86rem;min-width:760px}
th{text-align:left;font:500 .68rem/1.3 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:8px;border-bottom:1px solid var(--rule)}
td{padding:7px 8px;border-bottom:1px solid var(--rule);vertical-align:middle}
td.n{font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
td.tag{font:500 .8rem var(--mono);white-space:nowrap}
tr.fam td{background:transparent;padding-top:18px;font-weight:600;border-bottom:1px solid var(--ink)}
.bars{display:flex;flex-direction:column;gap:3px;width:240px}
.bar{height:8px;border-radius:0 4px 4px 0;min-width:2px}.bar.a{background:var(--accent)}.bar.v{background:var(--ochre)}
.pill{display:inline-flex;align-items:center;gap:6px;font:500 .7rem/1 var(--mono);padding:4px 8px;border-radius:999px;white-space:nowrap}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.gap{color:var(--bad);background:var(--bad-t)}.ok{color:var(--good);background:var(--good-t)}
.over{color:var(--warn);background:var(--warn-t)}.info{color:var(--info);background:var(--info-t)}
.why{font-size:.78rem;color:var(--muted)}
.pass{font-family:var(--mono);font-variant-numeric:tabular-nums}
.pass.lo{color:var(--bad)}.pass.mid{color:var(--warn)}.pass.hi{color:var(--good)}
.delta{font:.72rem var(--mono);color:var(--muted)}
.filters{display:flex;gap:8px;flex-wrap:wrap}
.filters button{font:500 .78rem var(--mono);padding:6px 12px;border-radius:999px;border:1px solid var(--rule);background:var(--surface);color:var(--ink);cursor:pointer}
.filters button[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.filters button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
footer{font-size:.8rem;color:var(--faint);border-top:1px solid var(--rule);padding-top:14px}
"""


def pct(x: float) -> str:
    return f"{100 * x:.1f}%"


TRACE_TAGS = ["all", "outcome:ask", "outcome:value", "outcome:diff", "outcome:rows", "outcome:decline",
              "convention:balance", "convention:bare_weekday", "shape:multi_write", "shape:3+_calls",
              "distractor:present", "context:correction"]
TRACE_CLASSES = [("trace chose the wrong ending", "bad"), ("trace chose the right ending, details wrong", "warn"),
                 ("trace right, call disagreed", "info"), ("no trace", "info")]


def render_traces(tr: dict | None) -> str:
    if not tr or not (tr.get("train") or tr.get("eval")):
        return ""
    e = html.escape
    out = ['<section><div class="eyebrow">Reasoning traces</div>',
           "<h2>Does the trace carry anything the call does not?</h2>"]
    t = tr.get("train")
    if t:
        f = lambda x: "–" if x is None else "%.1f%%" % (100 * x)  # noqa: E731
        tiles = [(f(t["reconstructible"]), "of training traces rebuild exactly from the context and the call (must be 100%)"),
                 (f(t.get("write_ask_named")), "of writes and asks name a row from the context in their trace"),
                 (f(t.get("target_in_evidence")), "of writes by row number act on a row their trace named"),
                 (f(t.get("ask_saw_multi")), "of asks come after the trace saw two or more fitting rows"),
                 (f(t.get("name_act_saw_multi")), "of writes by bare name go ahead although two or more rows in the trace fit that name (the runtime's ambiguity replies)"),
                 ("%d" % (t.get("tokens_p95") or 0), "tokens in a trace at the 95th percentile (mean %.0f)" % (t.get("tokens_mean") or 0)),
                 (f'{t["distinct"]:,}', f'distinct trace strings over {t["steps"]:,} steps')]
        out.append('<div class="tiles">' + "".join(
            f'<div class="tile"><div class="v">{v}</div><div class="k">{k}</div></div>' for v, k in tiles) + "</div>")
        out.append('<p class="muted">A trace that is rebuilt from its own call adds no information: the model can write it '
                   "only after it has already decided. A trace of evidence, then rule, then decision is different: everything in it is read off "
                   "the message and the rows on screen, so the model has to look before it chooses.</p>")
        out.append('<div class="scroll"><table style="min-width:0"><thead><tr><th>Most common training traces</th>'
                   '<th style="text-align:right">Steps</th></tr></thead><tbody>' + "".join(
                       f'<tr><td class="tag">{e(k)}</td><td class="n">{v:,}</td></tr>' for k, v in t["top"]) + "</tbody></table></div>")
    ev = tr.get("eval")
    if ev:
        out.append('<div class="tiles">' + "".join(
            f'<div class="tile"><div class="v">{v}</div><div class="k">{k}</div></div>' for v, k in [
                ("%.1f%%" % (100 * ev["agree"]), "of the model's steps: the plan in its trace matches the call it made"),
                ("%.1f%%" % (100 * ev["with_evidence"]), "of the model's traces contain evidence")]) + "</div>")
        out.append('<p class="muted">Every trace the model wrote matched the call it made, so the trace never '
                   "disagreed with a decision. It restated it.</p>" if ev["agree"] > .99 else "")
        out.append('<p class="muted">Each failed val turn, split by what the model\'s last trace said. '
                   "<strong>Wrong ending</strong>: the trace already chose the wrong kind of ending (acted when it should "
                   "ask, answered when it should write); the decision failed before the call. <strong>Details wrong</strong>: "
                   "the trace chose right and the rows, values or fields were wrong, which a slot trace does not reason about.</p>")
        head = "".join(f"<th style='text-align:right'>{e(c)}</th>" for c, _ in TRACE_CLASSES)
        body = []
        for tag in TRACE_TAGS:
            c = ev["by_tag"].get(tag)
            if not c:
                continue
            fails = sum(v for k, v in c.items() if k != "passed")
            if not fails:
                continue
            cells = "".join(
                f'<td class="n"><span class="pass {"lo" if cls == "bad" else "mid" if cls == "warn" else ""}">'
                f'{100 * c.get(k, 0) / fails:.0f}%</span><br><span class="muted">{c.get(k, 0)}</span></td>'
                for k, cls in TRACE_CLASSES)
            body.append(f'<tr><td class="tag">{e(tag.split(":", 1)[-1] if tag != "all" else "all turns")}</td>'
                        f'<td class="n">{fails}</td>{cells}</tr>')
        out.append('<div class="scroll"><table><thead><tr><th>Tag</th><th style="text-align:right">Failed turns</th>'
                   f"{head}</tr></thead><tbody>{''.join(body)}</tbody></table></div>")
    out.append("</section>")
    return "\n".join(out)


def render_scorecard(sc: dict | None, prev: dict | None) -> str:
    if not sc:
        return ""
    ps = (prev or {}).get("score") or {}
    lab = {"ok": "pass", "over": "watch", "gap": "fail", "info": "n/a"}

    def pill(b):
        return f'<span class="pill {b}">{lab[b]}</span>'

    def dl(cur, old, digits=3):
        return "" if old is None or cur is None else f' <span class="delta">was {old:.{digits}f}</span>'

    def famtable(per, old, kind):
        rows = "".join(
            f'<tr><td class="tag">{html.escape(f)}</td><td class="n">{v:.3f}{dl(v, (old or {}).get(f))}</td>'
            f'<td>{pill(band(kind, v))}</td></tr>' for f, v in sorted(per.items(), key=lambda kv: kv[1], reverse=(kind == "shift")))
        return f'<table style="min-width:0"><tbody>{rows}</tbody></table>'

    def card(title, sub, head, b, gate, inner):
        return (f'<div class="tile" style="gap:10px"><div class="eyebrow">{title}</div>'
                f'<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><div class="v">{head}</div>{pill(b)}</div>'
                f'<div class="k">{sub}</div><div class="why">{gate}</div>{inner}</div>')

    sh, cv, tr = sc["shift"], sc["coverage"], sc["trace"]
    wf, wv = sh["worst"]
    c1 = card("1 · Variance, authored vs val", f"worst family: {html.escape(wf)}, total variation distance", f"{wv:.3f}",
              band("shift", wv), "Fraction of authored turns in the wrong cell. Pass at 0.05 or below, reject above 0.10.",
              famtable(sh["per_family"], (ps.get("shift") or {}).get("per_family"), "shift"))
    wf, wv = cv["worst"]
    th = cv.get("thinnest")
    c2 = card("2 · Coverage of val", f"worst family: {html.escape(wf)}, share of val turns in a covered tag", f"{wv:.3f}",
              band("coverage", wv), "Pass at 0.95 or above, reject below 0.90."
              + (f" Thinnest cell with 2%+ of val: <code>{html.escape(th[0])}</code> at {cv['thinnest_ratio']:.2f}× val." if th else ""),
              famtable(cv["per_family"], (ps.get("coverage") or {}).get("per_family"), "coverage"))
    if tr:
        ptr = ps.get("trace") or {}
        rows = [("plan accuracy", tr["plan"], "plan", "trace chose the right ending"),
                ("execution given right plan", tr["exec"], "exec", "call details correct"),
                ("evidence before a write or ask", tr["evidence"], "evidence", "training trace names a row from the context"),
                ("turn accuracy", tr["turn"], None, "plan × execution; 0.965 gives 90% of sessions")]
        inner = "".join(
            f'<tr><td>{n}<div class="why">{w}</div></td><td class="n">{pct(v) if v is not None else "–"}{dl(v, ptr.get(k or "turn"), 3) if v is not None else ""}</td>'
            f'<td>{pill(band(k, v)) if k else ""}</td></tr>' for n, v, k, w in rows)
        # the lever is whichever factor has more room to gain
        lever = "execution" if (1 - (tr["exec"] or 1)) > (1 - tr["plan"]) else "plan"
        c3 = card("3 · Trace efficacy", f"{tr['turns']:,} val turns; the bigger loss is {lever}", pct(tr["turn"]),
                  "gap" if tr["turn"] < .9 else "ok" if tr["turn"] >= .965 else "over",
                  "Plan ≥ 98% and execution ≥ 98.5% multiply to the 96.5% turn accuracy that 90% of sessions needs.",
                  f'<table style="min-width:0"><tbody>{inner}</tbody></table>')
    else:
        c3 = card("3 · Trace efficacy", "needs --run and --run-log", "–", "info", "", "")
    return (f'<section><div class="eyebrow">Three scores</div><div class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start">'
            f'{c1}{c2}{c3}</div></section>')


def render(snap: dict, prev: dict | None) -> str:
    e = html.escape
    tags = snap["tags"]
    ptags = {t["tag"]: t for t in (prev or {}).get("tags", [])}
    n = Counter(t["status"] for t in tags)
    judged = [t for t in tags if t["status"] != "info"]
    pn = Counter(t["status"] for t in (prev or {}).get("tags", []))
    gaps = [t for t in tags if t["status"] == "gap"]
    gp = [t for t in gaps if t["run_pass"] is not None]
    okp = [t for t in tags if t["status"] == "ok" and t["run_pass"] is not None]
    avg = lambda L: sum(t["run_pass"] * t["run_n"] for t in L) / max(1, sum(t["run_n"] for t in L))  # noqa: E731
    run = snap.get("run") or {}
    auc = snap["auc"]

    def tile(v, k, dl=""):
        return f'<div class="tile"><div class="v">{v}</div><div class="k">{k}</div>{f"<div class=dl>{dl}</div>" if dl else ""}</div>'

    def d_(key):
        return f"was {pn.get(key, 0)}" if prev else ""

    tiles = [tile(n["gap"], "tags below the gate", d_("gap")), tile(n["ok"], "tags passing", d_("ok")),
             tile(n["over"], "tags over-supplied (&gt;3× val)", d_("over"))]
    gates = snap["gates"]
    red_n = snap["red"]["count"]
    tiles.append(tile(red_n, f"red tags: covered, pass under {pct(snap['rules']['red_pass'])} on {snap['rules']['red_min_turns']}+ turns"))
    if run:
        tiles.append(tile(pct(run["session_pass"] / run["sessions"]), "val session pass"))
        tiles.append(tile(pct(run["turn_pass"] / run["turns"]), "val turn pass"))
    if gates["auc"]["value"] is not None:
        tiles.append(tile(f'{gates["auc"]["value"]:.3f}', f'AUC authored vs val, names masked (pass at {gates["auc"]["line"]:.2f} or below): '
                          f'{"pass" if gates["auc"]["pass"] else "fail"}'))
    hg = gates["hardness"]
    if hg["min_share"] is not None:
        tiles.append(tile(pct(hg["min_share"]), f'lowest hard share, <code>{e(hg["min_tag"])}</code> (pass at {pct(hg["line"])} or above): '
                          f'{"pass" if hg["pass"] else "fail"}'))
    sc = snap["red"].get("seed_check")

    check = ""
    if sc:
        check = (f'<p class="muted">Red-list check: {sc["in_red"]} of {sc["failed"]} failed turns in the red-list file ({pct(sc["share"])}) '
                 f'sit in a tag this report marks red; {sc["in_red_narrow"]} ({pct(sc["share_narrow"])}) when only red tags of at most {pct(sc["narrow_max_val_share"])} of val turns count.</p>')
    if gp and okp:
        check += (f'<p class="muted">Gate check: val turns in <strong>gap</strong> tags pass {pct(avg(gp))}, '
                  f'val turns in <strong>passing</strong> tags pass {pct(avg(okp))}. A gate that works puts the failures '
                  f'on the gap side; a passing tag with a low pass rate is <strong>red</strong>.</p>')

    order = {"gap": 0, "over": 1, "ok": 2, "info": 3}
    body = []
    for fam in sorted({t["family"] for t in tags}, key=lambda f: list(FAMILIES).index(f) if f in FAMILIES else 99):
        ft = sorted((t for t in tags if t["family"] == fam), key=lambda t: (order[t["status"]], -t["v_share"]))
        scale = max(max(t["a_share"], t["v_share"]) for t in ft) or 1  # one scale per family
        body.append(f'<tr class="fam" data-fam><td colspan="8">{e(FAMILIES.get(fam, fam))}</td></tr>')
        for t in ft:
            hp = t["run_pass"] if t["run_pass"] is not None else t["seed_pass"]
            hn = t["run_n"] if t["run_pass"] is not None else t["seed_n"]
            cls = "" if hp is None else "lo" if hp < .6 else "mid" if hp < .8 else "hi"
            red = ' <span class="pill gap">red</span>' if t["red"] else ""
            p = ptags.get(t["tag"])
            delta = ""
            if p:
                dd = t["a"] - p["a"]
                delta = f'<div class="delta">{"+" if dd >= 0 else ""}{dd} uses · was {p["status"]}</div>'
            body.append(
                f'<tr data-status="{t["status"]}" data-red="{int(t["red"])}"><td class="tag">{e(t["tag"].split(":", 1)[-1])}</td>'
                f'<td><div class="bars" title="authored {t["a"]} turns ({pct(t["a_share"])}), val {t["v"]} turns ({pct(t["v_share"])})">'
                f'<div class="bar a" style="width:{100 * t["a_share"] / scale:.1f}%"></div>'
                f'<div class="bar v" style="width:{100 * t["v_share"] / scale:.1f}%"></div></div></td>'
                f'<td class="n">{pct(t["a_share"])}<br><span class="muted">{t["a"]}</span></td>'
                f'<td class="n">{pct(t["v_share"])}<br><span class="muted">{t["v"]}</span></td>'
                f'<td class="n">{pct(t["a_hard"] / t["a"]) if t["a"] else "–"}<br><span class="muted">val {pct(t["v_hard"] / t["v"]) if t["v"] else "–"}</span></td>'
                f'<td><span class="pill {t["status"]}">{t["status"]}</span>{red}<div class="why">{e(t["why"])}</div>{delta}</td>'
                f'<td class="n"><span class="pass {cls}">{"–" if hp is None else pct(hp)}</span><br><span class="muted">{"" if hn is None else hn} {"val run" if t["run_pass"] is not None else "seed" if hp is not None else ""}</span></td></tr>')

    sl = snap["session_len"]
    at, dt = sum(sl["authored"].values()), sum(sl["val"].values())
    slen = "".join(
        f'<tr><td class="tag">{k if k != "7" else "7+"}</td><td class="n">{pct(sl["authored"].get(k, 0) / at)}</td>'
        f'<td class="n">{pct(sl["val"].get(k, 0) / dt)}</td></tr>'
        for k in sorted(set(sl["authored"]) | set(sl["val"]), key=int))
    redrows = sorted((t for t in tags if t["red"]), key=lambda t: (t["run_pass"] if t["run_pass"] is not None else t["seed_pass"]))
    redtab = "".join(
        f'<tr><td class="tag">{e(t["tag"])}</td><td class="n">{t["a"]}</td><td class="n">{pct(t["v_share"])}</td>'
        f'<td class="n"><span class="pass lo">{pct(t["run_pass"] if t["run_pass"] is not None else t["seed_pass"])}</span></td>'
        f'<td class="n">{t["run_n"] if t["run_pass"] is not None else t["seed_n"]}</td><td>{e(" + ".join(t["red_src"]))}</td></tr>' for t in redrows)
    hardtab = "".join(f'<tr><td class="tag">{e(x["tag"])}</td><td class="n">{x["uses"]}</td><td class="n">{pct(x["share"])}</td></tr>'
                      for x in hg["lowest"])
    gates_html = f'''<section><div class="eyebrow">Gates</div>
  <h2>Red tags: covered, yet the model fails them</h2>
  <p class="muted">{snap["red"]["rule"]}. Sources: the val run (--run) and the red-list file (--seed-red).</p>
  <div class="scroll"><table style="min-width:0"><thead><tr><th>Tag</th><th style="text-align:right">Authored uses</th>
  <th style="text-align:right">Val share</th><th style="text-align:right">Model pass</th><th style="text-align:right">Turns</th><th>Source</th></tr></thead>
  <tbody>{redtab or '<tr><td colspan="6" class="muted">none</td></tr>'}</tbody></table></div>
  <h2>Hardness share, lowest tags</h2>
  <p class="muted">Share of a tag's authored turns that are hard; every tag with {snap["rules"]["min_uses"]}+ uses must reach {pct(snap["rules"]["hard_min_share"])}, except the axis tags fit:* and depth:*, whose hardness is defined by the axis itself (fit:1 is easy by definition) and so are left out of the gate.</p>
  <div class="scroll"><table style="min-width:0"><thead><tr><th>Tag</th><th style="text-align:right">Uses</th><th style="text-align:right">Hard share</th></tr></thead>
  <tbody>{hardtab}</tbody></table></div></section>'''
    r = snap["rules"]
    sd = snap.get("selection")
    sel = f", after leaving out {sd['dropped']} of {sd['of']:,} sessions to match val's mix (select.py)" if sd else ""
    return f"""<title>Corpus Gap Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>{CSS}</style>
<div class="wrap">
<header style="display:flex;flex-direction:column;gap:12px">
  <div class="eyebrow">snapshot {e(snap["label"])}{f" · compared with {e(prev['label'])}" if prev else ""}</div>
  <h1>Where the authored corpus differs from the task</h1>
  <p class="muted">{snap["authored"]["sessions"]:,} authored sessions ({snap["authored"]["turns"]:,} turns) against val
  ({snap["val"]["sessions"]} sessions, {snap["val"]["turns"]} turns){sel}. Every turn on both sides is tagged by the same code.
  A tag is a <strong>gap</strong> when its authored share is under {r["min_ratio"]}× its val share, or it has fewer than
  {r["min_uses"]} uses. A covered tag is <strong>red</strong> when the model passes under {pct(r["red_pass"])} of its turns
  ({r["red_min_turns"]}+ turns; from a val run and/or the red-list file). Hard turns: two or more fitting rows, 12+ words, three or
  more calls, or no word shared with the row acted on.</p>
  <div class="tiles">{"".join(tiles)}</div>
  {check}
</header>
{render_scorecard(snap.get("score"), prev)}
{gates_html}
<section>
  <div class="eyebrow">Tags</div>
  <div class="legend"><span><span class="sw" style="background:var(--accent)"></span>authored share of turns</span>
  <span><span class="sw" style="background:var(--ochre)"></span>val share of turns</span></div>
  <div class="filters" role="group" aria-label="Filter by status">
    <button id="f-all" data-f="all" aria-pressed="true">all</button><button id="f-gap" data-f="gap" aria-pressed="false">gaps</button>
    <button id="f-red" data-f="red" aria-pressed="false">red</button><button id="f-over" data-f="over" aria-pressed="false">over-supplied</button><button id="f-ok" data-f="ok" aria-pressed="false">ok</button></div>
  <div class="scroll"><table id="t">
    <thead><tr><th>Tag</th><th>Share, scaled per group</th><th style="text-align:right">Authored</th><th style="text-align:right">Val</th>
    <th style="text-align:right">Hard</th><th>Gate</th><th style="text-align:right">Model pass</th></tr></thead>
    <tbody>{"".join(body)}</tbody></table></div>
</section>
{render_traces(snap.get("traces"))}
<section>
  <div class="eyebrow">Session length</div>
  <div class="scroll"><table style="min-width:0;max-width:420px"><thead><tr><th>Turns</th><th style="text-align:right">Authored</th>
  <th style="text-align:right">Val</th></tr></thead><tbody>{slen}</tbody></table></div>
</section>
<footer>Generated by authored/gapreport.py. Tags: eval/conventions.py rules plus structure read from gold and reference
calls; difficulty tags (date, depth, fit, typo, limit, flow) from the turn and its world alone. Near-miss rows: a changed
row shares a name word with another row in its world. Not yet measured: contrast pairs, per-slice AUC.</footer>
</div>
<script>
const bs=document.querySelectorAll('.filters button');
bs.forEach(b=>b.addEventListener('click',()=>{{
  bs.forEach(x=>x.setAttribute('aria-pressed',x===b));
  const f=b.dataset.f;
  document.querySelectorAll('#t tbody tr[data-status]').forEach(r=>r.hidden=!(f==='all'||r.dataset.status===f||(f==='red'&&r.dataset.red==='1')));
  document.querySelectorAll('#t tbody tr.fam').forEach(h=>{{let n=h.nextElementSibling,any=false;
    while(n&&!n.classList.contains('fam')){{if(!n.hidden)any=true;n=n.nextElementSibling}}h.hidden=!any}});
}}));
</script>
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", required=True, help="glob of authored *.gold.jsonl")
    ap.add_argument("--gate", help="gate.py --json output")
    ap.add_argument("--run", help="eval report.json of a run on val (eval/run.py --set sets/val.jsonl, then score.py)")
    ap.add_argument("--seed-red", help="authored/seed_red.json: a red list (per-tag pass, failed turns) from a past run")
    ap.add_argument("--records", help="glob of built training records *.jsonl.gz (for the trace section)")
    ap.add_argument("--run-log", help="run.jsonl of the val run (the model's own traces)")
    ap.add_argument("--label", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--drop", help="selected.json from select.py: sessions left out of training")
    ap.add_argument("--prev", help="an earlier snapshot json to compare with")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    snap = snapshot(a)
    prev = json.load(open(a.prev)) if a.prev else None
    (out / f"{a.label}.json").write_text(json.dumps(snap, indent=1))
    (out / f"{a.label}.html").write_text(render(snap, prev))
    n = Counter(t["status"] for t in snap["tags"])
    print(f"{a.label}: {len(snap['tags'])} tags, gap {n['gap']}, over {n['over']}, ok {n['ok']}, info {n['info']}")
    for t in sorted(snap["tags"], key=lambda t: t["a_share"] / t["v_share"] if t["v_share"] else 9):
        if t["status"] == "gap":
            hp = "–" if t["run_pass"] is None else f"{100 * t['run_pass']:.0f}%"
            print(f"  GAP {t['tag']:28s} a {pct(t['a_share']):>6s} v {pct(t['v_share']):>6s} run {hp:>4s}  {t['why']}")
    red = [t for t in snap["tags"] if t["red"]]
    print(f"red tags: {len(red)}")
    for t in sorted(red, key=lambda t: t["run_pass"] if t["run_pass"] is not None else t["seed_pass"]):
        hp, hn = (t["run_pass"], t["run_n"]) if t["run_pass"] is not None else (t["seed_pass"], t["seed_n"])
        print(f"  RED {t['tag']:28s} pass {100 * hp:.0f}% on {hn} ({'+'.join(t['red_src'])}); authored {t['a']}, val {t['v']}")
    g = snap["gates"]
    print(f"auc {g['auc']['value']} (pass {g['auc']['pass']}); hardness min {g['hardness']['min_share']} at {g['hardness']['min_tag']} (pass {g['hardness']['pass']})")
    if snap["red"]["seed_check"]:
        print("seed check:", json.dumps(snap["red"]["seed_check"]))


if __name__ == "__main__":
    main()
