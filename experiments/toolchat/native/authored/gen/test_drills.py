"""Unit tests of the decision-drills generator (authored/gen/drills.py).

    python3 -m unittest authored/gen/test_drills.py          # from experiments/toolchat/native, no runtime needed
    NATIVETOOLS=... python3 -m unittest authored.gen.test_drills.Gaps    # the gap-cell classifier needs `nativetools export`

The tests read authored/worlds (never write there) and use a tiny synthetic world for the evaluator. The runtime is not
needed except for the gap classifier (skipped without NATIVETOOLS) and the end-to-end build, which `drills.py gen` runs.
"""
from __future__ import annotations

import collections
import datetime as dt
import json
import os
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import drill_dist  # noqa: E402
import drills  # noqa: E402
from drills import U, Dt, span  # noqa: E402

WORLD = {
    "me": "Sam Park", "epoch": "2026-01-05T09:00", "currency": "USD",
    "people": [{"key": "neha", "name": "Neha Rao", "role": "sister", "nickname": "Nee", "starred": True, "cadence": 14, "last_contacted": "2026-09-20T10:00"},
               {"key": "raj", "name": "Raj Patel", "role": "plumber"}, {"key": "priya_a", "name": "Priya Nair", "role": "nurse"},
               {"key": "priya_b", "name": "Priya Shah", "role": "teacher"}],
    "groups": [{"key": "tahoe", "name": "Tahoe Trip", "currency": "EUR", "members": ["neha", "raj"]}],
    "lists": [{"key": "home", "name": "Home"}, {"key": "work", "name": "Work"}],
    "events": [{"key": "dentist", "name": "Dentist", "start": "2026-10-02T09:00", "end": "2026-10-02T10:00", "attendees": ["neha"]},
               {"key": "dentist2", "name": "Dentist", "start": "2026-10-09T09:00", "end": "2026-10-09T09:30"},
               {"key": "gym", "name": "Gym", "start": "2026-09-29T18:00", "end": "2026-09-29T19:30", "cancelled": True}],
    "tasks": [{"key": "milk", "name": "Buy milk", "list": "home", "due": "2026-09-30", "effort": 10},
              {"key": "cabin", "name": "Book the cabin", "list": "home", "due": "2026-10-03", "priority": 2, "status": "in_progress"},
              {"key": "tax", "name": "Pay tax", "list": "work", "due": "2026-09-28", "completed": "2026-09-27T10:00"},
              {"key": "old", "name": "Old thing", "list": "work", "status": "cancelled"},
              {"key": "sub", "name": "Pick a cabin date", "parent": "cabin", "list": "home", "due": "2026-10-01"}],
    "notebooks": [{"key": "ideas", "name": "Ideas"}], "notes": [{"key": "dal", "name": "Dal", "body": "lentils and rice", "notebook": "ideas", "pinned": True}],
    "folders": [{"key": "taxes", "name": "Taxes"}], "documents": [{"key": "w2", "name": "W2 2025", "folder": "taxes", "starred": True}],
    "albums": [{"key": "summer", "name": "Summer"}], "photos": [{"key": "beach", "name": "Beach", "taken": "2026-07-01T10:00", "albums": ["summer"], "people": ["neha"]}],
    "debts": [{"key": "d1", "person": "neha", "direction": "owes_me", "amount": 25.5, "name": "tickets", "date": "2026-09-01"},
              {"key": "d2", "person": "raj", "direction": "i_owe", "amount": 100, "name": "fix", "date": "2026-09-10", "settled": "2026-09-12"}],
    "locker": [{"key": "wifi", "name": "Home wifi", "type": "wifi", "password": "x"}], "links": [{"from": "milk", "to": "raj"}],
}
TODAY = "2026-09-30T10:00"  # a Wednesday


def vault() -> drills.Vault:
    return drills.Vault(WORLD, TODAY)


class Dates(unittest.TestCase):
    now = dt.datetime(2026, 9, 30, 10, 0)

    def echo(self, expr):
        r = drills.resolve(expr, self.now)
        return (r[0], str(r[1]), str(r[2])) if r[0] != "at" else ("at", str(r[1]))

    def test_weeks_run_monday_to_sunday(self):
        self.assertEqual(self.echo(U("week", 0)), ("days", "2026-09-28", "2026-10-04"))
        self.assertEqual(self.echo(U("week", 1)), ("days", "2026-10-05", "2026-10-11"))
        self.assertEqual(self.echo(U("week", -1)), ("days", "2026-09-21", "2026-09-27"))

    def test_weekday_and_clock(self):
        self.assertEqual(self.echo(U("week", 1, weekday=5)), ("days", "2026-10-09", "2026-10-09"))
        self.assertEqual(self.echo(U("week", 0, weekday=5, time="15:00")), ("at", "2026-10-02 15:00:00"))

    def test_named_month_conventions(self):
        self.assertEqual(self.echo(U("month", -1, name=11)), ("days", "2025-11-01", "2025-11-30"))
        self.assertEqual(self.echo(U("month", 1, name=3)), ("days", "2027-03-01", "2027-03-31"))
        self.assertEqual(self.echo(U("month", 0, name=12)), ("days", "2026-12-01", "2026-12-31"))
        self.assertEqual(self.echo(U("month", -1)), ("days", "2026-08-01", "2026-08-31"))

    def test_spans_and_open_ends(self):
        self.assertEqual(self.echo(span(U("week", 0, weekday=6), U("week", 0, weekday=7))), ("days", "2026-10-03", "2026-10-04"))
        r = drills.resolve({"to": U("day", -1)}, self.now)
        self.assertEqual(str(r[2]), "2026-09-29")
        self.assertTrue(drills.contains(drills.resolve({"from": Dt("2026-10-05")}, self.now), (dt.date(2030, 1, 1), None)))

    def test_contains_follows_the_runtime(self):
        day = drills.resolve(Dt("2026-10-02"), self.now)
        self.assertTrue(drills.contains(day, (dt.date(2026, 10, 2), (9, 0))))
        self.assertFalse(drills.contains(day, (dt.date(2026, 10, 3), None)))
        at = drills.resolve(Dt("2026-10-02", "09:00"), self.now)
        self.assertTrue(drills.contains(at, (dt.date(2026, 10, 2), (9, 0))))
        self.assertFalse(drills.contains(at, (dt.date(2026, 10, 2), (10, 0))))

    def test_bare_weekday_rule(self):
        today = dt.date(2026, 9, 30)  # a Wednesday
        self.assertEqual(drills.wd_rel(today, 4), 0)  # friday is ahead
        self.assertEqual(drills.wd_rel(today, 0), 1)  # monday is past this week
        self.assertEqual(drills.wd_rel(today, 2), 0)  # today counts
        texts = {p.text: p for p in drills.phrase_bank(today)}
        self.assertEqual(texts["monday"].expr, U("week", 1, weekday=1))
        self.assertIn("this friday", texts)
        self.assertNotIn("this monday", texts)


