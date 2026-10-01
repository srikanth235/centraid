#!/usr/bin/env python3
"""v3 canonical sampler: typed, coverage-driven, multi-turn.

    python3 gen.py                 # writes canon.jsonl, heldout_canon.jsonl, coverage.md

Every choice is TYPED by typing_v3.py (derived.json + lexicon.py + v2/arms.json):
a field only under a kind that has it, a predicate form only where derived.json
admits it, `B of (A)` only along a link, sum/min/max only on aggregable fields,
enum fields only against their CHECK values, `during` only on date fields,
`count of Kind` only along a link, and every write is one of the 29 executor
arms with only the arg names that arm reads.

Every choice is also COVERAGE-DRIVEN: each option carries the coverage keys it
would exercise (grammar edges in the context of their parent, and terminals),
and the sampler takes the option whose least-covered key is least covered
(greedy covering, weighted by realism, with a small jitter). Turn types and
set depth are drawn the same way against target shares (the gold profile the
brief gives: depth 0/1/2/3/4+ = 7/43/43/6/1 %, ~45 % multi-turn).

Every target is checked by gbnf.Recognizer (the GBNF rule table), by
check.parse (the reference parser, imported — its main() reads map.json and is
never run), by the arms check, and for degenerate `X of (X called|that`.
No evaluation file is opened by this script or anything it imports.
"""
import collections, datetime, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from typing_v3 import (KINFO, LINKS, EXEC_WALKS, COUNT_WALKS, MEMBER_OF, CMDS, CLASS_OK,  # noqa: E402
                       ARMS, REQUIRED, NULL_ONLY, SEALED, GRAMMAR, L)
import pools as P  # noqa: E402
import gbnf  # noqa: E402
import check  # noqa: E402  (parser only; check.main() is never called)

REC = gbnf.Recognizer(gbnf.rules())
DAY0, DAY1 = datetime.date(2025, 3, 1), datetime.date(2028, 11, 30)

DEPTH_SHARE = {0: 0.07, 1: 0.43, 2: 0.43, 3: 0.06, 4: 0.01}
# turn-type shares (single-turn s.*, multi-turn m.*); normalised below
TT_SHARE = {
    "s.show": 13, "s.value": 8.5, "s.cmd": 5.5, "s.create": 1.6, "s.linkpred": 1.2, "s.anchored": 0.3,
    "s.seq": 1.2, "s.same": 1.2, "s.refuse": 3.2, "s.clarify": 0.9, "s.nothing": 0.4, "s.overdue": 1.3,
    "s.open": 1.3, "s.owe": 1.4, "s.lastcontact": 0.7, "s.find": 1.2, "s.whatson": 1.2, "s.dates": 0.8,
    "m.refine": 4.0, "m.window": 2.2, "m.sort": 2.0, "m.walk": 3.5, "m.agg": 7.0,
    "m.bareagg": 1.6, "m.project": 4.5, "m.write": 9.0, "m.undo": 1.8, "m.nothing": 1.4,
    "m.substitute": 1.5, "m.widen": 0.8, "m.other": 1.2, "m.earlier": 1.2, "m.lastadded": 1.5,
    "m.same": 0.8, "m.clarify": 1.0, "m.c14": 1.0, "m.seq": 1.0, "m.new": 0.6,
    "m.lastcontact": 0.4, "m.overdue": 0.6,
}
MULTI = 0.50
_s = sum(v for k, v in TT_SHARE.items() if k.startswith("s."))
_m = sum(v for k, v in TT_SHARE.items() if k.startswith("m."))
TT_SHARE = {k: (v / _s * (1 - MULTI) if k.startswith("s.") else v / _m * MULTI) for k, v in TT_SHARE.items()}

KIND_W = {"tasks": 3, "events": 3, "photos": 2.5, "expenses": 2.5, "notes": 2.5, "parties": 3,
          "documents": 2, "locker items": 1.6, "members": 1.4, "groups": 1.6, "obligations": 1.6,
          "albums": 1.4, "places": 1.3, "activities": 1.2, "important dates": 1.2,
          "contact channels": 1.1, "profiles": 1.1, "journal notes": 1.1, "settlements": 1.0,
          "projects": 1.0, "notebooks": 0.9, "transactions": 0.9, "accounts": 0.8, "circles": 0.7}
HOUSE = {"created_at", "updated_at", "deleted_at"}


class Fail(Exception):
    pass


# ---------------------------------------------------------------------------
# set expressions
# ---------------------------------------------------------------------------
class S:
    __slots__ = ("text", "kind", "depth", "form", "plural", "single", "ordered", "bounded", "two")

    def __init__(self, text, kind, depth, form, plural=True, single=False, ordered=False,
                 bounded=True, two=False):
        self.text, self.kind, self.depth, self.form = text, kind, depth, form
        self.plural, self.single, self.ordered, self.bounded, self.two = plural, single, ordered, bounded, two


def par(s):
    return s.text if s.form in ("kind", "ref") else "(%s)" % s.text


def base(s):
    return s.text if s.form in ("kind", "ref", "post", "walk") else "(%s)" % s.text


def q(x):
    return '"%s"' % x.replace("\\", "\\\\").replace('"', '\\"')


class Ctx:
    """What the previous turn left behind (§3)."""

    def __init__(self, held=None, plural=True, ordered=False, two=False, earlier=None,
                 added=None, written=None, wrote_plural=False, delete_cls=None, value=False):
        self.held, self.plural, self.ordered, self.two = held, plural, ordered, two
        self.value = value
        self.earlier, self.added, self.written = earlier, added, written
        self.wrote_plural, self.delete_cls = wrote_plural, delete_cls

    def meta(self):
        return {k: getattr(self, k) for k in ("held", "plural", "ordered", "two", "earlier",
                                               "added", "written")}


NOCTX = Ctx()


