"""Model-side date readings: phrase -> §4.4 expression, per phrases.json and the §14 rulings.

This module never evaluates an expression. Ranges come from the runtime (Oracle below), which
echoes every expression it evaluates.
"""
from __future__ import annotations

import datetime as dt
import json
import random
import re
from dataclasses import dataclass

from rt import Session

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december"]
NUMW = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten"}

RULE_AT = '"at N" = N+12:00 for N in 1..7'
RULE_BARE_WD = "bare weekday = next occurrence, today included"
RULE_NEXT_WD = '"next <weekday>" = that day of next week'
RULE_LAST_MONTH = '"last <month>" = most recent fully ended one'
RULE_NEXT_MONTH = '"next <month>" = next one not yet begun'
RULE_WEEKEND = '"this weekend" = coming Sat-Sun'
RULE_LAST_N = '"the last N days" = N days ending today'


@dataclass
class DatePhrase:
    text: str          # as it appears in the message
    expr: dict         # the §4.4 expression the model writes
    family: str        # phrase family id (coverage)
    shape: str         # expression shape (coverage): day, day+time, week, week+weekday, month, month+name, ...
    rule: str | None = None   # convention applied (quoted in the trace)
    anchor_row: bool = False
    kept: bool = False        # carried over from the previous question (substitution)

    def trace(self) -> str:
        s = f'date{" (kept)" if self.kept else ""}: "{self.text}" → {describe(self.expr)}'
        if self.rule:
            s += f" ({self.rule})"
        return s


def describe(e: dict) -> str:
    if "from" in e or "to" in e:
        if "to" not in e:
            return f"from {describe(e['from'])} on"
        if "from" not in e:
            return f"up to {describe(e['to'])}"
        return f"from {describe(e['from'])} to {describe(e['to'])}"
    if "date" in e:
        return e["date"] + (f" {e['time']}" if "time" in e else "")
    parts = [e["unit"]]
    if "name" in e:
        parts.append(f"{e['name']}")
    if "weekday" in e:
        parts.append(f"weekday {e['weekday']}")
    rel = e.get("rel", 0)
    parts.append(f"rel {rel:+d}" if rel else "rel 0")
    if "time" in e:
        parts.append(e["time"])
    if e.get("anchor") == "row":
        parts.append("from the row")
    return ", ".join(parts)


def shape(e: dict) -> str:
    if "from" in e or "to" in e:
        return "span" if "from" in e and "to" in e else "open span"
    if "date" in e:
        return "date+time" if "time" in e else "date"
    s = e["unit"]
    if "name" in e:
        s += "+name"
    if "weekday" in e:
        s += "+weekday"
    if "time" in e:
        s += "+time"
    if e.get("anchor") == "row":
        s += "@row"
    return s


def _mk(text, expr, fam, rule=None, anchor=False) -> DatePhrase:
    return DatePhrase(text, expr, fam, shape(expr), rule, anchor)


def at_time(rng: random.Random) -> tuple[str, str, str | None]:
    """A spoken time -> (text, HH:MM, rule)."""
    c = rng.random()
    if c < 0.35:
        h = rng.randint(1, 7)
        return f"at {h}", f"{h + 12:02d}:00", RULE_AT
    if c < 0.55:
        h = rng.choice([8, 9, 10, 11])
        return f"at {h}", f"{h:02d}:00", None
    if c < 0.7:
        h = rng.choice([1, 2, 3, 4, 5, 6, 7, 8, 9])
        return f"at {h}pm", f"{h + 12:02d}:00", None
    if c < 0.8:
        h = rng.choice([7, 8, 9, 10, 11])
        return f"at {h}am", f"{h:02d}:00", None
    if c < 0.92:
        h = rng.choice([8, 9, 10, 11])
        m = rng.choice([15, 30, 45])
        return f"at {h}:{m:02d}", f"{h:02d}:{m:02d}", None
    return "at noon", "12:00", None