class Evaluator(unittest.TestCase):
    def setUp(self):
        self.v = vault()

    def test_status_words(self):
        v = self.v
        self.assertEqual(sorted(v.select("task", where=[("status", "=", "open")])), ["cabin", "milk", "sub"])  # in progress is open
        self.assertEqual(sorted(v.select("task", where=[("status", "!=", "open")])), ["old", "tax"])
        self.assertEqual(v.select("task", where=[("status", "=", "completed")]), ["tax"])
        self.assertEqual(sorted(v.select("task", where=[("status", "in", ["open", "completed"])])), ["cabin", "milk", "sub", "tax"])
        self.assertEqual(v.select("task", where=[("status", "=", "in_progress")]), ["cabin"])

    def test_linked_to(self):
        v = self.v
        self.assertEqual(sorted(v.select("task", linked_to="home")), ["cabin", "milk", "sub"])
        self.assertEqual(sorted(v.select("task", linked_to="cabin")), ["sub"])  # subtasks
        self.assertEqual(v.select("event", linked_to="neha"), ["dentist"])
        self.assertEqual(sorted(v.select("person", linked_to="tahoe")), ["me", "neha", "raj"])  # you are a member
        self.assertEqual(v.select("photo", linked_to="summer"), ["beach"])
        self.assertEqual(v.select("task", linked_to="raj"), ["milk"])

    def test_where_operators(self):
        v = self.v
        self.assertEqual(v.select("task", where=[("effort", "<", 20)]), ["milk"])
        self.assertEqual(v.select("task", where=[("effort", "<", "20 minutes")]), ["milk"])
        self.assertEqual(sorted(v.select("task", where=[("priority", "is empty", None)])), ["milk", "old", "sub", "tax"])
        self.assertEqual(v.select("task", where=[("priority", "is set", None)]), ["cabin"])
        self.assertEqual(v.select("person", where=[("role", "contains", "plum")]), ["raj"])
        self.assertEqual(sorted(v.select("person", where=[("role", "in", ["nurse", "teacher"])])), ["priya_a", "priya_b"])
        self.assertEqual(v.select("person", where=[("starred", "=", "yes")]), ["neha"])
        self.assertEqual(v.select("debt", where=[("amount", ">", 30)]), ["d2"])
        self.assertEqual(v.select("debt", where=[("amount", ">=", "25.5 USD")]), ["d1", "d2"])
        self.assertEqual(v.select("event", where=[("duration", ">", 60)]), ["gym"])
        self.assertEqual(v.select("album", where=[("photo count", ">=", 1)]), ["summer"])
        self.assertEqual(v.select("folder", where=[("document count", "=", 0)]), [])

    def test_name_match_is_whole_words_in_any_order(self):
        v = self.v
        self.assertEqual([r["key"] for r in v.by_name("task", "cabin book")], ["cabin"])
        self.assertEqual(v.by_name("task", "cab"), [])  # a word start is the runtime's fallback, not a match
        self.assertEqual([r["key"] for r in v.by_name("person", "nee")], ["neha"])  # a nickname is a name
        self.assertEqual(len(v.by_name("event", "dentist")), 2)

    def test_word_index_agrees_with_the_linear_scan(self):
        """`by_name` runs on a word index; it must pick what `fits` picks, in the same order, on a whole real world too."""
        for v in (self.v, drills.Vault(json.loads((drills.AUTHORED / "worlds" / "T01.json").read_text()), drills.world_today("T01")[0])):
            texts = set()
            for r in v.rows.values():
                texts.add(r["name"])
                texts.update(drills.toks(r["name"]))
                texts.update(" ".join(drills.toks(r["name"])[i:i + 2]) for i in range(max(1, len(drills.toks(r["name"])) - 1)))
                if r.get("nickname"):
                    texts.add(r["nickname"])
            texts |= {"", "zzz", "the", "Neha", "NEHA RAO", "rao neha"}
            for kind in {r["kind"] for r in v.rows.values()}:
                for live in (True, False):
                    for text in sorted(texts):
                        want = [r for r in v.of(kind, live) if v.fits(r, text)]
                        self.assertEqual([r["key"] for r in v.by_name(kind, text, live)], [r["key"] for r in want], (kind, live, text))

    def test_select_is_memoised_without_sharing_results(self):
        v = self.v
        a = v.select("task", where=[("status", "=", "open")])
        a.append("junk")
        self.assertNotIn("junk", v.select("task", where=[("status", "=", "open")]))
        self.assertEqual(v.select("task", where=[("status", "=", "open")], limit=1), a[:1])
        self.assertNotEqual(v.select("task", where=[("status", "=", "completed")]), a)

    def test_block_hits_and_first_names(self):
        v = self.v
        self.assertEqual(v.block_hits("priya"), 2)  # a whole word
        self.assertEqual(v.block_hits("pri"), 2)  # a word start of three letters
        self.assertEqual(v.block_hits("pr"), 0)  # two letters is no start
        self.assertEqual(v.block_hits("dentist"), 2)
        self.assertEqual(v.block_hits(""), 0)
        bank = drills.RichBank(v, [])
        self.assertIsNone(bank.first_unique(v.get("priya_a")))  # two Priyas
        self.assertEqual(bank.first_unique(v.get("neha")), "Neha")
        self.assertIsNone(bank.first_unique(v.get("raj")))  # three letters

    def test_dates_and_superlatives(self):
        v = self.v
        self.assertEqual(sorted(v.select("event", when=U("week", 0))), ["dentist", "gym"])
        self.assertEqual(v.select("event", when=U("week", 0, weekday=5)), ["dentist"])
        self.assertEqual(sorted(v.select("task", when=U("week", 0), where=[("status", "=", "open")])), ["cabin", "milk", "sub"])
        self.assertEqual(v.select("task", where=[("status", "=", "open")], order=("date", "asc"), limit=1), ["milk"])
        self.assertEqual(v.select("task", where=[("status", "=", "open")], order=("date", "desc"), limit=1), ["cabin"])
        self.assertEqual(v.select("debt", order=("amount", "desc"), limit=1), ["d2"])
        self.assertEqual(v.select("event", order=("duration", "asc"), limit=1), ["dentist2"])
        self.assertEqual(v.select("task", where=[("status", "=", "open")], when={"to": U("day", -1)}), [])  # overdue: nothing before today

    def test_container_readout_rule(self):
        v = self.v
        self.assertTrue(v.active_default("task", "home", [], "what's on the home list"))
        self.assertFalse(v.active_default("task", "home", [], "everything on the home list"))
        self.assertFalse(v.active_default("task", "home", [("status", "=", "open")], "tasks on home"))
        self.assertFalse(v.active_default("event", "home", [], "x"))

    def test_reopen_clears_a_completion_date_only_when_there_is_one(self):
        v = self.v
        self.assertEqual(drills.VERBS["reopen"]["gold"](v, "tax"), drills.g_upd("tax", status="open", completed=None))  # completed: a date to clear
        self.assertEqual(drills.VERBS["reopen"]["gold"](v, "old"), drills.g_upd("old", status="open"))  # cancelled: nothing to clear

    def test_trashed_rows_are_not_live(self):
        w = json.loads(json.dumps(WORLD))
        w["tasks"].append({"key": "gone", "name": "Gone", "trashed": "2026-09-20T10:00"})
        v = drills.Vault(w, TODAY)
        self.assertNotIn("gone", v.select("task"))
        self.assertEqual(v.select("task", name="gone", trashed=True), ["gone"])


class Banks(unittest.TestCase):
    def test_every_cell_has_a_template_with_eight_phrasings(self):
        for cell in drills.CELL_NAMES:
            ts = [t for t in drills.TEMPLATES if t.cell == cell]
            self.assertTrue(ts, cell)
            self.assertGreaterEqual(sum(t.frames for t in ts), 8, cell)
            for t in ts:
                self.assertGreaterEqual(t.frames, 8, f"{cell}.{t.name}")  # per template family
        self.assertTrue(all(t.asks and not t.needs_m1 for t in drills.TEMPLATES if t.cell == "AMB"))

    def test_every_frame_list_spans_the_three_moods(self):
        """Each list of frames the templates draw on (a tuple per frame, the mood first) holds command, question and indirect
        ("can you ...") phrasings, and the ones a template uses on their own hold at least six."""
        moods = {"command", "question", "indirect"}
        lists = {}
        for name, val in vars(drills).items():
            if isinstance(val, dict) and val and all(isinstance(x, list) for x in val.values()):
                for k, lst in val.items():
                    lists[f"{name}[{k}]"] = lst
            elif isinstance(val, list):
                lists[name] = val
        checked = 0
        for name, lst in lists.items():
            if lst and all(isinstance(x, tuple) and x and x[0] in moods for x in lst):
                checked += 1
                self.assertEqual({x[0] for x in lst}, moods, name)
                self.assertGreaterEqual(len(lst), 6, name)
        self.assertGreater(checked, 25)

    def test_frames_span_the_three_moods(self):
        for name, frames in (("read", drills.READ_FRAMES), ("count", drills.COUNT_FRAMES), ("sum", drills.SUM_FRAMES), ("super", drills.SUPER_FRAMES)):
            self.assertEqual({m for m, _ in frames}, {"command", "question", "indirect"}, name)
            self.assertGreaterEqual(len(frames), 8, name)
        for verb, frames in drills.VERB_FRAMES.items():
            self.assertGreaterEqual(len(frames), 8, verb)
            self.assertTrue(all("{X}" in f for _, f in frames), verb)

    def test_date_wording_is_never_garbled(self):
        today = dt.date(2026, 3, 12)
        phs = drills.phrase_bank(today) + drills.span_phrases(today) + [drills.abs_phrase(today + dt.timedelta(days=k)) for k in (3, 9)]
        bad = re.compile(r"\bon (today|tomorrow|yesterday)\b|\bfor in\b|\bon from\b|\bfrom from\b|\bsince\b|\bthe the\b|\bon on\b")
        for p in phs:
            for kind in ("event", "task", "person", "note", "document", "photo", "debt"):
                for form in drills.when_forms(kind, p):
                    self.assertFalse(bad.search(form.format(t=p.text)), (kind, form, p.text))
            for vi in (0, 1):
                for kind in ("event", "task"):
                    self.assertFalse(bad.search(drills.date_connect(kind, p, vi)), (kind, vi, p.text))
        self.assertEqual(drills.when_forms("event", next(p for p in phs if p.text == "tomorrow")), ["{t}"])
        self.assertEqual(drills.date_connect("task", next(p for p in phs if p.text == "today"), 1), "due today")

    def test_tidy_drops_the_words_a_frame_and_a_name_both_bring(self):
        self.assertEqual(drills.tidy("move lee to the bar prep study group group ?"), "move lee to the bar prep study group?")
        self.assertEqual(drills.tidy("in the the garden album"), "in the garden album")
        self.assertEqual(drills.tidy("what notebook is puff puff in"), "what notebook is puff puff in")  # a name may repeat a word

    def test_verb_words_follow_the_delete_convention(self):
        """SPEC 14.1: 'get rid of', 'wipe', 'clear out' are a delete; no cancel, complete or star frame may use them."""
        words = re.compile(r"\b(get rid of|wipe|clear out|scrap|drop|bin|kill)\b")
        for verb in ("cancel", "complete", "star", "unstar", "reopen", "log"):
            for _mood, frame in drills.VERB_FRAMES[verb]:
                self.assertFalse(words.search(frame), (verb, frame))
        for phrase in drills.VP["cancel"] + drills.VP["complete"] + drills.VP["star"]:
            self.assertFalse(words.search(phrase), phrase)

    def test_phone_typing_is_lowercase_and_deterministic(self):
        r1, r2 = drills.rng(1, "a"), drills.rng(1, "a")
        self.assertEqual(drills.phone("Can you show me {X}", r1), drills.phone("Can you show me {X}", r2))
        self.assertEqual(drills.phone("What is on {X}", drills.rng(2, "z")).split("{")[0], "what's on ")

    def test_names_decide_one_row(self):
        v = vault()
        for key in ("milk", "cabin", "neha", "raj"):
            row = v.get(key)
            opts = drills.name_options(v, row)
            self.assertTrue(opts, key)
            for style, text, arg in opts:
                self.assertEqual([r["key"] for r in v.by_name(row["kind"], arg)], [key], (key, text))
        self.assertEqual(drills.name_options(v, v.get("dentist")), [])  # a repeating event has no name of its own
        self.assertEqual(drills.name_options(v, v.get("me")), [])
        sets = drills.twin_sets(v)
        self.assertEqual([sorted(x["key"] for x in S) for S in sets["first"]], [["priya_a", "priya_b"]])
        self.assertEqual([sorted(x["key"] for x in S) for S in sets["same"]], [["dentist", "dentist2"]])