# ---------------------------------------------------------------------------
# the sampler
# ---------------------------------------------------------------------------
class Gen:
    def __init__(self, seed, counts=None):
        self.rng = random.Random(seed)
        self.counts = counts if counts is not None else collections.Counter()
        self.pending = collections.Counter()
        self.penalty = collections.Counter()

    # -- coverage ---------------------------------------------------------
    def c(self, key):
        return self.counts[key] + self.pending[key] + self.penalty[key]

    def pick(self, options, jitter=0.35):
        """options: [(value, [keys], weight)] -> value whose least-covered key is
        least covered (count / weight), ties broken by jitter."""
        best, score = None, None
        for value, keys, w in options:
            if w <= 0:
                continue
            m = min(self.c(k) for k in keys) if keys else 0
            s = (m + self.rng.random() * jitter * (1 + m ** 0.5)) / w
            if score is None or s < score:
                best, score = (value, keys), s
        if best is None:
            raise Fail("no option")
        for k in best[1]:
            self.pending[k] += 1
        return best[0]

    def mark(self, *keys):
        for k in keys:
            self.pending[k] += 1

    # -- literals -----------------------------------------------------------
    def person(self, full=None):
        f, l = self.rng.choice(P.FIRST), self.rng.choice(P.LAST)
        if full is None:
            full = self.rng.random() < 0.6
        return "%s %s" % (f, l) if full else f

    def label(self, kind):
        r = self.rng.choice
        return {
            "tasks": lambda: r(P.TASKS), "events": lambda: r(P.EVENTS), "notes": lambda: r(P.NOTES),
            "journal notes": lambda: r(["coffee with %s" % self.person(False), "catch-up notes",
                                        "what %s said" % self.person(False), r(P.NOTES)]),
            "documents": lambda: r(P.DOCS), "parties": lambda: self.person(),
            "members": lambda: self.person(), "photos": lambda: r(P.PHOTOS),
            "albums": lambda: r(P.ALBUMS), "notebooks": lambda: r(P.NOTEBOOKS),
            "places": lambda: r(P.PLACES), "expenses": lambda: r(P.EXPENSES),
            "groups": lambda: r(P.GROUPS), "circles": lambda: r(P.CIRCLES),
            "accounts": lambda: r(P.ACCOUNTS), "transactions": lambda: r(P.TXNS),
            "projects": lambda: r(P.PROJECTS), "locker items": lambda: r(P.LOCKER),
            "things": lambda: r(P.PLACES + P.PROJECTS + P.GROUPS + [self.person(False)]),
        }[kind]()

    def short(self, lit):
        """A `called` literal is sometimes the distinctive part only."""
        words = lit.split()
        if len(words) >= 3 and self.rng.random() < 0.25:
            keep = [w for w in words if len(w) > 3 and w.lower() not in ("the", "with", "from")]
            if keep:
                return keep[0] if self.rng.random() < 0.5 else " ".join(words[:2])
        return lit

    def date(self, lo=-30, hi=45):
        return self.today + datetime.timedelta(days=self.rng.randint(lo, hi))

    def dt(self, lo=-10, hi=30):
        d = self.date(lo, hi)
        return "%sT%02d:%s" % (d.isoformat(), self.rng.randint(7, 20), self.rng.choice(["00", "30"]))

    def dur(self):
        return self.rng.choice(["+1d", "-1d", "+2d", "+7d", "+1h", "-1h", "+2h", "+3d", "-2h", "+14d"])

    def amount(self):
        return self.rng.choice([150, 350, 480, 750, 900, 1250, 1500, 1850, 2000, 2400, 3275,
                                4500, 6000, 8800, 12000, 15050, 24000])

    # -- windows ------------------------------------------------------------
    PAST = {"spent_on", "captured_at", "started_at", "paid_on", "posted_at", "incurred_on",
            "settled_at", "completed_at", "created_at", "updated_at", "deleted_at",
            "last_contacted_at", "archived_at", "opened_at", "closed_at", "password_set_at",
            "rate_date", "ended_at"}

    def window(self, field, ctxk="W", allow_anchor=True, nmax=0):
        past = field in self.PAST
        phrases = ["today", "yesterday", "this week", "last week", "this weekend", "last weekend",
                   "this month", "last month", "recently"] if past else \
            ["today", "tomorrow", "this week", "next week", "this weekend", "this month",
             "next month", "before now", "yesterday", "last week", "last month"]
        opts = [(("phrase", p), ["W:" + p], 1.0) for p in phrases]
        opts += [(("date", None), ["W:date"], 1.6), (("month", None), ["W:month"], 0.6),
                 (("daterange", None), ["W:daterange"], 0.6), (("datetime", None), ["W:datetime"], 0.15)]
        if not past:
            opts.append((("rolling", None), ["W:rolling"], 0.8))
        if allow_anchor and nmax >= 2:
            opts.append((("anchored", None), ["W:anchored"], 0.25))
        how, val = self.pick(opts)
        if how == "phrase":
            return val, 0
        lo, hi = (-60, 0) if past else (-20, 45)
        if how == "date":
            return self.date(lo, hi).isoformat(), 0
        if how == "datetime":
            return self.dt(lo, hi), 0
        if how == "month":
            d = self.date(lo, hi)
            return "%04d-%02d" % (d.year, d.month), 0
        if how == "daterange":
            d = self.date(lo, hi - 7)
            return "%s..%s" % (d.isoformat(), (d + datetime.timedelta(days=self.rng.randint(2, 9))).isoformat()), 0
        if how == "rolling":
            n, unit = self.rng.choice([(3, "days"), (7, "days"), (10, "days"), (2, "weeks"),
                                       (3, "weeks"), (2, "months"), (3, "months"), (6, "months")])
            return "next %d %s" % (n, unit), 0
        ev = self.label("events")
        a = self.rng.choice(["dtstart", "dtend"])
        return "from (dtstart of (events called %s)) to (%s of (events called %s))" % (
            q(ev), a, q(self.rng.choice([ev, self.label("events")]))), 2

    # -- predicates ---------------------------------------------------------
    def lit_for(self, kind, f, info, eq=False):
        if f in P.TEXT:
            if eq and f not in P.EQ_OK:
                return None
            return self.rng.choice(P.TEXT[f])
        if info["shape"] == "label" or f in ("title", "name"):
            lab = self.label(kind)
            if eq:
                return lab
            words = [w for w in lab.split() if len(w) > 3]
            return self.rng.choice(words) if words else lab
        if f in ("album", "album_titles"):
            return self.rng.choice(P.ALBUMS)
        if f == "place":
            return self.rng.choice(P.PLACES)
        if f == "notebooks":
            return self.rng.choice(P.NOTEBOOKS)
        return None

    def num_for(self, f):
        if f in P.FLAGS:
            return self.rng.choice([1, 1, 0])
        return self.rng.choice(P.NUMS.get(f, [1, 2, 5]))

    def ref_of(self, kind, ctx, single=False, base=False):
        """Ref terminals that name rows of `kind` in this context. `base`: the
        ref is about to be refined, so only a plural answer qualifies."""
        out = []
        if ctx.held == kind:
            if ctx.plural and not single:
                out.append(("them", 1.0))
            if not base:
                if not ctx.plural:
                    out += [("it", 1.0), ("that one", 0.25)]
                if ctx.plural and not ctx.value:
                    n = self.rng.choice([1, 2, 2, 3, 4])
                    out.append(("the %d%s one" % (n, {1: "st", 2: "nd", 3: "rd"}.get(n, "th")), 0.5))
                if ctx.two:
                    out.append(("the other one", 0.8))
        if ctx.earlier == kind:
            out.append(("the earlier one", 0.6))
        if ctx.added == kind and not base:
            out.append(("the last thing I added", 0.6))
        return out

    def atom(self, kind, nmax, ctx, avoid=(), only=None):
        """One predicate atom over `kind`; nested sets at depth <= nmax."""
        ki = KINFO[kind]
        opts = []
        for f, info in ki["fields"].items():
            if f in avoid or (only and f != only):
                continue
            fw = 0.35 if f in HOUSE else (0.3 if f in NULL_ONLY else 1.0)
            for form in info["forms"]:
                if form.startswith("called"):
                    continue
                if form in ("= (Set)", "!= (Set)"):
                    t = info["target"]
                    if t is None:
                        continue
                    if nmax < 2 and not (nmax >= 1 and self.nested_refs(t, ctx, kind)):
                        continue
                w = fw
                if info["shape"] == "label" and form in ("= Lit", "contains Lit"):
                    w *= 0.25
                if form.startswith("!=") and form != "!= (Set)":
                    w *= 0.5
                if form in ("<= Date", ">= Date", "<= Num", ">= Num", "!= Num"):
                    w *= 0.4
                if form in ("= Lit", "!= Lit") and info["shape"] != "enum" and \
                        self.lit_for(kind, f, info, eq=True) is None:
                    continue
                if form == "contains Lit" and self.lit_for(kind, f, info) is None:
                    continue
                opts.append((("field", f, form), ["F:%s.%s" % (kind, f), "PF:" + form], w))
        for a, b in COUNT_WALKS:
            if a == kind and not only:
                opts.append((("countwalk", b, None), ["CW:%s/%s" % (a, b), "PF:count of"], 0.6))
        for a, b in MEMBER_OF:
            if a == kind and not only and (nmax >= 2 or (nmax >= 1 and self.nested_refs(b, ctx, kind))):
                opts.append((("member", b, None), ["M:%s/%s" % (a, b), "PF:member of"], 0.6))
        for (a, x, op, y) in FIELD_PAIRS:
            if a == kind and not only:
                opts.append((("pair", x, (op, y)), ["FF:%s.%s%s%s" % (a, x, op, y), "PF:Field Cmp Field"], 0.4))
        what, f, form = self.pick(opts)
        if what == "countwalk":
            op = self.rng.choice(["=", ">", ">=", "<", "="])
            n = self.rng.choice([0, 1, 2, 3, 5]) if op != "<" else self.rng.choice([1, 2, 3])
            return "count of %s %s %d" % (f, op, n), 0
        if what == "member":
            s = self.single_set(f, nmax, ctx, pctx="member", outer=kind)
            return "member of %s" % par(s), s.depth
        if what == "pair":
            return "%s %s %s" % (f, form[0], form[1]), 0
        info = ki["fields"][f]
        if form in ("is null", "is not null", "= true", "= false", "= me"):
            return "%s %s" % (f, form), 0
        if form in ("= (Set)", "!= (Set)"):
            s = self.single_set(info["target"], nmax, ctx, pctx="operand", outer=kind)
            return "%s %s (%s)" % (f, form.split()[0], s.text), s.depth
        if form == "during Window":
            w, dd = self.window(f, nmax=nmax)
            return "%s during %s" % (f, w), dd
        if form.endswith("Date"):
            past = f in self.PAST
            d = self.date(-60, 0) if past else self.date(-20, 60)
            if f == "birth_date":
                d = datetime.date(self.rng.randint(1950, 2005), self.rng.randint(1, 12), 1)
            v = d.isoformat() if self.rng.random() < 0.85 else "%sT%02d:00" % (d.isoformat(), self.rng.randint(8, 18))
            return "%s %s %s" % (f, form.split()[0], v), 0
        if form.endswith("Num"):
            return "%s %s %s" % (f, form.split()[0], self.num_for(f)), 0
        if form == "in (Lit, …)":
            vals = info["values"]
            k = min(len(vals), self.rng.choice([2, 2, 3]))
            return "%s in (%s)" % (f, ", ".join(q(v) for v in self.rng.sample(vals, k))), 0
        if form in ("= Lit", "!= Lit"):
            v = self.rng.choice(info["values"]) if info["shape"] == "enum" else \
                self.lit_for(kind, f, info, eq=True)
            return "%s %s %s" % (f, form.split()[0], q(v)), 0
        if form == "contains Lit":
            return "%s contains %s" % (f, q(self.lit_for(kind, f, info))), 0
        raise Fail("form " + form)

    NESTED_REFS = ("it", "that one", "the earlier one", "the last thing I added")

    def nested_refs(self, kind, ctx, outer=None):
        if kind == outer and ctx.held == kind:
            return []
        return [r for r, _ in self.ref_of(kind, ctx, single=True) if r in self.NESTED_REFS]

    def single_set(self, kind, nmax, ctx, pctx, outer=None):
        """A set naming ONE row: a singular ref, or `Kind called "X"`."""
        refs = self.nested_refs(kind, ctx, outer)
        if refs and (nmax < 2 or self.rng.random() < 0.45):
            r = self.rng.choice(refs)
            self.mark("E:%s>ref" % pctx, "R:" + r)
            return S(r, kind, 1, "ref", plural=False, single=True)
        if nmax < 2 or not KINFO[kind]["label"]:
            raise Fail("no single set of %s" % kind)
        return self.set_of(kind, 2, ctx, pctx=pctx, forms=("called",))

    def pred(self, kind, nmax, ctx):
        shape = self.pick([("one", ["PC:one"], 3.0), ("and", ["PC:and"], 1.4), ("or", ["PC:or"], 0.35),
                           ("not", ["PC:not"], 0.25), ("group", ["PC:group"], 0.12)])
        a, d = self.atom(kind, nmax, ctx)
        if shape == "one":
            return a, d
        if shape == "not":
            return "not (%s)" % a, d
        f1 = a.split()[0]
        b, d2 = self.atom(kind, nmax, ctx, avoid=(f1,))
        if shape in ("and", "or"):
            return "%s %s %s" % (a, shape, b), max(d, d2)
        c, d3 = self.atom(kind, nmax, ctx, avoid=(f1, b.split()[0]))
        return "(%s or %s) and %s" % (a, b, c), max(d, d2, d3)

    # -- sets at an exact depth ----------------------------------------------
    POSTFIX_BASE = ("kind", "called", "that", "during", "walk")

    def set_of(self, kind, d, ctx, pctx="show", single_ok=False, need_single=False,
               bounded=False, allow_things=False, forms=None, base_ref=False):
        """A Set of `kind` whose check.depth is exactly d. `forms` limits the
        outermost constructor ('kind' and 'ref' are the depth-1 forms)."""
        ki = KINFO.get(kind)
        if d <= 1:
            refs = self.ref_of(kind, ctx, single=need_single, base=base_ref) if kind != "things" else []
            opts = []
            if forms is None or "ref" in forms:
                for r, w in refs:
                    rk = "R:" + (r if r in L.REFS else "the Nth one")
                    opts.append((("ref", r), ["E:%s>ref" % pctx, rk], w * 2.0))
            if not need_single and not bounded and (forms is None or "kind" in forms):
                opts.append((("kind", kind), ["E:%s>kind" % pctx, "K:" + kind], 0.8))
            if not opts:
                raise Fail("no depth-1 set for %s" % kind)
            how, v = self.pick(opts)
            if how == "ref":
                sing = v != "them"
                return S(v, kind, 1, "ref", plural=not sing, single=sing, bounded=True)
            return S(kind, kind, 1, "kind", bounded=False)
        opts = []
        if kind == "things":
            opts = [("called", ["E:%s>called" % pctx], 1.0), ("during", ["E:%s>during" % pctx], 1.6)]
        else:
            if ki["label"] and d in (2, 3):
                opts.append(("called", ["E:%s>called" % pctx], 2.2 if d == 2 else 0.4))
            if not need_single:
                opts.append(("that", ["E:%s>that" % pctx], 2.4))
                if ki["salient"]:
                    opts.append(("during", ["E:%s>during" % pctx], 1.5))
                opts.append(("order", ["E:%s>order" % pctx], 0.6))
                if any(a == kind and (d > 2 or self.ref_of(b, ctx)) for (a, b) in LINKS):
                    opts.append(("walk", ["E:%s>walk" % pctx], 1.6))
                if ki["label"] and d >= 3:
                    opts.append(("union", ["E:%s>union" % pctx], 0.3))
                    opts.append(("except", ["E:%s>except" % pctx], 0.2))
            if d >= 3 or self.ref_of(kind, ctx, base=True):
                opts.append(("first", ["E:%s>first" % pctx], 0.8 if d >= 3 else 0.3))
        if forms:
            opts = [o for o in opts if o[0] in forms]
        form = self.pick(opts)
        self.mark("K:" + kind)
        if form == "called":
            if d == 2:
                b = S(kind, kind, 1, "kind")
            else:
                b = self.set_of(kind, 2, ctx, pctx="called", forms=("walk",))
            lit = self.label(kind)
            lit = self.short(lit) if kind not in ("parties", "members") else lit
            if ki and ki["label"]:
                self.mark("F:%s.%s" % (kind, ki["label"]))
            return S("%s called %s" % (base(b), q(lit)), kind, d, "post", plural=False, single=True,
                     bounded=True)
        if form == "that":
            b = None
            if d > 2 and self.rng.random() < 0.6:
                for _ in range(4):
                    bb = self.set_of(kind, 1, ctx, pctx="that", base_ref=True)
                    p, pd = self.pred(kind, d - 1, ctx)
                    if pd == d - 1:
                        b = bb
                        break
            if b is None:
                b = self.set_of(kind, d - 1, ctx, pctx="that", base_ref=True, forms=self.POSTFIX_BASE + ("ref",))
                p, pd = self.pred(kind, d - 1, ctx)
            if 1 + max(b.depth, pd) != d:
                raise Fail("that depth")
            return S("%s that (%s)" % (base(b), p), kind, d, "post", plural=True, bounded=True)
        if form == "during":
            b = self.set_of(kind, d - 1, ctx, pctx="during", base_ref=True, forms=self.POSTFIX_BASE + ("ref",))
            f = ki["salient"] if kind != "things" else "dtstart"
            if ki:
                self.mark("F:%s.%s" % (kind, f))
            w, wd = self.window(f, nmax=d - 1)
            if 1 + max(b.depth, wd) != d:
                raise Fail("during depth")
            if kind == "tasks" and self.rng.random() < 0.8:
                # C1: a due-window over tasks carries the open predicate — as one clause
                self.mark("Q:C1")
                return S("%s that (due_at during %s and status != \"completed\")" % (base(b), w),
                         kind, d, "post", bounded=True)
            return S("%s during %s" % (base(b), w), kind, d, "post", bounded=True)
        if form == "order":
            b = self.set_of(kind, d - 1, ctx, pctx="order", base_ref=True, forms=self.POSTFIX_BASE + ("ref",))
            f = self.order_field(kind)
            return S("%s ordered by %s %s" % (base(b), f, self.rng.choice(["asc", "desc"])), kind, d,
                     "post", ordered=True, bounded=b.bounded)
        if form == "walk":
            srcs = [(a2, ["L:%s<-%s" % (kind, a2)], 1.0 if (kind, a2) in EXEC_WALKS else 0.35)
                    for (k2, a2) in LINKS if k2 == kind
                    and (d > 2 or self.ref_of(a2, ctx))]
            if not srcs:
                raise Fail("no walk source")
            src = self.pick(srcs)
            if d == 2:
                s = self.set_of(src, 1, ctx, pctx="walk", forms=("ref",))
            else:
                s = self.set_of(src, d - 1, ctx, pctx="walk", forms=("called", "that", "during", "first"))
            if re.match(r"\(?%s (called|that)" % re.escape(kind), s.text):
                raise Fail("degenerate")
            return S("%s of %s" % (kind, par(s)), kind, d, "walk", bounded=s.bounded)
        if form == "first":
            n = self.pick([(1, ["N:first1"], 1.5), (2, ["N:first2"], 0.6), (3, ["N:first3"], 0.8),
                           (5, ["N:first5"], 0.5)])
            if need_single:
                n = 1
            if d == 2:
                inner = self.set_of(kind, 1, ctx, pctx="first", forms=("ref",), base_ref=True)
            else:
                inner = self.set_of(kind, d - 1, ctx, pctx="first", forms=("order",))
            return S("first %d of %s" % (n, par(inner)), kind, d, "first", plural=n > 1,
                     single=n == 1, bounded=True, two=n == 2, ordered=True)
        if form in ("union", "except"):
            l = self.set_of(kind, d - 1, ctx, pctx=form,
                            forms=("called",) if form == "union" else ("walk", "that", "during"))
            r = self.set_of(kind, 2, ctx, pctx=form, forms=("called",))
            if l.text == r.text:
                raise Fail("same operands")
            return S("%s %s %s" % (base(l), "and" if form == "union" else "except", base(r)), kind, d,
                     "union", bounded=l.bounded and r.bounded,
                     two=form == "union" and l.single and r.single)
        raise Fail(form)

    def order_field(self, kind):
        ki = KINFO[kind]
        cands = [f for f in ki["minmax"]] + ([ki["label"]] if ki["label"] in ki["fields"] else [])
        if kind in ("parties", "members"):
            cands.append("display_name")
        cands = sorted(set(cands))
        return self.pick([(f, ["F:%s.%s" % (kind, f), "O:%s.%s" % (kind, f)],
                           0.3 if f in HOUSE else 1.0) for f in cands])

    def kind_pick(self, kinds, extra=()):
        """Least-covered kind, where a kind with an uncovered field counts as
        less covered than its board count says."""
        opts = []
        for k in kinds:
            keys = ["K:" + k] + ["%s%s" % (e, k) for e in extra]
            opts.append((k, keys, KIND_W.get(k, 1)))
        best, score = None, None
        for k, keys, w in opts:
            m = min(self.c(x) for x in keys)
            fk = ["F:%s.%s" % (k, f) for f, i in KINFO[k]["fields"].items() if i["forms"]] if k in KINFO else []
            if fk:
                m = min(m, 40 * min(self.c(x) for x in fk))
            s = (m + self.rng.random() * 0.35 * (1 + m ** 0.5)) / w
            if score is None or s < score:
                best, score = k, s
        self.pending["K:" + best] += 1
        return best

    # -- values ---------------------------------------------------------------
    def value_turn(self, d, ctx, pctx="value", kinds=None):
        form = self.pick([("count", ["E:turn>count"], 2.0), ("sum", ["E:turn>sum"], 1.3),
                          ("min", ["E:turn>min"], 0.7), ("max", ["E:turn>max"], 0.8),
                          ("project", ["E:turn>project"], 1.3 if d >= 2 or ctx.held else 0),
                          ("balance", ["E:turn>balance"], 0.45 if d >= 2 else 0)])
        allk = kinds or [k for k in KINFO]
        if form == "count":
            k = self.kind_pick(allk)
            s = self.set_of(k, d, ctx, pctx="count")
            return "count of %s" % par(s), s
        if form in ("sum", "min", "max"):
            k, f = self.agg_pick(form, allk)
            s = self.set_of(k, d, ctx, pctx=form, forms=("kind", "ref", "that", "during", "walk", "first"))
            return "%s %s of %s" % (form, f, par(s)), s
        if form == "project":
            k = self.kind_pick([k for k in allk if KINFO[k]["label"] or self.ref_of(k, ctx)])
            f = self.proj_field(k)
            s = self.set_of(k, d, ctx, pctx="project", need_single=True)
            return "%s of %s" % (f, par(s)), s
        # balance of (member) in (group)
        g = self.set_of("groups", 2, ctx, pctx="balance.in", forms=("called",)) if d >= 2 else None
        if self.ref_of("members", ctx) and self.rng.random() < 0.6:
            m = self.set_of("members", 1, ctx, pctx="balance.of", need_single=True)
        else:
            m = self.set_of("members", 2, ctx, pctx="balance.of", forms=("called",))
        if self.ref_of("groups", ctx) and self.rng.random() < 0.5:
            g = self.set_of("groups", 1, ctx, pctx="balance.in", need_single=True)
        self.mark("K:members", "K:groups")
        return "balance of %s in %s" % (par(m), par(g)), m

    def agg_pick(self, form, kinds):
        opts = []
        for k in kinds:
            for f in (KINFO[k]["sum"] if form == "sum" else KINFO[k]["minmax"]):
                opts.append(((k, f), ["GK:%s:%s" % (form, k), "G:%s:%s.%s" % (form, k, f)],
                             KIND_W.get(k, 1) ** 0.5 * (0.3 if f in HOUSE else 1.0)))
        k, f = self.pick(opts)
        self.mark("F:%s.%s" % (k, f), "K:" + k)
        return k, f

    def proj_field(self, k):
        fs = [f for f, i in KINFO[k]["fields"].items()
              if f not in NULL_ONLY and i["shape"] not in ("sealed", "reflist") and i["forms"]]
        return self.pick([(f, ["F:%s.%s" % (k, f), "PJ:%s.%s" % (k, f)], 0.3 if f in HOUSE else 1.0) for f in fs])

    # -- commands -------------------------------------------------------------
    def cmd_options(self, anchor_kinds=None, creates=None):
        opts = []
        for cmd, (anchor, subsets) in CMDS.items():
            if creates is True and anchor is not None and cmd != "tally.settle_up":
                continue
            if creates is False and anchor is None:
                continue
            if anchor_kinds is not None:
                if anchor is None:
                    continue
                ak = [k for k in anchor_kinds if self.anchor_ok(cmd, k)]
                if not ak:
                    continue
            for sub in subsets:
                w = 1.0
                if cmd in ("people.undo_person", "tally.undo_expense", "schedule.restore_task",
                           "core.restore_document", "media.restore_asset"):
                    w = 0.15 if anchor_kinds is None else 0.3
                opts.append(((cmd, sub), ["C:%s|%s" % (cmd, ",".join(sub))], w))
        return opts

    @staticmethod
    def anchor_ok(cmd, kind):
        anchor = CMDS[cmd][0]
        if anchor == kind:
            return True
        return (cmd == "knowledge.delete_note" and kind == "journal notes") or \
               (cmd in ("people.log_interaction", "people.trash_person") and kind == "members")

    def verb_token(self, cmd, kind):
        classes = [c for (c, k), v in CLASS_OK.items() if v == cmd and k == kind]
        if not classes:
            self.mark("V:" + cmd)
            return cmd
        return self.pick([(cmd, ["V:" + cmd], 0.6)] + [(c, ["V:" + c], 1.0) for c in classes])

    def args(self, cmd, sub, ctx):
        out, dmax = [], 0
        for a in sub:
            self.mark("ARG:%s.%s" % (cmd, a))
            if a == "to":
                how = self.pick([("date", ["A:date"], 1.0), ("datetime", ["A:datetime"], 0.8),
                                 ("value", ["A:value"], 0.15)])
                if how == "date":
                    v = self.date(-3, 40).isoformat()
                elif how == "datetime":
                    v = self.dt(-3, 40)
                else:
                    v = "dtstart of (events called %s)" % q(self.label("events"))
                    dmax = max(dmax, 2)
            elif a == "by":
                v = self.dur(); self.mark("A:duration")
            elif a == "due_at":
                v = self.date(0, 40).isoformat() if self.rng.random() < 0.6 else self.dt(0, 40)
            elif a == "dtstart":
                v = self.dt(0, 40)
            elif a == "dtend":
                v = None
            elif a in ("title", "summary", "description"):
                v = q({"schedule.add_task": P.TASKS, "knowledge.create_note": P.NOTES,
                       "schedule.propose_event": P.EVENTS, "locker.add_item": P.LOCKER,
                       "tally.add_expense": P.EXPENSES}[cmd] and self.rng.choice(
                    {"schedule.add_task": P.TASKS, "knowledge.create_note": P.NOTES,
                     "schedule.propose_event": P.EVENTS, "locker.add_item": P.LOCKER,
                     "tally.add_expense": P.EXPENSES}[cmd]))
                self.mark("A:string")
            elif a == "status":
                v = q(self.rng.choice(["completed", "in-process", "needs-action", "cancelled"]))
            elif a == "type":
                v = q(self.rng.choice(["login", "wifi", "note", "card", "password", "membership"]))
            elif a == "content":
                v = q(self.rng.choice(P.SECRETS))
            elif a == "columns":
                v = q(self.rng.choice(["password", "username", "card_number", "otp_seed"]))
            elif a == "kind":
                v = q(self.rng.choice(["call", "visit", "message", "coffee"]))
            elif a == "category":
                v = q(self.rng.choice(["food", "groceries", "transport", "fun", "travel", "utilities",
                                       "shopping", "rent", "general"]))
            elif a == "amount_minor":
                if cmd == "tally.settle_up" and "from_party" not in sub:
                    v = None  # filled by caller (balance value)
                else:
                    v = str(self.amount()); self.mark("A:number")
            elif a in ("album_id", "group_id"):
                k = "albums" if a == "album_id" else "groups"
                if self.ref_of(k, ctx) and self.rng.random() < 0.4:
                    s = self.set_of(k, 1, ctx, pctx="arg", need_single=True)
                else:
                    s = self.set_of(k, 2, ctx, pctx="arg", forms=("called",))
                v = "(%s)" % s.text; dmax = max(dmax, s.depth); self.mark("A:setarg")
            elif a in ("paid_by", "from_party"):
                if self.rng.random() < 0.5:
                    v = "me"; self.mark("A:keyword")
                else:
                    s = self.set_of("members", 2, ctx, pctx="arg", forms=("called",))
                    v = "(%s)" % s.text; dmax = max(dmax, 2); self.mark("A:setarg")
            else:
                raise Fail("arg " + a)
            out.append([a, v])
        return out, dmax

    def fmt_cmd(self, verb, args, on=None):
        body = ", ".join("%s: %s" % (a, v) for a, v in args if v is not None)
        t = "%s{ %s }" % (verb, body) if body else "%s{}" % verb
        return t + (" on %s" % par(on) if on is not None else "")

    def command(self, d, ctx, anchor_kinds=None, creates=None, pick=None):
        """One Cmd. Returns (text, anchor S or None, cmd, depth)."""
        cmd, sub = pick or self.pick(self.cmd_options(anchor_kinds, creates))
        anchor = CMDS[cmd][0]
        args, adep = self.args(cmd, sub, ctx)
        if cmd == "schedule.propose_event" and "dtend" in sub:
            start = [v for a, v in args if a == "dtstart"][0]
            h = int(start[11:13]) + self.rng.choice([1, 1, 2])
            args = [[a, (start[:11] + "%02d:%s" % (min(h, 23), start[14:16]) if a == "dtend" else v)]
                    for a, v in args]
        if cmd == "tally.settle_up":
            if "from_party" in sub:
                self.mark("V:" + cmd)
                return self.fmt_cmd(cmd, args), None, cmd, adep
            g = [v for a, v in args if a == "group_id"][0]
            self.mark("A:value")
            args = [[a, ("balance of it in %s" % g if a == "amount_minor" else v)] for a, v in args]
            if d >= 3 and self.rng.random() < 0.5:
                on = S("members of %s" % g, "members", 3, "walk")
                self.mark("L:members<-groups")
            elif self.ref_of("members", ctx, single=True):
                on = self.set_of("members", 1, ctx, pctx="on", need_single=True)
            else:
                on = self.set_of("members", 2, ctx, pctx="on", forms=("called",))
            self.mark("V:" + cmd)
            return self.fmt_cmd(cmd, args, on), on, cmd, max(adep, on.depth)
        if anchor is None:
            self.mark("E:cmd>noon", "V:" + cmd)
            return self.fmt_cmd(cmd, args), None, cmd, adep
        kinds = [k for k in (anchor_kinds or [anchor, "journal notes", "members"]) if self.anchor_ok(cmd, k)]
        k = kinds[0] if len(kinds) == 1 else self.kind_pick(kinds)
        single = cmd in ("people.log_interaction", "people.trash_person", "tally.add_group_member",
                         "people.settle_debt", "media.add_to_album") and not (
            cmd == "media.add_to_album" and self.rng.random() < 0.4)
        destructive = "delete" in cmd or "trash" in cmd or "cancel" in cmd
        dd = max(1, d)
        if cmd == "people.settle_debt":
            if ctx.held == "obligations":
                on = self.set_of("obligations", 1, ctx, pctx="on")
            else:
                src = self.set_of("parties", 2, ctx, pctx="walk", forms=("called",))
                on = S("obligations of %s" % par(src), "obligations", 3, "walk")
                self.mark("L:obligations<-parties")
        elif single and cmd != "media.add_to_album":
            refs = self.ref_of(k, ctx, single=True)
            if dd == 1 and refs:
                on = self.set_of(k, 1, ctx, pctx="on", need_single=True)
            else:
                on = self.set_of(k, 2, ctx, pctx="on", forms=("called",))
        else:
            on = self.set_of(k, dd, ctx, pctx="on", bounded=True,
                             forms=("ref", "called", "that", "during", "walk", "first", "union"))
            if destructive and not on.bounded:
                raise Fail("unbounded")
        verb = self.verb_token(cmd, k)
        # the reschedule class only reads `by` on events
        if verb == "reschedule" and k == "tasks" and any(a == "by" for a, _ in args):
            raise Fail("by on tasks")
        return self.fmt_cmd(verb, args, on), on, cmd, max(adep, on.depth)

    # -----------------------------------------------------------------------
    # turn scenarios
    # -----------------------------------------------------------------------
    def depth_for(self, feasible):
        return self.pick([(d, ["D:%d" % min(d, 4)], DEPTH_SHARE[min(d, 4)]) for d in feasible], jitter=0.1)

    def fresh_prev(self, kinds=None, shape=None):
        """A set-producing first turn and the context it leaves."""
        shape = shape or self.pick([("list", ["PV:list"], 3.0), ("single", ["PV:single"], 1.6),
                                    ("value", ["PV:value"], 0.8), ("two", ["PV:two"], 0.5)])
        k = self.kind_pick(kinds or [k for k in KINFO])
        g2 = Gen(self.rng.random(), self.counts)          # prev literals never count as coverage
        g2.today = self.today
        if shape == "single" and KINFO[k]["label"]:
            s = g2.set_of(k, 2, NOCTX, forms=("called",))
            return "show " + s.text, Ctx(held=k, plural=False)
        if shape == "two" and KINFO[k]["label"]:
            a, b = g2.label(k), g2.label(k)
            if a == b:
                raise Fail("two")
            return 'show %s called %s and %s called %s' % (k, q(a), k, q(b)), Ctx(held=k, plural=True, two=True)
        d = g2.rng.choice([1, 2, 2, 2, 3])
        s = g2.set_of(k, d, NOCTX, allow_things=False)
        if shape == "value":
            return "count of %s" % par(s), Ctx(held=k, plural=True, value=True)
        if shape == "list" and s.single:
            raise Fail("single")
        return "show " + s.text, Ctx(held=k, plural=not s.single, ordered=s.ordered, two=s.two)

    def scenario(self, tt):
        """-> (prev, target, ctx, hint)"""
        m = getattr(self, "t_" + tt.replace(".", "_"))
        return m()

    # single-turn ------------------------------------------------------------
    def t_s_show(self):
        d = self.depth_for([1, 2, 3, 4])
        k = self.kind_pick(list(KINFO) + ["things"]) if d >= 2 else self.kind_pick(list(KINFO))
        if k == "things":
            return "NONE", "show " + self.set_of("things", 2, NOCTX).text, NOCTX, None
        s = self.set_of(k, d, NOCTX)
        return "NONE", "show " + s.text, NOCTX, None

    def t_s_value(self):
        d = self.depth_for([1, 2, 3])
        t, _ = self.value_turn(d, NOCTX)
        return "NONE", t, NOCTX, None

    def t_s_cmd(self):
        d = self.depth_for([2, 3])
        t, _, _, _ = self.command(d, NOCTX, creates=False)
        return "NONE", t, NOCTX, None

    def t_s_create(self):
        t, _, _, _ = self.command(0, NOCTX, creates=True)
        return "NONE", t, NOCTX, None

    def t_s_seq(self):
        """Cmd then Cmd (§1.2): one sentence, two writes whose order matters."""
        form = self.pick([("done+cancel", ["SEQ:done+cancel"], 1), ("move2", ["SEQ:move2"], 1),
                          ("restore+delete", ["SEQ:restore+delete"], 1), ("log+task", ["SEQ:log+task"], 1),
                          ("delete+create", ["SEQ:delete+create"], 0.7), ("expense+settle", ["SEQ:expense+settle"], 0.6),
                          ("add+member", ["SEQ:add+member"], 0.5)])
        self.mark("E:turn>seq", "TT:seq-form")
        r = self.rng
        if form == "done+cancel":
            t = r.choice(P.EVENTS)
            a = 'schedule.set_task_status{ status: "completed" } on (tasks called %s)' % q(t)
            b = '%s{} on (events called %s)' % (r.choice(["cancel", "schedule.cancel_event"]), q(t))
        elif form == "move2":
            k = r.choice(["tasks", "events"])
            x, y = r.sample(P.TASKS if k == "tasks" else P.EVENTS, 2)
            v = r.choice(["reschedule", "schedule.edit_task" if k == "tasks" else "schedule.reschedule_event"])
            a = '%s{ to: %s } on (%s called %s)' % (v, self.date(1, 20).isoformat(), k, q(x))
            b = '%s{ to: %s } on (%s called %s)' % (v, self.date(1, 20).isoformat(), k, q(y))
        elif form == "restore+delete":
            k = r.choice(["tasks", "documents", "photos"])
            x, y = self.label(k), self.label(k)
            if x == y:
                raise Fail("same")
            a = 'restore{} on (%s called %s)' % (k, q(x))
            b = '%s{} on (%s called %s)' % (self.verb_token(CLASS_OK[("delete", k)], k), k, q(y))
        elif form == "log+task":
            p = self.person()
            a = 'people.log_interaction{ kind: %s } on (parties called %s)' % (q(r.choice(["call", "visit", "message", "coffee"])), q(p))
            b = 'schedule.add_task{ title: %s, due_at: %s }' % (q(r.choice(P.TASKS)), self.date(1, 14).isoformat())
        elif form == "delete+create":
            a = 'delete{} on (notes called %s)' % q(r.choice(P.NOTES))
            b = 'knowledge.create_note{ title: %s }' % q(r.choice(P.NOTES))
        elif form == "expense+settle":
            g = r.choice(P.GROUPS)
            a = 'tally.add_expense{ amount_minor: %d, description: %s, group_id: (groups called %s) }' % (
                self.amount(), q(r.choice(P.EXPENSES)), q(g))
            b = 'tally.settle_up{ amount_minor: %d, from_party: me, group_id: (groups called %s) }' % (self.amount(), q(g))
        else:
            g = r.choice(P.GROUPS)
            p = self.person(True)
            a = 'tally.add_group_member{ group_id: (groups called %s) } on (parties called %s)' % (q(g), q(p))
            b = 'tally.add_expense{ amount_minor: %d, description: %s, group_id: (groups called %s), paid_by: (members called %s) }' % (
                self.amount(), q(r.choice(P.EXPENSES)), q(g), q(p))
        if a == b:
            raise Fail("seq same")
        return "NONE", "%s then %s" % (a, b), NOCTX, None

    def same_pair(self, ctx):
        opts = []
        for (a, b) in sorted(LINKS):
            if KINFO[b]["label"]:
                opts.append(((a, b), ["SQ:%s/%s" % (a, b)], 0.5 if (a, b) in EXEC_WALKS else 0.12))
        for k in ("parties", "members", "photos", "events", "tasks", "documents", "notes"):
            if k in ("parties", "members") or (ctx.held == k and self.ref_of(k, ctx, single=True)):
                opts.append(((k, None), ["SQ:%s/same" % k], 1.5))
        a, b = self.pick(opts)
        if b is None:
            if a in ("parties", "members"):
                f, l2 = self.rng.choice(P.FIRST), self.rng.choice(P.LAST)
                other = self.rng.choice(["parties", "members"])
                l = S('%s called "%s"' % (a, f if self.rng.random() < 0.5 else f + " " + l2), a, 2, "post")
                r = S('%s called "%s %s"' % (other, f, l2), other, 2, "post")
                self.mark("E:same>called", "K:" + other)
            else:
                l = self.set_of(a, 2, ctx, pctx="same", forms=("called",))
                r = None
            if ctx.held == a and self.ref_of(a, ctx, single=True):
                r = self.set_of(a, 1, ctx, pctx="same", need_single=True)
            elif r is None:
                lab = re.search(r'"([^"]*)"', l.text).group(1)
                words = lab.split()
                r = S('%s called "%s"' % (a, " ".join(words[:max(1, len(words) - 1)]) if len(words) > 1 else self.label(a)), a, 2, "post")
        else:
            if ctx.held == b and self.ref_of(b, ctx, single=True):
                src = self.set_of(b, 1, ctx, pctx="walk", need_single=True)
            else:
                src = self.set_of(b, 2, ctx, pctx="walk", forms=("called",))
            l = S("%s of %s" % (a, par(src)), a, 1 + src.depth, "walk")
            self.mark("L:%s<-%s" % (a, b))
            r = self.set_of(a, 2, ctx, pctx="same", forms=("called",))
        if l.text == r.text:
            raise Fail("same same")
        self.mark("E:turn>same")
        return "same? %s %s" % (par(l), par(r))

    def t_s_same(self):
        return "NONE", self.same_pair(NOCTX), NOCTX, None

    def t_s_refuse(self):
        reason = self.pick([(r, ["X:" + r], 1.0) for r in sorted(L.DECLINE_REASONS)])
        scene = self.rng.choice(P.REFUSE_SCENES[reason]).format(
            place=self.rng.choice(P.PLACES), person=self.person(), locker=self.rng.choice(P.LOCKER))
        return "NONE", "refuse: " + reason, NOCTX, "The member asks the assistant to %s." % scene

    def t_s_clarify(self):
        self.mark("Q:clarify-noref")
        act = self.rng.choice(["delete it", "move it to Friday", "how much was that one", "star that one",
                               "send them the reminder", "put it back", "what time is it on",
                               "mark them done", "add it to the album", "who was at that"])
        return "NONE", "clarify: out_of_ontology", NOCTX, (
            "Conversation start. The member uses a pronoun with nothing earlier to point at "
            "(e.g. '%s'), so the assistant cannot tell what they mean." % act)

    def t_s_nothing(self):
        return "NONE", "nothing", NOCTX, "The member starts to ask for something and immediately withdraws it (never mind / forget it / scratch that)."

    def t_s_overdue(self):
        self.mark("Q:overdue")
        core = 'tasks that (due_at during before now and status != "completed")'
        form = self.pick([("show", ["QO:show"], 2), ("count", ["QO:count"], 1), ("proj", ["QO:project"], 0.5),
                          ("order", ["QO:order"], 0.5), ("inproject", ["QO:inproject"], 1),
                          ("prio", ["QO:prio"], 0.6), ("effort", ["QO:effort"], 0.5)])
        if form == "inproject":
            return "NONE", 'show tasks that (due_at during before now and status != "completed" and project_id = (projects called %s))' % q(
                self.label("projects")), NOCTX, None
        if form == "prio":
            return "NONE", 'show tasks that (due_at during before now and status != "completed" and priority = %d)' % self.rng.choice([1, 2]), NOCTX, None
        if form == "effort":
            return "NONE", "sum effort_min of (%s)" % core, NOCTX, None
        if form == "show":
            return "NONE", "show " + core, NOCTX, None
        if form == "count":
            return "NONE", "count of (%s)" % core, NOCTX, None
        if form == "order":
            return "NONE", "show %s ordered by due_at asc" % core, NOCTX, None
        return "NONE", "min due_at of (%s)" % core, NOCTX, None

    def t_s_open(self):
        self.mark("Q:open")
        w, _ = self.window("due_at")
        form = self.pick([("plain", ["QP:plain"], 1), ("window", ["QP:window"], 2), ("project", ["QP:project"], 1),
                          ("count", ["QP:count"], 1)])
        if form == "plain":
            return "NONE", 'show tasks that (status != "completed")', NOCTX, None
        if form == "window":
            return "NONE", 'show tasks that (due_at during %s and status != "completed")' % w, NOCTX, None
        if form == "project":
            return "NONE", 'show tasks that (project_id = (projects called %s) and status != "completed")' % q(
                self.label("projects")), NOCTX, None
        return "NONE", 'count of (tasks that (due_at during %s and status != "completed"))' % w, NOCTX, None

    def t_s_owe(self):
        self.mark("Q:owe")
        p = self.person()
        form = self.pick([("iowe", ["QW:iowe"], 1), ("oweme", ["QW:oweme"], 1), ("withx", ["QW:withx"], 1.2),
                          ("total", ["QW:total"], 0.8), ("who", ["QW:who"], 0.6)])
        if form == "iowe":
            return "NONE", "show obligations that (from_party = me and settled_at is null)", NOCTX, None
        if form == "oweme":
            return "NONE", "show obligations that (to_party = me and settled_at is null)", NOCTX, None
        if form == "withx":
            return "NONE", "show obligations of (parties called %s)" % q(p), NOCTX, None
        if form == "total":
            side = self.rng.choice(["from_party", "to_party"])
            return "NONE", "sum amount_minor of (obligations that (%s = me and settled_at is null))" % side, NOCTX, None
        return "NONE", "show parties of (obligations that (from_party = me and settled_at is null))", NOCTX, None

    def t_s_lastcontact(self):
        self.mark("Q:lastcontact")
        return "NONE", "show first 1 of (activities of (parties called %s) ordered by started_at desc)" % q(
            self.person()), NOCTX, None

    def t_s_find(self):
        self.mark("Q:find")
        return "NONE", "show parties called %s" % q(self.person()), NOCTX, None

    def t_s_whatson(self):
        self.mark("Q:whatson")
        w = self.rng.choice([self.date(-2, 12).isoformat(), "today", "tomorrow", "this weekend",
                             self.date(0, 7).isoformat()])
        return "NONE", "show things during %s" % w, NOCTX, None

    def t_s_dates(self):
        """Birthdays and anniversaries: `important dates` by their derived next occurrence."""
        self.mark("Q:dates", "K:important dates")
        w, _ = self.window("next_occurrence")
        lab = self.rng.choice(["birthday", "anniversary", "name day", "graduation"])
        form = self.pick([("win", ["QD:win"], 1), ("label", ["QD:label"], 1), ("person", ["QD:person"], 1),
                          ("count", ["QD:count"], 0.5)])
        if form == "win":
            return "NONE", "show important dates during %s" % w, NOCTX, None
        if form == "label":
            self.mark("F:important dates.label", "F:important dates.next_occurrence")
            return "NONE", 'show important dates that (label contains %s and next_occurrence during %s)' % (q(lab), w), NOCTX, None
        if form == "count":
            return "NONE", 'count of (important dates that (label = %s and next_occurrence during %s))' % (q(lab), w), NOCTX, None
        self.mark("L:important dates<-parties")
        return "NONE", "show important dates of (parties called %s)" % q(self.person()), NOCTX, None

    def t_s_linkpred(self):
        """The two link-typed predicate atoms: `member of Set` and `count of Kind Cmp N`."""
        opts = [(("m", a, b), ["M:%s/%s" % (a, b)], 1.0) for (a, b) in MEMBER_OF if KINFO[b]["label"]]
        opts += [(("c", a, b), ["CW:%s/%s" % (a, b)], 1.0) for (a, b) in COUNT_WALKS]
        how, a, b = self.pick(opts)
        if how == "m":
            src = self.set_of(b, 2, NOCTX, pctx="member", forms=("called",))
            self.mark("PF:member of", "E:show>that")
            return "NONE", "show %s that (member of (%s))" % (a, src.text), NOCTX, None
        op = self.rng.choice(["=", ">", ">=", "<", "="])
        n = self.rng.choice([0, 1, 2, 3, 5]) if op != "<" else self.rng.choice([1, 2, 3])
        self.mark("PF:count of", "E:show>that")
        head = self.rng.choice(["show %s", "show %s", "count of (%s)"])
        return "NONE", head % ("%s that (count of %s %s %d)" % (a, b, op, n)), NOCTX, None

    def t_s_anchored(self):
        ev = self.label("events")
        k = self.kind_pick(["photos", "expenses", "activities", "tasks", "notes", "things"])
        w = "from (dtstart of (events called %s)) to (%s of (events called %s))" % (
            q(ev), self.rng.choice(["dtend", "dtstart"]), q(self.rng.choice([ev, self.label("events")])))
        self.mark("W:anchored", "E:show>during")
        return "NONE", "show %s during %s" % (k, w), NOCTX, None

    # multi-turn -------------------------------------------------------------
    def t_m_refine(self):
        prev, ctx = self.fresh_prev(shape=self.rng.choice(["list", "list", "value"]))
        if not ctx.plural:
            raise Fail("refine single")
        d = self.depth_for([2, 3])
        if prev.startswith("show ") and "{" not in prev and " and " not in prev and \
                " except " not in prev and "first " not in prev and "ordered by" not in prev and \
                self.rng.random() < 0.25:
            # the REWRITE form of a refinement: the previous Set plus one clause
            p, _ = self.pred(ctx.held, 1, NOCTX)
            self.mark("MT:refine-rewrite")
            return prev, "%s that (%s)" % (prev, p), NOCTX, None
        s = self.set_of(ctx.held, d, ctx, pctx="refine", forms=("that",))
        if not s.text.startswith("them"):
            raise Fail("refine base")
        self.mark("MT:refine")
        return prev, "show " + s.text, ctx, None

    def t_m_window(self):
        prev, ctx = self.fresh_prev(kinds=[k for k in KINFO if KINFO[k]["salient"]], shape="list")
        if not ctx.plural:
            raise Fail("single")
        s = self.set_of(ctx.held, 2, ctx, pctx="refine", forms=("during",))
        if not s.text.startswith("them"):
            raise Fail("window base")
        self.mark("MT:window")
        return prev, "show " + s.text, ctx, None

    def t_m_sort(self):
        prev, ctx = self.fresh_prev(shape="list")
        if not ctx.plural:
            raise Fail("single")
        k = ctx.held
        f = self.order_field(k)
        dr = self.rng.choice(["asc", "desc"])
        form = self.pick([("order", ["MS:order"], 1.6), ("first", ["MS:first"], 0.7)])
        self.mark("MT:sort", "E:refine>order")
        if form == "order":
            return prev, "show them ordered by %s %s" % (f, dr), ctx, None
        n = self.rng.choice([1, 1, 3, 5])
        self.mark("E:refine>first")
        return prev, "show first %d of (them ordered by %s %s)" % (n, f, dr), ctx, None

    def t_m_walk(self):
        a, k0 = self.pick([((a, b), ["L:%s<-%s" % (a, b)], 1.0 if (a, b) in EXEC_WALKS else 0.4)
                           for (a, b) in sorted(LINKS)])
        prev, ctx = self.fresh_prev(kinds=[k0], shape=self.rng.choice(["list", "single", "single"]))
        if ctx.held != k0:
            raise Fail("walk prev")
        d = self.depth_for([2, 3])
        src = self.set_of(k0, 1, ctx, pctx="walk", forms=("ref",))
        t = "%s of %s" % (a, src.text)
        if d == 3:
            what = self.pick([("that", ["E:walkref>that"], 1), ("during", ["E:walkref>during"], 1 if KINFO[a]["salient"] else 0),
                              ("order", ["E:walkref>order"], 0.5)])
            if what == "that":
                p, _ = self.pred(a, 1, NOCTX)
                t += " that (%s)" % p
            elif what == "during":
                w, _ = self.window(KINFO[a]["salient"])
                t += " during %s" % w
            else:
                t += " ordered by %s %s" % (self.order_field(a), self.rng.choice(["asc", "desc"]))
        self.mark("MT:walk")
        return prev, "show " + t, ctx, None

    def t_m_agg(self):
        prev, ctx = self.fresh_prev(shape=self.rng.choice(["list", "list", "two"]))
        d = self.depth_for([1, 2])
        k = ctx.held
        opts = [("count", ["MA:count"], 1.2)]
        if KINFO[k]["sum"]:
            opts.append(("sum", ["MA:sum"], 1.2))
        if KINFO[k]["minmax"]:
            opts += [("min", ["MA:min"], 0.6), ("max", ["MA:max"], 0.6)]
        form = self.pick(opts)
        s = self.set_of(k, d, ctx, pctx=form, forms=("that", "during", "ref"), base_ref=d > 1)
        if not re.match(r"(them|it|the )", s.text):
            raise Fail("agg base")
        self.mark("MT:agg")
        if form == "count":
            return prev, "count of %s" % par(s), ctx, None
        fields = KINFO[k]["sum"] if form == "sum" else KINFO[k]["minmax"]
        f = self.pick([(f, ["GK:%s:%s" % (form, k), "G:%s:%s.%s" % (form, k, f), "F:%s.%s" % (k, f)], 0.3 if f in HOUSE else 1) for f in fields])
        return prev, "%s %s of %s" % (form, f, par(s)), ctx, None

    def t_m_bareagg(self):
        k = self.kind_pick(["expenses", "obligations", "transactions", "settlements"])
        g2 = Gen(self.rng.random(), self.counts); g2.today = self.today
        if k == "obligations":
            prev = self.rng.choice(["show obligations of (parties called %s)" % q(self.person()),
                                    "show obligations that (%s = me and settled_at is null)" % self.rng.choice(["from_party", "to_party"])])
        elif k == "expenses" and self.rng.random() < 0.5:
            prev = "show expenses of (groups called %s)" % q(self.rng.choice(P.GROUPS))
        else:
            w, _ = g2.window(KINFO[k]["salient"])
            prev = "show %s during %s" % (k, w)
        ctx = Ctx(held=k, plural=True)
        self.mark("MT:bareagg", "G:sum:%s.amount_minor" % k, "E:sum>ref", "R:them")
        return prev, "sum amount_minor of them", ctx, "The follow-up is a bare fragment asking the total, e.g. 'how much?' / 'total?' / 'and in money?'"

    def t_m_project(self):
        prev, ctx = self.fresh_prev(shape=self.rng.choice(["single", "single", "list", "two"]))
        k = ctx.held
        f = self.proj_field(k)
        s = self.set_of(k, 1, ctx, pctx="project", need_single=True)
        self.mark("MT:project")
        return prev, "%s of %s" % (f, s.text), ctx, None

    WRITE_KINDS = ["tasks", "events", "notes", "documents", "photos", "parties", "expenses",
                   "locker items", "obligations", "members", "journal notes"]

    def t_m_write(self):
        prev, ctx = self.fresh_prev(kinds=self.WRITE_KINDS)
        d = self.depth_for([1, 2])
        t, on, cmd, _ = self.command(d, ctx, anchor_kinds=[ctx.held])
        if on is None or not re.match(r"\(?(them|it|that one|the )", on.text):
            raise Fail("write base")
        self.mark("MT:write")
        return prev, t, ctx, None

    def t_m_undo(self):
        k = self.kind_pick(["tasks", "documents", "photos", "expenses", "parties"])
        g2 = Gen(self.rng.random(), self.counts); g2.today = self.today
        s = g2.set_of(k, 2, NOCTX, forms=("called",))
        verb = {"tasks": "delete", "documents": "core.trash_document", "photos": "media.delete_asset",
                "expenses": "tally.delete_expense", "parties": "people.trash_person"}[k]
        if self.rng.random() < 0.6 and k != "parties":
            verb = "delete"
        prev = "%s{} on (%s)" % (verb, s.text)
        ctx = Ctx(held=k, plural=False, written=k)
        undo = {"tasks": ["restore", "schedule.restore_task"], "documents": ["restore", "core.restore_document"],
                "photos": ["restore", "media.restore_asset"], "expenses": ["tally.undo_expense"],
                "parties": ["people.undo_person"]}[k]
        v = self.pick([(u, ["V:" + u, "C:%s|" % (CLASS_OK.get((u, k), u))], 1.0) for u in undo])
        self.mark("MT:undo", "R:it", "E:on>ref")
        return prev, "%s{} on it" % v, ctx, "The follow-up takes the previous write back ('undo that', 'put it back', 'oops, restore it')."

    def t_m_nothing(self):
        if self.rng.random() < 0.5:
            prev, ctx = self.fresh_prev()
        else:
            g2 = Gen(self.rng.random(), self.counts); g2.today = self.today
            prev, _, _, _ = g2.command(2, NOCTX)
            ctx = NOCTX
        self.mark("MT:nothing")
        return prev, "nothing", ctx, "The follow-up withdraws: the member says never mind / leave it / actually don't."

    def t_m_substitute(self):
        k = self.kind_pick([k for k in KINFO if KINFO[k]["label"]])
        g2 = Gen(self.rng.random(), self.counts); g2.today = self.today
        d = self.depth_for([2, 3])
        s = self.set_of(k, d, NOCTX, pctx="show", forms=("called", "during", "walk"))
        target = "show " + s.text
        prev = target
        lits = re.findall(r'"[^"]*"', target)
        wins = re.findall(r"during ([a-z ]+?|\d{4}-\d\d-\d\d)(?=\)| and|$| ordered)", target)
        if lits:
            old = lits[0]
            new = q(g2.label(k))
            if new == old:
                raise Fail("sub")
            prev = target.replace(old, new, 1)
        elif wins:
            w2, _ = g2.window(KINFO[k]["salient"] or "dtstart")
            if w2 == wins[0]:
                raise Fail("sub")
            prev = target.replace("during " + wins[0], "during " + w2, 1)
        else:
            raise Fail("nothing to substitute")
        if "{" in prev:
            raise Fail("sub")
        self.mark("MT:substitute")
        return prev, target, Ctx(held=k), "The follow-up keeps the previous question's shape and swaps one name/date ('and for X?', 'what about next week?')."

    def t_m_widen(self):
        k = self.kind_pick([k for k in KINFO if KINFO[k]["salient"]])
        d = self.depth_for([1, 2])
        target = "show " + self.set_of(k, d, NOCTX, forms=("that", "kind")).text
        w, _ = self.window(KINFO[k]["salient"])
        prev = "%s during %s" % (target, w)
        self.mark("MT:widen")
        return prev, target, Ctx(held=k), "The follow-up widens the previous question by dropping its time limit ('any time, not just then' / 'what about all of them?')."

    def t_m_other(self):
        prev, ctx = self.fresh_prev(shape="two")
        k = ctx.held
        form = self.pick([("show", ["MO:show"], 1), ("proj", ["MO:proj"], 1), ("cmd", ["MO:cmd"], 1)])
        self.mark("MT:other", "R:the other one")
        if form == "show":
            return prev, "show the other one", ctx, None
        if form == "proj":
            return prev, "%s of the other one" % self.proj_field(k), ctx, None
        opts = [o for o in self.cmd_options(anchor_kinds=[k]) if o[0][0] not in ("people.settle_debt",)]
        if not opts:
            raise Fail("no cmd")
        cmd, sub = self.pick(opts)
        args, _ = self.args(cmd, sub, ctx)
        return prev, self.fmt_cmd(self.verb_token(cmd, k), args, S("the other one", k, 1, "ref")), ctx, None

    def t_m_earlier(self):
        k0 = self.kind_pick(sorted({b for (a, b) in LINKS if KINFO[b]["label"]}))
        a = self.pick([(a, ["L:%s<-%s" % (a, k0)], 1.0 if (a, k0) in EXEC_WALKS else 0.4)
                       for (a, b) in LINKS if b == k0])
        prev = "show %s of it" % a
        ctx = Ctx(held=a, plural=True, earlier=k0)
        form = self.pick([("show", ["ME:show"], 1), ("count", ["ME:count"], 0.6), ("walk", ["ME:walk"], 1),
                          ("cmd", ["ME:cmd"], 0.6), ("except", ["ME:except"], 0.6)])
        self.mark("MT:earlier", "R:the earlier one")
        if form == "show":
            return prev, "show the earlier one", ctx, None
        if form == "count":
            return prev, "count of the earlier one", ctx, None
        if form == "except":
            return prev, "show %s of the earlier one except them" % a, ctx, None
        if form == "walk":
            others = [(b2, ["L:%s<-%s" % (b2, k0)], 1.0) for (b2, b) in LINKS if b == k0 and b2 != a]
            if not others:
                raise Fail("earlier")
            return prev, "show %s of the earlier one" % self.pick(others), ctx, None
        opts = self.cmd_options(anchor_kinds=[k0])
        if not opts:
            raise Fail("no cmd")
        cmd, sub = self.pick(opts)
        args, _ = self.args(cmd, sub, ctx)
        return prev, self.fmt_cmd(self.verb_token(cmd, k0), args, S("the earlier one", k0, 1, "ref")), ctx, None

    def t_m_lastadded(self):
        g2 = Gen(self.rng.random(), self.counts); g2.today = self.today
        cmd = self.rng.choice(["schedule.add_task", "knowledge.create_note", "schedule.propose_event",
                               "tally.add_expense", "locker.add_item"])
        prev, _, _, _ = g2.command(0, NOCTX, pick=(cmd, CMDS[cmd][1][0]))
        k = {"schedule.add_task": "tasks", "knowledge.create_note": "notes", "schedule.propose_event": "events",
             "tally.add_expense": "expenses", "locker.add_item": "locker items"}[cmd]
        ctx = Ctx(added=k, written=k)
        form = self.pick([("cmd", ["ML:cmd"], 2), ("show", ["ML:show"], 0.4), ("proj", ["ML:proj"], 0.6)])
        self.mark("MT:lastadded", "R:the last thing I added")
        if form == "show":
            return prev, "show the last thing I added", ctx, None
        if form == "proj":
            return prev, "%s of the last thing I added" % self.proj_field(k), ctx, None
        opts = self.cmd_options(anchor_kinds=[k])
        cmd2, sub = self.pick(opts)
        args, _ = self.args(cmd2, sub, ctx)
        return prev, self.fmt_cmd(self.verb_token(cmd2, k), args, S("the last thing I added", k, 1, "ref")), ctx, None

    def t_m_same(self):
        prev, ctx = self.fresh_prev(kinds=["parties", "members", "photos", "events", "tasks"], shape="single")
        t = self.same_pair(ctx)
        self.mark("MT:same")
        return prev, t, ctx, None

    def t_m_clarify(self):
        f = self.rng.choice(P.FIRST)
        l1, l2 = self.rng.sample(P.LAST, 2)
        k = self.rng.choice(["parties", "parties", "members"])
        prev = 'show %s called "%s %s" and %s called "%s %s"' % (k, f, l1, k, f, l2)
        act = self.rng.choice(["log a call with %s", "text %s", "delete %s", "settle up with %s",
                               "when did I last see %s", "add %s to the group", "what's %s's number"]) % f
        self.mark("MT:clarify", "Q:clarify-ambiguous")
        return prev, "clarify: out_of_ontology", Ctx(held=k, plural=True, two=True), (
            "The previous answer listed two different people who share the first name %s; the member now says "
            "'%s' using only the first name, so it is ambiguous which one." % (f, act))

    def t_m_c14(self):
        p = self.person(True)
        g2 = Gen(self.rng.random(), self.counts); g2.today = self.today
        prev = self.rng.choice([
            "owed_to_them of (parties called %s)" % q(p),
            "count of (events of (parties called %s) during this month)" % q(p),
            "sum amount_minor of (obligations of (parties called %s))" % q(p),
            "count of (activities of (parties called %s))" % q(p)])
        on = S("parties called %s" % q(p), "parties", 2, "post")
        cmd = self.pick([(c, ["C14:" + c], 1) for c in ("people.log_interaction", "tally.add_group_member",
                                                        "people.trash_person")] + [("show", ["C14:show"], 1)])
        self.mark("MT:c14", "Q:c14")
        hint = ("The previous turn named %s and got back only a number; the member now refers to them with a "
                "pronoun (him/her/them), which the canonical resolves to the name." % p)
        if cmd == "show":
            return prev, "show %s of (parties called %s)" % (self.rng.choice(["events", "contact channels", "important dates"]), q(p)), NOCTX, hint
        args, _ = self.args(cmd, CMDS[cmd][1][-1], NOCTX)
        return prev, self.fmt_cmd(cmd if cmd != "people.trash_person" else self.verb_token(cmd, "parties"),
                                  args, on), NOCTX, hint

    def t_m_seq(self):
        prev, ctx = self.fresh_prev(kinds=["tasks", "events", "documents", "photos", "expenses"], shape="two")
        k = ctx.held
        opts = self.cmd_options(anchor_kinds=[k])
        c1, s1 = self.pick(opts)
        c2, s2 = self.pick(opts)
        a1, _ = self.args(c1, s1, ctx)
        a2, _ = self.args(c2, s2, ctx)
        r1 = self.rng.choice(["the 1st one", "it", "the 2nd one"])
        r2 = "the other one" if r1 != "the 2nd one" else "the 1st one"
        if r1 == "it":
            r1 = "the 1st one"
        t = "%s then %s" % (self.fmt_cmd(self.verb_token(c1, k), a1, S(r1, k, 1, "ref")),
                            self.fmt_cmd(self.verb_token(c2, k), a2, S(r2, k, 1, "ref")))
        self.mark("MT:seq", "E:turn>seq", "R:the Nth one", "R:" + r2 if r2 in L.REFS else "R:the Nth one")
        return prev, t, ctx, None

    def t_m_new(self):
        prev, ctx = self.fresh_prev()
        d = self.depth_for([1, 2, 3])
        k = self.kind_pick([k for k in KINFO if k != ctx.held])
        self.mark("MT:new")
        if self.rng.random() < 0.6:
            return prev, "show " + self.set_of(k, d, NOCTX).text, NOCTX, "The follow-up changes topic completely."
        t, _ = self.value_turn(max(d, 1), NOCTX)
        return prev, t, NOCTX, "The follow-up changes topic completely."

    def t_m_lastcontact(self):
        prev, ctx = self.fresh_prev(kinds=["parties"], shape="single")
        self.mark("MT:lastcontact", "Q:lastcontact", "R:it")
        return prev, "show first 1 of (activities of it ordered by started_at desc)", ctx, None

    def t_gap(self):
        """Gap-fill: one row aimed at a single zero-count key of the universe."""
        key = self.gap_key
        fam, _, rest = key.partition(":")
        if fam == "F":
            k, f = rest.split(".", 1)
            forms = [x for x in KINFO[k]["fields"][f]["forms"] if not x.startswith("called")]
            if not forms or any(x in ("= (Set)", "!= (Set)") for x in forms) and len(forms) <= 3:
                if f in KINFO[k]["minmax"]:
                    return "NONE", "show %s ordered by %s %s" % (k, f, self.rng.choice(["asc", "desc"])), NOCTX, None
            a, dd = self.atom(k, 2, NOCTX, only=f)
            self.mark(key)
            return "NONE", "show %s that (%s)" % (k, a), NOCTX, None
        if fam == "L":
            a, b = rest.split("<-")
            prev, ctx = self.fresh_prev(kinds=[b], shape="list")
            self.mark(key)
            return prev, "show %s of them" % a if ctx.plural else "show %s of it" % a, ctx, None
        if fam == "GK":
            agg, k = rest.split(":")
            f = self.rng.choice(KINFO[k]["sum"] if agg == "sum" else KINFO[k]["minmax"])
            self.mark(key, "G:%s:%s.%s" % (agg, k, f))
            return "NONE", "%s %s of %s" % (agg, f, k), NOCTX, None
        raise Fail("gap " + key)

    def t_m_overdue(self):
        prev = 'show tasks that (due_at during before now and status != "completed")'
        ctx = Ctx(held="tasks", plural=True)
        self.mark("MT:overdue", "Q:overdue")
        form = self.pick([("move", ["MOV:move"], 1), ("count", ["MOV:count"], 1), ("status", ["MOV:status"], 0.6),
                          ("oldest", ["MOV:oldest"], 0.6)])
        if form == "move":
            to = self.date(1, 10).isoformat()
            return prev, "%s{ to: %s } on them" % (self.rng.choice(["reschedule", "schedule.edit_task"]), to), ctx, None
        if form == "count":
            return prev, "count of them", ctx, None
        if form == "status":
            return prev, 'schedule.set_task_status{ status: "completed" } on %s' % self.rng.choice(
                ["the 1st one", "the 2nd one", "them"]), ctx, None
        return prev, "show first 1 of (them ordered by due_at asc)", ctx, None