def read_phrase(rng: random.Random, today: dt.datetime, family: str | None = None) -> DatePhrase:
    """A period phrase for a `when` filter on a read (or a write selector)."""
    wd_today = today.isoweekday()
    fams = ["day_rel", "day_n", "week", "month", "year", "month_name", "weekday", "weekend", "span_last_n",
            "span_since", "span_wd", "date_iso", "date_nth", "open"]
    fam = family or rng.choice(fams)
    if fam == "day_rel":
        t, r = rng.choice([("today", 0), ("tomorrow", 1), ("yesterday", -1), ("the day after tomorrow", 2),
                           ("the day before yesterday", -2)])
        return _mk(t, {"unit": "day", "rel": r}, fam)
    if fam == "day_n":
        n = rng.randint(2, 10)
        if rng.random() < 0.5:
            return _mk(f"{NUMW[n]} days ago", {"unit": "day", "rel": -n}, fam)
        return _mk(f"in {NUMW[n]} days", {"unit": "day", "rel": n}, fam)
    if fam == "week":
        t, r = rng.choice([("this week", 0), ("next week", 1), ("last week", -1), ("the week after next", 2)])
        return _mk(t, {"unit": "week", "rel": r}, fam)
    if fam == "month":
        t, r = rng.choice([("this month", 0), ("next month", 1), ("last month", -1)])
        return _mk(t, {"unit": "month", "rel": r}, fam)
    if fam == "year":
        t, r = rng.choice([("this year", 0), ("last year", -1), ("next year", 1)])
        return _mk(t, {"unit": "year", "rel": r}, fam)
    if fam == "month_name":
        m = rng.randint(1, 12)
        c = rng.random()
        if c < 0.55:
            return _mk(f"last {MONTHS[m - 1]}", {"unit": "month", "name": m, "rel": -1}, fam, RULE_LAST_MONTH)
        if c < 0.8:
            return _mk(f"next {MONTHS[m - 1]}", {"unit": "month", "name": m, "rel": 1}, fam, RULE_NEXT_MONTH)
        if c < 0.93:
            return _mk(f"this {MONTHS[m - 1]}", {"unit": "month", "name": m, "rel": 0}, fam)
        return _mk(f"the {MONTHS[m - 1]} before last", {"unit": "month", "name": m, "rel": -2}, fam)
    if fam == "weekday":
        d = rng.randint(1, 7)
        c = rng.random()
        if c < 0.3:
            return _mk(f"next {WEEKDAYS[d - 1]}", {"unit": "week", "rel": 1, "weekday": d}, fam, RULE_NEXT_WD)
        if c < 0.5:
            return _mk(f"last {WEEKDAYS[d - 1]}", {"unit": "week", "rel": -1, "weekday": d}, fam)
        if c < 0.65:
            return _mk(f"this {WEEKDAYS[d - 1]}", {"unit": "week", "rel": 0, "weekday": d}, fam)
        rel = 0 if d >= wd_today else 1
        return _mk(f"on {WEEKDAYS[d - 1]}", {"unit": "week", "rel": rel, "weekday": d}, fam,
                   f"{RULE_BARE_WD}; today is {WEEKDAYS[wd_today - 1][:3].title()}")
    if fam == "weekend":
        t, r = rng.choice([("this weekend", 0), ("next weekend", 1), ("last weekend", -1)])
        return _mk(t, {"from": {"unit": "week", "rel": r, "weekday": 6}, "to": {"unit": "week", "rel": r, "weekday": 7}},
                   fam, RULE_WEEKEND if r == 0 else None)
    if fam == "span_last_n":
        n = rng.choice([3, 5, 7, 10, 14, 30])
        return _mk(f"the last {n} days", {"from": {"unit": "day", "rel": -(n - 1)}, "to": {"unit": "day", "rel": 0}},
                   fam, RULE_LAST_N)
    if fam == "span_since":
        m = rng.randint(1, 12)
        return _mk(f"since last {MONTHS[m - 1]}", {"from": {"unit": "month", "name": m, "rel": -1},
                                                    "to": {"unit": "day", "rel": 0}}, fam, RULE_LAST_MONTH)
    if fam == "span_wd":
        if rng.random() < 0.5:
            a, z = sorted(rng.sample(range(1, 6), 2))
            return _mk(f"from {WEEKDAYS[a - 1]} to {WEEKDAYS[z - 1]} next week",
                       {"from": {"unit": "week", "rel": 1, "weekday": a}, "to": {"unit": "week", "rel": 1, "weekday": z}}, fam)
        d = rng.randint(1, 7)
        rel = 0 if d >= wd_today else 1
        return _mk(f"between now and {WEEKDAYS[d - 1]}", {"from": {"unit": "day", "rel": 0},
                                                           "to": {"unit": "week", "rel": rel, "weekday": d}}, fam,
                   f"{RULE_BARE_WD}; today is {WEEKDAYS[wd_today - 1][:3].title()}")
    if fam == "open":
        # one-ended spans (the runtime filters from/to alone)
        base = read_phrase(rng, today, rng.choice(["weekday", "date_nth", "month_name"]))
        if base.text.startswith("on "):          # "from on the 22nd onwards" -> "from the 22nd onwards"
            base = _mk(base.text[3:], base.expr, base.family, base.rule)
        if rng.random() < 0.6:
            return _mk(f"from {base.text} onwards", {"from": base.expr}, fam, base.rule)
        return _mk(f"up to {base.text}", {"to": base.expr}, fam, base.rule)
    if fam == "date_iso":
        d = (today + dt.timedelta(days=rng.randint(-60, 60))).date()
        return _mk(f"on {d.isoformat()}", {"date": d.isoformat()}, fam)
    if fam == "date_nth":
        # "on the Nth" = the next Nth, this month if not past
        day = rng.randint(1, 28)
        y, m = today.year, today.month
        if day < today.day:
            m += 1
            if m == 13:
                y, m = y + 1, 1
        d = dt.date(y, m, day)
        return _mk(f"on the {ordinal(day)}", {"date": d.isoformat()}, fam)
    raise ValueError(fam)


