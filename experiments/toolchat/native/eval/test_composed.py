"""The reference calls the runtime composed past (D-1044-11, M1): what regen.py names `composed-ask`, `composed-decline`,
`composed-refusal`, `composed-answer` and `composed-apply`, and what the reference builder's verify reports. A `find`
never ends a turn by composition (SPEC §4.8, M1b): its miss is a reply the turn goes on from, and `composed-answer` is
a widening, the old gold kept beside the read's own answer. `composed-apply` (M1c) is a write the runtime applied to
the rows it chose: explained, no gold change, when the old gold accepts that diff.

    python3 -m unittest test_composed -v      # from experiments/toolchat/native/eval

Runs are built as the runtime reports them (crates/assist/src/native/compose.rs) against the fixture world (`fixture_world.py`).
"""

from __future__ import annotations

import unittest
from unittest import mock

import fixture_world
import gold
import regen
from lib import load_keys
from score import Ids

WORLD = fixture_world.install()  # a made-up household with the rows these tests name (the held-out worlds are not public)
KEYS = load_keys(WORLD)


def vid(key: str) -> str:
    return KEYS[key]["id"]


def row(key: str, n: int = 30) -> dict:
    return {"id": vid(key), "kind": KEYS[key]["kind"], "n": n}


def step(call_tool: str, effect: dict, ends: bool = True, args: dict | None = None) -> dict:
    return {"model": "", "response": {"call": {"tool": call_tool, "args": args or {}}, "effect": effect,
                                      "ends_turn": ends, "text": ""}}


def composed_ask(keys: list[str], **extra) -> dict:
    """An `act` the runtime ended in the ask it composed: `Which one?` over the candidates."""
    return step("act", {"tool": "ask", "composed": True, "ask": {"question": "Which one?",
                                                                   "options": [row(k) for k in keys]},
                        "compose": {"family": "ambiguous_write", "action": "ask_options"}, **extra})


def composed_decline(reason: str = "not_found", **extra) -> dict:
    return step("act", {"tool": "decline", "composed": True, "decline": {"reason": reason},
                        "compose": {"family": "unmatched_write", "action": "decline:not_found"}, **extra})


def composed_answer(keys: list[str], action: str = "answer_near_spellings", args: dict | None = None) -> dict:
    """An `answer` by name the runtime ended in the answer it composed: the near spellings, or nothing."""
    return step("answer", {"tool": "answer", "composed": True,
                           "answer": {"rows": [row(k) for k in keys], "ordered": False, "result": "@1"},
                           "compose": {"family": "unmatched_read", "action": action}},
                args=args if args is not None else {"kind": "task", "name": "zzyzx"})


def find_miss(args: dict | None = None, **extra) -> dict:
    """A `find` by name that reached nothing: the plain miss, no rows, and the turn goes on (SPEC §4.8)."""
    return step("find", {"tool": "find", "rows": [], "compose": {"family": "unmatched_read", "action": "find_miss"},
                         **extra}, ends=False, args=args if args is not None else {"kind": "task", "name": "zzyzx"})


def write_step() -> dict:
    return step("act", {"tool": "act", "verb": "complete", "diff": {"rows": [], "links": []}})


def ref(*tools: str) -> list[dict]:
    return [{"tool": t, "args": {}} for t in tools]


def session(*refs: list[dict]) -> dict:
    return {"id": "s1", "set": "val", "world": WORLD, "today": "2026-10-14", "me": "me", "tags": [],
            "turns": [{"user": f"message {i}", "gold": [gold.decline("not_found")], "ref": r, "tags": []}
                      for i, r in enumerate(refs)]}


def run_of(*turn_steps: list[dict]) -> dict:
    return {"id": "s1", "turns": [{"steps": s} for s in turn_steps]}