class Gen(unittest.TestCase):
    """The generator on the real worlds, without the runtime: deterministic, pairs, hygiene."""

    @classmethod
    def setUpClass(cls):
        cls.a = drills.gen_world("T01", 11, 160, drills.CELL_NAMES, set())
        cls.pairs = cls.a[1]

    def test_same_seed_same_items(self):
        b = drills.gen_world("T01", 11, 160, drills.CELL_NAMES, set())
        dump = lambda pairs: [[(t.user, json.dumps(t.gold, sort_keys=True), json.dumps(t.ref, sort_keys=True)) for it in p for t in it.turns] for p in pairs]  # noqa: E731
        self.assertEqual(dump(self.pairs), dump(b[1]))
        c = drills.gen_world("T01", 12, 160, drills.CELL_NAMES, set())
        self.assertNotEqual(dump(self.pairs), dump(c[1]))

    def test_items_do_not_depend_on_the_hash_seed(self):
        """Python's string hashing differs per process: the items must not (no choice may walk a set)."""
        import subprocess
        code = ("import sys, json, hashlib; sys.path.insert(0, %r); import drills; "
                "_, ps, _ = drills.gen_world('T01', 5, 80, drills.CELL_NAMES, set()); "
                "print(hashlib.sha256(json.dumps([[(t.user, t.gold, t.ref) for it in p for t in it.turns] for p in ps], sort_keys=True).encode()).hexdigest())"
                % str(Path(__file__).resolve().parent))
        outs = {subprocess.run([sys.executable, "-c", code], env={**os.environ, "PYTHONHASHSEED": h}, capture_output=True, text=True, check=True).stdout.strip()
                for h in ("11", "29")}
        self.assertEqual(len(outs), 1, outs)

    def test_quota_and_cells(self):
        q = drills.quotas(80, drills.CELL_NAMES)
        self.assertEqual(sum(q.values()), 80)
        made = {c: sum(1 for a, b in self.pairs if a.cell == c) for c in drills.CELL_NAMES}
        self.assertGreater(sum(made.values()), 60)
        for c in ("C2", "C3", "REF", "CM", "TWO", "DATES", "CONT", "FOLLOW", "JUDGE"):
            self.assertGreater(made[c], 0, c)

    def test_a_pair_flips_one_decision(self):
        for a, b in self.pairs:
            self.assertEqual((a.cell, a.template, a.frame, a.feature), (b.cell, b.template, b.frame, b.feature))
            self.assertEqual(len(a.turns), len(b.turns))
            self.assertTrue(drills.outcomes_differ(a, b), a.sid_key())
            ma, mb = [t.user for t in a.turns], [t.user for t in b.turns]
            self.assertNotEqual(ma, mb)
            for x, y in zip(ma, mb):  # the same phrasing: the two messages share most of their words
                wx, wy = set(x.split()), set(y.split())
                self.assertLessEqual(len(wx ^ wy), 12, (x, y))
            if a.cell in ("C2", "C3", "DATES", "CONT", "TWO"):
                self.assertEqual([c["tool"] for t in a.turns for c in t.ref], [c["tool"] for t in b.turns for c in t.ref])

    def test_constraint_counts_are_the_cell(self):
        for a, b in self.pairs:
            if a.cell in ("C2", "C3"):
                k = int(a.cell[1])
                for it in (a, b):
                    self.assertEqual(it.k(), k, (it.sid_key(), it.turns[0].ref))

    def test_no_duplicate_messages_across_pairs(self):
        seen = {}
        for n, (a, b) in enumerate(self.pairs):
            for m in {t.user for it in (a, b) for t in it.turns}:
                self.assertNotIn(m, seen, f"{m!r} in pairs {seen.get(m)} and {n}")
                seen[m] = n

    def test_no_collision_with_authored_messages_or_other_runs(self):
        avoid = {t.user for a, b in self.pairs[:10] for it in (a, b) for t in it.turns}
        ctx, pairs, _ = drills.gen_world("T01", 11, 160, drills.CELL_NAMES, avoid)
        # an authored message of six words or more is refused (the context is built with the authored list of the world); a
        # shorter one may repeat an authored message
        long_pair = next((a, b) for a, b in self.pairs if any(len(t.user.split()) >= 6 for it in (a, b) for t in it.turns))
        a, b = long_pair
        m = next(t.user for it in (a, b) for t in it.turns if len(t.user.split()) >= 6)
        self.assertFalse(drills.pair_ok(drills.Ctx("T01", 11, set(), {m}), a, b))
        self.assertTrue(drills.pair_ok(drills.Ctx("T01", 11, set(), set()), a, b))
        short = next((a, b) for a, b in self.pairs if all(len(t.user.split()) < 6 for it in (a, b) for t in it.turns))
        self.assertTrue(drills.pair_ok(drills.Ctx("T01", 11, set(), {t.user for it in short for t in it.turns}), *short))
        self.assertFalse(drills.pair_ok(drills.Ctx("T01", 11, {m}, set()), a, b))  # `--avoid` of an earlier run
        short_msg = next(t.user for it in short for t in it.turns)
        self.assertTrue(drills.pair_ok(drills.Ctx("T01", 11, {short_msg}, set()), *short))  # a short message may repeat across runs
        ctx3 = drills.Ctx("T01", 11, set(), set())
        ctx3.msgs.add(short_msg)
        self.assertFalse(drills.pair_ok(ctx3, *short))  # but never inside a world
        for a, b in pairs:
            for it in (a, b):
                for t in it.turns:
                    if drills.is_long(t.user):
                        self.assertNotIn(t.user, avoid)
        authored_real = drills.authored_messages("T01")
        self.assertTrue(authored_real)
        for a, b in self.pairs:
            for it in (a, b):
                for t in it.turns:
                    if len(t.user.split()) >= 6:
                        self.assertNotIn(t.user, authored_real)

    def test_messages_carry_no_artifact_phrases(self):
        bad = re.compile(r"\bon (today|tomorrow|yesterday)\b|\bfor in\b|\bon from\b|\bfrom from\b|\bto on\b|\bsince\b|\b(the|with|to|in|on|of|and|for|about) \1\b|"
                         r"\b(list|album|notebook|folder|group) \2\b|  |^\W|\b(a|an|the|to|of|with|and|or)$")
        for w, n in (("T01", 300), ("T05", 300), ("T30", 200)):
            _ctx, pairs, _st = drills.gen_world(w, 5, n, drills.CELL_NAMES, set())
            for a, b in pairs:
                for it in (a, b):
                    for t in it.turns:
                        m = bad.search(t.user)
                        self.assertTrue(m is None or t.user.startswith("what do") and t.user.endswith(" come to"), (w, it.cell, t.user))
                        self.assertFalse(re.search(r"\b(get rid of|scrap|drop|bin)\b", t.user) and it.template in ("ordinal-act", "both-one", "the-other") and "cancel" in it.tags, t.user)

    def test_shares_override_the_cell_mix(self):
        import argparse
        import contextlib
        import io
        saved = dict(drills.CELL_SHARE)
        try:
            with tempfile.TemporaryDirectory() as d:
                ns = argparse.Namespace(worlds="T01", cells="C2,REF", templates=None, out=d, avoid=None, weights=None, seed="1", per_world=40,
                                        no_build=True, jobs=1, split="train", shares="REF=0.6,C2=0.2")
                with contextlib.redirect_stdout(io.StringIO()):
                    drills.cmd_gen(ns)
                cells = json.loads((Path(d) / "cells.json").read_text())
            n = collections.Counter(m["cell"] for m in cells.values())
            self.assertEqual((n["C2"], n["REF"]), (10, 30))  # a quarter and three quarters of the 20 pairs
            ns.shares = "NOPE=1"
            with self.assertRaises(SystemExit):
                drills.cmd_gen(ns)
        finally:
            drills.CELL_SHARE.clear()
            drills.CELL_SHARE.update(saved)

    def test_val_worlds_are_refused(self):
        import argparse
        for w in json.loads((drills.AUTHORED / "split.json").read_text())["val"]:
            with self.assertRaises(SystemExit) as cm:
                drills.cmd_gen(argparse.Namespace(worlds=f"T01,{w}", cells=None, templates=None, shares=None, out=str(Path(tempfile.gettempdir()) / "drills-never-written"),
                                                  avoid=None, weights=None, seed="1", per_world=10, no_build=True, jobs=1, split="train"))
            self.assertIn("val worlds", str(cm.exception))

    def test_twins_are_not_honorifics(self):
        w = json.loads(json.dumps(WORLD))
        w["people"] += [{"key": "dr_a", "name": "Dr. Rao"}, {"key": "dr_b", "name": "Dr. Das"}]
        v = drills.Vault(w, TODAY)
        firsts = [sorted(x["key"] for x in S) for S in drills.twin_sets(v)["first"]]
        self.assertEqual(firsts, [["priya_a", "priya_b"]])

    def test_src_session_is_loadable_gold(self):
        sys.path.insert(0, str(drills.NATIVE / "eval"))
        import gold
        a, b = self.pairs[0]
        a.sid, b.sid = "TX-D0001a", "TX-D0001b"
        gold._SESSIONS.clear()
        gold.world("TX", "2026-03-12T18:20", "Me", "train")
        ns = {k: getattr(gold, k) for k in dir(gold) if not k.startswith("_")}
        exec(drills.src_session(a) + drills.src_session(b), ns)
        ss = gold.sessions()
        self.assertEqual([s["id"] for s in ss], ["TX-D0001a", "TX-D0001b"])
        self.assertEqual(ss[0]["turns"][0]["user"], a.turns[0].user)
        gold._SESSIONS.clear()