def ordinal(n: int) -> str:
    suf = "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def instant_phrase(rng: random.Random, today: dt.datetime, family: str | None = None) -> DatePhrase:
    """A moment for create/reschedule (`date:` / `to:`) relative to today."""
    wd_today = today.isoweekday()
    fams = ["day_time", "weekday_time", "next_wd_time", "date_md_time", "hours", "day_only", "weekday_only",
            "date_nth"]
    fam = family or rng.choice(fams)
    if fam == "day_time":
        t, r = rng.choice([("tomorrow", 1), ("today", 0), ("the day after tomorrow", 2)])
        if r == 0 and rng.random() < 0.4:
            h = rng.randint(6, 9)
            return _mk(f"tonight at {h}", {"unit": "day", "rel": 0, "time": f"{h + 12:02d}:00"}, fam)
        at, hm, rule = at_time(rng)
        if rng.random() < 0.3:
            return _mk(f"{at} {t}", {"unit": "day", "rel": r, "time": hm}, fam, rule)
        return _mk(f"{t} {at}", {"unit": "day", "rel": r, "time": hm}, fam, rule)
    if fam == "weekday_time":
        d = rng.randint(1, 7)
        rel = 0 if d >= wd_today else 1
        at, hm, rule = at_time(rng)
        rules = f"{RULE_BARE_WD}; today is {WEEKDAYS[wd_today - 1][:3].title()}"
        if rule:
            rules += f"; {rule}"
        return _mk(f"{WEEKDAYS[d - 1]} {at}", {"unit": "week", "rel": rel, "weekday": d, "time": hm}, fam, rules)
    if fam == "next_wd_time":
        d = rng.randint(1, 7)
        at, hm, rule = at_time(rng)
        rules = RULE_NEXT_WD + (f"; {rule}" if rule else "")
        return _mk(f"next {WEEKDAYS[d - 1]} {at}", {"unit": "week", "rel": 1, "weekday": d, "time": hm}, fam, rules)
    if fam == "date_md_time":
        d = (today + dt.timedelta(days=rng.randint(1, 120))).date()
        at, hm, rule = at_time(rng)
        return _mk(f"{MONTHS[d.month - 1]} {d.day} {at}", {"date": d.isoformat(), "time": hm}, fam, rule)
    if fam == "hours":
        c = rng.random()
        if c < 0.5:
            n = rng.randint(1, 4)
            return _mk(f"in {'an hour' if n == 1 else NUMW.get(n, n) + ' hours'}", {"unit": "hour", "rel": n}, fam)
        n = rng.choice([15, 20, 30, 45])
        return _mk(f"in {n} minutes", {"unit": "minute", "rel": n}, fam)
    if fam == "day_only":
        t, r = rng.choice([("tomorrow", 1), ("today", 0), ("the day after tomorrow", 2)])
        if rng.random() < 0.3:
            n = rng.randint(3, 10)
            return _mk(f"in {NUMW[n]} days", {"unit": "day", "rel": n}, fam)
        return _mk(t, {"unit": "day", "rel": r}, fam)
    if fam == "weekday_only":
        d = rng.randint(1, 7)
        if rng.random() < 0.5:
            return _mk(f"next {WEEKDAYS[d - 1]}", {"unit": "week", "rel": 1, "weekday": d}, fam, RULE_NEXT_WD)
        rel = 0 if d >= wd_today else 1
        return _mk(WEEKDAYS[d - 1], {"unit": "week", "rel": rel, "weekday": d}, fam,
                   f"{RULE_BARE_WD}; today is {WEEKDAYS[wd_today - 1][:3].title()}")
    if fam == "date_nth":
        return read_phrase(rng, today, "date_nth")
    raise ValueError(fam)


