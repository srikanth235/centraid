"""Hand-built pass/fail pairs for score.py, one pair per outcome type (and a few edge cases).

    python3 -m unittest test_score -v      # from experiments/toolchat/native/eval

Turns are built as the runtime would report them (the `effect` records), against world A's keys.
"""

from __future__ import annotations

import unittest

from lib import load_keys
from score import Ids, judge_turn, report, score, wilson

KEYS = load_keys("A")


def vid(key: str) -> str:
    return KEYS[key]["id"]


def row(key: str, n: int = 30) -> dict:
    return {"id": vid(key), "kind": KEYS[key]["kind"], "n": n}


def step(effect: dict, ends: bool = True) -> dict:
    return {"model": "<tool_call>…</tool_call>", "response": {"effect": effect, "ends_turn": ends, "text": ""}}


def answer_rows(*keys: str) -> list[dict]:
    return [step({"tool": "answer", "answer": {"rows": [row(k) for k in keys], "ordered": False}})]


def answer_value(*values) -> list[dict]:
    return [step({"tool": "answer", "value": {"op": "sum", "values": [{"amount": a, "unit": u} for a, u in values]}})]


def act(diff_rows=(), links=(), verb="edit", ends=True, **extra) -> dict:
    return step({"tool": "act", "verb": verb, "diff": {"rows": list(diff_rows), "links": list(links)}, **extra}, ends)


def updated(key: str, **fields) -> dict:
    return {"id": vid(key), "kind": KEYS[key]["kind"], "n": 30, "change": "updated",
            "fields": {f: list(v) for f, v in fields.items()}}


def gold(*accepts) -> dict:
    return {"gold": list(accepts), "tags": []}


class OutcomeTypes(unittest.TestCase):
    def setUp(self):
        self.ids = Ids("A")

    # rows ------------------------------------------------------------------------------------
    def test_rows_pass(self):
        g = gold({"type": "rows", "rows": ["dentist", "vet"]})
        self.assertTrue(judge_turn(g, answer_rows("vet", "dentist"), self.ids)["pass"])

    def test_rows_fail_extra_row(self):
        g = gold({"type": "rows", "rows": ["dentist", "vet"]})
        res = judge_turn(g, answer_rows("vet", "dentist", "haircut"), self.ids)
        self.assertFalse(res["pass"])
        self.assertFalse(res["wrong_write"])

    # value -----------------------------------------------------------------------------------
    def test_value_pass(self):
        g = gold({"type": "value", "values": [{"amount": 180.40, "unit": "USD"}]})
        self.assertTrue(judge_turn(g, answer_value((180.4, "USD")), self.ids)["pass"])

    def test_value_fail_wrong_unit(self):
        g = gold({"type": "value", "values": [{"amount": 180.40, "unit": "USD"}]})
        self.assertFalse(judge_turn(g, answer_value((180.4, "EUR")), self.ids)["pass"])

    def test_value_multi_currency_order_free(self):
        g = gold({"type": "value", "values": [{"amount": 1, "unit": "USD"}, {"amount": 2, "unit": "JPY"}]})
        self.assertTrue(judge_turn(g, answer_value((2, "JPY"), (1, "USD")), self.ids)["pass"])

    # diff ------------------------------------------------------------------------------------
    def test_diff_pass(self):
        g = gold({"type": "diff", "diff": {"rows": [{"key": "faucet", "change": "updated",
                                                     "fields": {"status": "completed", "completed": {"any": True}}}],
                                           "links": []}})
        steps = [act([updated("faucet", status=("open", "completed"), completed=(None, "2026-10-14T08:40:00"))],
                     verb="complete")]
        res = judge_turn(g, steps, self.ids)
        self.assertTrue(res["pass"], res["problems"])
        self.assertFalse(res["wrong_write"])

    def test_diff_fail_extra_row_is_wrong_write(self):
        g = gold({"type": "diff", "diff": {"rows": [{"key": "faucet", "change": "updated",
                                                     "fields": {"status": "completed", "completed": {"any": True}}}],
                                           "links": []}})
        steps = [act([updated("faucet", status=("open", "completed"), completed=(None, "x")),
                      updated("dogfood", status=("open", "completed"), completed=(None, "x"))], verb="complete")]
        res = judge_turn(g, steps, self.ids)
        self.assertFalse(res["pass"])
        self.assertTrue(res["wrong_write"])

    def test_diff_fail_write_on_read_turn(self):
        g = gold({"type": "rows", "rows": ["pottery"]})
        steps = [act([updated("pottery", status=("cancelled", "tentative"))], verb="edit", ends=False)] + answer_rows("pottery")
        res = judge_turn(g, steps, self.ids)
        self.assertFalse(res["pass"])
        self.assertTrue(res["wrong_write"])

    def test_already_pass_and_fail(self):
        g = gold({"type": "diff", "diff": {"rows": [], "links": []}, "already": ["en0"]})
        ok = [act([], verb="star", ends=False, already=[{**row("en0"), "state": "is starred"}])] + answer_rows("en0")
        self.assertTrue(judge_turn(g, ok, self.ids)["pass"])
        self.assertFalse(judge_turn(g, answer_rows("en0"), self.ids)["pass"])

    def test_create_and_link(self):
        g = gold({"type": "diff", "diff": {"rows": [{"new": "task", "fields": {"name": {"has": ["Greg"]},
                                                                               "date": "2026-10-19"}}],
                                           "links": [{"change": "added", "from": "home", "to": "new"}]}})
        new_id = "00000000-0000-0000-0000-000000000001"
        created = {"id": new_id, "kind": "task", "n": 40, "change": "created",
                   "fields": {"name": [None, "Call Greg"], "date": [None, "2026-10-19"], "status": [None, "open"]}}
        link = {"change": "added", "from": {"id": vid("home"), "kind": "list"}, "to": {"id": new_id, "kind": "task"}}
        self.assertTrue(judge_turn(g, [act([created], [link], verb="create")], self.ids)["pass"])
        self.assertFalse(judge_turn(g, [act([created], [], verb="create")], self.ids)["pass"])

    def test_undo_nets_out(self):
        g = gold({"type": "diff", "diff": {"rows": [], "links": []}})
        steps = [act([updated("lease", starred=(True, False))], verb="unstar", ends=False),
                 act([updated("lease", starred=(False, True))], verb="undo")]
        self.assertTrue(judge_turn(g, steps, self.ids)["pass"])

    def test_settle_up_balance_row(self):
        g = gold({"type": "diff", "diff": {"rows": [], "links": []}, "settle": [{"name": "Jordan Blake"}]})
        zeroed = {"id": vid("jordan_b"), "kind": "person", "n": 30, "change": "updated",
                  "fields": {"balance": [{"amount": 180.4, "unit": "USD"}, {"amount": 0.0, "unit": "USD"}]}}
        text = 'settled up: #30 person "Jordan Blake" · no field changed\nsettlement: 180.40 USD paid to you'
        ok = [{"model": "", "response": {"effect": {"tool": "act", "verb": "settle_up", "diff": {"rows": [zeroed], "links": []}},
                                         "ends_turn": True, "text": text}}]
        self.assertTrue(judge_turn(g, ok, self.ids)["pass"])
        other = gold({"type": "diff", "diff": {"rows": [], "links": []}, "settle": [{"name": "Jordan Lee"}]})
        self.assertFalse(judge_turn(other, ok, self.ids)["pass"])

    # ask -------------------------------------------------------------------------------------
    def test_ask_pass(self):
        g = gold({"type": "ask", "candidates": ["meera_i", "meera_s"]})
        steps = [step({"tool": "ask", "ask": {"question": "which?", "options": [row("meera_i"), row("meera_s")]}})]
        self.assertTrue(judge_turn(g, steps, self.ids)["pass"])

    def test_ask_fail_under_ask(self):
        g = gold({"type": "ask", "candidates": ["meera_i", "meera_s"]})
        steps = [act([updated("meera_s", date=(None, "2026-10-14T08:40:00"))], verb="log")]
        res = judge_turn(g, steps, self.ids)
        self.assertFalse(res["pass"])
        self.assertEqual(res["effect"]["kind"], "act")

    # decline ---------------------------------------------------------------------------------
    def test_decline_pass(self):
        g = gold({"type": "decline", "reasons": ["out_of_scope"]})
        steps = [step({"tool": "decline", "decline": {"reason": "out_of_scope"}})]
        self.assertTrue(judge_turn(g, steps, self.ids)["pass"])

    def test_decline_fail_wrong_reason(self):
        g = gold({"type": "decline", "reasons": ["sealed_egress"]})
        steps = [step({"tool": "decline", "decline": {"reason": "out_of_scope"}})]
        self.assertFalse(judge_turn(g, steps, self.ids)["pass"])

    # any-of readings and loops ---------------------------------------------------------------
    def test_any_acceptable_reading(self):
        g = gold({"type": "rows", "rows": ["oneonone10"]}, {"type": "rows", "rows": ["oneonone10", "pottery"]})
        self.assertTrue(judge_turn(g, answer_rows("oneonone10", "pottery"), self.ids)["pass"])

    def test_loop_fails_read(self):
        g = gold({"type": "rows", "rows": ["dentist"]})
        steps = [step({"tool": "find", "error": "error: repeated call", "loop": True})]
        res = judge_turn(g, steps, self.ids)
        self.assertFalse(res["pass"])
        self.assertEqual(res["effect"]["kind"], "loop")