class PickAmbiguity(unittest.TestCase):
    """The port of act.rs `near` and `ambiguous_pick` (the cases are the runtime's own unit tests)."""

    def test_near_reads_the_runtimes_cases(self):
        for name, word in (("aadhaar", "aadhar"), ("9b", "9"), ("tires", "tire"), ("rotated", "rotation"), ("rotation", "rotated"), ("sundays", "sunday"), ("books", "book")):
            self.assertTrue(drills.near(name, word), (name, word))
        for name, word in (("planner", "plant"), ("rental", "dental"), ("dental", "mental"), ("test", "text"), ("30", "3"), ("312", "3")):
            self.assertFalse(drills.near(name, word), (name, word))

    def test_would_ask_at_an_ambiguous_pick(self):
        w = json.loads(json.dumps(WORLD))
        w["tasks"] += [{"key": "b1", "name": "Return books", "list": "home"}, {"key": "b2", "name": "Book flights", "list": "home"},
                       {"key": "b3", "name": "Plain thing", "list": "home"}]
        v = drills.Vault(w, TODAY)
        act = lambda **a: {"tool": "act", "args": {"verb": "complete", "kind": "task", **a}}  # noqa: E731
        self.assertTrue(drills.would_ask(v, act(name="books"), "tick off books"))  # "book" names the other row too
        self.assertFalse(drills.would_ask(v, act(name="books", when="{}"), "tick off books"))  # the call states a date: no pick to doubt
        self.assertFalse(drills.would_ask(v, act(name="books"), "tick off the books one"))  # "one" points at a row
        self.assertFalse(drills.would_ask(v, act(name="books"), "tick off books on friday"))  # a date settles which
        self.assertFalse(drills.would_ask(v, act(name="plain thing"), "tick off plain thing"))  # one row fits
        self.assertFalse(drills.would_ask(v, act(name="return books"), "tick off return books"))  # the whole name, stated, is only this row's
        self.assertTrue(drills.would_ask(v, act(rows="$b1"), "tick off books"))  # a pick by #n is doubted the same way
        self.assertFalse(drills.would_ask(v, {"tool": "act", "args": {"verb": "complete", "rows": "@prev"}}, "tick off books"))

    def test_generated_pairs_never_end_in_the_runtimes_ask(self):
        _ctx, pairs, st = drills.gen_world("T21", 7, 300, drills.CELL_NAMES, set())
        for a, b in pairs:
            for it in (a, b):
                if it.needs_m1 or it.cell == "AMB":  # an AMB pair is meant to end in the ask
                    continue
                for ti, t in enumerate(it.turns):
                    for c in t.ref:
                        self.assertFalse(drills.would_ask(_ctx.v, c, t.user, it.turns[ti - 1].user if ti else ""), (t.user, c))


class PreGrounding(unittest.TestCase):
    """The port of search.rs `preground`: the rows the first message puts in front of the model."""

    def crowded(self):
        w = json.loads(json.dumps(WORLD))
        w["tasks"] += [{"key": f"band_t{i}", "name": "Band", "list": "home"} for i in range(4)]
        w["events"] += [{"key": f"band_e{i}", "name": "Band", "start": f"2026-11-0{i + 1}T20:00", "end": f"2026-11-0{i + 1}T21:00"} for i in range(4)]
        w["notes"] += [{"key": f"band_n{i}", "name": "Band", "body": "x", "notebook": "ideas"} for i in range(4)] + [{"key": "heating", "name": "Heating", "body": "boiler", "notebook": "ideas"}]
        return drills.Vault(w, TODAY)

    def test_the_block_shows_what_the_words_reach(self):
        v = vault()
        shown = drills.block_keys(v, "tick off buy milk", slack=0)
        self.assertEqual(shown[0], "milk")  # "tick" is no verb of the list: it also reaches the debt "tickets" by its start
        self.assertNotIn("cabin", shown)
        self.assertIn("neha", drills.block_keys(v, "star nee", slack=0))  # a nickname is a name, a prefix counts
        self.assertEqual(drills.block_keys(v, "please star it", slack=0), [])  # fillers and the verb name nothing
        self.assertEqual(drills.spoken("Mum's 70th"), ["mum", "70th"])

    def test_a_crowded_message_cuts_a_row(self):
        v = self.crowded()
        shown = drills.block_keys(v, "wipe band and heating", slack=0)
        self.assertEqual(len(shown), 8)
        self.assertNotIn("heating", shown)  # twelve rows say "Band" in full; no kind past four, and the cap is eight
        item = types.SimpleNamespace(turns=[types.SimpleNamespace(user="wipe band and heating", ref=[{"tool": "act", "args": {"verb": "delete", "rows": "$heating"}}])])
        self.assertEqual(drills.unseen_keys(v, item), ["heating"])
        item.turns[0].user = "wipe heating"
        self.assertEqual(drills.unseen_keys(v, item), [])
        item.turns[0].ref = [{"tool": "answer", "args": {"kind": "task", "linked_to": "$home"}}]
        item.turns[0].user = "wipe band and heating"
        self.assertEqual(drills.unseen_keys(v, item), [])  # a container is in the system prompt's directory

    def test_a_name_many_rows_share_is_cut_to_six(self):
        w = json.loads(json.dumps(WORLD))
        w["events"] += [{"key": f"shift{i}", "name": "Night shift", "start": f"2026-10-{10 + i:02d}T22:00", "end": f"2026-10-{10 + i:02d}T23:00"} for i in range(9)]
        v = drills.Vault(w, TODAY)
        shown = [k for k in drills.block_keys(v, "night shift", slack=0) if k.startswith("shift")]
        self.assertEqual(len(shown), 6)


class NewTemplates(unittest.TestCase):
    """The grouped values, the `within` follow-up and the nickname twins, on the real worlds (no runtime)."""

    def test_group_values_by_label(self):
        v = vault()
        keys = v.select("task")
        self.assertEqual(drills.group_values(v, keys, "status", "count", None), {"open": 2, "in_progress": 1, "completed": 1, "cancelled": 1})
        self.assertEqual(drills.group_values(v, v.select("debt"), "direction", "sum", "amount"), {"owes_me": (25.5, "USD"), "i_owe": (100.0, "USD")})
        self.assertEqual(drills.group_values(v, v.select("person"), "role", "count", None)["none"], 1)  # an unset field (my own row has no role) is the label "none"
        self.assertEqual(drills.gold_groups({"a": 2, "b": (3.5, "USD")}),
                         {"type": "value", "groups": {"a": [{"amount": 2, "unit": None}], "b": [{"amount": 3.5, "unit": "USD"}]}})

    def test_c4_is_a_cell_that_runs_on_request(self):
        import argparse
        import contextlib
        import io
        saved = dict(drills.CELL_SHARE)
        try:
            self.assertEqual(drills.CELL_SHARE["C4"], 0.0)
            self.assertEqual(sum(drills.quotas(100, [c for c in drills.CELL_NAMES if drills.CELL_SHARE[c] > 0]).values()), 100)
            with tempfile.TemporaryDirectory() as d:
                ns = argparse.Namespace(worlds="T01", cells="C4", templates=None, shares=None, out=d, avoid=None, weights=None, seed="1", per_world=40,
                                        no_build=True, jobs=1, split="train")
                with contextlib.redirect_stdout(io.StringIO()):
                    drills.cmd_gen(ns)
                cells = json.loads((Path(d) / "cells.json").read_text())
            self.assertTrue(cells and all(m["cell"] == "C4" and m["k"] == 4 for m in cells.values()))
        finally:
            drills.CELL_SHARE.clear()
            drills.CELL_SHARE.update(saved)

    def test_group_pairs(self):
        ctx = drills.Ctx("T01", 3, set(), set())
        made = 0
        for k in (2, 3):
            for i in range(40):
                res = drills.sel_pair(ctx, ctx.rng("g", k, i), "group", k)
                if not res:
                    continue
                made += 1
                a, b = res
                for it in (a, b):
                    t = it.turns[0]
                    self.assertEqual([c["tool"] for c in t.ref], ["compute", "answer"])
                    self.assertEqual(t.ref[1]["args"], {"value": "@prev"})
                    self.assertEqual(it.k(), k)
                    self.assertIn("group", t.ref[0]["args"])
                    self.assertTrue(t.gold["groups"])
                    if t.ref[0]["args"]["kind"] == "task" and t.ref[0]["args"]["group"] == "status":
                        self.assertNotIn("linked_to", t.ref[0]["args"])  # a list or a parent would keep the active rows only
                self.assertNotEqual(a.turns[0].gold, b.turns[0].gold)
        self.assertGreater(made, 5)

    def test_within_pairs_share_turn_one(self):
        ctx = drills.Ctx("T01", 3, set(), set())
        made = 0
        for i in range(60):
            res = drills.follow_within(ctx, ctx.rng("w", i))
            if not res:
                continue
            made += 1
            a, b = res
            self.assertEqual(a.turns[0].user, b.turns[0].user)
            self.assertNotEqual(a.turns[1].user, b.turns[1].user)
            rows1 = set(a.turns[0].gold["rows"])
            self.assertTrue(4 <= len(rows1) <= drills.ROW_CAP)
            for it in (a, b):
                call = it.turns[1].ref[0]
                self.assertEqual(call["args"]["within"], "@prev")
                self.assertEqual(it.k(), 2)
                self.assertLessEqual(set(it.turns[1].gold["rows"]), rows1)
            self.assertNotEqual(a.turns[1].gold, b.turns[1].gold)
        self.assertGreater(made, 5)

    def test_nickname_twins(self):
        ctx = drills.Ctx("T14", 3, set(), set())
        v = ctx.v
        made = 0
        for i in range(20):
            res = drills.ref_nick(ctx, ctx.rng("n", i))
            if not res:
                continue
            made += 1
            for it in res:
                name = it.turns[0].ref[0]["args"]["name"]
                self.assertEqual(len(v.by_name("person", name)), 1, name)  # the name alone decides it
            self.assertEqual(res[0].turns[0].ref[0]["args"]["name"], "Rafa")
        self.assertGreater(made, 0)