FIELD_PAIRS = [("tasks", "completed_at", ">", "due_at"), ("locker items", "password_set_at", "=", "created_at"),
               ("locker items", "password_set_at", "<", "created_at"), ("notes", "updated_at", ">", "created_at"),
               ("documents", "updated_at", ">", "created_at"), ("activities", "ended_at", ">", "started_at"),
               ("expenses", "original_amount_minor", ">", "amount_minor"), ("events", "dtend", "<", "dtstart")]


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------
DEGEN = re.compile(r"(?:^|[ (])((?:[a-z]+ )?[a-z]+) of \(\1 (?:called|that)\b")


def base_kind(node, ctx):
    n = node.get("node")
    if n == "kind":
        return node["kind"]
    if n == "walk":
        return node["kind"]["kind"]
    if n in ("called", "filter", "during", "order", "first"):
        return base_kind(node["set"], ctx)
    if n in ("union", "except"):
        return base_kind(node["left"], ctx)
    if n == "ref":
        r = node["ref"]
        if r == "the earlier one":
            return ctx.get("earlier")
        if r == "the last thing I added":
            return ctx.get("added")
        return ctx.get("held") or ctx.get("written") or ctx.get("added")
    return None


def arms_ok(tree, ctx):
    steps = [tree] if tree["node"] == "cmd" else tree.get("steps", []) if tree["node"] == "seq" else []
    for c in steps:
        verb, args = c["verb"], set(c["args"])
        kind = base_kind(c["on"], ctx) if c["on"] else None
        if c["is_class"]:
            cmd = CLASS_OK.get((verb, kind))
        else:
            cmd = verb
        if cmd not in ARMS:
            return "not an arm: %s on %s" % (verb, kind)
        if not args <= set(ARMS[cmd]):
            return "args %s not read by %s" % (sorted(args - set(ARMS[cmd])), cmd)
        if not REQUIRED.get(cmd, set()) <= args:
            return "missing %s" % (REQUIRED[cmd] - args)
        if cmd == "schedule.reschedule_event" and not ({"to", "by"} & args):
            return "reschedule without to/by"
        if (CMDS[cmd][0] is not None) != (c["on"] is not None) and cmd != "tally.settle_up":
            return "anchor mismatch %s" % cmd
        if CMDS[cmd][0] is not None and kind is not None and not Gen.anchor_ok(cmd, kind):
            return "anchor kind %s for %s" % (kind, cmd)
    return None


