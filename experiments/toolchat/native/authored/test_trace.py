"""Unit tests for the slot trace (authored/trace.py, CONTRACT_V3.md): the text round trip, the base slot rules on small
hand-built contexts, the trace -> call compiler, the refer rule, and the golden set (one think and call per distinct call
shape of the train data). The runtime side of the base slots is tested in crates/nativetools/tests/trace.rs;
`trace3_check.py` measures the rules on a built corpus.

    python3 -m unittest authored/test_trace.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("authored_trace", HERE / "trace.py")
T = importlib.util.module_from_spec(spec)
sys.modules["authored_trace"] = T
spec.loader.exec_module(T)

SYSTEM = {"role": "system", "content": "today: Friday 2026-03-13\nme: Sam Park\n\nvault directory:\nlists: Home (#1), Work (#2)"}


def user(text, block=""):
    return {"role": "user", "content": f"{block}\n\n{text}" if block else text}


def call(tool, **args):
    return {"role": "assistant", "think": "", "tool": tool, "args": {k: str(v) for k, v in args.items()}}


def tool(text):
    return {"role": "tool", "content": text}


def derive(history, tool_, args, **kw):
    return T.derive_slots({"tool": tool_, "args": args}, history, None, **kw)


class Slots(unittest.TestCase):
    """The base slots (`derive_slots`): what the call is for, which rows it takes and what the message says of them."""

    def test_a_selector_write_is_one_row_and_names_its_span(self):
        history = [SYSTEM, user("cancel the night shift on friday")]
        tr = derive(history, "act", {"verb": "cancel", "kind": "event", "name": "Night shift", "when": '{"unit":"week","rel":0,"weekday":5}'})
        s = tr.slots
        self.assertEqual(s["intent"][0], "write")
        self.assertEqual((s["verb"], s["scope"][0]), ("cancel", "one"))
        self.assertEqual(s["target"], ["night shift"])
        self.assertEqual(s["when"], ("q", "friday"))
        self.assertEqual(T.check_slots(tr.slots, {"tool": "act", "args": {"verb": "cancel", "kind": "event", "name": "Night shift", "when": '{"unit":"week","rel":0,"weekday":5}'}}, history), [])

    def test_a_follow_up_refers_to_the_result_and_both_needs_the_whole_of_it(self):
        history = [SYSTEM, user("what's on friday"), call("answer", kind="event"),
                   tool('answered:\n@1 · 2 events (showing 2)   [event: date]\n#5 [1] event "Gym" · Fri 2026-03-13\n#6 [2] event "Dentist" · Fri 2026-03-13'),
                   user("move both to monday")]
        args = {"verb": "reschedule", "rows": "@1", "args": 'to: {"unit":"week","rel":1,"weekday":1}'}
        s = derive(history, "act", args).slots
        self.assertEqual(s["scope"][0], "all")
        self.assertEqual(s["refer"][0], "both")
        self.assertEqual(s["refer"][2], ["@1"])
        one = derive(history, "act", {"verb": "reschedule", "rows": "#6", "args": args["args"]}).slots
        self.assertEqual(one["scope"][0], "one")
        self.assertNotEqual(one["refer"][0], "both")  # one row of the two is not "both"

    def test_a_pick_lists_the_shown_candidates_with_a_reason(self):
        block = 'vault: #7 task "Mend the gate" · #8 event "Mend the gate"'
        history = [SYSTEM, user("done with the mend the gate task", block)]
        s = derive(history, "act", {"verb": "complete", "rows": "#7"}).slots
        self.assertEqual(s["pick"][0], (7, None))
        self.assertEqual(s["pick"][1], (8, "kind"))

    def test_a_lookup_carries_the_intent_of_the_call_it_prepares(self):
        history = [SYSTEM, user("tick off the gate")]
        ahead = [call("act", verb="complete", rows="#3")]
        s = derive(history, "find", {"kind": "task", "name": "gate"}, ahead=ahead).slots
        self.assertEqual((s["intent"][0], s.get("verb")), ("write", "complete"))
        # the lookup's own outcome is not known yet: an ask or a decline after it does not leak back
        s = derive(history, "find", {"kind": "task", "name": "gate"}, ahead=[call("ask", question="which?", options="#3, #4")]).slots
        self.assertNotEqual(s["intent"][0], "ask")

    def test_a_value_with_no_source_is_an_error_unless_the_call_is_marked_bad(self):
        history = [SYSTEM, user("cancel the gig")]
        args = {"verb": "cancel", "kind": "event", "name": "Kaeltewelle live"}
        with self.assertRaises(T.TraceError) as cm:
            derive(history, "act", args)
        self.assertEqual(cm.exception.reason, "unsourced")
        self.assertEqual(derive(history, "act", args, bad=True).unsourced, [("name", "Kaeltewelle live")])

    def test_a_date_the_message_does_not_state_is_now_or_earlier(self):
        history = [SYSTEM, user("what's on the list")]
        s = derive(history, "answer", {"kind": "task", "when": '{"from":{"unit":"day","rel":0}}'}).slots
        self.assertEqual(s["when"], ("w", "now"))
        history = [SYSTEM, user("move the call to 3"), user("marcus")]
        s = derive(history, "act", {"verb": "reschedule", "kind": "event", "name": "Marcus", "args": 'to: {"unit":"day","rel":0,"anchor":"row","time":"15:00"}'}).slots
        self.assertEqual(s["when"], ("e", "3"))


# ---------------------------------------------------------------------------------------------
# the whole trace: one slot per call argument, and the call it compiles to
# ---------------------------------------------------------------------------------------------

FULL3 = "\n".join([
    "retry: rejected",
    'intent: write "move"',
    "verb: reschedule",
    'scope: some "both"',
    'refer: both "both" -> @3',
    'target: "night shift"',
    "kind: event",
    "name: Night shift",
    "where: status = \"open\" and effort > 30",
    'when: "friday" = from week+0 wd5 to day+1 row t',
    "linked_to: #30",
    "exclude: #34",
    "order: date asc",
    "limit: 2",
    "more: true",
    "set: to = ~week+1 wd5 t · notes = Dr Patel, 2 pm · list = #12",
    "time: 09:00 · 14:30",
    "pick: #12 ok · #13 no (kind)",
    "rows: #12, #13",
])


class TraceText(unittest.TestCase):
    def test_every_slot_round_trips(self):
        slots = T.parse3(FULL3)
        self.assertEqual(T.render3(slots), FULL3)
        self.assertEqual(slots["refer"], ("both", "both", ["@3"]))
        self.assertEqual(slots["pick"], [(12, None), (13, "kind")])
        self.assertEqual(slots["set"], [("to", "week+1 wd5 t", True), ("notes", "Dr Patel, 2 pm", False), ("list", "#12", False)])
        self.assertEqual(slots["when_expr"], "from week+0 wd5 to day+1 row t")
        self.assertEqual(slots["time"], ["09:00", "14:30"])
        self.assertEqual(T.parse3("intent: read\nrefer: none")["refer"], ("none", "", []))
        self.assertEqual(T.render3(T.parse3("intent: read\nrefer: none")), "intent: read\nrefer: none")

    def test_bare_forms(self):
        self.assertEqual(T.parse3("intent: count")["intent"], ("count", ""))
        self.assertEqual(T.parse3("intent: read\nrefer: it -> #7, #9")["refer"][2], ["#7", "#9"])
        self.assertEqual(T.parse3('intent: read "x"\nwhen: now')["when"], ("w", "now"))
        for when in ('when: "friday"', "when: now", "when: earlier"):
            self.assertEqual(T.render3(T.parse3(f"intent: read\n{when}")).split("\n")[1], when)

    def test_order_and_unknown_lines(self):
        for bad in ("kind: task\nintent: read", "intent: read\nplan: act", "intent: read\nset: nothing", "intent: read\nvia: grep",
                    "intent: read\nwhere: x\nkind: task", 'verb: cancel\nintent: write "x"', "scope: one"):
            with self.assertRaises(ValueError, msg=bad):
                T.parse3(bad)


class Compile(unittest.TestCase):
    def test_dates_round_trip_in_the_calls_own_key_order(self):
        for expr in ('{"unit":"week","rel":1,"weekday":5}', '{"unit":"day","rel":0,"anchor":"row","time":"09:00"}', '{"date":"2026-03-27","time":"15:00"}',
                     '{"from":{"unit":"week","rel":0,"weekday":1},"to":{"unit":"week","rel":0,"weekday":3}}', '{"to":{"unit":"month","rel":-1,"name":3}}',
                     '{"unit":"name","rel":0}' if False else '{"unit":"month","name":3,"rel":0}', '{"unit":"hour","rel":1,"time":"09:30","anchor":"row"}',
                     '{"date":"2026-03"}', '{"weekday":5}', '{"unit":"day","rel":-2}'):
            compact, times = T.date_to_compact(expr)
            self.assertEqual(json.dumps(T.date_from_compact(compact, list(times)), separators=(",", ":")), expr, compact)
        for bad in ('{"unit":"fortnight","rel":1}', '{"unit":"day","rel":"1"}', '{"foo":1}', '{"from":{"unit":"day","rel":0},"x":1}', '[1]'):
            with self.assertRaises(ValueError, msg=bad):
                T.date_to_compact(bad)

    def test_a_trace_states_the_whole_call(self):
        c = T.compile_call(FULL3)
        self.assertEqual(c["tool"], "act")
        self.assertEqual(list(c["args"]), ["verb", "rows", "kind", "name", "linked_to", "when", "where", "exclude", "order", "limit", "more", "args"])
        self.assertEqual(c["args"]["when"], '{"from":{"unit":"week","rel":0,"weekday":5},"to":{"unit":"day","rel":1,"anchor":"row","time":"09:00"}}')
        self.assertEqual(c["args"]["args"], 'to: {"unit":"week","rel":1,"weekday":5,"time":"14:30"}\nnotes: Dr Patel, 2 pm\nlist: #12')
        self.assertEqual(c["args"]["rows"], "#12, #13")  # an explicit slot wins over the ok rows of pick
        c = T.compile_call("intent: write\nverb: cancel\nscope: some\nrefer: both \"both\" -> @3\nkind: event")
        self.assertEqual(c["args"], {"verb": "cancel", "kind": "event", "rows": "@3"})  # rows stated by refer
        c = T.compile_call("intent: write\nverb: cancel\nscope: one\npick: #7 ok · #8 no (kind)")
        self.assertEqual(c["args"], {"verb": "cancel", "rows": "#7"})  # ... or by the ok rows of pick
        c = T.compile_call("intent: read\nvia: open\npick: #7 ok")
        self.assertEqual((c["tool"], c["args"]), ("open", {"row": "#7"}))
        self.assertEqual(T.compile_call('intent: read\nrefer: none "x"'.replace('refer: none "x"', "refer: none"))["tool"], "answer")

    def test_tools_follow_the_intent_or_via(self):
        self.assertEqual([T.compile_call(f"intent: {i}\nverb: star")["tool"] for i in ("read", "count", "write", "ask", "decline")],
                         ["answer", "answer", "act", "ask", "decline"])
        self.assertEqual(T.compile_call("intent: count\nvia: compute\nop: sum")["tool"], "compute")
        self.assertEqual(T.compile_call("intent: write\nvia: find\nverb: cancel\nkind: task")["args"], {"kind": "task"})  # a lookup has no verb

    def test_a_trace_that_is_not_a_call_does_not_compile(self):
        for bad in ("intent: write\nkind: task", "intent: read\nwhen: now = day+0 t", "intent: read\nwhen: now = day+0\ntime: 09:00",
                    "intent: read\nwhen: now = fortnight+1"):
            with self.assertRaises(T.CompileError, msg=bad):
                T.compile_call(bad)
        with self.assertRaises(T.CompileError):
            T.compile_call("not a trace")


class Generate(unittest.TestCase):
    def setUp(self):
        self.history = [SYSTEM, user("what's on friday"), call("answer", kind="event"),
                        tool('answered:\n@1 · 2 events (showing 2)   [event: date]\n#5 [1] event "Gym" · Fri 2026-03-13\n#6 [2] event "Dentist" · Fri 2026-03-13'),
                        user("move both to monday at 3")]

    def round_trip(self, history, tool_, args, **kw):
        tr = T.derive_trace3({"tool": tool_, "args": args}, history, None, **kw)
        self.assertEqual(T.check_call3(T.render3(tr.slots), {"tool": tool_, "args": args}, history), [])
        got = T.compile_call(T.render3(tr.slots))
        self.assertTrue(T.same_call(got, {"tool": tool_, "args": args}))
        return tr.slots

    def test_every_argument_has_a_slot(self):
        args = {"verb": "reschedule", "rows": "@1", "args": 'to: {"unit":"week","rel":1,"weekday":1,"time":"15:00"}'}
        s = self.round_trip(self.history, "act", args)
        self.assertNotIn("rows", s)  # stated by refer
        self.assertEqual(s["refer"][2], ["@1"])
        self.assertEqual(s["when_expr"] if "when_expr" in s else None, None)
        self.assertEqual(s["set"], [("to", "week+1 wd1 t", True)])
        self.assertEqual(s["time"], ["15:00"])
        # one row of the two: the ok row of pick states the rows argument (pick wins over refer)
        s = self.round_trip(self.history, "act", dict(args, rows="#6"))
        self.assertEqual(([n for n, why in s["pick"] if why is None], "rows" in s), ([6], False))
        # a rows argument neither pick nor refer states gets its own slot
        s = self.round_trip([SYSTEM, user("star the gym", 'vault: #5 event "Gym"')], "act", {"verb": "star", "rows": "#5"})
        self.assertEqual(s["rows"], "#5")

    def test_a_lookup_and_its_filters(self):
        history = [SYSTEM, user("the two biggest debts i owe")]
        args = {"kind": "debt", "where": 'direction = "i_owe" and status = "open"', "order": "amount desc", "limit": "2"}
        s = self.round_trip(history, "find", args)
        self.assertEqual((s["via"], s["kind"], s["order"], s["limit"]), ("find", "debt", "amount desc", "2"))

    def test_the_new_slots_of_the_diagnosis(self):
        history = [SYSTEM, user("search dubai")]
        s = self.round_trip(history, "search", {"text": "dubai", "kind": "task"})
        self.assertEqual((s["via"], s["text"], s["kind"]), ("search", "dubai", "task"))
        history = [SYSTEM, user("undo that"), call("act", verb="complete", rows="#3"), tool("completed: #3"), user("and that one too")]
        s = self.round_trip(history, "act", {"verb": "undo", "more": "true"})
        self.assertEqual(s["more"], "true")
        history = [SYSTEM, user("move samira's visit to 12 on the 31st")]
        s = self.round_trip(history, "act", {"verb": "reschedule", "kind": "event", "name": "Samira visit",
                                             "args": 'to: {"date":"2026-07-31","time":"12:00"}'})
        self.assertEqual(s["time"], ["12:00"])
        self.assertEqual(s["set"], [("to", "2026-07-31 t", True)])

    def test_a_call_the_trace_cannot_state_is_refused_with_its_reason(self):
        history = [SYSTEM, user("move the call to friday")]
        with self.assertRaises(T.TraceError) as cm:
            T.derive_trace3({"tool": "act", "args": {"verb": "reschedule", "kind": "event", "name": "Call",
                                                     "args": 'to: {"unit":"fortnight","rel":1}'}}, history, None)
        self.assertEqual(cm.exception.reason, "date-form")
        with self.assertRaises(T.TraceError) as cm:
            T.derive_trace3({"tool": "act", "args": {"verb": "star", "kind": "task", "name": "Call", "colour": "red"}}, history, None)
        self.assertIn(cm.exception.reason, ("roundtrip", "unsourced"))

    def test_a_quote_the_call_says_is_not_said_twice(self):
        history = [SYSTEM, user("cancel the night shift on friday")]
        s = self.round_trip(history, "act", {"verb": "cancel", "kind": "event", "name": "Night shift", "when": '{"unit":"week","rel":0,"weekday":5}'})
        self.assertEqual(s["name"], "Night shift")
        self.assertFalse(s.get("target"))


class Refer(unittest.TestCase):
    def test_previous_result_reads_the_context(self):
        self.assertFalse(T.has_prev_result([SYSTEM, user("what's on friday")]))
        h = [SYSTEM, user("what's on friday"), call("answer", kind="event"), tool('answered:\n@1 · 1 event (showing 1)\n#5 [1] event "Gym" · Fri'), user("star it")]
        self.assertTrue(T.has_prev_result(h))
        self.assertTrue(T.first_step(h))
        self.assertFalse(T.first_step(h + [call("act", verb="star", rows="@1")]))

    def test_refer_is_required_by_the_turn_and_the_previous_result_alone(self):
        first = [SYSTEM, user("star it")]
        self.assertFalse(T.refer_required(first))                      # first turn: nothing earlier to point at, whatever the words
        h = [SYSTEM, user("what's on friday"), call("answer", kind="event"), tool('answered:\n@1 · 1 event (showing 1)\n#5 [1] event "Gym" · Fri')]
        for text in ("star it", "add milk to the shopping list", "how many tasks are open", "never mind"):
            self.assertTrue(T.refer_required(h + [user(text)]), text)  # every turn after a result, cue or none
        self.assertFalse(T.refer_required(h))                          # not a first step
        self.assertFalse(T.refer_required(h + [user("a"), call("answer", kind="event")]))
        h0 = [SYSTEM, user("add milk"), call("act", verb="create", kind="task", name="Milk"), tool("done")]
        self.assertFalse(T.refer_required(h0 + [user("what else")]))   # no earlier turn showed rows

    def test_the_trace_of_a_turn_after_a_result_says_refer_none_when_the_call_names_no_rows(self):
        h = [SYSTEM, user("what's on friday"), call("answer", kind="event"), tool('answered:\n@1 · 1 event (showing 1)\n#5 [1] event "Gym" · Fri'),
             user("how many tasks are open")]
        tr = T.derive_trace3({"tool": "answer", "args": {"kind": "task", "op": "count"}}, h, None)
        self.assertEqual(tr.slots["refer"], ("none", "", []))
        first = T.derive_trace3({"tool": "answer", "args": {"kind": "event"}}, [SYSTEM, user("what's on friday")], None)
        self.assertNotIn("refer", first.slots)

    def test_a_follow_up_with_no_earlier_rows_says_refer_none(self):
        h = [SYSTEM, user("what's on friday"), call("answer", kind="event"), tool('answered:\n@1 · 1 event (showing 1)\n#5 [1] event "Gym" · Fri'),
             user("which of those need a reminder")]
        tr = T.derive_trace3({"tool": "answer", "args": {"kind": "event", "where": "reminder is set"}}, h, None)
        self.assertEqual(tr.slots["refer"], ("none", "", []))
        self.assertIn("\nrefer: none", T.render3(tr.slots))
        # not on a later step of the turn, and not when the trace already refers
        h2 = h + [call("find", kind="event"), tool("answered:\n@2 · 0 events")]
        tr = T.derive_trace3({"tool": "answer", "args": {"kind": "event"}}, h2, None)
        self.assertNotIn("refer", tr.slots)


class V31(unittest.TestCase):
    """CONTRACT_V3.md section 7: a date the dates line reads as `dates[i]`, a `where` of typed segments, `retry: <slot>`, the slots
    the runtime's `compile` op reads. The runtime side (the same text through the real op) is train/test_trace3.py."""

    DATES = "dates: next week = 2026-03-16..2026-03-22 · friday = 2026-03-13 (past) / 2026-03-20 (upcoming) · at 3pm = 15:00"
    HIST = [SYSTEM, {"role": "user", "content": DATES + "\n\nwhat is on next week"}]

    def test_where_is_typed_segments_and_the_call_the_runtime_spelling(self):
        for call_where, slot in (('status = "open"', "status = open"), ("status = open and effort > 60", "status = open · effort > 60"),
                                 ('role contains "hiking"', 'role contains "hiking"'), ("document count = 0", "document count = 0"),
                                 ("notes is empty", "notes is empty"), ('role in ("mother", "cousin")', 'role in ("mother", "cousin")'),
                                 ("starred = yes", "starred = yes"), ("amount > 35 BRL", "amount > 35 BRL"), ("effort > 1 hour", "effort > 1 hour"),
                                 ('nickname = "KC"', 'nickname = "KC"'), ('status != "cancelled"', "status != cancelled")):
            spelled = T.where_respell(call_where)
            self.assertEqual(spelled[1], slot, call_where)
            self.assertEqual(spelled[0].replace('"', ""), call_where.replace('"', ""))
            self.assertEqual(T.where_respell(spelled[0]), spelled)  # idempotent: a canonical where is its own spelling
        self.assertEqual(T.where_respell("status = open")[0], 'status = "open"')
        self.assertIsNone(T.where_respell("whichever tasks are due"))
        self.assertIsNone(T.where_respell("status == open"))

    def test_the_slot_compiles_to_the_call_in_one_spelling(self):
        c = T.compile_call('intent: read\nkind: task\nwhere: status = open · effort > 60')
        self.assertEqual(c["args"]["where"], 'status = "open" and effort > 60')
        self.assertEqual(T.slots_json(T.parse3('intent: read\nkind: task\nwhere: status = open · effort > 60'))["where"],
                         [{"field": "status", "op": "=", "value": "open"}, {"field": "effort", "op": ">", "value": 60}])
        free = T.slots_json(T.parse3("intent: read\nkind: task\nwhere: whichever"))
        self.assertEqual(free["where"], "whichever")  # a free string goes to the runtime as text, which refuses it

    def test_the_dates_line_entries_and_their_readings(self):
        e = T.dates_entries(self.DATES)
        self.assertEqual([p for p, _ in e], ["next week", "friday", "at 3pm"])
        self.assertEqual(T.reading_expr(e[0][1]), {"from": {"date": "2026-03-16"}, "to": {"date": "2026-03-22"}})
        self.assertEqual(T.reading_expr(e[1][1], "upcoming"), {"date": "2026-03-20"})
        with self.assertRaises(ValueError):
            T.reading_expr(e[1][1])  # two readings, none chosen
        with self.assertRaises(ValueError):
            T.reading_expr(e[2][1])  # a clock alone is not a date
        self.assertEqual(T.date_text({"time": "15:00", "date": "2026-03-20"}), '{"date":"2026-03-20","time":"15:00"}')
        self.assertEqual(T.date_anchor('{"date":"2026-03-13"}', self.DATES), "dates[1] past")
        self.assertEqual(T.date_anchor({"from": {"date": "2026-03-16"}, "to": {"date": "2026-03-22"}}, self.DATES), "dates[0]")
        self.assertIsNone(T.date_anchor('{"unit":"week","rel":1}', self.DATES))  # equal in meaning, not as written: typed
        self.assertIsNone(T.date_anchor('{"unit":"week","rel":1}', None))

    def test_a_pick_of_the_dates_line_is_in_the_trace_and_compiles_against_the_line(self):
        args = {"kind": "event", "when": '{"to":{"date":"2026-03-22"},"from":{"date":"2026-03-16"}}'}
        tr = T.derive_trace3({"tool": "answer", "args": args}, self.HIST)
        self.assertEqual(tr.slots["when_expr"], "dates[0]")
        self.assertIn("= dates[0]", T.render3(tr.slots))
        self.assertEqual(tr.call["args"]["when"], '{"from":{"date":"2026-03-16"},"to":{"date":"2026-03-22"}}')  # the one key order
        self.assertEqual(T.compile_call(T.render3(tr.slots), self.DATES)["args"]["when"], tr.call["args"]["when"])
        with self.assertRaises(T.CompileError):
            T.compile_call(T.render3(tr.slots))  # without the line the pick has nothing to read
        with self.assertRaises(T.CompileError):
            T.compile_call("intent: read\nkind: event\nwhen: now = dates[7]", self.DATES)
        self.assertEqual(T.slots_json(tr.slots)["when"], {"pick": {"date": 0}})
        self.assertEqual(tr.mentions["dates_anchored"], 1)
        self.assertEqual(tr.mentions["class"], "anchored")

    def test_a_date_in_a_set_line_and_a_reading_two_readings_need(self):
        hist = [SYSTEM, {"role": "user", "content": self.DATES + "\n\nmove the dentist to friday"}]
        args = {"verb": "reschedule", "name": "Dentist", "kind": "event", "args": 'to: {"date":"2026-03-20"}'}
        tr = T.derive_trace3({"tool": "act", "args": args}, hist)
        self.assertEqual(tr.slots["set"], [("to", "dates[1] upcoming", True)])
        self.assertEqual(T.slots_json(tr.slots)["set"], [{"key": "to", "date": {"pick": {"date": 1, "reading": "upcoming"}}}])
        self.assertEqual(T.compile_call(T.render3(tr.slots), self.DATES)["args"]["args"], 'to: {"date":"2026-03-20"}')

    def test_a_date_the_line_does_not_read_stays_typed_and_a_where_that_is_not_typed_is_refused(self):
        tr = T.derive_trace3({"tool": "answer", "args": {"kind": "event", "when": '{"unit":"week","rel":1}'}}, self.HIST)
        self.assertEqual(tr.slots["when_expr"], "week+1")
        self.assertEqual(tr.mentions["dates_free"], 1)
        self.assertEqual(tr.mentions["class"], "free")
        hist = [SYSTEM, user("whichever tasks are due")]
        with self.assertRaises(T.TraceError) as cm:
            T.derive_trace3({"tool": "answer", "args": {"kind": "task", "where": "whichever == 3"}}, hist)
        self.assertEqual(cm.exception.reason, "where-form")
        T.derive_trace3({"tool": "answer", "args": {"kind": "task", "where": "whichever == 3"}}, hist, bad=True)  # a repair call may be wrong

    def test_the_rows_an_error_lists_are_text_not_pick_candidates(self):
        """The runtime numbers a row only when a block or a result shows it; the rows an error reply names ("the selection holds
        3: #40 ...") are text. A pick over them is a pick the compile op refuses."""
        err = 'error: balance is for one person; the selection holds 3: #40 person "Al Ng", #41 person "Bo Li", #32 person "Marisol Garza"'
        hist = [SYSTEM, user("what's my balance with marisol"), call("answer", op="balance", kind="person"), tool(err)]
        tr = T.derive_slots({"tool": "answer", "args": {"op": "balance", "rows": "#32"}}, hist, None, retry=True)
        self.assertNotIn("pick", tr.slots)
        self.assertEqual(T.build_ctx(hist).lists[-1].kind, "error")
        shown = hist[:3] + [tool('answered:\n@1 · 3 persons (showing 3)   [person]\n#40 [1] person "Al Ng"\n#41 [2] person "Bo Li"\n#32 [3] person "Marisol Garza"')]
        tr = T.derive_slots({"tool": "answer", "args": {"op": "balance", "rows": "#32"}}, shown, None)
        self.assertEqual([n for n, _ in tr.slots["pick"]], [40, 41, 32])  # a result does show them

    def test_the_trace_respells_a_where_in_the_record(self):
        hist = [SYSTEM, user("which tasks are open")]
        tr = T.derive_trace3({"tool": "answer", "args": {"kind": "task", "where": "status = open"}}, hist)
        self.assertEqual(tr.call["args"]["where"], 'status = "open"')
        self.assertEqual(tr.slots["where"], "status = open")

    def test_retry_names_the_slot(self):
        for line, want in (("retry: rejected", True), ("retry: where[1]", "where[1]"), ("retry: pick", "pick")):
            self.assertEqual(T.parse3(line + '\nintent: read')["retry"], want)
            self.assertEqual(T.render3(T.parse3(line + '\nintent: read')), line + '\nintent: read')
        with self.assertRaises(ValueError):
            T.parse3('retry: Where 1\nintent: read')

    def test_the_slots_the_runtime_reads(self):
        s = T.parse3('intent: write\nverb: edit\nscope: one\nrefer: it "it" -> @1\nkind: task\nlinked_to: #4\nlimit: 3\nmore: true\n'
                     'set: name = Milk · to = ~2026-03-27 t\ntime: 15:00')
        j = T.slots_json(s)
        self.assertEqual(j["linked_to"], [{"pick": {"row": "#4"}}])
        self.assertEqual(j["set"], [{"key": "name", "value": "Milk"}, {"key": "to", "date": {"date": "2026-03-27", "time": "15:00"}}])
        self.assertEqual((j["limit"], j["more"], j["verb"], j["intent"]), (3, True, "edit", "write"))
        for dropped in ("refer", "scope", "time", "retry"):
            self.assertNotIn(dropped, j)
        # the rows a refer states are given when no slot or pick does, and a pick's verdicts go as written
        j = T.slots_json(T.parse3('intent: write\nverb: complete\nrefer: it "it" -> @2'))
        self.assertEqual(j["rows"], ["@2"])
        j = T.slots_json(T.parse3('intent: write\nverb: complete\npick: #5 ok · #6 no (name)'))
        self.assertEqual(j["pick"], [{"row": "#5", "verdict": "ok"}, {"row": "#6", "verdict": "no"}])
        self.assertNotIn("rows", j)

    def test_a_compiled_reply_as_a_call(self):
        reply = {"call": {"tool": "act", "args": {"verb": "complete", "rows": ["#5", "#6"], "more": True, "limit": 2}}}
        self.assertEqual(T.runtime_call(reply), {"tool": "act", "args": {"verb": "complete", "rows": "#5, #6", "more": "true", "limit": "2"}})

    def test_same_call_compares_a_date_as_the_object_it_spells(self):
        a = {"tool": "answer", "args": {"when": '{"from":{"date":"2026-03-16"},"to":{"date":"2026-03-22"}}'}}
        b = {"tool": "answer", "args": {"when": '{"to":{"date":"2026-03-22"},"from":{"date":"2026-03-16"}}'}}
        self.assertTrue(T.same_call(a, b))
        self.assertFalse(T.same_call(a, {"tool": "answer", "args": {"when": '{"date":"2026-03-16"}'}}))

    def test_what_a_call_refers_to(self):
        m = T.mentions("answer", {"kind": "task", "name": "Milk"}, T.parse3("intent: read\nkind: task\nname: Milk"))
        self.assertEqual((m["names"], m["class"]), (1, "free"))
        m = T.mentions("act", {"verb": "create", "name": "Milk"}, T.parse3("intent: write\nverb: create\nname: Milk"))
        self.assertEqual((m["names"], m["class"]), (0, "none"))  # a new value, not a mention
        m = T.mentions("act", {"verb": "edit", "rows": "#4", "name": "Milk"}, T.parse3("intent: write\nverb: edit\nname: Milk\nrows: #4"))
        self.assertEqual((m["rows"], m["names"], m["class"]), (1, 0, "anchored"))