class Measure(unittest.TestCase):
    def test_measure_on_a_synthetic_run(self):
        gold = [
            {"id": "W-D0001a", "world": "T01", "turns": [{"user": "show me open tasks", "gold": [{"type": "rows", "rows": ["a"]}], "ref": [{"tool": "answer", "args": {"kind": "task", "where": "status = open"}}]}]},
            {"id": "W-D0001b", "world": "T01", "turns": [{"user": "show me done tasks", "gold": [{"type": "rows", "rows": ["b"]}], "ref": [{"tool": "answer", "args": {"kind": "task", "where": "status = completed"}}]}]},
            {"id": "W-D0002a", "world": "T01", "turns": [{"user": "text sam", "gold": [{"type": "decline", "reasons": ["out_of_scope"]}], "ref": [{"tool": "decline", "args": {"reason": "out_of_scope"}}]}]},
            {"id": "X-1", "world": "T01", "turns": [{"user": "star priya", "gold": [{"type": "diff", "diff": {"rows": [], "links": []}}], "ref": [{"tool": "act", "args": {"verb": "star", "name": "priya", "kind": "person"}}]},
                                                    {"user": "and log a call with them", "gold": [{"type": "diff", "diff": {"rows": [], "links": []}}], "ref": [{"tool": "act", "args": {"verb": "log", "rows": "@prev"}}]}]},
        ]
        cells = {"W-D0001a": {"cell": "C2", "pair": "W-D0001", "side": "a", "family": "read.3"}, "W-D0001b": {"cell": "C2", "pair": "W-D0001", "side": "b", "family": "read.3"},
                 "W-D0002a": {"cell": "JUDGE", "pair": "W-D0002", "side": "a", "family": "text.1"}}
        run = [{"id": g["id"], "turns": [{"user": t["user"], "steps": []} for t in g["turns"]]} for g in gold]
        verdict = {"W-D0001a": [True], "W-D0001b": [False], "W-D0002a": [True], "X-1": [True, False]}

        def fake_score(run_, gold_):
            return {"sessions": [{"id": g["id"], "world": g["world"], "turns": [{"pass": p} for p in verdict[g["id"]]]} for g in gold_]}

        fake = types.ModuleType("score")
        fake.score = fake_score
        old = sys.modules.get("score")
        sys.modules["score"] = fake
        try:
            m = drills.measure(run, gold, cells)
        finally:
            if old is None:
                del sys.modules["score"]
            else:
                sys.modules["score"] = old
        c2 = m["cells"]["C2"]
        self.assertEqual((c2["items"], c2["turns"], c2["turn_pass"], c2["item_pass"], c2["pairs"], c2["pair_pass"]), (2, 2, 1, 1, 1, 0))
        self.assertEqual(m["cells"]["JUDGE"]["turn_pass"], 1)
        # the sessions the drills do not know are labelled by the heuristic classifier
        self.assertEqual(drills.turn_label(gold[3], 0), "C1")
        self.assertEqual(drills.turn_label(gold[3], 1), "FOLLOW")
        self.assertIn("FOLLOW", m["cells"])
        self.assertEqual(m["cells"]["FOLLOW"]["turn_pass"], 0)
        text = drills.render_measure(m)
        self.assertIn("| C2 | 2 | 2 | 50.0%", text)
        self.assertIn("ten worst phrasing families", text)
        self.assertEqual(m["worst_families"][0][2], 0)

    def test_cmd_measure_reads_gold_files_once_and_follows_the_run(self):
        import argparse
        import contextlib
        import io
        g1 = {"id": "W-D0001a", "world": "T01", "turns": [{"user": "show me open tasks", "gold": [{"type": "rows", "rows": ["a"]}],
                                                           "ref": [{"tool": "answer", "args": {"kind": "task", "where": "status = open"}}]}]}
        g2 = {"id": "W-D0001b", "world": "T01", "turns": [{"user": "show me done tasks", "gold": [{"type": "rows", "rows": ["b"]}],
                                                           "ref": [{"tool": "answer", "args": {"kind": "task", "where": "status = completed"}}]}]}
        g3 = {"id": "W-D0009a", "world": "T01", "turns": [{"user": "star priya", "gold": [{"type": "diff", "diff": {"rows": [], "links": []}}],
                                                           "ref": [{"tool": "act", "args": {"verb": "star", "name": "priya", "kind": "person"}}]}]}
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "kept.gold.jsonl").write_text("\n".join(json.dumps(x) for x in (g1, g2)) + "\n")
            (d / "T01.kept.gold.jsonl").write_text("\n".join(json.dumps(x) for x in (g1, g2)) + "\n")  # the same sessions in a second file
            (d / "extra.gold.jsonl").write_text(json.dumps(g3) + "\n")
            (d / "cells.json").write_text(json.dumps({"W-D0001a": {"cell": "C2", "pair": "W-D0001", "side": "a", "family": "read.1"},
                                                      "W-D0001b": {"cell": "C2", "pair": "W-D0001", "side": "b", "family": "read.1"}}))
            run = [{"id": x["id"], "turns": [{"user": t["user"], "steps": []} for t in x["turns"]]} for x in (g1, g2, g3)]
            (d / "run.jsonl").write_text("\n".join(json.dumps(x) for x in run) + "\n")
            fake = types.ModuleType("score")
            fake.score = lambda run_, gold_: {"sessions": [{"id": g["id"], "world": g["world"], "turns": [{"pass": True} for _ in g["turns"]]} for g in gold_]}
            old = sys.modules.get("score")
            sys.modules["score"] = fake
            try:
                def measured(**kw):
                    buf = io.StringIO()
                    with contextlib.redirect_stdout(buf):
                        drills.cmd_measure(argparse.Namespace(run=str(d / "run.jsonl"), gold=kw.get("gold"), cells=kw.get("cells"), md=None))
                    return buf.getvalue()
                self.assertIn("measured 2 sessions", measured(cells=str(d / "cells.json")))  # kept.gold.jsonl beside cells.json, once each
                self.assertIn("measured 3 sessions", measured(gold=str(d / "*.gold.jsonl")))  # any gold files, a session once
                out = measured(gold=str(d / "extra.gold.jsonl"))
                self.assertIn("measured 1 sessions", out)  # the run is the denominator
            finally:
                if old is None:
                    del sys.modules["score"]
                else:
                    sys.modules["score"] = old

    def test_label_classes(self):
        s = {"turns": [{"user": "delete all my tasks", "gold": [{"type": "decline", "reasons": ["unbounded_destruction"]}], "ref": [{"tool": "decline", "args": {"reason": "x"}}]},
                       {"user": "move night shift from friday to monday", "gold": [{"type": "diff", "diff": {"rows": [], "links": []}}],
                        "ref": [{"tool": "act", "args": {"verb": "reschedule", "kind": "event", "name": "n", "when": json.dumps(U("week", 0, weekday=5)), "args": "to: " + json.dumps(U("week", 1, weekday=1))}}]},
                       {"user": "put it in the kids list", "gold": [{"type": "diff", "diff": {"rows": [], "links": []}}], "ref": [{"tool": "act", "args": {"verb": "add_to", "rows": "$a", "args": "to: $b"}}]}]}
        self.assertEqual(drills.turn_label(s, 0), "JUDGE")
        self.assertEqual(drills.turn_label(s, 1), "DATES")
        self.assertEqual(drills.turn_label(s, 2), "CONT")