def validate(target, ctx):
    if not REC.full(target):
        return "gbnf"
    try:
        tree = check.parse(target)
    except check.ParseError as e:
        return "parse: %s" % e
    if DEGEN.search(target):
        return "degenerate"
    why = arms_ok(tree, ctx)
    if why:
        return why
    return None


# ---------------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------------
def rand_today(rng):
    return DAY0 + datetime.timedelta(days=rng.randint(0, (DAY1 - DAY0).days))


BAD = []
FIXED_IDIOMS = {"s.overdue", "s.open", "s.owe", "m.overdue", "m.bareagg", "s.nothing", "m.nothing"}
WHY = collections.defaultdict(collections.Counter)


def tree_depth(tree):
    """check.depth, except a `then` sequence is as deep as its deepest step
    (check.depth does not descend into the steps list)."""
    if tree["node"] == "seq":
        return max(check.depth(s) for s in tree["steps"])
    return check.depth(tree)


def generate(n, seed, counts, prefix, max_same_target=10, avoid_skel=None):
    g = Gen(seed, counts)
    rows, seen, per_target = [], collections.Counter(), collections.Counter()
    fails = collections.Counter()
    tries = 0
    while len(rows) < n and tries < n * 60:
        tries += 1
        g.pending = collections.Counter()
        g.today = rand_today(g.rng)
        tt = g.pick([(t, ["TT:" + t], s) for t, s in TT_SHARE.items()], jitter=0.05)
        try:
            prev, target, ctx, hint = g.scenario(tt)
        except (Fail, IndexError, KeyError) as e:
            fails["gen:" + tt] += 1
            WHY[tt][repr(e)[:70]] += 1
            for k in g.pending:
                g.penalty[k] += 0.25
            g.penalty["TT:" + tt] += 0.25
            continue
        why = validate(target, ctx.meta())
        if why is None and prev != "NONE":
            if not REC.full(prev):
                why = "prev gbnf"
        if why:
            fails[why.split(":")[0]] += 1
            if len(fails) < 400:
                BAD.append((tt, why, target))
            for k in g.pending:
                g.penalty[k] += 0.25
            continue
        key = (prev, target, hint)
        cap = 30 if target.startswith(("refuse", "clarify", "nothing")) or tt in FIXED_IDIOMS else max_same_target
        # a literal-free line (or a fixed idiom) may recur: new `today`, new words
        reps = 3 if ('"' not in target or tt in FIXED_IDIOMS) else 1
        if seen[key] >= reps or per_target[target] >= cap:
            fails["dup"] += 1
            for k in g.pending:
                g.penalty[k] += 0.25
            continue
        tree = check.parse(target)
        dep = tree_depth(tree)
        skel = json.dumps(check.skeleton(tree), sort_keys=True)
        if avoid_skel is not None and skel in avoid_skel:
            fails["seen skeleton"] += 1
            for k in g.pending:
                g.penalty[k] += 0.25
            continue
        g.pending["TT:" + tt] += 1
        g.pending["D:%d" % min(dep, 4)] += 1
        edges = sorted(k for k, v in g.pending.items() if v)
        counts.update(g.pending)
        seen[key] += 1
        per_target[target] += 1
        rows.append({"id": "%s%04d" % (prefix, len(rows)), "prev": prev, "target": target,
                     "today": g.today.isoformat(), "edges": edges, "turn_type": tt, "depth": dep,
                     "ctx": ctx.meta(), "hint": hint, "skeleton": skel})
    # gap-fill: every key of the typing's universe that is still zero gets one row
    if avoid_skel is None:
        U = universe()
        for key in sorted(k for k in U if counts[k] == 0 and k.split(":")[0] in ("F", "L", "GK")):
            for _ in range(20):
                g.pending = collections.Counter()
                g.today = rand_today(g.rng)
                g.gap_key = key
                try:
                    prev, target, ctx, hint = g.t_gap()
                except (Fail, IndexError, KeyError):
                    continue
                if validate(target, ctx.meta()) or (prev != "NONE" and not REC.full(prev)):
                    continue
                if seen[(prev, target, hint)]:
                    continue
                tree = check.parse(target)
                g.pending["TT:gap"] += 1
                g.pending["D:%d" % min(tree_depth(tree), 4)] += 1
                counts.update(g.pending)
                seen[(prev, target, hint)] += 1
                rows.append({"id": "%s%04d" % (prefix, len(rows)), "prev": prev, "target": target,
                             "today": g.today.isoformat(), "edges": sorted(g.pending), "turn_type": "gap",
                             "depth": tree_depth(tree), "ctx": ctx.meta(), "hint": hint,
                             "skeleton": json.dumps(check.skeleton(tree), sort_keys=True)})
                break
    return rows, fails


