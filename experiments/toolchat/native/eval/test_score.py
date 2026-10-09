"""Hand-built pass/fail pairs for score.py, one pair per outcome type (and a few edge cases), and the
clean turn metric on small synthetic runs.

    python3 -m unittest test_score -v      # from experiments/toolchat/native/eval

Turns are built as the runtime would report them (the `effect` records), against the keys of the fixture world (`fixture_world.py`).
"""

from __future__ import annotations

import unittest

import fixture_world
import slices
from lib import load_keys
from score import Ids, clean_turns, judge_turn, report, score, wilson

WORLD = fixture_world.install()  # a made-up household with the rows these tests name (the held-out worlds are not public)
KEYS = load_keys(WORLD)


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
        self.ids = Ids(WORLD)

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

    def test_retraction_step_scores_as_a_never_mind_decline(self):
        """A turn the runtime ends itself (run.py: no model message, `runtime: never_mind`) is judged like
        any decline."""
        ended = {"model": "", "runtime": "never_mind", "response": {
            "text": "declined: never_mind", "ends_turn": True,
            "effect": {"tool": "decline", "decline": {"reason": "never_mind"}}}}
        g = gold({"type": "decline", "reasons": ["never_mind"]})
        res = judge_turn(g, [ended], self.ids)
        self.assertTrue(res["pass"], res["problems"])
        self.assertEqual((res["effect"]["kind"], res["effect"]["reason"], res["effect"]["steps"]), ("decline", "never_mind", 1))
        self.assertFalse(judge_turn(gold({"type": "rows", "rows": ["dentist"]}), [ended], self.ids)["pass"])

    # a log that ends the turn also answers the row -------------------------------------------
    def test_log_that_answers_the_row_is_rows_plus_diff(self):
        changed = updated("meera_s", date=(None, "2026-10-14T08:40:00"))
        logged = [act([changed], verb="log", answer={"rows": [row("meera_s")], "ordered": False, "result": "@3"})]
        g = gold({"type": "rows", "rows": ["meera_s"],
                  "diff": {"rows": [{"key": "meera_s", "change": "updated", "fields": {"date": {"any": True}}}],
                           "links": []}})
        res = judge_turn(g, logged, self.ids)
        self.assertTrue(res["pass"], res["problems"])
        self.assertEqual((res["effect"]["kind"], res["effect"]["rows"]), ("rows", [vid("meera_s")]))
        # the older gold of a log turn (a write) still holds; the other row does not
        old = gold({"type": "diff", "diff": {"rows": [{"key": "meera_s", "change": "updated",
                                                       "fields": {"date": {"any": True}}}], "links": []}})
        self.assertTrue(judge_turn(old, logged, self.ids)["pass"])
        wrong = gold({"type": "rows", "rows": ["meera_i"], "diff": g["gold"][0]["diff"]})
        self.assertFalse(judge_turn(wrong, logged, self.ids)["pass"])
        # `more: true` answers nothing: the turn ends however the model ends it
        paged = [act([changed], verb="log", ends=False)]
        self.assertEqual(judge_turn(old, paged, self.ids)["effect"]["kind"], "cap")

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
        gold_sets = [{"id": "s1", "world": WORLD, "tags": [], "turns": [
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
        gold_sets = [{"id": "s1", "world": WORLD, "tags": [], "turns": [
            {"user": "q", "tags": ["convention", "convention:bare_weekday"], "gold": [{"type": "rows", "rows": ["vet"]}]},
            {"user": "q", "tags": [], "gold": [{"type": "rows", "rows": ["dentist"]}]}]}]
        run = [{"id": "s1", "turns": [{"steps": answer_rows("dentist")}, {"steps": answer_rows("dentist")}]}]
        _, summary = report(score(run, gold_sets), "t")
        self.assertEqual(summary["session_pass"], 0)  # the convention turn fails the strict session
        self.assertEqual(summary["without_convention"]["session_pass"], [1, 1])
        self.assertEqual(summary["without_convention"]["turn_pass"], [1, 1])
        self.assertEqual(summary["without_convention"]["clean_sessions"], [0, 0])


class CleanTurns(unittest.TestCase):
    """Clean turn pass: a turn is downstream when an earlier turn of its session already failed; the
    first failure of a session is still a clean turn."""

    @staticmethod
    def session(sid: str, outcomes: tuple[bool, ...]) -> tuple[dict, dict]:
        """(gold, run) of a session of the fixture world whose turn i is answered right (True) or wrong (False)."""
        gold_session = {"id": sid, "world": WORLD, "tags": [], "turns": [
            {"user": "q", "tags": [], "gold": [{"type": "rows", "rows": ["dentist"]}]} for _ in outcomes]}
        run = {"id": sid, "turns": [{"steps": answer_rows("dentist" if ok else "vet")} for ok in outcomes]}
        return gold_session, run

    def scored(self, **sessions: tuple[bool, ...]) -> tuple[list[dict], dict, str]:
        pairs = [self.session(sid, outcomes) for sid, outcomes in sessions.items()]
        gold_sets = [g for g, _ in pairs]
        text, summary = report(score([r for _, r in pairs], gold_sets), "t")
        return gold_sets, summary, text

    def test_clean_turns_of_one_session(self):
        turns = [{"pass": p} for p in (True, False, True, False)]
        self.assertEqual(clean_turns(turns), turns[:2])  # up to and including the first failure
        self.assertEqual(clean_turns(turns[:1]), turns[:1])  # nothing failed: every turn is clean
        self.assertEqual(clean_turns([{"pass": False}] * 3), [{"pass": False}])
        self.assertEqual(clean_turns([]), [])

    def test_fail_then_pass_is_two_clean_turns_and_one_clean_pass(self):
        _, summary, _ = self.scored(s1=(True, False, True))  # t1 passes, t2 fails, t3 is downstream
        self.assertEqual((summary["turns_clean"], summary["turn_pass_clean"]), (2, 1))
        self.assertEqual((summary["turns"], summary["turn_pass"]), (3, 2))
        self.assertEqual((summary["sessions"], summary["session_pass"]), (1, 0))

    def test_summary_and_headline_over_several_sessions(self):
        _, summary, text = self.scored(s1=(True, False, True), s2=(True, True), s3=(False, False, False))
        self.assertEqual((summary["turns_clean"], summary["turn_pass_clean"]), (2 + 2 + 1, 1 + 2 + 0))
        self.assertEqual((summary["turns"], summary["turn_pass"]), (8, 4))
        self.assertEqual((summary["sessions"], summary["session_pass"]), (3, 1))
        self.assertEqual(summary["ci95_clean"], list(wilson(3, 5)))
        self.assertEqual(summary["ci95"], list(wilson(1, 3)))  # the existing keys stay
        order = [text.index(x) for x in ("Session strict pass: 1/3", "Clean turn pass: 3/5 = 60.0%",
                                         "Turn pass (all turns): 4/8 = 50.0%")]
        self.assertEqual(order, sorted(order), "headline order: sessions, clean turns, all turns")

    def test_no_sessions(self):
        _, summary, _ = self.scored()
        self.assertEqual((summary["turns_clean"], summary["turn_pass_clean"]), (0, 0))
        self.assertEqual(summary["ci95_clean"], [0.0, 0.0])

    def test_agrees_with_the_downstream_flag_of_slices(self):
        gold_sets, summary, _ = self.scored(s1=(True, False, True, False), s2=(False, True), s3=(True, True, False))
        recs = slices.slice_failed(summary["failed"], gold_sets)
        self.assertEqual([(r["id"], r["turn"]) for r in recs],
                         [("s1", 2), ("s1", 4), ("s2", 1), ("s3", 3)])  # the failed turns
        self.assertEqual([(r["id"], r["turn"]) for r in recs if r["downstream"]], [("s1", 4)])
        # a failed clean turn is the first failure of its session: the failed clean turns are the others
        failed_clean = summary["turns_clean"] - summary["turn_pass_clean"]
        self.assertEqual(failed_clean, 3)
        self.assertEqual(sum(r["first_failure_in_session"] for r in recs), failed_clean)
        self.assertEqual(sum(r["downstream"] for r in recs), len(recs) - failed_clean)


if __name__ == "__main__":
    unittest.main()