class Gaps(unittest.TestCase):
    def test_md_and_tiers(self):
        md = "### A: uncovered (1)\n\n- A: delete · person · prev\n\n### A: thin, under 3 uses corpus-wide (1)\n\n- A: edit · person · where: 2\n\n### B: uncovered (0)\n"
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cov.md"
            p.write_text(md)
            g = drills.Gaps(str(p))
        self.assertEqual(g.tier("A: delete · person · prev"), "uncovered")
        self.assertEqual(g.tier("A: edit · person · where"), "thin")
        self.assertEqual(g.tier("A: star · person · named"), "")
        self.assertEqual(g.tier_of({"A: star · person · named", "A: edit · person · where"}), "thin")
        self.assertEqual(drills.GAP_WEIGHT["uncovered"] / drills.GAP_WEIGHT[""], 3.0)
        self.assertEqual(drills.GAP_WEIGHT["thin"] / drills.GAP_WEIGHT[""], 2.0)

    @unittest.skipUnless(os.environ.get("NATIVETOOLS"), "needs the runtime export")
    def test_item_cells(self):
        g = drills.Gaps(None)
        T = types.SimpleNamespace
        turn = T(ref=[{"tool": "act", "args": {"verb": "delete", "rows": "@prev"}}], gold=[{"type": "diff", "diff": {"rows": [{"key": "priya_n", "change": "trashed"}], "links": []}}], user="x")
        cells = g.item_cells("T01", [turn])
        self.assertIn("A: delete · person · prev", cells)
        turn2 = T(ref=[{"tool": "answer", "args": {"kind": "task", "where": "effort < 60 minutes", "when": drills.jx(span(U("week", 0, weekday=5), Dt("2026-10-09")))}}], gold=[{"type": "rows", "rows": []}], user="y")
        cells2 = g.item_cells("T01", [turn2])
        self.assertIn("B: task.effort · < · unit", cells2)
        self.assertIn("C: task · from..to[rel+unit+weekday | date]", cells2)


class SourceSession(unittest.TestCase):
    def test_a_drill_carries_its_pair_tag_for_the_trainer(self):
        # train.py pair_of reads `pair:<id>`: without it the two siblings of a pair land in different steps
        turn = drills.Turn("tick off the dentist one", {"tool": "act"}, [{"tool": "act", "args": {"verb": "complete"}}])
        it = drills.Item("CM", "t", "f", "x", [turn], pair="T01-D0007", sid="T01-D0007a")
        tags = re.search(r"S\('T01-D0007a', '([^']*)'", drills.src_session(it)).group(1).split()
        self.assertEqual(tags[:3], ["drill", "cm", "pair:T01-D0007"])


# =============================================================================================================
# the five conventions the drills were measured against (round 2, #1044): operators, REF clauses, durations, FOLLOW linked_to, AMB
# =============================================================================================================

ROLE_WORLD = {
    "me": "Sam Park", "epoch": "2026-01-05T09:00", "currency": "USD",
    "people": [{"key": "ana", "name": "Ana Cole", "role": "dog walker", "met": "Ward 7 night"},
               {"key": "ben", "name": "Ben Ford", "role": "estate chairman", "met": "Coop assembly"},
               {"key": "cy", "name": "Cy Gray", "role": "estate treasurer", "met": "Coop assembly"},
               {"key": "di", "name": "Di Hall", "role": "head chef", "met": "Ward 7 day"},
               {"key": "ed", "name": "Ed Ito", "role": "plumber"}, {"key": "fay", "name": "Fay Jones", "role": "plumber"}],
}


def where_of(call: dict) -> list:
    return drill_dist.parse_where((call.get("args") or {}).get("where"))


def row_key(item: drills.Item) -> str:
    return item.turns[0].gold["diff"]["rows"][0]["key"]


class TextForms(unittest.TestCase):
    """Convention 1: a text condition is `=` the whole value, `contains` the whole value or `contains` a part of it, in the natural mix of its field
    (never one operator per field)."""

    @classmethod
    def setUpClass(cls):
        cls.ctx = drills.Ctx("T01", 1, set(), set(), world=ROLE_WORLD, today=TODAY)

    def facets(self, field):
        return {f.id: f for f in self.ctx.bank.facets("person") if f.groups == frozenset({field})}

    def test_the_proportions_are_the_natural_counts(self):
        # drill_dist.py over the 35 natural builds: role `=` 45, `contains` the whole value 18, `contains` a part 97 (+2 no row has); met 25 / 2 / 8 (+1)
        self.assertEqual(drills.TEXT_MIX["role"], (45, 18, 99))
        self.assertEqual(drills.TEXT_MIX["met"], (25, 2, 9))
        eq, has, part = drills.TEXT_MIX["role"]
        self.assertGreater(has + part, 2 * eq)  # a role is mostly `contains`
        eq, has, part = drills.TEXT_MIX["met"]
        self.assertGreater(eq, has + part)  # a place of meeting mostly `=`
        eq, has, part = drills.TEXT_MIX["body"]
        self.assertGreater(has + part, 9 * eq)

    def test_a_text_field_has_a_facet_per_form_sharing_the_natural_mix(self):
        fs = self.facets("role")
        self.assertEqual(set(fs), {"role", "role-has", "role-part"})
        self.assertAlmostEqual(sum(f.share for f in fs.values()), 1.0)
        mix = drills.TEXT_MIX["role"]
        for i, fid in enumerate(("role", "role-has", "role-part")):
            self.assertAlmostEqual(fs[fid].share, mix[i] / sum(mix), msg=fid)
        # a field with no part to say (every met value here has a word of four letters, but "Coop assembly" is the one twice) keeps the mix of the forms it has
        self.assertEqual(set(self.facets("met")), {"met", "met-has", "met-part"})

    def test_every_form_says_what_the_rows_have(self):
        v = self.ctx.v
        roles = {drills.fold(p["role"]) for p in v.of("person") if p.get("role")}
        for fid, f in self.facets("role").items():
            self.assertTrue(f.opts, fid)
            for o in f.opts:
                ((field, op, val),) = o.where
                self.assertEqual(field, "role")
                self.assertTrue(v.select("person", where=o.where), (fid, o.id))
                self.assertIn(val.lower(), " ".join(o.text(0)))  # the message says the value
                if fid == "role":
                    self.assertEqual(op, "=")
                    self.assertIn(drills.fold(val), roles)
                elif fid == "role-has":
                    self.assertEqual(op, "contains")
                    self.assertIn(drills.fold(val), roles)
                else:
                    self.assertEqual(op, "contains")
                    self.assertNotIn(drills.fold(val), roles)  # a part, never the whole
                    self.assertTrue(any(drills.fold(val) in r.split() for r in roles), val)  # a word of a role
                    self.assertIn(val, [drills.role_head(p["role"]) for p in v.of("person") if p.get("role")])  # the head of one

    def test_parts_are_words_never_the_whole(self):
        self.assertEqual(drills.text_parts("estate chairman"), ["chairman", "estate"])
        self.assertEqual(drills.text_parts("plumber"), [])
        self.assertEqual(drills.text_parts("Ward 7"), ["Ward"])
        self.assertEqual(drills.text_parts("Osgoode Hall", first=True), ["Osgoode", "Hall"])  # the distinctive word of a place leads
        self.assertEqual(drills.role_parts("product manager at Lumen")[:2], ["manager", "product"])  # the head, not the word after "at"
        self.assertEqual(drills.role_parts("friend of Chiamaka")[0], "friend")
        self.assertEqual(drills.role_parts("plumber"), [])
        self.assertEqual(drills.part_say("estate chairman", "chairman", False), "chairman")  # the head alone
        self.assertEqual(drills.part_say("estate chairman", "chairman", True), "estate chairman")  # or the whole role
        self.assertEqual(drills.part_say("Bengaluru cousin", "Bengaluru", False), "Bengaluru cousin")  # a modifier is never said alone
        self.assertEqual(drills.url_parts("https://dispatch.peachtreecomfort.com/login"), ["dispatch.peachtreecomfort.com", "peachtreecomfort"])
        self.assertEqual(drills.url_parts("https://uit.no"), ["uit.no"])

    def test_a_form_drawn_for_the_people_follows_the_mix(self):
        forms = collections.Counter()
        for w in ("T01", "T05", "T09", "T11", "T20", "T24"):
            ctx = drills.Ctx(w, 7, set(), set())
            for i in range(50):
                got = drills.pick_role_people(ctx.v, ctx.rng("roles", i), "log")
                if got:
                    forms[got[0]] += 1
                    for P, cond, say in got[1]:  # the condition singles the person out among everyone, and the message says its words
                        self.assertEqual(ctx.v.select("person", where=[cond]), [P["key"]])
        n = sum(forms.values())
        self.assertGreater(n, 250)
        self.assertTrue(all(forms[f] for f in drills.FORMS), forms)
        self.assertGreater(forms["part"] / n, 0.5)  # natural 0.61
        self.assertLess(forms["eq"] / n, 0.4)  # natural 0.28

    def test_generated_drills_carry_both_operators_on_a_role(self):
        ops = collections.Counter()
        for w in ("T05", "T20"):
            _ctx, pairs, _st = drills.gen_world(w, 7, 500, ["REF", "C2", "C3"], set())
            for a, b in pairs:
                for it in (a, b):
                    for t in it.turns:
                        for c in t.ref:
                            for f, op, val in where_of(c):
                                if f == "role":
                                    ops[op] += 1
        self.assertGreater(ops["="], 10)
        self.assertGreater(ops["contains"], 10)
        self.assertGreater(ops["contains"] / (ops["="] + ops["contains"]), 0.4)  # natural 0.72, the twins of a world can say a word of a role less often