class Names(unittest.TestCase):
    def test_every_composed_end_has_its_convention(self):
        self.assertEqual(regen.composed_name(composed_ask(["roadmap"])["response"]["effect"]), "composed-ask")
        self.assertEqual(regen.composed_name(composed_decline()["response"]["effect"]), "composed-decline")
        self.assertEqual(regen.composed_name(composed_answer(["roadmap"])["response"]["effect"]), "composed-answer")

    def test_a_refusal_is_named_by_its_refusal_whichever_way_it_ends(self):
        refusal = {"verb": "remove_from", "predicate": "member_off_ledger", "outcome": "ask"}
        self.assertEqual(regen.composed_name(composed_ask(["roadmap"], refusal=refusal)["response"]["effect"]),
                         "composed-refusal")
        self.assertEqual(regen.composed_name(composed_decline("out_of_scope", refusal=refusal)["response"]["effect"]),
                         "composed-refusal")

    def test_the_cap_and_the_steps_the_model_wrote_are_not_composed_ends(self):
        self.assertIsNone(regen.composed_name(composed_ask(["roadmap"], bulk={"count": 13})["response"]["effect"]))
        self.assertIsNone(regen.composed_name({"tool": "ask", "ask": {"question": "which?", "options": []}}))
        self.assertIsNone(regen.composed_name(write_step()["response"]["effect"]))

    def test_the_heading_is_the_last_reference_call(self):
        self.assertEqual(regen.reference_heading(ref("act", "search", "ask")), "ask")
        self.assertEqual(regen.reference_heading(ref("find", "decline")), "decline")
        self.assertEqual(regen.reference_heading(ref("find", "search", "find")), "answer")
        self.assertEqual(regen.reference_heading(ref("act", "find", "act")), "act")
        self.assertEqual(regen.reference_heading([]), "act")


class Unreached(unittest.TestCase):
    def test_an_ask_after_an_ambiguous_write_is_explained(self):
        s = session(ref("act", "ask"))
        ends = regen.composed_ends(s, run_of([composed_ask(["roadmap", "fridge"])]))
        self.assertEqual(ends, [{"turn": 0, "step": 0, "convention": "composed-ask", "unreached": 1,
                                 "heading": "ask", "explained": True}])
        self.assertEqual(regen.composed_problems(s, run_of([composed_ask(["roadmap", "fridge"])])), [])

    def test_a_decline_after_a_dead_end_is_explained_and_counts_every_call_it_left(self):
        s = session(ref("act", "search", "find", "decline"))
        ends = regen.composed_ends(s, run_of([composed_decline()]))
        self.assertEqual((ends[0]["convention"], ends[0]["unreached"], ends[0]["explained"]),
                         ("composed-decline", 3, True))

    def test_a_dead_end_that_became_an_ask_is_explained_both_ways(self):
        for heading in ("ask", "decline"):
            s = session(ref("act", heading))
            self.assertTrue(regen.composed_ends(s, run_of([composed_ask(["roadmap"])]))[0]["explained"], heading)
            self.assertTrue(regen.composed_ends(s, run_of([composed_decline()]))[0]["explained"], heading)

    def test_a_read_that_dead_ends_may_have_been_heading_for_an_answer_an_ask_or_a_decline(self):
        for tools in (("find", "search", "answer"), ("find", "ask"), ("find", "decline")):
            s = session(ref(*tools))
            ends = regen.composed_ends(s, run_of([composed_answer(["roadmap"])]))
            self.assertTrue(ends[0]["explained"], tools)

    def test_a_reference_heading_for_a_write_is_not_explained(self):
        s = session(ref("act", "find", "act"))
        run = run_of([composed_ask(["roadmap", "fridge"])])
        ends = regen.composed_ends(s, run)
        self.assertEqual((ends[0]["heading"], ends[0]["explained"]), ("act", False))
        problems = regen.composed_problems(s, run)
        self.assertEqual(len(problems), 1)
        self.assertEqual(problems[0]["turn"], 1)
        self.assertIn("reference calls 2-3 are unreached after the runtime's composed-ask at call 1",
                      problems[0]["problems"][0])
        self.assertIn("heading for act", problems[0]["problems"][0])

    def test_a_composed_answer_is_not_a_write_either(self):
        s = session(ref("find", "act"))
        self.assertFalse(regen.composed_ends(s, run_of([composed_answer(["roadmap"])]))[0]["explained"])

    def test_nothing_is_left_unreached_when_the_composed_call_is_the_last_one(self):
        s = session(ref("act"), ref("find", "act", "ask"))
        run = run_of([composed_ask(["roadmap", "fridge"])],
                     [step("find", {"tool": "find", "rows": []}, ends=False), write_step(),
                      step("ask", {"tool": "ask", "ask": {"question": "?", "options": []}})])
        self.assertEqual(regen.composed_ends(s, run), [])
        self.assertEqual(regen.composed_problems(s, run), [])

    def test_a_step_after_the_one_that_ended_the_turn_is_not_looked_at(self):
        s = session(ref("act", "ask", "act"))
        run = run_of([composed_ask(["roadmap"]), write_step()])
        self.assertEqual(len(regen.composed_ends(s, run)), 1)

    def test_a_turn_without_a_run_has_no_ends(self):
        s = session(ref("act", "ask"), ref("act", "ask"))
        self.assertEqual(regen.composed_ends(s, run_of([composed_ask(["roadmap"])])), [
            {"turn": 0, "step": 0, "convention": "composed-ask", "unreached": 1, "heading": "ask",
             "explained": True}])

    def test_counts_per_convention_over_a_set(self):
        sessions = [session(ref("act", "ask"), ref("find", "search", "answer"), ref("act")),
                    {**session(ref("act", "decline")), "id": "s2"}]
        records = [run_of([composed_ask(["roadmap"])], [composed_answer([])], [write_step()]),
                   {**run_of([composed_decline()]), "id": "s2"}]
        self.assertEqual(regen.composed_counts(sessions, records),
                         {"composed-ask": 1, "composed-decline": 1, "composed-refusal": 0, "composed-answer": 1,
                          "composed-apply": 0})