class V4(unittest.TestCase):
    """CONTRACT_V3.md section 8: the v4 trace. Its slots, how it compiles, what the compile step infers, and the converter from a
    v3.1 think. The runtime side (the same slots through the real op) is crates/nativetools/tests/phase7_v4.rs."""

    BLOCK = ('vault: #31 task "Pay rent" · #32 person "Chioma Eze" · #33 event "Kids dentist"\n'
             'focus: created #34 task "Water the plants" · @1: #35 note "Dal recipe" · asked: #36 person "Priya Nair" '
             '(charge nurse · Ward 7)\nresult line')

    def hist(self, text, block=None):
        return [SYSTEM, user(text, self.BLOCK if block is None else block)]

    def test_a_v4_trace_round_trips_through_its_text(self):
        for text in ('intent: write "star"\nverb: star\npick: #31 (focus)',
                     'retry: where[0]\nintent: read\nkind: task\nwhere: status = open\nlinked_to: #8',
                     'intent: write "mark"\nverb: complete\nrows: @2',
                     'intent: write\nverb: create\nkind: task\nwhen: "friday" = dates[0]\nset: name = Milk · due = ~dates[0]'):
            self.assertEqual(T.render3(T.parse4(text)), text)
            self.assertEqual(T.render4(T.parse4(text)), text)
        self.assertEqual(T.parse4("intent: write\nverb: star\npick: #5 (nick)")["pick"], [(5, None)])
        self.assertEqual(T.parse4("intent: write\nverb: star\npick: #5 (nick)")["pick_reason"], "nick")

    def test_the_slots_v4_drops_are_not_v4_and_v4_picks_are_not_v31(self):
        for text in ('intent: write\nscope: one', 'intent: read\nrefer: none', 'intent: read\ntarget: "x"', "intent: read\nvia: find\nkind: task",
                     "intent: write\nverb: star\npick: #5 ok · #6 no (kind)", "intent: write\nverb: star\npick: #5 (position)",
                     "intent: write\nverb: star\nrows: #5\npick: #5 (name)", "intent: write\nverb: star\npick: #5 (name)\nrows: #5"):
            with self.assertRaises(ValueError, msg=text):
                T.parse4(text)
        with self.assertRaises(ValueError):
            T.parse3("intent: write\nverb: star\npick: #5 (focus)")

    def test_the_version_is_read_off_a_construct_of_one_of_them_else_the_mode(self):
        bare = "intent: read\nkind: task"
        self.assertNotIn("v", T.parse_any(bare, "v3.1"))
        self.assertEqual(T.parse_any(bare, "v4")["v"], 4)
        self.assertEqual(T.parse_any("intent: read\nscope: one", "v4").get("v"), None)  # a v3.1 construct wins over the mode
        self.assertEqual(T.parse_any("intent: write\nverb: star\npick: #5 (name)", "v3.1")["v"], 4)
        with mock.patch.dict(os.environ):
            os.environ.pop("NATIVE_TRACE", None)
            self.assertEqual(T.default_mode(), "v4")
            for value in ("v3.1", "v3", "3.1", "3"):
                os.environ["NATIVE_TRACE"] = value
                self.assertEqual(T.default_mode(), "v3.1", value)
            os.environ["NATIVE_TRACE"] = "v4"
            self.assertEqual(T.default_mode(), "v4")

    def test_a_pick_states_the_rows_beside_another_handle_slot(self):
        c = T.compile_call("intent: write\nverb: complete\npick: #31 (name)\nwithin: @1", None, "v4")
        self.assertEqual(c["args"], {"verb": "complete", "rows": "#31", "within": "@1"})
        c = T.compile_call("intent: read\nvia: open\npick: #31 (name)", None, "v4")
        self.assertEqual(c, {"tool": "open", "args": {"row": "#31"}})

    def test_an_act_that_names_a_row_takes_the_kind_of_its_verb(self):
        want = {"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "Pay rent"}}
        self.assertEqual(T.compile_call("intent: write\nverb: complete\nname: Pay rent", None, "v4"), want)
        self.assertEqual(T.compile_call("intent: write\nverb: complete\nkind: task\nname: Pay rent", None, "v4"), want)
        self.assertNotIn("kind", T.compile_call("intent: write\nverb: complete\nname: Pay rent", None, "v3.1")["args"])
        for text in ("intent: write\nverb: delete\nname: Pay rent", "intent: read\nname: Pay rent", "intent: write\nverb: complete\npick: #31 (name)",
                     "intent: write\nverb: complete\nname: Pay rent\nwithin: @1"):  # a handle slot carries the kind
            self.assertNotIn("kind", T.compile_call(text, None, "v4")["args"], text)

    def test_a_pick_reason_is_read_from_the_context(self):
        def reason(n, text, block=None):
            return T.pick_reason(T.build_ctx(self.hist(text, block)), n)
        self.assertEqual(reason(34, "and delete it"), "created")
        self.assertEqual(reason(35, "and delete it"), "focus")
        self.assertEqual(reason(36, "and delete it"), "asked")
        self.assertEqual(reason(31, "tick off the rent"), "name")
        self.assertEqual(reason(34, "tick off the plants"), "name")  # the message names it: not a back reference
        self.assertEqual(reason(32, "rang chi", self.BLOCK.replace('person "Chioma Eze"', 'person "Chioma Eze" · nickname "Chi"')), "nick")
        self.assertEqual(reason(33, "move it to friday", 'vault: #33 event "Kids dentist" · Thu 2026-03-12 10:00'), "date")
        self.assertEqual(reason(33, "move it", 'vault: #33 event "Kids dentist"'), "kind")
        self.assertEqual(T.reason_hint({"refer": ("it", "", ["@1"])}), "focus")
        self.assertEqual(T.reason_hint({"pick": [(1, None), (2, "name")]}), "name")

    def test_an_acted_part_of_the_focus_line_is_its_own_segment(self):
        """The `acted ...` part sits after the sets and before `asked:`; a pick of its row is `focus`, not `created`."""
        block = ('vault: #31 task "Pay rent"\n'
                 'focus: created #34 task "Water the plants" · acted #37 task "Call Ama", #38 event "Dentist" · '
                 '@1: #35 note "Dal recipe" · asked: #36 person "Priya Nair"\nresult line')
        self.assertEqual(T.focus_sets(block), [("created", {34}), ("focus", {37, 38}), ("focus", {35}), ("asked", {36})])
        short = 'focus: created #34 task "Water the plants" · acted #37 task "Call Ama"\nresult line'
        self.assertEqual(T.focus_sets(short), [("created", {34}), ("focus", {37})])
        h = self.hist("and delete it", block)
        ctx = T.build_ctx(h)
        self.assertEqual(T.pick_reason(ctx, 37), "focus")
        self.assertEqual(T.pick_reason(ctx, 34), "created")
        self.assertEqual(T.pick_reason(ctx, 36), "asked")

    def test_the_converter_drops_what_the_compile_step_infers(self):
        h = self.hist("tick off the rent")
        got = T.v4_think('intent: write "tick off"\nverb: complete\nscope: one\nrefer: none\ntarget: "rent"\npick: #31 ok · #33 no (kind)', h)
        self.assertEqual(got, 'intent: write "tick off"\nverb: complete\npick: #31 (name)')
        # a result handle and several rows are a rows slot, one row of an earlier turn a pick with its reason
        self.assertEqual(T.v4_think('intent: write "delete"\nverb: delete\nscope: all "them"\nrefer: both "them" -> @1', h),
                         'intent: write "delete"\nverb: delete\nrows: @1')
        self.assertEqual(T.v4_think('intent: write "delete"\nverb: delete\nscope: some\nrows: #31, #33', h), 'intent: write "delete"\nverb: delete\nrows: #31, #33')
        h2 = self.hist("and delete it")
        self.assertEqual(T.v4_think('intent: write "delete"\nverb: delete\nscope: one\nrefer: it "it" -> #35', h2), 'intent: write "delete"\nverb: delete\npick: #35 (focus)')
        # the kind goes only when the verb fixes it and a name selects
        self.assertEqual(T.v4_think('intent: write "done"\nverb: complete\nscope: one\nkind: task\nname: Pay rent', h), 'intent: write "done"\nverb: complete\nname: Pay rent')
        keep = 'intent: write "remove"\nverb: delete\nscope: one\nkind: task\nname: Pay rent'
        self.assertIn("kind: task", T.v4_think(keep, h))
        # a v4 think is itself; a lookup has no v4 form
        self.assertEqual(T.v4_think('intent: write\nverb: star\npick: #5 (nick)', h), 'intent: write\nverb: star\npick: #5 (nick)')
        with self.assertRaises(T.V4Skip) as e:
            T.v4_think('intent: read\nvia: find\nkind: task\nname: Pay rent', h)
        self.assertEqual(e.exception.reason, "find")

    def test_the_v4_think_compiles_to_the_v31_calls_where_a_date_is_picked(self):
        dates = "dates: friday = 2026-03-13 · at 3pm = 15:00"
        h = [SYSTEM, {"role": "user", "content": dates + "\n\nmove it to friday"}]
        t3 = 'intent: write "move"\nverb: reschedule\nscope: one\nrefer: none\nkind: event\nname: Dentist\nwhen: "friday" = dates[0]\nset: to = ~dates[0]'
        t4 = T.v4_think(t3, h)
        self.assertNotIn("scope", t4)
        self.assertEqual(T.compile_call(t4, dates, "v4"), T.compile_call(t3, dates))

    def test_the_slots_the_runtime_reads_say_v4_and_the_reason(self):
        j = T.slots_json(T.parse4("intent: write\nverb: complete\npick: #31 (name)\nwithin: @1"))
        self.assertEqual(j["trace"], "v4")
        self.assertEqual(j["pick"], [{"row": "#31", "verdict": "ok", "reason": "name"}])
        self.assertNotIn("trace", T.slots_json(T.parse3("intent: write\nverb: complete\nrows: #31")))

    def test_what_a_v4_call_refers_to(self):
        m = T.mentions("act", {"verb": "complete", "rows": "#31"}, T.parse4("intent: write\nverb: complete\npick: #31 (name)"))
        self.assertEqual((m["rows"], m["class"]), (1, "anchored"))

    def test_the_consistency_check_reads_a_v4_think(self):
        h = self.hist("tick off the rent")
        call_ = {"tool": "act", "args": {"verb": "complete", "rows": "#31"}}
        self.assertEqual(T.check_call3("intent: write\nverb: complete\npick: #31 (name)", call_, h), [])
        self.assertTrue(T.check_call3("intent: read\nverb: complete\npick: #31 (name)", call_, h))
        self.assertTrue(T.check_call3("intent: write\nverb: delete\npick: #31 (name)", call_, h))


class GoldenV4(unittest.TestCase):
    """The v4 renderings of the golden file (`trace3_check.py golden4`): each compiles to the call of its v3.1 think."""

    def test_every_golden_shape_has_a_v4_think_that_compiles_to_the_same_call(self):
        rows = json.loads((HERE / "golden_v3.json").read_text())
        said = [r for r in rows if r.get("think4")]
        self.assertGreater(len(said), 500)
        self.assertEqual({r["call"]["tool"] for r in rows if r.get("think4") is None}, {"find"})  # v4 has no lookup step
        for r in said:
            got = T.compile_call(r["think4"], r.get("dates"), "v4")
            self.assertEqual(got, T.canon_call(r["call"]), r["shape"])
            self.assertEqual(T.render3(T.parse4(r["think4"])), r["think4"], r["shape"])


class Golden(unittest.TestCase):
    """The trace -> call compiler on one example of every distinct call shape of the train corpus (`trace3_check.py golden`).
    The decoder renders its call with the same function."""

    def test_every_shape_compiles_to_its_call(self):
        rows = json.loads((HERE / "golden_v3.json").read_text())
        self.assertGreater(len(rows), 500)
        for r in rows:
            got = T.compile_call(r["think"], r.get("dates"), "v3.1")  # golden thinks are v3.1
            self.assertEqual(got, T.canon_call(r["call"]), r["shape"])
            self.assertEqual(list(got["args"]), list(T.canon_call(r["call"])["args"]), r["shape"])  # the order is part of the text
            self.assertEqual(T.render3(T.parse3(r["think"])), r["think"], r["shape"])

    def test_every_tool_and_argument_of_the_contract_is_in_the_golden_set(self):
        rows = json.loads((HERE / "golden_v3.json").read_text())
        tools = {r["call"]["tool"] for r in rows}
        keys = {k for r in rows for k in r["call"]["args"]}
        self.assertEqual(tools, {"act", "answer", "ask", "compute", "decline", "find", "open", "search"})
        self.assertTrue(set(T.CALL_ORDER) <= keys, set(T.CALL_ORDER) - keys)


if __name__ == "__main__":
    unittest.main()