class RefClauses(unittest.TestCase):
    """Convention 2: a trailing role clause is a filter only where the first name is shared, then in the natural forms; a person is also named by the
    role alone, as the natural sessions most often do."""

    def made(self, fn, tag, worlds=("T01", "T11", "T20"), n=25):
        out = []
        for w in worlds:
            ctx = drills.Ctx(w, 7, set(), set())
            for i in range(n):
                res = fn(ctx, ctx.rng(tag, i))
                if res:
                    out.append((ctx, res))
        return out

    def test_the_clause_is_a_filter_only_when_the_name_is_shared(self):
        got = self.made(drills.ref_clause, "clause")
        self.assertGreater(len(got), 20)
        for ctx, (a, b) in got:
            sides = [it.turns[0].ref[0]["args"] for it in (a, b)]
            filtered = [c for c in sides if "where" in c]
            plain = [c for c in sides if "where" not in c]
            self.assertEqual((len(filtered), len(plain)), (1, 1), sides)
            self.assertEqual(len(ctx.v.by_name("person", plain[0]["name"])), 1)  # the name alone names one person: no filter
            self.assertGreaterEqual(len(ctx.v.by_name("person", filtered[0]["name"])), 2)  # a namesake: the clause is the filter
            self.assertEqual(where_of({"args": filtered[0]})[0][0], "role")

    def test_twin_pairs_share_one_form_and_each_condition_singles_out_its_twin(self):
        got = self.made(drills.ref_role, "role")
        self.assertGreater(len(got), 20)
        forms = collections.Counter()
        for ctx, (a, b) in got:
            conds = []
            for it in (a, b):
                call = it.turns[0].ref[0]
                ((cond,)) = where_of(call)
                conds.append(cond)
                self.assertEqual(ctx.v.select("person", name=call["args"].get("name"), where=[cond]), [row_key(it)])
            whole = [any(drills.fold(c[2]) == drills.fold(p["role"]) for p in ctx.v.of("person") if p.get("role")) for c in conds]
            self.assertEqual(conds[0][1], conds[1][1])  # one operator on both siblings
            self.assertEqual(whole[0], whole[1])  # the whole role or a word of it, on both
            forms[(conds[0][1], whole[0])] += 1
        self.assertGreaterEqual(len(forms), 2, forms)
        names = [bool(it.turns[0].ref[0]["args"].get("name")) for _c, (a, _b) in got for it in (a,)]
        self.assertTrue(any(names) and not all(names))  # now and then the role alone names the person, as in the natural sessions

    def test_the_role_alone_names_no_one(self):
        got = self.made(drills.ref_roleonly, "only")
        self.assertGreater(len(got), 20)
        for ctx, (a, b) in got:
            for it in (a, b):
                call = it.turns[0].ref[0]
                self.assertNotIn("name", call["args"])
                ((cond,)) = where_of(call)
                self.assertEqual(ctx.v.select("person", where=[cond]), [row_key(it)])
            self.assertNotEqual(row_key(a), row_key(b))


class Durations(unittest.TestCase):
    """Convention 3: a duration stays in a field or a condition, never in a from..to span, and the words keep it apart from the date."""

    @classmethod
    def setUpClass(cls):
        cls.items = []
        for w in ("T01", "T05", "T10", "T20"):
            _ctx, pairs, _st = drills.gen_world(w, 7, 500, ["C2", "C3", "C4", "CM", "DATES"], set())
            cls.items += [it for a, b in pairs for it in (a, b)]

    @staticmethod
    def span(call: dict) -> bool:
        w = (call.get("args") or {}).get("when") or ""
        return '"from"' in w and '"to"' in w

    def test_a_write_that_mentions_a_duration_carries_no_span(self):
        n = 0
        for it in self.items:
            for t in it.turns:
                if drill_dist.DURATION.search(t.user) and any(c["tool"] == "act" for c in t.ref):
                    n += 1
                    for c in t.ref:
                        self.assertFalse(self.span(c), (t.user, c))
        self.assertGreater(n, 40)

    def test_a_read_keeps_a_span_beside_a_duration_no_more_often_than_natural(self):
        n = k = 0
        for it in self.items:
            for t in it.turns:
                for c in t.ref:
                    a = c.get("args") or {}
                    if c["tool"] in ("answer", "find", "compute") and any(f in (a.get("where") or "") for f in ("duration", "effort")):
                        n += 1
                        k += self.span(c)
        self.assertGreater(n, 100)
        self.assertLess(k / n, 0.3)  # natural 0.18; the drills wrote 0.39

    def test_the_gate_takes_the_span_from_a_date_beside_a_duration(self):
        span_o = drills.Opt("from monday to friday", [drills._tx(post="from monday to friday")], when=span(U("week", 0, weekday=1), U("week", 0, weekday=5)))
        point_o = drills.Opt("friday", [drills._tx(post="on friday")], when=U("week", 0, weekday=5))
        when = drills.Facet("when", "event", [span_o, point_o], frozenset({"when"}), rank=7)
        dur = drills.Facet("duration", "event", [drills.Opt("d", [drills._tx(post="over 60 minutes")], where=[("duration", ">", 60)])], frozenset({"duration"}), rank=6)
        status = drills.Facet("status", "event", [drills.Opt("s", [drills._tx(pre="tentative")], where=[("status", "=", "tentative")])], frozenset({"status"}), rank=1)

        def kept(chosen, always, n=200, **kw):
            k = 0
            for i in range(n):
                got, flips = drills.drop_duration_spans(chosen, [when], drills.rng("gate", str(i)), always, **kw)
                k += got is not None and any(len(o.when) == 2 for f in got if f.id == "when" for o in f.opts)
            return k / n

        self.assertEqual(kept([when, dur], always=True), 0.0)  # a write: never
        self.assertEqual(kept([when, status], always=True), 1.0)  # no duration: the date is left alone
        self.assertEqual(kept([when, status], always=True, says_duration=True), 0.0)  # the message says the new duration
        self.assertAlmostEqual(kept([when, dur], always=False), drills.KEEP_SPAN_WITH_DURATION, delta=0.12)  # a read: the natural share of the time
        only_span = drills.Facet("when", "event", [span_o], frozenset({"when"}), rank=7)
        self.assertEqual(drills.drop_duration_spans([only_span, dur], [only_span], drills.rng("g"), True), (None, None))  # nothing left to flip: no pair

    def test_the_duration_follows_the_date_in_the_words(self):
        when = drills.Facet("when", "event", [], frozenset({"when"}), rank=7)
        dur = drills.Facet("duration", "event", [], frozenset({"duration"}), rank=6)
        wo, do = drills.Opt("w", [drills._tx(post="from monday to friday")]), drills.Opt("d", [drills._tx(post="over 120 minutes")])
        self.assertEqual(drills.compose("event", [(dur, do), (when, wo)], 0), "events from monday to friday that are over 120 minutes")
        eff = drills.Facet("effort", "task", [], frozenset({"effort"}), rank=6)
        wt, eo = drills.Opt("w", [drills._tx(post="due friday")]), drills.Opt("e", [drills._tx(post="at least 30 minutes")])
        self.assertEqual(drills.compose("task", [(eff, eo), (when, wt)], 0), "tasks due friday that take at least 30 minutes")
        self.assertEqual(drills.compose("event", [(dur, do)], 0), "events over 120 minutes")  # no date: no connective
        self.assertEqual(drills.compose("event", [(when, wo)], 0), "events from monday to friday")

    def test_a_new_event_for_an_hour_keeps_the_length_in_the_duration_field(self):
        ctx = drills.Ctx("T01", 7, set(), set())
        seen = 0
        for i in range(30):
            res = drills.cm_event_duration(ctx, ctx.rng("ed", i))
            if not res:
                continue
            seen += 1
            lines = []
            for it in res:
                t = it.turns[0]
                call = t.ref[0]["args"]
                self.assertEqual((call["verb"], call["kind"]), ("create", "event"))
                fields = dict(ln.split(": ", 1) for ln in call["args"].split("\n"))
                self.assertEqual(set(fields), {"name", "date", "duration"})
                self.assertNotIn('"from"', fields["date"])  # the length is not a span of the date
                row = t.gold["diff"]["rows"][0]
                self.assertEqual((row["new"], row["fields"]["duration"]), ("event", int(fields["duration"])))
                self.assertTrue(drill_dist.DURATION.search(t.user), t.user)
                lines.append(fields)
            self.assertEqual((lines[0]["name"], lines[0]["date"]), (lines[1]["name"], lines[1]["date"]))  # the pair flips the length alone
            self.assertNotEqual(lines[0]["duration"], lines[1]["duration"])
        self.assertGreater(seen, 20)