class Report(unittest.TestCase):
    def test_wilson(self):
        lo, hi = wilson(270, 300)
        self.assertAlmostEqual(lo, 0.861, places=2)
        self.assertAlmostEqual(hi, 0.930, places=2)

    def test_guardrail_denominators(self):
        gold_sets = [{"id": "s1", "world": "A", "tags": [], "turns": [
            {"user": "q", "tags": [], "gold": [{"type": "ask", "candidates": []}]},
            {"user": "q", "tags": [], "gold": [{"type": "rows", "rows": ["dentist"]}]}]}]
        run = [{"id": "s1", "turns": [
            {"steps": answer_rows("dentist")},  # answered where gold asks: under-ask
            {"steps": [step({"tool": "ask", "ask": {"question": "?", "options": []}})]},  # over-ask
        ]}]
        _, summary = report(score(run, gold_sets), "t")
        self.assertEqual(summary["under_ask"], [1, 1])
        self.assertEqual(summary["over_ask"], [1, 1])
        self.assertEqual(summary["session_pass"], 0)


    def test_without_convention(self):
        gold_sets = [{"id": "s1", "world": "A", "tags": [], "turns": [
            {"user": "q", "tags": ["convention", "convention:bare_weekday"], "gold": [{"type": "rows", "rows": ["vet"]}]},
            {"user": "q", "tags": [], "gold": [{"type": "rows", "rows": ["dentist"]}]}]}]
        run = [{"id": "s1", "turns": [{"steps": answer_rows("dentist")}, {"steps": answer_rows("dentist")}]}]
        _, summary = report(score(run, gold_sets), "t")
        self.assertEqual(summary["session_pass"], 0)  # the convention turn fails the strict session
        self.assertEqual(summary["without_convention"]["session_pass"], [1, 1])
        self.assertEqual(summary["without_convention"]["turn_pass"], [1, 1])
        self.assertEqual(summary["without_convention"]["clean_sessions"], [0, 0])


if __name__ == "__main__":
    unittest.main()
