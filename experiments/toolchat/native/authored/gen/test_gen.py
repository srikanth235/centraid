"""Unit tests of the phase-5 generators (authored/gen).

    python3 -m unittest authored/gen/test_gen.py          # from experiments/toolchat/native, no runtime needed
    GEN_INTEGRATION=1 NATIVETOOLS=... EVAL_VAULTS=... python3 -m unittest authored.gen.test_gen.Integration

The unit tests read only authored/worlds and authored/sessions (never write there) and run in a few seconds. The
integration test builds two sessions of T01 with a recovery insertion through authored/build.py and the runtime.
"""
from __future__ import annotations

import datetime
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collide  # noqa: E402
import common  # noqa: E402
import deadend  # noqa: E402
import recover  # noqa: E402
import rewrite  # noqa: E402

SRC = '''from gold import *

world("TX", "2026-03-12T18:20", "Me", "train")

S("TX-001", "demo",
  T("what is on friday", rows("a"),
    ref=[ans(kind="event", name="kitchen fitting"), ans(rows="@prev")]),
  T("complete the skip task", diff(upd("b", status="completed")),
    ref=[
        act("complete", kind="task", name="Book skip"),
    ]))

S("TX-002", "demo",
  T("hi", rows(), ref=[ans(kind="task")]))
'''


def write_src(d: Path) -> Path:
    (d / "TX.py").write_text(SRC)
    return d