def refs_in(t):
    out = []
    for r in sorted(L.REFS, key=len, reverse=True):
        if re.search(r"(?<![a-z_])%s(?![a-z_])" % re.escape(r), re.sub(r'"[^"]*"', '""', t)):
            out.append(r)
    if re.search(r"\bthe \d+(st|nd|rd|th) one\b", t):
        out.append("the Nth one")
    return out


def universe():
    """Every key the typing ALLOWS — so a zero in coverage.md is visible."""
    u = set()
    for k, ki in KINFO.items():
        u.add("K:" + k)
        for f, i in ki["fields"].items():
            if i["forms"] or f in ki["minmax"]:
                u.add("F:%s.%s" % (k, f))
        if ki["sum"]:
            u.add("GK:sum:%s" % k)
        if ki["minmax"]:
            u.add("GK:min:%s" % k); u.add("GK:max:%s" % k)
    for (a, b) in LINKS:
        u.add("L:%s<-%s" % (a, b))
    for (a, b) in COUNT_WALKS:
        u.add("CW:%s/%s" % (a, b))
    for (a, b) in MEMBER_OF:
        u.add("M:%s/%s" % (a, b))
    for cmd, (_, subs) in CMDS.items():
        for s in subs:
            u.add("C:%s|%s" % (cmd, ",".join(s)))
        u.add("V:" + cmd)
    for (c, k) in CLASS_OK:
        u.add("V:" + c)
    for w in L.WINDOW_PHRASES:
        u.add("W:" + w)
    for w in ("date", "month", "daterange", "datetime", "rolling", "anchored"):
        u.add("W:" + w)
    for r in L.REFS:
        u.add("R:" + r)
    u.add("R:the Nth one")
    for r in L.DECLINE_REASONS:
        u.add("X:" + r)
    for t in TT_SHARE:
        u.add("TT:" + t)
    return u