def shift_phrase(rng: random.Random) -> DatePhrase:
    """Row-anchored moves: "an hour earlier" (anchor row, only inside act)."""
    opts = [("an hour earlier", {"unit": "hour", "rel": -1}), ("an hour later", {"unit": "hour", "rel": 1}),
            ("two hours later", {"unit": "hour", "rel": 2}), ("half an hour later", {"unit": "minute", "rel": 30}),
            ("half an hour earlier", {"unit": "minute", "rel": -30}), ("a day later", {"unit": "day", "rel": 1}),
            ("two days earlier", {"unit": "day", "rel": -2}), ("a week later", {"unit": "week", "rel": 1}),
            ("a day earlier", {"unit": "day", "rel": -1}), ("a month later", {"unit": "month", "rel": 1}),
            ("three days later", {"unit": "day", "rel": 3})]
    t, e = rng.choice(opts)
    e = dict(e, anchor="row")
    if rng.random() < 0.15:
        at, hm, rule = at_time(rng)
        return _mk(f"the next day {at}", {"unit": "day", "rel": 1, "time": hm, "anchor": "row"}, "shift", rule, True)
    return _mk(t, e, "shift", None, True)


class Oracle:
    """Evaluates expressions through the runtime's own echo, on a scratch session."""

    RX = re.compile(r"when: ([^)\n]+?)(?:\)|$)", re.M)

    def __init__(self, vault, today: str, me: str):
        self.s = Session(vault, today, me, directory=False, preground=False)
        self.s.prompt()
        self.n = 99
        self.cache: dict[str, tuple] = {}

    def range(self, expr: dict) -> tuple[str, str]:
        """(lo, hi) as ISO strings; for an instant lo == hi == 'YYYY-MM-DDTHH:MM'."""
        key = json.dumps(expr, sort_keys=True)
        if key in self.cache:
            return self.cache[key]
        if self.n >= 4:
            self.s.user("probe")
            self.n = 0
        self.n += 1
        r = self.s.call("find", {"kind": "task", "when": expr})
        m = self.RX.search(r["text"])
        if not m:
            raise ValueError(f"no echo for {expr}: {r['text'][:200]}")
        txt = m.group(1).strip()
        if ".." in txt:
            a, z = txt.split("..")
            out = (a.strip()[-10:] or "0000-00-00", (z.strip()[-10:] + "T23:59") if z.strip() else "9999-12-31")
        else:
            parts = txt.split()
            d = parts[1] if len(parts) > 1 and re.match(r"\d{4}-", parts[1]) else parts[0]
            if len(parts) >= 3:
                out = (f"{d}T{parts[2]}", f"{d}T{parts[2]}")
            else:
                out = (d, d + "T23:59")
        self.cache[key] = out
        return out

    def contains(self, expr: dict, when: dt.datetime | None) -> bool:
        if when is None:
            return False
        lo, hi = self.range(expr)
        iso = when.strftime("%Y-%m-%dT%H:%M")
        return lo <= iso <= hi if "T" in lo else lo <= iso[:10] and iso <= hi

    def close(self):
        self.s.close()
