"""Unit tests for the forward slot trace (authored/trace.py): the grammar round trip and the slot rules
on small hand-built contexts. The runtime side of the same grammar is tested in
crates/nativetools/tests/trace.rs; `trace_check.py` measures the rules on the built corpus.

    python3 -m unittest authored/test_trace.py
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

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
    return T.derive_trace({"tool": tool_, "args": args}, history, None, **kw)


class Grammar(unittest.TestCase):
    def test_every_slot_round_trips(self):
        text = "\n".join([
            "retry: rejected",
            'intent: write "cancel it"',
            "verb: cancel",
            'scope: some "both"',
            'refer: both "both" -> @3',
            'target: "night shift" · "kwame"',
            'when: earlier "to 3"',
            "pick: #12 ok · #13 no (kind) · #14 no (date)",
        ])
        slots = T.parse(text)
        self.assertEqual(T.render(slots), text)
        self.assertEqual(slots["refer"], ("both", "both", ["@3"]))
        self.assertEqual(slots["pick"], [(12, None), (13, "kind"), (14, "date")])
        for when in ('when: "friday"', "when: now", "when: earlier"):
            self.assertEqual(T.render(T.parse(f"intent: read\n{when}")).split("\n")[1], when)

    def test_bare_forms_and_order(self):
        self.assertEqual(T.parse("intent: count")["intent"][0], "count")
        self.assertFalse(T.parse("intent: count")["intent"][1])
        self.assertEqual(T.parse("intent: read\nrefer: it -> #7, #9")["refer"][2], ["#7", "#9"])
        with self.assertRaises(ValueError):
            T.parse('verb: cancel\nintent: write "x"')  # out of order
        with self.assertRaises(ValueError):
            T.parse("intent: write\nplan: act")  # not a slot
        with self.assertRaises(ValueError):
            T.parse("scope: one")  # no intent


class Slots(unittest.TestCase):
    def test_a_selector_write_is_one_row_and_names_its_span(self):
        history = [SYSTEM, user("cancel the night shift on friday")]
        tr = derive(history, "act", {"verb": "cancel", "kind": "event", "name": "Night shift", "when": '{"unit":"week","rel":0,"weekday":5}'})
        s = tr.slots
        self.assertEqual(s["intent"][0], "write")
        self.assertEqual((s["verb"], s["scope"][0]), ("cancel", "one"))
        self.assertEqual(s["target"], ["night shift"])
        self.assertEqual(s["when"], ("q", "friday"))
        self.assertEqual(T.check_call(tr.text(), {"tool": "act", "args": {"verb": "cancel", "kind": "event", "name": "Night shift", "when": '{"unit":"week","rel":0,"weekday":5}'}}, history), [])

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


if __name__ == "__main__":
    unittest.main()