class FollowLinkedTo(unittest.TestCase):
    """Convention 4: a follow-up leans on `linked_to` no more than the natural sessions do (writes of a later turn 3.2%, the reads of a first turn a quarter)."""

    def test_follow_writes_carry_no_more_linked_to_than_natural(self):
        n = k = 0
        for w in ("T01", "T05", "T10", "T20", "T30"):
            _ctx, pairs, _st = drills.gen_world(w, 7, 400, ["FOLLOW"], set())
            for a, b in pairs:
                for it in (a, b):
                    for t in it.turns[1:]:
                        for c in t.ref:
                            if c["tool"] == "act":
                                n += 1
                                k += "linked_to" in c["args"]
        self.assertGreater(n, 100)
        self.assertLessEqual(k / n, 0.05)

    def test_a_task_listing_is_read_through_a_list_only_part_of_the_time(self):
        tasks = linked = 0
        for w in ("T01", "T05", "T10", "T20"):
            ctx = drills.Ctx(w, 7, set(), set())
            for i in range(60):
                got = drills.sorted_listing(ctx, ctx.rng("sl", i), "complete")
                if got:
                    tasks += 1
                    linked += bool(got[1].get("linked_to"))
                    keys = got[2]
                    self.assertTrue(3 <= len(keys) <= 7)
                    self.assertEqual(len({drills.stamp_dt(ctx.v.rows[k]["date"]) for k in keys}), len(keys))  # an ordinal names one row
        self.assertGreater(tasks, 150)
        self.assertGreater(linked / tasks, 0.15)
        self.assertLess(linked / tasks, 0.5)  # LIST_LISTING 0.3

    def test_the_other_listings_say_the_same_rows_in_their_words(self):
        ctx = drills.Ctx("T20", 7, set(), set())
        found = drills.task_listings(ctx, ctx.rng("tl"), lambda n: 3 <= n <= 7)
        self.assertTrue(found)
        for args, keys, words in found:
            self.assertFalse(args.get("linked_to"))
            self.assertEqual(args["order"], "date asc")
            self.assertTrue(words.startswith(("open", "unfinished", "remaining", "outstanding")), words)
            when = json.loads(args["when"]) if args.get("when") else None
            where = [(f, op, int(x) if re.fullmatch(r"\d+", x) else x) for f, op, x in drill_dist.parse_where(args.get("where"))]  # a number is a number, as the call says it
            self.assertEqual(ctx.v.select("task", where=where, when=when, name=args.get("name"), order=("date", "asc")), keys)


class AmbCell(unittest.TestCase):
    """Convention 5: the ambiguous-selector cell is kept; it was held back for a runtime that composes the ask, which the binary now does."""

    def test_amb_templates_ask_and_are_not_held_back(self):
        ts = [t for t in drills.TEMPLATES if t.cell == "AMB"]
        self.assertTrue(ts and all(t.asks and not t.needs_m1 for t in ts))
        self.assertFalse(any(t.asks or t.needs_m1 for t in drills.TEMPLATES if t.cell != "AMB"))

    def test_amb_items_are_kept_when_their_pair_verifies(self):
        _ctx, pairs, st = drills.gen_world("T01", 7, 200, ["AMB"], set())
        self.assertGreater(len(pairs), 5)
        for a, b in pairs:
            for it in (a, b):
                self.assertFalse(it.needs_m1)
                self.assertTrue(drills.is_kept(it, True))
                self.assertFalse(drills.is_kept(it, False))  # a pair whose sibling failed is not for the corpus
            self.assertEqual(sorted(t.gold["type"] for it in (a, b) for t in it.turns), ["ask", "diff"])  # one side is the ask, the other settles it
        self.assertEqual(st["made"]["AMB"], len(pairs))

    def test_the_cells_file_of_a_run_says_no_amb_item_needs_the_binary(self):
        import argparse
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as d:
            ns = argparse.Namespace(worlds="T01", cells="AMB", templates=None, shares=None, out=d, avoid=None, weights=None, seed="1", per_world=40,
                                    no_build=True, jobs=1, split="train")
            with contextlib.redirect_stdout(io.StringIO()):
                drills.cmd_gen(ns)
            cells = json.loads((Path(d) / "cells.json").read_text())
        self.assertTrue(cells and all(m["cell"] == "AMB" and not m["needs_m1"] for m in cells.values()))


class DrillDist(unittest.TestCase):
    """The measuring script the five conventions are checked with (authored/gen/drill_dist.py), on made-up records."""

    def test_where_conditions_are_split_outside_quotes_and_brackets(self):
        got = drill_dist.parse_where('status in ("open", "in progress") and description contains "Ward and Co" and effort >= 30 minutes and role is set and person count > 1')
        self.assertEqual(got, [("status", "in", '"open", "in progress"'), ("description", "contains", "Ward and Co"), ("effort", ">=", "30 minutes"),
                               ("role", "is set", ""), ("person count", ">", "1")])
        self.assertEqual(drill_dist.parse_where(None), [])
        self.assertEqual(drill_dist.parse_where('role = "dentist"'), [("role", "=", "dentist")])

    def test_a_drill_is_a_pair_record_not_a_fire_drill(self):
        self.assertTrue(drill_dist.is_drill({"id": "train-T01-D0007a", "tags": ["drill", "cm", "pair:T01-D0007"]}))
        self.assertTrue(drill_dist.is_drill({"id": "T01-D0007b", "tags": []}))
        self.assertFalse(drill_dist.is_drill({"id": "train-T16-133", "tags": ["ask", "cancel", "fire", "drill", "never"]}))
        self.assertEqual(drill_dist.pair_of({"id": "train-T01-D0007a", "tags": []}), "T01-D0007")
        self.assertEqual(drill_dist.cell_of({"id": "x", "tags": ["drill", "ref", "person"]}), "REF")

    def test_durations_and_spans_in_a_message_and_a_call(self):
        for text in ("for half an hour", "two hours later", "it takes 45 minutes", "an hour and a half", "for 2 hrs"):
            self.assertTrue(drill_dist.DURATION.search(text), text)
        for text in ("at 7pm", "friday at 3", "two people", "a week later"):
            self.assertFalse(drill_dist.DURATION.search(text), text)
        self.assertTrue(drill_dist.has_span(drills.jx(span(U("week", 0, weekday=1), U("week", 0, weekday=5)))))
        self.assertFalse(drill_dist.has_span(drills.jx({"to": U("day", -1)})))

    def test_counts_a_made_up_record(self):
        def ref(user, tool, **args):
            return [{"role": "user", "content": "vault: x\n\n" + user}, {"role": "assistant", "tool": tool, "args": args, "think": ""}]
        rec = {"id": "train-T01-D0001a", "world": "T01", "n_turns": 2, "tags": ["drill", "follow", "pair:T01-D0001"],
               "messages": ref("star the plumber", "act", verb="star", kind="person", where='role contains "plumber"')
               + ref("and the other for an hour", "act", verb="edit", rows="@1", args="duration: 60", linked_to="#3")}
        pop = drill_dist.Pop("x")
        pop.add(rec, drill_dist.Worlds(drill_dist.NATIVE / "authored" / "worlds"))
        self.assertEqual(pop.ops[("role", "contains")], 1)
        self.assertEqual(pop.dur["duration/effort field in args"], 1)
        self.assertEqual(pop.lk[("act", "T1")], [1, 0])
        self.assertEqual(pop.lk[("act", "T2+")], [1, 1])
        self.assertEqual(pop.cells["FOLLOW"]["pairs"], {"T01-D0001"})
        self.assertEqual(dict(pop.form), {"where": 1, "rows @n": 1})


class Resume(unittest.TestCase):
    """A run killed part way is started again with the same arguments and goes on from the worlds it had built."""

    def test_a_world_built_from_the_same_sessions_is_not_built_again(self):
        from unittest import mock
        calls = []

        def fake(w, sdir, out, *a, **k):
            calls.append(w)
            for x in ("report.json", "anchoring.json", "gold.jsonl", "jsonl.gz"):
                (out / f"{w}.{x}").write_text("[]")
            return types.SimpleNamespace(stdout="", stderr="", returncode=0)

        with tempfile.TemporaryDirectory() as d, mock.patch.object(drills.common, "build_world", fake):
            out = Path(d)
            (out / "sessions").mkdir()
            (out / "sessions" / "T01_d01.py").write_text("x")
            drills.build_all(out, ["T01"], "train", 1, resume=True)
            self.assertEqual(calls, ["T01"])
            drills.build_all(out, ["T01"], "train", 1, resume=True)
            self.assertEqual(calls, ["T01"])  # the same sessions, built: not again
            (out / "sessions" / "T01_d01.py").write_text("y")
            drills.build_all(out, ["T01"], "train", 1, resume=True)
            self.assertEqual(calls, ["T01", "T01"])  # other sessions: built
            drills.build_all(out, ["T01"], "train", 1)
            self.assertEqual(len(calls), 3)  # without --resume: always
            (out / "T01.anchoring.json").unlink()
            drills.build_all(out, ["T01"], "train", 1, resume=True)
            self.assertEqual(len(calls), 4)  # an output missing: built

    def test_a_build_that_failed_leaves_no_stamp(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as d, mock.patch.object(drills.common, "build_world", lambda *a, **k: types.SimpleNamespace(stdout="", stderr="killed", returncode=-9)):
            out = Path(d)
            (out / "sessions").mkdir()
            (out / "sessions" / "T01_d01.py").write_text("x")
            drills.build_all(out, ["T01"], "train", 1, resume=True)
            self.assertFalse((out / "T01.built").exists())


if __name__ == "__main__":
    unittest.main()