class ComposedAnswer(unittest.TestCase):
    """`composed-answer` is a widening (M1b): the old gold of a read that dead-ends, a decline not_found or an ask,
    stays, and what the read answered is accepted beside it."""

    def setUp(self):
        # N7 widens every decline gold; these tests are about `composed-answer` alone (test_regen.DeclineAnyReason has N7)
        patcher = mock.patch.object(regen, "WIDENING", tuple(c for c in regen.WIDENING if c != "decline-any-reason"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def one(self, old: dict, steps: list[dict], reference: list[str]) -> dict:
        gt = {"user": "who is zzyzx", "gold": [old], "ref": ref(*reference), "tags": []}
        return regen.regen_turn(gt, steps, regen.Sess({"world": WORLD}, Ids(WORLD)), 0)

    def test_a_decline_not_found_is_widened_with_the_empty_answer(self):
        res = self.one(gold.decline("not_found"), [composed_answer([], "answer_empty")], ["answer", "decline"])
        self.assertEqual(res["convention"], "composed-answer", res)
        self.assertTrue(res["changed"], res)
        self.assertFalse(res["was_failing"], res)  # the alternative is there before the run is judged
        self.assertEqual(res["new_gold"], [gold.decline("not_found"), gold.rows()])
        self.assertIn("answer_empty", res["evidence"])

    def test_an_ask_with_candidates_is_widened_with_the_near_spellings_by_the_rule_that_explains_it(self):
        res = self.one(gold.ask("roadmap", "fridge"), [composed_answer(["roadmap"])], ["answer", "ask"])
        self.assertEqual(res["convention"], "composed-answer", res)
        self.assertTrue(res["was_failing"], res)  # no alternative before the run: the explain rule adds it
        self.assertEqual(res["new_gold"], [gold.ask("roadmap", "fridge"), gold.rows("roadmap")])
        self.assertIn("answer_near_spellings", res["evidence"])

    def test_an_ask_with_no_candidates_is_widened_before_the_run_is_judged(self):
        res = self.one(gold.ask(), [composed_answer(["roadmap"])], ["answer", "ask"])
        self.assertEqual(res["convention"], "composed-answer", res)
        self.assertFalse(res["was_failing"], res)
        self.assertEqual(res["new_gold"], [gold.ask(), gold.rows("roadmap")])

    def test_the_near_spellings_the_answer_carried_are_the_alternative(self):
        res = self.one(gold.decline("not_found"), [composed_answer(["roadmap", "fridge"], "answer_all_fits")],
                       ["answer"])
        self.assertEqual(res["new_gold"], [gold.decline("not_found"), gold.rows("roadmap", "fridge")])

    def test_a_find_that_missed_widens_a_decline_the_run_passes(self):
        steps = [find_miss(), step("search", {"tool": "search", "rows": []}, ends=False, args={"text": "zzyzx"}),
                 step("decline", {"tool": "decline", "decline": {"reason": "not_found"}},
                      args={"reason": "not_found"})]
        res = self.one(gold.decline("not_found"), steps, ["find", "search", "decline"])
        self.assertEqual((res["convention"], res["changed"], res["was_failing"]), ("composed-answer", True, False))
        self.assertEqual(res["gold"], [gold.decline("not_found"), gold.rows()])
        self.assertIn("find_miss", res["evidence"])

    def test_a_find_that_missed_widens_an_open_ask(self):
        steps = [find_miss(), step("ask", {"tool": "ask", "ask": {"question": "which?", "options": []}},
                                   args={"question": "which?"})]
        res = self.one(gold.ask(), steps, ["find", "ask"])
        self.assertEqual(res["gold"], [gold.ask(), gold.rows()])

    def test_the_hint_of_a_find_is_never_an_alternative(self):
        # the rows a hint names are in the reply text, never in the effect: only a plain miss, rows []
        miss = find_miss()
        miss["response"]["text"] = 'answered: 0 tasks called "zzyzx" match\nhint: near spellings: #30 task "Roadmap"'
        steps = [miss, step("decline", {"tool": "decline", "decline": {"reason": "not_found"}},
                            args={"reason": "not_found"})]
        res = self.one(gold.decline("not_found"), steps, ["find", "decline"])
        self.assertEqual(res["gold"], [gold.decline("not_found"), gold.rows()])

    def test_a_read_that_says_when_where_or_linked_to_is_not_a_miss_by_name(self):
        for extra in ({"when": {"unit": "week", "rel": 0}}, {"where": "status = open"}, {"linked_to": "#3"}):
            args = {"kind": "task", "name": "zzyzx", **extra}
            steps = [find_miss(args), step("decline", {"tool": "decline", "decline": {"reason": "not_found"}},
                                           args={"reason": "not_found"})]
            res = self.one(gold.decline("not_found"), steps, ["find", "decline"])
            self.assertFalse(res["changed"], extra)
            res = self.one(gold.decline("not_found"), [composed_answer([], "answer_empty", args)], ["answer"])
            self.assertEqual(res["convention"], "composed-answer", extra)  # the explain rule still reads the answer
            self.assertIn("answer_empty", res["evidence"])

    def widened(self, old: dict, steps: list[dict]) -> list[dict]:
        """`widen_gold` alone: the gold with the alternatives added before any run is judged."""
        sess = regen.Sess({"world": WORLD}, Ids(WORLD))
        return regen.widen_gold([old], "who is zzyzx", [], sess, 0, steps)[0]

    def test_only_a_gold_of_nothing_found_is_widened_before_the_run(self):
        steps = [find_miss(), step("ask", {"tool": "ask", "ask": {"question": "which?", "options": [row("roadmap")]}},
                                   args={"question": "which?"})]
        for old in (gold.decline("not_found"), gold.ask()):
            self.assertEqual(self.widened(old, steps), [old, gold.rows()], old)
        for old in (gold.ask("roadmap"), gold.decline("out_of_scope"), gold.decline("not_found", "out_of_scope"),
                    gold.decline(), gold.rows("roadmap"), gold.diff()):
            self.assertEqual(self.widened(old, steps), [old], old)

    def test_without_the_steps_of_a_run_nothing_is_widened(self):
        self.assertEqual(self.widened(gold.decline("not_found"), []), [gold.decline("not_found")])

    def test_a_turn_with_a_write_is_about_the_write_not_the_miss(self):
        steps = [find_miss(), step("act", {"tool": "act", "verb": "complete", "diff": {"rows": [], "links": []}},
                                   args={"verb": "complete", "kind": "task", "name": "zzyzx"}),
                 step("decline", {"tool": "decline", "decline": {"reason": "not_found"}},
                      args={"reason": "not_found"})]
        res = self.one(gold.decline("not_found"), steps, ["find", "act", "decline"])
        self.assertFalse(res["changed"], res)

    def test_a_find_that_found_rows_is_not_a_miss(self):
        found = step("find", {"tool": "find", "rows": [row("roadmap")], "result": "@1"}, ends=False,
                     args={"kind": "task", "name": "roadmap"})
        steps = [found, step("decline", {"tool": "decline", "decline": {"reason": "not_found"}},
                             args={"reason": "not_found"})]
        self.assertFalse(self.one(gold.decline("not_found"), steps, ["find", "decline"])["changed"])

    def test_the_widening_is_idempotent(self):
        steps = [composed_answer([], "answer_empty")]
        res = self.one(gold.decline("not_found"), steps, ["answer"])
        again = regen.regen_turn({"user": "who is zzyzx", "gold": res["gold"], "ref": ref("answer"), "tags": []},
                                 steps, regen.Sess({"world": WORLD}, Ids(WORLD)), 0)
        self.assertFalse(again["changed"], again)
        self.assertEqual(again["gold"], res["gold"])

    def test_a_gold_of_other_rows_is_not_explained(self):
        res = self.one(gold.rows("fridge"), [composed_answer(["roadmap"])], ["answer"])
        self.assertEqual(res["convention"], regen.UNEXPLAINED, res)
        self.assertFalse(res["changed"])

    def test_an_answer_the_model_wrote_is_not_a_composed_one(self):
        plain = step("answer", {"tool": "answer", "answer": {"rows": [row("roadmap")], "ordered": False,
                                                           "result": "@1"}}, args={"kind": "task", "name": "zzyzx"})
        res = self.one(gold.decline("not_found"), [plain], ["answer"])
        self.assertNotEqual(res["convention"], "composed-answer", res)

    def test_the_convention_is_one_the_refreeze_can_count(self):
        self.assertIn("composed-answer", regen.CONVENTIONS)
        self.assertIn("composed-answer", regen.WIDENING)
        self.assertIn("composed-answer", regen.WIDENERS)
        self.assertTrue({"composed-ask", "composed-decline", "composed-refusal"} <= set(regen.CONVENTIONS))
        changes = [{"applied": True, "convention": "composed-answer", "was_failing": True, "id": "s1", "turn": 1,
                    "held": False}]
        self.assertEqual(regen.summarize(changes, 1, 1)["by_convention"], {"composed-answer": 1})


class FindIsALookup(unittest.TestCase):
    """A `find` that missed ends nothing (SPEC §4.8): the verify of the reference builder has no composed end to explain."""

    def test_a_find_miss_is_not_a_composed_end_and_leaves_nothing_unreached(self):
        s = session(ref("find", "search", "answer"))
        run = run_of([find_miss(), step("search", {"tool": "search", "rows": []}, ends=False),
                      step("answer", {"tool": "answer", "answer": {"rows": [], "ordered": False}})])
        self.assertIsNone(regen.composed_name(find_miss()["response"]["effect"]))
        self.assertEqual(regen.composed_ends(s, run), [])
        self.assertEqual(regen.composed_problems(s, run), [])
        self.assertEqual(regen.composed_counts([s], [run]), {"composed-ask": 0, "composed-decline": 0,
                                                             "composed-refusal": 0, "composed-answer": 0,
                                                             "composed-apply": 0})


def apply_step(key: str, action: str = "apply_all", verb: str = "complete", fields: dict | None = None,
               **extra) -> dict:
    """An `act` the runtime applied to the row it chose: the write's own diff, and `compose.action` says which choice
    (`apply_all`, `apply_near_spelling`, `apply_other_kind`)."""
    return apply_row(vid(key), KEYS[key]["kind"], action, verb, fields, **extra)


def apply_row(row_id: str, kind: str, action: str = "apply_all", verb: str = "complete", fields: dict | None = None,
              change: str = "updated", **extra) -> dict:
    changed = {"id": row_id, "kind": kind, "n": 30, "change": change,
               "fields": fields if fields is not None else {"status": ["open", "completed"]}}
    return step("act", {"tool": "act", "verb": verb, "diff": {"rows": [changed], "links": []},
                        "compose": {"family": "ambiguous_write", "action": action}, **extra},
                args={"verb": verb, "kind": kind, "name": "x"})


class AppliedWrites(unittest.TestCase):
    """`composed-apply` (M1c): a write the runtime applied to the rows it chose ends the turn at the call, and the
    reference calls after it are unreached. It is explained, with no gold change, when the old gold accepts that diff;
    another diff is UNEXPLAINED as for any write no convention explains, and that is where it is reported."""

    ACCEPTED = gold.diff(gold.upd("roadmap", status="completed"))
    OTHER = gold.diff(gold.upd("fridge", status="completed"))

    def turn(self, old: dict, steps: list[dict], reference: list[str]) -> dict:
        gt = {"user": "tick it off", "gold": [old], "ref": ref(*reference), "tags": []}
        return regen.regen_turn(gt, steps, regen.Sess({"world": WORLD}, Ids(WORLD)), 0)

    def test_every_applied_write_is_a_composed_end_named_composed_apply(self):
        self.assertEqual(set(regen.APPLY_ACTIONS), {"apply_all", "apply_near_spelling", "apply_other_kind"})
        self.assertIn("composed-apply", regen.COMPOSED_NAMES)
        self.assertEqual(regen.HEADING["composed-apply"], ("act",))
        for action in regen.APPLY_ACTIONS:
            effect = apply_step("roadmap", action)["response"]["effect"]
            self.assertEqual(regen.composed_name(effect), "composed-apply", action)
        # the runtime picks no instance of a series any more (R6c): such a write is a write as the model wrote it
        gone = apply_step("roadmap", "apply_next")["response"]["effect"]
        self.assertIsNone(regen.composed_name(gone))

    def test_a_write_the_runtime_did_not_choose_is_no_composed_end(self):
        plain = apply_step("roadmap")["response"]["effect"]
        plain.pop("compose")
        self.assertIsNone(regen.composed_name(plain))  # a write as the model wrote it
        refused = apply_step("roadmap", "apply_near_spelling")["response"]["effect"]
        refused["compose"] = {"family": "refused_write", "action": "decline"}
        self.assertIsNone(regen.composed_name(refused))  # the refusal composed at the row is its own marker
        failed = apply_step("roadmap", error="error: ...")["response"]["effect"]
        self.assertIsNone(regen.composed_name(failed))
        no_diff = apply_step("roadmap")["response"]["effect"]
        no_diff.pop("diff")
        self.assertIsNone(regen.composed_name(no_diff))
        # the asks and declines keep their names
        self.assertEqual(regen.composed_name(composed_ask(["roadmap"])["response"]["effect"]), "composed-ask")

    def test_an_apply_the_old_gold_accepts_is_explained_and_leaves_no_problem(self):
        # T23-077's shape: the reference looks, then searches, then writes; the runtime wrote at the first call
        s = session(ref("act", "search", "act"))
        s["turns"][0]["gold"] = [self.ACCEPTED]
        for action in regen.APPLY_ACTIONS:
            run = run_of([apply_step("roadmap", action)])
            self.assertEqual(regen.composed_ends(s, run), [{
                "turn": 0, "step": 0, "convention": "composed-apply", "unreached": 2, "heading": "act",
                "explained": True}], action)
            self.assertEqual(regen.composed_problems(s, run), [], action)

    def test_an_apply_another_diff_is_not_explained_and_no_verify_problem_of_its_own(self):
        s = session(ref("act", "search", "act"))
        s["turns"][0]["gold"] = [self.OTHER]
        run = run_of([apply_step("roadmap")])
        ends = regen.composed_ends(s, run)
        self.assertEqual((ends[0]["convention"], ends[0]["explained"]), ("composed-apply", False))
        self.assertEqual(regen.composed_problems(s, run), [])  # the gold failing is where it is reported

    def test_the_gold_is_left_as_it_is_when_it_accepts_the_diff(self):
        for action in regen.APPLY_ACTIONS:
            res = self.turn(self.ACCEPTED, [apply_step("roadmap", action)], ["act", "search", "act"])
            self.assertFalse(res["changed"], res)
            self.assertIsNone(res["convention"], res)
            self.assertEqual(res["gold"], [self.ACCEPTED])

    def test_another_diff_is_unexplained_as_today(self):
        res = self.turn(self.OTHER, [apply_step("roadmap")], ["act", "search", "act"])
        self.assertEqual(res["convention"], regen.UNEXPLAINED, res)
        self.assertFalse(res["changed"])
        self.assertEqual(res["gold"], [self.OTHER])

    def test_an_ask_or_a_decline_gold_is_unexplained_too(self):
        # whether a series asks or takes its one open instance is the owner's ruling, never a convention
        for old in (gold.ask("roadmap", "fridge"), gold.decline("not_found")):
            res = self.turn(old, [apply_step("roadmap")], ["act"])
            self.assertEqual(res["convention"], regen.UNEXPLAINED, old)
            self.assertFalse(res["changed"], old)

    def test_a_bad_mark_on_the_applied_call_does_not_apply_when_the_gold_accepts(self):
        s = session([{"tool": "act", "args": {}, "bad": True}, {"tool": "act", "args": {}}])
        run = run_of([apply_step("roadmap")])
        s["turns"][0]["gold"] = [self.ACCEPTED]
        self.assertEqual(regen.composed_marks(s, run), {(0, 0)})
        s["turns"][0]["gold"] = [self.OTHER]
        self.assertEqual(regen.composed_marks(s, run), set())  # the call is still marked: it fails as today

    def test_a_call_that_is_not_marked_bad_is_not_a_mark(self):
        s = session(ref("act", "act"))
        s["turns"][0]["gold"] = [self.ACCEPTED]
        self.assertEqual(regen.composed_marks(s, run_of([apply_step("roadmap")])), set())

    def test_the_rows_an_earlier_turn_created_are_the_ones_a_gold_names_as_plus_one(self):
        made = apply_row("11111111-1111-7111-8111-111111111111", "task", "apply_all", "create", {}, change="created")
        s = session(ref("act"), ref("act", "search", "act"))
        s["turns"][0]["gold"] = [gold.diff(gold.new("task"))]
        s["turns"][1]["gold"] = [gold.diff(gold.upd("+1", status="completed"))]
        run = run_of([made], [apply_row("11111111-1111-7111-8111-111111111111", "task")])
        ends = regen.composed_ends(s, run)
        self.assertEqual([(e["turn"], e["explained"]) for e in ends], [(1, True)])
        s["turns"][1]["gold"] = [gold.diff(gold.upd("fridge", status="completed"))]
        self.assertEqual([(e["turn"], e["explained"]) for e in regen.composed_ends(s, run)], [(1, False)])

    def test_nothing_is_left_unreached_when_the_applied_write_was_the_reference_s_last_call(self):
        s = session(ref("act"))
        s["turns"][0]["gold"] = [self.ACCEPTED]
        self.assertEqual(regen.composed_ends(s, run_of([apply_step("roadmap")])), [])

    def test_the_counts_name_the_applied_writes(self):
        s = session(ref("act"), ref("act", "act"))
        run = run_of([apply_step("roadmap", "apply_near_spelling")], [apply_step("fridge", "apply_other_kind")])
        self.assertEqual(regen.composed_counts([s], [run]), {
            "composed-ask": 0, "composed-decline": 0, "composed-refusal": 0, "composed-answer": 0,
            "composed-apply": 2})

    def test_a_write_that_stays_open_is_not_counted(self):
        s = session(ref("act", "answer"))
        run = run_of([{**apply_step("roadmap"), "response": {**apply_step("roadmap")["response"], "ends_turn": False}}])
        self.assertEqual(regen.composed_counts([s], [run])["composed-apply"], 0)
        self.assertEqual(regen.composed_ends(s, run), [])


if __name__ == "__main__":
    unittest.main()
