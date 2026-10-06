"""The decision drills (phase 7, slice M2, #1044): minimal pairs of one- or two-turn sessions, each isolating one decision.

    python3 authored/gen/drills.py gen --worlds T01,T02 --out OUT --per-world 200 --seed 7 [--cells C2,REF] [--jobs 4]
                                       [--templates group,REF.nick] [--shares REF=0.06,C3=0.3] [--split train]
                                       [--avoid OUT1,OUT2] [--weights train-coverage.json] [--no-build]
    python3 authored/gen/drills.py measure --run RUN.jsonl --gold GOLD.jsonl [--cells OUT/cells.json] [--md FILE]
    python3 authored/gen/drills.py cells            # the cell universe with the count of templates and phrasings each has

Why. On val the model fails with the answer in view, and the fail rate climbs with the constraints a call carries
(k<=1 13%, k=2 22%, k=3 37%, k=4 67%); the natural sessions hold few k>=3 turns, and the model memorises instances
instead of rules. A drill is a session of one or two turns that isolates one decision. Every drill has a sibling that is
the same phrasing with only the deciding feature flipped (the flipped fragment, or the flipped first turn of a two-turn
drill), the two gold outcomes differ, so the pair is learnable only as the rule. Thousands per world, mixed with the
natural sessions.

`gen` writes, under OUT:
    sessions/<W>.py            an empty stub (build.py always loads <W>.py first)
    sessions/<W>_d01.py ..     the sessions in the gold.py format, ids <W>-D0001a / <W>-D0001b, about 100 per file
    <W>.jsonl.gz, <W>.report.json, <W>.gold.jsonl   build.py's output on those sessions (`--split` as given)
    <W>.kept.gold.jsonl        the gold of the sessions that verified AND whose pair verified (what the corpus uses)
    <W>.kept.jsonl.gz          the training records of those sessions (build.py's records minus an orphaned sibling and the needs-m1 items)
    kept.gold.jsonl            the kept gold of every world of the run (`measure` reads it by default)
    cells.json                 item id -> {cell, pair, side, feature, family, world, shape, k, needs_m1, gap, kept, reason}
    report.md                  per cell: generated, verified, dropped by reason; pair consistency; the hardness.py table
                               of the kept items; the train-coverage share; the disagreements with the runtime
    disagreements.json         every dropped item whose reference or gold the runtime disagreed with, message and reference
    messages.json              every message of the run (`--avoid` reads it back so two runs never share one)

The gold is computed from the world JSON by this file's own evaluator (`Vault`: the selector semantics of SPEC section
3 and 14.1, status words by D-1044-7, the container readout rule, dates from the world's `today` by the conventions of
SPEC 14.1), never from the runtime. build.py then replays the reference calls through the runtime and scores the gold:
a mismatch drops the item and is counted by reason; a pair keeps only when both siblings verify. A gold that build.py's
`--gold-from-ref` conventions rewrote (eval/regen.py) is a disagreement between this evaluator and the runtime and counts
as a drop (`convention:<name>`), never as a pass: the gold is never bent to the runtime's answer. A widening convention
(an alternative accept, `superlative`) keeps the item and its widened gold.

Messages: lower-case phone typing on the frame (contractions, a dropped word, a rare typo in a filler word), the row
named verbatim about half the time and by partial name / first name / nickname / description otherwise; a pronoun, a
stop word or an honorific is never the name of a row. No two pairs of a world share a message (a pair's two siblings share
the phrasing and, in a two-turn drill, one of the two turns); no message of six words or more equals an authored message of
the world (authored/sessions/<W>*.py), a message of another world's drill (a world is generated against the long messages of
the worlds before it in `--worlds`, so a quota is filled by another pair, not dropped) or one of an earlier run (`--avoid`).
Shorter messages ("text sam") may repeat across worlds; inside a world nothing repeats. The report checks all of it.

The runtime ends a by-name or by-`#n` write in its own ask when the message words fit several rows ("tick off books" with a
"Book eye test" in the vault: SPEC 3 item 3c, act.rs `ambiguous_pick`). `would_ask` ports that rule, and a pair with such a write
is left out of every cell but AMB (the pilots: it flags the two items the runtime did end in an ask and none of 2,199 accepted calls).
A `$key` the pre-grounding block of the first message does not show cannot be resolved ("ref names $x before the runtime showed it");
`block_keys` ports search.rs `preground` (tokens, exact names, the cap of eight, no kind past half, a shared name cut to six), and a
pair whose first turn names a row the block leaves out is not generated (over 1,380 built sessions it flags the one that failed that way
and none of the others). Containers are in the system prompt and always resolve.

The cells (a cell is the decision, not a production): C2 and C3 (reads, counts, sums, superlatives, grouped values and bounded
writes with exactly two or three constraints by authored/hardness.py), REF (a referent with a decoy in view: twins by role,
group, nickname, date, container, state, focus, or an ask that offered both), CM (create versus modify), TWO (two writes, or a
write then a read), DATES (two dates in one message, every shape), CONT (containers and subtasks), FOLLOW (turn 2 leaning on
turn 1: an ordinal, "the other", "what else" (exclude), "same for" (another person), "both", a narrowing of the rows shown
(within), and writes on `@prev`), JUDGE (the judgements the model keeps) and AMB (an ambiguous write: the reference is the
act alone, the gold the ask over the candidates the runtime composes (SPEC 4.8); kept like any cell, its pairs are the only ones
exempt from the would-ask filter). `--templates` runs one template family on its own (`cells` lists the names).

What the drills keep of the natural sessions (round 2; `authored/gen/drill_dist.py` measures each on any record file, drill or natural): the
operator of a text condition is drawn per field in the natural mix (`TEXT_MIX`: `=` the whole value, `contains` the whole value, `contains` a
word of it), not fixed per field; a trailing role clause of a message is a filter only where the first name is shared (REF `clause`), and a
person is also named by the role alone (REF `role-only`), the usual natural way; a duration stays in its field or condition (a write that
mentions one never carries a from..to span, a read keeps one beside a duration as often as the natural sessions do, a new event "for an hour"
is `duration: 60`, CM `event-duration`) and the words say the date first; a follow-up listing is read through a list `LIST_LISTING` of the
time, as the natural reads of a first turn lean on `linked_to`; the ambiguous-selector cell (AMB) is kept.

`--weights` (train-coverage.json from authored/coverage.py, or its md): a slot draws up to four candidate pairs and keeps
one with probability proportional to its tier, an uncovered cell of tables A, B or C three times a covered one and a thin
cell two times; the facets, the options of a facet and the (verb, kind) of a write on `@prev` are weighted the same way.

`measure` takes any gold file and a driver run (eval/run.py output): per cell the items, turn pass and pair pass, and the
ten worst phrasing families. A session that cells.json knows is measured by its drill cell, pair and family; any other
turn is labelled by `turn_label` from its reference calls and gold (JUDGE, TWO, DATES, CONT, FOLLOW, CM, else C1..C4),
and a table of the worst cells of the universe (tables A, B, C) follows.

Environment as for authored/build.py: NATIVETOOLS (the runtime), EVAL_VAULTS (a scratch vault directory), HF_HUB_OFFLINE=1;
the interpreter that runs `gen` is the one that runs build.py (it re-invokes `sys.executable`): use the PY with torch.
"""
from __future__ import annotations

import argparse
import ast
import collections
import concurrent.futures as cf
import dataclasses
import datetime as dt
import functools
import glob as globmod
import gzip
import hashlib
import itertools
import json
import math
import os
import re
import resource
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from common import AUTHORED, NATIVE, rng  # noqa: E402

SECTIONS = {"people": "person", "groups": "group", "lists": "list", "events": "event", "tasks": "task",
            "notebooks": "notebook", "notes": "note", "folders": "folder", "documents": "document", "albums": "album",
            "photos": "photo", "debts": "debt", "locker": "locker item"}
NOUN = {"person": "people", "group": "groups", "list": "lists", "event": "events", "task": "tasks",
        "notebook": "notebooks", "note": "notes", "folder": "folders", "document": "documents", "album": "albums",
        "photo": "photos", "debt": "debts", "locker item": "locker items"}
NOUN1 = {"person": "person", "group": "group", "list": "list", "event": "event", "task": "task",
         "notebook": "notebook", "note": "note", "folder": "folder", "document": "document", "album": "album",
         "photo": "photo", "debt": "debt", "locker item": "locker item"}
DATE_KINDS = {"person", "event", "task", "note", "document", "photo", "debt"}  # kinds with a date field (kind card)
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
          "december"]
ROW_CAP = 12
HONORIFICS = {"dr", "mr", "mrs", "ms", "miss", "prof", "sir", "madam", "fr", "rev", "sr", "jr", "aunt", "uncle", "auntie"}


# =============================================================================================================
# dates: a port of crates/nativetools/src/dates.rs (evaluate, contains) for the expressions drills write
# =============================================================================================================

D0, D1 = dt.date.min, dt.date.max


def parse_stamp(text: str | None):
    """`YYYY-MM-DD[THH:MM]` -> (date, (h, m) | None)."""
    if not text:
        return None
    d = dt.date.fromisoformat(text[:10])
    rest = text[10:].lstrip("T ")
    if len(rest) >= 5:
        return (d, (int(rest[0:2]), int(rest[3:5])))
    return (d, None)


def stamp_dt(s) -> dt.datetime:
    h, m = s[1] or (0, 0)
    return dt.datetime.combine(s[0], dt.time(h, m))


def monday_of(d: dt.date) -> dt.date:
    return d - dt.timedelta(days=d.weekday())


def add_months(d: dt.date, n: int) -> dt.date:
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    import calendar
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def last_of_month(d: dt.date) -> dt.date:
    import calendar
    return dt.date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


def _clock(text: str) -> tuple[int, int]:
    return int(text[:2]), int(text[3:5])


def _day_or_at(d: dt.date, time_):
    if time_:
        return ("at", dt.datetime.combine(d, dt.time(*_clock(time_))))
    return ("days", d, d)


def resolve(expr: dict, now: dt.datetime, row=None):
    """A date expression (gold form) -> ('days', d0, d1) | ('at', datetime) | ('between', datetime, datetime)."""
    if "from" in expr or "to" in expr:
        a = resolve(expr["from"], now, row) if expr.get("from") else ("days", D0, D0)
        b = resolve(expr["to"], now, row) if expr.get("to") else ("days", D1, D1)
        start = _ends(a)[0]
        end = {"days": lambda: dt.datetime.combine(b[2], dt.time(23, 59)) if b[2] != D1 else dt.datetime.max,
               "at": lambda: b[1], "between": lambda: b[2]}[b[0]]()
        if a[0] == "days" and b[0] == "days":
            return ("days", a[1], b[2])
        return ("between", start, end)
    if "date" in expr:
        d = dt.date.fromisoformat(expr["date"])
        return _day_or_at(d, expr.get("time"))
    unit, rel = expr["unit"], expr["rel"]
    today = now.date()
    if expr.get("anchor") == "row":
        raise ValueError("anchor row is handled by the writer")
    if unit == "day":
        return _day_or_at(today + dt.timedelta(days=rel), expr.get("time"))
    if unit == "week":
        monday = monday_of(today) + dt.timedelta(days=7 * rel)
        if expr.get("weekday"):
            return _day_or_at(monday + dt.timedelta(days=expr["weekday"] - 1), expr.get("time"))
        return ("days", monday, monday + dt.timedelta(days=6))
    if unit == "month":
        if expr.get("name"):
            month, cur, year = expr["name"], today.month, today.year
            if rel < 0:
                base = year if month < cur else year - 1
                year = base + rel + 1
            elif rel > 0:
                base = year if month > cur else year + 1
                year = base + rel - 1
            first = dt.date(year, month, 1)
        else:
            first = add_months(today.replace(day=1), rel)
        return ("days", first, last_of_month(first))
    if unit == "year":
        y = today.year + rel
        return ("days", dt.date(y, 1, 1), dt.date(y, 12, 31))
    raise ValueError(f"unit {unit}")


def _ends(r):
    if r[0] == "days":
        return dt.datetime.combine(r[1], dt.time(0, 0)) if r[1] != D0 else dt.datetime.min, \
            dt.datetime.combine(r[2], dt.time(0, 0)) if r[2] != D1 else dt.datetime.max
    if r[0] == "at":
        return r[1], r[1]
    return r[1], r[2]


def contains(r, s) -> bool:
    """Whether a row's date stamp falls inside a resolution (Resolved::contains)."""
    if s is None:
        return False
    if r[0] == "days":
        return r[1] <= s[0] <= r[2]
    if r[0] == "at":
        return s[0] == r[1].date() and (s[1] is None or s[1] == (r[1].hour, r[1].minute))
    if s[1] is not None:
        return r[1] <= stamp_dt(s) <= r[2]
    return r[1].date() <= s[0] <= r[2].date()


def jx(expr: dict) -> str:
    return json.dumps(expr, separators=(",", ":"))


def U(unit, rel, **kw):
    return {"unit": unit, "rel": rel, **kw}


def Dt(date, time=None):
    return {"date": date, **({"time": time} if time else {})}


def span(a, b):
    return {"from": a, "to": b}


def day_name(d: dt.date) -> str:
    return WEEKDAYS[d.weekday()]


# =============================================================================================================
# text helpers
# =============================================================================================================


@functools.lru_cache(maxsize=None)
def fold(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text.lower()) if unicodedata.category(c) != "Mn")


@functools.lru_cache(maxsize=None)
def _toks(text: str) -> tuple:
    return tuple(re.findall(r"[a-z0-9]+", fold(text)))


def toks(text: str) -> list[str]:
    return list(_toks(text))


def say_num(n) -> str:
    """A number as a person might say it for small values."""
    small = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten"}
    return small.get(n, str(n)) if isinstance(n, int) else str(n)


def money(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else f"{x:g}"


# =============================================================================================================
# the vault: a world JSON read as rows, and the selector semantics of SPEC 3, 4.1 and 14.1
# =============================================================================================================

ACTIVE = ("open", "in_progress")  # D-1044-7: what `status = open` selects on a task
DONE_WORDS = re.compile(r"\b(all|everything|done|completed|finished|cancelled|closed)\b", re.I)


def world_today(w: str) -> tuple[str, str]:
    """(today, me) of a world: the `world(...)` line of its sessions, else the docstring of its builder."""
    for f in sorted((AUTHORED / "sessions").glob(f"{w}*.py")):
        m = re.search(r'^world\("%s",\s*"([^"]+)",\s*"([^"]+)"' % w, f.read_text(), re.M)
        if m:
            return m.group(1), m.group(2)
    text = (AUTHORED / "worlds" / f"{w}_build.py").read_text()
    m = re.search(r"Today in the sessions is \w+ (\d{4}-\d\d-\d\d) (\d\d:\d\d)", text)
    me = json.loads((AUTHORED / "worlds" / f"{w}.json").read_text())["me"]
    return f"{m.group(1)}T{m.group(2)}", me


class Vault:
    """A world as drills see it. `rows[key]` is a dict with `key kind name live` and the kind's fields (`date` a stamp)."""

    def __init__(self, world: dict, today: str, me: str | None = None):
        self.world = world
        self.today_s = today
        self.now = dt.datetime.combine(parse_stamp(today)[0], dt.time(*(parse_stamp(today)[1] or (9, 0))))
        self.today = self.now.date()
        self.me = me or world["me"]
        self.currency = (world.get("currency") or "USD").upper()
        self.epoch = parse_stamp(world.get("epoch", "2026-01-01T09:00"))
        self.rows: dict[str, dict] = {}
        self.order: list[str] = []
        self.links: dict[str, set[str]] = collections.defaultdict(set)
        self._load()

    # -- loading
    def _add(self, r: dict) -> dict:
        self.rows[r["key"]] = r
        self.order.append(r["key"])
        return r

    def _load(self) -> None:
        w = self.world
        self._add({"key": "me", "kind": "person", "name": self.me, "live": True, "role": None, "nickname": None, "met": None,
                   "cadence": None, "starred": False, "date": None, "me": True})
        for sec, kind in SECTIONS.items():
            for x in w.get(sec, []):
                r = {"key": x["key"], "kind": kind, "name": x["name"], "live": not x.get("trashed"),
                     "trashed_at": parse_stamp(x["trashed"]) if isinstance(x.get("trashed"), str) else None}
                if kind == "person":
                    r.update(role=x.get("role"), nickname=x.get("nickname"), met=x.get("met"),
                             cadence=x.get("cadence") or None, starred=bool(x.get("starred")),
                             date=parse_stamp(x.get("last_contacted")))
                elif kind == "group":
                    r.update(currency=(x.get("currency") or self.currency).upper(), members=list(x.get("members", [])) + ["me"])
                elif kind == "list":
                    r.update(area=x.get("area"))
                elif kind == "event":
                    s = parse_stamp(x["start"])
                    e = parse_stamp(x.get("end")) if x.get("end") else None
                    if e is None:
                        e = (s[0] + dt.timedelta(days=1), None) if s[1] is None else None
                    dur = int((stamp_dt(e) - stamp_dt(s)).total_seconds() // 60) if e else 60
                    cancelled = x.get("cancelled")
                    r.update(date=s, end=e, duration=dur, description=x.get("description"),
                             status="cancelled" if (cancelled is True or isinstance(cancelled, str)) else "tentative",
                             attendees=list(x.get("attendees", [])))
                elif kind == "task":
                    st = x.get("status")
                    if st == "completed" or x.get("completed"):
                        st = "completed"
                    elif st not in ("in_progress", "cancelled"):
                        st = "open"
                    r.update(date=parse_stamp(x.get("due")), status=st, effort=x.get("effort"), priority=x.get("priority"),
                             completed=parse_stamp(x.get("completed")), description=x.get("description"),
                             parent=x.get("parent"), list=x.get("list"))
                elif kind == "note":
                    r.update(date=parse_stamp(x.get("created")) or self.epoch, body=x.get("body") or x["name"],
                             pinned=bool(x.get("pinned")), notebook=x.get("notebook"))
                elif kind == "document":
                    r.update(date=parse_stamp(x.get("created")) or self.epoch, starred=bool(x.get("starred")),
                             folder=x.get("folder"))
                elif kind == "photo":
                    r.update(date=parse_stamp(x.get("taken")) or self.epoch, starred=bool(x.get("starred")),
                             albums=list(x.get("albums", [])), people=list(x.get("people", [])))
                elif kind == "debt":
                    r.update(date=parse_stamp(x.get("date")) or self.epoch, amount=float(x["amount"]),
                             direction=x.get("direction", "owes_me"), status="settled" if x.get("settled") else "open",
                             person=x["person"])
                elif kind == "locker item":
                    r.update(type=x.get("type", "login"), username=x.get("username"), url=x.get("url"),
                             notes=x.get("notes"), starred=bool(x.get("starred")))
                self._add(r)
        for l in w.get("links", []):
            self.links[l["from"]].add(l["to"])
            self.links[l["to"]].add(l["from"])

    # -- queries
    def of(self, kind: str, live: bool = True) -> list[dict]:
        idx = self.__dict__.get("_idx")
        if idx is None or idx[0] != len(self.order):
            allk = collections.defaultdict(list)
            for k in self.order:
                allk[self.rows[k]["kind"]].append(self.rows[k])
            idx = self._idx = (len(self.order), allk, {kk: [r for r in rs if r["live"]] for kk, rs in allk.items()})
        return list(idx[2 if live else 1].get(kind, ()))

    def get(self, key: str) -> dict:
        return self.rows[key]

    def name_words(self, r: dict) -> set[str]:
        cache = self.__dict__.setdefault("_nw", {})
        ws = cache.get(r["key"])
        if ws is None:
            ws = set(toks(r["name"]))
            if r["kind"] == "person" and r.get("nickname"):
                ws |= set(toks(r["nickname"]))
            cache[r["key"]] = ws
        return set(ws)

    def word_rows(self) -> dict[str, list[dict]]:
        """Every name word (a person's nickname words too) of a live row -> the live rows that have it."""
        idx = self.__dict__.get("_wr")
        if idx is None:
            idx = collections.defaultdict(list)
            for r in self.rows.values():
                if r["live"]:
                    for w in self.name_words(r):
                        idx[w].append(r)
            self._wr = idx
        return idx

    def block_hits(self, text: str) -> int:
        """How many live rows the pre-grounding block could show for these words (a whole word, or a word start of three letters)."""
        ws = toks(text)
        if not ws:
            return 0
        pref = self.__dict__.get("_pref")
        if pref is None:
            pref = collections.defaultdict(set)
            for r in self.rows.values():
                if r["live"]:
                    for x in self.name_words(r):
                        for n in range(3, len(x) + 1):
                            pref[x[:n]].add(r["key"])
            self._pref = pref
        words = self.word_rows()
        sets = []
        for w in ws:
            hit = {r["key"] for r in words.get(w, ())}
            if len(w) >= 3:
                hit |= pref.get(w, set())
            sets.append(hit)
        return len(set.intersection(*sets))

    def fits(self, r: dict, text: str) -> bool:
        """The runtime's name match: every word of `text` is a word of the row's name (a nickname is a name of a person)."""
        want = _toks(text)
        if not want:
            return False
        if r["kind"] == "person" and r.get("nickname") and set(want) <= set(_toks(r["nickname"])):
            return True
        return set(want) <= set(_toks(r["name"]))

    def _name_index(self, kind: str, live: bool):
        """Inverted indexes over the rows `of(kind, live)`: name word -> row positions, and nickname word -> row positions."""
        cache = self.__dict__.setdefault("_nidx", {})
        key = (kind, live, len(self.order))
        if key not in cache:
            rows = self.of(kind, live)
            by_word: dict[str, set[int]] = collections.defaultdict(set)
            by_nick: dict[str, set[int]] = collections.defaultdict(set)
            for i, r in enumerate(rows):
                for w in _toks(r["name"]):
                    by_word[w].add(i)
                if r["kind"] == "person" and r.get("nickname"):
                    for w in _toks(r["nickname"]):
                        by_nick[w].add(i)
            cache[key] = (rows, by_word, by_nick)
        return cache[key]

    def by_name(self, kind: str, text: str, live: bool = True) -> list[dict]:
        """The rows `fits` text, in `of(kind, live)` order (a word index: every word of the text must be one of the name, or of
        the nickname of a person)."""
        want = _toks(text)
        if not want:
            return []
        rows, by_word, by_nick = self._name_index(kind, live)
        hit = set.intersection(*[by_word.get(w, set()) for w in want])
        if by_nick:
            hit = hit | set.intersection(*[by_nick.get(w, set()) for w in want])
        return [rows[i] for i in sorted(hit)]

    def related(self, r: dict, a: dict) -> bool | None:
        """Is row `r` linked to anchor `a` (kind pairs the drills use); None when the pair is not modelled."""
        k, ak = r["kind"], a["kind"]
        if (k, ak) == ("task", "list"):
            return r["list"] == a["key"]
        if (k, ak) == ("task", "task"):
            return r["parent"] == a["key"]
        if (k, ak) == ("task", "person"):
            return a["key"] in self.links.get(r["key"], ())
        if (k, ak) == ("event", "person"):
            return a["key"] in r["attendees"]
        if (k, ak) == ("person", "group"):
            return r["key"] in a["members"]
        if (k, ak) == ("group", "person"):
            return a["key"] in r["members"]
        if (k, ak) == ("person", "event"):
            return r["key"] in a["attendees"]
        if (k, ak) == ("photo", "album"):
            return a["key"] in r["albums"]
        if (k, ak) == ("photo", "person"):
            return a["key"] in r["people"]
        if (k, ak) == ("note", "notebook"):
            return r["notebook"] == a["key"]
        if (k, ak) == ("document", "folder"):
            return r["folder"] == a["key"]
        if (k, ak) == ("debt", "person"):
            return r["person"] == a["key"]
        return None

    def count_of(self, r: dict, what: str) -> int | None:
        """`<kind> count` of a row (the link-count where fields)."""
        cache = self.__dict__.setdefault("_cc", {})
        key = (r["key"], what)
        if key not in cache:
            cache[key] = self._count_of(r, what)
        return cache[key]

    def _count_of(self, r: dict, what: str) -> int | None:
        k = r["kind"]
        if (k, what) == ("album", "photo"):
            return sum(1 for p in self.of("photo") if r["key"] in p["albums"])
        if (k, what) == ("folder", "document"):
            return sum(1 for p in self.of("document") if p["folder"] == r["key"])
        if (k, what) == ("notebook", "note"):
            return sum(1 for p in self.of("note") if p["notebook"] == r["key"])
        if (k, what) == ("list", "task"):
            return sum(1 for p in self.of("task") if p["list"] == r["key"])
        if (k, what) == ("event", "person"):
            return len(r["attendees"])
        if (k, what) == ("photo", "person"):
            return len(r["people"])
        if (k, what) == ("photo", "album"):
            return len(r["albums"])
        if (k, what) == ("group", "person"):
            return len(r["members"])
        if (k, what) == ("debt", "person"):
            return 1
        if (k, what) == ("task", "person"):
            return sum(1 for o in self.links.get(r["key"], ()) if self.rows[o]["kind"] == "person")
        if (k, what) == ("task", "list"):
            return 1 if r["list"] else 0
        if (k, what) == ("person", "group"):
            return sum(1 for g in self.of("group") if r["key"] in g["members"])
        if (k, what) == ("person", "event"):
            return sum(1 for e in self.of("event") if r["key"] in e["attendees"])
        if (k, what) == ("person", "task"):
            return sum(1 for o in self.links.get(r["key"], ()) if self.rows[o]["kind"] == "task" and self.rows[o]["live"])
        if (k, what) == ("person", "note"):
            return sum(1 for o in self.links.get(r["key"], ()) if self.rows[o]["kind"] == "note" and self.rows[o]["live"])
        if (k, what) == ("person", "photo"):
            return sum(1 for p in self.of("photo") if r["key"] in p["people"])
        if (k, what) == ("person", "debt"):
            return sum(1 for d in self.of("debt") if d["person"] == r["key"])
        if (k, what) == ("note", "notebook"):
            return 1 if r["notebook"] else 0
        if (k, what) == ("note", "person"):
            return sum(1 for o in self.links.get(r["key"], ()) if self.rows[o]["kind"] == "person")
        if (k, what) == ("document", "folder"):
            return 1 if r["folder"] else 0
        return None

    # -- where
    def cond(self, r: dict, c: tuple) -> bool:
        """One where condition `(field, op, value)`; a link count is `("<kind> count", op, n)`."""
        f, op, v = c
        if isinstance(v, str) and re.match(r"^-?[0-9.]+\s+\S", v):
            v = float(v.split()[0])  # `effort > 60 minutes`, `amount > 20 GBP`: the unit is the field's own
        if f.endswith(" count"):
            n = self.count_of(r, f[:-6])
            return _cmp(n, op, v)
        x = r.get(f)
        if f == "status" and r["kind"] == "task":
            if op == "=":
                return r["status"] in ACTIVE if v == "open" else r["status"] == v
            if op == "!=":
                return not (r["status"] in ACTIVE if v == "open" else r["status"] == v)
            if op == "in":
                acc = set()
                for m in v:
                    acc |= set(ACTIVE) if m == "open" else {m}
                return r["status"] in acc
        if op == "is empty":
            return x in (None, "", 0) if f in ("cadence",) else x in (None, "")
        if op == "is set":
            return x not in (None, "", 0) if f in ("cadence",) else x not in (None, "")
        if op == "contains":
            return x is not None and fold(str(v)) in fold(str(x))
        if op == "in":
            return x is not None and fold(str(x)) in {fold(str(m)) for m in v}
        if op in ("=", "!="):
            if isinstance(x, bool):
                x = "yes" if x else "no"
            if x is None:
                return op == "!=" and not isinstance(v, (int, float))
            eq = fold(str(x)) == fold(str(v)) if not isinstance(x, (int, float)) else float(x) == float(v)
            return eq if op == "=" else not eq
        return _cmp(x, op, v)

    # -- the selector
    def select(self, kind: str, *, name: str | None = None, where: list | None = None, when: dict | None = None,
               linked_to: str | None = None, within: list | None = None, exclude: list | None = None,
               order: tuple | None = None, limit: int | None = None, trashed: bool = False) -> list[str]:
        """The keys a selector picks (the vault never changes, so a selector is evaluated once)."""
        memo = self.__dict__.setdefault("_sel", {})
        key = (kind, name, repr(where), repr(when), linked_to, tuple(within) if within is not None else None,
               tuple(exclude) if exclude else None, order, limit, trashed)
        if key not in memo:
            memo[key] = self._select(kind, name, where, when, linked_to, within, exclude, order, limit, trashed)
        return list(memo[key])

    def _select(self, kind, name, where, when, linked_to, within, exclude, order, limit, trashed) -> list[str]:
        pool = self.of(kind, live=not trashed)
        if trashed:
            pool = [r for r in pool if not r["live"]]
        if within is not None:
            pool = [self.rows[k] for k in within if k in self.rows]
            if kind:
                pool = [r for r in pool if r["kind"] == kind]
        out = []
        res = resolve(when, self.now) if when else None
        anchor = self.rows[linked_to] if linked_to else None
        for r in pool:
            if name is not None and not self.fits(r, name):
                continue
            if res is not None and not contains(res, r.get("date")):
                continue
            if anchor is not None and not self.related(r, anchor):
                continue
            if any(not self.cond(r, c) for c in (where or [])):
                continue
            if exclude and r["key"] in exclude:
                continue
            out.append(r)
        if order:
            f, direction = order
            have = [r for r in out if _orderval(r, f) is not None]
            have.sort(key=lambda r: _orderval(r, f), reverse=(direction == "desc"))
            out = have
        if limit:
            out = out[:limit]
        return [r["key"] for r in out]

    def active_default(self, kind, linked_to, where, message) -> bool:
        """The container readout rule of 14.1: a task read through a list or a parent task with no status condition and
        none of the words all/everything/done/... selects the active rows only."""
        if kind != "task" or not linked_to or self.rows[linked_to]["kind"] not in ("list", "task"):
            return False
        if any(c[0] == "status" for c in (where or [])):
            return False
        return not DONE_WORDS.search(message or "")


def _cmp(x, op, v) -> bool:
    if x is None:
        return False
    x, v = float(x), float(v)
    return {"=": x == v, "!=": x != v, "<": x < v, "<=": x <= v, ">": x > v, ">=": x >= v}[op]


def _orderval(r: dict, f: str):
    if f == "date":
        s = r.get("date")
        return stamp_dt(s) if s else None
    v = r.get(f)
    if f == "priority" and v is not None:
        return float(v)
    return v if v not in ("",) else None


# =============================================================================================================
# the phrase bank: date phrases and the expression the runtime resolves each to (phrases.json is the authority)
# =============================================================================================================


@dataclasses.dataclass
class Ph:
    text: str
    expr: dict
    shape: str  # the cells.py date shape
    fam: str  # phrases of one family flip into one another
    future: bool = True  # lies wholly ahead of today (a write may set it)


def wd_rel(today: dt.date, wd: int) -> int:
    """A bare weekday (0 = monday): week rel 0 when the day is today or later this week, else rel 1."""
    return 0 if wd >= today.weekday() else 1


def phrase_bank(today: dt.date, past: bool = True) -> list[Ph]:
    out: list[Ph] = []
    add = lambda *a, **k: out.append(Ph(*a, **k))  # noqa: E731
    add("today", U("day", 0), "rel+unit", "day")
    add("tomorrow", U("day", 1), "rel+unit", "day")
    add("yesterday", U("day", -1), "rel+unit", "day", future=False)
    add("this week", U("week", 0), "rel+unit", "week", future=False)
    add("next week", U("week", 1), "rel+unit", "week")
    add("last week", U("week", -1), "rel+unit", "week", future=False)
    add("the week after next", U("week", 2), "rel+unit", "week")
    for i, w in enumerate(WEEKDAYS):
        n = i + 1
        add(f"next {w}", U("week", 1, weekday=n), "rel+unit+weekday", "weekday")
        add(f"last {w}", U("week", -1, weekday=n), "rel+unit+weekday", "weekday", future=False)
        add(w, U("week", wd_rel(today, i), weekday=n), "rel+unit+weekday", "weekday")
        if i >= today.weekday():
            add(f"this {w}", U("week", 0, weekday=n), "rel+unit+weekday", "weekday")
    add("this weekend", span(U("week", 0, weekday=6), U("week", 0, weekday=7)), "from..to[rel+unit+weekday | rel+unit+weekday]", "weekend")
    add("next weekend", span(U("week", 1, weekday=6), U("week", 1, weekday=7)), "from..to[rel+unit+weekday | rel+unit+weekday]", "weekend")
    add("last weekend", span(U("week", -1, weekday=6), U("week", -1, weekday=7)), "from..to[rel+unit+weekday | rel+unit+weekday]", "weekend", future=False)
    add("this month", U("month", 0), "rel+unit", "month", future=False)
    add("next month", U("month", 1), "rel+unit", "month")
    add("last month", U("month", -1), "rel+unit", "month", future=False)
    for i, m in enumerate(MONTHS):
        n = i + 1
        if n > today.month:
            add(f"in {m}", U("month", 0, name=n), "name+rel+unit", "named")
            add(f"next {m}", U("month", 1, name=n), "name+rel+unit", "named")
        if n < today.month:
            add(f"last {m}", U("month", -1, name=n), "name+rel+unit", "named", future=False)
    add("this year", U("year", 0), "rel+unit", "year", future=False)
    add("last year", U("year", -1), "rel+unit", "year", future=False)
    return [p for p in out if past or p.future]


def day_text(d: dt.date) -> str:
    return f"{MONTHS[d.month - 1]} {d.day}"


def abs_phrase(d: dt.date) -> Ph:
    return Ph(day_text(d), Dt(d.isoformat()), "date", "abs")


# =============================================================================================================
# messages: frames, phone typing, naming
# =============================================================================================================

FILLERS = ["please", "anything", "everything", "could", "would", "thanks", "again", "quickly"]
CONTR = [(r"\bwhat is\b", "what's"), (r"\bdo not\b", "don't"), (r"\bi am\b", "i'm"),
         (r"\bthat is\b", "that's"), (r"\bit is\b", "it's"), (r"\bcannot\b", "can't")]


def phone(frame: str, r) -> str:
    """Phone typing on a frame (a `{...}` slot is left alone): lowercase, contractions, a dropped word, a rare typo in a
    filler word. The same call on the same frame and rng makes the same text, so siblings share it."""
    parts = re.split(r"(\{[^}]*\})", frame)
    out = []
    for p in parts:
        if p.startswith("{"):
            out.append(p)
            continue
        p = p.lower()
        for rx, sub in CONTR:
            p = re.sub(rx, sub, p)
        out.append(p)
    text = "".join(out)
    if r.random() < 0.10:
        text = re.sub(r"\b(please|kindly|just)\s+", "", text, count=1)
    if r.random() < 0.05:
        for f in FILLERS:
            if re.search(rf"\b{f}\b", text) and len(f) >= 5:
                i = text.index(f) + r.randrange(1, len(f) - 2)
                text = text[:i] + text[i + 1] + text[i] + text[i + 2:]
                break
    return text


KIND_WORDS = r"(list|album|notebook|folder|group)"


def tidy(msg: str) -> str:
    """Spaces, the space before punctuation, and the words a frame and a name both bring ('the the garden album' for a container
    called The Garden, 'the bar prep study group group' for one called Bar Prep Study Group)."""
    msg = re.sub(r"\s+", " ", msg).strip()
    msg = re.sub(r"\s+([?!.,])", r"\1", msg)
    msg = re.sub(r"\bthe the\b", "the", msg)
    return re.sub(rf"\b{KIND_WORDS} \1\b", r"\1", msg)


def hardness_k(call: dict) -> int:
    """authored/hardness.py's constraint count of one reference call."""
    sys.path.insert(0, str(AUTHORED))
    import hardness
    return hardness.constraints({"tool": call["tool"], "args": call.get("args", {})})


# =============================================================================================================
# items, sessions
# =============================================================================================================


def C(tool: str, **args) -> dict:
    return {"tool": tool, "args": {k: v for k, v in args.items() if v is not None}}


def gold_rows(keys, order=False):
    out = {"type": "rows", "rows": list(keys)}
    if order:
        out["order"] = True
    return out


def gold_val(*vals):
    out = []
    for v in vals:
        out.append({"amount": v[0], "unit": v[1]} if isinstance(v, tuple) else {"amount": v, "unit": None})
    return {"type": "value", "values": out}


def gold_groups(groups: dict):
    return {"type": "value", "groups": {k: [{"amount": v[0], "unit": v[1]}] if isinstance(v, tuple)
                                        else [{"amount": v, "unit": None}] for k, v in groups.items()}}


def gold_diff(rows=(), links=(), already=()):
    out = {"type": "diff", "diff": {"rows": list(rows), "links": list(links)}}
    if already:
        out["already"] = list(already)
    return out


def g_upd(key, **fields):
    return {"key": key, "change": "updated", "fields": fields}


def g_new(kind, **fields):
    return {"new": kind, "fields": fields}


def g_trash(key):
    return {"key": key, "change": "trashed"}


def g_restore(key):
    return {"key": key, "change": "restored"}


def g_link(a, b):
    return {"change": "added", "from": a, "to": b}


ANY = {"any": True}


def gold_ask(*keys):
    return {"type": "ask", "candidates": list(keys)}


def gold_decline(*reasons):
    return {"type": "decline", "reasons": list(reasons)}


@dataclasses.dataclass
class Turn:
    user: str
    gold: dict | list
    ref: list
    k: int = 0


@dataclasses.dataclass
class Item:
    cell: str
    template: str
    frame: str
    feature: str  # what the pair flips
    turns: list
    shape: str = ""
    needs_m1: bool = False
    tags: tuple = ()
    pair: str = ""
    side: str = ""
    sid: str = ""
    world: str = ""

    def sid_key(self) -> str:
        return "|".join(t.user for t in self.turns)

    def gold_flat(self):
        return [t.gold if isinstance(t.gold, list) else [t.gold] for t in self.turns]

    def k(self) -> int:
        return max((hardness_turn_k(t) for t in self.turns), default=0)


def hardness_turn_k(t: Turn) -> int:
    return max((hardness_k(c) for c in t.ref if not c.get("bad")), default=0)


def src_session(it: Item) -> str:
    tags = " ".join(["drill", it.cell.lower(), f"pair:{it.pair}", *it.tags])  # pair:<id>: train.py batches the two siblings in one step
    turns = []
    for t in it.turns:
        gold = t.gold if isinstance(t.gold, list) else [t.gold]
        refs = ", ".join(common.render_call(c) for c in t.ref)
        turns.append(f"  T({t.user!r}, {', '.join(repr(g) for g in gold)},\n    ref=[{refs}])")
    return f"S({it.sid!r}, {tags!r},\n" + ",\n".join(turns) + ")\n"


# =============================================================================================================
# facets: the constraints a selector can carry, each with the values a pair can flip between
# =============================================================================================================


@dataclasses.dataclass
class Opt:
    id: str
    texts: list  # variants of (pre, post); the variant index is chosen once per pair
    where: list = dataclasses.field(default_factory=list)
    when: dict | None = None
    linked: str | None = None
    name: str | None = None
    order: tuple | None = None
    shape: str = ""
    fam: str = ""

    def n(self) -> int:
        return len(self.where) + (1 if self.when else 0) + (1 if self.linked else 0) + (1 if self.name else 0) + (1 if self.order else 0)

    def text(self, vi: int) -> tuple[str, str]:
        return self.texts[vi % len(self.texts)]


@dataclasses.dataclass
class Facet:
    id: str
    kind: str
    opts: list
    groups: frozenset
    rank: int = 5  # position among the posts (low first)
    share: float = 1.0  # the weight of this form among the forms of one text field (TEXT_MIX); 1 for every other facet


def _tx(pre="", post=""):
    return (pre, post)


def mins_text(n: int) -> list[str]:
    out = [f"{n} minutes"]
    if n == 60:
        out.insert(0, "an hour")
    if n == 90:
        out.insert(0, "an hour and a half")
    if n == 120:
        out.insert(0, "two hours")
    if n == 30:
        out.insert(0, "half an hour")
    return out


def when_forms(kind: str, p: Ph) -> list[str]:
    """The ways a message words a date phrase on a kind, each a template with `{t}` (never 'on tomorrow', 'for in april',
    'due on from monday to tuesday'; 'since' is left out, it reads as an open span)."""
    fam, t = p.fam, p.text
    if kind == "event":
        if fam == "weekday":
            return ["on {t}", "{t}"]
        if fam in ("day", "span") or (fam == "named" and t.startswith("in ")):
            return ["{t}"]
        return ["{t}", "for {t}"]
    if kind == "task":
        return ["due {t}", "due on {t}"] if fam == "weekday" else ["due {t}"]
    forms = {"person": ["i contacted {t}", "contacted {t}"], "note": ["from {t}", "written {t}"], "document": ["from {t}", "added {t}"],
             "photo": ["taken {t}", "from {t}"], "debt": ["from {t}", "dated {t}"]}[kind]
    # a span says "from" itself, and "from friday" reads as a span that starts there: a day or a weekday takes the dated form
    return [f for f in forms if not (fam in ("span", "weekday", "day") and f.startswith("from "))]


# The natural mix of a text condition: per field, how many conditions of the natural train sessions are `=` the whole value of a row,
# `contains` the whole value, and `contains` a part of it (a keyword the message says: `role contains "chairman"` for "the estate
# chairman"). Counted by authored/gen/drill_dist.py over the 35 natural builds of the train worlds (4,491 sessions, the where conditions
# of their act, find, answer and compute calls; the 2, 1 and 6 conditions of role, met and body whose value no row of the world has
# count as parts). The facets of a text field are one per form and share the field's draw in these proportions, so a drill carries
# `role = "dentist"`, `role contains "dentist"` and `role contains "chairman"` as the natural sessions do, never one operator per field.
TEXT_MIX = {"role": (45, 18, 99), "met": (25, 2, 9), "body": (5, 1, 48), "url": (2, 0, 6)}
FORMS = ("eq", "has", "part")
FORM_ID = {"eq": "{f}", "has": "{f}-has", "part": "{f}-part"}


def form_facets(kind: str, field: str, opts: dict, rank: int) -> list:
    """One facet per form of a text field that has options, their shares the natural mix of the forms there are."""
    mix = dict(zip(FORMS, TEXT_MIX[field]))
    live = [f for f in FORMS if opts.get(f) and mix[f] > 0]
    total = sum(mix[f] for f in live)
    return [Facet(FORM_ID[f].format(f=field), kind, opts[f], frozenset({field}), rank=rank, share=mix[f] / total) for f in live]


def text_parts(value: str, first: bool = False) -> list[str]:
    """What a message can say of a text value instead of all of it: a word of four letters or more that is no stop word, the last word
    first (the head of "dog walker" or "estate chairman"), then the first; with `first` the first word leads (the distinctive word of a
    place, "Osgoode" of "Osgoode Hall"). Never the whole value."""
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z'-]*", value) if len(w) >= 4 and w.lower() not in STOP]
    out: list[str] = []
    for w in ((words[0], words[-1]) if first else (words[-1], words[0])) if words else ():
        if fold(w) != fold(value) and fold(w) not in {fold(o) for o in out}:
            out.append(w)
    return out


PREPOSITIONS = {"of", "at", "in", "for", "from", "with", "to", "on", "by"}


def role_head(role: str):
    """The head word of a role: the last word before a preposition ("manager" of "product manager at Lumen", "friend" of "friend of Chiamaka"),
    when it has four letters or more and is no stop word."""
    left: list[str] = []
    for w in re.findall(r"[A-Za-z][A-Za-z'-]*", role):
        if w.lower() in PREPOSITIONS and left:
            break
        left.append(w)
    return left[-1] if left and len(left[-1]) >= 4 and left[-1].lower() not in STOP else None


def role_parts(role: str) -> list[str]:
    """What a message says of a role instead of all of it: the head word first, then the other words of four letters or more; never the whole."""
    head = role_head(role)
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z'-]*", role) if len(w) >= 4 and w.lower() not in STOP]
    out: list[str] = []
    for w in ([head] if head else []) + words:
        if fold(w) != fold(role) and fold(w) not in {fold(o) for o in out}:
            out.append(w)
    return out


def url_parts(u: str) -> list[str]:
    """The host of a url (no scheme, no path) and its name word: what a message says of a login's url ("mail.google.com", "condoportal")."""
    host = re.sub(r"^[a-z]+://(www\.)?", "", u.strip()).split("/")[0]
    out = [host] if host and fold(host) != fold(u) else []
    labels = host.split(".")
    if len(labels) >= 2 and len(labels[-2]) >= 4 and fold(labels[-2]) not in {fold(o) for o in out}:
        out.append(labels[-2])
    return out


def phrase_role(form: str, x: str, whole: str) -> list:
    """`x` is what the condition holds (the whole role, or its head word for a part), `whole` the role. The same words whatever the form: a
    message does not say which; a part says the head ("with role chairman") or the whole role ("whose role is estate chairman")."""
    return [_tx(post=f"with role {x.lower()}"), _tx(post=f"whose role is {(whole if form == 'part' else x).lower()}")]


def phrase_met(form: str, x: str, whole: str) -> list:
    return [_tx(post=f"i met at {whole.lower()}"), _tx(post=f"met at {whole.lower()}")]  # the place as it is, the condition may hold a word of it


def phrase_url(form: str, x: str, whole: str) -> list:
    return [_tx(post=f"at {x}"), _tx(post=f"with {x} in the url" if form == "part" else f"with the url {x}")]


class FacetBank:
    """The facets of one vault, built from its rows (an option exists only where the rows make it meaningful)."""

    def __init__(self, v: Vault, today_ph: list[Ph]):
        self.v, self.ph = v, today_ph
        self.cache: dict[str, list[Facet]] = {}

    def person_label(self, p: dict) -> str | None:
        """How a message names a person so that the name decides it: the full name, or a first name that no other row
        of the vault shares (person names and nicknames)."""
        full = p["name"]
        return full

    def first_unique(self, p: dict) -> str | None:
        """A person's first name when no other live row (person, nickname or any other kind) has it as a word of its name."""
        cache = self.__dict__.setdefault("_fu", {})
        if p["key"] not in cache:
            first = toks(p["name"])[0]
            rows = self.v.word_rows().get(first, ())
            hits = [q for q in rows if q["kind"] == "person"]
            others = [r for r in rows if r["kind"] != "person"]
            cache[p["key"]] = p["name"].split()[0] if len(hits) == 1 and not others and len(first) >= 4 else None
        return cache[p["key"]]

    def text_facets(self, kind: str, field: str, values: list[str], phrase, parts_of, cap: int, rank: int) -> list[Facet]:
        """The facets of one text field of a kind, one per form of the natural mix (`TEXT_MIX`): `=` the whole value, `contains` the whole
        value, `contains` a part of it. `phrase(form, text, whole)` gives the (pre, post) variants a message says for the value or its part (`whole` is the value).
        An option exists when its condition reaches one row at least and `cap` rows at most (as the facets of these fields always did)."""
        v = self.v
        opts: dict[str, list] = {f: [] for f in FORMS}
        seen: set[str] = set()
        for val in sorted(set(values)):
            if '"' in val or " and " in val:  # hardness counts a condition per ` and `, a quote ends the value
                continue
            for form, cond in (("eq", (field, "=", val)), ("has", (field, "contains", val))):
                if 1 <= len(v.select(kind, where=[cond])) <= cap:
                    opts[form].append(Opt(f"{field} {cond[1]} {val}", phrase(form, val, val), where=[cond]))
            for kw in parts_of(val):
                if fold(kw) not in seen and 1 <= len(v.select(kind, where=[(field, "contains", kw)])) <= cap:
                    seen.add(fold(kw))
                    opts["part"].append(Opt(f"{field} contains {kw}", phrase("part", kw, val), where=[(field, "contains", kw)]))
        return form_facets(kind, field, opts, rank)

    def facets(self, kind: str) -> list[Facet]:
        if kind not in self.cache:
            self.cache[kind] = [f for f in getattr(self, "f_" + kind.replace(" ", "_"))() if f and (len(f.opts) >= 1)]
        return self.cache[kind]

    # -- dated
    def when_facet(self, kind: str, past_only=False, future_only=False, fams=None) -> Facet | None:
        v = self.v
        opts = []
        for p in self.ph:
            if fams and p.fam not in fams:
                continue
            if future_only and not p.future:
                continue
            res = v.select(kind, when=p.expr)
            if len(res) > ROW_CAP or (not res and p.fam != "span"):
                continue
            ts = [_tx(post=form.format(t=p.text)) for form in when_forms(kind, p)]
            opts.append(Opt(p.text, ts, when=p.expr, shape=p.shape, fam=p.fam))
        return Facet("when", kind, opts, frozenset({"when"}), rank=7) if opts else None

    # -- task
    def f_task(self):
        v = self.v
        out = []
        st = []
        for sid, variants in (("open", ["open", "remaining", "outstanding", "unfinished"]), ("completed", ["finished", "completed", "done"]),
                              ("in_progress", ["in-progress", "in progress"]), ("cancelled", ["cancelled", "abandoned"])):
            if v.select("task", where=[("status", "=", sid)]):
                st.append(Opt(sid, [_tx(pre=x) for x in variants], where=[("status", "=", sid)]))
        out.append(Facet("status", "task", st, frozenset({"status"}), rank=1))
        od = Opt("overdue", [_tx(pre="overdue")], where=[("status", "=", "open")], when={"to": U("day", -1)}, shape="from..to[? | rel+unit]")
        if v.select("task", where=od.where, when=od.when):
            out.append(Facet("overdue", "task", [od], frozenset({"status", "when"}), rank=1))
        lists = [l for l in v.of("list") if v.select("task", linked_to=l["key"])]
        out.append(Facet("list", "task", [Opt(l["key"], [_tx(post=f"on the {l['name'].lower()} list"), _tx(post=f"in the {l['name'].lower()} list"),
                                                        _tx(post=f"from the {l['name'].lower()} list")], linked=l["key"]) for l in lists],
                         frozenset({"linked"}), rank=3))
        parents = [t for t in v.of("task") if len(v.select("task", linked_to=t["key"])) >= 2 and len(v.by_name("task", t["name"])) == 1]
        out.append(Facet("parent", "task", [Opt(t["key"], [_tx(post=f"under {t['name'].lower()}"), _tx(post=f"for {t['name'].lower()}"),
                                                          _tx(post=f"in {t['name'].lower()}")], linked=t["key"]) for t in parents], frozenset({"linked"}), rank=3))
        out.append(self.when_facet("task"))
        eff = []
        for n in (15, 20, 30, 45, 60, 90, 120):
            for op, words in ((">", ("over", "more than", "longer than")), ("<", ("under", "less than", "shorter than")),
                              (">=", ("at least",)), ("<=", ("at most", "no more than"))):
                res = v.select("task", where=[("effort", op, n)])
                if 0 < len(res) <= ROW_CAP + 6:
                    ts = [_tx(post=f"{w} {m}") for w in words for m in mins_text(n)[:1 if len(words) > 1 else 2]]
                    eff.append(Opt(f"effort {op} {n}", ts, where=[("effort", op, n)]))
        out.append(Facet("effort", "task", eff, frozenset({"effort"}), rank=6))
        pr = []
        for n in (1, 2, 3):
            if v.select("task", where=[("priority", "=", n)]):
                pr.append(Opt(f"priority = {n}", [_tx(pre=f"priority {n}"), _tx(post=f"with priority {n}")], where=[("priority", "=", n)]))
        out.append(Facet("priority", "task", pr, frozenset({"priority"}), rank=2))
        names = {}
        for t in v.of("task"):
            for w in toks(t["name"]):
                if len(w) >= 4 and w not in STOP:
                    names.setdefault(w, set()).add(t["key"])
        nm = [Opt(f"name {w}", [_tx(post=f"with {w} in the name"), _tx(post=f"about {w}")], name=w) for w, ks in sorted(names.items()) if 2 <= len(ks) <= 8 and not v.by_name("event", w)]
        out.append(Facet("name", "task", nm[:30], frozenset({"name"}), rank=2))
        return out

    # -- event
    def f_event(self):
        v = self.v
        out = [self.when_facet("event")]
        st = [Opt(s, [_tx(pre=x) for x in vs], where=[("status", "=", s)]) for s, vs in (("cancelled", ["cancelled", "called-off"]), ("tentative", ["tentative", "unconfirmed"]))
              if v.select("event", where=[("status", "=", s)])]
        out.append(Facet("status", "event", st, frozenset({"status"}), rank=1))
        people = [p for p in v.of("person") if len(v.select("event", linked_to=p["key"])) in range(1, ROW_CAP + 1)]
        out.append(Facet("person", "event", [Opt(p["key"], [_tx(post=f"with {p['name']}"), _tx(post=f"involving {p['name']}")], linked=p["key"])
                                              for p in people], frozenset({"linked"}), rank=3))
        du = []
        for n in (30, 45, 60, 90, 120, 180):
            for op, words in ((">", ("over", "longer than", "more than")), ("<", ("under", "shorter than", "less than"))):
                res = v.select("event", where=[("duration", op, n)])
                if 0 < len(res) <= ROW_CAP + 10:
                    du.append(Opt(f"duration {op} {n}", [_tx(post=f"{w} {m}") for w in words for m in mins_text(n)[:1]], where=[("duration", op, n)]))
        out.append(Facet("duration", "event", du, frozenset({"duration"}), rank=6))
        names = {}
        for e in v.of("event"):
            for w in toks(e["name"]):
                if len(w) >= 4 and w not in STOP:
                    names.setdefault(w, set()).add(e["key"])
        nm = [Opt(f"name {w}", [_tx(post=f"with {w} in the name"), _tx(post=f"that have {w} in the name")], name=w) for w, ks in sorted(names.items()) if 2 <= len(ks) <= 14 and not v.by_name("task", w)]
        out.append(Facet("name", "event", nm[:30], frozenset({"name"}), rank=2))
        return out

    # -- person
    def f_person(self):
        v = self.v
        out = []
        out += self.text_facets("person", "role", [p["role"] for p in v.of("person") if p.get("role")], phrase_role, lambda r_: [role_head(r_)] if role_head(r_) and fold(role_head(r_)) != fold(r_) else [], cap=6, rank=4)
        out.append(Facet("starred", "person", [Opt("starred", [_tx(pre="starred"), _tx(pre="favourite")], where=[("starred", "=", "yes")])], frozenset({"starred"}), rank=1))
        groups = [g for g in v.of("group") if len(v.select("person", linked_to=g["key"])) >= 2]
        out.append(Facet("group", "person", [Opt(g["key"], [_tx(post=f"in {g['name'].lower()}"), _tx(post=f"from {g['name'].lower()}")], linked=g["key"]) for g in groups],
                         frozenset({"linked"}), rank=3))
        out += self.text_facets("person", "met", [p["met"] for p in v.of("person") if p.get("met")], phrase_met, lambda m: text_parts(m, first=True)[:1], cap=10, rank=4)
        cad = []
        for n in (7, 14, 21, 30):
            for op, w in ((">", "over"), ("<=", "up to")):
                if 0 < len(v.select("person", where=[("cadence", op, n)])) <= 10:
                    cad.append(Opt(f"cadence {op} {n}", [_tx(post=f"on a cadence of {w} {n} days")], where=[("cadence", op, n)]))
        out.append(Facet("cadence", "person", cad, frozenset({"cadence"}), rank=6))
        out.append(self.when_facet("person"))
        return out

    # -- debt
    def f_debt(self):
        v = self.v
        out = []
        out.append(Facet("direction", "debt", [Opt("owes_me", [_tx(post="owed to me"), _tx(post="that people owe me")], where=[("direction", "=", "owes_me")]),
                                                Opt("i_owe", [_tx(post="i owe"), _tx(post="that i owe")], where=[("direction", "=", "i_owe")])],
                         frozenset({"direction"}), rank=4))
        out.append(Facet("status", "debt", [Opt("open", [_tx(pre="open"), _tx(pre="unpaid"), _tx(pre="outstanding")], where=[("status", "=", "open")]),
                                             Opt("settled", [_tx(pre="settled"), _tx(pre="paid off"), _tx(pre="cleared")], where=[("status", "=", "settled")])],
                         frozenset({"status"}), rank=1))
        am = []
        for n in (10, 20, 25, 30, 50, 100, 200):
            for op, w in ((">", "over"), ("<", "under")):
                if 0 < len(v.select("debt", where=[("amount", op, n)])) <= ROW_CAP:
                    am.append(Opt(f"amount {op} {n}", [_tx(post=f"{w} {n}"), _tx(post=f"{'more' if op == '>' else 'less'} than {n}")], where=[("amount", op, n)]))
        out.append(Facet("amount", "debt", am, frozenset({"amount"}), rank=6))
        pp = sorted({d["person"] for d in v.of("debt")})
        out.append(Facet("person", "debt", [Opt(p, [_tx(post=f"with {v.get(p)['name']}")], linked=p) for p in pp if p in v.rows and v.rows[p]["live"]],
                         frozenset({"linked"}), rank=3))
        out.append(self.when_facet("debt"))
        return out

    # -- note
    def f_note(self):
        v = self.v
        out = [Facet("pinned", "note", [Opt("pinned", [_tx(pre="pinned")], where=[("pinned", "=", "yes")])], frozenset({"pinned"}), rank=1)]
        nbs = [n for n in v.of("notebook") if v.select("note", linked_to=n["key"])]
        out.append(Facet("notebook", "note", [Opt(n["key"], [_tx(post=f"in the {n['name'].lower()} notebook"), _tx(post=f"from the {n['name'].lower()} notebook")], linked=n["key"]) for n in nbs],
                         frozenset({"linked"}), rank=3))
        words = collections.defaultdict(set)
        for n in v.of("note"):
            for w in set(toks(n["body"])):
                if len(w) >= 5 and w not in STOP:
                    words[w].add(n["key"])
        bw = [Opt(f"body {w}", [_tx(post=f"mentioning {w}"), _tx(post=f"that mention {w}")], where=[("body", "contains", w)])
              for w, ks in sorted(words.items()) if 1 <= len(ks) <= 6][:40]
        whole = [Opt(f"body = {b}", [_tx(post=f"saying exactly {b.lower()}"), _tx(post=f"that say exactly {b.lower()}")], where=[("body", "=", b)])
                 for b in sorted({n["body"] for n in v.of("note")}) if 1 <= len(toks(b)) <= 7 and '"' not in b and " and " not in b
                 and 1 <= len(v.select("note", where=[("body", "=", b)])) <= 6][:20]
        out += form_facets("note", "body", {"eq": whole, "part": bw}, rank=5)
        out.append(self.when_facet("note"))
        return out

    # -- document / photo
    def f_document(self):
        v = self.v
        out = [Facet("starred", "document", [Opt("starred", [_tx(pre="starred")], where=[("starred", "=", "yes")])], frozenset({"starred"}), rank=1)]
        fs = [f for f in v.of("folder") if v.select("document", linked_to=f["key"])]
        out.append(Facet("folder", "document", [Opt(f["key"], [_tx(post=f"in the {f['name'].lower()} folder"), _tx(post=f"from the {f['name'].lower()} folder")], linked=f["key"]) for f in fs],
                         frozenset({"linked"}), rank=3))
        out.append(self.when_facet("document"))
        return out

    def f_photo(self):
        v = self.v
        out = [Facet("starred", "photo", [Opt("starred", [_tx(pre="starred"), _tx(pre="favourite")], where=[("starred", "=", "yes")])], frozenset({"starred"}), rank=1)]
        als = [a for a in v.of("album") if v.select("photo", linked_to=a["key"])]
        out.append(Facet("album", "photo", [Opt(a["key"], [_tx(post=f"in the {a['name'].lower()} album"), _tx(post=f"from the {a['name'].lower()} album")], linked=a["key"]) for a in als],
                         frozenset({"linked"}), rank=3))
        pp = [p for p in v.of("person") if 1 <= len(v.select("photo", linked_to=p["key"])) <= ROW_CAP]
        out.append(Facet("person", "photo", [Opt(p["key"], [_tx(post=f"of {p['name']}"), _tx(post=f"with {p['name']} in them")], linked=p["key"]) for p in pp],
                         frozenset({"linked"}), rank=3))
        out.append(self.when_facet("photo"))
        return out

    def f_locker_item(self):
        v = self.v
        types = collections.Counter(r["type"] for r in v.of("locker item"))
        word = {"login": ["login"], "card": ["card"], "note": ["secure note"], "identity": ["identity"], "wifi": ["wifi"], "password": ["password"],
                "ssh_key": ["ssh key"], "api_credential": ["api credential"], "passport": ["passport"], "bank_account": ["bank account"],
                "driving_licence": ["driving licence"], "software_licence": ["software licence"], "crypto_wallet": ["crypto wallet"],
                "membership": ["membership"], "document": ["document"]}
        out = [Facet("type", "locker item", [Opt(f"type {t}", [_tx(pre=w) for w in word[t]], where=[("type", "=", t)]) for t, n in sorted(types.items())
                                              if 1 <= n <= 8 and t in word], frozenset({"type"}), rank=1)]
        out.append(Facet("starred", "locker item", [Opt("starred", [_tx(pre="starred")], where=[("starred", "=", "yes")])], frozenset({"starred"}), rank=2))
        return out

    def f_group(self):
        v = self.v
        cur = collections.Counter(g["currency"] for g in v.of("group"))
        return [Facet("currency", "group", [Opt(f"currency {c}", [_tx(post=f"in {c.lower()}"), _tx(post=f"that use {c.lower()}")], where=[("currency", "=", c)])
                                             for c, n in sorted(cur.items()) if 1 <= n <= 8], frozenset({"currency"}), rank=4)]

    def f_album(self):
        return []

    f_list = f_notebook = f_folder = f_album


SUPER = {  # kind -> [(order, label variants)]
    "task": [(("effort", "desc"), ["longest", "biggest"]), (("effort", "asc"), ["shortest", "quickest"]), (("priority", "asc"), ["highest priority", "most urgent"]),
             (("date", "asc"), ["earliest due", "soonest due"]), (("date", "desc"), ["latest due", "last due"])],
    "event": [(("duration", "desc"), ["longest"]), (("duration", "asc"), ["shortest"]), (("date", "asc"), ["earliest", "first"]), (("date", "desc"), ["latest", "last"])],
    "debt": [(("amount", "desc"), ["largest", "highest"]), (("amount", "asc"), ["smallest", "lowest"])],
}


# =============================================================================================================
# the generation context and the call renderers
# =============================================================================================================


class Ctx:
    def __init__(self, w: str, seed, avoid: set[str], authored: set[str], world: dict | None = None, today: str | None = None, gaps=None):
        self.w, self.seed = w, seed
        self.gaps = gaps
        self.world = world or json.loads((AUTHORED / "worlds" / f"{w}.json").read_text())
        t, me = (today, self.world["me"]) if today else world_today(w)
        self.today_s, self.me = t, me
        self.v = Vault(self.world, t, me)
        self.ph = phrase_bank(self.v.today) + span_phrases(self.v.today)
        self.bank = RichBank(self.v, self.ph)
        self.avoid, self.authored = avoid, authored
        self.msgs: set[str] = set()  # the messages of the pairs made so far: no two pairs of a world share one

    def rng(self, *key):
        return rng(self.seed, self.w, *map(str, key))


def cond_text(c: tuple) -> str:
    f, op, v = c
    if f.endswith(" count") or op in ("<", "<=", ">", ">="):
        return f"{f} {op} {v}"
    if op in ("is empty", "is set"):
        return f"{f} {op}"
    if op == "contains":
        return f'{f} contains "{v}"'
    if op == "in":
        return f"{f} in (" + ", ".join(f'"{x}"' for x in v) + ")"
    ENUM = {"status", "starred", "pinned", "direction", "type"}
    if f in ENUM or isinstance(v, (int, float)) or (isinstance(v, str) and re.match(r"^-?[0-9.]+\s+\S", v)):
        return f"{f} {op} {v}"
    return f'{f} {op} "{v}"'


def sel_args(kind: str, chosen: list[Opt], extra_where=(), limit=None) -> dict:
    where = [c for o in chosen for c in o.where] + list(extra_where)
    when = next((o.when for o in chosen if o.when), None)
    linked = next((o.linked for o in chosen if o.linked), None)
    name = next((o.name for o in chosen if o.name), None)
    order = next((o.order for o in chosen if o.order), None)
    return dict(kind=kind, name=name, where=" and ".join(cond_text(c) for c in where) or None,
                when=jx(when) if when else None, linked_to=f"${linked}" if linked else None,
                order=f"{order[0]} {order[1]}" if order else None, limit=limit)


def sel_keys(v: Vault, kind: str, chosen: list[Opt], message: str, extra_where=(), limit=None) -> list[str]:
    where = [c for o in chosen for c in o.where] + list(extra_where)
    when = next((o.when for o in chosen if o.when), None)
    linked = next((o.linked for o in chosen if o.linked), None)
    name = next((o.name for o in chosen if o.name), None)
    order = next((o.order for o in chosen if o.order), None)
    keys = v.select(kind, name=name, where=where, when=when, linked_to=linked, order=order, limit=limit)
    if v.active_default(kind, linked, where, message):
        keys = [k for k in keys if v.rows[k]["status"] in ACTIVE]
    return keys


# frames: (mood, text). {X} the noun phrase. Phone typing is applied to the frame, never to {X}.
READ_FRAMES = [("command", "show me {X}"), ("command", "list {X}"), ("command", "pull up {X}"), ("command", "give me {X}"),
               ("command", "find {X}"), ("command", "get me {X}"), ("question", "what {X} do i have"), ("question", "any {X}?"),
               ("question", "do i have any {X}"), ("question", "got any {X}?"), ("question", "what are my {X}"), ("question", "{X}?"),
               ("indirect", "can you show me {X}"), ("indirect", "could you list {X}"), ("indirect", "can i see {X}"),
               ("indirect", "can you pull up {X}"), ("indirect", "would you find {X}"), ("indirect", "can you get me {X}")]
COUNT_FRAMES = [("command", "count {X}"), ("command", "give me a count of {X}"), ("command", "tell me how many {X}"),
                ("question", "how many {X} do i have"), ("question", "how many {X}?"), ("question", "number of {X}?"),
                ("question", "how many {X} are there"), ("question", "how many {X} have i got"), ("question", "{X} count?"),
                ("indirect", "can you count {X}"), ("indirect", "could you tell me how many {X}"), ("indirect", "can you tell me how many {X} i have")]
SUM_FRAMES = [("command", "total up {X}"), ("command", "add up {X}"), ("command", "give me the total of {X}"),
              ("question", "how much are {X}"), ("question", "what do {X} come to"), ("question", "what's the total of {X}?"),
              ("question", "total of {X}?"), ("question", "how much in all for {X}"), ("indirect", "can you total up {X}"),
              ("indirect", "could you add up {X}"), ("indirect", "can you tell me the total of {X}")]
SUPER_FRAMES = [("command", "show me the {X}"), ("command", "find the {X}"), ("command", "give me the {X}"), ("command", "pull up the {X}"),
                ("question", "what's the {X}?"), ("question", "which is the {X}"), ("question", "which one is the {X}?"), ("question", "the {X}?"),
                ("indirect", "can you show me the {X}"), ("indirect", "could you find the {X}"), ("indirect", "can you tell me the {X}"),
                ("indirect", "can i see the {X}")]
VERB_FRAMES = {
    "complete": [("command", "complete {X}"), ("command", "tick off {X}"), ("command", "mark {X} as done"), ("command", "mark {X} done"),
                 ("command", "check off {X}"), ("command", "finish off {X}"), ("question", "can we tick off {X}?"), ("question", "tick off {X}?"),
                 ("indirect", "can you tick off {X}"), ("indirect", "could you mark {X} as done"), ("indirect", "can you complete {X}"),
                 ("indirect", "would you mind ticking off {X}")],
    # "cancel" and "call off" only: "get rid of", "scrap" and "drop" read as a delete (SPEC 14.1, delete and trash)
    "cancel": [("command", "cancel {X}"), ("command", "call off {X}"), ("command", "cancel {X} for me"), ("command", "go ahead and cancel {X}"),
               ("command", "we need to call off {X}"), ("question", "can we cancel {X}?"), ("question", "cancel {X}?"), ("question", "shall we call off {X}?"),
               ("indirect", "can you cancel {X}"), ("indirect", "could you call off {X}"), ("indirect", "can you cancel {X} for me"),
               ("indirect", "would you cancel {X} for me")],
    "star": [("command", "star {X}"), ("command", "favourite {X}"), ("command", "give {X} a star"), ("command", "mark {X} as favourites"),
             ("command", "add a star to {X}"), ("question", "can we star {X}?"), ("question", "star {X}?"), ("question", "shall i star {X}?"),
             ("indirect", "can you star {X}"), ("indirect", "could you favourite {X}"), ("indirect", "can you give {X} a star"),
             ("indirect", "would you star {X} for me")],
}


DURATION_FACETS = ("duration", "effort")  # the numeric facets whose words are minutes and hours


def compose(kind: str, chosen: list[tuple[Facet, Opt]], vi: int, plural=True, sup: str | None = None) -> str:
    """The noun phrase of a selector: pre words, the noun, the post phrases in rank order. A duration or effort phrase follows the date,
    joined by "that are" / "that take": "events from monday to friday that are over 120 minutes", never "events over 120 minutes from monday
    to friday", which reads as one phrase (120 minutes from monday)."""
    has_dur = any(fo[0].id in DURATION_FACETS for fo in chosen)
    chosen = sorted(chosen, key=lambda fo: 5.5 if (has_dur and fo[0].id == "when") else fo[0].rank)
    pres = [fo[1].text(vi)[0] for fo in chosen if fo[1].text(vi)[0]]
    posts, after_when = [], False
    for f, o in chosen:
        post = o.text(vi)[1]
        if post:
            posts.append(("that take " if f.id == "effort" else "that are ") + post if (after_when and f.id in DURATION_FACETS) else post)
        after_when = after_when or f.id == "when"
    noun = (NOUN if plural else NOUN1)[kind]
    parts = ([sup] if sup else []) + pres + [noun] + posts
    return " ".join(p for p in parts if p).lower()


def the_x(x: str) -> str:
    """For write frames: 'the open tasks ...'."""
    return "the " + x


def fill(frame: str, x: str) -> str:
    return tidy(frame.replace("{X}", x))


# =============================================================================================================
# C2 / C3: reads, counts, sums, superlatives and bounded writes with exactly two or three constraints
# =============================================================================================================

KIND_W = {"task": 30, "event": 26, "person": 12, "debt": 8, "note": 6, "document": 4, "photo": 8, "locker item": 3, "group": 3, "list": 2, "folder": 2, "notebook": 2, "album": 2}
# a bounded write: kind, verb, a forced facet-free where, the gold diff of a changed row, frames key
WRITES = {
    "task": [dict(verb="complete", force=[("status", "=", "open")], pre="open", diff=lambda k: g_upd(k, status="completed", completed=ANY),
                  only=("status", "overdue", "name", "list", "parent", "when", "effort", "priority", "count-person", "completed", "effort-set")),
             dict(verb="reopen", force=[("status", "=", "completed")], pre="finished", diff=lambda k: g_upd(k, status="open", completed=None),
                  only=("name", "list", "parent", "when", "effort", "priority", "count-person"), key="reopen"),
             dict(verb="edit", force=[("status", "=", "open")], pre="open", only=("name", "list", "parent", "when", "priority", "count-person"), key="edit-effort",
                  edit=("effort", [15, 30, 45, 60]))],
    "event": [dict(verb="cancel", force=[("status", "=", "tentative")], pre="tentative", diff=lambda k: g_upd(k, status="cancelled"),
                   only=("person", "when", "duration", "name", "count-person"), future=True)],
    "person": [dict(verb="star", force=[("starred", "=", "no")], pre="unstarred", diff=lambda k: g_upd(k, starred=True), only=("role", "role-has", "role-part", "met", "met-has", "met-part")),
               dict(verb="unstar", force=[("starred", "=", "yes")], pre="starred", diff=lambda k: g_upd(k, starred=False), only=("role", "role-has", "role-part", "met", "met-has", "met-part"))],
    "document": [dict(verb="star", force=[("starred", "=", "no")], pre="unstarred", diff=lambda k: g_upd(k, starred=True), only=("folder", "count-folder")),
                 dict(verb="unstar", force=[("starred", "=", "yes")], pre="starred", diff=lambda k: g_upd(k, starred=False), only=("folder", "count-folder"))],
    "photo": [dict(verb="star", force=[("starred", "=", "no")], pre="unstarred", diff=lambda k: g_upd(k, starred=True), only=("album", "person", "count-album", "count-person")),
              dict(verb="unstar", force=[("starred", "=", "yes")], pre="starred", diff=lambda k: g_upd(k, starred=False), only=("album", "person", "count-album", "count-person"))],
    "locker item": [dict(verb="unstar", force=[("starred", "=", "yes")], pre="starred", diff=lambda k: g_upd(k, starred=False), only=("type", "url", "url-part", "url-set")),
                    dict(verb="star", force=[("starred", "=", "no")], pre="unstarred", diff=lambda k: g_upd(k, starred=True), only=("type", "url", "url-part", "url-set"))],
}
VERB_FRAMES["edit-effort"] = [("command", "set the effort on {X} to {n} minutes"), ("command", "make {X} {n} minutes each"), ("command", "give {X} {n} minutes of effort"),
                              ("command", "change the effort of {X} to {n} minutes"), ("command", "estimate {n} minutes for {X}"), ("question", "can we set {X} to {n} minutes?"),
                              ("question", "{X} should be {n} minutes?"), ("indirect", "can you make {X} {n} minutes"), ("indirect", "could you set the effort on {X} to {n} minutes"),
                              ("indirect", "would you give {X} {n} minutes each")]


def _facet_n(f: Facet) -> int:
    return f.opts[0].n()


def tier_w(ctx: Ctx, kind: str, o: Opt) -> float:
    """The sampling weight of an option: 3 when a cell it lands in is uncovered in the train corpus, 2 when thin, else 1."""
    g = ctx.gaps
    if g is None:
        return 1.0
    key = (kind, o.id, repr(o.where), repr(o.when))
    cache = ctx.__dict__.setdefault("_tw", {})
    if key not in cache:
        cs = set()
        coverage, cells_mod, x = g.cov()
        for f, op, val in coverage.where_conds(" and ".join(cond_text(c) for c in o.where)) if o.where else []:
            cs.add(cells_mod.cell_str(("B", f"{kind}.{f}", op, coverage.value_form(kind, f, op, val, x))))
        if o.when:
            for sh in coverage.date_shapes({"when": jx(o.when)}):
                cs.add(cells_mod.cell_str(("C", kind, sh)))
        cache[key] = GAP_WEIGHT[g.tier_of(cs)]
    return cache[key]


def facet_w(ctx: Ctx, f: Facet) -> float:
    if f.share != 1.0:  # one form of a text field: the natural mix of the forms (TEXT_MIX) sets how often it is drawn, not the gap tiers
        return f.share
    return max((tier_w(ctx, f.kind, o) for o in f.opts), default=1.0)


def wshuffle(items: list, weights: list, r) -> list:
    """A weighted random order (the heavier first more often)."""
    keyed = sorted(((-math.log(max(r.random(), 1e-12)) / w, i) for i, w in enumerate(weights)))
    return [items[i] for _, i in keyed]


def pick_facets(facs: list[Facet], need: int, r, forced: list[Facet] = (), must_flip: bool = True, ctx: Ctx | None = None):
    """A compatible set of facets whose constraints add up to `need`, one of them with two options or more."""
    for _ in range(40):
        chosen, used, total = list(forced), set().union(*[f.groups for f in forced]) if forced else set(), sum(_facet_n(f) for f in forced)
        pool = [f for f in facs if f not in chosen]
        pool = wshuffle(pool, [facet_w(ctx, f) if ctx else 1.0 for f in pool], r)
        for f in pool:
            if total >= need:
                break
            if f.groups & used or total + _facet_n(f) > need:
                continue
            chosen.append(f)
            used |= f.groups
            total += _facet_n(f)
        if total != need:
            continue
        flips = [f for f in chosen if len(f.opts) >= 2 and f not in forced]
        if must_flip and not flips:
            continue
        return chosen, flips
    return None, None


def choose_flip(opts: list[Opt], resolve_fn, r, allow_empty=0.12, wfn=None):
    """Two options of one facet whose results differ (same family preferred for dates); resolve_fn(opt) -> result."""
    idx = list(range(len(opts)))
    r.shuffle(idx)
    cand = []
    res = {i: resolve_fn(opts[i]) for i in idx}
    for i in idx:
        for j in idx:
            if i < j and res[i] != res[j]:
                a, b = res[i], res[j]
                if isinstance(a, list) and not (a or b):
                    continue
                if isinstance(a, list) and (not a or not b) and r.random() > allow_empty:
                    continue
                same = opts[i].fam == opts[j].fam
                cand.append((0 if same else 1, i, j))
    if not cand:
        return None
    best = min(c[0] for c in cand)
    pool = [c for c in cand if c[0] == best] if r.random() < 0.85 else cand
    w = [max(wfn(opts[c[1]]), wfn(opts[c[2]])) if wfn else 1.0 for c in pool]
    _, i, j = r.choices(pool, w)[0]
    return (opts[i], opts[j]) if r.random() < 0.5 else (opts[j], opts[i])


def make_item(ctx: Ctx, cell: str, template: str, frame_id: str, feature: str, turns: list[Turn], shape="", needs_m1=False, tags=()) -> Item:
    return Item(cell=cell, template=template, frame=f"{template}.{frame_id}", feature=feature, turns=turns, shape=shape, needs_m1=needs_m1,
                tags=tuple(tags), world=ctx.w)


# grouped values: `compute op [field] group=<field> <selector>` then `answer value=@prev`, one value per label of the group field
# (values.rs: the label is the field's text, "none" for an unset one). (group field, op, number field) per kind.
GROUPS = {"task": [("status", "count", None)], "event": [("status", "count", None)],
          "debt": [("direction", "sum", "amount"), ("status", "sum", "amount"), ("direction", "count", None), ("status", "count", None)]}
GROUP_WORDS = {"status": ["by status", "per status"], "direction": ["by direction", "by who owes who"]}
GROUP_COUNT_FRAMES = [("command", "count {X} {G}"), ("command", "break {X} down {G}"), ("command", "split {X} {G}"), ("command", "give me a count of {X} {G}"),
                      ("question", "how many {X} {G}?"), ("question", "how many {X} do i have {G}?"), ("question", "{X} count {G}?"),
                      ("question", "what's the split of {X} {G}?"), ("indirect", "can you break {X} down {G}"), ("indirect", "could you count {X} {G}"),
                      ("indirect", "can you split {X} {G}")]
GROUP_SUM_FRAMES = [("command", "total up {X} {G}"), ("command", "add up {X} {G}"), ("command", "break the total of {X} down {G}"),
                    ("command", "give me the total of {X} {G}"), ("question", "how much are {X} {G}?"), ("question", "what's the total of {X} {G}?"),
                    ("question", "total of {X} {G}?"), ("question", "how much in all for {X} {G}?"), ("indirect", "can you total up {X} {G}"),
                    ("indirect", "could you add up {X} {G}"), ("indirect", "can you break down the total of {X} {G}")]


def group_values(v: Vault, keys: list[str], gfield: str, gop: str, gnum: str | None) -> dict:
    """The gold of a grouped compute over `keys`: label -> count, or label -> (sum, currency)."""
    by: dict[str, list[dict]] = collections.defaultdict(list)
    for k in keys:
        row = v.get(k)
        by[str(row.get(gfield) if row.get(gfield) is not None else "none")].append(row)
    if gop == "count":
        return {label: len(rows) for label, rows in by.items()}
    return {label: (round(sum(r_[gnum] for r_ in rows), 2), v.currency) for label, rows in by.items()}


KEEP_SPAN_WITH_DURATION = 0.5  # of the reads that have a duration condition and a date: the natural sessions keep 18% a from..to span, the drills 39%


def no_span(f: Facet) -> Facet:
    return dataclasses.replace(f, opts=[o for o in f.opts if not (o.when and "from" in o.when and "to" in o.when)])


def drop_duration_spans(chosen: list, flips: list, r, always: bool, says_duration: bool = False):
    """The date of a call with a duration or effort condition (or whose message says the new duration) loses its from..to spans: the natural
    sessions keep a duration where it is, in a field, and a write that mentions one never carries a span (drill_dist.py: 0 of 109, the drills
    15%), a read only 18% of the time. Always for a write, else all but KEEP_SPAN_WITH_DURATION of the time. (chosen, flips), or (None, None)
    when the date has no other option to flip."""
    when = next((f for f in chosen if f.id == "when"), None)
    if when is None or not (says_duration or any(f.id in DURATION_FACETS for f in chosen)):
        return chosen, flips
    if not always and r.random() < KEEP_SPAN_WITH_DURATION:
        return chosen, flips
    w2 = no_span(when)
    if not w2.opts:
        return None, None
    chosen = [w2 if f is when else f for f in chosen]
    flips = [w2 if f is when else f for f in flips if f is not when or len(w2.opts) >= 2]
    return (chosen, flips) if flips else (None, None)


def sel_pair(ctx: Ctx, r, intent: str, target_k: int):
    """One minimal pair of a selector drill. intent: read | count | sum | super | group | write."""
    v, bank = ctx.v, ctx.bank
    kinds = {"sum": ["debt"], "super": list(SUPER), "write": list(WRITES), "group": list(GROUPS)}.get(intent, list(KIND_W))
    weights = [KIND_W.get(k, 5) for k in kinds]
    kind = r.choices(kinds, weights)[0]
    facs = bank.facets(kind)
    extra = {"count": 1, "sum": 1, "super": 1, "group": 1}.get(intent, 0)
    forced: list[Facet] = []
    spec = None
    gfield = gop = gnum = None
    if intent == "group":
        gfield, gop, gnum = r.choice(GROUPS[kind])
        facs = [f for f in facs if gfield not in f.groups]  # the group field is no filter of the same call
        if kind == "task":  # a task read through a list or a parent keeps the active rows (SPEC 14.1), which is no by-status split
            facs = [f for f in facs if "linked" not in f.groups]
    if intent == "write":
        spec = r.choice(WRITES[kind])
        facs = [f for f in facs if f.id in spec["only"]]
        if kind in ("task",):
            st = next((f for f in bank.facets("task") if f.id == "status"), None)
            want = spec["force"][0][2]
            st_open = next((o for o in (st.opts if st else []) if o.id == want), None)
            if st_open is None:
                return None
            forced = [Facet("status", "task", [st_open], frozenset({"status"}), rank=1)]
            facs = [f for f in facs if f.id not in ("status", "overdue")] + ([f for f in bank.facets("task") if f.id == "overdue"] if want == "open" else [])
        else:
            fv = spec["force"][0]
            forced = [Facet("status", kind, [Opt(f"{fv[0]} {fv[2]}", [_tx(pre=spec["pre"])], where=[fv])], frozenset({"force"}), rank=1)]
        if spec.get("future"):
            facs = [dataclasses.replace(f, opts=[o for o in f.opts if not o.when or _future(o.when, ctx)]) if f.id == "when" else f for f in facs]
            facs = [f for f in facs if f.opts]
    need = target_k - extra
    sup_opts = None
    if intent == "super":
        sup_opts = SUPER[kind]
        need -= 0  # the order facet is its own constraint, counted by `extra`
    chosen_f, flips = pick_facets(facs, need, r, forced, ctx=ctx)
    if chosen_f is None:
        return None
    chosen_f, flips = drop_duration_spans(chosen_f, flips, r, always=intent == "write", says_duration=bool(spec and spec.get("edit")))
    if chosen_f is None:
        return None
    vi = r.randrange(4)
    df = r.choices(flips, [facet_w(ctx, f) for f in flips])[0]
    fixed = []
    for f in chosen_f:
        if f is df:
            continue
        fixed.append((f, r.choices(f.opts, [tier_w(ctx, kind, o) for o in f.opts])[0]))
    base_opts = [o for _, o in fixed]

    def evaluate(opt, order=None, limit=None):
        ch = base_opts + [opt]
        msg = compose(kind, [(f, o) for f, o in fixed] + [(df, opt)], vi)
        return sel_keys(v, kind, ch, msg, limit=limit)

    if intent == "super":
        so = r.choice(sup_opts)
    flip = choose_flip(df.opts, (lambda o: len(evaluate(o))) if intent in ("count",) else
                       ((lambda o: round(sum(v.get(k)["amount"] for k in evaluate(o)), 2) if evaluate(o) else None) if intent == "sum" else
                        ((lambda o: group_values(v, evaluate(o), gfield, gop, gnum)) if intent == "group" else
                         (lambda o: evaluate(o)))), r, wfn=(lambda o: tier_w(ctx, kind, o)))
    if flip is None:
        return None
    oa, ob = flip
    shape = oa.shape or ob.shape
    # --- build the two sides
    sides = []
    for opt in (oa, ob):
        pairs = fixed + [(df, opt)]
        chosen_o = [o for _, o in pairs]
        sup_label = None
        if intent == "super":
            order_opt = Opt("order", [_tx()], order=so[0])
            chosen_o = chosen_o + [order_opt]
            sup_label = so[1][vi % len(so[1])]
        x = compose(kind, pairs, vi, plural=(intent != "super"), sup=sup_label)
        keys = sel_keys(v, kind, chosen_o, x, limit=1 if intent == "super" else None)
        sides.append((opt, chosen_o, x, keys))
    # super: the extreme must be strict
    if intent == "super":
        for opt, chosen_o, x, keys in sides:
            full = sel_keys(v, kind, chosen_o, x)
            if len(full) < 2:
                if len(full) == 0:
                    return None
                continue
            f_, d_ = chosen_o[-1].order
            if _orderval(v.get(full[0]), f_) == _orderval(v.get(full[1]), f_):
                return None
        if any(len(s[3]) != 1 for s in sides) or sides[0][3] == sides[1][3]:
            return None
    frames = ({"read": READ_FRAMES, "count": COUNT_FRAMES, "sum": SUM_FRAMES, "super": SUPER_FRAMES,
               "group": GROUP_COUNT_FRAMES if gop == "count" else GROUP_SUM_FRAMES}[intent] if intent != "write" else VERB_FRAMES[spec.get("key", spec["verb"])])
    gword = r.choice(GROUP_WORDS[gfield]) if intent == "group" else ""
    edit_n = r.choice(spec["edit"][1]) if intent == "write" and spec.get("edit") else None
    fi = r.randrange(len(frames))
    mood, frame = frames[fi]
    frame = phone(frame, r)
    items = []
    for side, (opt, chosen_o, x, keys) in zip("ab", sides):
        if intent == "write":
            x = the_x(x)
        msg = fill((frame.replace("{n}", str(edit_n)) if edit_n else frame).replace("{G}", gword), x)
        args = sel_args(kind, chosen_o, limit=1 if intent == "super" else None)
        if intent == "group":
            if not keys:
                return None
            ref = [C("compute", op=gop, field=gnum, group=gfield, **args), C("answer", value="@prev")]
            gold = gold_groups(group_values(v, keys, gfield, gop, gnum))
        elif intent == "read" or intent == "super":
            ref = [C("answer", **args)]
            gold = gold_rows(keys)
        elif intent == "count":
            ref = [C("answer", op="count", **args)]
            gold = gold_val(len(keys))
        elif intent == "sum":
            ref = [C("answer", op="sum", field="amount", **args)]
            if not keys:
                return None
            gold = gold_val((round(sum(v.get(k)["amount"] for k in keys), 2), ctx.v.currency))
        else:
            if not keys or len(keys) > 6:
                return None
            eargs = f"{spec['edit'][0]}: {edit_n}" if edit_n else None
            if edit_n and any(v.get(k).get(spec["edit"][0]) == edit_n for k in keys):
                return None
            if len(keys) == 1:
                ref = [C("act", verb=spec["verb"], args=eargs, **args)]
            else:
                ref = [C("find", **args), C("act", verb=spec["verb"], rows="@prev", args=eargs)]
            gold = gold_diff([(g_upd(k, **{spec["edit"][0]: edit_n}) if edit_n else spec["diff"](k)) for k in keys])
        t = Turn(msg, gold, ref)
        items.append((msg, t, opt))
    k = hardness_turn_k(items[0][1])
    if k != target_k or hardness_turn_k(items[1][1]) != target_k:
        return None
    if items[0][0] == items[1][0]:
        return None
    cell = f"C{target_k}"
    feature = f"{kind}.{df.id}"
    out = []
    for (msg, t, opt) in items:
        out.append(make_item(ctx, cell, f"{intent}", f"{fi}", feature, [t], shape=opt.shape or shape, tags=(intent, kind.replace(" ", "_"))))
    return out[0], out[1]


def _future(when: dict, ctx: Ctx) -> bool:
    res = resolve(when, ctx.v.now)
    lo = _ends(res)[0]
    return lo.date() >= ctx.v.today + dt.timedelta(days=1)


# =============================================================================================================
# the registry of templates
# =============================================================================================================

CELL_NAMES = ["C2", "C3", "C4", "REF", "CM", "TWO", "DATES", "CONT", "FOLLOW", "JUDGE", "AMB"]
CELL_SHARE = {"C2": 0.17, "C3": 0.19, "C4": 0.0, "REF": 0.13, "CM": 0.08, "TWO": 0.07, "DATES": 0.09, "CONT": 0.08, "FOLLOW": 0.08, "JUDGE": 0.07, "AMB": 0.04}
CELL_DOC = {
    "C2": "a read, count, sum, superlative, grouped value or bounded write with exactly two constraints; the pair flips one constraint's value",
    "C3": "the same with exactly three constraints",
    "C4": "the same with exactly four constraints (the hardest calls on val; no share by default: --shares C4=0.06)",
    "REF": "a referent with a decoy in view (twins of the world); the message settles it (role, the role alone, a role clause that is no filter, group, nickname, date, container, state, focus, an ask); the pair flips which twin is meant",
    "CM": "create versus modify with near-identical wording, and the create's fields as constraints; the pair flips the verb class",
    "TWO": "two writes on different rows in one message, or a write then a read of its result; the pair flips one of the rows",
    "DATES": "two dates in one message and every date shape, the hour conventions; the pair flips one date",
    "CONT": "containers and subtasks: membership, move, which list; the pair flips the container",
    "FOLLOW": "turn 2 leaning on turn 1 through the block's lines (ordinal, the other, what else, same for, both, narrowing within the rows shown, a write on @prev); the pair flips the ordinal, person or narrowing",
    "JUDGE": "the judgements the model keeps (open ask vs create, policy declines, bounded vs unbounded delete); the pair flips the judgement",
    "AMB": "an ambiguous write: reference is the act alone, gold the ask over the candidates the runtime composes; the pair flips what settles which row",
}


@dataclasses.dataclass
class Template:
    cell: str
    name: str
    fn: object
    weight: float = 1.0
    frames: int = 0
    needs_m1: bool = False  # the pair needs a runtime feature that is not in the binary: built, never kept (no template sets it now)
    asks: bool = False  # the pair is meant to end in the runtime's ask (a write that fits several rows): kept, and exempt from the would-ask filter


TEMPLATES: list[Template] = []


def register(cell, name, fn, weight=1.0, frames=0, needs_m1=False, asks=False):
    TEMPLATES.append(Template(cell, name, fn, weight, frames, needs_m1, asks))


def _reg_selectors():
    nf = {"read": len(READ_FRAMES), "count": len(COUNT_FRAMES), "sum": len(SUM_FRAMES), "super": len(SUPER_FRAMES), "write": 72,
          "group": len(GROUP_COUNT_FRAMES) + len(GROUP_SUM_FRAMES)}
    wt = {"read": 3.0, "count": 2.2, "sum": 0.8, "super": 1.2, "write": 2.0, "group": 0.9}
    for k in (2, 3, 4):
        for intent in ("read", "count", "sum", "super", "write", "group"):
            register(f"C{k}", f"{intent}", (lambda c, r, i=intent, kk=k: sel_pair(c, r, i, kk)), wt[intent], nf[intent])


_reg_selectors()


# =============================================================================================================
# naming a row in a message, and the single-row verbs (shared by REF, CM, TWO, FOLLOW, CONT, JUDGE, AMB)
# =============================================================================================================

STOP = {"the", "and", "for", "with", "from", "your", "our", "into", "about", "this", "that", "new", "old", "of", "to", "in", "on", "a", "an", "at", "by"}
# words a message must not use as the name of a row: a pronoun ("give her a star" for a photo named "Mei in her white coat") or a
# word the follow-ups use themselves ("the other one", "both")
PRONOUNS = {"he", "she", "her", "hers", "him", "his", "it", "its", "they", "them", "their", "we", "you", "one", "ones", "all", "both", "other", "same",
            "that", "those", "these", "this", "here", "there", "then", "now", "last", "next", "first", "second", "third", "some", "any", "what", "who"}
NOT_NAME = STOP | PRONOUNS


def name_options(v: Vault, row: dict) -> list[tuple[str, str, str]]:
    """How a message can name a row so the name alone decides it: [(style, text in the message, name argument)]. Styles:
    full (verbatim), partial (words of the name), first / nick (a person's first name, a nickname)."""
    cache = v.__dict__.setdefault("_nopt", {})
    if row["key"] not in cache:
        cache[row["key"]] = _name_options(v, row)
    return list(cache[row["key"]])


def _name_options(v: Vault, row: dict) -> list[tuple[str, str, str]]:
    kind = row["kind"]
    out = []
    if row.get("me"):
        return out
    full = row["name"]
    if len(v.by_name(kind, full)) == 1:
        out.append(("full", full.lower(), full))
    ws = [w for w in re.split(r"\s+", full.strip()) if re.search(r"[A-Za-z0-9]", w)]
    seen = set()
    # contiguous runs of the name that neither start nor end on a filler word: "car insurance", "swimming costume"
    for n in (1, 2, 3):
        for i in range(0, len(ws) - n + 1):
            run = [w.strip(",.:;-()").lower() for w in ws[i:i + n]]
            core = lambda w: re.sub(r"[^a-z0-9]", "", fold(w))  # noqa: E731
            if core(run[0]) in NOT_NAME or core(run[-1]) in NOT_NAME or len(core(run[0])) < 3 or len(core(run[-1])) < 3:
                continue
            text = " ".join(run)
            if text in seen or toks(text) == toks(full):
                continue
            seen.add(text)
            hits = v.by_name(kind, text)
            if len(hits) == 1 and hits[0]["key"] == row["key"]:
                out.append(("partial", text, text))
    if kind == "person":
        if row.get("nickname"):
            nk = row["nickname"]
            if len(v.by_name("person", nk)) == 1 and not set(toks(nk)) & NOT_NAME:
                out.append(("nick", nk.lower(), nk))
        first = toks(full)[0]
        hits = v.by_name("person", first)
        if len(hits) == 1 and len(first) >= 3 and first not in NOT_NAME:
            out.append(("first", first, first))
    return out


def pick_name(v: Vault, row: dict, r, verbatim_share=0.5):
    """(style, text, name argument) for a row: verbatim about half the time, else partial/first/nick."""
    opts = name_options(v, row)
    if not opts:
        return None
    full = [o for o in opts if o[0] == "full"]
    rest = [o for o in opts if o[0] != "full"]
    if full and (r.random() < verbatim_share or not rest):
        return full[0]
    if not rest:
        return None
    # prefer short distinctive partials and first names / nicknames
    lastw = toks(row["name"])[-1]
    rest.sort(key=lambda o: (o[0] == "partial" and len(o[1].split()) > 2, o[0] == "partial" and toks(o[1])[-1] != lastw, len(o[1])))
    return r.choice(rest[: max(1, min(4, len(rest)))])


def shown_key(row: dict) -> str:
    return "$" + row["key"]


def single_ref(verb: str, row: dict, name_arg: str | None, r, args: str | None = None, by_key_share=0.3, **sel) -> dict:
    """The reference call of a verb on one named row: a selector by name (k=1) or a pick by `$key`."""
    if name_arg is None or r.random() < by_key_share:
        return C("act", verb=verb, rows=shown_key(row), args=args)
    return C("act", verb=verb, kind=row["kind"], name=name_arg, args=args, **sel)


# the single-row verbs: how a change reads as gold, and which rows the verb can change (SPEC 14.1 verb applicability)
VERBS = {
    "star": dict(kinds=("person", "document", "photo", "locker item"), gold=lambda v, k: g_upd(k, starred=True), ok=lambda v, r: not r["starred"]),
    "unstar": dict(kinds=("person", "document", "photo", "locker item"), gold=lambda v, k: g_upd(k, starred=False), ok=lambda v, r: r["starred"]),
    "complete": dict(kinds=("task",), gold=lambda v, k: g_upd(k, status="completed", completed=ANY), ok=lambda v, r: r["status"] in ACTIVE),
    # a cancelled task has no completion date to clear, so its diff is the status alone
    "reopen": dict(kinds=("task",), gold=lambda v, k: g_upd(k, status="open", completed=None) if v.get(k).get("completed") else g_upd(k, status="open"),
                   ok=lambda v, r: r["status"] not in ACTIVE),
    "cancel": dict(kinds=("event",), gold=lambda v, k: g_upd(k, status="cancelled"), ok=lambda v, r: r["status"] != "cancelled"),
    "log": dict(kinds=("person",), gold=lambda v, k: g_upd(k, date=ANY), ok=lambda v, r: not r.get("me"), args="kind: call"),
    "delete": dict(kinds=("task", "event", "note", "document", "photo", "person", "locker item"), gold=lambda v, k: g_trash(k), ok=lambda v, r: r["live"] and not r.get("me")),
    "edit": dict(kinds=tuple(NOUN), gold=None, ok=lambda v, r: r["live"] and not r.get("me")),
    "reschedule": dict(kinds=("task", "event"), gold=None, ok=lambda v, r: r["live"] and r.get("status") != "cancelled" and r.get("date") is not None),
    "restore": dict(kinds=tuple(NOUN), gold=lambda v, k: g_restore(k), ok=lambda v, r: not r["live"]),
    "settle_debt": dict(kinds=("debt",), gold=lambda v, k: g_upd(k, status="settled"), ok=lambda v, r: r["status"] == "open"),
}
VERB_FRAMES.update({
    "unstar": [("command", "unstar {X}"), ("command", "take the star off {X}"), ("command", "remove the star from {X}"), ("command", "un-favourite {X}"),
               ("command", "unfavourite {X}"), ("question", "can we unstar {X}?"), ("question", "unstar {X}?"), ("question", "shall i unstar {X}?"),
               ("indirect", "can you unstar {X}"), ("indirect", "could you take the star off {X}"), ("indirect", "can you un-favourite {X}"),
               ("indirect", "would you remove the star from {X}")],
    "reopen": [("command", "reopen {X}"), ("command", "put {X} back on my list"), ("command", "un-tick {X}"), ("command", "mark {X} as not done"),
               ("command", "open {X} up again"), ("question", "can we reopen {X}?"), ("question", "reopen {X}?"), ("question", "shall i reopen {X}?"),
               ("indirect", "can you reopen {X}"), ("indirect", "could you un-tick {X}"), ("indirect", "can you open {X} up again"),
               ("indirect", "would you put {X} back on my list")],
    "log": [("command", "log a call with {X}"), ("command", "log that i rang {X}"), ("command", "put down a call with {X}"),
            ("command", "note that i called {X}"), ("command", "i just spoke to {X}, log it"), ("question", "can i log a call with {X}?"),
            ("question", "log call with {X}?"), ("question", "should i log the call with {X}?"), ("indirect", "can you log a call with {X}"),
            ("indirect", "could you note that i rang {X}"), ("indirect", "can you put down a call with {X}"), ("indirect", "would you log my call with {X}")],
    "delete": [("command", "delete {X}"), ("command", "get rid of {X}"), ("command", "wipe {X}"), ("command", "clear out {X}"),
               ("command", "kill {X}"), ("question", "can we delete {X}?"), ("question", "delete {X}?"), ("question", "shall i get rid of {X}?"),
               ("indirect", "can you delete {X}"), ("indirect", "could you get rid of {X}"), ("indirect", "can you wipe {X}"),
               ("indirect", "would you delete {X} for me")],
})


def verb_frame(ctx: Ctx, r, verb: str):
    frames = VERB_FRAMES[verb]
    i = r.randrange(len(frames))
    return i, frames[i][0], phone(frames[i][1], r)


def can_verb(v: Vault, verb: str, row: dict) -> bool:
    spec = VERBS[verb]
    return not row.get("me") and row["kind"] in spec["kinds"] and spec["ok"](v, row)


def block_hits(v: Vault, text: str) -> int:
    return v.block_hits(text)


def key_safe(v: Vault, row: dict, text: str) -> bool:
    """A pick by `$key` needs the row in the block of the turn: safe when few rows fit the words of the message."""
    return block_hits(v, text) <= 5


def verb_candidates(v: Vault, verb: str, kind: str, name: str) -> list[dict]:
    """The rows a by-name `act` would act on: live rows of the kind whose name fits and that the verb can change."""
    return [x for x in v.by_name(kind, name) if can_verb(v, verb, x)]


def twin_sets(v: Vault) -> dict[str, list[list[dict]]]:
    """The twins a world already has: person first names, same name (same kind), container names across kinds."""
    out: dict[str, list[list[dict]]] = {"first": [], "same": [], "container": []}
    first = collections.defaultdict(list)
    for p in v.of("person"):
        if not p.get("me") and toks(p["name"])[0] not in HONORIFICS:  # "Dr. Mehta" and "Dr. Rao" are no pair of first names
            first[toks(p["name"])[0]].append(p)
    out["first"] = [x for x in first.values() if 2 <= len(x) <= 4]
    same = collections.defaultdict(list)
    for kind in ("task", "event", "note", "document", "photo", "debt"):
        for r_ in v.of(kind):
            same[(kind, tuple(toks(r_["name"])))].append(r_)
    out["same"] = [x for x in same.values() if 2 <= len(x) <= 12]
    cont = collections.defaultdict(list)
    for r_ in v.rows.values():
        if r_["live"] and r_["kind"] in ("list", "album", "notebook", "folder", "group"):
            cont[tuple(toks(r_["name"]))].append(r_)
    out["container"] = [x for x in cont.values() if len({y["kind"] for y in x}) >= 2]
    return out


# =============================================================================================================
# the pre-grounding block (search.rs `preground`): which rows a first message puts in front of the model. A `$key` the block
# does not show cannot be resolved ("ref names $x before the runtime showed it"), so a pair whose first message leaves one out is
# not generated. Containers are listed in the system prompt and always resolve.
# =============================================================================================================

PG_STOPWORDS = set("""the and for with what whats who when where which how have has had did does can could would should will are was were you your our his
her their them they this that these those from into about any all some been not but out get got please show tell list find give make add put set move mark last next
today tomorrow yesterday week month year there here just also then than too very much many more most one two""".split())
PG_SHORT_STOP = set("to of in on is it my me do be so at as by we us up or no go an if he hi ok am oh re vs".split())
PG_VERB_FORMS = set("""stars starred starring unstarred deleted deleting deletes completed completing completes done finish finished cancelled canceled cancelling
canceling cancels restored restoring restores logged logging logs reopened reopening rescheduled rescheduling postpone postponed push pushed move moved created
creating new edited editing change changed update updated rename renamed added adding removed removing settled settling pay paid revealed revealing undone trash
trashed pin pinned unpin archive archived mark marked open opened remind save saved create edit reschedule complete reopen cancel delete restore star unstar add to
remove from log settle up debt reveal undo""".split())
PG_CAP = 8
PG_CONTAINERS = {"group", "list", "notebook", "folder", "album"}
KIND_ORDER = ["person", "group", "event", "task", "note", "document", "photo", "album", "debt", "locker item", "notebook", "folder", "list"]


def spoken(text: str) -> list[str]:
    """search.rs `spoken_words`: folded words, the possessive 's dropped."""
    return toks(re.sub(r"(?<=[A-Za-z0-9])['\u2019\u2018`][sS](?![A-Za-z0-9])", "", text))


def block_keys(v: "Vault", message: str, slack: int = 1) -> list[str]:
    """The keys the pre-grounding block shows for a first message (a port of `preground`: tokens of three letters or more that are no
    filler and no verb, rows ranked by an exact name, its length, the tokens that reach it and how well, containers before leaves; the
    cap of eight with no kind past half, a name many rows share cut to six). `slack` rows are kept back for the container and
    own-row lines the real block may put first."""
    words = spoken(message)
    said = set(words)
    tokens = []
    for t in words:
        if len(t) >= 3 and t not in PG_STOPWORDS and t not in PG_VERB_FORMS and t not in tokens:
            tokens.append(t)
    found = []
    for r in v.rows.values():
        if not r["live"]:
            continue
        names = [spoken(r["name"])] + ([spoken(r["nickname"])] if r.get("nickname") else [])
        hits = score = 0
        for t in tokens:
            best = max((3 if t == w else 2 if w.startswith(t) else 0 for name in names for w in name), default=0)
            if best >= 2:
                hits += 1
                score += best
        spans = [len(n) for n in names if n and all(w in said for w in n)
                 and (hits > 0 or any(len(w) == 2 and any(c.isalpha() for c in w) and w not in PG_SHORT_STOP and w not in PG_VERB_FORMS for w in n))]
        span = max(spans, default=0)
        if hits == 0 and not span:
            continue
        found.append((r, bool(span), span, hits, score))
    # a name many rows share is cut to the six nearest to today
    runs = collections.defaultdict(list)
    for item in found:
        runs[(item[0]["kind"], fold(item[0]["name"]))].append(item)
    hidden = set()
    for run in runs.values():
        if len(run) > 6:
            near_ = sorted(run, key=lambda it: (abs((it[0]["date"][0] - v.today).days) if it[0].get("date") else 10 ** 6, it[0]["key"]))
            hidden |= {it[0]["key"] for it in near_[6:]}
    found = [it for it in found if it[0]["key"] not in hidden]

    def rank(it):
        r = it[0]
        return (not it[1], -it[2], -it[3], -it[4], r["kind"] not in PG_CONTAINERS, KIND_ORDER.index(r["kind"]), r["name"].lower(), r["key"])
    found.sort(key=rank)
    room = PG_CAP - slack
    per_kind: collections.Counter = collections.Counter()
    chosen, waiting = [], []
    for it in found:
        if len(chosen) == room:
            break
        if per_kind[it[0]["kind"]] < PG_CAP // 2:
            per_kind[it[0]["kind"]] += 1
            chosen.append(it)
        else:
            waiting.append(it)
    for it in waiting:
        if len(chosen) == room:
            break
        chosen.append(it)
    return [it[0]["key"] for it in chosen]


def unseen_keys(v: "Vault", item: "Item") -> list[str]:
    """`$key` references of the first turn that the block of its message does not show (containers always resolve)."""
    t = item.turns[0]
    shown = None
    out = []
    for c in t.ref:
        a = c.get("args") or {}
        for field in ("rows", "linked_to", "within", "exclude", "args"):
            for key in re.findall(r"\$([A-Za-z0-9_]+)", str(a.get(field) or "")):
                row = v.rows.get(key)
                if row is None or row["kind"] in PG_CONTAINERS or key == "me":
                    continue
                if shown is None:
                    shown = set(block_keys(v, t.user))
                if key not in shown and key not in out:
                    out.append(key)
    return out


# =============================================================================================================
# the runtime's pick ambiguity (SPEC 3, item 3c; act.rs `ambiguous_pick`): a by-name or by-`#n` write whose message words fit
# several rows of the kind ends in an ask. Drills predict it from the call and the messages, and leave such a pair out.
# =============================================================================================================

UNNAMING = {"the", "a", "an", "to", "on", "in", "at", "for", "of", "and", "my", "with", "from", "by", "is", "be", "as", "up", "off", "out", "do", "did", "i", "me",
            "we", "you", "was", "just", "please", "now", "all", "s", "tick", "star", "unstar", "cancel", "delete", "restore", "complete", "reopen", "move",
            "push", "add", "put", "file", "remove", "take", "mark", "log", "settle", "reveal", "undo"}
PICKED = {"it", "them", "that", "this", "those", "these", "he", "she", "her", "him", "his", "they", "one", "ones", "too", "also", "same", "again", "both",
          "other", "another", "first", "second", "third", "last", "latest", "previous", "next", "earlier", "later", "open", "done", "finished", "paid", "old",
          "new", "oldest", "newest"}
STEM_SUFFIXES = ("ations", "ation", "ings", "ing", "ions", "ion", "ated", "ates", "ed", "es", "s")
DATE_WORDS = set(WEEKDAYS) | {d + "s" for d in WEEKDAYS} | set(MONTHS) | {"today", "tomorrow", "tonight", "yesterday", "week", "weekend", "month", "year", "every", "each",
                                                                       "everyone", "everything", "everybody", "whole"}


def _stem(w: str) -> str:
    out = w
    for suf in STEM_SUFFIXES:  # the runtime takes the first suffix (in this order) that leaves four letters
        if out.endswith(suf) and len(out) - len(suf) >= 4:
            out = out[: -len(suf)]
            break
    return out[:-1] if out.endswith("e") and len(out) - 1 >= 4 else out


def near(name: str, word: str) -> bool:
    """act.rs `near`: a word of a name that a message word stands for (the same word in another form, one letter off in a word of
    five or more that starts alike, the digits of a numbered name)."""
    if name == word:
        return True
    if word.isdigit():
        rest = name[len(word):] if name.startswith(word) else None
        return rest is not None and len(rest) == 1 and rest.isalpha()
    if _stem(name) == _stem(word) and len(_stem(name)) >= 4:
        return True
    if len(name) < 5 or len(word) < 5 or abs(len(name) - len(word)) > 1 or name[0] != word[0]:
        return False
    common = next((i for i, (x, y) in enumerate(zip(name, word)) if x != y), min(len(name), len(word)))
    tail = next((i for i, (x, y) in enumerate(zip(reversed(name), reversed(word))) if x != y), min(len(name), len(word)))
    return common + tail + 1 >= max(len(name), len(word))


def would_ask(v: "Vault", call: dict, message: str, prev_message: str = "") -> bool:
    """Whether the runtime would answer this by-name or by-`$key` write with the ask it composes at an ambiguous pick (it reads the call
    and the message words; focus and dates that could still settle it are not modelled, so this errs toward asking)."""
    a = call.get("args") or {}
    if call.get("tool") != "act" or a.get("verb") in (None, "create", "undo") or any(a.get(k) for k in ("where", "when", "linked_to", "within", "exclude")):
        return False
    applies = (lambda r: can_verb(v, a["verb"], r)) if a["verb"] in VERBS else (lambda r: r["live"] and not r.get("me"))  # noqa: E731
    if a.get("rows"):
        keys = [x.strip().lstrip("$") for x in str(a["rows"]).split(",")]
        if len(keys) != 1 or keys[0] not in v.rows:
            return False
        row = v.rows[keys[0]]
    elif a.get("name") and a.get("kind"):
        hits = [r for r in v.by_name(a["kind"], a["name"]) if applies(r)]
        if len(hits) != 1:
            return False
        row = hits[0]
    else:
        return False
    words = toks(message)
    if any(w in PICKED or w in DATE_WORDS or w.rstrip("s") in WEEKDAYS or re.fullmatch(r"\d+(st|nd|rd|th)", w) for w in words):
        return False
    name_words = toks(row["name"])
    names_it = lambda w: w not in UNNAMING and any(near(n, w) for n in name_words)  # noqa: E731
    if not any(names_it(w) for w in words):
        return False
    spoken = list(words) + [w for w in toks(prev_message) if w not in words]
    reference = [w for w in spoken if names_it(w)]
    fits = [r for r in v.of(row["kind"]) if all(any(near(n, w) for n in toks(r["name"])) for w in reference)]
    if len(fits) < 2 or row["key"] not in {r["key"] for r in fits}:
        return False
    in_full = [r for r in fits if (ws := [n for n in toks(r["name"]) if n not in UNNAMING]) and all(any(near(n, w) for w in spoken) for n in ws)]
    if [r["key"] for r in in_full] == [row["key"]]:
        return False
    return sum(1 for r in fits if applies(r)) >= 2


# =============================================================================================================
# REF: a referent with a decoy in view; the pair flips which twin is meant
# =============================================================================================================

SIMPLE_ROLE = re.compile(r"^[a-z][a-z ]+$")


def set_name_options(v: Vault, S: list[dict]) -> list[tuple[str, str]]:
    """Names (text in the message, name argument) that fit exactly the rows of a same-name set and nothing else."""
    kind = S[0]["kind"]
    want = {x["key"] for x in S}
    out = []
    full = S[0]["name"]
    if {x["key"] for x in v.by_name(kind, full)} == want:
        out.append((full.lower(), full))
    tk = [t for t in toks(full) if len(t) >= 3 and t not in STOP]
    for n in (1, 2):
        for combo in itertools.combinations(tk, n):
            text = " ".join(combo)
            if {x["key"] for x in v.by_name(kind, text)} == want and (text, text) not in out:
                out.append((text, text))
    return out


def role_phrases(first: str, role: str, vi: int) -> str:
    return [f"{first}, the {role}", f"{first} the {role}", f"the {role} one, {first}", f"{first} who's the {role}"][vi % 4]


def twin_person_pairs(v: Vault):
    out = []
    for S in twin_sets(v)["first"]:
        for a, b in itertools.permutations(S, 2):
            out.append((a, b, S))
    return out


NAME_DROP = 0.15  # the share of natural role-clause writes that name the person by the role alone (drill_dist.py: a name beside the role in 15 of 54)


def part_say(role: str, kw: str, say_full: bool) -> str:
    """The words a message says for a role condition `contains kw`: the word alone when it is the head of the role ("the chairman" for
    "estate chairman") and the pair does not say the whole role, else the whole role ("the bengaluru cousin" for `contains "Bengaluru"`)."""
    return kw if (not say_full and role_head(role) and fold(kw) == fold(role_head(role))) else role


def role_clauses(v: Vault, form: str, a: dict, b: dict, first: str, say_full: bool):
    """How the role clause of a message names twin `a` or `b` (two people of one first name) and the condition it becomes, in one form of
    the natural mix of role conditions (TEXT_MIX): `=` the whole role, `contains` the whole role, `contains` a word of it (the clause then
    says that word, or the whole role when `say_full`: "tunde, the estate chairman" is `role contains "chairman"`). {key: (the words the
    message says, the condition)}, or None when the form does not single each twin out among the people of that first name."""
    out = {}
    for P, Q in ((a, b), (b, a)):
        role = P["role"]
        if form == "part":
            kws = [k for k in role_parts(role) if fold(k) not in fold(Q["role"])]
            if not kws:
                return None
            cond, say = ("role", "contains", kws[0]), part_say(role, kws[0], say_full)
        else:
            cond, say = ("role", "=" if form == "eq" else "contains", role), role
        if v.select("person", name=first, where=[cond]) != [P["key"]]:
            return None
        out[P["key"]] = (say.lower(), cond)
    return out


def pick_role_twins(v: Vault, r, cands: list):
    """(a, b, S, first, form, clauses): a pair of namesakes and the form of its role clause. The form is drawn first, in the natural mix of
    role conditions (TEXT_MIX), then a pair that can take it; a world with no such pair (a word of a role that tells the namesakes apart
    needs roles of two words) makes none, the slot going to another template, so the drills' role conditions keep the mix instead of
    falling back on `=`. Both siblings of a pair share the form."""
    mix = dict(zip(FORMS, TEXT_MIX["role"]))
    pool = list(cands)
    r.shuffle(pool)
    say_full = r.random() < 0.5
    form = r.choices(FORMS, [mix[f] for f in FORMS])[0]
    for a, b, S in pool:
        first = a["name"].split()[0]
        clauses = role_clauses(v, form, a, b, first, say_full)
        if clauses is not None:
            return a, b, S, first, form, clauses
    return None


def drops_name(v: Vault, r, clauses: dict) -> bool:
    """Whether the pair's calls name the person by the role condition alone (NAME_DROP of the pairs, when each condition singles its person out
    among everyone): the natural sessions do, "log a message with priya, the treasurer one" is `role contains "treasurer"` and no name."""
    drop = r.random() < NAME_DROP
    return drop and all(v.select("person", where=[cond]) == [key] for key, (_say, cond) in clauses.items())


def _person_verb(v: Vault, P1: dict, P2: dict, r) -> str | None:
    opts = ["log"]
    if not P1["starred"] and not P2["starred"]:
        opts.append("star")
    if P1["starred"] and P2["starred"]:
        opts.append("unstar")
    return r.choice(opts)


def ref_role(ctx: Ctx, r):
    """R1: two people share a first name; the message says which by their role."""
    v = ctx.v
    cands = [(a, b, S) for a, b, S in twin_person_pairs(v) if a["key"] < b["key"] and a.get("role") and b.get("role")
             and SIMPLE_ROLE.match(a["role"].lower()) and SIMPLE_ROLE.match(b["role"].lower()) and a["role"] != b["role"]]
    if not cands:
        return None
    got = pick_role_twins(v, r, cands)
    if got is None:
        return None
    a, b, S, first, form, clauses = got
    verb = _person_verb(v, a, b, r)
    vi = r.randrange(4)
    fi, mood, frame = verb_frame(ctx, r, verb)
    drop = drops_name(v, r, clauses)
    turns = []
    for P in (a, b):
        say, cond = clauses[P["key"]]
        ref = C("act", verb=verb, kind="person", name=None if drop else first, where=cond_text(cond), args=VERBS[verb].get("args"))
        turns.append(Turn(fill(frame, role_phrases(first.lower(), say, vi)), gold_diff([VERBS[verb]["gold"](v, P["key"])]), [ref]))
    return (make_item(ctx, "REF", "role", f"{verb}.{fi}", "which twin: role", [turns[0]], tags=("person", verb)),
            make_item(ctx, "REF", "role", f"{verb}.{fi}", "which twin: role", [turns[1]], tags=("person", verb)))


def pick_role_people(v: Vault, r, verb: str):
    """Two people the role alone names: (form, [(person, condition, the words a message says)] x 2). The form is drawn in the natural mix of
    role conditions (TEXT_MIX), then two people the verb applies to whose condition in that form singles each out among everyone (a form that
    fewer than two can take is dropped and drawn again); the words are the whole role, or a word of it (the whole role in half the pairs
    that take a word)."""
    people = [p for p in v.of("person") if not p.get("me") and p.get("role") and SIMPLE_ROLE.match(p["role"].lower()) and can_verb(v, verb, p)]
    forms = list(FORMS)
    mix = dict(zip(FORMS, TEXT_MIX["role"]))
    say_full = r.random() < 0.5
    r.shuffle(people)
    while forms:
        form = r.choices(forms, [mix[f] for f in forms])[0]
        found = []
        for P in people:
            role = P["role"]
            conds = [(("role", "contains", k), part_say(role, k, say_full)) for k in role_parts(role)] if form == "part" \
                else [(("role", "=" if form == "eq" else "contains", role), role)]
            for cond, say in conds:
                if v.select("person", where=[cond]) == [P["key"]]:
                    found.append((P, cond, say.lower()))
                    break
        if len(found) >= 2:
            return form, found[:2]
        forms.remove(form)
    return None


def ref_roleonly(ctx: Ctx, r):
    """R10: a person named by the role alone, "star the drummer": the natural sessions write no name for it (39 of the 54 role conditions of
    a person write), `role contains "drummer"` or `role = "drummer"`. The role clause is in the natural mix of forms (TEXT_MIX) and singles the
    person out among everyone; the pair flips which role the message says."""
    v = ctx.v
    verb = r.choice(["star", "star", "unstar", "log", "log"])
    got = pick_role_people(v, r, verb)
    if got is None:
        return None
    form, pair = got
    fi, mood, frame = verb_frame(ctx, r, verb)
    turns = [Turn(fill(frame, f"the {say}"), gold_diff([VERBS[verb]["gold"](v, P["key"])]),
                  [C("act", verb=verb, kind="person", where=cond_text(cond), args=VERBS[verb].get("args"))]) for P, cond, say in pair]
    return (make_item(ctx, "REF", "role-only", f"{verb}.{fi}", "which person: the role alone", [turns[0]], tags=("person", verb)),
            make_item(ctx, "REF", "role-only", f"{verb}.{fi}", "which person: the role alone", [turns[1]], tags=("person", verb)))


def ref_clause(ctx: Ctx, r):
    """R9: the same clause, "star pete, the removalist", where the first name alone names one person (the clause only says what he does:
    no filter) against where a namesake shares it (the clause is the filter). The natural sessions filter on a trailing role clause when
    the name is shared and leave it out when it is not; the pair flips which of the two the message is about."""
    v, bank = ctx.v, ctx.bank
    cands = [(a, b, S) for a, b, S in twin_person_pairs(v) if a["key"] < b["key"] and a.get("role") and b.get("role")
             and SIMPLE_ROLE.match(a["role"].lower()) and SIMPLE_ROLE.match(b["role"].lower()) and a["role"] != b["role"]]
    if not cands:
        return None
    got = pick_role_twins(v, r, cands)
    if got is None:
        return None
    a, b, S, first, form, clauses = got
    verb = _person_verb(v, a, b, r)
    solos = [p for p in v.of("person") if not p.get("me") and p.get("role") and SIMPLE_ROLE.match(p["role"].lower()) and bank.first_unique(p)
             and can_verb(v, verb, p) and p["key"] not in {x["key"] for x in S}]
    if not solos:
        return None
    U = r.choice(solos)
    P = r.choice([a, b])
    say, cond = clauses[P["key"]]
    vi = r.randrange(4)
    fi, mood, frame = verb_frame(ctx, r, verb)
    solo = Turn(fill(frame, role_phrases(U["name"].split()[0].lower(), U["role"].lower(), vi)), gold_diff([VERBS[verb]["gold"](v, U["key"])]),
                [C("act", verb=verb, kind="person", name=U["name"].split()[0], args=VERBS[verb].get("args"))])
    twin = Turn(fill(frame, role_phrases(first.lower(), say, vi)), gold_diff([VERBS[verb]["gold"](v, P["key"])]),
                [C("act", verb=verb, kind="person", name=first, where=cond_text(cond), args=VERBS[verb].get("args"))])
    sides = [solo, twin] if r.random() < 0.5 else [twin, solo]
    return (make_item(ctx, "REF", "clause", f"{verb}.{fi}", "a role clause: a filter only when the name is shared", [sides[0]], tags=("person", verb)),
            make_item(ctx, "REF", "clause", f"{verb}.{fi}", "a role clause: a filter only when the name is shared", [sides[1]], tags=("person", verb)))


def ref_group(ctx: Ctx, r):
    """R2: two people share a first name; the message says which by the group they are in."""
    v = ctx.v
    cands = []
    for a, b, S in twin_person_pairs(v):
        if a["key"] >= b["key"]:
            continue
        ga = [g for g in v.of("group") if a["key"] in g["members"] and b["key"] not in g["members"]]
        gb = [g for g in v.of("group") if b["key"] in g["members"] and a["key"] not in g["members"]]
        if ga and gb:
            cands.append((a, b, ga, gb))
    if not cands:
        return None
    a, b, ga, gb = r.choice(cands)
    ga_, gb_ = r.choice(ga), r.choice(gb)
    verb = _person_verb(v, a, b, r)
    first = a["name"].split()[0]
    conn = r.choice(["from {g}", "in {g}", "from the {g} group", "that's in {g}"])
    fi, mood, frame = verb_frame(ctx, r, verb)
    turns = []
    for P, G in ((a, ga_), (b, gb_)):
        if v.select("person", name=first, linked_to=G["key"]) != [P["key"]]:
            return None
        x = f"{first.lower()} " + conn.format(g=G["name"].lower())
        ref = C("act", verb=verb, kind="person", name=first, linked_to=f"${G['key']}", args=VERBS[verb].get("args"))
        turns.append(Turn(fill(frame, x), gold_diff([VERBS[verb]["gold"](v, P["key"])]), [ref]))
    return (make_item(ctx, "REF", "group", f"{verb}.{fi}", "which twin: group", [turns[0]], tags=("person", verb)),
            make_item(ctx, "REF", "group", f"{verb}.{fi}", "which twin: group", [turns[1]], tags=("person", verb)))


def ref_nick(ctx: Ctx, r):
    """R7: two people share a first name and one has a nickname: the nickname names that one, the full name the other."""
    v = ctx.v
    cands = []
    for S in twin_sets(v)["first"]:
        for P in S:
            nk = P.get("nickname")
            if not nk or len(v.by_name("person", nk)) != 1 or set(toks(nk)) & NOT_NAME or len(nk) < 3:
                continue
            for Q in S:
                if Q["key"] != P["key"] and len(toks(Q["name"])) >= 2 and [x["key"] for x in v.by_name("person", Q["name"])] == [Q["key"]]:
                    cands.append((P, Q))
    if not cands:
        return None
    P, Q = r.choice(cands)
    verb = _person_verb(v, P, Q, r)
    fi, mood, frame = verb_frame(ctx, r, verb)
    turns = []
    for row, text, arg in ((P, P["nickname"].lower(), P["nickname"]), (Q, Q["name"].lower(), Q["name"])):
        ref = C("act", verb=verb, kind="person", name=arg, args=VERBS[verb].get("args"))
        turns.append(Turn(fill(frame, text), gold_diff([VERBS[verb]["gold"](v, row["key"])]), [ref]))
    return (make_item(ctx, "REF", "nick", f"{verb}.{fi}", "which twin: nickname vs full name", [turns[0]], tags=("person", verb)),
            make_item(ctx, "REF", "nick", f"{verb}.{fi}", "which twin: nickname vs full name", [turns[1]], tags=("person", verb)))


def when_phrases(ctx: Ctx, kind: str):
    return [p for p in ctx.ph if p.fam in ("weekday", "day", "week", "weekend", "month", "named")]


def date_connect(kind: str, p: Ph, vi: int) -> str:
    """A date phrase joined to a row's name: 'due friday' / 'due on friday', 'on friday' / 'friday', 'for next week' / 'next week'
    (never 'on tomorrow', 'for in april', 'due on today')."""
    t = p.text
    if kind == "task":
        return "due on " + t if (p.fam in ("weekday", "abs") and vi % 2) else "due " + t
    if p.fam == "abs":
        return "on " + t
    if p.fam == "weekday":
        return ["on " + t, t][vi % 2]
    if p.fam in ("week", "month", "weekend") or (p.fam == "named" and not t.startswith("in ")):
        return ["for " + t, t][vi % 2]
    return t


def ref_date(ctx: Ctx, r):
    """R3: same-name rows (an event that repeats, a task that comes round); the message settles it by a date phrase."""
    v = ctx.v
    sets = [S for S in twin_sets(v)["same"] if S[0]["kind"] in ("event", "task") and len(S) >= 2 and set_name_options(v, S)]
    if not sets:
        return None
    S = r.choice(sets)
    kind = S[0]["kind"]
    verbs = ["cancel", "delete"] if kind == "event" else ["complete", "reopen", "delete"]
    verb = r.choice(verbs)
    cand = [x for x in S if can_verb(v, verb, x)]
    if len(cand) < 2:
        return None
    phs = [p for p in when_phrases(ctx, kind) if p.future or verb in ("reopen", "delete")]
    single = {}
    for p in phs:
        res = resolve(p.expr, v.now)
        hit = [x for x in cand if contains(res, x["date"])]
        if len(hit) == 1:
            single[p.text] = (p, hit[0])
    byfam = collections.defaultdict(list)
    for p, row in single.values():
        byfam[p.fam].append((p, row))
    fams = [f for f, xs in byfam.items() if len({x[1]["key"] for x in xs}) >= 2]
    if not fams:
        return None
    fam = r.choice(fams)
    xs = byfam[fam]
    (p1, r1), (p2, r2) = r.sample([x for x in xs], 2)
    if r1["key"] == r2["key"]:
        return None
    name_text, name_arg = r.choice(set_name_options(v, S))
    vi = r.randrange(2)
    fi, mood, frame = verb_frame(ctx, r, verb)
    turns = []
    for p, row in ((p1, r1), (p2, r2)):
        x = f"{name_text} {date_connect(kind, p, vi)}"
        ref = C("act", verb=verb, kind=kind, name=name_arg, when=jx(p.expr))
        turns.append(Turn(fill(frame, x), gold_diff([VERBS[verb]["gold"](v, row["key"])]), [ref]))
    sh = p1.shape
    return (make_item(ctx, "REF", "date", f"{verb}.{fi}", "which twin: date", [turns[0]], shape=sh, tags=(kind, verb)),
            make_item(ctx, "REF", "date", f"{verb}.{fi}", "which twin: date", [turns[1]], shape=p2.shape, tags=(kind, verb)))


def ref_state(ctx: Ctx, r):
    """R4: same-name tasks, one open and one finished; complete picks the open one, reopen the finished one."""
    v = ctx.v
    sets = []
    for S in twin_sets(v)["same"]:
        if S[0]["kind"] != "task" or not set_name_options(v, S):
            continue
        co = [x for x in S if can_verb(v, "complete", x)]
        re_ = [x for x in S if can_verb(v, "reopen", x)]
        if len(co) == 1 and len(re_) == 1:
            sets.append((S, co[0], re_[0]))
    if not sets:
        return None
    S, o, d = r.choice(sets)
    name_text, name_arg = r.choice(set_name_options(v, S))
    i = r.randrange(len(VERB_FRAMES["complete"]))
    turns = []
    for verb, row in (("complete", o), ("reopen", d)):
        mood, frame = VERB_FRAMES[verb][i]
        frame = phone(frame, ctx.rng("ref_state", i, verb, name_arg))
        ref = C("act", verb=verb, kind="task", name=name_arg)
        turns.append(Turn(fill(frame, name_text), gold_diff([VERBS[verb]["gold"](v, row["key"])]), [ref]))
    return (make_item(ctx, "REF", "state", f"complete-reopen.{i}", "verb: complete vs reopen", [turns[0]], tags=("task",)),
            make_item(ctx, "REF", "state", f"complete-reopen.{i}", "verb: complete vs reopen", [turns[1]], tags=("task",)))


CHILD_KIND = {"list": "task", "album": "photo", "notebook": "note", "folder": "document", "group": "person"}
CONT_READ_FRAMES = [("command", "show me what's in the {n} {kw}"), ("command", "open up the {n} {kw}"), ("command", "list everything in the {n} {kw}"),
                    ("command", "pull up the {n} {kw}"), ("question", "what's in the {n} {kw}?"), ("question", "what's in my {n} {kw}"),
                    ("question", "what have i got in the {n} {kw}?"), ("question", "the {n} {kw}?"),
                    ("indirect", "can you show me what's in the {n} {kw}"), ("indirect", "could you list the {n} {kw}"),
                    ("indirect", "can i see the {n} {kw}"), ("indirect", "can you open the {n} {kw}")]
CONT_COUNT_FRAMES = [("command", "count what's in the {n} {kw}"), ("command", "tell me how many are in the {n} {kw}"),
                     ("question", "how many are in the {n} {kw}?"), ("question", "how many things in the {n} {kw}"),
                     ("question", "how many have i got in the {n} {kw}?"), ("question", "{n} {kw} count?"),
                     ("indirect", "can you count what's in the {n} {kw}"), ("indirect", "could you tell me how many are in the {n} {kw}"),
                     ("indirect", "can you tell me how many are in my {n} {kw}")]


def container_gold(ctx: Ctx, C_: dict, count: bool, msg: str):
    v = ctx.v
    ck = CHILD_KIND[C_["kind"]]
    keys = v.select(ck, linked_to=C_["key"])
    if v.active_default(ck, C_["key"], [], msg):
        keys = [k for k in keys if v.rows[k]["status"] in ACTIVE]
    ref = C("answer", op="count" if count else None, kind=ck, linked_to=f"${C_['key']}")
    return keys, ref


def ref_container(ctx: Ctx, r):
    """R5: a list and an album (a notebook and a folder...) share a name; the kind word in the message decides."""
    v = ctx.v
    sets = [S for S in twin_sets(v)["container"]]
    if not sets:
        return None
    S = r.choice(sets)
    a, b = r.sample([x for x in S if x["kind"] in CHILD_KIND], 2) if len([x for x in S if x["kind"] in CHILD_KIND]) >= 2 else (None, None)
    if a is None or a["kind"] == b["kind"]:
        return None
    count = r.random() < 0.4
    frames = CONT_COUNT_FRAMES if count else CONT_READ_FRAMES
    fi = r.randrange(len(frames))
    mood, frame = frames[fi]
    frame = phone(frame, r)
    turns = []
    keys_ab = []
    for C_ in (a, b):
        text = frame.replace("{n}", C_["name"].lower()).replace("{kw}", C_["kind"])
        text = tidy(text)
        keys, ref = container_gold(ctx, C_, count, text)
        if not count and (not keys or len(keys) > ROW_CAP):
            return None
        if count and len(keys) == 0:
            return None
        keys_ab.append(keys)
        turns.append(Turn(text, gold_val(len(keys)) if count else gold_rows(keys), [ref]))
    if keys_ab[0] == keys_ab[1] or (count and len(keys_ab[0]) == len(keys_ab[1])):
        return None
    return (make_item(ctx, "REF", "container", f"{'count' if count else 'read'}.{fi}", "which twin: container kind", [turns[0]], tags=("container",)),
            make_item(ctx, "REF", "container", f"{'count' if count else 'read'}.{fi}", "which twin: container kind", [turns[1]], tags=("container",)))


T2_IT = {
    "log": [("command", "and log a call with that one"), ("command", "also log a call with them"), ("command", "now log a call with that one"),
            ("command", "then note that i rang them"), ("question", "can i log a call with them too?"), ("question", "log a call with that one as well?"),
            ("indirect", "can you also log a call with them"), ("indirect", "could you log a call with that one now")],
    "reopen": [("command", "actually put it back on my list"), ("command", "no wait, reopen it"), ("command", "reopen it"),
               ("command", "un-tick it, i hadn't finished"), ("question", "can we reopen it?"), ("question", "reopen it again?"),
               ("indirect", "can you reopen it"), ("indirect", "could you put it back on my list")],
    "delete": [("command", "actually delete it"), ("command", "no wait, get rid of it"), ("command", "delete it"), ("command", "wipe it"),
               ("question", "can we delete it?"), ("question", "delete it too?"), ("indirect", "can you delete it"), ("indirect", "could you get rid of it")],
}


def ref_focus(ctx: Ctx, r):
    """R6: turn 1 writes the target (the twin is named by role, date), turn 2 says 'it' / 'that one': the focus decides."""
    v = ctx.v
    mode = r.choice(["person", "task", "event"])
    if mode == "person":
        by_role = r.random() < 0.5  # turn 1 names the person by the role alone ("star the drummer", the natural way), else a namesake by the clause
        if by_role:
            got = pick_role_people(v, r, "star")
            if got is None:
                return None
            form, pair = got
            people = [(P, f"the {say}", cond, None) for P, cond, say in pair]
        else:
            cands = [(a, b, S) for a, b, S in twin_person_pairs(v) if a["key"] < b["key"] and a.get("role") and b.get("role")
                     and SIMPLE_ROLE.match(a["role"].lower()) and SIMPLE_ROLE.match(b["role"].lower()) and a["role"] != b["role"]
                     and not a["starred"] and not b["starred"]]
            if not cands:
                return None
            got = pick_role_twins(v, r, cands)
            if got is None:
                return None
            a, b, S, first, form, clauses = got
            drop = drops_name(v, r, clauses)
            vi = r.randrange(4)
            people = [(P, role_phrases(first.lower(), clauses[P["key"]][0], vi), clauses[P["key"]][1], None if drop else first) for P in (a, b)]
        fi, mood, frame1 = verb_frame(ctx, r, "star")
        t2 = r.randrange(len(T2_IT["log"]))
        msg2 = deco(phone(T2_IT["log"][t2][1], r), pick_deco(r))
        sides = []
        for P, x, cond, nm in people:
            ref1 = C("act", verb="star", kind="person", name=nm, where=cond_text(cond))
            ref2 = C("act", verb="log", rows=f"${P['key']}", args="kind: call")
            sides.append([Turn(fill(frame1, x), gold_diff([VERBS["star"]["gold"](v, P["key"])]), [ref1]),
                          Turn(msg2, gold_diff([VERBS["log"]["gold"](v, P["key"])]), [ref2])])
        fam = f"person.star-log.{fi}.{t2}"
        return (make_item(ctx, "REF", "focus", fam, "which twin: focus", sides[0], tags=("person",)),
                make_item(ctx, "REF", "focus", fam, "which twin: focus", sides[1], tags=("person",)))
    kind = mode
    sets = [S for S in twin_sets(v)["same"] if S[0]["kind"] == kind and set_name_options(v, S)]
    if not sets:
        return None
    S = r.choice(sets)
    v1, v2 = ("complete", "reopen") if kind == "task" else ("cancel", "delete")
    cand = [x for x in S if can_verb(v, v1, x)]
    phs = [p for p in when_phrases(ctx, kind) if p.future]
    single = collections.defaultdict(list)
    for p in phs:
        res = resolve(p.expr, v.now)
        hit = [x for x in cand if contains(res, x["date"])]
        if len(hit) == 1:
            single[p.fam].append((p, hit[0]))
    fams = [f for f, xs in single.items() if len({x[1]["key"] for x in xs}) >= 2]
    if not fams:
        return None
    xs = single[r.choice(fams)]
    (p1, r1), (p2, r2) = r.sample(xs, 2)
    if r1["key"] == r2["key"]:
        return None
    name_text, name_arg = r.choice(set_name_options(v, S))
    vi = r.randrange(2)
    fi, mood, frame1 = verb_frame(ctx, r, v1)
    t2 = r.randrange(len(T2_IT[v2]))
    msg2 = deco(phone(T2_IT[v2][t2][1], r), pick_deco(r))
    sides = []
    for p, row in ((p1, r1), (p2, r2)):
        x = f"{name_text} {date_connect(kind, p, vi)}"
        ref1 = C("act", verb=v1, kind=kind, name=name_arg, when=jx(p.expr))
        ref2 = C("act", verb=v2, rows=f"${row['key']}")
        sides.append([Turn(fill(frame1, x), gold_diff([VERBS[v1]["gold"](v, row["key"])]), [ref1]),
                      Turn(msg2, gold_diff([VERBS[v2]["gold"](v, row["key"])]), [ref2])])
    fam = f"{kind}.{v1}-{v2}.{fi}.{t2}"
    return (make_item(ctx, "REF", "focus", fam, "which twin: focus", sides[0], tags=(kind,)),
            make_item(ctx, "REF", "focus", fam, "which twin: focus", sides[1], tags=(kind,)))


def ref_ask_pick(ctx: Ctx, r):
    """R8: turn 1 is ambiguous and ends in the ask over both twins; turn 2 names which by a word of the name or a date."""
    v = ctx.v
    mode = r.choice(["person", "event"])
    if mode == "person":
        cands = [(a, b, S) for a, b, S in twin_person_pairs(v) if a["key"] < b["key"] and len(toks(a["name"])) >= 2 and len(toks(b["name"])) >= 2
                 and toks(a["name"])[-1] != toks(b["name"])[-1]]
        if not cands:
            return None
        a, b, S = r.choice(cands)
        verb = _person_verb(v, a, b, r)
        first = a["name"].split()[0]
        fi, mood, frame1 = verb_frame(ctx, r, verb)
        cand = [x for x in S if can_verb(v, verb, x)]
        if len(cand) < 2:
            return None
        t1 = fill(frame1, first.lower())
        sel = verb_candidates(v, verb, "person", first)
        if len(sel) < 2 or len(sel) > ROW_CAP:
            return None
        ask_ref = [C("act", verb=verb, kind="person", name=first, args=VERBS[verb].get("args")),
                   C("ask", question=f"{' or '.join(x['name'] for x in sel)}?", options=", ".join(f"${x['key']}" for x in sel))]
        t2i = r.randrange(6)
        t2f = ["{ln}", "the {ln} one", "{ln} please", "{ln}, the one i mean", "it's {ln}", "the {ln}"][t2i]
        sides = []
        dco = pick_deco(r)
        for P in (a, b):
            ln = toks(P["name"])[-1]
            sides.append([Turn(t1, gold_ask(*[x["key"] for x in sel]), ask_ref),
                          Turn(deco(phone(t2f.format(ln=ln), r), dco), gold_diff([VERBS[verb]["gold"](v, P["key"])]), [C("act", verb=verb, rows=f"${P['key']}", args=VERBS[verb].get("args"))])])
        fam = f"person.{verb}.{fi}.{t2i}"
        return (make_item(ctx, "REF", "ask-pick", fam, "which twin: after an ask, surname", sides[0], tags=("person", verb)),
                make_item(ctx, "REF", "ask-pick", fam, "which twin: after an ask, surname", sides[1], tags=("person", verb)))
    sets = [S for S in twin_sets(v)["same"] if S[0]["kind"] == "event" and set_name_options(v, S)]
    if not sets:
        return None
    S = r.choice(sets)
    verb = "cancel"
    cand = [x for x in S if x["status"] != "cancelled"]
    if not (2 <= len(S) <= ROW_CAP) or len(cand) < 2:
        return None
    phs = [p for p in when_phrases(ctx, "event") if p.future]
    single = collections.defaultdict(list)
    for p in phs:
        res = resolve(p.expr, v.now)
        hit = [x for x in cand if contains(res, x["date"]) and stamp_dt(x["date"]) >= v.now]
        if len(hit) == 1:
            single[p.fam].append((p, hit[0]))
    fams = [f for f, xs in single.items() if len({x[1]["key"] for x in xs}) >= 2]
    if not fams:
        return None
    (p1, r1), (p2, r2) = r.sample(single[r.choice(fams)], 2)
    if r1["key"] == r2["key"]:
        return None
    name_text, name_arg = r.choice(set_name_options(v, S))
    fi, mood, frame1 = verb_frame(ctx, r, verb)
    t1 = fill(frame1, name_text)
    ask_ref = [C("act", verb=verb, kind="event", name=name_arg),
               C("ask", question=f"which {name_text}?", options=", ".join(f"${x['key']}" for x in S))]
    t2i = r.choice([1, 3, 4] if p1.text.startswith("the ") or p2.text.startswith("the ") else [0, 1, 2, 3, 4])  # no "the the week after next"
    t2f = ["the {p} one", "{p} one", "the one {p}", "{p} please", "{p}"][t2i]
    sides = []
    dco = pick_deco(r)
    for p, row in ((p1, r1), (p2, r2)):
        sides.append([Turn(t1, gold_ask(*[x["key"] for x in S]), ask_ref),
                      Turn(deco(phone(t2f.format(p=p.text), r), dco), gold_diff([VERBS[verb]["gold"](v, row["key"])]), [C("act", verb=verb, rows=f"${row['key']}")])])
    fam = f"event.cancel.{fi}.{t2i}"
    return (make_item(ctx, "REF", "ask-pick", fam, "which twin: after an ask, date", sides[0], shape=p1.shape, tags=("event",)),
            make_item(ctx, "REF", "ask-pick", fam, "which twin: after an ask, date", sides[1], shape=p2.shape, tags=("event",)))


for _n, _f, _w, _fr in (("role", ref_role, 0.5, 48), ("clause", ref_clause, 0.5, 48), ("role-only", ref_roleonly, 1.6, 48), ("nick", ref_nick, 0.9, 48), ("group", ref_group, 1.0, 48), ("date", ref_date, 2.2, 36), ("state", ref_state, 1.2, 12),
                        ("container", ref_container, 1.4, 21), ("focus", ref_focus, 2.0, 16), ("ask-pick", ref_ask_pick, 1.4, 12)):
    register("REF", _n, _f, _w, _fr)


# =============================================================================================================
# CM: create versus modify, and the create's fields
# =============================================================================================================

TASK_NAMES = ["buy milk", "call the plumber", "renew library books", "book flights", "water the plants", "email the landlord", "print the tickets",
              "order a birthday cake", "pick up dry cleaning", "fix the bike light", "post the parcel", "book a haircut", "wash the car",
              "sort the recycling", "refill the prescription", "pay the window cleaner", "charge the camera", "back up my phone", "buy stamps",
              "iron the uniforms", "defrost the freezer", "get a spare key cut", "return the drill", "check the tyre pressure"]
EVENT_NAMES = {"evening": ["dinner", "drinks", "movie night", "party", "dinner with friends", "drinks after work"],
               "morning": ["breakfast", "morning run", "breakfast with a friend", "coffee morning"],
               "plain": ["haircut", "car service", "yoga class", "team lunch", "piano lesson", "eye test", "vet visit", "boiler check"]}
FIRST = ["Dana", "Marcus", "Leila", "Owen", "Tessa", "Ravi", "Noor", "Callie", "Dmitri", "Imogen", "Joaquin", "Freya", "Anton", "Selma"]
LAST = ["Whitlock", "Brandt", "Okafor", "Delgado", "Marsh", "Kapoor", "Lindgren", "Ferreira", "Hale", "Moreau", "Abara", "Quinn", "Vance", "Sorensen"]
ROLES = ["plumber", "dentist", "accountant", "babysitter", "electrician", "neighbour", "tutor", "landlord", "dog walker", "physio", "mechanic", "barber"]
NOTE_TEXT = [("flask", "bring the big flask for nights"), ("parking", "ask about the visitor parking permit"), ("recipe", "swap the butter for olive oil"),
             ("gift", "mum would love the blue scarf"), ("wifi", "router resets on thursdays"), ("coach", "bring the spare kit to training"),
             ("tiles", "grey grout looks better than white"), ("garden", "plant the bulbs before the frost")]


def iso_of(v: Vault, expr: dict) -> str | None:
    res = resolve(expr, v.now)
    if res[0] == "days" and res[1] == res[2]:
        return res[1].isoformat()
    if res[0] == "at":
        return res[1].strftime("%Y-%m-%dT%H:%M")
    return None


def event_span(e: dict) -> tuple[dt.datetime, dt.datetime]:
    s = stamp_dt(e["date"])
    return s, (stamp_dt(e["end"]) if e.get("end") else s + dt.timedelta(minutes=e.get("duration", 60)))


def slot_free(v: Vault, start: dt.datetime, minutes: int = 60) -> bool:
    """No event (live or in the trash, not cancelled) overlaps [start, start+minutes) with a 30 minute margin."""
    end = start + dt.timedelta(minutes=minutes)
    for e in v.of("event", live=False):
        if e["status"] == "cancelled" and e["live"]:
            continue
        s, f = event_span(e)
        if s - dt.timedelta(minutes=30) < end and start < f + dt.timedelta(minutes=30):
            return False
    return True


def new_name(v: Vault, r, bank=TASK_NAMES, kind="task") -> str:
    for _ in range(30):
        n = r.choice(bank)
        if not v.by_name(kind, n) and not any(set(toks(n)) <= set(toks(x["name"])) for x in v.of(kind)):
            return n
    return r.choice(bank)


def cap(text: str) -> str:
    return text[:1].upper() + text[1:]


def has_words(name: str) -> dict:
    ws = [w for w in toks(name) if w not in STOP and len(w) >= 3][:2]
    return {"has": ws or toks(name)[:1]}


CREATE_TASK_FRAMES = [("command", "add a task {X}"), ("command", "new task: {X}"), ("command", "remind me to {X}"), ("command", "make a task {X}"),
                      ("command", "put {X} on my to-do list"), ("question", "can i add a task {X}?"), ("question", "need a task {X}, ok?"),
                      ("question", "any chance of a task {X}?"), ("indirect", "can you add a task {X}"), ("indirect", "could you remind me to {X}"),
                      ("indirect", "can you make a task {X}"), ("indirect", "would you add {X} as a task")]


def task_fields(ctx: Ctx, r):
    """The optional fields of a task create as facets: (id, [(label, text, args line(s), gold fields, link key)])."""
    v = ctx.v
    dates = [p for p in ctx.ph if p.future and p.fam in ("weekday", "day", "week") and iso_of(v, p.expr)]
    lists = [l for l in v.of("list")]
    out = {}
    out["date"] = [(p.text, [f"due {p.text}", f"for {p.text}"], ("date", p.expr), {"date": iso_of(v, p.expr)}, None, p.shape) for p in dates]
    out["list"] = [(l["key"], [f"on the {l['name'].lower()} list", f"for the {l['name'].lower()} list"], ("list", f"${l['key']}"), {}, l["key"], "") for l in lists]
    out["priority"] = [(f"p{n}", [f"priority {n}", f"with priority {n}"], ("priority", str(n)), {"priority": n}, None, "") for n in (1, 2, 3)]
    out["effort"] = [(f"e{n}", [f"it takes {n} minutes", f"about {n} minutes"], ("effort", str(n)), {"effort": n}, None, "") for n in (15, 30, 45, 60)]
    return out


def cm_create_fields(ctx: Ctx, r):
    v = ctx.v
    fields = task_fields(ctx, r)
    k = r.choice([1, 2, 2, 3])
    chosen = r.sample(sorted(fields), k)
    df = r.choice(chosen)
    name = new_name(v, r)
    vi = r.randrange(2)
    fi = r.randrange(len(CREATE_TASK_FRAMES))
    mood, frame = CREATE_TASK_FRAMES[fi]
    frame = phone(frame, r)
    fixed = {f: r.choice(fields[f]) for f in chosen if f != df}
    opts = r.sample(fields[df], 2)
    turns, shapes = [], []
    for o in opts:
        parts = {**fixed, df: o}
        order = ["date", "priority", "effort", "list"]
        posts = [parts[f][1][vi % len(parts[f][1])] for f in order if f in parts]
        x = " ".join([name] + posts)
        args = [f"name: {cap(name)}"]
        gold_f = {"name": has_words(name)}
        links = []
        for f in order:
            if f not in parts:
                continue
            _, _, (fld, val), gf, lk, sh = parts[f]
            if fld == "date":
                args.append(f"date: {jx(val)}")
            else:
                args.append(f"{fld}: {val}")
            gold_f.update(gf)
            if lk:
                links.append(g_link(lk, "new"))
            if sh:
                shapes.append(sh)
        gold = gold_diff([g_new("task", **gold_f)], links)
        turns.append(Turn(fill(frame, x), gold, [C("act", verb="create", kind="task", args="\n".join(args))]))
    return (make_item(ctx, "CM", "create-task", f"{fi}", f"create field: {df}", [turns[0]], shape=shapes[0] if shapes else "", tags=("task", "create")),
            make_item(ctx, "CM", "create-task", f"{fi}", f"create field: {df}", [turns[1]], shape=shapes[-1] if shapes else "", tags=("task", "create")))


ADD_TO_FRAMES = [("command", "add {X} to the {L} list"), ("command", "put {X} on the {L} list"), ("command", "stick {X} on the {L} list"),
                 ("command", "throw {X} on the {L} list"), ("question", "can {X} go on the {L} list?"), ("question", "{X} on the {L} list?"),
                 ("question", "shall we put {X} on the {L} list?"), ("indirect", "can you add {X} to the {L} list"),
                 ("indirect", "could you put {X} on the {L} list"), ("indirect", "can you stick {X} on the {L} list"),
                 ("indirect", "would you add {X} to the {L} list")]


def cm_exists(ctx: Ctx, r):
    """The same words 'add X to the L list': X is not in the vault (a create) or is a task already (a move into L)."""
    v = ctx.v
    lists = [l for l in v.of("list")]
    tasks = [t for t in v.of("task") if t["status"] in ACTIVE and name_options(v, t)]
    if len(lists) < 2 or not tasks:
        return None
    t = r.choice(tasks)
    cands = [l for l in lists if l["key"] != t["list"]]
    if not cands:
        return None
    L = r.choice(cands)
    opt = pick_name(v, t, r)
    if not opt:
        return None
    style, text, name_arg = opt
    new = new_name(v, r)
    fi = r.randrange(len(ADD_TO_FRAMES))
    mood, frame = ADD_TO_FRAMES[fi]
    frame = phone(frame, r)
    ln = L["name"].lower()
    ta = Turn(tidy(frame.replace("{X}", new).replace("{L}", ln)), gold_diff([g_new("task", name=has_words(new))], [g_link(L["key"], "new")]),
              [C("act", verb="create", kind="task", args=f"name: {cap(new)}\nlist: ${L['key']}")])
    changes = [g_link(L["key"], t["key"])]
    if t["list"]:
        changes_unlink = [{"change": "removed", "from": t["list"], "to": t["key"]}]
    else:
        changes_unlink = []
    tb = Turn(tidy(frame.replace("{X}", text).replace("{L}", ln)), gold_diff([], changes + changes_unlink),
              [C("act", verb="add_to", kind="task", name=name_arg, args=f"to: ${L['key']}") if (r.random() < 0.7 or not key_safe(v, t, text)) else C("act", verb="add_to", rows=f"${t['key']}", args=f"to: ${L['key']}")])
    return (make_item(ctx, "CM", "exists", f"{fi}", "the row exists: create vs add_to", [ta], tags=("task", "create")),
            make_item(ctx, "CM", "exists", f"{fi}", "the row exists: create vs add_to", [tb], tags=("task", "add_to")))


RENAME_VS_CREATE = [  # (mood, rename frame with {x} {y}, create frame with {y})
    ("command", "rename the {x} task to {y}", "add a task {y}"), ("command", "call the {x} task {y} instead", "new task {y}"),
    ("command", "change the {x} task to {y}", "make a task {y}"), ("command", "make the {x} task say {y}", "put {y} on my to-do list"),
    ("question", "can we rename the {x} task to {y}?", "can we add a task {y}?"), ("question", "{x} should be called {y}?", "need a task {y}?"),
    ("indirect", "can you rename the {x} task to {y}", "can you add a task {y}"), ("indirect", "could you change the {x} task to {y}", "could you make a task {y}"),
    ("indirect", "would you call the {x} task {y}", "would you add a task {y}"), ("command", "retitle the {x} task as {y}", "remind me to {y}"),
]


def cm_rename(ctx: Ctx, r):
    """Rename an existing task to Y, or make a new task Y: the verb class decides."""
    v = ctx.v
    tasks = [t for t in v.of("task") if name_options(v, t)]
    if not tasks:
        return None
    t = r.choice(tasks)
    opt = pick_name(v, t, r)
    if not opt:
        return None
    style, text, name_arg = opt
    y = new_name(v, r)
    i = r.randrange(len(RENAME_VS_CREATE))
    mood, fr, fc = RENAME_VS_CREATE[i]
    fr, fc = phone(fr, r), phone(fc, r)
    ta = Turn(tidy(fr.replace("{x}", text).replace("{y}", y)), gold_diff([g_upd(t["key"], name=cap(y))]),
              [C("act", verb="edit", kind="task", name=name_arg, args=f"name: {cap(y)}")])
    tb = Turn(tidy(fc.replace("{y}", y)), gold_diff([g_new("task", name=has_words(y))]), [C("act", verb="create", kind="task", args=f"name: {cap(y)}")])
    return (make_item(ctx, "CM", "rename-create", f"{i}", "verb class: edit vs create", [ta], tags=("task", "edit")),
            make_item(ctx, "CM", "rename-create", f"{i}", "verb class: edit vs create", [tb], tags=("task", "create")))


EVT_TASK_FRAMES = [("command", "put {n} {w} {d}"), ("command", "add {n} {w} {d}"), ("command", "stick {n} {w} {d}"), ("command", "pop {n} {w} {d}"),
                   ("question", "can {n} go {w} {d}?"), ("question", "{n} {w} {d}?"), ("indirect", "can you put {n} {w} {d}"),
                   ("indirect", "could you add {n} {w} {d}"), ("indirect", "can you pop {n} {w} {d}")]


def cm_kind(ctx: Ctx, r):
    """Calendar or to-do list: 'put X in the diary friday at 4' is an event, 'put X on my to-do list friday at 4' a task."""
    v = ctx.v
    ph = [p for p in ctx.ph if p.future and p.fam in ("weekday", "day") and p.expr.get("weekday") or p.text in ("tomorrow",)]
    r.shuffle(ph)
    n = r.choice(EVENT_NAMES["plain"])
    hour = r.choice([2, 3, 4, 5, 6])
    for p in ph:
        d = resolve(p.expr, v.now)[1]
        start = dt.datetime.combine(d, dt.time(hour + 12, 0))
        if slot_free(v, start):
            break
    else:
        return None
    i = r.randrange(len(EVT_TASK_FRAMES))
    mood, frame = EVT_TASK_FRAMES[i]
    frame = phone(frame, r)
    when = {**p.expr, "time": f"{hour + 12:02d}:00"}
    when_t = f"{p.text} at {hour}"
    iso = start.strftime("%Y-%m-%dT%H:%M")
    ev = Turn(tidy(frame.replace("{n}", n).replace("{w}", "in the diary").replace("{d}", when_t)),
              gold_diff([g_new("event", name=has_words(n), date=iso)]), [C("act", verb="create", kind="event", args=f"name: {cap(n)}\ndate: {jx(when)}")])
    tk = Turn(tidy(frame.replace("{n}", n).replace("{w}", "on my to-do list").replace("{d}", when_t)),
              gold_diff([g_new("task", name=has_words(n), date=iso)]), [C("act", verb="create", kind="task", args=f"name: {cap(n)}\ndate: {jx(when)}")])
    return (make_item(ctx, "CM", "event-or-task", f"{i}", "kind: diary vs to-do list", [ev], shape="rel+time+unit+weekday", tags=("event", "create")),
            make_item(ctx, "CM", "event-or-task", f"{i}", "kind: diary vs to-do list", [tk], shape="rel+time+unit+weekday", tags=("task", "create")))


NEW_CONTACT = [("command", "new contact {n}, {r}"), ("command", "add a contact {n}, my {r}"), ("command", "save {n} as a contact, they're my {r}"),
               ("command", "add {n} to my people, the {r}"), ("question", "can you save {n}, my {r}?"), ("question", "{n} is my {r}, add them?"),
               ("indirect", "can you add a contact {n}, the {r}"), ("indirect", "could you save {n} as my {r}"), ("indirect", "would you add {n}, my {r}, to my people")]


def cm_contact(ctx: Ctx, r):
    """A new contact and the role they play: the role is the field that flips."""
    v = ctx.v
    for _ in range(20):
        n = f"{r.choice(FIRST)} {r.choice(LAST)}"
        if not v.by_name("person", n) and not v.by_name("person", n.split()[0]):
            break
    else:
        return None
    ra, rb = r.sample(ROLES, 2)
    i = r.randrange(len(NEW_CONTACT))
    mood, frame = NEW_CONTACT[i]
    frame = phone(frame, r)
    turns = []
    for role in (ra, rb):
        turns.append(Turn(tidy(frame.replace("{n}", n.lower()).replace("{r}", role)), gold_diff([g_new("person", name=n, role=role)]),
                          [C("act", verb="create", kind="person", args=f"name: {n}\nrole: {role}")]))
    return (make_item(ctx, "CM", "contact-role", f"{i}", "create field: role", [turns[0]], tags=("person", "create")),
            make_item(ctx, "CM", "contact-role", f"{i}", "create field: role", [turns[1]], tags=("person", "create")))


DURATIONS = [(30, "half an hour"), (45, "45 minutes"), (60, "an hour"), (90, "an hour and a half"), (120, "two hours"), (180, "three hours")]
CLOCKS_AMPM = [("9am", 9), ("10am", 10), ("11am", 11), ("2pm", 14), ("3pm", 15), ("4pm", 16), ("5pm", 17), ("6pm", 18), ("7pm", 19)]
DURATION_FRAMES = [("command", "put {n} {d} for {x}"), ("command", "add {n} {d} for {x}"), ("command", "book {n} {d} for {x}"), ("command", "schedule {n} {d} for {x}"),
                   ("command", "pop {n} in the diary {d} for {x}"), ("question", "can we do {n} {d} for {x}?"), ("question", "{n} {d} for {x}?"),
                   ("indirect", "can you put {n} {d} for {x}"), ("indirect", "could you book {n} {d} for {x}"), ("indirect", "would you schedule {n} {d} for {x}")]


def cm_event_duration(ctx: Ctx, r):
    """A new event "for an hour": the length goes in the `duration` field, as the natural sessions have it (`duration: 60`), never in a from..to
    span of the date; the pair flips the length and nothing else."""
    v = ctx.v
    phs = [p for p in point_phrases(ctx) if p.fam in ("weekday", "day")]
    r.shuffle(phs)
    name = r.choice(EVENT_NAMES["plain"])
    clock, hour = r.choice(CLOCKS_AMPM)
    (d1, t1), (d2, t2) = r.sample(DURATIONS, 2)
    for p in phs:
        start = dt.datetime.combine(resolve(p.expr, v.now)[1], dt.time(hour, 0))
        if start > v.now and slot_free(v, start, max(d1, d2)):
            break
    else:
        return None
    expr = {**p.expr, "time": f"{hour:02d}:00"}
    iso = start.strftime("%Y-%m-%dT%H:%M")
    fi = r.randrange(len(DURATION_FRAMES))
    mood, frame = DURATION_FRAMES[fi]
    frame = phone(frame, r)
    turns = []
    for minutes, said in ((d1, t1), (d2, t2)):
        msg = tidy(frame.replace("{n}", name).replace("{d}", f"{p.text} at {clock}").replace("{x}", said))
        turns.append(Turn(msg, gold_diff([g_new("event", name=has_words(name), date=iso, duration=minutes)]),
                          [C("act", verb="create", kind="event", args=f"name: {cap(name)}\ndate: {jx(expr)}\nduration: {minutes}")]))
    shape = "rel+time+unit+weekday" if p.expr.get("weekday") else "rel+time+unit"
    return (make_item(ctx, "CM", "event-duration", f"{fi}", "create field: duration", [turns[0]], shape=shape, tags=("event", "create")),
            make_item(ctx, "CM", "event-duration", f"{fi}", "create field: duration", [turns[1]], shape=shape, tags=("event", "create")))


for _n, _f, _w, _fr in (("create-task", cm_create_fields, 2.0, len(CREATE_TASK_FRAMES)), ("exists", cm_exists, 2.0, len(ADD_TO_FRAMES)),
                        ("rename-create", cm_rename, 1.5, len(RENAME_VS_CREATE) * 2), ("event-or-task", cm_kind, 1.5, len(EVT_TASK_FRAMES) * 2),
                        ("contact-role", cm_contact, 1.0, len(NEW_CONTACT)), ("event-duration", cm_event_duration, 0.25, len(DURATION_FRAMES) * 2)):
    register("CM", _n, _f, _w, _fr)


# =============================================================================================================
# TWO: two writes in one message, or a write then a read of its result
# =============================================================================================================

VP = {"complete": ["tick off {X}", "mark {X} as done", "complete {X}", "check off {X}", "finish off {X}"],
      "cancel": ["cancel {X}", "call off {X}", "cancel {X} for me", "go ahead and cancel {X}"],
      "star": ["star {X}", "favourite {X}", "give {X} a star", "add a star to {X}"],
      "delete": ["delete {X}", "get rid of {X}", "wipe {X}"],
      "log": ["log a call with {X}", "note that i rang {X}"]}
TWO_WRAPS = [("command", "{a} and {b}"), ("command", "{a}, then {b}"), ("command", "{a} and also {b}"), ("command", "{a} plus {b}"),
             ("question", "can we {a} and {b}?"), ("question", "shall we {a} and then {b}?"), ("indirect", "can you {a} and {b}"),
             ("indirect", "could you {a} and also {b}"), ("indirect", "would you {a}, then {b}")]
TWO_COMBOS = [("star", "person", "complete", "task"), ("complete", "task", "cancel", "event"), ("star", "document", "complete", "task"),
              ("cancel", "event", "star", "person"), ("complete", "task", "complete", "task"), ("star", "person", "star", "photo"),
              ("log", "person", "complete", "task"), ("complete", "task", "delete", "note")]


def nameable(v: Vault, verb: str, kind: str, avoid: set[str] = frozenset()) -> list[dict]:
    out = []
    for x in v.of(kind):
        if x["key"] in avoid or not can_verb(v, verb, x) or not name_options(v, x):
            continue
        if verb == "cancel" and stamp_dt(x["date"]) < v.now:
            continue
        out.append(x)
    return out


def words_clash(v: Vault, a: dict, b: dict) -> bool:
    return bool(set(toks(a["name"])) & set(toks(b["name"])))


def two_writes(ctx: Ctx, r):
    v = ctx.v
    v1, k1, v2, k2 = r.choice(TWO_COMBOS)
    A = nameable(v, v1, k1)
    B = nameable(v, v2, k2)
    if not A or not B:
        return None
    a = r.choice(A)
    flip_second = r.random() < 0.7
    Bs = [b for b in B if b["key"] != a["key"] and not words_clash(v, a, b)]
    if len(Bs) < 2:
        return None
    b1, b2 = r.sample(Bs, 2)
    a2 = None
    if not flip_second:
        As = [x for x in A if x["key"] not in (a["key"], b1["key"]) and not words_clash(v, x, b1)]
        if not As:
            return None
        a2 = r.choice(As)
    wi = r.randrange(len(TWO_WRAPS))
    mood, wrap = TWO_WRAPS[wi]
    wrap = phone(wrap, r)
    ia, ib = r.randrange(len(VP[v1])), r.randrange(len(VP[v2]))
    sides = []
    combos = [(a, b1), (a, b2)] if flip_second else [(a, b1), (a2, b1)]
    for ra, rb in combos:
        calls, texts, changes = [], [], []
        for verb, row, idx, last in ((v1, ra, ia, False), (v2, rb, ib, True)):
            pn = pick_name(v, row, ctx.rng("two-name", row["key"], wi))
            style, text, name_arg = pn
            texts.append(VP[verb][idx].replace("{X}", text))
            if ctx.rng("two-by", row["key"], wi).random() < 0.35 and key_safe(v, row, text):
                calls.append(C("act", verb=verb, rows=shown_key(row), args=VERBS[verb].get("args"), more=True if not last else None))
            else:
                calls.append(C("act", verb=verb, kind=row["kind"], name=name_arg, args=VERBS[verb].get("args"), more=True if not last else None))
            changes.append(VERBS[verb]["gold"](v, row["key"]))
        msg = tidy(wrap.replace("{a}", texts[0]).replace("{b}", texts[1]))
        sides.append(Turn(msg, gold_diff(changes), calls))
    fam = f"{v1}-{v2}.{wi}"
    feat = "second row" if flip_second else "first row"
    return (make_item(ctx, "TWO", "writes", fam, f"two writes: {feat}", [sides[0]], tags=(k1, k2)),
            make_item(ctx, "TWO", "writes", fam, f"two writes: {feat}", [sides[1]], tags=(k1, k2)))


WR_WRAPS = [("command", "{a} and tell me what's left on the {L} list"), ("command", "{a}, then show me what's left on {L}"),
            ("command", "{a} and then list what's left on the {L} list"), ("command", "{a}, what's left on {L} after that?"),
            ("question", "can we {a}? what's left on the {L} list then?"), ("question", "{a} - what's left on the {L} list now?"),
            ("indirect", "can you {a} and tell me what's left on the {L} list"), ("indirect", "could you {a} and then show me what's left on {L}"),
            ("indirect", "would you {a}, then tell me what's still open on the {L} list")]


def two_write_read(ctx: Ctx, r):
    """Complete a task and then read what is left on its list: the task decides the rows that come back."""
    v = ctx.v
    lists = []
    for L in v.of("list"):
        open_ = [t for t in v.select("task", linked_to=L["key"], where=[("status", "=", "open")]) if name_options(v, v.get(t))]
        if 2 <= len(open_) <= ROW_CAP:
            lists.append((L, open_))
    if not lists:
        return None
    L, open_ = r.choice(lists)
    t1, t2 = r.sample(open_, 2)
    all_open = v.select("task", linked_to=L["key"], where=[("status", "=", "open")])
    wi = r.randrange(len(WR_WRAPS))
    mood, wrap = WR_WRAPS[wi]
    wrap = phone(wrap, r)
    ia = r.randrange(len(VP["complete"]))
    sides = []
    for t in (t1, t2):
        row = v.get(t)
        style, text, name_arg = pick_name(v, row, ctx.rng("wr-name", t, wi))
        rest = [k for k in all_open if k != t]
        a = VP["complete"][ia].replace("{X}", text)
        msg = tidy(wrap.replace("{a}", a).replace("{L}", L["name"].lower()))
        if ctx.rng("wr-by", t, wi).random() < 0.3 and key_safe(v, row, text):
            c1 = C("act", verb="complete", rows=shown_key(row), more=True)
        else:
            c1 = C("act", verb="complete", kind="task", name=name_arg, more=True)
        c2 = C("answer", kind="task", linked_to=f"${L['key']}", where="status = open")
        gold = {"type": "rows", "rows": rest, "diff": {"rows": [VERBS["complete"]["gold"](v, t)], "links": []}}
        sides.append(Turn(msg, gold, [c1, c2]))
    return (make_item(ctx, "TWO", "write-read", f"{wi}", "write then read: which task", [sides[0]], tags=("task",)),
            make_item(ctx, "TWO", "write-read", f"{wi}", "write then read: which task", [sides[1]], tags=("task",)))


WC_WRAPS = [("command", "{a} and tell me how many starred people i have now"), ("command", "{a}, then count my starred people"),
            ("command", "{a} and then how many starred people is that"), ("command", "{a}, how many starred people after that?"),
            ("question", "can we {a}? how many starred people is that then?"), ("question", "{a} - how many starred people now?"),
            ("indirect", "can you {a} and tell me how many starred people i have"), ("indirect", "could you {a} and then count the starred people"),
            ("indirect", "would you {a}, then tell me how many people are starred")]


def two_write_count(ctx: Ctx, r):
    """Star someone and count the starred people: the count after the write, the person decides the diff."""
    v = ctx.v
    cand = nameable(v, "star", "person")
    if len(cand) < 2:
        return None
    p1, p2 = r.sample(cand, 2)
    n0 = len(v.select("person", where=[("starred", "=", "yes")]))
    wi = r.randrange(len(WC_WRAPS))
    mood, wrap = WC_WRAPS[wi]
    wrap = phone(wrap, r)
    ia = r.randrange(len(VP["star"]))
    sides = []
    for p in (p1, p2):
        style, text, name_arg = pick_name(v, p, ctx.rng("wc-name", p["key"], wi))
        msg = tidy(wrap.replace("{a}", VP["star"][ia].replace("{X}", text)))
        c1 = C("act", verb="star", kind="person", name=name_arg, more=True)
        c2 = C("answer", op="count", kind="person", where="starred = yes")
        gold = {"type": "value", "values": [{"amount": n0 + 1, "unit": None}], "diff": {"rows": [VERBS["star"]["gold"](v, p["key"])], "links": []}}
        sides.append(Turn(msg, gold, [c1, c2]))
    return (make_item(ctx, "TWO", "write-count", f"{wi}", "write then count: which person", [sides[0]], tags=("person",)),
            make_item(ctx, "TWO", "write-count", f"{wi}", "write then count: which person", [sides[1]], tags=("person",)))


for _n, _f, _w, _fr in (("writes", two_writes, 3.0, len(TWO_WRAPS) * 4), ("write-read", two_write_read, 1.5, len(WR_WRAPS) * 5),
                        ("write-count", two_write_count, 1.0, len(WC_WRAPS) * 4)):
    register("TWO", _n, _f, _w, _fr)


# =============================================================================================================
# DATES: two dates in one message, every date shape, the hour conventions
# =============================================================================================================


def fmt_iso(d: dt.date, time_) -> str:
    return d.isoformat() if time_ is None else f"{d.isoformat()}T{time_[0]:02d}:{time_[1]:02d}"


def target_iso(v: Vault, row: dict, expr: dict) -> str | None:
    """The date a row has after a `reschedule ... to: expr` (anchor row shifts, a day alone keeps the time, a clock sets it)."""
    s = row["date"]
    if expr.get("anchor") == "row":
        unit, rel = expr["unit"], expr["rel"]
        if unit in ("minute", "hour"):
            if s[1] is None:
                return None
            d = stamp_dt(s) + dt.timedelta(minutes=rel if unit == "minute" else 60 * rel)
            return fmt_iso(d.date(), (d.hour, d.minute))
        d = s[0]
        d = d + dt.timedelta(days=rel) if unit == "day" else d + dt.timedelta(days=7 * rel) if unit == "week" else add_months(d, rel)
        t = _clock(expr["time"]) if expr.get("time") else s[1]
        return fmt_iso(d, t)
    res = resolve(expr, v.now)
    if res[0] == "days" and res[1] == res[2]:
        return fmt_iso(res[1], s[1])
    if res[0] == "at":
        return fmt_iso(res[1].date(), (res[1].hour, res[1].minute))
    return None


def point_phrases(ctx: Ctx, future=True) -> list[Ph]:
    out = [p for p in ctx.ph if p.fam in ("weekday", "day") and (p.future or not future)]
    for k in range(1, 22):
        d = ctx.v.today + dt.timedelta(days=k)
        out.append(abs_phrase(d))
    return [p for p in out if resolve(p.expr, ctx.v.now)[0] == "days" and resolve(p.expr, ctx.v.now)[1] == resolve(p.expr, ctx.v.now)[2]]


MOVE_FROM_TO = [("command", "move {n} from {a} to {b}"), ("command", "shift {n} from {a} to {b}"), ("command", "push {n} from {a} to {b}"),
                ("command", "reschedule {n} from {a} to {b}"), ("command", "change {n} from {a} to {b}"), ("question", "can we move {n} from {a} to {b}?"),
                ("question", "{n} from {a} to {b}?"), ("indirect", "can you move {n} from {a} over to {b}"), ("indirect", "could you shift {n} from {a} to {b}"),
                ("indirect", "would you reschedule {n} from {a} to {b}")]


def dates_from_to(ctx: Ctx, r):
    """D1: 'move the night shift from friday to monday': the first date names the row, the second is where it goes."""
    v = ctx.v
    sets = [S for S in twin_sets(v)["same"] if S[0]["kind"] == "event" and len(S) >= 2 and set_name_options(v, S)]
    if not sets:
        return None
    S = r.choice(sets)
    cand = [x for x in S if x["status"] != "cancelled" and stamp_dt(x["date"]) >= v.now]
    if len(cand) < 2:
        return None
    phs = point_phrases(ctx)
    src = {}
    for p in phs:
        res = resolve(p.expr, v.now)
        hit = [x for x in cand if contains(res, x["date"])]
        if len(hit) == 1:
            src.setdefault(hit[0]["key"], []).append(p)
    if len(src) < 1:
        return None
    flip_src = r.random() < 0.4 and len(src) >= 2
    name_text, name_arg = r.choice(set_name_options(v, S))
    fi = r.randrange(len(MOVE_FROM_TO))
    mood, frame = MOVE_FROM_TO[fi]
    frame = phone(frame, r)
    sides = []
    if flip_src:
        k1, k2 = r.sample(sorted(src), 2)
        pa1, pa2 = r.choice(src[k1]), r.choice(src[k2])
        tos = [p for p in phs if p.fam in ("weekday", "day", "abs") and p.text not in (pa1.text, pa2.text)]
        pb = r.choice(tos)
        combos = [(v.get(k1), pa1, pb), (v.get(k2), pa2, pb)]
    else:
        k1 = r.choice(sorted(src))
        pa = r.choice(src[k1])
        tos = [p for p in phs if p.text != pa.text and p.fam in ("weekday", "day", "abs")]
        pb1, pb2 = r.sample(tos, 2)
        combos = [(v.get(k1), pa, pb1), (v.get(k1), pa, pb2)]
    for row, pa, pb in combos:
        iso = target_iso(v, row, pb.expr)
        if iso is None or iso == fmt_iso(row["date"][0], row["date"][1]):
            return None
        msg = tidy(frame.replace("{n}", name_text).replace("{a}", pa.text).replace("{b}", pb.text))
        ref = C("act", verb="reschedule", kind="event", name=name_arg, when=jx(pa.expr), args=f"to: {jx(pb.expr)}")
        sides.append((Turn(msg, gold_diff([g_upd(row["key"], date=iso)]), [ref]), pa, pb))
    if sides[0][0].gold == sides[1][0].gold:
        return None
    feat = "source date" if flip_src else "destination date"
    return (make_item(ctx, "DATES", "from-to", f"{fi}", f"two dates: {feat}", [sides[0][0]], shape=sides[0][2].shape, tags=("event",)),
            make_item(ctx, "DATES", "from-to", f"{fi}", f"two dates: {feat}", [sides[1][0]], shape=sides[1][2].shape, tags=("event",)))


BETWEEN = [("command", "show me {X} between {a} and {b}"), ("command", "list {X} from {a} to {b}"), ("command", "what's {X} from {a} through {b}"),
           ("command", "pull up {X} {a} to {b}"), ("question", "what {X} do i have between {a} and {b}?"), ("question", "any {X} from {a} to {b}?"),
           ("question", "{X} between {a} and {b}?"), ("indirect", "can you show me {X} between {a} and {b}"), ("indirect", "could you list {X} from {a} to {b}"),
           ("indirect", "can i see {X} from {a} to {b}")]
BETWEEN_COUNT = [("command", "count {X} between {a} and {b}"), ("question", "how many {X} between {a} and {b}?"), ("question", "how many {X} from {a} to {b}?"),
                 ("question", "how many {X} do i have from {a} through {b}"), ("indirect", "can you count {X} between {a} and {b}"),
                 ("indirect", "could you tell me how many {X} from {a} to {b}"), ("command", "tell me how many {X} {a} to {b}"),
                 ("question", "{X} count from {a} to {b}?")]


def dates_between(ctx: Ctx, r):
    """D2: a span between two dates: 'what's on between monday and wednesday'; the pair moves one end."""
    v = ctx.v
    kind = r.choice(["event", "task", "event", "task", "photo", "debt", "note", "document"])
    phs = point_phrases(ctx, future=False)
    phs = [p for p in phs if p.fam in ("weekday", "day", "abs")]
    for _ in range(30):
        pa = r.choice(phs)
        ra = resolve(pa.expr, v.now)[1]
        bs = [p for p in phs if resolve(p.expr, v.now)[1] > ra and (resolve(p.expr, v.now)[1] - ra).days <= 14]
        if len(bs) < 2:
            continue
        pb1, pb2 = r.sample(bs, 2)
        sel = []
        for pb in (pb1, pb2):
            sel.append(v.select(kind, when=span(pa.expr, pb.expr), where=[("status", "=", "open")] if kind == "task" else None))
        if sel[0] != sel[1] and max(len(s) for s in sel) <= ROW_CAP + 30 and min(len(s) for s in sel) >= 0 and (len(sel[0]) + len(sel[1])) > 0:
            break
    else:
        return None
    count = max(len(s) for s in sel) > ROW_CAP or (r.random() < 0.3 and len(sel[0]) != len(sel[1]))
    if count and len(sel[0]) == len(sel[1]):
        return None
    frames = BETWEEN_COUNT if count else BETWEEN
    fi = r.randrange(len(frames))
    mood, frame = frames[fi]
    frame = phone(frame, r)
    noun = ("open " if kind == "task" else "") + NOUN[kind]
    turns = []
    for pb, keys in ((pb1, sel[0]), (pb2, sel[1])):
        msg = tidy(frame.replace("{X}", noun).replace("{a}", pa.text).replace("{b}", pb.text))
        args = dict(kind=kind, where="status = open" if kind == "task" else None, when=jx(span(pa.expr, pb.expr)))
        if count:
            ref, gold = C("answer", op="count", **args), gold_val(len(keys))
        else:
            ref, gold = C("answer", **args), gold_rows(keys)
        turns.append(Turn(msg, gold, [ref]))
    sh = f"from..to[{pa.shape} | {pb1.shape}]"
    return (make_item(ctx, "DATES", "between", f"{'count' if count else 'read'}.{fi}", "two dates: end of the span", [turns[0]], shape=sh, tags=(kind,)),
            make_item(ctx, "DATES", "between", f"{'count' if count else 'read'}.{fi}", "two dates: end of the span", [turns[1]], shape=sh, tags=(kind,)))


def wd_expr_of(today: dt.date, wd: int) -> dict:
    return U("week", wd_rel(today, wd), weekday=wd + 1)


def next_day_expr(today: dt.date, wd: int) -> dict:
    rel = wd_rel(today, wd)
    return U("week", rel, weekday=wd + 2) if wd < 6 else U("week", rel + 1, weekday=1)


def prev_day_expr(today: dt.date, wd: int) -> dict:
    rel = wd_rel(today, wd)
    return U("week", rel, weekday=wd) if wd > 0 else U("week", rel - 1, weekday=7)


OPEN_FRAMES = [("command", "show me {X} {o}"), ("command", "list {X} {o}"), ("command", "pull up {X} {o}"), ("command", "find {X} {o}"),
               ("question", "what {X} do i have {o}?"), ("question", "any {X} {o}?"), ("question", "{X} {o}?"), ("indirect", "can you show me {X} {o}"),
               ("indirect", "could you list {X} {o}"), ("indirect", "can i see {X} {o}")]
OPEN_COUNT = [("command", "count {X} {o}"), ("question", "how many {X} {o}?"), ("question", "how many {X} do i have {o}"), ("indirect", "can you count {X} {o}"),
              ("indirect", "could you tell me how many {X} {o}"), ("command", "tell me how many {X} {o}"), ("question", "{X} count {o}?")]


def dates_open(ctx: Ctx, r):
    """D6: a span with one end open: 'by friday' against 'after friday', 'before' against 'from ... on'."""
    v = ctx.v
    kind = r.choice(["event", "task", "task", "photo", "debt", "note", "document"])
    wd = r.randrange(7)
    use_abs = r.random() < 0.3
    if use_abs:
        d = v.today + dt.timedelta(days=r.randrange(2, 20))
        base = {"by": ({"to": Dt(d.isoformat())}, f"by {day_text(d)}", "from..to[? | date]"),
                "after": ({"from": Dt((d + dt.timedelta(days=1)).isoformat())}, f"after {day_text(d)}", "from..to[date | ?]"),
                "before": ({"to": Dt((d - dt.timedelta(days=1)).isoformat())}, f"before {day_text(d)}", "from..to[? | date]"),
                "from": ({"from": Dt(d.isoformat())}, f"from {day_text(d)} on", "from..to[date | ?]")}
    else:
        n = WEEKDAYS[wd]
        base = {"by": ({"to": wd_expr_of(v.today, wd)}, f"by {n}", "from..to[? | rel+unit+weekday]"),
                "after": ({"from": next_day_expr(v.today, wd)}, f"after {n}", "from..to[rel+unit+weekday | ?]"),
                "before": ({"to": prev_day_expr(v.today, wd)}, f"before {n}", "from..to[? | rel+unit+weekday]"),
                "from": ({"from": wd_expr_of(v.today, wd)}, f"from {n} on", "from..to[rel+unit+weekday | ?]")}
    pair = r.choice([("by", "after"), ("before", "from")])
    sel = {}
    for k in pair:
        sel[k] = v.select(kind, when=base[k][0], where=[("status", "=", "open")] if kind == "task" else None)
    if sel[pair[0]] == sel[pair[1]]:
        return None
    count = max(len(x) for x in sel.values()) > ROW_CAP
    frames = OPEN_COUNT if count else OPEN_FRAMES
    fi = r.randrange(len(frames))
    mood, frame = frames[fi]
    frame = phone(frame, r)
    noun = ("open " if kind == "task" else "") + NOUN[kind]
    turns = []
    for k in pair:
        expr, text, shape = base[k]
        msg = tidy(frame.replace("{X}", noun).replace("{o}", text))
        args = dict(kind=kind, where="status = open" if kind == "task" else None, when=jx(expr))
        keys = sel[k]
        turns.append((Turn(msg, gold_val(len(keys)) if count else gold_rows(keys), [C("answer", op="count" if count else None, **args)]), shape))
    if count and len(sel[pair[0]]) == len(sel[pair[1]]):
        return None
    return (make_item(ctx, "DATES", "open-span", f"{'count' if count else 'read'}.{fi}", f"open span: {pair[0]} vs {pair[1]}", [turns[0][0]], shape=turns[0][1], tags=(kind,)),
            make_item(ctx, "DATES", "open-span", f"{'count' if count else 'read'}.{fi}", f"open span: {pair[0]} vs {pair[1]}", [turns[1][0]], shape=turns[1][1], tags=(kind,)))


ANCHORS = [("an hour later", U("hour", 1, anchor="row")), ("an hour earlier", U("hour", -1, anchor="row")), ("half an hour later", U("minute", 30, anchor="row")),
           ("half an hour earlier", U("minute", -30, anchor="row")), ("two hours later", U("hour", 2, anchor="row")), ("a day later", U("day", 1, anchor="row")),
           ("a day earlier", U("day", -1, anchor="row")), ("two days earlier", U("day", -2, anchor="row")), ("two days later", U("day", 2, anchor="row")),
           ("a week later", U("week", 1, anchor="row")), ("a week earlier", U("week", -1, anchor="row")),
           ("the next day at 10", U("day", 1, anchor="row", time="10:00")), ("the next day at 9", U("day", 1, anchor="row", time="09:00"))]
ANCHOR_FRAMES = [("command", "move {n} {p}"), ("command", "push {n} {p}"), ("command", "shift {n} {p}"), ("command", "make {n} {p}"),
                 ("command", "bump {n} {p}"), ("question", "can we move {n} {p}?"), ("question", "{n} {p}?"), ("indirect", "can you move {n} {p}"),
                 ("indirect", "could you push {n} {p}"), ("indirect", "would you shift {n} {p}")]


def anchor_shape(e: dict) -> str:
    return "anchor+rel+time+unit" if e.get("time") else "anchor+rel+unit"


def dates_anchor(ctx: Ctx, r):
    """D4: a shift from the row's own date ('an hour later', 'two days earlier'): direction and size are the decision."""
    v = ctx.v
    rows = [x for x in v.of("event") if x["status"] != "cancelled" and name_options(v, x) and stamp_dt(x["date"]) >= v.now]
    if not rows:
        return None
    row = r.choice(rows)
    pa, pb = r.sample(ANCHORS, 2)
    isos = [target_iso(v, row, p[1]) for p in (pa, pb)]
    if None in isos or isos[0] == isos[1]:
        return None
    style, text, name_arg = pick_name(v, row, r)
    fi = r.randrange(len(ANCHOR_FRAMES))
    mood, frame = ANCHOR_FRAMES[fi]
    frame = phone(frame, r)
    turns = []
    for (ptext, expr), iso in zip((pa, pb), isos):
        msg = tidy(frame.replace("{n}", text).replace("{p}", ptext))
        turns.append(Turn(msg, gold_diff([g_upd(row["key"], date=iso)]), [C("act", verb="reschedule", kind="event", name=name_arg, args=f"to: {jx(expr)}")]))
    return (make_item(ctx, "DATES", "anchor", f"{fi}", "shift from the row: direction or size", [turns[0]], shape=anchor_shape(pa[1]), tags=("event",)),
            make_item(ctx, "DATES", "anchor", f"{fi}", "shift from the row: direction or size", [turns[1]], shape=anchor_shape(pb[1]), tags=("event",)))


CLOCKS = [("2", 14), ("3", 15), ("4", 16), ("5", 17), ("6", 18), ("9", 9), ("10", 10), ("11", 11), ("3pm", 15), ("9am", 9), ("7am", 7), ("7pm", 19), ("2pm", 14), ("10am", 10)]
MOVE_TO = [("command", "move {n} to {d}"), ("command", "reschedule {n} to {d}"), ("command", "push {n} to {d}"), ("command", "change {n} to {d}"),
           ("command", "shift {n} to {d}"), ("question", "can we move {n} to {d}?"), ("question", "{n} to {d}?"), ("indirect", "can you move {n} to {d}"),
           ("indirect", "could you reschedule {n} to {d}"), ("indirect", "would you push {n} to {d}")]


def dates_to(ctx: Ctx, r):
    """D5: reschedule to a typed date, a weekday and a clock, tomorrow at N, or a day alone (the time stays)."""
    v = ctx.v
    rows = [x for x in v.of("event") if x["status"] != "cancelled" and name_options(v, x) and stamp_dt(x["date"]) >= v.now]
    if not rows:
        return None
    row = r.choice(rows)
    phs = point_phrases(ctx)
    mode = r.choice(["clock", "clock", "day", "time"])
    style, text, name_arg = pick_name(v, row, r)
    fi = r.randrange(len(MOVE_TO))
    mood, frame = MOVE_TO[fi]
    frame = phone(frame, r)
    turns, shapes = [], []
    if mode == "time":  # same day phrase, two clocks
        p = r.choice(phs)
        (c1, h1), (c2, h2) = r.sample(CLOCKS, 2)
        if h1 == h2:
            return None
        combos = [(p, c1, h1), (p, c2, h2)]
    else:
        p1, p2 = r.sample(phs, 2)
        c, h = r.choice(CLOCKS)
        combos = [(p1, c, h), (p2, c, h)] if mode == "clock" else [(p1, None, None), (p2, None, None)]
    for p, c, h in combos:
        if c is None:
            expr, d_text = p.expr, p.text
            shape = {"abs": "date"}.get(p.fam, "rel+unit+weekday" if p.expr.get("weekday") else "rel+unit")
        else:
            expr = {**p.expr, "time": f"{h:02d}:00"}
            d_text = f"{p.text} at {c}"
            shape = "date+time" if p.fam == "abs" else ("rel+time+unit+weekday" if p.expr.get("weekday") else "rel+time+unit")
        iso = target_iso(v, row, expr)
        if iso is None or iso == fmt_iso(row["date"][0], row["date"][1]):
            return None
        msg = tidy(frame.replace("{n}", text).replace("{d}", d_text))
        turns.append(Turn(msg, gold_diff([g_upd(row["key"], date=iso)]), [C("act", verb="reschedule", kind="event", name=name_arg, args=f"to: {jx(expr)}")]))
        shapes.append(shape)
    if turns[0].gold == turns[1].gold:
        return None
    feat = {"clock": "day with the clock fixed", "day": "day alone (time stays)", "time": "the clock"}[mode]
    return (make_item(ctx, "DATES", "move-to", f"{mode}.{fi}", f"date: {feat}", [turns[0]], shape=shapes[0], tags=("event",)),
            make_item(ctx, "DATES", "move-to", f"{mode}.{fi}", f"date: {feat}", [turns[1]], shape=shapes[1], tags=("event",)))


HOUR_FRAMES = [("command", "put {n} in for {d}"), ("command", "add {n} {d}"), ("command", "book {n} {d}"), ("command", "schedule {n} {d}"),
               ("command", "pop {n} in the diary {d}"), ("question", "can we do {n} {d}?"), ("question", "{n} {d}?"), ("indirect", "can you put {n} in for {d}"),
               ("indirect", "could you add {n} {d}"), ("indirect", "would you book {n} {d}")]


def dates_hour(ctx: Ctx, r):
    """D3: the hour conventions of SPEC 14.1: dinner at 7 is the evening, breakfast at 7 the morning, 7am is 7am."""
    v = ctx.v
    phs = [p for p in point_phrases(ctx) if p.fam in ("weekday", "day")]
    r.shuffle(phs)
    mode = r.choice(["word", "word", "marker"])
    for p in phs:
        d = resolve(p.expr, v.now)[1]
        h = r.choice([5, 6, 7, 8, 9]) if mode == "word" else r.choice([6, 7, 8, 9])
        starts = [dt.datetime.combine(d, dt.time(x, 0)) for x in (h, h + 12)]
        if all(slot_free(v, s_) for s_ in starts):
            break
    else:
        return None
    fi = r.randrange(len(HOUR_FRAMES))
    mood, frame = HOUR_FRAMES[fi]
    frame = phone(frame, r)
    turns = []
    if mode == "word":
        ne = r.choice(EVENT_NAMES["evening"][:4])
        nm = r.choice(EVENT_NAMES["morning"][:2])
        sides = [(ne, h + 12, f"at {h}"), (nm, h, f"at {h}")]
        feat = "hour: the word (evening vs morning)"
    else:
        n = r.choice(["a catch-up", "a meetup", "a call"])
        sides = [(n, h, f"at {h}am"), (n, h + 12, f"at {h}pm")]
        feat = "hour: the am/pm marker"
    for name, hr, ctext in sides:
        expr = {**p.expr, "time": f"{hr:02d}:00"}
        msg = tidy(frame.replace("{n}", name).replace("{d}", f"{p.text} {ctext}"))
        iso = fmt_iso(d, (hr, 0))
        turns.append(Turn(msg, gold_diff([g_new("event", name=has_words(name), date=iso)]), [C("act", verb="create", kind="event", args=f"name: {cap(name)}\ndate: {jx(expr)}")]))
    return (make_item(ctx, "DATES", "hour", f"{mode}.{fi}", feat, [turns[0]], shape="rel+time+unit+weekday" if p.expr.get("weekday") else "rel+time+unit", tags=("event", "create")),
            make_item(ctx, "DATES", "hour", f"{mode}.{fi}", feat, [turns[1]], shape="rel+time+unit+weekday" if p.expr.get("weekday") else "rel+time+unit", tags=("event", "create")))


for _n, _f, _w, _fr in (("from-to", dates_from_to, 2.0, len(MOVE_FROM_TO)), ("between", dates_between, 2.0, len(BETWEEN) + len(BETWEEN_COUNT)),
                        ("open-span", dates_open, 1.8, len(OPEN_FRAMES) + len(OPEN_COUNT)), ("anchor", dates_anchor, 1.6, len(ANCHOR_FRAMES)),
                        ("move-to", dates_to, 2.0, len(MOVE_TO) * 3), ("hour", dates_hour, 1.4, len(HOUR_FRAMES) * 2)):
    register("DATES", _n, _f, _w, _fr)


# =============================================================================================================
# CONT: containers and subtasks
# =============================================================================================================

CONT_OF = {"task": ("list", "list"), "note": ("notebook", "notebook"), "document": ("folder", "folder"), "photo": ("album", "album"), "person": ("group", "group")}
SINGLE = {"task": lambda r: r["list"], "note": lambda r: r["notebook"], "document": lambda r: r["folder"]}  # one container per row


def containers_of(v: Vault, row: dict) -> list[str]:
    k = row["kind"]
    if k in SINGLE:
        c = SINGLE[k](row)
        return [c] if c else []
    if k == "photo":
        return [a for a in row["albums"] if v.rows[a]["live"]]
    if k == "person":
        return [g["key"] for g in v.of("group") if row["key"] in g["members"]]
    return []


WHICH_FRAMES = [("command", "tell me which {kw} {X} is in"), ("command", "find out which {kw} {X} is in"), ("command", "show me the {kw} that has {X}"),
                ("question", "which {kw} is {X} in?"), ("question", "what {kw} is {X} in"), ("question", "{X} is in which {kw}?"),
                ("question", "which {kw} holds {X}"), ("indirect", "can you tell me which {kw} {X} is in"), ("indirect", "could you find the {kw} {X} is in"),
                ("indirect", "can i see which {kw} {X} is in")]


def cont_which(ctx: Ctx, r):
    """'which list is X on': the answer is the container; the pair flips the row (and so the container)."""
    v = ctx.v
    kind = r.choice(["task", "note", "document", "photo"])
    rows = [x for x in v.of(kind) if len(containers_of(v, x)) == 1 and name_options(v, x)]
    byc = collections.defaultdict(list)
    for x in rows:
        byc[containers_of(v, x)[0]].append(x)
    if len(byc) < 2:
        return None
    c1, c2 = r.sample(sorted(byc), 2)
    a, b = r.choice(byc[c1]), r.choice(byc[c2])
    ck, kw = CONT_OF[kind]
    fi = r.randrange(len(WHICH_FRAMES))
    mood, frame = WHICH_FRAMES[fi]
    frame = phone(frame, r)
    turns = []
    for row, c in ((a, c1), (b, c2)):
        style, text, name_arg = pick_name(v, row, ctx.rng("cw", row["key"]))
        if not key_safe(v, row, text):
            return None
        msg = tidy(frame.replace("{kw}", kw).replace("{X}", text))
        turns.append(Turn(msg, gold_rows([c]), [C("answer", kind=ck, linked_to=shown_key(row))]))
    return (make_item(ctx, "CONT", "which", f"{fi}", f"which {kw}: the row", [turns[0]], tags=(kind,)),
            make_item(ctx, "CONT", "which", f"{fi}", f"which {kw}: the row", [turns[1]], tags=(kind,)))


SUB_FRAMES = [("command", "show me the subtasks of {P}"), ("command", "list the subtasks under {P}"), ("command", "pull up everything under {P}"),
              ("question", "what are the subtasks of {P}?"), ("question", "what's under {P}?"), ("question", "which subtasks does {P} have"),
              ("indirect", "can you show me the subtasks of {P}"), ("indirect", "could you list what's under {P}")]
SUB_COUNT = [("command", "count the subtasks of {P}"), ("question", "how many subtasks does {P} have?"), ("question", "how many subtasks under {P}?"),
             ("indirect", "can you count the subtasks of {P}"), ("indirect", "could you tell me how many subtasks {P} has"), ("question", "{P} subtasks count?")]


def cont_sub(ctx: Ctx, r):
    """The subtasks of a task; the pair flips the parent."""
    v = ctx.v
    parents = []
    for t in v.of("task"):
        subs = [k for k in v.select("task", linked_to=t["key"]) if v.rows[k]["status"] in ACTIVE]
        if len(subs) >= 1 and name_options(v, t):
            parents.append((t, subs))
    if len(parents) < 2:
        return None
    (p1, s1), (p2, s2) = r.sample(parents, 2)
    count = r.random() < 0.4 or max(len(s1), len(s2)) > ROW_CAP
    if s1 == s2 or (count and len(s1) == len(s2)):
        return None
    frames = SUB_COUNT if count else SUB_FRAMES
    fi = r.randrange(len(frames))
    mood, frame = frames[fi]
    frame = phone(frame, r)
    turns = []
    for P, subs in ((p1, s1), (p2, s2)):
        style, text, name_arg = pick_name(v, P, ctx.rng("cs", P["key"]))
        if not key_safe(v, P, text):
            return None
        msg = tidy(frame.replace("{P}", text))
        ref = C("answer", op="count" if count else None, kind="task", linked_to=shown_key(P))
        turns.append(Turn(msg, gold_val(len(subs)) if count else gold_rows(subs), [ref]))
    return (make_item(ctx, "CONT", "subtasks", f"{'count' if count else 'read'}.{fi}", "subtasks of: the parent", [turns[0]], tags=("task",)),
            make_item(ctx, "CONT", "subtasks", f"{'count' if count else 'read'}.{fi}", "subtasks of: the parent", [turns[1]], tags=("task",)))


IN_FRAMES = [("command", "check whether {X} is in the {C} {kw}"), ("command", "tell me if {X} is in the {C} {kw}"), ("question", "is {X} in the {C} {kw}?"),
             ("question", "is {X} still in the {C} {kw}"), ("question", "do i have {X} in the {C} {kw}?"), ("question", "{X} in the {C} {kw}?"),
             ("question", "is {X} part of the {C} {kw}?"), ("indirect", "can you check if {X} is in the {C} {kw}"),
             ("indirect", "could you tell me if {X} is in the {C} {kw}")]


def cont_member(ctx: Ctx, r):
    """'is X in the Y album': a row when it is, an empty answer when it is not; the pair flips the container."""
    v = ctx.v
    kind = r.choice(["photo", "task", "note", "document", "person"])
    rows = [x for x in v.of(kind) if containers_of(v, x) and name_options(v, x) and not x.get("me")]
    if not rows:
        return None
    x = r.choice(rows)
    ck, kw = CONT_OF[kind]
    mine = containers_of(v, x)
    others = [c for c in v.of(ck) if c["key"] not in mine and v.select(kind, linked_to=c["key"])]
    if not others:
        return None
    yes = v.get(r.choice(mine))
    no = r.choice(others)
    style, text, name_arg = pick_name(v, x, r)
    fi = r.randrange(len(IN_FRAMES))
    mood, frame = IN_FRAMES[fi]
    frame = phone(frame, r)
    turns = []
    for C_, member in ((yes, True), (no, False)):
        msg = tidy(frame.replace("{X}", text).replace("{C}", C_["name"].lower()).replace("{kw}", kw))
        keys = v.select(kind, name=name_arg, linked_to=C_["key"])
        if v.active_default(kind, C_["key"], [], msg):
            keys = [k for k in keys if v.rows[k]["status"] in ACTIVE]
        if (x["key"] in keys) != member:
            return None
        turns.append(Turn(msg, gold_rows(keys), [C("answer", kind=kind, name=name_arg, linked_to=f"${C_['key']}")]))
    return (make_item(ctx, "CONT", "member", f"{fi}", f"membership: the {kw}", [turns[0]], tags=(kind,)),
            make_item(ctx, "CONT", "member", f"{fi}", f"membership: the {kw}", [turns[1]], tags=(kind,)))


MOVE_FRAMES = [("command", "move {X} to the {C} {kw}"), ("command", "put {X} in the {C} {kw}"), ("command", "file {X} under the {C} {kw}"),
               ("command", "stick {X} in the {C} {kw}"), ("command", "add {X} to the {C} {kw}"), ("question", "can we move {X} to the {C} {kw}?"),
               ("question", "{X} to the {C} {kw}?"), ("indirect", "can you move {X} to the {C} {kw}"), ("indirect", "could you put {X} in the {C} {kw}"),
               ("indirect", "would you file {X} in the {C} {kw}")]


def cont_move(ctx: Ctx, r):
    """'move X to the Y list': the pair flips the destination container (the old link goes where a row has one container)."""
    v = ctx.v
    kind = r.choice(["task", "note", "document", "photo", "person"])
    rows = [x for x in v.of(kind) if name_options(v, x) and not x.get("me") and (kind != "task" or x["status"] in ACTIVE)]
    if not rows:
        return None
    x = r.choice(rows)
    ck, kw = CONT_OF[kind]
    mine = set(containers_of(v, x))
    dests = [c for c in v.of(ck) if c["key"] not in mine]
    if len(dests) < 2:
        return None
    c1, c2 = r.sample(dests, 2)
    style, text, name_arg = pick_name(v, x, r)
    fi = r.randrange(len(MOVE_FRAMES))
    mood, frame = MOVE_FRAMES[fi]
    frame = phone(frame, r)
    turns = []
    for C_ in (c1, c2):
        msg = tidy(frame.replace("{X}", text).replace("{C}", C_["name"].lower()).replace("{kw}", kw))
        changes = [g_link(C_["key"], x["key"])]
        if kind in SINGLE and SINGLE[kind](x):
            changes.append({"change": "removed", "from": SINGLE[kind](x), "to": x["key"]})
        turns.append(Turn(msg, gold_diff([], changes), [C("act", verb="add_to", kind=kind, name=name_arg, args=f"to: ${C_['key']}")]))
    return (make_item(ctx, "CONT", "move", f"{fi}", f"move to: the {kw}", [turns[0]], tags=(kind, "add_to")),
            make_item(ctx, "CONT", "move", f"{fi}", f"move to: the {kw}", [turns[1]], tags=(kind, "add_to")))


for _n, _f, _w, _fr in (("which", cont_which, 1.6, len(WHICH_FRAMES) * 4), ("subtasks", cont_sub, 1.4, len(SUB_FRAMES) + len(SUB_COUNT)),
                        ("member", cont_member, 2.0, len(IN_FRAMES) * 5), ("move", cont_move, 2.2, len(MOVE_FRAMES) * 5)):
    register("CONT", _n, _f, _w, _fr)


# =============================================================================================================
# the train corpus's own gaps (--weights): which universe cells a drill lands in, and how to weight toward the thin ones
# =============================================================================================================

GAP_WEIGHT = {"uncovered": 3.0, "thin": 2.0, "": 1.0}


def export_dir(nt: str) -> str:
    """One `nativetools export` per runtime binary, shared by every process (cells.export() alone makes a new temp directory each time)."""
    st = os.stat(nt)
    d = Path(tempfile.gettempdir()) / ("drills-export-" + hashlib.sha1(f"{nt}:{st.st_size}:{st.st_mtime_ns}".encode()).hexdigest()[:12])
    if not (d / "kind_card.txt").exists():
        tmp = Path(tempfile.mkdtemp(prefix="drills-export-wip-"))
        subprocess.run([nt, "export", str(tmp)], check=True, capture_output=True)
        try:
            os.rename(tmp, d)  # atomic: a process that loses the race keeps the winner's copy
        except OSError:
            shutil.rmtree(tmp, ignore_errors=True)
    return str(d)


class Gaps:
    """The cells of tables A, B and C that the train corpus never (uncovered) or rarely (thin) produces, from the census
    (`train-coverage.json`, or the md twin). An item's tier is the best tier among the cells its reference calls land in."""

    def __init__(self, path: str | None = None):
        self.unc: set[str] = set()
        self.thin: dict[str, int] = {}
        self.path = path
        if path:
            self._load(Path(path))
        self._cov = None
        self._worlds: dict[str, object] = {}

    def _load(self, p: Path) -> None:
        if p.suffix == ".json":
            d = json.loads(p.read_text())
            for t in "ABC":
                tb = d["tables"][t]
                self.unc |= {f"{c[0]}: " + " · ".join(c[1:]) for c in tb["uncovered"]}
                self.thin.update(tb["thin"])
            return
        sect = None
        for line in p.read_text().splitlines():
            m = re.match(r"^### ([ABC]): (uncovered|thin)", line)
            if m:
                sect = m.group(2)
                continue
            if line.startswith("#"):
                sect = None
            if sect and line.startswith("- "):
                text = line[2:].strip()
                if sect == "uncovered":
                    self.unc.add(text)
                else:
                    cell, _, n = text.rpartition(": ")
                    self.thin[cell] = int(n)

    def tier(self, cell: str) -> str:
        return "uncovered" if cell in self.unc else "thin" if cell in self.thin else ""

    def tier_of(self, cells: set[str]) -> str:
        ts = {self.tier(c) for c in cells}
        return "uncovered" if "uncovered" in ts else "thin" if "thin" in ts else ""

    def cov(self):
        if self._cov is None:
            sys.path.insert(0, str(AUTHORED))
            import cells as cells_mod
            import coverage as coverage_mod
            self._cov = (coverage_mod, cells_mod, cells_mod.export(export_dir(cells_mod.NT)))
        return self._cov

    def item_cells(self, w: str, turns: list) -> set[str]:
        """The A, B and C cells (as cells.cell_str writes them) of the reference calls of an item."""
        coverage, cells_mod, x = self.cov()
        wo = self._worlds.get(w)
        if wo is None:
            wo = self._worlds[w] = coverage.World(AUTHORED / "worlds", w)
        out: set[str] = set()
        for t in turns:
            gl = t.gold if isinstance(t.gold, list) else [t.gold]
            turn = {"ref": t.ref, "gold": gl}
            diff_keys = {r.get("key") for g in gl for r in (g.get("diff") or {}).get("rows", []) if r.get("key")}
            gold_rows = {k for g in gl if g.get("type") == "rows" for k in g.get("rows", [])}
            for c in t.ref:
                if c.get("bad"):
                    continue
                a = c.get("args") or {}
                kinds = coverage.call_kinds(c, wo, None)
                if kinds == ["?"]:
                    kinds = sorted({wo.kind_of("$" + k) for k in gold_rows | diff_keys} - {"?"}) or ["?"]
                if c["tool"] == "act" and a.get("verb") != "undo":
                    for kd in kinds:
                        for sel in (["—"] if a.get("verb") == "create" else coverage.selectors(c, turn)):
                            out.add(cells_mod.cell_str(("A", a.get("verb", "?"), kd, sel)))
                if a.get("where"):
                    for kd in kinds:
                        for f, op, val in coverage.where_conds(a["where"]):
                            if op != "?":
                                out.add(cells_mod.cell_str(("B", f"{kd}.{f}", op, coverage.value_form(kd, f, op, val, x))))
                for shape in coverage.date_shapes(a):
                    for kd in kinds:
                        out.add(cells_mod.cell_str(("C", kd, shape)))
        return out


# =============================================================================================================
# richer facets (numbers with and without units, every comparison, link counts, status sets) and span phrases
# =============================================================================================================

PLURAL = {"person": "people", "event": "events", "task": "tasks", "note": "notes", "photo": "photos", "debt": "debts", "group": "groups",
          "document": "documents", "album": "albums", "list": "lists", "notebook": "notebooks", "folder": "folders"}
COUNT_PAIRS = {"person": ["group", "event", "task", "note", "photo", "debt"], "task": ["person", "list", "task"], "event": ["person"], "note": ["notebook", "person"],
               "document": ["folder"], "photo": ["album", "person"], "debt": ["person"], "group": ["person"], "list": ["task"], "notebook": ["note"],
               "folder": ["document"], "album": ["photo"]}


def count_text(op: str, n: int, what: str) -> list[str]:
    nouns, noun = PLURAL[what], what
    nn = noun if n == 1 else nouns
    if (op, n) == ("=", 0):
        return [f"with no {nouns}", f"without any {nouns}"]
    if (op, n) in ((">=", 1), ("!=", 0), (">", 0)):
        return [f"with at least one {noun}", f"with any {nouns}"]
    if op == "=":
        return [f"with exactly {n} {nn}"]
    if op == ">":
        return [f"with more than {n} {nn}"]
    if op == ">=":
        return [f"with {n} or more {nouns}", f"with at least {n} {nn}"]
    if op == "<":
        return [f"with fewer than {n} {nn}", f"with less than {n} {nn}"]
    if op == "<=":
        return [f"with at most {n} {nn}", f"with {n} {nn} or fewer"]
    return [f"that don't have exactly {n} {nn}", f"with anything but {n} {nn}"]


def num_phrase(op: str, n: int, unit_word: str | None, unit_in_text: bool, kind_word: str) -> list[str]:
    """The words for `field op n`: 'over 60 minutes', 'exactly 30 minutes'..."""
    nn = (f"{n} {unit_word}" if unit_word else str(n)) if unit_in_text else str(n)
    lead = {">": ["over", "more than"] + (["longer than"] if kind_word == "time" else []),
            "<": ["under", "less than"] + (["shorter than"] if kind_word == "time" else []),
            ">=": ["at least"], "<=": ["at most", "no more than"], "=": ["exactly"], "!=": ["anything but", "not"]}[op]
    return [f"{w} {nn}" for w in lead]


class RichBank(FacetBank):
    NUMERIC = {("task", "effort"): ((15, 20, 30, 45, 60, 90, 120), "minutes", "time", 6), ("event", "duration"): ((30, 45, 60, 90, 120, 180), "minutes", "time", 6),
               ("person", "cadence"): ((7, 14, 21, 30), "days", "plain", 6), ("debt", "amount"): ((10, 20, 25, 30, 50, 100, 200), None, "money", 6)}

    def numeric_facet(self, kind: str, field: str) -> Facet | None:
        v = self.v
        thresholds, unit, kw, rank = self.NUMERIC[(kind, field)]
        unit = unit or v.currency
        opts = []
        for n in thresholds:
            for op in (">", "<", ">=", "<=", "=", "!="):
                if kind == "debt" and field == "amount" and op in ("=", "!=") and n not in {int(d["amount"]) for d in v.of("debt") if float(d["amount"]).is_integer()}:
                    continue
                res = v.select(kind, where=[(field, op, n)])
                if not (0 < len(res) <= ROW_CAP + 6):
                    continue
                for form in ("bare", "unit"):
                    val = n if form == "bare" else f"{n} {unit}"
                    if kind in ("task", "event"):
                        leads = num_phrase(op, n, None, False, kw)
                        leads = [w[: -len(str(n))].strip() for w in leads]
                        amt = f"{n} minutes" if form == "unit" else mins_text(n)[0]
                        texts = [_tx(post=f"{w} {amt}") for w in leads]
                    elif field == "cadence":
                        texts = [_tx(post="on a cadence of " + p + ("" if form == "unit" else " days")) for p in num_phrase(op, n, "days", form == "unit", kw)]
                    else:
                        texts = [_tx(post=p) for p in num_phrase(op, n, unit.lower(), form == "unit", kw)]
                    opts.append(Opt(f"{field} {op} {n} {form}", texts, where=[(field, op, val)], fam=f"{field}-{form}"))
        return Facet(field, kind, opts, frozenset({field}), rank=rank) if opts else None

    def count_facets(self, kind: str) -> list[Facet]:
        v = self.v
        out = []
        for what in COUNT_PAIRS.get(kind, []):
            vals = sorted({v.count_of(r_, what) for r_ in v.of(kind)} - {None})
            opts = []
            for n in vals[:7]:
                for op in ("=", "!=", ">", "<", ">=", "<="):
                    res = v.select(kind, where=[(f"{what} count", op, n)])
                    if not (0 < len(res) <= ROW_CAP + 6):
                        continue
                    if len(res) == len(v.of(kind)):
                        continue
                    opts.append(Opt(f"{what} count {op} {n}", [_tx(post=t) for t in count_text(op, n, what)], where=[(f"{what} count", op, n)], fam=f"count-{what}"))
            if opts:
                out.append(Facet(f"count-{what}", kind, opts, frozenset({f"count-{what}"}), rank=6))
        return out

    def facets(self, kind: str) -> list[Facet]:
        if kind not in self.cache:
            base = [f for f in getattr(self, "f_" + kind.replace(" ", "_"))() if f and len(f.opts) >= 1]
            base = [f for f in base if (kind, f.id) not in self.NUMERIC]
            extra = []
            for (k, field) in self.NUMERIC:
                if k == kind:
                    nf = self.numeric_facet(kind, field)
                    if nf:
                        extra.append(nf)
            extra += self.count_facets(kind)
            extra += self.more_facets(kind)
            self.cache[kind] = base + [f for f in extra if f and f.opts]
        return self.cache[kind]

    def more_facets(self, kind: str) -> list[Facet]:
        v = self.v
        out = []
        if kind == "task":
            pr = [Opt(f"priority != {n}", [_tx(post=f"with any priority but {n}"), _tx(post=f"not priority {n}")], where=[("priority", "!=", n)])
                  for n in (1, 2, 3) if 0 < len(v.select("task", where=[("priority", "!=", n)])) <= ROW_CAP + 6]
            out.append(Facet("priority-ne", "task", pr, frozenset({"priority"}), rank=2))
            out.append(Facet("completed", "task", [Opt("completed is set", [_tx(post="with a completion date"), _tx(post="that have a completion date")], where=[("completed", "is set", None)]),
                                                     ], frozenset({"completed"}), rank=5))
            out.append(Facet("effort-set", "task", [Opt("effort is set", [_tx(post="with an effort estimate"), _tx(post="that have an effort estimate")], where=[("effort", "is set", None)]),
                                                      Opt("effort is empty", [_tx(post="with no effort estimate"), _tx(post="that have no effort estimate")], where=[("effort", "is empty", None)])],
                             frozenset({"effort"}), rank=5))
            out.append(Facet("status-in", "task", [Opt("status in active", [_tx(pre="active")], where=[("status", "in", ["open", "in_progress"])]),
                                                     Opt("status in closed", [_tx(pre="closed")], where=[("status", "in", ["completed", "cancelled"])])],
                             frozenset({"status"}), rank=1))
        if kind == "event":
            out.append(Facet("status-in", "event", [Opt("status in tentative or cancelled", [_tx(pre="tentative or cancelled")], where=[("status", "in", ["tentative", "cancelled"])]),
                                                      Opt("status in tentative", [_tx(pre="unconfirmed"), _tx(pre="not yet confirmed")], where=[("status", "in", ["tentative"])])],
                             frozenset({"status"}), rank=1))
        if kind == "debt":
            out.append(Facet("status-in", "debt", [Opt("status in open", [_tx(pre="still-open")], where=[("status", "in", ["open"])]),
                                                     Opt("status in settled", [_tx(pre="paid-up")], where=[("status", "in", ["settled"])])],
                             frozenset({"status"}), rank=1))
            out.append(Facet("direction-in", "debt", [Opt("direction in owes_me", [_tx(post="people owe me")], where=[("direction", "in", ["owes_me"])]),
                                                        Opt("direction in i_owe", [_tx(post="i owe people")], where=[("direction", "in", ["i_owe"])])],
                             frozenset({"direction"}), rank=4))
        if kind == "document":
            out.append(Facet("unstarred", "document", [Opt("starred != yes", [_tx(pre="unstarred"), _tx(pre="un-starred")], where=[("starred", "!=", "yes")])],
                             frozenset({"starred"}), rank=1))
        if kind == "photo":
            out.append(Facet("unstarred", "photo", [Opt("starred != yes", [_tx(pre="unstarred")], where=[("starred", "!=", "yes")])], frozenset({"starred"}), rank=1))
        if kind == "locker item":
            hosts = collections.Counter((r_["url"] or "") for r_ in v.of("locker item") if r_.get("url"))
            out += self.text_facets("locker item", "url", [u for u, n in sorted(hosts.items()) if n == 1][:12], phrase_url, url_parts, cap=1, rank=5)
            out.append(Facet("url-set", "locker item", [Opt("url is set", [_tx(post="with a url")], where=[("url", "is set", None)]),
                                                          Opt("url is empty", [_tx(post="with no url")], where=[("url", "is empty", None)])], frozenset({"url"}), rank=5))
        return out

    f_list = f_notebook = f_folder = f_album = lambda self: []


def span_phrases(today: dt.date) -> list[Ph]:
    """Spans whose two ends are different shapes (a weekday and a typed date, a clock on one end): the shapes the train
    corpus rarely writes. fam `span`."""
    out: list[Ph] = []
    wds = list(range(7))
    for i in wds:
        for j in wds:
            if i == j:
                continue
            a, b = wd_expr_of(today, i), wd_expr_of(today, j)
            ra, rb = resolve(a, dt.datetime.combine(today, dt.time(9, 0))), resolve(b, dt.datetime.combine(today, dt.time(9, 0)))
            if ra[1] < rb[1] and (rb[1] - ra[1]).days <= 6:
                out.append(Ph(f"from {WEEKDAYS[i]} to {WEEKDAYS[j]}", span(a, b), "from..to[rel+unit+weekday | rel+unit+weekday]", "span"))
    for k in range(3, 20, 4):
        d = today + dt.timedelta(days=k)
        for j in (0, 3, 5):
            w = wd_expr_of(today, (d.weekday() + j - 2) % 7)
            rw = resolve(w, dt.datetime.combine(today, dt.time(9, 0)))[1]
            if rw < d and (d - rw).days <= 10:
                out.append(Ph(f"from {WEEKDAYS[(d.weekday() + j - 2) % 7]} to {day_text(d)}", span(w, Dt(d.isoformat())), "from..to[rel+unit+weekday | date]", "span"))
            if rw > d and (rw - d).days <= 10:
                out.append(Ph(f"from {day_text(d)} to {WEEKDAYS[(d.weekday() + j - 2) % 7]}", span(Dt(d.isoformat()), w), "from..to[date | rel+unit+weekday]", "span"))
    for k in range(2, 16, 5):
        d = today + dt.timedelta(days=k)
        d2 = d + dt.timedelta(days=4)
        out.append(Ph(f"from {day_text(d)} at 3pm to {day_text(d2)}", span(Dt(d.isoformat(), "15:00"), Dt(d2.isoformat())), "from..to[date+time | date]", "span"))
        w = wd_expr_of(today, d2.weekday())
        if resolve(w, dt.datetime.combine(today, dt.time(9, 0)))[1] > d:
            out.append(Ph(f"from {day_text(d)} at 3pm to {WEEKDAYS[d2.weekday()]}", span(Dt(d.isoformat(), "15:00"), w), "from..to[date+time | rel+unit+weekday]", "span"))
        w0 = wd_expr_of(today, d.weekday())
        if resolve(w0, dt.datetime.combine(today, dt.time(9, 0)))[1] < d2:
            out.append(Ph(f"from {WEEKDAYS[d.weekday()]} to {day_text(d2)} at 6pm", span(w0, Dt(d2.isoformat(), "18:00")), "from..to[rel+unit+weekday | date+time]", "span"))
    return out


DECO_PRE = ["ok ", "and ", "now ", "then ", "also ", "ah ", "right, ", "so "]
DECO_SUF = [" please", " now", " thanks", " for me", " ok", " pls"]


def pick_deco(r) -> tuple[str, str]:
    """A prefix and a suffix a person might add to a short follow-up ('ok delete them now'); drawn once per pair so the two
    siblings share it (the follow-up messages of a world must be distinct, and 'delete them' has only so many spellings)."""
    return (r.choice(DECO_PRE) if r.random() < 0.5 else "", r.choice(DECO_SUF) if r.random() < 0.45 else "")


def deco(msg: str, d: tuple[str, str]) -> str:
    pre, suf = d
    low = msg.lower()
    if pre and not re.match(r"^(can|could|would|shall|should|and|now|ok|actually|no wait|also|then|so|ah|right)\b", low):
        msg = pre + msg
    if suf and not re.search(r"\b(please|now|thanks|pls|too|as well|also|ok)\b", low):
        msg = (msg[:-1] + suf + "?") if msg.endswith("?") else msg + suf
    return msg


# =============================================================================================================
# FOLLOW: turn 2 leans on turn 1 (an ordinal, "the other", "what else", "same for", "both", @prev)
# =============================================================================================================

ORDS = ["first", "second", "third", "fourth", "fifth"]
ORD_FRAMES_READ = [("command", "tell me about the {o} one"), ("command", "show me the {o} one"), ("command", "open the {o} one"), ("command", "more on the {o} one"),
                   ("question", "what's the {o} one?"), ("question", "the {o} one?"), ("question", "what about the {o} one"),
                   ("indirect", "can you show me the {o} one"), ("indirect", "could you pull up the {o} one")]
SORT_TAILS = ["soonest first", "earliest first", "in date order", "by date"]


LIST_LISTING = 0.3  # of the task listings a follow-up leans on, the share read through a list (`linked_to`): the natural reads of a first turn carry it a quarter of the time


TASK_LISTING_FACETS = ("priority", "effort", "name", "count-person", "priority-ne")


def task_listings(ctx: Ctx, r, ok) -> list:
    """The open tasks a follow-up can lean on, in date order, read by something other than a list: [(args, keys, the words that say it)] of a
    window ("due next week") or of one condition (priority, effort, a word of the name, the people on it) whose count satisfies `ok(n)`, whose
    dates are all there and all different (an ordinal names one row). `vi` of the words is drawn from `r`."""
    v, bank = ctx.v, ctx.bank
    st = next((f for f in bank.facets("task") if f.id == "status"), None)
    open_opt = next((o for o in (st.opts if st else []) if o.id == "open"), None)
    if open_opt is None:
        return []
    order = Opt("order", [_tx()], order=("date", "asc"))
    vi = r.randrange(4)
    out = []

    def add(chosen, words):
        keys = sel_keys(v, "task", chosen + [order], words)
        every = sel_keys(v, "task", chosen, words)
        ds = [stamp_dt(v.rows[k]["date"]) for k in keys if v.rows[k]["date"]]
        if ok(len(keys)) and len(keys) == len(every) and len(ds) == len(keys) and len(set(ds)) == len(ds):
            out.append((sel_args("task", chosen + [order]), keys, words))

    for f in bank.facets("task"):
        if f.id == "when":
            for o in f.opts:
                if o.fam in ("week", "weekend", "month"):
                    add([open_opt, o], f"open tasks {o.text(vi)[1]}")
        elif f.id in TASK_LISTING_FACETS:
            for o in f.opts:
                if not o.linked and not o.when:
                    add([open_opt, o], compose("task", [(st, open_opt), (f, o)], vi))
    return out


def sorted_listing(ctx: Ctx, r, verb: str | None, lo=3, hi=7):
    """A turn-1 listing in a known order: (kind, args, keys, message, frame index). Tasks on a list (LIST_LISTING of the time) or due in a
    window, events in a window."""
    v = ctx.v
    kind = r.choice(["task", "event"]) if verb is None else ("task" if verb in ("complete", "reopen") else "event")
    tail = r.choice(SORT_TAILS)
    fi = r.randrange(len(READ_FRAMES))
    mood, frame = READ_FRAMES[fi]
    frame = phone(frame, r)
    if kind == "task":
        cands = []
        for L in v.of("list"):
            keys = [k for k in v.select("task", linked_to=L["key"], where=[("status", "=", "open")], order=("date", "asc"))]
            dates = [v.rows[k]["date"] for k in keys]
            if lo <= len(keys) <= hi and len(keys) == len(v.select("task", linked_to=L["key"], where=[("status", "=", "open")])) \
                    and len({stamp_dt(d) for d in dates if d}) == len(keys):
                cands.append((L, keys))
        others = task_listings(ctx, r, lambda n: lo <= n <= hi)
        if cands and (not others or r.random() < LIST_LISTING):
            L, keys = r.choice(cands)
            args = dict(kind="task", linked_to=f"${L['key']}", where="status = open", order="date asc")
            x = f"open tasks on the {L['name'].lower()} list, {tail}"
        elif others:
            args, keys, words = r.choice(others)
            x = f"{words}, {tail}"
        else:
            return None
    else:
        cands = []
        for p in ctx.ph:
            if p.fam not in ("week", "weekend", "month") or not p.future:
                continue
            keys = v.select("event", when=p.expr, order=("date", "asc"))
            live = [k for k in keys if v.rows[k]["status"] != "cancelled"]
            ds = [stamp_dt(v.rows[k]["date"]) for k in keys]
            if lo <= len(keys) <= hi and len(set(ds)) == len(ds) and len(live) == len(keys):
                cands.append((p, keys))
        if not cands:
            return None
        p, keys = r.choice(cands)
        args = dict(kind="event", when=jx(p.expr), order="date asc")
        x = f"events {p.text}, {tail}"
    return kind, args, keys, tidy(frame.replace("{X}", x)), fi


def follow_ordinal(ctx: Ctx, r, mode: str):
    """F1/F6: turn 1 lists rows in date order, turn 2 acts on (or reads) 'the second one'; the pair flips the ordinal."""
    v = ctx.v
    verb = r.choice(["complete", "cancel"]) if mode == "act" else None
    got = sorted_listing(ctx, r, verb)
    if got is None:
        return None
    kind, args, keys, msg1, fi1 = got
    if verb is None:
        verb = None
    verb = verb or ("complete" if kind == "task" else "cancel")
    n = len(keys)
    ords = list(range(min(n, 5)))
    o1, o2 = r.sample(ords, 2)
    ordname = lambda i: ORDS[i]  # noqa: E731
    if mode == "act":
        rows_ok = [i for i in range(min(n, 5)) if can_verb(v, verb, v.get(keys[i]))]
        if len(rows_ok) < 2:
            return None
        o1, o2 = r.sample(rows_ok, 2)
        fi, mood, frame = verb_frame(ctx, r, verb)
        dco = pick_deco(r)
        make = lambda i: Turn(deco(fill(frame, f"the {ordname(i)} one"), dco), gold_diff([VERBS[verb]["gold"](v, keys[i])]), [C("act", verb=verb, rows=f"${keys[i]}")])  # noqa: E731
        fam = f"{kind}.{verb}.{fi1}.{fi}"
    else:
        fi = r.randrange(len(ORD_FRAMES_READ))
        mood, frame = ORD_FRAMES_READ[fi]
        frame = phone(frame, r)
        dco = pick_deco(r)
        make = lambda i: Turn(deco(tidy(frame.replace("{o}", ordname(i))), dco), gold_rows([keys[i]]), [C("answer", rows=f"${keys[i]}")])  # noqa: E731
        fam = f"{kind}.read.{fi1}.{fi}"
    t1 = Turn(msg1, gold_rows(keys, order=True), [C("answer", **args)])
    return (make_item(ctx, "FOLLOW", "ordinal-" + mode, fam, "which ordinal", [t1, make(o1)], tags=(kind, verb or "read")),
            make_item(ctx, "FOLLOW", "ordinal-" + mode, fam, "which ordinal", [t1, make(o2)], tags=(kind, verb or "read")))


ELSE_T1 = [("command", "show me the first {n} open tasks on the {L} list"), ("command", "give me the {n} earliest open tasks on the {L} list"),
           ("question", "what are the first {n} open tasks on the {L} list?"), ("question", "which {n} tasks are due first on the {L} list?"),
           ("indirect", "can you show me the first {n} open tasks on the {L} list"), ("indirect", "could you list the {n} earliest open tasks on the {L} list")]
ELSE_T2 = ["what else", "what else is open", "anything else?", "what else is there", "any others?", "and what else", "what other ones are there", "what else is on there"]


def follow_else(ctx: Ctx, r):
    """F2: turn 1 shows the first N, turn 2 'what else' leaves those out; the pair flips which list was shown."""
    v = ctx.v
    lists = []
    for L in v.of("list"):
        keys = v.select("task", linked_to=L["key"], where=[("status", "=", "open")], order=("date", "asc"))
        every = v.select("task", linked_to=L["key"], where=[("status", "=", "open")])
        if len(keys) >= 4 and len(every) <= ROW_CAP + 4:
            lists.append((L, keys, every))
    if len(lists) < 2:
        return None
    (L1, k1, e1), (L2, k2, e2) = r.sample(lists, 2)
    n = r.choice([2, 3])
    fi = r.randrange(len(ELSE_T1))
    mood, frame = ELSE_T1[fi]
    frame = phone(frame, r)
    t2i = r.randrange(len(ELSE_T2))
    msg2 = deco(phone(ELSE_T2[t2i], r), pick_deco(r))
    sides = []
    for L, keys, every in ((L1, k1, e1), (L2, k2, e2)):
        dates = [stamp_dt(v.rows[k]["date"]) if v.rows[k]["date"] else None for k in keys]
        top = keys[:n]
        if None in dates[: n + 1] or len(set(dates[: n + 1])) != len(dates[: n + 1]):
            return None
        rest = [k for k in every if k not in top]
        if not (1 <= len(rest) <= ROW_CAP):
            return None
        t1 = Turn(tidy(frame.replace("{n}", say_num(n)).replace("{L}", L["name"].lower())), gold_rows(top, order=True),
                  [C("answer", kind="task", linked_to=f"${L['key']}", where="status = open", order="date asc", limit=n)])
        t2 = Turn(msg2, gold_rows(rest), [C("answer", kind="task", linked_to=f"${L['key']}", where="status = open", exclude="@prev")])
        sides.append([t1, t2])
    return (make_item(ctx, "FOLLOW", "what-else", f"{fi}.{t2i}", "what was shown (the list)", sides[0], tags=("task",)),
            make_item(ctx, "FOLLOW", "what-else", f"{fi}.{t2i}", "what was shown (the list)", sides[1], tags=("task",)))


SAME_T2 = ["same for {p}", "and {p}?", "what about {p}", "how about {p}", "and for {p}", "{p} too?", "same with {p}", "and {p}'s?"]
SAME_KINDS = {"event": ("events with {p}", "what's on with {p}", "event"), "photo": ("photos of {p}", "what photos have {p}", "photo"), "debt": ("debts with {p}", "what's open with {p}", "debt")}


def follow_same_for(ctx: Ctx, r):
    """F3: turn 1 reads something about a person, turn 2 'same for B' keeps the call and swaps the person."""
    v = ctx.v
    kind = r.choice(["event", "event", "photo", "debt"])
    people = [p for p in v.of("person") if not p.get("me") and 1 <= len(v.select(kind, linked_to=p["key"])) <= ROW_CAP]
    if len(people) < 3:
        return None
    a, b, c = r.sample(people, 3)
    if len({tuple(v.select(kind, linked_to=x["key"])) for x in (b, c)}) < 2:
        return None
    fi = r.randrange(len(READ_FRAMES))
    mood, frame = READ_FRAMES[fi]
    frame = phone(frame, r)
    t2i = r.randrange(len(SAME_T2))
    msg2f = phone(SAME_T2[t2i], r)
    noun = NOUN[kind]

    def person_text(p):
        first = BankHelper.first(ctx, p)
        return first.lower() if (first and r.random() < 0.4) else p["name"].lower()

    ta = person_text(a)
    dco = pick_deco(r)
    t1 = Turn(tidy(frame.replace("{X}", f"{noun} with {ta}" if kind != "photo" else f"{noun} of {ta}")), gold_rows(v.select(kind, linked_to=a["key"])),
              [C("answer", kind=kind, linked_to=shown_key(a))])
    sides = []
    for p in (b, c):
        pt = person_text(p)
        if not key_safe(v, p, pt) or not key_safe(v, a, ta):
            return None
        keys = v.select(kind, linked_to=p["key"])
        poss = pt + ("'s" if "'s" in msg2f else "")
        msg2 = deco(tidy(msg2f.replace("{p}'s", poss).replace("{p}", pt)), dco)
        sides.append([t1, Turn(msg2, gold_rows(keys), [C("answer", kind=kind, linked_to=shown_key(p))])])
    return (make_item(ctx, "FOLLOW", "same-for", f"{kind}.{fi}.{t2i}", "same for: the person", sides[0], tags=(kind,)),
            make_item(ctx, "FOLLOW", "same-for", f"{kind}.{fi}.{t2i}", "same for: the person", sides[1], tags=(kind,)))


class BankHelper:
    @staticmethod
    def first(ctx: Ctx, p: dict):
        return ctx.bank.first_unique(p)


AND_T2 = ["and {p}?", "what about {p}", "how about {p}", "{p}?", "and for {p}", "same but {p}", "and {p} then?", "same for {p}"]


def follow_and_when(ctx: Ctx, r):
    """F3b: turn 1 reads a window, turn 2 'and friday?' swaps only the date."""
    v = ctx.v
    kind = r.choice(["event", "task"])
    phs = [p for p in ctx.ph if p.fam in ("weekday", "day", "week", "weekend") and p.future]
    p1, p2, p3 = r.sample(phs, 3)
    res = [v.select(kind, when=p.expr) for p in (p1, p2, p3)]
    if not (1 <= len(res[0]) <= ROW_CAP) or res[1] == res[2] or max(len(x) for x in res) > ROW_CAP:
        return None
    if not (res[1] or res[2]):
        return None
    fi = r.randrange(len(READ_FRAMES))
    mood, frame = READ_FRAMES[fi]
    frame = phone(frame, r)
    t2i = r.randrange(len(AND_T2))
    msg2f = phone(AND_T2[t2i], r)
    noun = NOUN[kind]
    lead = "due " if kind == "task" else ""
    dco = pick_deco(r)
    sides = []
    t1 = Turn(tidy(frame.replace("{X}", f"{noun} {lead}{date_connect(kind, p1, 0).replace('due ', '')}")), gold_rows(res[0]), [C("answer", kind=kind, when=jx(p1.expr))])
    for p, keys in ((p2, res[1]), (p3, res[2])):
        sides.append([t1, Turn(deco(tidy(msg2f.replace("{p}", p.text)), dco), gold_rows(keys), [C("answer", kind=kind, when=jx(p.expr))])])
    return (make_item(ctx, "FOLLOW", "and-when", f"{kind}.{fi}.{t2i}", "and <date>: the new date", sides[0], shape=p2.shape, tags=(kind,)),
            make_item(ctx, "FOLLOW", "and-when", f"{kind}.{fi}.{t2i}", "and <date>: the new date", sides[1], shape=p3.shape, tags=(kind,)))


WITHIN_T2 = [("command", "narrow that down to {X}"), ("command", "keep only {X}"), ("command", "now just {X}"), ("command", "filter those to {X}"),
             ("command", "show me just {X}"), ("question", "which of those {P}?"), ("question", "which of them {P}?"), ("question", "what about just {X}?"),
             ("question", "just {X}?"), ("indirect", "can you narrow that down to {X}"), ("indirect", "could you filter those to {X}"),
             ("indirect", "can you show me just {X}")]
CLAUSE_STARTS = {"with", "without", "in", "on", "from", "about", "involving", "of", "at", "that", "whose", "i", "people", "mentioning", "for"}


def within_phrases(opt: Opt, vi: int) -> tuple[str, str]:
    """(X, P) for a turn-2 option: X as 'the ones due friday' / 'the starred ones', P as 'are due friday' / 'with priority 2'."""
    pre, post = opt.text(vi)
    if pre:
        return f"the {pre} ones", f"are {pre}"
    first = post.split()[0]
    return f"the ones {post}", post if first in CLAUSE_STARTS else f"are {post}"


def follow_within(ctx: Ctx, r):
    """F8: turn 1 lists a set, turn 2 narrows it ('which of those are due friday'): `within=@prev` plus one more constraint;
    both siblings share turn 1 and differ in the narrowing."""
    v, bank = ctx.v, ctx.bank
    kind = r.choice(["task", "task", "event", "debt", "person", "photo"])
    facs = bank.facets(kind)
    vi = r.randrange(4)
    for _ in range(12):
        chosen1, _flips = pick_facets(facs, r.choice([1, 2]), r, must_flip=False, ctx=ctx)
        if chosen1 is None:
            continue
        pairs1 = [(f, r.choices(f.opts, [tier_w(ctx, kind, o) for o in f.opts])[0]) for f in chosen1]
        x1 = compose(kind, pairs1, vi)
        keys1 = sel_keys(v, kind, [o for _, o in pairs1], x1)
        if 4 <= len(keys1) <= ROW_CAP:
            break
    else:
        return None
    used = set().union(*[f.groups for f in chosen1])
    cands = [dataclasses.replace(f, opts=[o for o in f.opts if not o.linked]) for f in facs if not f.groups & used]
    cands = [f for f in cands if len(f.opts) >= 2]
    if not cands:
        return None
    f2 = r.choices(cands, [facet_w(ctx, f) for f in cands])[0]

    def narrowed(o: Opt) -> list[str]:
        return v.select(kind, within=keys1, where=o.where, when=o.when, name=o.name)

    flip = choose_flip(f2.opts, narrowed, r, allow_empty=0.1, wfn=lambda o: tier_w(ctx, kind, o))
    if flip is None:
        return None
    fi1 = r.randrange(len(READ_FRAMES))
    f1 = phone(READ_FRAMES[fi1][1], r)
    fi2 = r.randrange(len(WITHIN_T2))
    f2txt = phone(WITHIN_T2[fi2][1], r)
    t1 = Turn(tidy(f1.replace("{X}", x1)), gold_rows(keys1), [C("answer", **sel_args(kind, [o for _, o in pairs1]))])
    dco = pick_deco(r)
    sides = []
    for o in flip:
        X, P = within_phrases(o, vi)
        t2 = Turn(deco(tidy(f2txt.replace("{X}", X).replace("{P}", P)), dco), gold_rows(narrowed(o)),
                  [C("answer", within="@prev", **sel_args(kind, [o]))])
        sides.append((o, [t1, t2]))
    return (make_item(ctx, "FOLLOW", "within", f"{kind}.{fi1}.{fi2}", f"within: {kind}.{f2.id}", sides[0][1], shape=sides[0][0].shape, tags=(kind, "within")),
            make_item(ctx, "FOLLOW", "within", f"{kind}.{fi1}.{fi2}", f"within: {kind}.{f2.id}", sides[1][1], shape=sides[1][0].shape, tags=(kind, "within")))


BOTH_X = ["both", "them both", "both of them", "the pair"]
ONE_X = ["the first one", "just the first one", "only the first one", "the first"]


def follow_both(ctx: Ctx, r):
    """F4: turn 1 lists exactly two rows, turn 2 'both' (rows=@prev) or 'the first one' (a pick)."""
    v = ctx.v
    kind = r.choice(["task", "event"])
    verb = "complete" if kind == "task" else "cancel"
    cands = []
    if kind == "task":
        by_list = []
        by_window = [(args, keys, words) for args, keys, words in task_listings(ctx, r, lambda n: n == 2)]
        for p in ctx.ph:
            if p.fam not in ("week", "weekday", "weekend", "month"):
                continue
            for L in v.of("list"):
                keys = v.select("task", linked_to=L["key"], where=[("status", "=", "open")], when=p.expr, order=("date", "asc"))
                ds = [stamp_dt(v.rows[k]["date"]) for k in keys]
                if len(keys) == 2 and len(set(ds)) == 2:
                    by_list.append((dict(kind="task", linked_to=f"${L['key']}", where="status = open", when=jx(p.expr), order="date asc"), keys,
                                    f"open tasks on the {L['name'].lower()} list due {p.text}"))
        cands = by_list if by_list and (not by_window or r.random() < LIST_LISTING) else by_window
    else:
        for p in ctx.ph:
            if p.fam not in ("week", "weekend", "month") or not p.future:
                continue
            keys = v.select("event", when=p.expr, where=[("status", "=", "tentative")], order=("date", "asc"))
            ds = [stamp_dt(v.rows[k]["date"]) for k in keys]
            if len(keys) == 2 and len(set(ds)) == 2 and all(stamp_dt(v.rows[k]["date"]) > v.now for k in keys):
                cands.append((dict(kind="event", where="status = tentative", when=jx(p.expr), order="date asc"), keys, f"tentative events {p.text}"))
    if not cands:
        return None
    args, keys, x = r.choice(cands)
    if not all(can_verb(v, verb, v.get(k)) for k in keys):
        return None
    fi1 = r.randrange(len(READ_FRAMES))
    mood, f1 = READ_FRAMES[fi1]
    t1 = Turn(tidy(phone(f1, r).replace("{X}", x)), gold_rows(keys, order=True), [C("answer", **args)])
    fi, mood, frame = verb_frame(ctx, r, verb)
    j = r.randrange(4)
    dco = pick_deco(r)
    tb = Turn(deco(fill(frame, BOTH_X[j]), dco), gold_diff([VERBS[verb]["gold"](v, k) for k in keys]), [C("act", verb=verb, rows="@prev")])
    to = Turn(deco(fill(frame, ONE_X[j]), dco), gold_diff([VERBS[verb]["gold"](v, keys[0])]), [C("act", verb=verb, rows=f"${keys[0]}")])
    return (make_item(ctx, "FOLLOW", "both-one", f"{kind}.{verb}.{fi}.{j}", "scope: both vs the first one", [t1, tb], tags=(kind, verb)),
            make_item(ctx, "FOLLOW", "both-one", f"{kind}.{verb}.{fi}.{j}", "scope: both vs the first one", [t1, to], tags=(kind, verb)))


OTHER_X = ["the other one too", "the other one as well", "the other one now", "the other one also"]


def follow_other(ctx: Ctx, r):
    """F5: turn 1 acts on one of two twins, turn 2 does 'the other one too'; the pair flips which twin turn 1 named."""
    v = ctx.v
    mode = r.choice(["person", "task", "event"])
    j = r.randrange(len(OTHER_X))
    if mode == "person":
        cands = [(a, b, S) for a, b, S in twin_person_pairs(v) if a["key"] < b["key"] and len(S) == 2 and a.get("role") and b.get("role")
                 and SIMPLE_ROLE.match(a["role"].lower()) and SIMPLE_ROLE.match(b["role"].lower()) and a["role"] != b["role"]
                 and not a["starred"] and not b["starred"]]
        if not cands:
            return None
        got = pick_role_twins(v, r, cands)
        if got is None:
            return None
        a, b, S, first, form, clauses = got
        vi = r.randrange(4)
        fi, mood, frame1 = verb_frame(ctx, r, "star")
        mood2, frame2 = VERB_FRAMES["star"][fi]
        frame2 = phone(frame2, r)
        dco = pick_deco(r)
        drop = drops_name(v, r, clauses)
        sides = []
        for P, Q in ((a, b), (b, a)):
            say, cond = clauses[P["key"]]
            x = role_phrases(first.lower(), say, vi)
            t1 = Turn(fill(frame1, x), gold_diff([VERBS["star"]["gold"](v, P["key"])]), [C("act", verb="star", kind="person", name=None if drop else first, where=cond_text(cond))])
            t2 = Turn(deco(fill(frame2, OTHER_X[j]), dco), gold_diff([VERBS["star"]["gold"](v, Q["key"])]), [C("act", verb="star", rows=f"${Q['key']}")])
            sides.append([t1, t2])
        fam = f"person.star.{fi}.{j}"
        return (make_item(ctx, "FOLLOW", "the-other", fam, "the other: which twin came first", sides[0], tags=("person",)),
                make_item(ctx, "FOLLOW", "the-other", fam, "the other: which twin came first", sides[1], tags=("person",)))
    kind = mode
    v1 = "complete" if kind == "task" else "cancel"
    sets = []
    for S in twin_sets(v)["same"]:
        if S[0]["kind"] != kind or not set_name_options(v, S):
            continue
        cand = [x for x in S if can_verb(v, v1, x)]
        if len(cand) == 2 and (kind == "task" or all(stamp_dt(x["date"]) > v.now for x in cand)):
            sets.append((S, cand))
    if not sets:
        return None
    S, cand = r.choice(sets)
    phs = [p for p in ctx.ph if p.future and p.fam in ("weekday", "day", "week", "weekend", "month", "named")]
    single = collections.defaultdict(dict)
    for p in phs:
        res = resolve(p.expr, v.now)
        for row in cand:
            if contains(res, row["date"]) and not any(contains(res, o["date"]) for o in S if o["key"] != row["key"] and can_verb(v, v1, o)):
                single[row["key"]].setdefault(p.fam, p)
    if len(single) < 2:
        return None
    pa, pb = None, None
    for fam in ("weekday", "week", "day", "weekend", "month", "named"):
        if all(fam in single[row["key"]] for row in cand):
            pa, pb = single[cand[0]["key"]][fam], single[cand[1]["key"]][fam]
            break
    if pa is None:
        return None
    name_text, name_arg = r.choice(set_name_options(v, S))
    vi = r.randrange(2)
    fi, mood, frame1 = verb_frame(ctx, r, v1)
    mood2, frame2 = VERB_FRAMES[v1][fi]
    frame2 = phone(frame2, r)
    dco = pick_deco(r)
    sides = []
    for (row, p), other in (((cand[0], pa), cand[1]), ((cand[1], pb), cand[0])):
        x = f"{name_text} {date_connect(kind, p, vi)}"
        t1 = Turn(fill(frame1, x), gold_diff([VERBS[v1]["gold"](v, row["key"])]), [C("act", verb=v1, kind=kind, name=name_arg, when=jx(p.expr))])
        t2 = Turn(deco(fill(frame2, OTHER_X[j]), dco), gold_diff([VERBS[v1]["gold"](v, other["key"])]), [C("act", verb=v1, kind=kind, name=name_arg)])
        sides.append([t1, t2])
    fam = f"{kind}.{v1}.{fi}.{j}"
    return (make_item(ctx, "FOLLOW", "the-other", fam, "the other: which twin came first", sides[0], shape=pa.shape, tags=(kind,)),
            make_item(ctx, "FOLLOW", "the-other", fam, "the other: which twin came first", sides[1], shape=pb.shape, tags=(kind,)))


# ---- the write on @prev: turn 1 lists rows, turn 2 changes "them" (rows=@prev) ------------------------------------------

PREV_FRAMES = {
    "delete": ["delete them", "delete all of them", "get rid of those", "wipe them", "wipe the lot", "can you delete them", "could you get rid of those", "would you delete all of those"],
    "unstar": ["unstar them", "take the star off them", "unstar all of those", "remove the stars", "can you unstar them", "could you take the stars off those", "unfavourite them", "un-star the lot"],
    "star": ["star them", "star all of those", "give them a star", "favourite them", "can you star them", "could you star all of those", "add stars to those", "star the lot"],
    "reopen": ["reopen them", "put those back on my list", "un-tick all of those", "reopen all of them", "can you reopen them", "could you put those back", "mark them as not done", "open them up again"],
    "restore": ["restore them", "bring those back", "undelete them", "restore all of those", "can you restore them", "could you bring them back", "put them back", "get those back"],
    "settle_debt": ["mark those as settled", "settle them", "mark them paid", "those are all settled now", "can you settle those", "could you mark them as paid", "settle all of those", "tick those off as paid"],
    "edit-event": ["make them {n} minutes", "set them to {n} minutes", "change them to {n} minutes long", "make those {n} minutes each", "can you make them {n} minutes",
                   "could you set those to {n} minutes", "they should be {n} minutes", "update them to {n} minutes"],
    "edit-task": ["set them to {n} minutes", "make them {n} minutes of effort", "give them {n} minutes each", "estimate {n} minutes for them", "can you set those to {n} minutes",
                  "could you give them {n} minutes", "they take {n} minutes", "update them to {n} minutes"],
    "edit-note": ["pin them", "pin all of those", "pin the lot", "put pins on them", "can you pin them", "could you pin those", "pin those too", "keep them pinned"],
    "edit-person": ["make them all {role}", "they're all {role}", "set their role to {role}", "change their role to {role}", "can you make them {role}", "could you set those to {role}",
                    "label them as {role}", "mark them as {role}"],
    "edit-name": ["rename it to {name}", "call it {name}", "change the name to {name}", "make it {name}", "can you rename it to {name}", "could you call it {name}",
                  "its name should be {name}", "retitle it {name}"],
    "reschedule": ["push them back a day", "move them a day later", "shift them a day", "delay them by a day", "can you push them back a day", "could you move them a day later",
                   "push those out a day", "bump them a day"],
}
PREV_KINDS = {"delete": ["person", "task", "event", "note", "document", "photo", "locker item"], "unstar": ["person", "document", "photo", "locker item"],
              "star": ["photo", "locker item", "person", "document"], "reopen": ["task"], "restore": ["task", "event", "note", "document", "photo", "person", "locker item"],
              "settle_debt": ["debt"], "edit": ["event", "task", "note", "person", "list", "folder", "album", "notebook", "group", "document", "photo"], "reschedule": ["event", "task"]}
NAME_BANK = ["Spring Clear-out", "Shared Stuff", "Misc", "Keepers", "To Sort", "Archive", "Family", "Admin", "Hold", "Later"]


def prev_forced(ctx: Ctx, verb: str, kind: str) -> list[Facet]:
    """Facets a turn-1 listing must carry so that every row it shows is one the verb changes."""
    bank = ctx.bank
    f = {x.id: x for x in bank.facets(kind)}
    if verb == "unstar":
        return [Facet("starred", kind, [Opt("starred", [_tx(pre="starred")], where=[("starred", "=", "yes")])], frozenset({"starred"}), rank=1)]
    if verb == "star":
        return [Facet("unstarred", kind, [Opt("starred = no", [_tx(pre="unstarred")], where=[("starred", "=", "no")])], frozenset({"starred"}), rank=1)]
    if verb == "reopen":
        o = next((o for o in f["status"].opts if o.id == "completed"), None) if "status" in f else None
        return [Facet("status", kind, [o], frozenset({"status"}), rank=1)] if o else []
    if verb == "settle_debt":
        o = next((o for o in f["status"].opts if o.id == "open"), None) if "status" in f else None
        return [Facet("status", kind, [o], frozenset({"status"}), rank=1)] if o else []
    if verb == "reschedule" and kind == "event":
        return [Facet("status", kind, [Opt("tentative", [_tx(pre="tentative")], where=[("status", "=", "tentative")])], frozenset({"status"}), rank=1)]
    if verb == "reschedule" and kind == "task":
        o = next((o for o in f["status"].opts if o.id == "open"), None) if "status" in f else None
        return [Facet("status", kind, [o], frozenset({"status"}), rank=1)] if o else []
    return []


def prev_write(ctx: Ctx, r):
    """F7: 'delete them', 'unstar all of those', 'push them back a day' after a listing: the referent is @prev; the pair flips the listing."""
    v = ctx.v
    cells = [(vb, k) for vb, ks in PREV_KINDS.items() for k in ks]
    if ctx.gaps is not None:
        ws = [GAP_WEIGHT[ctx.gaps.tier(f"A: {vb} · {k} · prev")] for vb, k in cells]
    else:
        ws = [1.0] * len(cells)
    verb, kind = r.choices(cells, ws)[0]
    if verb == "restore":
        return prev_restore(ctx, r, kind)
    if kind in ("list", "folder", "album", "notebook", "group", "document", "photo") and verb == "edit":
        return prev_rename(ctx, r, kind)
    forced = prev_forced(ctx, verb, kind)
    if verb in ("unstar", "star", "reopen", "settle_debt", "reschedule") and not forced:
        return None
    facs = [f for f in ctx.bank.facets(kind) if not (forced and f.groups & set().union(*[x.groups for x in forced]))]
    if verb == "reschedule" and kind == "event":
        facs = [dataclasses.replace(f, opts=[o for o in f.opts if not o.when or _future(o.when, ctx)]) if f.id == "when" else f for f in facs]
        facs = [f for f in facs if f.opts]
    need = r.choice([1, 2]) + sum(_facet_n(x) for x in forced)
    chosen_f, flips = pick_facets(facs, need, r, forced, ctx=ctx)
    if chosen_f is None:
        return None
    vi = r.randrange(4)
    df = r.choices(flips, [facet_w(ctx, f) for f in flips])[0]
    fixed = [(f, r.choices(f.opts, [tier_w(ctx, kind, o) for o in f.opts])[0]) for f in chosen_f if f is not df]
    base = [o for _, o in fixed]

    def keys_of(opt):
        return sel_keys(v, kind, base + [opt], "", limit=None)

    flip = choose_flip(df.opts, keys_of, r, allow_empty=0.0, wfn=lambda o: tier_w(ctx, kind, o))
    if flip is None:
        return None
    sides = []
    for opt in flip:
        keys = keys_of(opt)
        if not (1 <= len(keys) <= 6) or not all(can_verb(v, verb, v.get(k)) for k in keys):
            return None
        sides.append((opt, keys))
    # turn 2: what is said, the args, the gold
    key = verb if verb != "edit" else f"edit-{kind}" if f"edit-{kind}" in PREV_FRAMES else "edit-name"
    frames = PREV_FRAMES[key]
    fi = r.randrange(len(frames))
    fill_in, args, gold_fn = {}, None, None
    if verb == "edit" and kind == "event":
        n = r.choice([30, 45, 90, 120])
        fill_in, args = {"n": str(n)}, f"duration: {n}"
        gold_fn = lambda k: g_upd(k, duration=n)  # noqa: E731
        if any(v.get(k)["duration"] == n for _, ks in sides for k in ks):
            return None
    elif verb == "edit" and kind == "task":
        n = r.choice([15, 30, 45, 60])
        fill_in, args = {"n": str(n)}, f"effort: {n}"
        gold_fn = lambda k: g_upd(k, effort=n)  # noqa: E731
        if any(v.get(k)["effort"] == n for _, ks in sides for k in ks):
            return None
    elif verb == "edit" and kind == "note":
        fill_in, args = {}, "pinned: yes"
        gold_fn = lambda k: g_upd(k, pinned=True)  # noqa: E731
        if any(v.get(k)["pinned"] for _, ks in sides for k in ks):
            return None
    elif verb == "edit" and kind == "person":
        role = r.choice(ROLES)
        fill_in, args = {"role": role}, f"role: {role}"
        gold_fn = lambda k: g_upd(k, role=role)  # noqa: E731
        if any(v.get(k).get("role") == role for _, ks in sides for k in ks):
            return None
    elif verb == "reschedule":
        expr = U("day", 1, anchor="row")
        args = f"to: {jx(expr)}"
        isos = {k: target_iso(v, v.get(k), expr) for _, ks in sides for k in ks}
        if None in isos.values():
            return None
        gold_fn = lambda k: g_upd(k, date=isos[k])  # noqa: E731
    else:
        gold_fn = lambda k: VERBS[verb]["gold"](v, k)  # noqa: E731
        args = VERBS.get(verb, {}).get("args") if verb in VERBS else None
    msg2 = phone(frames[fi], r)
    for kk, vv in fill_in.items():
        msg2 = msg2.replace("{" + kk + "}", vv)
    msg2 = deco(msg2, pick_deco(r))
    msg1_frame = r.randrange(len(READ_FRAMES))
    f1 = phone(READ_FRAMES[msg1_frame][1], r)
    out = []
    for opt, keys in sides:
        ch = [(f, o) for f, o in fixed] + [(df, opt)]
        x = compose(kind, ch, vi)
        t1 = Turn(tidy(f1.replace("{X}", x)), gold_rows(keys), [C("answer", **sel_args(kind, [o for _, o in ch]))])
        t2 = Turn(tidy(msg2), gold_diff([gold_fn(k) for k in keys]), [C("act", verb=verb, rows="@prev", args=args)])
        out.append([t1, t2])
    fam = f"{verb}.{kind}.{msg1_frame}.{fi}"
    return (make_item(ctx, "FOLLOW", "prev-write", fam, f"@prev: the listing ({df.id})", out[0], tags=(kind, verb, "prev")),
            make_item(ctx, "FOLLOW", "prev-write", fam, f"@prev: the listing ({df.id})", out[1], tags=(kind, verb, "prev")))


def prev_rename(ctx: Ctx, r, kind: str):
    """'rename it to X' after a listing that shows exactly one container/row: the listing flips."""
    v = ctx.v
    facs = [f for f in ctx.bank.facets(kind)]
    if not facs:
        return None
    need = 1
    chosen_f, flips = pick_facets(facs, need, r, [], ctx=ctx)
    if chosen_f is None:
        return None
    df = flips[0]
    vi = r.randrange(4)

    def keys_of(opt):
        return sel_keys(v, kind, [opt], "")

    flip = choose_flip(df.opts, keys_of, r, allow_empty=0.0)
    if flip is None:
        return None
    ks = [keys_of(o) for o in flip]
    if any(len(k) != 1 for k in ks):
        return None
    name = r.choice(NAME_BANK)
    if any(v.by_name(kind, name) for _ in (0,)):
        return None
    frames = PREV_FRAMES["edit-name"]
    fi = r.randrange(len(frames))
    msg2 = deco(phone(frames[fi], r).replace("{name}", name.lower()), pick_deco(r))
    f1i = r.randrange(len(READ_FRAMES))
    f1 = phone(READ_FRAMES[f1i][1], r)
    out = []
    for opt, keys in zip(flip, ks):
        x = compose(kind, [(df, opt)], vi)
        t1 = Turn(tidy(f1.replace("{X}", x)), gold_rows(keys), [C("answer", **sel_args(kind, [opt]))])
        t2 = Turn(tidy(msg2), gold_diff([g_upd(keys[0], name=name)]), [C("act", verb="edit", rows="@prev", args=f"name: {name}")])
        out.append([t1, t2])
    fam = f"edit.{kind}.{f1i}.{fi}"
    return (make_item(ctx, "FOLLOW", "prev-write", fam, f"@prev: the listing ({df.id})", out[0], tags=(kind, "edit", "prev")),
            make_item(ctx, "FOLLOW", "prev-write", fam, f"@prev: the listing ({df.id})", out[1], tags=(kind, "edit", "prev")))


def prev_restore(ctx: Ctx, r, kind: str):
    """'restore them' after a look in the trash: the rows are the trashed ones the name words pick out."""
    v = ctx.v
    gone = [x for x in v.of(kind, live=False) if not x["live"]]
    if len(gone) < 2 or any(x.get("trashed_at") is None for x in gone):
        return None
    if any((v.today - x["trashed_at"][0]).days > 30 for x in gone):
        return None
    words = collections.defaultdict(set)
    for x in gone:
        for w in toks(x["name"]):
            if len(w) >= 4 and w not in STOP:
                words[w].add(x["key"])
    opts = [(w, sorted(ks)) for w, ks in words.items() if 1 <= len(ks) <= 5]
    if len(opts) < 2:
        return None
    (w1, k1), (w2, k2) = r.sample(opts, 2)
    if set(k1) == set(k2):
        return None
    frames = PREV_FRAMES["restore"]
    fi = r.randrange(len(frames))
    msg2 = deco(phone(frames[fi], r), pick_deco(r))
    t1i = r.randrange(len(READ_FRAMES))
    f1 = phone(READ_FRAMES[t1i][1], r)
    out = []
    for w, ks in ((w1, k1), (w2, k2)):
        keys = [k for k in v.select(kind, name=w, trashed=True)]
        if sorted(keys) != ks:
            return None
        t1 = Turn(tidy(f1.replace("{X}", f"deleted {NOUN[kind]} with {w} in the name")), gold_rows(keys), [C("answer", kind=kind, name=w, trashed=True)])
        t2 = Turn(tidy(msg2), gold_diff([g_restore(k) for k in keys]), [C("act", verb="restore", rows="@prev")])
        out.append([t1, t2])
    fam = f"restore.{kind}.{t1i}.{fi}"
    return (make_item(ctx, "FOLLOW", "prev-write", fam, "@prev: the trash listing", out[0], tags=(kind, "restore", "prev")),
            make_item(ctx, "FOLLOW", "prev-write", fam, "@prev: the trash listing", out[1], tags=(kind, "restore", "prev")))


# the weights of the templates whose follow-up reads lean on a `linked_to` (what-else, same-for) are held so that the cell's follow-up reads carry it
# as often as the natural ones (a third of the selector reads of a turn after the first: drill_dist.py), the date and narrowing follow-ups taking the rest
for _n, _f, _w, _fr in (("ordinal-act", lambda c, r: follow_ordinal(c, r, "act"), 1.3, len(READ_FRAMES) * 4), ("ordinal-read", lambda c, r: follow_ordinal(c, r, "read"), 0.9, len(ORD_FRAMES_READ)),
                        ("what-else", follow_else, 0.7, len(ELSE_T1) * len(ELSE_T2)), ("within", follow_within, 1.6, len(WITHIN_T2) * 6), ("same-for", follow_same_for, 1.0, len(SAME_T2) * 3),
                        ("and-when", follow_and_when, 1.4, len(AND_T2)), ("both-one", follow_both, 1.0, len(BOTH_X) * 6), ("the-other", follow_other, 1.0, len(OTHER_X) * 4),
                        ("prev-write", prev_write, 3.2, sum(len(x) for x in PREV_FRAMES.values()))):
    register("FOLLOW", _n, _f, _w, _fr)


# =============================================================================================================
# JUDGE: the judgements the model keeps (open ask vs create, policy declines, bounded vs unbounded delete)
# =============================================================================================================

ADD_OPEN_FRAMES = [("command", "add {a}"), ("command", "make {a}"), ("command", "new {k}{c}"), ("command", "start {a}"), ("question", "can i add {a}?"),
               ("question", "can we make {a}?"), ("indirect", "can you add {a}"), ("indirect", "could you make {a}"), ("indirect", "would you start {a} for me")]
OPEN_Q = {"note": "what should the note say?", "task": "what is the task?", "person": "who is the contact?", "event": "what is the event and when?"}


def judge_open(ctx: Ctx, r):
    """An open ask when the content is missing ('add a note') against the create when it is there; the content decides."""
    v = ctx.v
    kind = r.choice(["note", "task", "person", "event"])
    fi = r.randrange(len(ADD_OPEN_FRAMES))
    mood, frame = ADD_OPEN_FRAMES[fi]
    frame = phone(frame, r)
    art = {"note": "a note", "task": "a task", "person": "a contact", "event": "an event"}[kind]
    knd = {"note": "note", "task": "task", "person": "contact", "event": "event"}[kind]
    if kind == "note":
        title, text = r.choice(NOTE_TEXT)
        title = " ".join(text.split()[:3])
        cont, call = f": {text}", C("act", verb="create", kind="note", args=f"name: {cap(title)}\nbody: {text}")
        gold = gold_diff([g_new("note", name=ANY, body=has_words(text))])
        shape = ""
    elif kind == "task":
        name = new_name(v, r)
        cont, call = f": {name}", C("act", verb="create", kind="task", args=f"name: {cap(name)}")
        gold = gold_diff([g_new("task", name=has_words(name))])
        shape = ""
    elif kind == "person":
        n = f"{r.choice(FIRST)} {r.choice(LAST)}"
        if v.by_name("person", n) or v.by_name("person", n.split()[0]):
            return None
        role = r.choice(ROLES)
        cont, call = f": {n.lower()}, {role}", C("act", verb="create", kind="person", args=f"name: {n}\nrole: {role}")
        gold = gold_diff([g_new("person", name=n, role=role)])
        shape = ""
    else:
        phs = [p for p in point_phrases(ctx) if p.fam in ("weekday", "day")]
        r.shuffle(phs)
        n = r.choice(EVENT_NAMES["plain"])
        hr = r.choice([2, 3, 4, 5])
        for p in phs:
            d = resolve(p.expr, v.now)[1]
            if slot_free(v, dt.datetime.combine(d, dt.time(hr + 12, 0))):
                break
        else:
            return None
        cont = f": {n} {p.text} at {hr}"
        call = C("act", verb="create", kind="event", args=f"name: {cap(n)}\ndate: {jx({**p.expr, 'time': f'{hr + 12:02d}:00'})}")
        gold = gold_diff([g_new("event", name=has_words(n), date=fmt_iso(d, (hr + 12, 0)))])
        shape = "rel+time+unit+weekday"
    ta = Turn(tidy(frame.replace("{a}", art).replace("{k}", knd).replace("{c}", "")), gold_ask(), [C("ask", question=OPEN_Q[kind])])
    tb = Turn(tidy(frame.replace("{a}", art + cont).replace("{k}", knd).replace("{c}", cont)), gold, [call])
    return (make_item(ctx, "JUDGE", "open-ask", f"{kind}.{fi}", "content: missing vs given", [ta], tags=(kind, "ask")),
            make_item(ctx, "JUDGE", "open-ask", f"{kind}.{fi}", "content: missing vs given", [tb], shape=shape, tags=(kind, "create")))


SEND_A = ["text {p} the wifi password", "whatsapp {p} the wifi code", "send the wifi password to {p}", "message {p} the wifi pw", "email {p} the wifi password",
          "can you text {p} the wifi password", "could you send {p} the wifi code", "can you whatsapp the wifi to {p}"]
SEND_B = ["what's the wifi password", "wifi code?", "where's the wifi password saved", "what's the wifi pw", "where did i save the wifi password",
          "do i have the wifi password saved", "can you find the wifi password", "could you check where the wifi code is"]
MAKEUP_A = ["make up a new wifi password", "invent a wifi password for me", "come up with a wifi password", "make one up for the wifi", "think up a wifi code",
            "can you make up a wifi password", "could you invent a wifi code", "would you come up with a wifi password for me"]
MAKEUP_B = ["where's my wifi password", "where is the wifi code kept", "which locker item is the wifi password", "wifi password, where is it?",
            "where did i put the wifi pw", "is the wifi password saved", "can you find me the wifi password", "could you say where the wifi code is saved"]


def judge_wifi(ctx: Ctx, r):
    """The wifi rulings of SPEC 14.1: sending the secret is declined (sealed_egress), inventing one is declined (fabricated_secret),
    naming or asking where it is is a read. The pair flips the act."""
    v = ctx.v
    wifi = [x for x in v.of("locker item") if x["type"] == "wifi"]
    if len(wifi) != 1:
        return None
    people = [p for p in v.of("person") if not p.get("me") and ctx.bank.first_unique(p)]
    mode = r.choice(["send", "make"])
    i = r.randrange(8)
    if mode == "send":
        p = r.choice(people) if people else None
        if p is None:
            return None
        msg_a = phone(SEND_A[i], r).replace("{p}", ctx.bank.first_unique(p).lower())
        a = Turn(tidy(msg_a), gold_decline("sealed_egress"), [C("decline", reason="sealed_egress")])
        b = Turn(tidy(phone(SEND_B[i], r)), gold_rows([wifi[0]["key"]]), [C("answer", kind="locker item", where="type = wifi")])
        feat = "send vs ask where"
    else:
        a = Turn(tidy(phone(MAKEUP_A[i], r)), gold_decline("fabricated_secret"), [C("decline", reason="fabricated_secret")])
        b = Turn(tidy(phone(MAKEUP_B[i], r)), gold_rows([wifi[0]["key"]]), [C("answer", kind="locker item", where="type = wifi")])
        feat = "invent vs ask where"
    return (make_item(ctx, "JUDGE", f"wifi-{mode}", f"{i}", feat, [a], tags=("locker", "decline")),
            make_item(ctx, "JUDGE", f"wifi-{mode}", f"{i}", feat, [b], tags=("locker", "answer")))


def judge_secret(ctx: Ctx, r):
    """Inventing a secret for a login is declined; asking where the login is saved is a read."""
    v = ctx.v
    logins = [x for x in v.of("locker item") if x["type"] == "login" and name_options(v, x)]
    if not logins:
        return None
    x = r.choice(logins)
    style, text, name_arg = pick_name(v, x, r)
    text = re.sub(r"\s+login$", "", text)  # the frames say "login" themselves
    if text == "login":
        return None
    i = r.randrange(6)
    A = ["make up a password for {n}", "invent a password for my {n} login", "come up with a password for {n}", "can you make up a password for {n}",
         "could you invent a new password for {n}", "would you think up a password for {n}"]
    B = ["where's the {n} login saved", "where is my {n} login", "do i have a {n} login saved", "can you find the {n} login",
         "could you check where my {n} login is", "which locker item is the {n} login"]
    a = Turn(tidy(phone(A[i], r).replace("{n}", text)), gold_decline("fabricated_secret"), [C("decline", reason="fabricated_secret")])
    b = Turn(tidy(phone(B[i], r).replace("{n}", text)), gold_rows([x["key"]]), [C("answer", kind="locker item", name=name_arg)])
    return (make_item(ctx, "JUDGE", "secret-invent", f"{i}", "invent a password vs ask where", [a], tags=("locker", "decline")),
            make_item(ctx, "JUDGE", "secret-invent", f"{i}", "invent a password vs ask where", [b], tags=("locker", "answer")))


ALL_A = ["delete all my {N}", "wipe all my {N}", "get rid of every one of my {N}", "clear out all my {N}", "delete every {n} i have",
         "can you delete all my {N}", "could you wipe all my {N}", "would you clear out all my {N}"]
ALL_B = ["delete the {s} {N}", "wipe the {s} {N}", "get rid of the {s} {N}", "clear out the {s} {N}", "delete the {s} {N} i have",
         "can you delete the {s} {N}", "could you wipe the {s} {N}", "would you clear out the {s} {N}"]


def judge_bulk(ctx: Ctx, r):
    """'delete all my tasks' is declined (unbounded_destruction); 'delete the finished ones' is a write (the runtime asks over the cap)."""
    v = ctx.v
    specs = []
    for kind, state, status, words in (("task", "finished", "completed", ["finished", "completed", "done"]), ("task", "cancelled", "cancelled", ["cancelled"]),
                                         ("event", "cancelled", "cancelled", ["cancelled", "called-off"])):
        keys = v.select(kind, where=[("status", "=", status)])
        if keys:
            specs.append((kind, status, words, keys))
    if not specs:
        return None
    kind, status, words, keys = r.choice(specs)
    i = r.randrange(8)
    s = r.choice(words)
    a = Turn(tidy(phone(ALL_A[i], r).replace("{N}", NOUN[kind]).replace("{n}", kind)), gold_decline("unbounded_destruction"), [C("decline", reason="unbounded_destruction")])
    msg = tidy(phone(ALL_B[i], r).replace("{N}", NOUN[kind]).replace("{s}", s))
    sel = dict(kind=kind, where=f"status = {status}")
    if len(keys) == 1:
        ref = [C("act", verb="delete", **sel)]
    else:
        ref = [C("find", **sel), C("act", verb="delete", rows="@prev")]
    gold = gold_diff([g_trash(k) for k in keys]) if len(keys) <= ROW_CAP else gold_ask()
    b = Turn(msg, gold, ref)
    return (make_item(ctx, "JUDGE", "bulk-delete", f"{kind}.{i}", "scope: all vs the bounded ones", [a], tags=(kind, "decline")),
            make_item(ctx, "JUDGE", "bulk-delete", f"{kind}.{i}", "scope: all vs the bounded ones", [b], tags=(kind, "delete")))


TEXT_A = ["text {p}", "message {p}", "whatsapp {p}", "tell {p} i said hi", "email {p}", "can you text {p}", "could you message {p}", "can you tell {p} i'm on my way"]
TEXT_B = ["note that i texted {p}", "log that i messaged {p}", "log a text to {p}", "put down that i whatsapped {p}", "note that i emailed {p}",
          "can you note that i texted {p}", "could you log that i messaged {p}", "can you log my text to {p}"]


def judge_text(ctx: Ctx, r):
    """'text sam' is out of scope (the vault sends nothing); 'note that i texted sam' is a log."""
    v = ctx.v
    people = [p for p in v.of("person") if not p.get("me") and ctx.bank.first_unique(p)]
    if not people:
        return None
    p = r.choice(people)
    first = ctx.bank.first_unique(p)
    i = r.randrange(8)
    a = Turn(tidy(phone(TEXT_A[i], r).replace("{p}", first.lower())), gold_decline("out_of_scope"), [C("decline", reason="out_of_scope")])
    b = Turn(tidy(phone(TEXT_B[i], r).replace("{p}", first.lower())), gold_diff([g_upd(p["key"], date=ANY)]), [C("act", verb="log", kind="person", name=first, args="kind: message")])
    return (make_item(ctx, "JUDGE", "text-or-log", f"{i}", "text someone vs note that i texted", [a], tags=("person", "decline")),
            make_item(ctx, "JUDGE", "text-or-log", f"{i}", "text someone vs note that i texted", [b], tags=("person", "log")))


for _n, _f, _w, _fr in (("open-ask", judge_open, 2.0, len(ADD_OPEN_FRAMES) * 4), ("wifi", judge_wifi, 1.4, len(SEND_A) + len(MAKEUP_A) + len(SEND_B) + len(MAKEUP_B)), ("secret-invent", judge_secret, 0.8, 12),
                        ("bulk-delete", judge_bulk, 1.4, len(ALL_A) * 2), ("text-or-log", judge_text, 1.2, len(TEXT_A) * 2)):
    register("JUDGE", _n, _f, _w, _fr)


# =============================================================================================================
# AMB: an ambiguous write; the reference is the act alone, the gold the ask over the candidates (needs the phase-7 runtime)
# =============================================================================================================


def undated(options: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """The names of a same-name set that say no day or month: 'cancel sunday call' would be settled by 'sunday' (act.rs narrow)."""
    return [o for o in options if not set(toks(o[0])) & DATE_WORDS]


def amb_person(ctx: Ctx, r):
    """'star priya' with two Priyas against 'star priya nair': the first name fits two people, the full name one."""
    v = ctx.v
    cands = [(S, a) for S in twin_sets(v)["first"] for a in S if len(toks(a["name"])) >= 2]
    if not cands:
        return None
    S, a = r.choice(cands)
    verb = r.choice(["star", "log", "delete"]) if all(not x["starred"] for x in S) else r.choice(["log", "delete"])
    cand = [x for x in S if can_verb(v, verb, x)]
    if len(cand) < 2:
        return None
    first = a["name"].split()[0]
    fi, mood, frame = verb_frame(ctx, r, verb)
    ta = Turn(fill(frame, first.lower()), gold_ask(*[x["key"] for x in cand]), [C("act", verb=verb, kind="person", name=first, args=VERBS[verb].get("args"))])
    tb = Turn(fill(frame, a["name"].lower()), gold_diff([VERBS[verb]["gold"](v, a["key"])]), [C("act", verb=verb, kind="person", name=a["name"], args=VERBS[verb].get("args"))])
    return (make_item(ctx, "AMB", "person", f"{verb}.{fi}", "first name vs full name", [ta], tags=("person", verb, "ask")),
            make_item(ctx, "AMB", "person", f"{verb}.{fi}", "first name vs full name", [tb], tags=("person", verb)))


def amb_same(ctx: Ctx, r):
    """'cancel night shift' with several night shifts against 'cancel night shift friday': the date settles it."""
    v = ctx.v
    sets = [S for S in twin_sets(v)["same"] if S[0]["kind"] in ("event", "task") and set_name_options(v, S)]
    if not sets:
        return None
    S = r.choice(sets)
    kind = S[0]["kind"]
    verb = r.choice(["cancel", "delete"]) if kind == "event" else r.choice(["complete", "delete"])
    cand = [x for x in S if can_verb(v, verb, x)]
    if not (2 <= len(cand) <= ROW_CAP):
        return None
    phs = [p for p in when_phrases(ctx, kind) if p.future]
    singles = []
    for p in phs:
        res = resolve(p.expr, v.now)
        hit = [x for x in cand if contains(res, x["date"])]
        if len(hit) == 1:
            singles.append((p, hit[0]))
    if not singles:
        return None
    p, row = r.choice(singles)
    name_text, name_arg = r.choice(undated(set_name_options(v, S)) or [("", "")])
    if not name_text:
        return None  # every name of the set says a day or a month: that settles which in the runtime's eyes
    vi = r.randrange(2)
    fi, mood, frame = verb_frame(ctx, r, verb)
    ta = Turn(fill(frame, name_text), gold_ask(*[x["key"] for x in cand]), [C("act", verb=verb, kind=kind, name=name_arg)])
    tb = Turn(fill(frame, f"{name_text} {date_connect(kind, p, vi)}"), gold_diff([VERBS[verb]["gold"](v, row["key"])]), [C("act", verb=verb, kind=kind, name=name_arg, when=jx(p.expr))])
    return (make_item(ctx, "AMB", "same-name", f"{kind}.{verb}.{fi}", "a date settles it", [ta], tags=(kind, verb, "ask")),
            make_item(ctx, "AMB", "same-name", f"{kind}.{verb}.{fi}", "a date settles it", [tb], shape=p.shape, tags=(kind, verb)))


def amb_move(ctx: Ctx, r):
    """'move the night shift to friday' with several: the reference is the act alone and the gold the ask."""
    v = ctx.v
    sets = [S for S in twin_sets(v)["same"] if S[0]["kind"] == "event" and set_name_options(v, S)]
    if not sets:
        return None
    S = r.choice(sets)
    cand = [x for x in S if x["status"] != "cancelled"]
    if not (2 <= len(cand) <= ROW_CAP):
        return None
    ph = [p for p in point_phrases(ctx) if p.fam in ("weekday", "day")]
    p = r.choice(ph)
    name_text, name_arg = r.choice(undated(set_name_options(v, S)) or [("", "")])
    if not name_text:
        return None  # every name of the set says a day or a month: that settles which in the runtime's eyes
    fi = r.randrange(len(MOVE_TO))
    mood, frame = MOVE_TO[fi]
    frame = phone(frame, r)
    ta = Turn(tidy(frame.replace("{n}", name_text).replace("{d}", p.text)), gold_ask(*[x["key"] for x in cand]),
              [C("act", verb="reschedule", kind="event", name=name_arg, args=f"to: {jx(p.expr)}")])
    pa = [q for q in point_phrases(ctx) if q.fam in ("weekday", "day") and q.text != p.text]
    singles = []
    for q in pa:
        res = resolve(q.expr, v.now)
        hit = [x for x in cand if contains(res, x["date"])]
        if len(hit) == 1:
            singles.append((q, hit[0]))
    if not singles:
        return None
    q, row = r.choice(singles)
    iso = target_iso(v, row, p.expr)
    on_q = q.text if q.fam == "day" else f"on {q.text}"
    tb = Turn(tidy(f"move {name_text} {on_q} to {p.text}"), gold_diff([g_upd(row["key"], date=iso)]),
              [C("act", verb="reschedule", kind="event", name=name_arg, when=jx(q.expr), args=f"to: {jx(p.expr)}")])
    return (make_item(ctx, "AMB", "move", f"{fi}", "a source date settles it", [ta], tags=("event", "reschedule", "ask")),
            make_item(ctx, "AMB", "move", f"{fi}", "a source date settles it", [tb], shape=q.shape, tags=("event", "reschedule")))


for _n, _f, _w, _fr in (("person", amb_person, 1.4, 36), ("same-name", amb_same, 1.6, 48), ("move", amb_move, 1.0, len(MOVE_TO))):
    register("AMB", _n, _f, _w, _fr, asks=True)


# =============================================================================================================
# measure: the closed loop's instrument. Any gold file plus a driver run: per cell, items, turn pass, pair pass, worst phrasings
# =============================================================================================================

HANDLE_RX = re.compile(r"@prev|@\d+|within|exclude")
ANA_RX = re.compile(r"\b(it|its|that|this|them|they|those|these|her|his|him|he|she|both|same|the other|other one|the one)\b")
ORD_RX = re.compile(r"\b(first|second|third|fourth|fifth|last|other one)\b")


def turn_label(session: dict, ti: int) -> str:
    """The decision cell of a turn of ANY gold file, from its reference calls and gold (the drills' own cells are used instead
    when cells.json knows the session): JUDGE (ask / decline gold), TWO (two writes or a write then a read), DATES (two dates in
    one call), CONT (a container link or add_to / remove_from), FOLLOW (a later turn that leans on an earlier result or says it /
    the other / the second), CM (a create), else C1 / C2 / C3 / C4 by the constraint count of authored/hardness.py."""
    t = session["turns"][ti]
    good = [c for c in t.get("ref", []) if not c.get("bad")]
    gl = t["gold"] if isinstance(t["gold"], list) else [t["gold"]]
    types = {g.get("type") for g in gl}
    if types & {"ask", "decline"}:
        return "JUDGE"
    acts = [c for c in good if c["tool"] == "act"]
    writes = [c for c in acts if (c.get("args") or {}).get("verb") not in ("undo",)]
    if len(writes) >= 2 or (writes and any(c["tool"] == "answer" for c in good[good.index(writes[-1]) + 1:])) or any(g.get("diff") and g.get("type") in ("rows", "value") for g in gl):
        return "TWO"
    ndates = 0
    for c in good:
        a = c.get("args") or {}
        w = a.get("when")
        blobs = [w] if isinstance(w, str) else [json.dumps(w)] if isinstance(w, dict) else []
        for line in str(a.get("args") or "").splitlines():
            if line.split(": ", 1)[0] in ("to", "date") and "{" in line:
                blobs.append(line.split(": ", 1)[1])
        for b in blobs:
            try:
                e = json.loads(b)
            except json.JSONDecodeError:
                continue
            ndates += 1 + (1 if isinstance(e, dict) and e.get("from") and e.get("to") else 0)
    if ndates >= 2:
        return "DATES"
    if any(c["tool"] == "act" and (c.get("args") or {}).get("verb") in ("add_to", "remove_from") for c in good):
        return "CONT"
    if ti > 0 and (any(HANDLE_RX.search(json.dumps(c.get("args") or {})) for c in good) or ANA_RX.search(t["user"].lower()) or ORD_RX.search(t["user"].lower())):
        return "FOLLOW"
    if any((c.get("args") or {}).get("verb") == "create" for c in good):
        return "CM"
    k = max((hardness_k(c) for c in good), default=0)
    return "C1" if k <= 1 else f"C{k}" if k <= 3 else "C4"


def mood_of(u: str) -> str:
    s = u.strip().lower()
    if re.search(r"\b(can you|could you|would you|can u|pls|please|mind)\b", s):
        return "indirect"
    if s.endswith("?") or re.match(r"^(what|whats|what's|when|who|how|where|which|why|is|are|do|does|did|any|anything)\b", s):
        return "question"
    return "command"


def turn_family(session: dict, ti: int, label: str) -> str:
    u = session["turns"][ti]["user"]
    lead = re.sub(r"[^a-z]", "", (u.lower().split() or [""])[0])
    return f"{label}.{mood_of(u)}.{lead or '_'}"


def load_jsonl_glob(spec: str) -> list[dict]:
    out = []
    for part in spec.split(","):
        for f in sorted(globmod.glob(part)) or ([part] if Path(part).exists() else []):
            with open(f) as fh:
                out += [json.loads(line) for line in fh if line.strip()]
    return out


def measure(run: list[dict], gold: list[dict], cells: dict | None = None) -> dict:
    """The numbers of `measure`: per cell {items, turns, turn_pass, item_pass, pairs, pair_pass, families, worst}."""
    sys.path.insert(0, str(NATIVE / "eval"))
    import score as score_mod
    verdicts = {s["id"]: s for s in score_mod.score(run, gold)["sessions"]}
    cells = cells or {}
    gaps = Gaps(None)
    by_cell: dict[str, dict] = {}
    fam_all: dict[str, list] = collections.defaultdict(list)
    ucell: dict[str, list] = collections.defaultdict(list)
    pair_of: dict[str, list] = collections.defaultdict(list)
    for s in gold:
        v = verdicts.get(s["id"])
        if v is None:
            continue
        meta = cells.get(s["id"])
        item_pass = all(t["pass"] for t in v["turns"])
        for ti, t in enumerate(v["turns"]):
            label = meta["cell"] if meta else turn_label(s, ti)
            fam = meta["family"] if meta else turn_family(s, ti, label)
            d = by_cell.setdefault(label, {"items": set(), "turns": 0, "turn_pass": 0, "item_pass": set(), "families": collections.defaultdict(lambda: [0, 0])})
            d["items"].add(s["id"])
            d["turns"] += 1
            d["turn_pass"] += bool(t["pass"])
            if item_pass:
                d["item_pass"].add(s["id"])
            d["families"][fam][0] += 1
            d["families"][fam][1] += bool(t["pass"])
            fam_all[f"{label}|{fam}"].append(bool(t["pass"]))
            try:
                class _T:  # a gold turn as Gaps.item_cells reads it
                    ref = s["turns"][ti].get("ref", [])
                    gold = s["turns"][ti]["gold"]
                    user = s["turns"][ti]["user"]
                for c in gaps.item_cells(s["world"], [_T]):
                    ucell[c].append(bool(t["pass"]))
            except Exception:  # noqa: BLE001  (a world the classifier cannot read is left out of the universe table)
                pass
        if meta:
            pair_of[meta["pair"]].append((meta["cell"], s["id"], item_pass))
    out = {}
    for label, d in by_cell.items():
        pairs = [ps for ps in pair_of.values() if ps and ps[0][0] == label and len(ps) == 2]
        fams = sorted(((f, n, p) for f, (n, p) in d["families"].items()), key=lambda x: (x[2] / x[1], -x[1]))
        out[label] = {"items": len(d["items"]), "turns": d["turns"], "turn_pass": d["turn_pass"], "item_pass": len(d["item_pass"]),
                      "pairs": len(pairs), "pair_pass": sum(1 for ps in pairs if all(x[2] for x in ps)), "worst": fams[:10]}
    worst_fam = sorted(((k, len(v), sum(v)) for k, v in fam_all.items()), key=lambda x: (x[2] / x[1], -x[1]))
    univ = sorted(((c, len(v), sum(v)) for c, v in ucell.items() if len(v) >= 3), key=lambda x: (x[2] / x[1], -x[1]))
    return {"cells": out, "worst_families": worst_fam[:10], "worst_universe": univ[:15], "sessions": len(verdicts)}


def render_measure(m: dict) -> str:
    L = [f"measured {m['sessions']} sessions", "", "| cell | items | turns | turn pass | item pass | pairs | pair pass |", "|---|---|---|---|---|---|---|"]
    tot_t = tot_p = 0
    for label in sorted(m["cells"]):
        d = m["cells"][label]
        tot_t += d["turns"]
        tot_p += d["turn_pass"]
        L.append(f"| {label} | {d['items']} | {d['turns']} | {100 * d['turn_pass'] / max(1, d['turns']):.1f}% ({d['turn_pass']}/{d['turns']}) | "
                 f"{100 * d['item_pass'] / max(1, d['items']):.1f}% | {d['pairs'] or 'n/a'} | "
                 + (f"{100 * d['pair_pass'] / d['pairs']:.1f}% ({d['pair_pass']}/{d['pairs']})" if d["pairs"] else "n/a") + " |")
    L.append(f"| ALL | | {tot_t} | {100 * tot_p / max(1, tot_t):.1f}% ({tot_p}/{tot_t}) | | | |")
    L += ["", "## the ten worst phrasing families (turn pass, over all cells)", ""]
    for k, n, p in m["worst_families"]:
        L.append(f"- `{k}`: {p}/{n} = {100 * p / n:.0f}%")
    L += ["", "## the worst phrasing families per cell", ""]
    for label in sorted(m["cells"]):
        w = [x for x in m["cells"][label]["worst"] if x[2] < x[1]][:10]
        if w:
            L.append(f"- {label}: " + "; ".join(f"`{f}` {p}/{n}" for f, n, p in w))
    if m["worst_universe"]:
        L += ["", "## the worst cells of the universe (authored/cells.py tables A, B, C; at least 3 turns)", ""]
        L += [f"- {c}: {p}/{n} = {100 * p / n:.0f}%" for c, n, p in m["worst_universe"]]
    return "\n".join(L) + "\n"


def cmd_measure(a) -> None:
    cells = json.loads(Path(a.cells).read_text()) if a.cells else None
    spec = a.gold
    if not spec and a.cells:  # the gold of the kept drills beside cells.json
        beside = Path(a.cells).parent
        spec = str(beside / "kept.gold.jsonl") if (beside / "kept.gold.jsonl").exists() else ",".join(sorted(globmod.glob(str(beside / "*.kept.gold.jsonl"))))
    if not spec:
        raise SystemExit("measure needs --gold GOLD.jsonl (or --cells cells.json with kept.gold.jsonl beside it)")
    gold, seen = [], set()
    for g in load_jsonl_glob(spec):
        if g["id"] not in seen and not g["id"].endswith("-stub"):  # a session once, whatever the files that hold it
            seen.add(g["id"])
            gold.append(g)
    run = load_jsonl_glob(a.run)
    ids = {r["id"] for r in run}  # the run is the denominator: a session it never ran is not a failure of the model
    gold = [g for g in gold if g["id"] in ids]
    text = render_measure(measure(run, gold, cells))
    print(text, end="")
    if a.md:
        Path(a.md).write_text(text)


# =============================================================================================================
# gen: choose the pairs, write the sessions, build them through the runtime, keep what verified
# =============================================================================================================


def authored_messages(w: str, sessions_dir: Path = AUTHORED / "sessions") -> set[str]:
    """Every user message of the authored sessions of a world (the files <W>.py, <W>_*.py)."""
    out: set[str] = set()
    for f in common.session_files(w, sessions_dir):
        if not f.exists():
            continue
        for node in ast.walk(ast.parse(f.read_text())):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("T", "X") and node.args:
                a = node.args[0]
                if isinstance(a, ast.Constant) and isinstance(a.value, str):
                    out.add(a.value)
    return out


LONG = 6  # words: a message this long is never shared with an authored message, another world's drill or an earlier run


def is_long(m: str) -> bool:
    return len(m.split()) >= LONG


def pair_ok(ctx: Ctx, a: Item, b: Item) -> bool:
    """A pair differs in what the person says; no message of it is one a pair of this world has (any length), and no message of
    six words or more is an authored message of the world or one of an earlier run (`--avoid`)."""
    ma, mb = [t.user for t in a.turns], [t.user for t in b.turns]
    if ma == mb:
        return False
    allm = set(ma) | set(mb)
    if any(m in ctx.msgs for m in allm):
        return False
    return not any(is_long(m) and (m in ctx.avoid or m in ctx.authored) for m in allm)


def pair_would_ask(ctx: Ctx, a: Item, b: Item) -> bool:
    """Whether the runtime would end any write of the pair in its own ask at an ambiguous pick (the gold would not say so)."""
    for it in (a, b):
        for ti, t in enumerate(it.turns):
            prev = it.turns[ti - 1].user if ti else ""
            if any(not c.get("bad") and would_ask(ctx.v, c, t.user, prev) for c in t.ref):
                return True
    return False


def outcomes_differ(a: Item, b: Item) -> bool:
    return any(json.dumps(t.gold, sort_keys=True) != json.dumps(u.gold, sort_keys=True) for t, u in zip(a.turns, b.turns))


def quotas(n_pairs: int, cells: list[str]) -> dict[str, int]:
    tot = sum(CELL_SHARE[c] for c in cells)
    raw = {c: n_pairs * CELL_SHARE[c] / tot for c in cells}
    q = {c: int(raw[c]) for c in cells}
    for c in sorted(cells, key=lambda c: raw[c] - q[c], reverse=True)[: n_pairs - sum(q.values())]:
        q[c] += 1
    return q


def gen_world(w: str, seed, n_items: int, cells: list[str], avoid: set[str], tries: int = 40, gaps: "Gaps | None" = None,
              pool: int = 4) -> tuple[Ctx, list[tuple[Item, Item]], dict]:
    """The pairs of one world. With `gaps` each slot draws up to `pool` candidate pairs and keeps one with probability
    proportional to its tier (uncovered 3, thin 2, covered 1): the pair that lands in a gap cell of the train corpus is
    three times as likely as one that does not, wherever the candidates exist."""
    ctx = Ctx(w, seed, avoid, authored_messages(w), gaps=gaps)
    n_pairs = max(1, n_items // 2)
    q = quotas(n_pairs, cells)
    pairs: list[tuple[Item, Item]] = []
    stats = {"asked": dict(q), "made": collections.Counter(), "tries": collections.Counter(),
             "tpl": collections.defaultdict(collections.Counter)}  # per template: tries, none, same-outcome, message (refused), kept
    for cell in cells:
        tpls = [t for t in TEMPLATES if t.cell == cell]
        if not tpls:
            continue
        for i in range(q[cell]):
            pick = ctx.rng(cell, "template", i)
            order = []
            left = list(tpls)
            while left:
                t = pick.choices(left, [x.weight for x in left])[0]
                order.append(t)
                left.remove(t)
            cands = []
            want = pool if gaps is not None else 1
            for attempt in range(tries):
                t = order[attempt % len(order)] if attempt < len(order) else pick.choices(tpls, [x.weight for x in tpls])[0]
                stats["tries"][cell] += 1
                tc = stats["tpl"][f"{cell}.{t.name}"]
                tc["tries"] += 1
                r = ctx.rng(cell, t.name, i, attempt)
                res = t.fn(ctx, r)
                if not res:
                    tc["none"] += 1
                    continue
                a, b = res
                if not outcomes_differ(a, b):
                    tc["same outcome"] += 1
                    continue
                if not pair_ok(ctx, a, b):
                    tc["message refused"] += 1
                    continue
                if not (t.needs_m1 or t.asks) and pair_would_ask(ctx, a, b):
                    tc["would ask"] += 1
                    continue
                if not t.needs_m1 and (unseen_keys(ctx.v, a) or unseen_keys(ctx.v, b)):
                    tc["key not shown"] += 1
                    continue
                for it in (a, b):
                    it.needs_m1 = it.needs_m1 or t.needs_m1
                if any(set(x.sid_key() for x in (a, b)) == set(y.sid_key() for y in (c[0], c[1])) for c in cands):
                    continue
                cands.append((a, b, t))
                tc["valid"] += 1
                if len(cands) >= want:
                    break
            if not cands:
                stats.setdefault("unfilled", collections.Counter())[cell] += 1
                continue
            if gaps is not None and len(cands) > 1:
                ws = []
                for a, b, t in cands:
                    tier = gaps.tier_of(gaps.item_cells(w, a.turns) | gaps.item_cells(w, b.turns))
                    ws.append(GAP_WEIGHT[tier])
                a, b, t = ctx.rng(cell, "choose", i).choices(cands, ws)[0]
            else:
                a, b, t = cands[0]
            ctx.msgs |= {t_.user for it in (a, b) for t_ in it.turns}
            pairs.append((a, b))
            stats["made"][cell] += 1
            stats["tpl"][f"{cell}.{t.name}"]["made"] += 1
    return ctx, pairs, stats


def is_kept(it: Item, pair_verified: bool) -> bool:
    """Whether an item is for the corpus: both siblings of its pair verified against the runtime, and the pair does not need a runtime
    feature the binary lacks (`needs_m1`; no template sets it now, the AMB cell, which needed the composed ask, is kept)."""
    return bool(pair_verified) and not it.needs_m1


def assign_ids(w: str, pairs: list[tuple[Item, Item]]) -> None:
    for n, (a, b) in enumerate(pairs, 1):
        a.pair = b.pair = f"{w}-D{n:04d}"
        a.side, b.side = "a", "b"
        a.sid, b.sid = a.pair + "a", b.pair + "b"
        a.world = b.world = w


def write_sessions(out: Path, w: str, ctx: Ctx, pairs: list[tuple[Item, Item]], split: str, per_file: int = 100) -> list[Path]:
    sdir = out / "sessions"
    sdir.mkdir(parents=True, exist_ok=True)
    head = f'from gold import *\n\nworld({w!r}, {ctx.today_s!r}, {ctx.me!r}, {split!r})\n\n'
    (sdir / f"{w}.py").write_text("from gold import *\n\n# decision drills: the sessions are in the <W>_dNN.py files\n")
    items = [it for p in pairs for it in p]
    files = []
    for n, i in enumerate(range(0, len(items), per_file), 1):
        f = sdir / f"{w}_d{n:02d}.py"
        f.write_text(head + "\n".join(src_session(it) for it in items[i:i + per_file]))
        files.append(f)
    for old in sdir.glob(f"{w}_d*.py"):  # a smaller rerun leaves no stale file
        if old not in files:
            old.unlink()
    return files


WIDEN = ("superlative", "group-or-value", "container-or-row")


def classify_problem(entry: dict) -> tuple[str, str]:
    """(reason class, detail) of a session that did not verify."""
    texts = [t for p in entry.get("problems", []) for t in (p.get("problems") or [])]
    for p in entry.get("problems", []):
        if "error" in p:
            return "error", str(p["error"])[:100]
        if "trace" in p:
            return f"trace {p['trace']}", str(p.get("detail", ""))[:100]
    for needle, label in (("it but it is not marked bad", "reference call rejected"), ("it but it is marked bad", "marked bad call accepted"),
                          ("gold-from-ref: UNEXPLAINED", "gold change no convention explains"), ("gold-from-ref: name-match", "name-match"),
                          ("guard false rejection", "trace guard rejected"), ("differs from the plain replay", "trace guard replay differs")):
        t = next((t for t in texts if needle in t), None)
        if t:
            return label, t[:160]
    t = texts[0] if texts else "dropped"
    t0 = re.sub(r"\[[^\]]*\]", "[..]", t)
    for pat, label in ((r"^rows differ", "rows differ"), (r"^ended in (\w+), want (\w+)", None), (r"^value", "value differs"),
                       (r"^created", "create fields differ"), (r"^missing", "missing change"), (r"^unwanted", "unwanted change"),
                       (r"^\w+: unexpected field", "unexpected field"), (r"^missing link", "missing link"), (r"^no already", "no already")):
        m = re.search(pat, t0)
        if m:
            return "gold fails: " + (label or f"ended in {m.group(1)}, want {m.group(2)}"), t[:200]
    return "gold fails: other", t[:200]


def analyze_world(out: Path, w: str, pairs: list[tuple[Item, Item]]) -> dict:
    rep = common.read_report(out, w)
    result = {}
    for a, b in pairs:
        for it in (a, b):
            e = rep.get(it.sid)
            res = {"verified": False, "reason": "", "detail": ""}
            if e is None:
                res.update(reason="not built", detail="no report entry (the build process died or the file did not load)")
            elif not e["pass"]:
                res["reason"], res["detail"] = classify_problem(e)
            else:
                applied = [c for c in e.get("changes", []) if c["applied"] and not all(x in WIDEN for x in c["convention"].split("+"))]
                if applied:
                    res.update(reason="convention:" + "+".join(sorted({c["convention"] for c in applied})),
                               detail=json.dumps([{k: c[k] for k in ("turn", "convention", "evidence", "old_gold", "new_gold")} for c in applied], ensure_ascii=False)[:400])
                else:
                    res["verified"] = True
            result[it.sid] = res
    return result


def sessions_digest(out: Path, w: str) -> str:
    """A digest of the session files of a world, to tell whether a build was made from these very sessions."""
    h = hashlib.sha256()
    for f in sorted((out / "sessions").glob(f"{w}_d*.py")):
        h.update(f.name.encode() + b"\0" + f.read_bytes() + b"\0")
    return h.hexdigest()


def build_all(out: Path, worlds: list[str], split: str, jobs: int, resume: bool = False) -> dict:
    """Build every world with authored/build.py: {"wall": {world: seconds}, "total": seconds of the whole step, "cpu": the user and
    system seconds of every process the step ran (build.py and the runtime it drives)}. A build that ends well leaves `<W>.built`, the
    digest of the sessions it was made from; with `resume` a world whose stamp matches its sessions and whose outputs are there is not built
    again (a run that was killed part way, started again with the same arguments, goes on from the worlds it had finished)."""
    sdir = out / "sessions"
    wall: dict[str, float] = {}

    def one(w):
        t = time.time()
        stamp, digest = out / f"{w}.built", sessions_digest(out, w)
        if resume and stamp.exists() and stamp.read_text() == digest and all((out / f"{w}.{x}").exists() for x in ("report.json", "anchoring.json", "gold.jsonl", "jsonl.gz")):
            wall[w] = 0.0
            return
        stamp.unlink(missing_ok=True)
        try:
            r = common.build_world(w, sdir, out, None, None, None, split)
            text = r.stdout + r.stderr
            if r.returncode == 0 and (out / f"{w}.anchoring.json").exists():
                stamp.write_text(digest)
        except Exception as e:  # noqa: BLE001  (one world failing to build must not end the run: its items are reported as not built)
            text = f"build of {w} failed: {e!r}\n"
        try:
            (out / f"{w}.log").write_text(text)
        except OSError:
            pass
        wall[w] = time.time() - t

    t0, before = time.time(), resource.getrusage(resource.RUSAGE_CHILDREN)
    with cf.ThreadPoolExecutor(jobs) as ex:
        list(ex.map(one, worlds))
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {"wall": wall, "total": time.time() - t0, "cpu": after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime}


def hardness_rows(sessions: list[dict]) -> str:
    sys.path.insert(0, str(AUTHORED))
    import hardness
    by = collections.defaultdict(list)
    for s in sessions:
        by[s["_cell"]].append(s)
    rows = {c: hardness.census(ss) for c, ss in sorted(by.items())}
    rows["ALL"] = hardness.census(sessions)
    keys = list(next(iter(rows.values())).keys())
    lines = ["| cell | " + " | ".join(keys) + " |", "|" + " --- |" * (len(keys) + 1)]
    for c, r in rows.items():
        lines.append(f"| {c} | " + " | ".join(str(r[k]) for k in keys) + " |")
    return "\n".join(lines)


def cmd_gen(a) -> None:
    worlds = a.worlds.split(",")
    val = json.loads((AUTHORED / "split.json").read_text())["val"]
    if [w for w in worlds if w in val]:
        raise SystemExit(f"{[w for w in worlds if w in val]} are val worlds (authored/split.json): held out whole, never drilled")
    if a.shares:
        for part in a.shares.split(","):
            cell, _, weight = part.partition("=")
            if cell not in CELL_SHARE or not weight:
                raise SystemExit(f"--shares wants CELL=weight with CELL one of {CELL_NAMES}, got {part!r}")
            CELL_SHARE[cell] = float(weight)
    cells = a.cells.split(",") if a.cells else [c for c in CELL_NAMES if CELL_SHARE[c] > 0]  # a cell with no share (C4) only on request
    bad = [c for c in cells if c not in CELL_NAMES]
    if bad:
        raise SystemExit(f"unknown cells {bad}; cells are {CELL_NAMES}")
    if a.cells and not any(CELL_SHARE[c] > 0 for c in cells):
        for c in cells:
            CELL_SHARE[c] = 1.0  # `--cells C4` alone: that cell gets everything
    if a.templates:
        want = set(a.templates.split(","))
        keep = [t for t in TEMPLATES if t.name in want or f"{t.cell}.{t.name}" in want]
        if not keep:
            raise SystemExit(f"no template matches {sorted(want)}; `cells` lists them")
        TEMPLATES[:] = keep
        cells = [c for c in cells if any(t.cell == c for t in TEMPLATES)]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    avoid: set[str] = set()
    for d in filter(None, (a.avoid or "").split(",")):
        p = Path(d) / "messages.json"
        if p.exists():
            avoid |= set(json.loads(p.read_text()))
    t0 = time.time()
    gaps = Gaps(a.weights) if a.weights else None
    ctxs, allpairs, stats = {}, {}, {}
    seen: set[str] = set()
    for w in worlds:
        # the one cross-world rule, no message of six words or more shared with another world's drill: a world is generated
        # against the long messages of the worlds before it in `--worlds` (same seed, same worlds in the same order, same items),
        # so a quota is filled by another pair, never short; the pass below only guards that no later pair repeats one
        ctx, pairs, st = gen_world(w, a.seed, a.per_world, cells, avoid | seen, gaps=gaps)
        kept_pairs, dup = [], collections.Counter()
        for pa, pb in pairs:
            ms = {t.user for it in (pa, pb) for t in it.turns if is_long(t.user)}
            if ms & seen:
                dup[pa.cell] += 1
                continue
            kept_pairs.append((pa, pb))
        for pa, pb in kept_pairs:
            seen |= {t.user for it in (pa, pb) for t in it.turns if is_long(t.user)}
        st["cross_world_duplicates"] = sum(dup.values())
        st["cross_world_by_cell"] = dict(dup)
        assign_ids(w, kept_pairs)
        write_sessions(out, w, ctx, kept_pairs, a.split)
        ctxs[w], allpairs[w], stats[w] = ctx, kept_pairs, st
    gen_s = time.time() - t0
    build_s: dict = {}
    if not a.no_build:
        build_s = build_all(out, worlds, a.split, a.jobs, resume=getattr(a, "resume", False))
    cellsmap, per_world_res = {}, {}
    tier_gaps = gaps if gaps is not None else (Gaps(None))
    for w in worlds:
        res = analyze_world(out, w, allpairs[w]) if not a.no_build else {}
        per_world_res[w] = res
        for pa, pb in allpairs[w]:
            ok = res.get(pa.sid, {}).get("verified") and res.get(pb.sid, {}).get("verified")
            for it in (pa, pb):
                r_ = res.get(it.sid, {})
                kept = is_kept(it, ok)
                gcells = tier_gaps.item_cells(w, it.turns) if gaps is not None else set()
                cellsmap[it.sid] = {"gap": gaps.tier_of(gcells) if gaps is not None else "", "gap_cells": sorted(c for c in gcells if gaps.tier(c)) if gaps is not None else [],
                                    "cell": it.cell, "pair": it.pair, "side": it.side, "feature": it.feature, "family": it.frame,
                                    "world": w, "shape": it.shape, "k": it.k(), "needs_m1": it.needs_m1, "verified": bool(r_.get("verified")),
                                    "kept": kept, "reason": r_.get("reason", ""), "tags": list(it.tags)}
    (out / "cells.json").write_text(json.dumps(cellsmap, indent=1, ensure_ascii=False))
    (out / "messages.json").write_text(json.dumps(sorted({t.user for ps in allpairs.values() for p in ps for it in p for t in it.turns})))
    # the gold and the training records of the kept sessions: build.py wrote every session that verified on its own, a pair
    # whose sibling failed and a needs-m1 item are not for the corpus
    kept_sessions = []
    with open(out / "kept.gold.jsonl", "w") as allfh:
        for w in worlds:
            gp = out / f"{w}.gold.jsonl"
            if not gp.exists():
                continue
            with open(out / f"{w}.kept.gold.jsonl", "w") as fh, open(gp) as built:
                for line in built:
                    if not line.strip():
                        continue
                    s = json.loads(line)
                    m = cellsmap.get(s["id"])
                    if m and m["kept"]:
                        # the gold as this file authored it (a widening convention may add alternatives; they are kept)
                        s["_cell"] = m["cell"]
                        kept_sessions.append(s)
                        text = json.dumps({k: v for k, v in s.items() if k != "_cell"}, ensure_ascii=False) + "\n"
                        fh.write(text)
                        allfh.write(text)
            rp = out / f"{w}.jsonl.gz"
            if rp.exists():
                with gzip.open(rp, "rt") as src, gzip.open(out / f"{w}.kept.jsonl.gz", "wt") as dst:
                    for line in src:
                        if line.strip() and cellsmap.get(json.loads(line)["id"].split("-", 1)[1], {}).get("kept"):
                            dst.write(line)
    report = make_report(out, worlds, allpairs, cellsmap, per_world_res, stats, kept_sessions, gen_s, build_s, a)
    (out / "report.md").write_text(report)
    print(report)


def hygiene_section(allpairs: dict) -> list[str]:
    """What the messages of the run look like: length, and the two sharing rules checked on the finished sessions."""
    per_world: dict[str, dict[str, set]] = {}
    where: dict[str, set] = collections.defaultdict(set)
    lens = []
    for w, pairs in allpairs.items():
        d = per_world.setdefault(w, collections.defaultdict(set))
        for a, b in pairs:
            for it in (a, b):
                for t in it.turns:
                    d[t.user].add(a.sid_key() + "|" + b.sid_key())
                    where[t.user].add(w)
    seen_len = set()
    for d in per_world.values():
        for m in d:
            if m not in seen_len:
                seen_len.add(m)
                lens.append(len(m.split()))
    lens.sort()
    n = max(1, len(lens))
    shared_in_world = sum(1 for d in per_world.values() for pairs_ in d.values() if len(pairs_) > 1)
    shared_across = sum(1 for m, ws in where.items() if len(ws) > 1 and is_long(m))
    return ["## message hygiene", "",
            f"{len(lens)} distinct messages; words per message: median {lens[len(lens) // 2] if lens else 0}, {100 * sum(1 for x in lens if x <= 4) / n:.1f}% of four words or fewer, "
            f"{100 * sum(1 for x in lens if x > 10) / n:.1f}% above ten; shared by two pairs of one world: {shared_in_world}; of six words or more shared by two worlds: {shared_across}", ""]


def template_section(stats: dict, worlds: list[str]) -> list[str]:
    """Per template, over the worlds: the attempts, the pairs made, and why an attempt gave no pair (the template found nothing to
    flip, both gold outcomes were the same, a message was already taken, the runtime would end a write in its own ask, a `$key` of the first turn would not be in the block). A template
    that mostly fails is a bug or a world that cannot host it."""
    tot: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for w in worlds:
        for k, c in stats[w].get("tpl", {}).items():
            tot[k].update(c)
    rows = ["## templates (attempts over all worlds)", "", "| template | pairs made | attempts | valid | found nothing | same outcome | message refused | would ask | key not shown |", "|---|---|---|---|---|---|---|---|---|"]
    for k in sorted(tot, key=lambda k: (CELL_NAMES.index(k.split(".")[0]), k)):
        c = tot[k]
        rows.append(f"| {k} | {c['made']} | {c['tries']} | {c['valid']} | {c['none']} | {c['same outcome']} | {c['message refused']} | {c['would ask']} | {c['key not shown']} |")
    return rows + [""]


def gap_section(a, cellsmap) -> list[str]:
    L: list[str] = []
    if getattr(a, "weights", None):
        tot = len(cellsmap)
        gs = collections.Counter(m.get("gap", "") for m in cellsmap.values())
        gk = collections.Counter(m.get("gap", "") for m in cellsmap.values() if m["kept"])
        nk = sum(1 for m in cellsmap.values() if m["kept"])
        L += ["## train-coverage weighting", "",
              f"weights from `{a.weights}`: of {tot} generated items {gs['uncovered']} ({100 * gs['uncovered'] / max(1, tot):.1f}%) land in an uncovered cell and "
              f"{gs['thin']} ({100 * gs['thin'] / max(1, tot):.1f}%) in a thin one (together {100 * (gs['uncovered'] + gs['thin']) / max(1, tot):.1f}%); "
              f"of the {nk} kept items {gk['uncovered']} uncovered and {gk['thin']} thin ({100 * (gk['uncovered'] + gk['thin']) / max(1, nk):.1f}%)", ""]
        by = collections.defaultdict(collections.Counter)
        for m in cellsmap.values():
            by[m["cell"]][m.get("gap", "")] += 1
        L.append("per cell, uncovered / thin / other items: " + "; ".join(f"{c} {v['uncovered']}/{v['thin']}/{v['']}" for c, v in sorted(by.items())))
        hit = collections.Counter(c for m in cellsmap.values() for c in m.get("gap_cells", []))
        L += ["", "gap cells reached (items): " + "; ".join(f"{c} x{n}" for c, n in hit.most_common(40)), ""]

    return L


def make_report(out, worlds, allpairs, cellsmap, per_world_res, stats, kept_sessions, gen_s, build_s, a) -> str:
    L = [f"# drills report: worlds {','.join(worlds)}, seed {a.seed}, per-world {a.per_world}", ""]
    n_items = sum(len(p) * 2 for p in allpairs.values())
    L.append(f"generation {gen_s:.1f}s for {n_items} items ({100 * gen_s / max(1, n_items):.2f}s per 100)"
             + (f"; build {build_s['total']:.0f}s wall ({', '.join(f'{w} {t:.0f}s' for w, t in build_s['wall'].items())}; {a.jobs} job(s)), "
                f"{build_s['cpu']:.0f} cpu-s in all: {100 * build_s['cpu'] / max(1, n_items):.1f} cpu-s and {100 * build_s['total'] / max(1, n_items):.1f} wall-s per 100 items"
                if build_s else ""))
    if getattr(a, "no_build", False):
        L += ["", "(sessions written, not built: `--no-build`)", "", "| cell | items | pairs |", "|---|---|---|"]
        cnt = collections.Counter(m["cell"] for m in cellsmap.values())
        L += [f"| {c} | {cnt[c]} | {cnt[c] // 2} |" for c in CELL_NAMES if cnt[c]]
        L += [""] + gap_section(a, cellsmap) + hygiene_section(allpairs) + ["## quota", ""]
        for w in worlds:
            st = stats[w]
            L.append(f"- {w}: asked {st['asked']}, made {dict(st['made'])}, unfilled {dict(st.get('unfilled', {}))}, pairs dropped as a message another world already has: {st.get('cross_world_duplicates', 0)}")
        return "\n".join(L + [""] + template_section(stats, worlds)) + "\n"
    L += ["", "## per cell", "", "| cell | generated | needs-m1 | verified | kept | pairs | pairs kept | drop rate | top reasons |", "|---|---|---|---|---|---|---|---|---|"]
    by_cell = collections.defaultdict(list)
    for sid, m in cellsmap.items():
        by_cell[m["cell"]].append((sid, m))
    flags = []
    for cell in CELL_NAMES:
        rows = by_cell.get(cell)
        if not rows:
            continue
        m1 = [r for r in rows if r[1]["needs_m1"]]
        real = [r for r in rows if not r[1]["needs_m1"]]
        ver = sum(1 for r in real if r[1]["verified"])
        kept = sum(1 for r in real if r[1]["kept"])
        pairs = {r[1]["pair"] for r in real}
        pk = {p for p in pairs if all(r[1]["kept"] for r in real if r[1]["pair"] == p)}
        reasons = collections.Counter(r[1]["reason"] for r in real if not r[1]["verified"] and r[1]["reason"])
        drop = 1 - ver / len(real) if real else 0
        if real and drop > 0.15:
            flags.append(f"{cell}: drop rate {drop:.0%} over 15%")
        L.append(f"| {cell} | {len(rows)} | {len(m1)} | {ver} | {kept} | {len(pairs)} | {len(pk)} | {drop:.1%} | "
                 + "; ".join(f"{k} x{v}" for k, v in reasons.most_common(4)) + " |")
    allreal = [m for m in cellsmap.values() if not m["needs_m1"]]
    pairs_all = {m["pair"] for m in allreal}
    pk_all = {p for p in pairs_all if all(m["kept"] for m in allreal if m["pair"] == p)}
    L += ["", f"pair consistency: {len(pk_all)} of {len(pairs_all)} pairs have both siblings kept ({100 * len(pk_all) / max(1, len(pairs_all)):.1f}%); "
              f"items kept {sum(m['kept'] for m in allreal)} of {len(allreal)}", ""]
    if flags:
        L += ["**generator bugs (drop over 15%):** " + "; ".join(flags), ""]
    L += gap_section(a, cellsmap)
    L += hygiene_section(allpairs)
    L += ["## quota", ""]
    for w in worlds:
        st = stats[w]
        L.append(f"- {w}: asked {st['asked']}, made {dict(st['made'])}, unfilled {dict(st.get('unfilled', {}))}, "
                 f"pairs dropped as a message another world already has: {st.get('cross_world_duplicates', 0)}")
    L += [""] + template_section(stats, worlds)
    # drop reasons in full
    L += ["## drop reasons (items)", ""]
    rc = collections.Counter((m["cell"], m["reason"]) for m in allreal if not m["verified"])
    for (cell, reason), n in sorted(rc.items(), key=lambda kv: (kv[0][0], -kv[1])):
        L.append(f"- {cell} x{n}: {reason}")
    # the disagreements, verbatim
    L += ["", "## disagreements with the runtime (message and reference, verbatim)", ""]
    shown = 0
    dis = []
    for w in worlds:
        for a_, b_ in allpairs[w]:
            for it in (a_, b_):
                r_ = per_world_res[w].get(it.sid)
                if not r_ or r_["verified"] or it.needs_m1:
                    continue
                if r_["reason"].startswith(("gold fails", "convention", "reference call rejected", "gold change no convention explains", "name-match",
                                            "marked bad call accepted", "trace", "error")):
                    dis.append({"id": it.sid, "cell": it.cell, "reason": r_["reason"], "detail": r_["detail"],
                                "turns": [{"user": t.user, "ref": [common.render_call(c) for c in t.ref], "gold": t.gold} for t in it.turns]})
    (out / "disagreements.json").write_text(json.dumps(dis, indent=1, ensure_ascii=False))
    seen = collections.Counter()
    for d in dis:
        key = (d["cell"], d["reason"])
        if seen[key] >= 3:
            continue
        seen[key] += 1
        shown += 1
        L.append(f"- `{d['id']}` {d['reason']}: {d['detail'][:260]}")
        for t in d["turns"]:
            L.append(f"    - message: `{t['user']}`; reference: {' ; '.join(t['ref'])}; gold: `{json.dumps(t['gold'])[:240]}`")
    L.append(f"\n({len(dis)} disagreements in all, first 3 per reason above; the full list is disagreements.json)")
    needs = [m for m in cellsmap.values() if m["needs_m1"]]
    L += ["", f"## needs-m1: {len(needs)} items built (kept out of every count above)", ""]
    if kept_sessions:
        L += ["## hardness of the kept items (authored/hardness.py)", "", hardness_rows(kept_sessions), ""]
    cov = collections.Counter(m["shape"] for m in cellsmap.values() if m["kept"] and m["shape"])
    if cov:
        L += ["## date shapes among the kept items", "", ", ".join(f"{k}: {v}" for k, v in cov.most_common()), ""]
    return "\n".join(L)


def cmd_cells(a) -> None:
    print(f"{'cell':8}{'templates':>10}{'frames':>8}   what the pair flips")
    for c in CELL_NAMES:
        ts = [t for t in TEMPLATES if t.cell == c]
        print(f"{c:8}{len(ts):>10}{sum(t.frames for t in ts):>8}   {CELL_DOC[c]}" + ("   [needs-m1]" if ts and all(t.needs_m1 for t in ts) else ""))
        for t in ts:
            print(f"    {t.name:28} weight {t.weight:<4} frames {t.frames}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen")
    g.add_argument("--worlds", required=True)
    g.add_argument("--out", required=True)
    g.add_argument("--per-world", type=int, default=200, help="items (sessions) per world; two per pair")
    g.add_argument("--seed", default="7")
    g.add_argument("--cells")
    g.add_argument("--templates", help="comma list of `template` or `cell.template` names (see `cells`): only those, to isolate one")
    g.add_argument("--shares", help="CELL=weight,... overrides of the share each cell gets of --per-world (default: CELL_SHARE, the C2 17%% .. AMB 4%% mix); "
                                    "the weights are normalised over the cells run")
    g.add_argument("--jobs", type=int, default=4)
    g.add_argument("--split", default="train")
    g.add_argument("--avoid", help="comma list of earlier OUT dirs whose messages.json must not be repeated")
    g.add_argument("--no-build", action="store_true", help="write the sessions only")
    g.add_argument("--resume", action="store_true", help="skip the worlds an interrupted run of these very sessions already built (stamp `<W>.built`); same arguments, same output")
    g.add_argument("--weights", help="train-coverage.json (or its .md): weight the cell sampling toward the cells the train corpus never or rarely produces")
    m = sub.add_parser("measure", help="per cell: items, turn pass, pair pass, the ten worst phrasing families, from a driver run and any gold file")
    m.add_argument("--run", required=True, help="eval/run.py output (one record per session)")
    m.add_argument("--gold", help="the gold file(s) the run was made on (comma list or globs); default: the *.gold.jsonl beside --cells")
    m.add_argument("--cells", help="a drills cells.json: the drills' own cell, pair and phrasing family for the sessions it knows")
    m.add_argument("--md")
    sub.add_parser("cells")
    a = ap.parse_args()
    {"gen": cmd_gen, "cells": cmd_cells, "measure": cmd_measure}[a.cmd](a)


if __name__ == "__main__":
    main()