def histo(rows, key):
    c = collections.Counter(key(r) for r in rows)
    return c


def write_coverage(rows, held, counts, fails, path):
    # the terminals a canonical actually carries, re-derived from the TEXT (not from the sampler's claims)
    real = collections.Counter()
    for r in rows:
        for ref in refs_in(r["target"]):
            real["R:" + ref] += 1
        for w in L.WINDOW_PHRASES:
            if re.search(r"during %s(?![a-z])" % w, r["target"]):
                real["W:" + w] += 1
    U = universe()
    keys = sorted(U | set(k for k in counts if not k.startswith(("ARG:",))))
    zero = [k for k in sorted(U) if counts[k] == 0]
    lines = ["# v3 canonical coverage", "",
             "Generated by `gen.py`. %d training canonicals (%d unique targets), %d held-out canonicals whose "
             "literal-masked skeleton never occurs in the training set." % (
                 len(rows), len({r["target"] for r in rows}), len(held)), "",
             "Key families: `TT` turn type, `D` set depth (check.depth), `E:<parent>><form>` set-constructor edge in "
             "the context of its parent, `PC`/`PF` predicate connective / form, `K` kind, `F` (kind, field) pair, "
             "`O`/`PJ` order/projection field, `G` aggregate, `L:B<-A` link walk `B of (A)`, `CW` count-over-walk, "
             "`M` member-of, `FF` field-to-field, `C:<command>|<args>` executor arm with arg subset, `V` verb token "
             "(class or command), `A` argval form, `W` window, `R` ref, `X` decline reason, `MT` multi-turn move, "
             "`Q*` special quotas.", "",
             "## Zero-count keys the typing allows", ""]
    lines += (["- none"] if not zero else ["- `%s`" % z for z in zero])
    lines += ["", "Not generated by design (and why):", "",
              "- verb class `complete` resolves to `people.complete_task`, which is not an executor arm "
              "(v2/arms.json); `restore` on events/notes/expenses/locker/parties resolves to a non-arm command "
              "(undo there uses `tally.undo_expense` / `people.undo_person`).",
              "- self-walks (`tasks of (tasks …)`, `places of (places …)`, `albums of (albums …)`) are the "
              "degenerate `X of (X called|that …)` shape the brief bans.",
              "- primary keys, `row_version`, `purge_at`, `sort_order`: never named by a member; opaque machinery "
              "columns (hashes, JSON blobs, device/concept ids) only under `is null` / `is not null`; "
              "`month_day` (stores MM-DD) is never windowed.", "",
              "## Histograms", ""]
    n = len(rows)
    for title, fn in [("turn type", lambda r: r["turn_type"]),
                      ("depth (check.depth; 4 = 4+)", lambda r: min(r["depth"], 4)),
                      ("multi-turn", lambda r: "prev" if r["prev"] != "NONE" else "NONE"),
                      ("uses a ref", lambda r: "ref" if refs_in(r["target"]) else "no ref"),
                      ("turn head", lambda r: r["target"].split(" ")[0].split("{")[0] if not "{" in r["target"].split(" ")[0] else "cmd" + (" then" if " then " in r["target"] else ""))]:
        h = histo(rows, fn)
        lines += ["### " + title, "", "| value | rows | share |", "| --- | ---: | ---: |"]
        for k, v in sorted(h.items(), key=lambda x: (-x[1], str(x[0]))):
            lines.append("| %s | %d | %.1f%% |" % (k, v, 100.0 * v / n))
        lines.append("")
    lines += ["### refs (re-derived from target text)", "", "| ref | rows |", "| --- | ---: |"]
    for k in sorted(real):
        if k.startswith("R:"):
            lines.append("| %s | %d |" % (k[2:], real[k]))
    lines += ["", "## Every edge and terminal", "", "| key | count |", "| --- | ---: |"]
    for k in keys:
        lines.append("| `%s` | %d |" % (k, counts[k]))
    lines += ["", "## Sampler rejects", "", "| reason | count |", "| --- | ---: |"]
    for k, v in fails.most_common():
        lines.append("| %s | %d |" % (k, v))
    open(path, "w").write("\n".join(lines) + "\n")
    return zero


def main():
    counts = collections.Counter()
    rows, fails = generate(int(os.environ.get("V3_N", 2000)), 20260923, counts, "v")
    skels = {r["skeleton"] for r in rows}
    hcounts = collections.Counter()
    held, hf = generate(150, 777, hcounts, "h", avoid_skel=skels, max_same_target=1)
    for name, rs in (("canon.jsonl", rows), ("heldout_canon.jsonl", held)):
        with open(os.path.join(HERE, name), "w") as fh:
            for r in rs:
                fh.write(json.dumps(r) + "\n")
    zero = write_coverage(rows, held, counts, fails, os.path.join(HERE, "coverage.md"))
    print("rows %d  heldout %d  zero-keys %d" % (len(rows), len(held), len(zero)))
    print("fails", fails.most_common(12))
    print("zero:", zero[:80])
    for b in BAD[:25]:
        print("BAD", b)
    for tt, c in sorted(WHY.items(), key=lambda x: -sum(x[1].values()))[:10]:
        print("WHY", tt, c.most_common(4))


if __name__ == "__main__":
    main()