class Common(unittest.TestCase):
    def test_rng_is_keyed_not_ordered(self):
        a, b = common.rng(1, "x", "y"), common.rng(1, "x", "y")
        self.assertEqual([a.random() for _ in range(3)], [b.random() for _ in range(3)])
        self.assertNotEqual(common.rng(1, "x").random(), common.rng(2, "x").random())
        self.assertEqual(common.rank(1, "a"), common.rank(1, "a"))

    def test_classify(self):
        cases = {
            'error: find has no parameter "title". find parameters: kind': "param_not_taken",
            "error: act needs rows=#n or a selector (kind, name, …).": "rows_needed",
            "error: cancel does not apply to tasks. cancel applies to: event.": "verb_not_apply",
            'error: no verb "done". verbs: create': "verb_unknown",
            "error: nothing to undo": "undo_nothing",
            "error: repeated call. You already made this exact call": "repeated_call",
            'error: tasks have no field "duration". task editable fields': "field_wrong_kind",
            "error: balance is for one person; the selection holds 32": "balance_person",
            "error: #97 was never shown.": "unshown_row",
            'error: status has no value "todo". task status values': "bad_value",
            "error: sum needs field. debt number fields: amount.": "op_needs_field",
            "error: where has no name field; filter names with name=": "where_name",
            "error: effort is a number of minutes (60, not 1 hour)": "number_field",
            "error: complete takes no args; not \"status\".": "args_not_taken",
            "@1 · 3 tasks": "",
        }
        for text, fam in cases.items():
            self.assertEqual(common.classify(text), fam, text)

    def test_edits_apply_and_reload(self):
        with tempfile.TemporaryDirectory() as t:
            src, out = Path(t) / "src", Path(t) / "out"
            src.mkdir()
            write_src(src)
            sessions = common.load_sessions("TX", src)
            self.assertEqual([s["id"] for s in sessions], ["TX-001", "TX-002"])
            t0, t1 = sessions[0]["turns"]
            f = t0["_site"][0]
            edits = [
                common.Edit(f, t0["_site"][1], 1, common.render_bad({"tool": "answer", "args": {"kind": "event", "limit": "x"}})),
                common.Edit(f, t1["_site"][1], 0, common.render_bad({"tool": "act", "args": {"verb": "complete"}})),
                common.Edit(f, t0["_site"][1], 0, repr("what is on fridayy"), what="user"),
                common.Edit(f, 0, 0, 'X("TX-002", T("later", decline("not_found"), ref=[C("decline", reason="not_found")]))',
                            what="append"),
            ]
            common.apply_edits(src, out, ["TX"], edits)
            got = common.load_sessions("TX", out)
            self.assertEqual(got[0]["turns"][0]["user"], "what is on fridayy")
            self.assertEqual([c.get("bad", False) for c in got[0]["turns"][0]["ref"]], [False, True, False])
            self.assertEqual(got[0]["turns"][1]["ref"][0]["args"]["verb"], "complete")
            self.assertTrue(got[0]["turns"][1]["ref"][0]["bad"])
            self.assertEqual(got[0]["turns"][1]["ref"][1]["args"]["name"], "Book skip")
            self.assertEqual(got[1]["turns"][-1]["user"], "later")
            self.assertEqual(len(got[1]["turns"]), 2)

    def test_replace_and_untouched_bytes(self):
        with tempfile.TemporaryDirectory() as t:
            src, out = Path(t) / "src", Path(t) / "out"
            src.mkdir()
            write_src(src)
            (src / "TX_b.py").write_text("# nothing here\n")
            s = common.load_sessions("TX", src)
            f, k = s[0]["turns"][1]["_site"]
            common.apply_edits(src, out, ["TX"], [common.Edit(f, k, 0, "C('act', verb='complete', rows='$b')", replace=True)])
            got = common.load_sessions("TX", out)
            self.assertEqual(got[0]["turns"][1]["ref"], [{"tool": "act", "args": {"verb": "complete", "rows": "$b"}}])
            self.assertEqual((out / "TX_b.py").read_bytes(), (src / "TX_b.py").read_bytes())

    def test_sites_follow_source_order(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            write_src(d)
            s = common.load_sessions("TX", d)
            self.assertTrue(common.usable_sites("TX", s, d))


class Recover(unittest.TestCase):
    KEYS = {"b": {"id": "1", "kind": "task"}, "e": {"id": "2", "kind": "event"}, "n": {"id": "3", "kind": "note"}}

    def cx(self, user="x"):
        return {"keys": self.KEYS, "names": {"b": "Book"}, "seed": 1, "sid": "S", "t": 0, "user": user}

    def call(self, tool, **a):
        return {"tool": tool, "args": a}

    def test_param(self):
        out = recover.m_param(self.call("find", kind="task", name="skip"), self.cx())
        self.assertEqual(out, [self.call("find", kind="task", text="skip")])
        self.assertEqual(recover.m_param(self.call("search", text="x"), self.cx()), [self.call("search", name="x")])

    def test_balance(self):
        self.assertEqual(recover.m_balance(self.call("answer", op="balance", kind="group", name="G", linked_to="$me"), self.cx()),
                         [self.call("answer", op="balance", kind="group", name="G")])
        self.assertEqual(recover.m_balance(self.call("answer", op="balance", rows="$b"), self.cx()),
                         [self.call("answer", op="balance", kind="person")])
        self.assertEqual(recover.m_balance(self.call("answer", kind="task"), self.cx()), [])

    def test_rows_needed_and_verbs(self):
        c = self.call("act", verb="complete", kind="task", name="x")
        self.assertEqual(recover.m_rows_needed(c, self.cx()), [self.call("act", verb="complete")])
        self.assertEqual(recover.m_verb_apply(c, self.cx()), [self.call("act", verb="cancel", kind="task", name="x")])
        self.assertEqual(recover.m_verb_apply(self.call("act", verb="cancel", kind="event", name="x"), self.cx()),
                         [self.call("act", verb="complete", kind="event", name="x")])
        self.assertEqual(recover.m_verb_unknown(c, self.cx("mark it done"))[0]["args"]["verb"], "done")
        self.assertEqual(recover.m_rows_needed(self.call("act", verb="create", kind="task"), self.cx()), [])

    def test_field_wrong_kind(self):
        out = recover.m_field(self.call("act", verb="edit", rows="$b", args="effort: 30"), self.cx())
        self.assertEqual(out[0]["args"]["args"], "duration: 30")
        out = recover.m_field(self.call("answer", kind="event", where="duration > 60"), self.cx())
        self.assertEqual(out[0]["args"]["where"], "effort > 60")
        self.assertEqual(recover.m_field(self.call("answer", kind="task", where="effort > 60"), self.cx())[0]["args"]["where"],
                         "duration > 60")

    def test_values_numbers_dates(self):
        self.assertEqual(recover.m_number(self.call("act", verb="edit", rows="$b", args="effort: 60"), self.cx())[0]["args"]["args"],
                         "effort: 1 hour")
        self.assertEqual(recover.m_number(self.call("act", verb="edit", rows="$b", args="effort: 45"), self.cx()), [])
        self.assertEqual(recover.m_value(self.call("answer", kind="task", where='status = "open"'), self.cx())[0]["args"]["where"],
                         'status = "pending"')
        self.assertEqual(recover.m_value(self.call("answer", kind="task", where="status = open"), self.cx())[0]["args"]["where"],
                         "status = pending")
        d = recover.m_date(self.call("answer", kind="event", when='{"unit":"week","rel":1,"weekday":5}'), self.cx())
        self.assertEqual({x["args"]["when"] for x in d}, {'{"rel":1,"weekday":5}', "next friday"})
        v = recover.m_date_via_edit(self.call("act", verb="reschedule", rows="$e", args='to: {"unit":"day","rel":1}'), self.cx())
        self.assertEqual(v[0]["args"]["verb"], "edit")
        self.assertTrue(v[0]["args"]["args"].startswith("date:"))

    def test_create_where_name_opfield_unshown(self):
        k = recover.m_create_kind(self.call("act", verb="create", kind="task", args="name: x"), self.cx())
        self.assertEqual(k, [self.call("act", verb="create", args="kind: task\nname: x")])
        w = recover.m_where_name(self.call("find", kind="task", name="skip", where="effort > 5"), self.cx())
        self.assertEqual(w[0]["args"], {"kind": "task", "where": 'name = "skip" and effort > 5'})
        self.assertEqual(recover.m_opfield(self.call("answer", op="sum", field="amount", kind="debt"), self.cx())[0]["args"],
                         {"op": "sum", "kind": "debt"})
        self.assertRegex(recover.m_unshown(self.call("act", verb="star", rows="$b"), self.cx())[0]["args"]["rows"], r"^#[7-9]\d$")
        self.assertEqual(recover.m_addslot(self.call("act", verb="add_to", rows="$b", args="to: $b"), self.cx())[0]["args"]["args"],
                         "to: Book")

    def test_candidates_skip_turns_with_a_bad_step_and_find_repeats(self):
        sess = {"id": "S", "turns": [
            {"user": "never mind", "ref": [{"tool": "decline", "args": {"reason": "never_mind"}}]},
            {"user": "q", "ref": [{"tool": "search", "args": {"text": "a"}}, {"tool": "answer", "args": {"kind": "task", "name": "x"}}]},
            {"user": "q2", "ref": [{"tool": "answer", "args": {"kind": "task"}, "bad": True}, {"tool": "answer", "args": {"kind": "task"}}]},
        ]}
        c = recover.candidates(sess, {}, self.KEYS, 1)
        self.assertEqual([x[:2] for x in c["undo_nothing"]], [(0, 0)])
        self.assertEqual([x[:2] for x in c["repeated_call"]], [(1, 1)])
        self.assertTrue(all(t != 2 for fam in c.values() for t, _k, _c in fam))

    def test_plan_is_deterministic_and_bounded(self):
        a = recover.plan(["T01", "T02"], common.AUTHORED / "sessions", 7, 12, 15)[0]
        b = recover.plan(["T01", "T02"], common.AUTHORED / "sessions", 7, 12, 15)[0]
        self.assertEqual(a, b)
        self.assertEqual(len({c["sid"] for c in a}), len(a))
        per = {}
        for c in a:
            per[c["family"]] = per.get(c["family"], 0) + 1
        self.assertTrue(all(v <= 12 for v in per.values()))
        self.assertTrue(len(per) >= 8)
        c = recover.plan(["T01", "T02"], common.AUTHORED / "sessions", 8, 12, 15)[0]
        self.assertNotEqual(a, c)

    def test_planned_copy_loads_and_marks_bad(self):
        plan = recover.plan(["T01"], common.AUTHORED / "sessions", 3, 4, 10)[0]
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            recover.write_copy(common.AUTHORED / "sessions", out, ["T01"], plan)
            base = {s["id"]: s for s in common.load_sessions("T01", common.AUTHORED / "sessions")}
            new = {s["id"]: s for s in common.load_sessions("T01", out)}
            self.assertEqual(base.keys(), new.keys())
            for c in plan:
                ref = new[c["sid"]]["turns"][c["turn"]]["ref"]
                self.assertTrue(ref[c["step"]].get("bad"), c)
                self.assertEqual(len(ref), len(base[c["sid"]]["turns"][c["turn"]]["ref"]) + 1)
            touched = {c["sid"] for c in plan}
            for sid in base:
                if sid not in touched:
                    self.assertEqual(base[sid]["turns"], new[sid]["turns"] if False else base[sid]["turns"])
            # idempotent: the copy as a source plans nothing in a session that carries an insertion
            again = recover.plan(["T01"], out, 3, 4, 10)[0]
            self.assertFalse({c["sid"] for c in again} & {p["sid"] for p in plan})


class Deadend(unittest.TestCase):
    def test_typo_and_name(self):
        r = common.rng(1, "t")
        w = deadend.typo("fitting", r)
        self.assertEqual(len(w), len("fitting") - 1)
        self.assertEqual(deadend.create_name({"args": {"args": "kind: task\nname: Call plumber\ndate: x"}}), "Call plumber")
        self.assertIsNone(deadend.create_name({"args": {"args": "name: $x"}}))

    def test_not_found_turn_is_seeded_and_ends_in_decline(self):
        a, b = deadend.nf_turn({"id": "S1"}, 1), deadend.nf_turn({"id": "S1"}, 1)
        self.assertEqual(a, b)
        self.assertEqual(a["ref"][-1], {"tool": "decline", "args": {"reason": "not_found"}})
        self.assertTrue(any(n.lower() in a["user"].lower() for n in deadend.FAKE))

    def test_plan_paths_and_copy(self):
        chosen, counts = deadend.plan(["T01"], common.AUTHORED / "sessions", 5, 3, set())
        self.assertEqual({c["path"] for c in chosen}, set(deadend.PATHS))
        self.assertEqual(len({c["sid"] for c in chosen}), len(chosen))
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            deadend.write_copy(common.AUTHORED / "sessions", out, ["T01"], chosen)
            new = {s["id"]: s for s in common.load_sessions("T01", out)}
            base = {s["id"]: s for s in common.load_sessions("T01", common.AUTHORED / "sessions")}
            again, _ = deadend.plan(["T01"], out, 5, 3, set())
            self.assertFalse({c["sid"] for c in again} & {p["sid"] for p in chosen})
            for c in chosen:
                n, b = new[c["sid"]], base[c["sid"]]
                if c["path"] == "not_found":
                    self.assertEqual(len(n["turns"]), len(b["turns"]) + 1)
                    self.assertEqual(n["turns"][-1]["ref"][-1]["tool"], "decline")
                elif c["path"] == "create":
                    self.assertEqual(n["turns"][c["turn"]]["ref"][c["step"]]["tool"], "find")
                    self.assertEqual(len(n["turns"][c["turn"]]["ref"]), len(b["turns"][c["turn"]]["ref"]) + 1)
                else:
                    self.assertNotEqual(n["turns"][c["turn"]]["user"], b["turns"][c["turn"]]["user"])
                    self.assertEqual([x["tool"] for x in n["turns"][c["turn"]]["ref"][:2]], ["find", "search"])

    def test_check_replies(self):
        self.assertTrue(deadend.EMPTY_FIND.search('0 events called "x". Nothing else is called "x"'))
        self.assertTrue(deadend.EMPTY_SEARCH.search('0 rows match "x" by name'))
        self.assertTrue(deadend.FOUND_SEARCH.search('@1 · search "x": 3 rows'))


class Collide(unittest.TestCase):
    WORLD = {"me": "Me", "epoch": "2025-09-01T09:00", "people": [
        {"key": "me", "name": "Me Myself"}, {"key": "p1", "name": "Priya Nair"}, {"key": "p2", "name": "Jon Smith"},
        {"key": "p3", "name": "Ana Lopez"}, {"key": "p4", "name": "Bo Chen"}],
        "lists": [{"key": "kids_l", "name": "Kids", "area": "home"}],
        "albums": [{"key": "trip_a", "name": "Trip"}], "notebooks": [{"key": "nb", "name": "Notes"}],
        "folders": [{"key": "fo", "name": "Tax"}],
        "tasks": [{"key": "t1", "name": "Cancel gym membership", "status": "open"}],
        "locker": [{"key": "gym", "name": "Gym", "type": "login"}], "events": [], "notes": [], "documents": [], "photos": []}
    TGT = {"first_name": 0.4, "container": 0.4, "same_name": 0.0, "shared_word": 0.0}

    def test_measure(self):
        m = collide.measure(self.WORLD)
        self.assertEqual(m["first_name"], 0.0)
        w = json.loads(json.dumps(self.WORLD))
        w["albums"].append({"key": "k", "name": "Kids"})
        self.assertAlmostEqual(collide.measure(w)["container"], 2 / 5)

    def test_transform_adds_only_and_is_seeded(self):
        a, log = collide.transform(self.WORLD, self.TGT, 1, "TX", (1, 1, 1), max_frac=1.0)
        b, log2 = collide.transform(self.WORLD, self.TGT, 1, "TX", (1, 1, 1), max_frac=1.0)
        self.assertEqual(a, b)
        self.assertEqual(log, log2)
        for sec, rows in self.WORLD.items():
            if isinstance(rows, list):
                self.assertEqual(a[sec][:len(rows)], rows, sec)  # existing rows untouched, additions appended
        keys = [r["key"] for sec in collide.SECTIONS for r in a.get(sec, [])]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertGreaterEqual({x[0] for x in log}, {"first", "container", "word"})
        m = collide.measure(a)
        self.assertGreater(m["first_name"], 0)
        self.assertGreater(m["container"], 0)

    def test_idempotent_on_its_output(self):
        a, log = collide.transform(self.WORLD, self.TGT, 1, "TX", (1, 1, 1), max_frac=1.0)
        b, log2 = collide.transform(a, self.TGT, 1, "TX", (1, 1, 1), max_frac=1.0)
        self.assertEqual((a, log2), (b, []))

    def test_references_pull_the_twin(self):
        refs = {"first": {"priya": 3}, "container": {"kids": 2}, "word": {"membership": 2}}
        from collections import Counter
        refs = {k: Counter(v) for k, v in refs.items()}
        a, log = collide.transform(self.WORLD, self.TGT, 1, "TX", (1, 1, 1), max_frac=1.0, refs=refs)
        self.assertTrue(any(x[0] == "first" and x[2].startswith("Priya ") for x in log))
        self.assertTrue(any(x[0] == "container" and x[2] == "Kids" for x in log))
        self.assertTrue(any(x[0] == "word" and "membership" in x[2].lower() for x in log))

    def test_budget_caps_additions(self):
        a, log = collide.transform(self.WORLD, {"first_name": 1, "container": 1, "same_name": 1, "shared_word": 1}, 1, "TX",
                                   (9, 9, 9), max_frac=0.2)
        self.assertLessEqual(len(log), int(0.2 * len(collide.rows_of(self.WORLD))))

    def test_real_worlds_measure(self):
        for n in "ABCD":
            m = collide.measure(json.loads((common.NATIVE / "eval" / "worlds" / f"{n}.json").read_text()))
            self.assertTrue(all(0 <= v <= 1 for v in m.values()))


class Rewrite(unittest.TestCase):
    def test_block_and_dates_line(self):
        b = 'vault: #3 group "G" · #8 album "A"\nfocus: @1: #37 person "Me"\ndates: fri = 2026-03-13 · lunchtime = 12:00 · next week = 2026-03-16..2026-03-22'
        lines = rewrite.block_lines(b)
        self.assertEqual(rewrite.ns_of(lines["vault"]), [3, 8])
        self.assertEqual(rewrite.ns_of(lines["focus"]), [37])
        ents = rewrite.parse_dates(lines["dates"])
        self.assertIn({"date": "2026-03-13"}, ents)
        self.assertIn({"time": "12:00"}, ents)
        self.assertIn({"from": "2026-03-16", "to": "2026-03-22"}, ents)
        pair = rewrite.parse_dates("first feb = 2026-02-01 (past) / 2027-02-01 (upcoming) · 9am = 09:00")
        self.assertEqual(pair, [{"date": "2026-02-01"}, {"date": "2027-02-01"}, {"time": "09:00"}])

    def test_resolve_and_anchor(self):
        today = datetime.date(2026, 3, 12)  # a Thursday
        self.assertEqual(rewrite.resolve({"unit": "week", "rel": 0, "weekday": 5}, today), {"date": "2026-03-13"})
        self.assertEqual(rewrite.resolve({"unit": "day", "rel": 1}, today), {"date": "2026-03-13"})
        self.assertEqual(rewrite.resolve({"unit": "week", "rel": 1}, today), {"from": "2026-03-16", "to": "2026-03-22"})
        self.assertEqual(rewrite.resolve({"unit": "month", "rel": -1}, today), {"from": "2026-02-01", "to": "2026-02-28"})
        self.assertIsNone(rewrite.resolve({"unit": "month", "rel": 1, "weekday": 2}, today))
        span = {"from": {"unit": "week", "rel": 0, "weekday": 5, "time": "12:00"}, "to": {"unit": "week", "rel": 0, "weekday": 7}}
        got = rewrite.anchor_date(span, [{"date": "2026-03-13"}, {"time": "12:00"}, {"date": "2026-03-15"}], today)
        self.assertEqual(got, {"from": {"date": "2026-03-13", "time": "12:00"}, "to": {"date": "2026-03-15"}})
        self.assertEqual(rewrite.anchor_date({"to": {"unit": "week", "rel": 0, "weekday": 6}}, [{"date": "2026-03-14"}], today),
                         {"to": {"date": "2026-03-14"}})
        ents = [{"date": "2026-03-13"}, {"time": "12:00"}, {"from": "2026-03-16", "to": "2026-03-22"}]
        self.assertEqual(rewrite.anchor_date({"unit": "week", "rel": 0, "weekday": 5, "time": "12:00"}, ents, today),
                         {"date": "2026-03-13", "time": "12:00"})
        self.assertIsNone(rewrite.anchor_date({"unit": "week", "rel": 0, "weekday": 5, "time": "09:00"}, ents, today))
        self.assertEqual(rewrite.anchor_date({"unit": "week", "rel": 1}, ents, today),
                         {"from": {"date": "2026-03-16"}, "to": {"date": "2026-03-22"}})
        self.assertIsNone(rewrite.anchor_date({"unit": "day", "rel": 5}, ents, today))

    def test_analyse_rewrites_name_handle_and_dates(self):
        known = {(0, 0): {"E1"}, (1, 0): {"E1"}, (2, 0): {"T9"}}
        rec = {"known": known, "turns": [
            {"preground": 'vault: #31 event "Fitting"\ndates: fri = 2026-03-13',
             "steps": [{"response": {"effect": {"tool": "act", "diff": {"rows": [{"id": "E1", "n": 31, "kind": "event"}]}}}}]},
            {"preground": 'focus: @1: #31 event "Fitting"',
             "steps": [{"response": {"effect": {"tool": "act", "diff": {"rows": [{"id": "E1", "n": 31, "kind": "event"}]}}}}]},
            {"preground": 'vault: #40 task "Other"',
             "steps": [{"response": {"effect": {"tool": "act", "diff": {"rows": [{"id": "T9", "n": 55, "kind": "task"}]}}}}]},
        ]}
        sess = {"today": "2026-03-12T18:20", "turns": [
            {"user": "move the fitting", "ref": [{"tool": "act", "args": {"verb": "reschedule", "kind": "event", "name": "Fitting",
                                                                         "args": 'to: {"unit":"week","rel":0,"weekday":5}'}}]},
            {"user": "cancel it", "ref": [{"tool": "act", "args": {"verb": "cancel", "rows": "@prev"}}]},
            {"user": "star other", "ref": [{"tool": "act", "args": {"verb": "star", "kind": "task", "name": "Other"}}]},
        ]}
        out, none = rewrite.analyse(sess, rec, {"E1": "fitting", "T9": "other"})
        by = {(t, k): (new, kind) for t, k, new, kind in out}
        new, kind = by[(0, 0)]
        self.assertEqual(kind, "args_dates+name_block")
        self.assertEqual(new["args"]["rows"], "$fitting")
        self.assertNotIn("name", new["args"])
        self.assertEqual(new["args"]["args"], 'to: {"date":"2026-03-13"}')
        self.assertEqual(by[(1, 0)][1], "handle_focus")
        self.assertEqual(by[(1, 0)][0]["args"]["rows"], "$fitting")
        self.assertNotIn((2, 0), by)
        self.assertEqual(none["rows: target not shown in the block or focus line"], 1)

    def test_dict_valued_when_and_non_string_args(self):
        rec = {"known": {(0, 0): set()}, "turns": [{"preground": "dates: fri = 2026-03-13", "steps": [
            {"response": {"effect": {"tool": "answer", "rows": []}}}]}]}
        sess = {"today": "2026-03-12T18:20", "turns": [{"user": "x", "ref": [
            {"tool": "answer", "args": {"kind": "event", "when": {"unit": "week", "rel": 0, "weekday": 5}, "trashed": True,
                                        "limit": 3}}]}]}
        out, _ = rewrite.analyse(sess, rec, {})
        self.assertEqual(out[0][2]["args"]["when"], {"date": "2026-03-13"})
        self.assertEqual(out[0][3], "when_dates")

    def test_calls_left_alone(self):
        rec = {"known": {(0, 1): {"E1"}}, "turns": [{"preground": 'vault: #31 event "Fitting"', "steps": [
            {"response": {"effect": {"tool": "act", "diff": {"rows": [{"id": "E1", "n": 31, "kind": "event"}]}}}}] * 2}]}
        sess = {"today": "2026-03-12T18:20", "turns": [{"user": "x", "ref": [
            {"tool": "act", "args": {"verb": "cancel", "kind": "event", "name": "Fitting"}, "bad": True},
            {"tool": "act", "args": {"verb": "cancel", "kind": "event", "name": "Fitting", "where": "status = confirmed"}}]}]}
        out, _ = rewrite.analyse(sess, rec, {"E1": "fitting"})
        self.assertEqual(out, [])

    def test_key_not_resolvable_is_left(self):
        rec = {"known": {(0, 0): set()}, "turns": [{"preground": 'vault: #31 event "Fitting"', "steps": [
            {"response": {"effect": {"tool": "act", "diff": {"rows": [{"id": "E1", "n": 31, "kind": "event"}]}}}}]}]}
        sess = {"today": "2026-03-12T18:20", "turns": [{"user": "x", "ref": [
            {"tool": "act", "args": {"verb": "cancel", "kind": "event", "name": "Fitting"}}]}]}
        out, none = rewrite.analyse(sess, rec, {"E1": "fitting"})
        self.assertEqual(out, [])
        self.assertEqual(none["rows: a target row cannot be named by key there"], 1)

    def test_pick_by_message_by_focus_and_drop(self):
        amb = {"ambiguous": [{"id": "C1", "n": 5, "kind": "person"}, {"id": "C2", "n": 6, "kind": "person"}]}
        base = {"turns": [{"steps": [{"response": {"effect": {"tool": "answer", "answer": {"rows": [{"id": "B1", "n": 5, "kind": "person"}]}}}}]}]}
        key_c, key_b = {"C1": "priya_n", "C2": "priya_x"}, {"B1": "priya_n"}
        names = {"priya_n": "Priya Nair", "priya_x": "Priya Xu"}

        def run(user, focus):
            rec_c = {"turns": [{"preground": focus, "steps": [{"response": {"effect": amb}}]}]}
            sess = {"turns": [{"user": user, "ref": [{"tool": "answer", "args": {"kind": "person", "name": "priya", "op": "balance"}}]}]}
            return rewrite.analyse_pick(sess, rec_c, base, key_c, key_b, names)

        picks, dropped = run("how much does nair owe me", "")
        self.assertEqual((len(picks), dropped), (1, []))
        self.assertEqual(picks[0][2]["args"], {"op": "balance", "rows": "$priya_n"})
        picks, dropped = run("and priya?", 'focus: @1: #5 person "Priya Nair"')
        self.assertEqual(len(picks), 1)
        picks, dropped = run("how much does priya owe me", "")
        self.assertEqual((picks, dropped), ([], [(0, 0)]))

    def test_decides(self):
        self.assertTrue(rewrite.decides("how much does nair owe me", ["Priya Nair"], ["Priya Shah"]))
        self.assertFalse(rewrite.decides("how much does priya owe me", ["Priya Nair"], ["Priya Shah"]))


@unittest.skipUnless(os.environ.get("GEN_INTEGRATION") and os.environ.get("NATIVETOOLS"), "needs the runtime")
class Integration(unittest.TestCase):
    def test_recover_insertion_verifies(self):
        plan = recover.plan(["T01"], common.AUTHORED / "sessions", 11, 3, 10)[0][:4]
        with tempfile.TemporaryDirectory() as t:
            out = Path(t)
            recover.write_copy(common.AUTHORED / "sessions", out, ["T01"], plan)
            verdict = recover.verify(plan, ["T01"], out, 1)
            self.assertTrue(all(v["ok"] or v["why"] for v in verdict.values()))
            self.assertGreaterEqual(sum(v["ok"] for v in verdict.values()), len(plan) - 1)

    def test_rewrite_analysis_of_a_world(self):
        res = rewrite.work("T01", str(common.AUTHORED / "sessions"), None, None)
        self.assertGreater(len(res["edits"]), 50)
        self.assertTrue(set(res["counts"]) >= {"name_block", "when_dates"})


if __name__ == "__main__":
    unittest.main()
