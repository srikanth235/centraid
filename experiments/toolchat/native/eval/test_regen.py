"""Hand-built reference runs for regen.py: the accept derived from each kind of terminal effect, the checks carried over
from the old gold, each convention on an old/new pair it explains and on the near misses it must not explain, and the
UNEXPLAINED case.

    python3 -m unittest test_regen -v      # from experiments/toolchat/native/eval

Runs are built as the runtime reports them (the `call` and the `effect` of every step) against world A.
"""

from __future__ import annotations

import unittest
from unittest import mock

import gold
import regen
from lib import load_keys, turn_effect
from score import Ids, judge_accept, judge_turn

KEYS = load_keys("A")
OPEN = ["dogfood", "amazon", "vetbill", "drycleaning"]  # open tasks of world A
STARTED = {"roadmap": 240, "fridge": 40, "readbook": None}  # the tasks in progress, with their effort in minutes


def vid(key: str) -> str:
    return KEYS[key]["id"]


def row(key: str, n: int = 30) -> dict:
    return {"id": vid(key), "kind": KEYS[key]["kind"], "n": n}


def step(tool: str, args: dict, effect: dict, ends: bool = True, text: str = "") -> dict:
    return {"model": "", "response": {"call": {"tool": tool, "args": args}, "effect": {"tool": tool, **effect},
                                      "ends_turn": ends, "text": text}}


def rows_step(keys: list[str], args: dict | None = None, result: str = "@1", ordered: bool = False) -> dict:
    return step("answer", args or {"kind": "task"}, {"answer": {"rows": [row(k) for k in keys], "ordered": ordered,
                                                                "result": result}})


def value_step(op: str, amount: float, args: dict, field: str | None = None, unit: str | None = None,
               result: str = "@1") -> dict:
    return step("answer", args, {"value": {"op": op, "field": field, "values": [{"amount": amount, "unit": unit}]},
                                 "result": result})


def ask_step(keys: list[str], completed: bool = False, args: dict | None = None, tool: str = "ask") -> dict:
    ask = {"question": "which?", "options": [row(k) for k in keys], **({"completed": True} if completed else {})}
    return step(tool, args or {"question": "which?"}, {"ask": ask})


def composed(tool: str, args: dict, kind: str, **payload) -> dict:
    """An ask or a decline the runtime wrote itself at the call of an `act`."""
    return {"model": "", "response": {"call": {"tool": "act", "args": args}, "effect": {"tool": kind, **payload},
                                      "ends_turn": True, "text": ""}}


def updated(key: str, **fields) -> dict:
    return {"id": vid(key), "kind": KEYS[key]["kind"], "n": 30, "change": "updated",
            "fields": {f: list(v) for f, v in fields.items()}}


def act_step(verb: str, diff_rows: list[dict], args: dict | None = None, links: list | None = None, ends: bool = True,
             **extra) -> dict:
    return step("act", {"verb": verb, **(args or {})}, {"verb": verb, "diff": {"rows": diff_rows, "links": links or []},
                                                        **extra}, ends)


def complete(key: str, was: str = "open") -> dict:
    return updated(key, status=(was, "completed"), completed=(None, "2026-10-14T08:40:00"))


COUNT_PREV = {"op": "count", "within": "@prev"}


def turn(user: str, *accepts: dict, ref: list[dict] | None = None) -> dict:
    """A gold turn. Without `ref` the reference calls are those the run makes (`filled` writes them in)."""
    return {"user": user, "gold": list(accepts), "ref": ref, "tags": []}


def filled(gt: dict, steps: list[dict]) -> dict:
    if gt["ref"] is not None:
        return gt
    return {**gt, "ref": [{"tool": s["response"]["call"]["tool"], "args": {}} for s in steps]}


def session(*turns: dict) -> dict:
    return {"id": "s1", "set": "val", "world": "A", "today": "2026-10-14", "me": "me", "tags": [],
            "turns": list(turns)}


def run_of(*turn_steps: list[dict]) -> dict:
    return {"id": "s1", "turns": [{"steps": s} for s in turn_steps]}


def one(gt: dict, steps: list[dict], sess: regen.Sess | None = None, ti: int = 0) -> dict:
    sess = sess or regen.Sess({"world": "A"}, Ids("A"))
    return regen.regen_turn(filled(gt, steps), steps, sess, ti)


def regen_s(s: dict, run: dict) -> tuple[dict, list[dict]]:
    """regen.regen_session over a session whose turns may leave their reference calls to the run."""
    return regen.regen_session({**s, "turns": [filled(t, r["steps"]) for t, r in zip(s["turns"], run["turns"])]}, run)


def rows(*keys: str, **kw) -> dict:
    return gold.rows(*keys, **kw)


def without_n7(case: unittest.TestCase) -> None:
    """N7 widens every decline gold. The tests of the other conventions leave that widening out, so what they expect is
    about their own convention (`DeclineAnyReason` has it on)."""
    patcher = mock.patch.object(regen, "WIDENING", tuple(c for c in regen.WIDENING if c != "decline-any-reason"))
    patcher.start()
    case.addCleanup(patcher.stop)



def has_in_progress_call(**extra) -> dict:
    return {"kind": "task", "where": "status = open", **extra}


class Helpers(unittest.TestCase):
    def test_status_clauses_split_outside_quotes(self):
        self.assertEqual(regen.clauses('name contains "salt and pepper" and status = "open"'),
                         ['name contains "salt and pepper"', 'status = "open"'])
        self.assertEqual(regen.status_clauses('priority = 1 and status = "open"'), [("=", frozenset({"open"}))])
        self.assertEqual(regen.status_clauses('status in ("open", "in_progress")'),
                         [("in", frozenset({"open", "in_progress"}))])
        self.assertEqual(regen.status_clauses("status != completed"), [("!=", frozenset({"completed"}))])
        self.assertEqual(regen.status_clauses('name contains "status = open"'), [])

    def test_open_reading_is_the_rule_of_d_1044_7(self):
        self.assertEqual(regen.open_reading("=", frozenset({"open"})), "pos")
        self.assertEqual(regen.open_reading("in", frozenset({"open", "completed"})), "pos")
        self.assertEqual(regen.open_reading("!=", frozenset({"open"})), "neg")
        for op, values in (("in", {"open", "in_progress"}), ("!=", {"completed"}), ("=", {"in_progress"})):
            self.assertIsNone(regen.open_reading(op, frozenset(values)))

    def test_world_status_follows_the_seed(self):
        self.assertEqual(regen.world_status({"status": "in_progress"}), "in_progress")
        self.assertEqual(regen.world_status({"status": "in_progress", "completed": "2026-01-01"}), "completed")
        self.assertEqual(regen.world_status({"completed": "2026-01-01"}), "completed")
        self.assertEqual(regen.world_status({}), "open")

    def test_fold_and_words(self):
        self.assertEqual(regen.fold("Lucía"), "lucia")
        self.assertEqual(regen.words("Tomás's list", True), {"tomas", "list"})
        self.assertEqual(regen.words("Tomás", False), {"tomás"})

    def test_canon_accept_ignores_the_order_of_sets_only(self):
        a = {"type": "rows", "rows": ["a", "b"]}
        self.assertEqual(regen.canon_accept(a), regen.canon_accept({"rows": ["b", "a"], "type": "rows"}))
        self.assertNotEqual(regen.canon_accept({**a, "order": True}),
                            regen.canon_accept({"type": "rows", "rows": ["b", "a"], "order": True}))

    def test_show_accept_is_one_line_per_kind(self):
        self.assertEqual(regen.show_accept(rows("a", "b", order=True)), "rows a, b (ordered)")
        self.assertEqual(regen.show_accept(gold.val(70)), "value 70")
        self.assertEqual(regen.show_accept(gold.val((5, "USD"))), "value 5 USD")
        self.assertEqual(regen.show_accept(gold.ask("a", "b")), "ask a, b")
        self.assertEqual(regen.show_accept(gold.decline("not_found")), "decline not_found")
        shown = regen.show_accept(gold.diff(gold.upd("faucet", status="completed", completed=gold.ANY),
                                            gold.new("task", name="x"), gold.link("home", "new")))
        self.assertIn("faucet~{status=completed, completed=*}", shown)
        self.assertIn("+task{name=x}", shown)
        self.assertIn("link added home->new", shown)


class Derive(unittest.TestCase):
    """The accept derived from each kind of terminal effect passes its own run."""

    def derive(self, steps: list[dict], old: list[dict] | None = None, ids: Ids | None = None) -> tuple[dict, dict]:
        ids = ids or Ids("A")
        eff = turn_effect(steps)
        accept, notes = regen.derive_accept(eff, ids, old or [], steps)
        ok, problems, _ = judge_accept(accept, eff, ids)
        self.assertTrue(ok, problems)
        return accept, notes

    def test_rows(self):
        accept, _ = self.derive([rows_step(["dentist", "vet"])])
        self.assertEqual(accept, {"type": "rows", "rows": ["dentist", "vet"]})

    def test_rows_keep_the_order_of_the_old_gold_and_add_the_new_rows(self):
        accept, _ = self.derive([rows_step(["dentist", "vet", "haircut"])], [rows("vet", "dentist")])
        self.assertEqual(accept["rows"], ["vet", "dentist", "haircut"])

    def test_rows_order_counts_only_when_the_old_gold_said_so(self):
        steps = [rows_step(["vet", "dentist"], ordered=True)]
        accept, _ = self.derive(steps, [rows("dentist", "vet", order=True)])
        self.assertEqual((accept["rows"], accept.get("order")), (["vet", "dentist"], True))
        accept, notes = self.derive(steps, [rows("dentist", "vet")])
        self.assertNotIn("order", accept)
        accept, _ = self.derive(steps, [])  # nothing to go by: the runtime's answer is ordered
        self.assertTrue(accept["order"])
        # the author's `order` stays, whatever the runtime flags: it is the order of the rows of the run that is judged
        accept, _ = self.derive([rows_step(["vet", "dentist"])], [rows("dentist", "vet", order=True)])
        self.assertEqual((accept["rows"], accept.get("order")), (["vet", "dentist"], True))

    def test_rows_created_in_an_earlier_turn_are_named_plus_n(self):
        ids = Ids("A")
        made = "00000000-0000-0000-0000-0000000000aa"
        ids.created = [made]
        steps = [step("answer", {"kind": "task"}, {"answer": {"rows": [row("dentist"), {"id": made, "kind": "task",
                                                                                         "n": 40}]}})]
        accept, _ = self.derive(steps, ids=ids)
        self.assertEqual(accept["rows"], ["dentist", "+1"])

    def test_rows_without_a_world_key_cannot_be_named(self):
        steps = [step("answer", {}, {"answer": {"rows": [{"id": "ffffffff-0000", "kind": "task", "n": 5}]}})]
        with self.assertRaises(regen.Underivable):
            regen.derive_accept(turn_effect(steps), Ids("A"), [], steps)

    def test_value_counts_have_no_unit_and_no_float(self):
        accept, _ = self.derive([value_step("count", 36.0, {"op": "count"})])
        self.assertEqual(accept, {"type": "value", "values": [{"amount": 36, "unit": None}]})

    def test_value_money_and_groups(self):
        accept, _ = self.derive([value_step("balance", 180.4, {"op": "balance"}, unit="USD")])
        self.assertEqual(accept["values"], [{"amount": 180.4, "unit": "USD"}])
        groups = step("answer", {}, {"value": {"op": "count", "group": "status", "groups": [
            {"key": "open", "values": [{"amount": 33, "unit": None}]},
            {"key": "in_progress", "values": [{"amount": 3, "unit": None}]}]}})
        accept, _ = self.derive([groups])
        self.assertEqual(accept["groups"], {"open": [{"amount": 33, "unit": None}],
                                            "in_progress": [{"amount": 3, "unit": None}]})

    def test_diff_of_an_update_stamps_the_time_as_any(self):
        accept, _ = self.derive([act_step("complete", [complete("faucet")])])
        self.assertEqual(accept["type"], "diff")
        self.assertEqual(accept["diff"]["rows"], [{"key": "faucet", "change": "updated",
                                                   "fields": {"status": "completed", "completed": gold.ANY}}])

    def test_diff_keeps_the_matchers_of_the_old_spec_that_still_match(self):
        old = [gold.diff(gold.upd("dentist", date=gold.ANY))]
        steps = [act_step("reschedule", [updated("dentist", date=("2026-10-20", "2026-10-21"))])]
        accept, notes = self.derive(steps, old)
        self.assertEqual(accept["diff"]["rows"][0]["fields"], {"date": gold.ANY})
        self.assertIn("row spec dentist", notes["carried"])
        steps = [act_step("reschedule", [updated("dentist", date=("2026-10-20", "2026-10-21"), starred=(False, True))])]
        accept, _ = self.derive(steps, old)
        self.assertEqual(accept["diff"]["rows"][0]["fields"], {"date": gold.ANY, "starred": True})

    def test_a_row_with_no_old_spec_takes_the_field_order_of_a_sibling_spec(self):
        old = [gold.diff(gold.upd("dentist", status="completed", completed=gold.ANY))]
        flipped = updated("vet", completed=(None, "2026-10-14T08:40:00"), status=("open", "completed"))
        accept, _ = self.derive([act_step("complete", [complete("dentist"), flipped])], old)
        self.assertEqual([list(s["fields"]) for s in accept["diff"]["rows"]], [["status", "completed"]] * 2)
        accept, _ = self.derive([act_step("complete", [flipped])])  # no sibling: the order of the effect
        self.assertEqual(list(accept["diff"]["rows"][0]["fields"]), ["completed", "status"])

    def test_diff_creates_a_row_from_the_fields_the_call_set_and_keeps_an_old_has(self):
        made = "00000000-0000-0000-0000-0000000000bb"
        created = {"id": made, "kind": "task", "n": 40, "change": "created",
                   "fields": {"name": [None, "Call Greg about the lease renewal"], "date": [None, "2026-10-19"],
                              "status": [None, "open"], "trashed": [None, False]}}
        steps = [act_step("create", [created], {"kind": "task", "args": "name: Call Greg about the lease renewal\n"
                                                                         "date: {\"unit\":\"week\",\"rel\":1}"},
                          created=[{"id": made, "kind": "task", "n": 40}])]
        accept, notes = self.derive(steps)
        self.assertEqual(accept["diff"]["rows"], [{"new": "task", "fields": {
            "name": "Call Greg about the lease renewal", "date": "2026-10-19"}}])
        self.assertTrue(notes["derived"])
        accept, notes = self.derive(steps, [gold.diff(gold.new("task", name=gold.has("greg")))])
        self.assertEqual(accept["diff"]["rows"], [{"new": "task", "fields": {"name": {"has": ["greg"]}}}])
        self.assertIn("row spec new task", notes["carried"])

    def test_diff_names_the_created_row_new_in_a_link(self):
        made = "00000000-0000-0000-0000-0000000000cc"
        created = {"id": made, "kind": "task", "n": 40, "change": "created", "fields": {"name": [None, "x"]}}
        link = {"change": "added", "from": {"id": vid("home"), "kind": "list"}, "to": {"id": made, "kind": "task"}}
        accept, _ = self.derive([act_step("create", [created], {"kind": "task", "args": "name: x"}, links=[link],
                                          created=[{"id": made, "kind": "task", "n": 40}])])
        self.assertEqual(accept["diff"]["links"], [{"change": "added", "from": "home", "to": "new"}])

    def test_ask_offers_every_option_as_a_candidate(self):
        accept, _ = self.derive([ask_step(["meera_i", "meera_s"])])
        self.assertEqual(accept, {"type": "ask", "candidates": ["meera_i", "meera_s"]})

    def test_decline_names_the_reason(self):
        accept, _ = self.derive([step("decline", {"reason": "not_found"}, {"decline": {"reason": "not_found"}})])
        self.assertEqual(accept, {"type": "decline", "reasons": ["not_found"]})

    def test_already_is_carried_and_derived_for_an_empty_diff(self):
        steps = [act_step("star", [], {"kind": "photo", "name": "en0"}, ends=False,
                          already=[{**row("en0"), "state": "is starred"}]), rows_step(["en0"])]
        # a write that changed nothing, then an answer: the turn ends in rows, so `already` has no place in the accept
        accept, _ = self.derive(steps)
        self.assertEqual(accept["type"], "rows")
        only = [act_step("star", [], {"kind": "photo", "name": "en0"}, already=[{**row("en0"), "state": "is starred"}])]
        accept, notes = self.derive(only, [])
        self.assertEqual((accept["diff"], accept["already"]), ({"rows": [], "links": []}, ["en0"]))
        self.assertTrue(any("already" in d for d in notes["derived"]))
        accept, notes = self.derive(only, [gold.diff(already=["en0"]), gold.diff(already=["en1"])])
        self.assertEqual(accept["already"], ["en0"])
        self.assertIn("already en1", notes["dropped"])

    def test_settle_up_is_the_settlement_and_not_a_balance_change(self):
        zeroed = {"id": vid("jordan_b"), "kind": "person", "n": 30, "change": "updated",
                  "fields": {"balance": [{"amount": 180.4, "unit": "USD"}, {"amount": 0.0, "unit": "USD"}]}}
        text = 'settled up: #30 person "Jordan Blake" · no field changed\nsettlement: 180.40 USD paid to you'
        steps = [{**act_step("settle_up", [zeroed], {"kind": "person", "name": "Jordan"})}]
        steps[0]["response"]["text"] = text
        accept, _ = self.derive(steps)
        self.assertEqual((accept["diff"]["rows"], accept["settle"]), ([], [{"name": "Jordan Blake"}]))
        accept, notes = self.derive(steps, [gold.diff(settle=[("Jordan Blake", "180.40"), ("Jordan Lee", "5.00")])])
        self.assertEqual(accept["settle"], [{"name": "Jordan Blake", "amount": "180.40"}])
        self.assertIn("settle Jordan Lee", notes["dropped"])

    def test_a_balance_that_did_not_reach_zero_is_a_change_not_a_settlement(self):
        partly = {"id": vid("jordan_b"), "kind": "person", "n": 30, "change": "updated",
                  "fields": {"balance": [{"amount": 180.4, "unit": "USD"}, {"amount": 80.4, "unit": "USD"}]}}
        steps = [act_step("settle_up", [partly], {"kind": "person", "name": "Jordan"})]
        steps[0]["response"]["text"] = 'settled up: #30 person "Jordan Blake" · balance changed\nsettlement: 100.00 USD'
        accept, _ = self.derive(steps)
        self.assertNotIn("settle", accept)
        self.assertEqual(accept["diff"]["rows"], [{"key": "jordan_b", "change": "updated",
                                                   "fields": {"balance": 80.4}}])  # money is its amount in a spec

    def test_reveal_is_kept_only_while_the_secret_is_still_revealed(self):
        steps = [act_step("reveal", [], {"kind": "locker item", "name": "wifi"},
                          revealed='revealed: #24 locker item "Wifi" · password: R4man!')]
        accept, notes = self.derive(steps, [gold.diff(reveal=[("wifi", "R4man!"), ("router", "other")])])
        self.assertEqual(accept["reveal"], [{"key": "wifi", "contains": "R4man!"}])
        self.assertIn("reveal router", notes["dropped"])
        accept, _ = self.derive(steps, [])
        self.assertNotIn("reveal", accept)

    def test_the_also_diff_of_a_rows_accept_follows_the_run(self):
        old = [rows("dentist", also=gold.diff(gold.upd("faucet", status="completed", completed=gold.ANY)))]
        steps = [act_step("complete", [complete("faucet")], {"kind": "task", "name": "faucet"}, ends=False),
                 rows_step(["dentist"])]
        accept, _ = self.derive(steps, old)
        self.assertEqual(accept["type"], "rows")
        self.assertEqual(accept["diff"]["rows"][0]["key"], "faucet")
        accept, notes = self.derive([rows_step(["dentist"])], old)
        self.assertNotIn("diff", accept)
        self.assertTrue(any("also" in d for d in notes["dropped"]))

    def test_a_run_with_no_terminal_effect_has_no_gold(self):
        for steps in ([], [step("find", {}, {"rows": []}, ends=False)],
                      [step("answer", {}, {"error": "error: bad"}, ends=False)],
                      [step("find", {}, {"loop": True, "error": "repeated"}, ends=True)]):
            with self.assertRaises(regen.Underivable):
                regen.derive_accept(turn_effect(steps), Ids("A"), [], steps)

    def test_a_secret_revealed_under_a_gold_that_asks_for_none_has_no_accept(self):
        steps = [act_step("reveal", [], {"kind": "locker item"}, ends=False, revealed="revealed: x · password: y"),
                 rows_step(["wifi"])]
        with self.assertRaises(regen.Underivable):
            regen.derive_accept(turn_effect(steps), Ids("A"), [], steps)


class Stale(unittest.TestCase):
    """Which turns are touched at all."""

    def test_a_turn_that_passes_its_gold_is_left_alone_alternatives_and_all(self):
        gt = turn("q", rows("dentist"), rows("dentist", "vet"))
        res = one(gt, [rows_step(["dentist", "vet"])])
        self.assertFalse(res["changed"])
        self.assertIsNone(res["convention"])
        self.assertEqual(res["gold"], gt["gold"])

    def test_a_turn_with_no_run_fails_and_is_unexplained(self):
        res = one(turn("q", rows("dentist")), [])
        self.assertEqual(res["convention"], regen.UNEXPLAINED)
        self.assertFalse(res["changed"])

    def test_a_failing_turn_gets_one_derived_accept_that_passes(self):
        gt = turn("how many open tasks do i have", gold.val(33), gold.val(34),
                  ref=[{"tool": "answer", "args": {"op": "count", "where": "status = open"}}])
        steps = [value_step("count", 36, {"op": "count", "kind": "task", "where": "status = open"})]
        res = one(gt, steps)
        self.assertTrue(res["changed"] and res["was_failing"])
        self.assertEqual(len(res["gold"]), 1)
        self.assertTrue(judge_accept(res["gold"][0], res["effect"], Ids("A"))[0])


class Status(unittest.TestCase):
    """D-1044-7: `status = open` selects open and in_progress."""

    def check(self, gt: dict, steps: list[dict], convention: str | None = "status", sess=None, ti: int = 0) -> dict:
        res = one(gt, steps, sess, ti)
        self.assertEqual(res["convention"], convention, res["note"] or res["evidence"])
        return res

    def test_a_listing_gains_the_task_in_progress(self):
        gt = turn("what's open this week", rows("dogfood", "amazon"),
                  ref=[{"tool": "answer", "args": has_in_progress_call()}])
        res = self.check(gt, [rows_step(["dogfood", "amazon", "roadmap"], has_in_progress_call())])
        self.assertEqual(res["gold"], [{"type": "rows", "rows": ["dogfood", "amazon", "roadmap"]}])
        self.assertIn("roadmap (in_progress)", res["evidence"])

    def test_a_row_that_is_not_in_progress_is_not_the_rule(self):
        gt = turn("what's open", rows("dogfood"), ref=[{"tool": "answer", "args": has_in_progress_call()}])
        self.check(gt, [rows_step(["dogfood", "amazon"], has_in_progress_call())], regen.UNEXPLAINED)

    def test_the_call_must_carry_the_status_condition(self):
        gt = turn("what's due", rows("dogfood"))
        self.check(gt, [rows_step(["dogfood", "roadmap"], {"kind": "task"})], regen.UNEXPLAINED)

    def test_an_explicit_in_progress_in_the_call_is_not_the_rule(self):
        call = {"kind": "task", "where": 'status in ("open", "in_progress")'}
        gt = turn("what's open", rows("dogfood"), ref=[{"tool": "answer", "args": call}])
        self.check(gt, [rows_step(["dogfood", "roadmap"], call)], regen.UNEXPLAINED)

    def test_the_other_status_forms_of_the_rule(self):
        for where in ('status = "open"', 'status in ("open")', 'priority = 1 and status = open',
                      'status in ("open", "completed")'):
            call = {"kind": "task", "where": where}
            gt = turn("what's open", rows("dogfood"), ref=[{"tool": "answer", "args": call}])
            self.check(gt, [rows_step(["dogfood", "fridge"], call)])

    def test_a_count_moves_by_at_most_the_tasks_in_progress(self):
        call = {"op": "count", "kind": "task", "where": "status = open"}
        gt = turn("how many open", gold.val(33), ref=[{"tool": "answer", "args": call}])
        self.assertEqual(len(STARTED), 3)
        for new in (34, 35, 36):  # one, two or all three of the tasks in progress
            self.check(gt, [value_step("count", new, call)])
        self.check(gt, [value_step("count", 37, call)], regen.UNEXPLAINED)  # four is more than there are
        self.check(gt, [value_step("count", 32, call)], regen.UNEXPLAINED)  # and the wrong way

    def test_a_sum_moves_by_the_effort_of_a_subset_of_the_tasks_in_progress(self):
        call = {"op": "sum", "field": "effort", "kind": "task", "where": "status = open"}
        gt = turn("total effort left", gold.val(100), ref=[{"tool": "answer", "args": call}])
        for gained in (240, 40, 280):
            self.check(gt, [value_step("sum", 100 + gained, call, field="effort")])
        self.check(gt, [value_step("sum", 150, call, field="effort")], regen.UNEXPLAINED)

    def test_a_max_that_becomes_the_effort_of_a_task_in_progress(self):
        call = {"op": "max", "field": "effort", "kind": "task", "where": "status = open"}
        gt = turn("the biggest", gold.val(60), ref=[{"tool": "answer", "args": call}])
        self.check(gt, [value_step("max", 240, call, field="effort")])
        self.check(gt, [value_step("max", 100, call, field="effort")], regen.UNEXPLAINED)
        # fridge (40 minutes) is a task in progress, but more rows in the selection never lower a maximum
        self.check(gt, [value_step("max", 40, call, field="effort")], regen.UNEXPLAINED)

    def test_a_limit_pushes_a_row_out_when_the_one_in_progress_takes_its_place(self):
        call = {"kind": "task", "where": "status = open", "order": "effort desc", "limit": 1}
        gt = turn("the longest job", rows("faucet"), ref=[{"tool": "answer", "args": call}])
        # "longest" also lets the value in beside the row (D-1044-13, G3): the longest is roadmap, 240 minutes
        res = self.check(gt, [rows_step(["roadmap"], call)], "status+superlative")
        self.assertEqual(res["gold"][0]["rows"], ["roadmap"])
        self.assertEqual(res["gold"][1:], [gold.val(240)])
        no_limit = {"kind": "task", "where": "status = open"}
        gt = turn("the longest job", rows("faucet"), ref=[{"tool": "answer", "args": no_limit}])
        self.check(gt, [rows_step(["roadmap"], no_limit)], regen.UNEXPLAINED)

    def test_an_ordered_gold_keeps_its_order_when_a_task_in_progress_joins_in_the_middle(self):
        call = has_in_progress_call(order="date asc")
        gt = turn("what's left", rows("dogfood", "amazon", "vetbill", order=True),
                  ref=[{"tool": "find", "args": call}, {"tool": "answer", "args": {"rows": "@prev"}}])
        found = step("find", call, {"rows": [row(k) for k in ("dogfood", "roadmap", "amazon", "vetbill")],
                                    "result": "@1"}, ends=False)
        res = self.check(gt, [found, rows_step(["dogfood", "roadmap", "amazon", "vetbill"], {"rows": "@1"})])
        self.assertEqual(res["gold"], [{"type": "rows", "rows": ["dogfood", "roadmap", "amazon", "vetbill"],
                                        "order": True}])

    def test_the_longest_of_them_after_a_listing_the_rule_changed(self):
        read = turn("what's open", rows("dogfood", "faucet"), ref=[{"tool": "answer", "args": has_in_progress_call()}])
        longest = turn("and the longest of them", rows("faucet"),
                       ref=[{"tool": "answer", "args": {"within": "@prev", "order": "effort desc", "limit": 1}}])
        run = run_of([rows_step(["dogfood", "faucet", "roadmap"], has_in_progress_call(), result="@1")],
                     [rows_step(["roadmap"], {"within": "@1", "order": "effort desc", "limit": 1}, result="@2")])
        _, found = regen_s(session(read, longest), run)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "status"), (2, "status+superlative")])

    def test_a_follow_up_that_loses_a_row_the_listing_never_lost_is_not_the_rule(self):
        read = turn("what's open", rows("dogfood", "faucet"), ref=[{"tool": "answer", "args": has_in_progress_call()}])
        over = turn("the ones over 15 minutes", rows("dogfood", "faucet"),
                    ref=[{"tool": "answer", "args": {"within": "@prev", "where": "effort > 15"}}])
        run = run_of([rows_step(["dogfood", "faucet", "roadmap"], has_in_progress_call(), result="@1")],
                     [rows_step(["dogfood", "roadmap"], {"within": "@1", "where": "effort > 15"}, result="@2")])
        _, found = regen_s(session(read, over), run)  # roadmap joins, but faucet leaves for no reason of the rule
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "status"), (2, regen.UNEXPLAINED)])

    def test_a_maximum_by_priority_moves_in_the_group_of_the_task_in_progress(self):
        call = {"op": "max", "field": "effort", "kind": "task", "where": "status = open", "group": "priority"}
        gt = turn("biggest open job at each priority", gold.vgroups({"1": 120, "none": 60}),
                  ref=[{"tool": "answer", "args": call}])

        def grouped(one: float, none: float) -> dict:
            return step("answer", call, {"value": {"op": "max", "field": "effort", "group": "priority", "groups": [
                {"key": "1", "values": [{"amount": one, "unit": None}]},
                {"key": "none", "values": [{"amount": none, "unit": None}]}]}, "result": "@1"})

        res = one(gt, [grouped(240, 60)])  # roadmap, 240 minutes, priority 1
        self.assertEqual(res["convention"], "status")
        self.assertEqual(one(gt, [grouped(130, 60)])["convention"], regen.UNEXPLAINED)  # no such task in progress
        self.assertEqual(one(gt, [grouped(120, 90)])["convention"], regen.UNEXPLAINED)  # none: no such effort
        self.assertEqual(one(gt, [grouped(240, 90)])["convention"], regen.UNEXPLAINED)  # one group moves, one does not

    def test_an_aggregate_over_a_top_n_follows_the_rows_the_status_read_lists(self):
        call = has_in_progress_call(order="effort desc", limit=3)
        agg = {"op": "min", "field": "effort", "within": "@prev"}
        gt = turn("the smallest of the three longest", gold.val(60),
                  ref=[{"tool": "find", "args": call}, {"tool": "compute", "args": agg},
                       {"tool": "answer", "args": {"value": "@prev"}}])

        def steps(listed: list[str], value: float) -> list[dict]:
            return [step("find", call, {"rows": [row(k) for k in listed], "result": "@1"}, ends=False),
                    step("compute", agg, {"value": {"op": "min", "field": "effort",
                                                    "values": [{"amount": value, "unit": None}]}, "result": "@2"},
                         ends=False),
                    step("answer", {"value": "@2"}, {"value": {"op": "min", "field": "effort",
                                                              "values": [{"amount": value, "unit": None}]}})]

        self.assertEqual(one(gt, steps(["roadmap", "dogfood", "faucet"], 20))["convention"], "status")
        self.assertEqual(one(gt, steps(["dogfood", "amazon", "faucet"], 20))["convention"], regen.UNEXPLAINED)

    def test_not_open_loses_the_tasks_in_progress(self):
        call = {"kind": "task", "where": "status != open"}
        gt = turn("what is not open", rows("plants", "roadmap"), ref=[{"tool": "answer", "args": call}])
        self.check(gt, [rows_step(["plants"], call)])

    def test_a_write_through_a_result_reaches_the_task_in_progress(self):
        read = turn("what's open on home", rows("dogfood"), ref=[{"tool": "answer", "args": has_in_progress_call()}])
        write = turn("tick them off", gold.diff(gold.upd("dogfood", status="completed", completed=gold.ANY)),
                     ref=[{"tool": "act", "args": {"verb": "complete", "rows": ["@prev"]}}])
        run = run_of([rows_step(["dogfood", "fridge"], has_in_progress_call(), result="@1")],
                     [act_step("complete", [complete("dogfood"), complete("fridge", "in_progress")],
                               {"rows": ["@1"]})])
        new, found = regen_s(session(read, write), run)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "status"), (2, "status")])
        self.assertEqual([r["key"] for r in new["turns"][1]["gold"][0]["diff"]["rows"]], ["dogfood", "fridge"])

    def test_a_count_over_a_result_the_rule_changed_is_the_same_op_over_its_rows(self):
        read = turn("what's open on home", rows("dogfood"), ref=[{"tool": "answer", "args": has_in_progress_call()}])
        count = turn("how many's that", gold.val(1), ref=[{"tool": "answer", "args": COUNT_PREV}])
        run = run_of([rows_step(["dogfood", "fridge"], has_in_progress_call(), result="@1")],
                     [value_step("count", 2, {"op": "count", "within": "@1"}, result="@2")])
        _, found = regen_s(session(read, count), run)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "status"), (2, "status")])
        wrong = run_of([rows_step(["dogfood", "fridge"], has_in_progress_call(), result="@1")],
                       [value_step("count", 5, {"op": "count", "within": "@1"}, result="@2")])
        _, found = regen_s(session(read, count), wrong)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "status"), (2, regen.UNEXPLAINED)])

    def test_a_count_over_a_result_must_also_agree_with_the_old_rows(self):
        read = turn("what's open on home", rows("dogfood"), ref=[{"tool": "answer", "args": has_in_progress_call()}])
        count = turn("how many's that", gold.val(7), ref=[{"tool": "answer", "args": COUNT_PREV}])
        run = run_of([rows_step(["dogfood", "fridge"], has_in_progress_call(), result="@1")],
                     [value_step("count", 2, {"op": "count", "within": "@1"}, result="@2")])
        _, found = regen_s(session(read, count), run)  # one old row, an old count of seven: not the same op over them
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "status"), (2, regen.UNEXPLAINED)])

    def test_a_follow_up_on_a_result_nothing_changed_is_not_the_rule(self):
        read = turn("what's due", rows("dogfood"))
        count = turn("how many's that", gold.val(1), ref=[{"tool": "answer", "args": COUNT_PREV}])
        run = run_of([rows_step(["dogfood"], {"kind": "task"}, result="@1")],
                     [value_step("count", 2, {"op": "count", "within": "@1"}, result="@2")])
        _, found = regen_s(session(read, count), run)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, regen.UNEXPLAINED)])

    def test_a_task_started_in_the_session_is_in_progress_for_the_turns_after(self):
        edit = turn("start the dogfood task", gold.diff(gold.upd("dogfood", status="in_progress")))
        read = turn("what's open", rows("amazon"), ref=[{"tool": "answer", "args": has_in_progress_call()}])
        run = run_of([act_step("edit", [updated("dogfood", status=("open", "in_progress"))])],
                     [rows_step(["amazon", "dogfood"], has_in_progress_call())])
        _, found = regen_s(session(edit, read), run)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, "status")])

    def test_an_alternative_that_is_the_old_reading_is_dropped_when_the_run_passes_the_other(self):
        call = {"op": "count", "kind": "task", "where": "status = open"}
        gt = turn("how many open", gold.val(33), gold.val(35), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [value_step("count", 35, call)])
        self.assertTrue(res["changed"])
        self.assertFalse(res["was_failing"])
        self.assertEqual((res["convention"], res["gold"]), ("status", [gold.val(35)]))
        # the run still gives the old count: the other alternative is the new reading, not the old one
        res = one(gt, [value_step("count", 33, call)])
        self.assertFalse(res["changed"])
        self.assertEqual(res["gold"], gt["gold"])

    def test_a_status_alternative_stays_when_the_call_names_in_progress_itself(self):
        call = {"op": "count", "kind": "task", "where": 'status in ("open", "in_progress")'}
        gt = turn("how many open", gold.val(33), gold.val(35), ref=[{"tool": "answer", "args": call}])
        self.assertFalse(one(gt, [value_step("count", 35, call)])["changed"])


class WhatElse(unittest.TestCase):
    def two_turns(self, user: str, second_rows: list[str]) -> tuple[dict, list[dict]]:
        first = turn("what's due this week", rows("dogfood", "amazon"))
        second = turn(user, rows("dogfood", "amazon", "vetbill"))
        run = run_of([rows_step(["dogfood", "amazon"], result="@1")], [rows_step(second_rows, result="@2")])
        return regen_s(session(first, second), run)

    def test_the_rows_shown_earlier_are_left_out_of_what_else(self):
        new, found = self.two_turns("and what else is due", ["vetbill"])
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, "what-else")])
        self.assertEqual(new["turns"][1]["gold"], [{"type": "rows", "rows": ["vetbill"]}])
        self.assertIn("dogfood, amazon", found[0]["evidence"])

    def test_not_without_the_words(self):
        _, found = self.two_turns("and due friday", ["vetbill"])
        self.assertEqual([(c["convention"]) for c in found], [regen.UNEXPLAINED])

    def test_not_for_rows_never_shown(self):
        _, found = self.two_turns("and what else is due", ["amazon", "vetbill"][1:])
        self.assertEqual([c["convention"] for c in found], ["what-else"])
        first = turn("what's due this week", rows("dogfood"))
        second = turn("what else", rows("dogfood", "amazon", "vetbill"))
        run = run_of([rows_step(["dogfood"], result="@1")], [rows_step(["vetbill"], result="@2")])
        _, found = regen_s(session(first, second), run)
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])  # amazon was never shown


class AskOptions(unittest.TestCase):
    def ask_turn(self, completed: bool) -> dict:
        gt = turn("star meera", gold.ask("meera_i"), ref=[{"tool": "act", "args": {}}, {"tool": "ask", "args": {}}])
        steps = [step("act", {"verb": "star", "name": "meera"}, {"ambiguous": [row("meera_i"), row("meera_s")]},
                      ends=False), ask_step(["meera_i", "meera_s"], completed=completed)]
        return one(gt, steps)

    def test_the_ask_that_names_fewer_candidates_than_the_runtime_offers_is_tightened(self):
        res = self.ask_turn(True)
        self.assertTrue(res["changed"])
        self.assertFalse(res["was_failing"])
        self.assertEqual((res["convention"], res["gold"]), ("ask-options", [gold.ask("meera_i", "meera_s")]))

    def test_nothing_changes_when_the_run_did_not_complete_the_options(self):
        res = self.ask_turn(False)
        self.assertFalse(res["changed"])

    def test_the_sent_options_are_evidence_too(self):
        gt = turn("star meera", gold.ask("meera_i"))
        steps = [ask_step(["meera_i", "meera_s"], args={"question": "?", "options": ["#30"]})]
        steps[0]["response"]["effect"]["ask"]["options"][0]["n"] = 30
        steps[0]["response"]["effect"]["ask"]["options"][1]["n"] = 31
        self.assertTrue(one(gt, steps)["changed"])

    def test_an_alternative_ask_that_the_run_does_not_reach_is_kept(self):
        gt = turn("star meera", gold.ask("meera_i"), rows("meera_s"))
        res = one(gt, [ask_step(["meera_i", "meera_s"], completed=True)])
        self.assertEqual(res["gold"], [gold.ask("meera_i", "meera_s"), rows("meera_s")])


class Refusal(unittest.TestCase):
    def setUp(self):
        without_n7(self)

    RESTORE = {"verb": "restore", "kind": "person", "name": "craig"}

    def test_a_restore_past_the_window_ends_in_a_decline_the_runtime_wrote(self):
        gt = turn("bring craig back", rows("craig"),
                  ref=[{"tool": "act", "args": self.RESTORE}, {"tool": "answer", "args": {}}])
        res = one(gt, [composed("act", self.RESTORE, "decline", decline={"reason": "not_found"})])
        self.assertEqual((res["convention"], res["gold"]), ("refusal", [gold.decline("not_found")]))
        self.assertIn("restore", res["evidence"])

    def test_a_delete_the_vault_refuses_ends_in_an_ask_a_confirmation_can_answer(self):
        args = {"verb": "delete", "kind": "folder", "name": "house"}
        gt = turn("delete the house folder", gold.decline("out_of_scope"),
                  ref=[{"tool": "act", "args": args}, {"tool": "decline", "args": {}}])
        res = one(gt, [composed("act", args, "ask", ask={"question": "the folder holds 12 documents; delete?",
                                                         "options": [row("house")]})])
        self.assertEqual((res["convention"], res["gold"]), ("refusal", [gold.ask("house")]))

    def test_an_ask_the_model_wrote_is_not_a_refusal(self):
        gt = turn("bring craig back", rows("craig"))
        res = one(gt, [ask_step(["craig"])])
        self.assertEqual(res["convention"], regen.UNEXPLAINED)

    def test_the_effect_names_the_refusal_and_the_verb_can_be_any(self):
        args = {"verb": "remove_from", "kind": "person", "name": "kenji", "args": "from: $bigbend"}
        gt = turn("take kenji out of the group", gold.diff(gold.unlink("bigbend", "kenji")),
                  ref=[{"tool": "act", "args": args}])
        refusal = {"verb": "remove_from", "predicate": "member_off_ledger", "outcome": "ask"}
        res = one(gt, [composed("act", args, "ask", ask={"question": "settle up first?", "options": []},
                                composed=True, refusal=refusal)])
        self.assertEqual(res["convention"], "refusal")
        self.assertIn("member_off_ledger", res["evidence"])

    def test_the_decline_the_runtime_marks_as_composed_is_one_even_when_the_call_was_a_decline(self):
        gt = turn("bring craig back", rows("craig"), ref=[{"tool": "decline", "args": {}}])
        steps = [step("decline", {"reason": "not_found"}, {"decline": {"reason": "not_found"}, "composed": True,
                                                           "refusal": {"verb": "restore", "outcome": "decline"}})]
        self.assertEqual(one(gt, steps)["convention"], "refusal")

    def test_a_refusal_needs_a_restore_or_a_delete(self):
        args = {"verb": "star", "kind": "person", "name": "craig"}
        gt = turn("star craig", gold.diff(gold.upd("craig", starred=True)))
        res = one(gt, [composed("act", args, "decline", decline={"reason": "not_found"})])
        self.assertEqual(res["convention"], regen.UNEXPLAINED)


class BulkCap(unittest.TestCase):
    def setUp(self):
        without_n7(self)

    TASKS = ["acfilter", "amazon", "ammaalbum", "ammapkg", "bbcabin", "bbpass", "bbplan", "biketire", "callamma",
             "carreg", "caterer", "deposit", "dogfood"]

    def test_a_write_over_the_cap_becomes_the_runtimes_ask(self):
        self.assertEqual(len(self.TASKS), regen.ROW_CAP + 1)
        old = gold.diff(*[gold.trash(k) for k in self.TASKS])
        args = {"verb": "delete", "rows": ["@1"]}
        gt = turn("delete all the old ones", old, ref=[{"tool": "act", "args": args}])
        res = one(gt, [composed("act", args, "ask", ask={"question": "this would delete 13 tasks; delete all?",
                                                         "options": []})])
        self.assertEqual(res["convention"], "bulk-cap")
        self.assertEqual(res["gold"], [gold.ask()])
        self.assertIn("13 rows", res["evidence"])

    def test_the_effect_that_records_the_cap_is_enough_whatever_the_count_of_the_old_gold(self):
        args = {"verb": "complete", "rows": ["@1"]}
        gt = turn("tick them all", gold.diff(gold.upd("dogfood", status="completed", completed=gold.ANY)),
                  ref=[{"tool": "act", "args": args}])
        effect = {"ask": {"question": "this would complete 13 tasks; complete all of them?", "options": [], "count": 13},
                  "composed": True, "bulk": {"count": 13, "cap": 12, "verb": "complete"}, "verb": "complete"}
        res = one(gt, [composed("act", args, "ask", **effect)])
        self.assertEqual(res["convention"], "bulk-cap")
        self.assertIn("13", res["evidence"])

    def test_a_write_at_the_cap_is_not_the_cap(self):
        old = gold.diff(*[gold.trash(k) for k in self.TASKS[:regen.ROW_CAP]])
        args = {"verb": "complete", "rows": ["@1"]}
        gt = turn("tick them all", old, ref=[{"tool": "act", "args": args}])
        res = one(gt, [composed("act", args, "ask", ask={"question": "?", "options": []})])
        self.assertEqual(res["convention"], regen.UNEXPLAINED)

    def test_the_cap_is_the_one_of_the_runtime(self):
        self.assertEqual(regen.ROW_CAP, 12)

    ARGS = {"verb": "delete", "rows": ["@1"]}

    def cap_ask(self) -> dict:
        effect = {"ask": {"question": "this would delete 31 tasks; delete all of them?", "options": [], "count": 31},
                  "composed": True, "bulk": {"count": 31, "cap": 12, "verb": "delete"}, "verb": "delete"}
        return composed("act", self.ARGS, "ask", **effect)

    def pair(self, *accepts: dict) -> dict:
        gt = turn("clear out the finished ones", *accepts, ref=[{"tool": "act", "args": self.ARGS}])
        return one(gt, [self.cap_ask()])

    def test_a_decline_for_unbounded_destruction_beside_the_write_goes_with_it(self):
        res = self.pair(gold.diff(*[gold.trash(k) for k in self.TASKS]), gold.decline("unbounded_destruction"))
        self.assertEqual((res["convention"], res["gold"]), ("bulk-cap", [gold.ask()]))
        self.assertIn("decline unbounded_destruction beside a write of 13 rows", res["evidence"])

    def test_a_decline_for_another_reason_is_not_the_cap(self):
        res = self.pair(gold.diff(*[gold.trash(k) for k in self.TASKS]), gold.decline("never_mind"))
        self.assertEqual(res["convention"], regen.UNEXPLAINED)

    def test_a_decline_with_no_write_beside_it_is_not_the_cap_when_the_message_is_unbounded(self):
        gt = turn("clear out all my tasks", gold.decline("unbounded_destruction"), ref=[{"tool": "act", "args": self.ARGS}])
        self.assertEqual(one(gt, [self.cap_ask()])["convention"], regen.UNEXPLAINED)

    def test_the_decline_needs_the_effect_that_records_the_cap(self):
        args = {"verb": "complete", "rows": ["@1"]}
        done = [gold.upd(k, status="completed", completed=gold.ANY) for k in self.TASKS]
        gt = turn("tick them all", gold.diff(*done), gold.decline("unbounded_destruction"),
                  ref=[{"tool": "act", "args": args}])
        step = composed("act", args, "ask", ask={"question": "?", "options": []})  # no `bulk` in the effect
        self.assertEqual(one(gt, [step])["convention"], regen.UNEXPLAINED)
        step = composed("act", args, "ask", ask={"question": "?", "options": [], "count": 13}, verb="complete",
                        bulk={"count": 13, "cap": 12, "verb": "complete"})
        self.assertEqual(one(gt, [step])["convention"], "bulk-cap")


class NameMatch(unittest.TestCase):
    """A name-match is detected and reported with the old gold and the derived accept; it is never applied."""

    def held(self, res: dict, gt: dict, derived: list[dict]) -> None:
        self.assertEqual((res["convention"], res["held"], res["changed"]), ("name-match", True, False))
        self.assertEqual((res["gold"], res["new_gold"]), (gt["gold"], derived))

    def chain(self, name: str, kind: str = "person") -> tuple[dict, list[dict]]:
        ref = [{"tool": "answer", "args": {"kind": kind, "name": name}}, {"tool": "search", "args": {"text": name}},
               {"tool": "answer", "args": {"op": "balance", "rows": ["$tomas"]}}]
        gt = turn(f"where do i stand with {name}", gold.val((5, "USD")), ref=ref)
        return gt, [rows_step(["tomas"], {"kind": kind, "name": name})]

    def test_a_nickname_resolves_at_the_first_call_and_the_reference_chain_ends(self):
        gt, steps = self.chain("Tomi")
        res = one(gt, steps)
        self.held(res, gt, [rows("tomas")])
        self.assertIn("Tomás Herrera", res["evidence"])
        self.assertIn("report only", res["note"])

    def test_an_accent_the_old_matcher_did_not_fold(self):
        gt, steps = self.chain("Tomas")
        self.held(one(gt, steps), gt, [rows("tomas")])

    def test_the_exact_spelling_is_not_a_name_match(self):
        gt, steps = self.chain("Tomás")
        self.assertEqual(one(gt, steps)["convention"], regen.UNEXPLAINED)

    def test_a_row_the_old_matcher_took_is_no_dead_end(self):
        gt, steps = self.chain("Tomas")
        sess = regen.Sess({"world": "A"}, Ids("A"))
        sess.names["person"].append(("Tomas Test", []))  # the old matcher found this row at its first call
        res = one(gt, steps, sess)
        self.assertEqual((res["convention"], res["held"]), (regen.UNEXPLAINED, False))

    def test_a_name_match_is_reported_in_the_session_and_its_gold_stays(self):
        gt, steps = self.chain("Tomi")
        s = session(gt)
        new, found = regen.regen_session(s, run_of(steps))
        self.assertIs(new, s)
        self.assertEqual([(c["turn"], c["convention"], c["applied"], c["held"]) for c in found],
                         [(1, "name-match", False, True)])
        self.assertEqual(regen.show_gold(found[0]["old_gold"]), "value 5 USD")
        self.assertEqual(regen.show_gold(found[0]["new_gold"]), "rows tomas")
        summary = regen.summarize(found, 1, 1)
        self.assertEqual((summary["turns_changed"], summary["sessions_touched"], summary["by_convention"]), (0, 0, {}))
        self.assertEqual((summary["name_match"], summary["name_match_ids"]), (1, ["s1 t1"]))
        self.assertEqual(summary["unexplained"], 0)

    def test_the_other_turns_of_the_session_are_regenerated_all_the_same(self):
        gt, steps = self.chain("Tomi")
        call = {"op": "count", "kind": "task", "where": "status = open"}
        later = turn("how many open", gold.val(33), ref=[{"tool": "answer", "args": call}])
        new, found = regen_s(session(gt, later), run_of(steps, [value_step("count", 34, call)]))
        self.assertEqual([(c["turn"], c["convention"], c["applied"]) for c in found],
                         [(1, "name-match", False), (2, "status", True)])
        self.assertEqual((new["turns"][0]["gold"], new["turns"][1]["gold"]), (gt["gold"], [gold.val(34)]))

    def test_the_chain_must_have_ended_early(self):
        gt, steps = self.chain("Tomi")
        gt["ref"] = gt["ref"][:1]
        self.assertEqual(one(gt, steps)["convention"], regen.UNEXPLAINED)

    def test_the_reply_that_says_a_fit_was_taken(self):
        gt = turn("edit the rec letter", gold.diff(gold.upd("dentist", date=gold.ANY)),
                  ref=[{"tool": "act", "args": {}}])
        steps = [act_step("edit", [updated("faucet", date=("2026-10-14", "2026-10-15"))], {"name": "Rec letter"})]
        steps[0]["response"]["text"] = ('edited: #21 task "Recommendation letter"\n'
                                        'matched "Rec letter" to #21 task "Recommendation letter"')
        res = one(gt, steps)
        self.assertEqual((res["convention"], res["held"], res["changed"]), ("name-match", True, False))
        self.assertEqual(res["gold"], gt["gold"])
        steps[0]["response"]["text"] = 'edited: #21 task "Recommendation letter"'
        res = one(gt, steps)
        self.assertEqual((res["convention"], res["held"]), (regen.UNEXPLAINED, False))


class Readouts(unittest.TestCase):
    """The readouts of the runtime that read the message (#1044): container, status-words, next, last-one."""

    @staticmethod
    def noted(st: dict, note: str) -> dict:
        st["response"]["text"] = "answered:\n" + note
        return st

    def test_container_leaves_out_completed_and_cancelled_rows(self):
        gt = turn("what's under it now", rows("dogfood", "rent0", "gym"))
        res = one(gt, [self.noted(rows_step(["dogfood"]), regen.NOTE_CONTAINER)])
        self.assertEqual((res["convention"], res["gold"]), ("container", [rows("dogfood")]))
        self.assertIn("rent0, gym", res["evidence"])

    def test_container_may_leave_nothing(self):
        gt = turn("and the planning one", rows("rent0", "rent1"))
        res = one(gt, [self.noted(rows_step([]), regen.NOTE_CONTAINER)])
        self.assertEqual((res["convention"], res["gold"]), ("container", [rows()]))
        self.assertIn("none are left", res["evidence"])

    def test_container_not_for_an_open_row_left_out_or_without_the_note(self):
        gt = turn("what's under it now", rows("dogfood", "amazon", "rent0"))
        self.assertEqual(one(gt, [self.noted(rows_step(["dogfood"]), regen.NOTE_CONTAINER)])["convention"],
                         regen.UNEXPLAINED)
        gt = turn("what's under it now", rows("dogfood", "rent0"))
        self.assertEqual(one(gt, [rows_step(["dogfood"])])["convention"], regen.UNEXPLAINED)

    def test_container_counts_sums_and_groups_by_status(self):
        call = {"op": "count", "kind": "task", "linked_to": ["#8"]}
        res = one(turn("how many on home", gold.val(11)), [self.noted(value_step("count", 8, call), regen.NOTE_CONTAINER)])
        self.assertEqual((res["convention"], res["gold"]), ("container", [gold.val(8)]))
        up = one(turn("how many on home", gold.val(8)), [self.noted(value_step("count", 11, call), regen.NOTE_CONTAINER)])
        self.assertEqual(up["convention"], regen.UNEXPLAINED)  # leaving rows out never adds
        groups = {"op": "count", "kind": "task", "group": "status", "linked_to": ["#8"]}
        run = self.noted(step("answer", groups, {"value": {"op": "count", "group": "status", "groups": [
            {"key": "open", "values": [{"amount": 7, "unit": None}]},
            {"key": "in_progress", "values": [{"amount": 2, "unit": None}]}]}}), regen.NOTE_CONTAINER)
        old = gold.vgroups({"open": 7, "in_progress": 2, "completed": 2, "cancelled": 1})
        res = one(turn("breakdown by status", old), [run])
        self.assertEqual(res["convention"], "container")
        self.assertIn("cancelled, completed", res["evidence"])

    def test_status_words_leave_out_completed_rows(self):
        gt = turn("what's left", rows("dogfood", "rent0"))
        res = one(gt, [self.noted(rows_step(["dogfood"]), regen.NOTE_STATUS_WORDS)])
        self.assertEqual((res["convention"], res["gold"]), ("status-words", [rows("dogfood")]))

    def test_next_keeps_the_nearest_one_or_none(self):
        gt = turn("when is the next dentist", rows("dentist", "vet", "haircut"))
        res = one(gt, [self.noted(rows_step(["vet"]), regen.NOTE_NEXT)])
        self.assertEqual((res["convention"], res["gold"]), ("next", [rows("vet")]))
        self.assertIn("nearest of 3", res["evidence"])
        res = one(gt, [self.noted(rows_step([]), regen.NOTE_NEXT)])
        self.assertEqual((res["convention"], res["gold"]), ("next", [rows()]))
        two = one(gt, [self.noted(rows_step(["vet", "dentist"]), regen.NOTE_NEXT)])
        self.assertEqual(two["convention"], regen.UNEXPLAINED)  # a limit 1 never leaves two
        added = one(gt, [self.noted(rows_step(["amazon"]), regen.NOTE_NEXT)])
        self.assertEqual(added["convention"], regen.UNEXPLAINED)

    def test_last_one_reads_one_row(self):
        gt = turn("what was the last one", rows("dentist", "vet"))
        res = one(gt, [self.noted(rows_step(["vet"]), regen.NOTE_LAST)])
        self.assertEqual((res["convention"], res["gold"]), ("last-one", [rows("vet")]))
        self.assertEqual(one(gt, [rows_step(["vet"])])["convention"], regen.UNEXPLAINED)


class Unexplained(unittest.TestCase):
    def test_a_run_of_other_reference_calls_gives_no_gold(self):
        gt = turn("what's due", rows("dentist"), ref=[{"tool": "find", "args": {}}, {"tool": "answer", "args": {}}])
        res = one(gt, [rows_step(["dentist", "vet"])])  # the run answered at once: it is not this reference's run
        self.assertEqual(res["convention"], regen.UNEXPLAINED)
        self.assertIn("does not follow the reference calls", res["note"])
        self.assertFalse(res["changed"])
        passing = one(gt, [rows_step(["dentist"])])
        self.assertFalse(passing["changed"])

    def test_a_reference_that_ran_out_before_the_turn_ended_gives_no_gold(self):
        gt = turn("what's due", rows("dentist"), ref=[{"tool": "answer", "args": {}}])
        steps = [step("answer", {}, {"error": "error: x"}, ends=False), rows_step(["vet"])]
        self.assertEqual(one(gt, steps)["convention"], regen.UNEXPLAINED)

    def test_a_change_no_convention_fits_keeps_the_gold_and_says_what_was_derived(self):
        gt = turn("what's on this week", rows("dentist", "vet"))
        sess = regen.Sess({"world": "A"}, Ids("A"))
        res = one(gt, [rows_step(["dentist", "haircut"])], sess)
        self.assertEqual(res["convention"], regen.UNEXPLAINED)
        self.assertFalse(res["changed"])
        self.assertEqual(res["gold"], gt["gold"])
        self.assertEqual(res["new_gold"], [rows("dentist", "haircut")])
        self.assertIn("no convention explains", res["note"])

    def test_a_change_of_type_is_not_explained(self):
        gt = turn("how many", gold.val(3))
        res = one(gt, [rows_step(["dentist"])])
        self.assertEqual(res["convention"], regen.UNEXPLAINED)

    def test_every_alternative_must_be_explained(self):
        call = {"op": "count", "kind": "task", "where": "status = open"}
        gt = turn("how many open", gold.val(33), rows("dentist"), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [value_step("count", 34, call)])
        self.assertEqual(res["convention"], regen.UNEXPLAINED)

    def test_a_run_that_ends_in_an_error_has_no_gold(self):
        res = one(turn("q", rows("dentist")), [step("answer", {}, {"error": "error: nope"}, ends=False)])
        self.assertEqual(res["convention"], regen.UNEXPLAINED)
        self.assertIn("underivable", res["note"])


class ComposedMarks(unittest.TestCase):
    """A call marked bad that the runtime now answers by composing the outcome of a refusal."""

    def test_the_marked_call_that_ended_the_turn_in_a_composed_outcome(self):
        marked = {"tool": "act", "args": {"verb": "restore"}, "bad": True}
        s = session(turn("bring craig back", gold.decline("not_found"), ref=[marked, {"tool": "decline", "args": {}}]),
                    turn("star him", rows("craig"), ref=[{"tool": "answer", "args": {}, "bad": True}]))
        run = run_of([composed("act", {"verb": "restore"}, "decline", decline={"reason": "not_found"}, composed=True)],
                     [rows_step(["craig"])])
        self.assertEqual(regen.composed_marks(s, run), {(0, 0)})

    def test_an_error_at_a_marked_call_is_still_a_mark(self):
        s = session(turn("q", rows("dentist"), ref=[{"tool": "answer", "args": {}, "bad": True},
                                                      {"tool": "answer", "args": {}}]))
        run = run_of([step("answer", {}, {"error": "error: x"}, ends=False), rows_step(["dentist"])])
        self.assertEqual(regen.composed_marks(s, run), set())

    def test_an_unmarked_composed_outcome_is_nothing_to_unmark(self):
        s = session(turn("q", gold.decline("not_found"), ref=[{"tool": "act", "args": {}}]))
        run = run_of([composed("act", {}, "decline", decline={"reason": "not_found"}, composed=True)])
        self.assertEqual(regen.composed_marks(s, run), set())


class Sessions(unittest.TestCase):
    def test_a_session_nothing_changed_in_is_returned_as_it_is(self):
        s = session(turn("q", rows("dentist"), ref=[{"tool": "answer", "args": {}}]))
        new, found = regen.regen_session(s, run_of([rows_step(["dentist"])]))
        self.assertIs(new, s)
        self.assertEqual(found, [])

    def test_a_changed_session_keeps_everything_but_the_gold_of_the_changed_turn(self):
        call = {"op": "count", "kind": "task", "where": "status = open"}
        s = {**session(turn("q", rows("dentist"), ref=[{"tool": "answer", "args": {}}]),
                       turn("how many open", gold.val(33), ref=[{"tool": "answer", "args": call}])), "replay": [1, 2]}
        new, found = regen.regen_session(s, run_of([rows_step(["dentist"])], [value_step("count", 34, call)]))
        self.assertEqual(new["turns"][0], s["turns"][0])
        self.assertEqual(new["turns"][1]["gold"], [gold.val(34)])
        self.assertEqual({k: new[k] for k in new if k != "turns"}, {k: s[k] for k in s if k != "turns"})
        self.assertEqual(s["turns"][1]["gold"], [gold.val(33)])  # the session on file is not edited
        self.assertEqual((found[0]["id"], found[0]["turn"], found[0]["applied"], found[0]["was_failing"]),
                         ("s1", 2, True, True))
        self.assertEqual(regen.show_gold(found[0]["old_gold"]), "value 33")
        self.assertEqual(regen.show_gold(found[0]["new_gold"]), "value 34")

    def test_the_regenerated_session_passes_its_own_run_and_regenerates_to_itself(self):
        call = {"op": "count", "kind": "task", "where": "status = open"}
        ask = turn("star meera", gold.ask("meera_i"), ref=[{"tool": "ask", "args": {}}])
        s = session(turn("how many open", gold.val(33), gold.val(35), ref=[{"tool": "answer", "args": call}]),
                    turn("what's open", rows("dogfood"), ref=[{"tool": "answer", "args": has_in_progress_call()}]), ask)
        run = run_of([value_step("count", 35, call)], [rows_step(["dogfood", "roadmap"], has_in_progress_call())],
                     [ask_step(["meera_i", "meera_s"], completed=True)])
        new, found = regen.regen_session(s, run)
        self.assertEqual([c["convention"] for c in found], ["status", "status", "ask-options"])
        again, nothing = regen.regen_session(new, run)
        self.assertEqual(nothing, [])
        self.assertIs(again, new)
        ids = Ids("A")
        for gt, record in zip(new["turns"], run["turns"]):
            self.assertTrue(judge_turn(gt, record["steps"], ids)["pass"])

    def test_a_row_created_in_one_turn_is_named_by_the_next(self):
        made = "00000000-0000-0000-0000-0000000000dd"
        created = {"id": made, "kind": "task", "n": 40, "change": "created", "fields": {"name": [None, "Call Greg"]}}
        make = turn("add a task to call greg", gold.diff(gold.new("task", name=gold.has("greg"))))
        read = turn("what's on the list", rows("dentist"))
        run = run_of([act_step("create", [created], {"kind": "task", "args": "name: Call Greg"},
                               created=[{"id": made, "kind": "task", "n": 40}])],
                     [step("answer", {}, {"answer": {"rows": [row("dentist"), {"id": made, "kind": "task", "n": 40}]}})])
        _, found = regen_s(session(make, read), run)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, regen.UNEXPLAINED)])
        self.assertEqual(found[0]["new_gold"], [rows("dentist", "+1")])

    def test_the_summary_counts_turns_by_convention_and_names_the_unexplained(self):
        found = [
            {"id": "a", "turn": 1, "convention": "status", "applied": True, "was_failing": True},
            {"id": "a", "turn": 2, "convention": "status", "applied": True, "was_failing": False},
            {"id": "b", "turn": 1, "convention": "ask-options", "applied": True, "was_failing": False},
            {"id": "c", "turn": 3, "convention": regen.UNEXPLAINED, "applied": False, "was_failing": True},
            {"id": "d", "turn": 4, "convention": "name-match", "applied": False, "was_failing": True}]
        for c in found:
            c["held"] = c["convention"] == "name-match"
        summary = regen.summarize(found, 10, 31)
        self.assertEqual(summary["by_convention"], {"ask-options": 1, "status": 2})
        self.assertEqual((summary["turns_changed"], summary["sessions_touched"]), (3, 2))
        self.assertEqual((summary["failed_the_old_gold"], summary["tightened_though_passing"]), (1, 2))
        self.assertEqual((summary["unexplained"], summary["unexplained_ids"]), (1, ["c t3"]))
        self.assertEqual((summary["name_match"], summary["name_match_ids"]), (1, ["d t4"]))


# ---------------------------------------------------------------------------------------------
# D-1044-13: the gold rulings
# ---------------------------------------------------------------------------------------------


class RulingsWhatElse(unittest.TestCase):
    """G2: "what else", "besides X": the rows shown, offered, written or named are left out."""

    def test_besides_leaves_out_the_row_the_message_names(self):
        gt = turn("who else besides arjun", rows("arjun", "kenji"), ref=[{"tool": "answer", "args": {"kind": "person"}}])
        res = one(gt, [rows_step(["kenji"], {"kind": "person"})])
        self.assertEqual((res["convention"], res["gold"]), ("what-else", [rows("kenji")]))
        self.assertIn("names them: arjun", res["evidence"])

    def test_a_row_the_message_does_not_name_is_not_left_out(self):
        gt = turn("who else besides kenji", rows("arjun", "kenji"), ref=[{"tool": "answer", "args": {"kind": "person"}}])
        self.assertEqual(one(gt, [rows_step(["kenji"], {"kind": "person"})])["convention"], regen.UNEXPLAINED)

    def test_the_row_a_turn_before_wrote_was_shown_to_the_user(self):
        done = turn("tick off the faucet", gold.diff(gold.upd("faucet", status="completed", completed=gold.ANY)))
        again = turn("anything else due", rows("faucet", "dogfood"), ref=[{"tool": "answer", "args": {"kind": "task"}}])
        run = run_of([act_step("complete", [complete("faucet")], {"kind": "task", "name": "faucet"})],
                     [rows_step(["dogfood"])])
        _, found = regen_s(session(done, again), run)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, "what-else")])
        self.assertIn("faucet", found[0]["evidence"])

    def test_a_row_an_ask_offered_was_shown_too(self):
        ask = turn("star meera", gold.ask("meera_i", "meera_s"))
        again = turn("the other ones", rows("meera_i", "meera_s", "kenji"), ref=[{"tool": "answer", "args": {}}])
        run = run_of([ask_step(["meera_i", "meera_s"])], [rows_step(["kenji"])])
        _, found = regen_s(session(ask, again), run)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, "what-else")])

    def test_apart_from_and_the_one_after_are_cues(self):
        for message in ("apart from arjun", "and the one after", "aside from arjun"):
            self.assertTrue(regen.WHAT_ELSE.search(message), message)
        self.assertFalse(regen.WHAT_ELSE.search("what's due friday"))


class RulingsWidening(unittest.TestCase):
    """G3, G4, G8: the other shape of the answer is an accepted alternative."""

    def test_the_row_of_a_superlative_has_its_value_beside_it(self):
        call = {"kind": "task", "order": "effort desc", "limit": 1}
        gt = turn("the longest job", rows("roadmap", order=True), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [rows_step(["roadmap"], call, ordered=True)])
        self.assertEqual((res["convention"], res["changed"]), ("superlative", True))
        self.assertEqual(res["gold"], [rows("roadmap", order=True), gold.val(240)])
        self.assertFalse(res["was_failing"])

    def test_the_value_of_a_superlative_has_its_row_beside_it(self):
        call = {"op": "max", "field": "effort", "rows": "$roadmap"}
        gt = turn("how long will it take", gold.val(240), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [value_step("max", 240, call, field="effort")])
        self.assertEqual((res["convention"], res["gold"]), ("superlative", [gold.val(240), rows("roadmap")]))

    def test_the_value_over_the_rows_of_the_turn_before_names_the_row_that_holds_it(self):
        read = turn("what's open", rows("faucet", "roadmap", "dogfood"), ref=[{"tool": "answer", "args": {"kind": "task"}}])
        call = {"op": "max", "field": "effort", "within": "@prev"}
        top = turn("the biggest of those", gold.val(240), ref=[{"tool": "answer", "args": call}])
        run = run_of([rows_step(["faucet", "roadmap", "dogfood"])], [value_step("max", 240, call, field="effort")])
        new, found = regen_s(session(read, top), run)
        self.assertEqual(new["turns"][1]["gold"], [gold.val(240), rows("roadmap")])
        self.assertEqual([c["convention"] for c in found], ["superlative"])

    def test_a_money_field_has_the_currency_of_the_vault(self):
        call = {"kind": "debt", "order": "amount desc", "limit": 1}
        gt = turn("the biggest debt", rows("uber", order=True), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [rows_step(["uber"], call, ordered=True)])
        self.assertEqual(res["gold"][1], gold.val((32.4, "USD")))

    def test_most_and_least_time_or_effort_are_superlatives_too(self):
        """G1 (owner ruling 2026-10-06): 'which needs the most time', 'most effort', 'least time' ask for the extreme."""
        call = {"kind": "task", "within": "@1", "order": "effort desc", "limit": 1}
        for message in ("which needs the most time, that's where to start", "the one that takes the most time",
                        "which has the most effort", "which one takes the least amount of time", "least time please"):
            self.assertTrue(regen.SUPERLATIVE.search(message), message)
            gt = turn(message, rows("roadmap", order=True), ref=[{"tool": "answer", "args": call}])
            res = one(gt, [rows_step(["roadmap"], call, ordered=True)])
            self.assertEqual((res["convention"], res["changed"]), ("superlative", True), message)
            self.assertEqual(res["gold"], [rows("roadmap", order=True), gold.val(240)], message)

    def test_most_or_least_of_something_else_is_no_superlative(self):
        for message in ("what's most important", "most of the time it rains", "the least timely one", "how much time is left"):
            self.assertFalse(regen.SUPERLATIVE.search(message), message)

    def test_the_value_of_the_most_time_has_its_row_beside_it(self):
        call = {"op": "max", "field": "effort", "rows": "$roadmap"}
        gt = turn("which needs the most time", gold.val(240), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [value_step("max", 240, call, field="effort")])
        self.assertEqual((res["convention"], res["gold"]), ("superlative", [gold.val(240), rows("roadmap")]))

    def test_no_superlative_in_the_message_no_alternative(self):
        call = {"kind": "task", "order": "effort desc", "limit": 1}
        gt = turn("the top one", rows("roadmap", order=True), ref=[{"tool": "answer", "args": call}])
        self.assertFalse(one(gt, [rows_step(["roadmap"], call, ordered=True)])["changed"])

    def test_a_list_of_rows_has_no_single_value(self):
        call = {"kind": "task", "order": "effort desc", "limit": 2}
        gt = turn("the longest jobs", rows("roadmap", "slides", order=True), ref=[{"tool": "answer", "args": call}])
        self.assertFalse(one(gt, [rows_step(["roadmap", "slides"], call, ordered=True)])["changed"])

    def test_who_owes_me_has_the_people_of_the_debts_beside_the_debt_rows(self):
        """B6 (D-1044-15): 'who owes me', 'who do i owe', 'who's that to' about debts accept the debt rows and the people."""
        call = {"kind": "debt", "where": "direction = i_owe and status = open"}
        gt = turn("who do i owe", rows("uber", "magazine", "jordan_gas"), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [rows_step(["uber", "magazine", "jordan_gas"], call)])
        self.assertEqual((res["convention"], res["changed"]), ("debt-or-person", True))
        self.assertEqual(res["gold"], [rows("uber", "magazine", "jordan_gas"), rows("chloe", "meera_i", "jordan_b")])
        self.assertFalse(res["was_failing"])

    def test_two_debts_of_one_person_are_one_person(self):
        call = {"kind": "debt", "where": "status = open"}
        gt = turn("who owes me or who do i owe", rows("jordan_gas", "acltix"), ref=[{"tool": "answer", "args": call}])
        got, labels, _ = regen.widen_gold(gt["gold"], gt["user"], [{"tool": "answer", "args": call}],
                                          regen.Sess({"world": "A"}, Ids("A")), 0)
        self.assertEqual((got, labels), ([rows("jordan_gas", "acltix"), rows("jordan_b")], ["debt-or-person"]))

    def test_a_check_the_accept_carries_stays_with_the_people(self):
        diff = gold.diff(gold.upd("uber", status="settled"))["diff"]
        gt = turn("paid chloe, who do i owe now", {**rows("magazine"), "diff": diff}, ref=[{"tool": "answer", "args": {"kind": "debt"}}])
        got, _, _ = regen.widen_gold(gt["gold"], gt["user"], gt["ref"], regen.Sess({"world": "A"}, Ids("A")), 0)
        self.assertEqual(got[1], {**rows("meera_i"), "diff": diff})

    def test_the_people_of_the_debts_need_the_words_and_debt_rows(self):
        sess = regen.Sess({"world": "A"}, Ids("A"))
        for user, accept in (("which debts are open", rows("uber")), ("who is on the ballet list", rows("uber")),
                             ("who owes me", rows("dogfood")), ("who owes me", rows("uber", "dogfood")),
                             ("who owes me", rows()), ("who owes me", gold.val(3))):
            got, labels, _ = regen.widen_gold([accept], user, [{"tool": "answer", "args": {"kind": "debt"}}], sess, 0)
            self.assertEqual((got, labels), ([accept], []), (user, accept))

    def test_the_cues_of_the_debt_idiom(self):
        for user in ("who owes me money", "who do i owe", "who still owes me", "who's that to", "who is that to", "whos it to",
                     "alex paid me for the shoes, who do i owe now", "who do i owe from last month",
                     "ok who owes me"):
            self.assertTrue(regen.WHO_DEBT.search(user), user)
        for user in ("who is on the guest list", "who's coming", "which debts are open", "what do i owe", "who else is on that",
                     "open debts where i'm the one who owes", "who's left with a star"):
            self.assertFalse(regen.WHO_DEBT.search(user), user)

    def test_the_people_when_the_run_answers_the_debts_and_the_other_way_round(self):
        call = {"kind": "debt", "where": "direction = i_owe and status = open"}
        gt = turn("who do i owe", rows("chloe", "meera_i"), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [rows_step(["uber", "magazine"], call)])
        self.assertEqual((res["convention"], res["gold"]), ("debt-or-person", [rows("chloe", "meera_i"), rows("uber", "magazine")]))
        gt = turn("who do i owe", rows("uber", "magazine"), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [rows_step(["chloe", "meera_i"], call)])
        self.assertEqual((res["convention"], res["gold"]), ("debt-or-person", [rows("uber", "magazine"), rows("chloe", "meera_i")]))

    def test_every_widening_convention_has_a_widener_and_a_rule(self):
        self.assertEqual(sorted(regen.WIDENING), sorted(regen.WIDENERS))
        self.assertTrue(set(regen.WIDENING) <= set(regen.RULES))

    def test_a_widener_reads_the_steps_of_the_run_and_the_others_do_not(self):
        # the three of D-1044-13 derive from the gold, the calls and the world: the run changes nothing for them
        call = {"kind": "task", "order": "effort desc", "limit": 1}
        gt = turn("the longest job", rows("roadmap", order=True), ref=[{"tool": "answer", "args": call}])
        sess = regen.Sess({"world": "A"}, Ids("A"))
        with_run = regen.widen_gold(gt["gold"], gt["user"], [{"tool": "answer", "args": call}], sess, 0,
                                    [rows_step(["roadmap"], call, ordered=True)])
        without = regen.widen_gold(gt["gold"], gt["user"], [{"tool": "answer", "args": call}], sess, 0)
        self.assertEqual(with_run, without)
        self.assertEqual(with_run[1], ["superlative"])

    def test_widening_is_idempotent(self):
        call = {"kind": "task", "order": "effort desc", "limit": 1}
        gt = turn("the longest job", rows("roadmap", order=True), gold.val(240), ref=[{"tool": "answer", "args": call}])
        self.assertFalse(one(gt, [rows_step(["roadmap"], call, ordered=True)])["changed"])

    def test_a_run_that_answers_the_other_shape_is_explained_and_both_are_kept(self):
        call = {"kind": "task", "order": "effort desc", "limit": 1}
        gt = turn("longest job", rows("roadmap", order=True), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [value_step("max", 240, {"op": "max", "field": "effort"}, field="effort")])
        self.assertEqual((res["convention"], res["gold"]), ("superlative", [rows("roadmap", order=True), gold.val(240)]))

    def test_a_grouped_count_with_one_group_is_also_the_plain_value(self):
        call = {"op": "count", "group": "status", "kind": "task"}
        gt = turn("how many by status", gold.vgroups({"open": 4}), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [step("answer", call, {"value": {"op": "count", "group": "status", "groups": [
            {"key": "open", "values": [{"amount": 4, "unit": None}]}]}})])
        self.assertEqual((res["convention"], res["gold"]), ("group-or-value", [gold.vgroups({"open": 4}), gold.val(4)]))

    def test_two_groups_are_not_a_plain_value(self):
        gt = turn("how many by status", gold.vgroups({"open": 4, "completed": 2}),
                  ref=[{"tool": "answer", "args": {"op": "count", "group": "status", "kind": "task"}}])
        res = one(gt, [step("answer", {"op": "count", "group": "status", "kind": "task"}, {"value": {
            "op": "count", "group": "status", "groups": [{"key": "open", "values": [{"amount": 4, "unit": None}]},
                                                         {"key": "completed", "values": [{"amount": 2, "unit": None}]}]}})])
        self.assertFalse(res["changed"])

    def test_a_plain_value_the_run_gives_as_one_group_is_explained(self):
        call = {"op": "count", "group": "status", "kind": "task"}
        gt = turn("how many", gold.val(3), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [step("answer", call, {"value": {"op": "count", "group": "status", "groups": [
            {"key": "open", "values": [{"amount": 3, "unit": None}]}]}})])
        self.assertEqual((res["convention"], res["gold"]), ("group-or-value", [gold.val(3), gold.vgroups({"open": 3})]))

    def test_a_row_still_in_a_folder_has_the_folder_beside_it(self):
        call = {"kind": "document", "name": "lease", "linked_to": "$house"}
        gt = turn("is it still in the house folder", rows("lease"), ref=[{"tool": "answer", "args": call}])
        res = one(gt, [rows_step(["lease"], call)])
        self.assertEqual((res["convention"], res["gold"]), ("container-or-row", [rows("lease"), rows("house")]))

    def test_the_container_needs_a_container_and_the_words(self):
        call = {"kind": "document", "name": "lease", "linked_to": "$house"}
        gt = turn("which folder has the lease", rows("lease"), ref=[{"tool": "answer", "args": call}])
        self.assertFalse(one(gt, [rows_step(["lease"], call)])["changed"])
        call = {"kind": "task", "name": "faucet", "linked_to": "$tomas"}
        gt = turn("is it still on tomas", rows("faucet"), ref=[{"tool": "answer", "args": call}])
        self.assertFalse(one(gt, [rows_step(["faucet"], call)])["changed"])


class AfterSeriesAsk(unittest.TestCase):
    """G2 (owner ruling 2026-10-06): the turn after a runtime `series-ask` accepts the write the gold has or the same
    `Which one?` again, when the gold on file was written for another dialog."""

    YOGA = ["yoga0", "yoga1", "yoga2", "yoga3"]  # four events of one name in world A
    MADE = "00000000-0000-0000-0000-0000000000cc"

    def series_ask(self, keys=None) -> dict:
        return composed("act", {"verb": "reschedule", "kind": "event", "name": "yoga with ananya"}, "ask",
                        composed=True, compose={"action": "ask_options", "family": "ambiguous_write"},
                        ask={"question": "Which one?", "options": [row(k) for k in keys or self.YOGA]})

    def create_step(self) -> dict:
        created = {"id": self.MADE, "kind": "event", "n": 50, "change": "created",
                   "fields": {"name": [None, "Yoga with Ananya"], "date": [None, "2026-10-17T11:00"]}}
        return act_step("create", [created], {"kind": "event", "args": "name: Yoga with Ananya\ndate: x"})

    CREATE = gold.diff(gold.new("event", name="Yoga with Ananya", date="2026-10-17T11:00"))

    def first(self, *old: dict) -> dict:
        return turn("move my yoga to saturday", *(old or (gold.ask(),)),
                    ref=[{"tool": "act", "args": {"verb": "reschedule", "kind": "event", "name": "yoga with ananya"}},
                         {"tool": "ask", "args": {"question": "There's no yoga coming up, want me to book one?"}}])

    def second(self, *old: dict, user: str = "yeah saturday at 11") -> dict:
        return turn(user, *(old or (self.CREATE,)),
                    ref=[{"tool": "act", "args": {"verb": "create", "kind": "event"}}])

    def go(self, first_old: dict | None, second_old: dict | None = None, second_run=None, user="yeah saturday at 11"):
        s = session(self.first(first_old) if first_old else self.first(), self.second(second_old, user=user)
                    if second_old else self.second(user=user))
        record = run_of([self.series_ask()], [second_run or self.create_step()])
        return regen.regen_session(s, record)

    def test_it_is_registered(self):
        for registry in (regen.WIDENING, regen.CONVENTIONS, regen.WIDENERS, regen.RULES):
            self.assertIn("after-series-ask", registry)

    def test_a_write_after_the_runtime_ask_over_a_series_also_accepts_the_ask_again(self):
        new, found = self.go(None)
        self.assertEqual([(c["turn"], c["convention"], c["applied"]) for c in found], [(2, "after-series-ask", True)])
        self.assertEqual(new["turns"][1]["gold"], [self.CREATE, gold.ask(*self.YOGA)])
        self.assertIn("Which one? over 4 events", found[0]["evidence"])
        self.assertEqual(new["turns"][0]["gold"], [gold.ask()])  # the turn that was asked keeps its gold

    def test_the_widened_gold_passes_the_create_and_the_ask_over_the_series_and_not_a_decline(self):
        new, _ = self.go(None)
        ids = Ids("A")
        accepts = new["turns"][1]["gold"]
        for steps, want in (([self.create_step()], True), ([self.series_ask()], True),
                            ([self.series_ask(["yoga0", "yoga1"])], False),  # an ask over rows of another set
                            ([step("decline", {"reason": "not_found"}, {"decline": {"reason": "not_found"}})], False)):
            self.assertEqual(judge_turn({"gold": accepts}, steps, ids)["pass"], want)

    def test_a_run_that_asks_again_is_explained_by_the_convention(self):
        new, found = self.go(None, second_run=self.series_ask())
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, "after-series-ask")])
        self.assertNotEqual(found[0]["convention"], regen.UNEXPLAINED)

    def test_it_is_idempotent(self):
        new, _ = self.go(None)
        again, found = regen.regen_session(new, run_of([self.series_ask()], [self.create_step()]))
        self.assertEqual(again["turns"][1]["gold"], new["turns"][1]["gold"])
        self.assertEqual(found, [])

    def test_a_gold_that_does_not_write_gets_nothing(self):
        without_n7(self)
        for old in (gold.decline("never_mind"), rows("yoga0"), gold.val(3)):
            s = session(self.first(), self.second(old, user="when's the next one"))
            record = run_of([self.series_ask()], [rows_step(["yoga0"])])
            new, _ = regen.regen_session({**s, "turns": s["turns"]}, record)
            self.assertNotIn(gold.ask(*self.YOGA), new["turns"][1]["gold"], old)

    def test_a_reference_that_asked_over_rows_was_the_same_dialog(self):
        new, found = self.go(gold.ask(*self.YOGA))
        self.assertEqual(found, [])
        self.assertEqual(new["turns"][1]["gold"], [self.CREATE])

    def test_a_write_the_gold_had_for_one_instance_is_another_dialog(self):
        # the reference wrote to the next instance; the series-ask replaces that gold, and the turn after it is widened
        wrote = gold.diff(gold.upd("yoga0", date="2026-10-17T11:00"))
        new, found = self.go(wrote)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "series-ask"), (2, "after-series-ask")])
        self.assertEqual(new["turns"][1]["gold"], [self.CREATE, gold.ask(*self.YOGA)])

    def test_an_ask_over_rows_that_are_no_series_is_not_one(self):
        other = composed("act", {"verb": "cancel", "kind": "event", "name": "x"}, "ask", composed=True,
                         compose={"action": "ask_options", "family": "ambiguous_write"},
                         ask={"question": "Which one?", "options": [row("yoga0"), row("dentist")]})
        s = session(self.first(), self.second())
        new, found = regen.regen_session(s, run_of([other], [self.create_step()]))
        self.assertEqual(found, [])
        self.assertEqual(new["turns"][1]["gold"], [self.CREATE])

    def test_the_model_s_own_ask_is_not_the_runtime_s(self):
        mine = ask_step(self.YOGA)  # an `ask` call the model made: nothing composed
        s = session(self.first(), self.second())
        new, found = regen.regen_session(s, run_of([mine], [self.create_step()]))
        self.assertEqual(found, [])

    def test_the_turn_after_next_is_not_widened(self):
        third = turn("and the last one", gold.diff(gold.upd("yoga1", date="2026-10-18T11:00")),
                     ref=[{"tool": "act", "args": {"verb": "reschedule", "kind": "event"}}])
        s = session(self.first(), self.second(), third)
        new, found = regen.regen_session(s, run_of([self.series_ask()], [self.create_step()],
                                                   [act_step("reschedule", [updated("yoga1", date=("a", "b"))])]))
        self.assertEqual(new["turns"][1]["gold"], [self.CREATE, gold.ask(*self.YOGA)])
        self.assertNotIn(gold.ask(*self.YOGA), new["turns"][2]["gold"])
        self.assertNotIn("after-series-ask", [c["convention"] for c in found if c["turn"] == 3])


class DeclineAnyReason(unittest.TestCase):
    """N7 (owner ruling 2026-10-06): a decline for any reason passes a turn whose gold is a decline. A widening: the old
    accept stays and one with every reason is added beside it."""

    ALL = list(regen.DECLINE_REASONS)

    def decline_run(self, reason: str) -> list[dict]:
        return [step("decline", {"reason": reason}, {"decline": {"reason": reason}})]

    def widen(self, *accepts: dict) -> tuple[list[dict], list[str]]:
        got, labels, _ = regen.widen_gold(list(accepts), "forget it", [], regen.Sess({"world": "A"}, Ids("A")), 0)
        return got, labels

    def test_the_reasons_are_the_ones_the_scorer_knows(self):
        self.assertEqual(self.ALL, ["out_of_scope", "unbounded_destruction", "sealed_egress", "fabricated_secret",
                                    "never_mind", "not_found"])
        self.assertIn("decline-any-reason", regen.WIDENING)
        self.assertIn("decline-any-reason", regen.WIDENERS)
        self.assertIn("decline-any-reason", regen.CONVENTIONS)

    def test_a_decline_gold_gains_the_other_reasons_and_keeps_its_own_first(self):
        got, labels = self.widen(gold.decline("sealed_egress"))
        self.assertEqual(labels, ["decline-any-reason"])
        self.assertEqual(got[0], gold.decline("sealed_egress"))
        self.assertEqual(got[1], gold.decline("sealed_egress", *[r for r in self.ALL if r != "sealed_egress"]))
        self.assertEqual(len(got), 2)

    def test_every_decline_of_the_gold_counts_and_one_accept_is_added(self):
        got, _ = self.widen(gold.ask("roadmap"), gold.decline("not_found"), gold.decline("out_of_scope"))
        self.assertEqual(got[:3], [gold.ask("roadmap"), gold.decline("not_found"), gold.decline("out_of_scope")])
        self.assertEqual(sorted(got[3]["reasons"]), sorted(self.ALL))
        self.assertEqual(len(got), 4)

    def test_a_gold_with_no_decline_is_untouched(self):
        for accept in (rows("roadmap"), gold.ask("roadmap"), gold.ask(), gold.val(3), gold.diff(gold.trash("dogfood"))):
            self.assertEqual(self.widen(accept), ([accept], []), accept)

    def test_it_is_idempotent(self):
        once, _ = self.widen(gold.decline("not_found"))
        twice, labels = regen.widen_gold(once, "forget it", [], regen.Sess({"world": "A"}, Ids("A")), 0)[:2]
        self.assertEqual((twice, labels), (once, []))
        gt = turn("forget it", gold.decline("never_mind"), ref=[{"tool": "decline", "args": {}}])
        res = one(gt, self.decline_run("never_mind"))
        again = one({**gt, "gold": res["gold"]}, self.decline_run("never_mind"))
        self.assertEqual((again["changed"], again["gold"]), (False, res["gold"]))

    def test_a_gold_that_already_accepts_every_reason_is_left_as_it_is(self):
        self.assertEqual(self.widen(gold.decline(*reversed(self.ALL))), ([gold.decline(*reversed(self.ALL))], []))

    def test_a_decline_for_another_reason_passes_and_the_turn_is_listed_by_convention(self):
        gt = turn("send my passwords to bob", gold.decline("sealed_egress"), ref=[{"tool": "decline", "args": {}}])
        for reason in self.ALL:
            res = one(gt, self.decline_run(reason))
            self.assertFalse(res["was_failing"], reason)
            self.assertEqual((res["convention"], res["changed"]), ("decline-any-reason", True), reason)
            self.assertTrue(judge_turn({"gold": res["gold"]}, self.decline_run(reason), Ids("A"))["pass"], reason)
        self.assertIn("alternative accept decline", res["evidence"])

    def test_a_run_that_does_not_decline_still_fails_the_decline_gold(self):
        gt = turn("send my passwords to bob", gold.decline("sealed_egress"), ref=[{"tool": "answer", "args": {}}])
        run = [rows_step(["roadmap"])]
        res = one(gt, run)
        self.assertEqual(res["convention"], regen.UNEXPLAINED)
        self.assertFalse(res["changed"])
        self.assertFalse(judge_turn({"gold": regen.widen_gold(gt["gold"], "x", [], regen.Sess({"world": "A"}, Ids("A")), 0)[0]},
                                    run, Ids("A"))["pass"])

    def test_a_session_of_val_or_test_is_widened_by_regen_session(self):
        t1 = turn("forget it", gold.decline("never_mind"), ref=[{"tool": "decline", "args": {}}])
        t2 = turn("show the roadmap", rows("roadmap"), ref=[{"tool": "answer", "args": {"kind": "task"}}])
        run = run_of(self.decline_run("never_mind"), [rows_step(["roadmap"])])
        for name in ("val", "test"):
            new, found = regen_s({**session(t1, t2), "set": name}, run)
            self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "decline-any-reason")])
            self.assertEqual(new["turns"][0]["gold"][0], gold.decline("never_mind"))
            self.assertEqual(sorted(new["turns"][0]["gold"][1]["reasons"]), sorted(self.ALL))
            self.assertEqual(new["turns"][1]["gold"], [rows("roadmap")])
            again, found = regen_s(new, run)
            self.assertEqual((found, again["turns"]), ([], new["turns"]))

    def test_a_derived_decline_is_widened_too(self):
        res = one(turn("bring craig back", rows("craig"), ref=[{"tool": "act", "args": {"verb": "restore", "kind": "person", "name": "craig"}}]),
                  [composed("act", {"verb": "restore", "kind": "person", "name": "craig"}, "decline", decline={"reason": "not_found"})])
        self.assertEqual(res["convention"], "refusal+decline-any-reason")
        self.assertEqual(res["gold"][0], gold.decline("not_found"))
        self.assertEqual(len(res["gold"]), 2)

    def test_a_replaced_gold_does_not_carry_the_label_of_the_accept_it_lost(self):
        args = {"verb": "restore", "kind": "person", "name": "craig"}
        gt = turn("bring craig back", gold.decline("out_of_scope"), ref=[{"tool": "act", "args": args}])
        res = one(gt, [composed("act", args, "ask", ask={"question": "which?", "options": [row("craig")]})])
        self.assertNotIn("decline-any-reason", res["convention"] or "")


class RulingsFocusWins(unittest.TestCase):
    def two(self, written_before: bool = True) -> tuple[dict, list[dict]]:
        star = turn("star the home wifi", gold.diff(gold.upd("wifi", starred=True)))
        pad = turn("what's open", rows("dogfood"), ref=[{"tool": "answer", "args": {"kind": "task"}}])
        reveal = turn("tell me the wifi password", gold.ask("wifi", "officewifi"),
                      ref=[{"tool": "act", "args": {"verb": "reveal"}}])
        starred = act_step("star", [updated("wifi", starred=(False, True))], {"kind": "locker item", "name": "wifi"})
        shown = act_step("reveal", [], {"verb": "reveal", "rows": ["#1"]}, revealed="biscuit-2208")
        if written_before:
            return regen_s(session(star, reveal), run_of([starred], [shown]))
        return regen_s(session(star, pad, reveal), run_of([starred], [rows_step(["dogfood"])], [shown]))

    def test_the_row_starred_in_the_turn_before_is_the_one_in_focus(self):
        new, found = self.two()
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, "focus-wins")])
        self.assertEqual(new["turns"][1]["gold"], [{"type": "diff", "diff": {"rows": [], "links": []},
                                                    "reveal": [{"key": "wifi", "contains": "biscuit-2208"}]}])

    def test_a_row_written_two_turns_back_is_not_in_focus_alone(self):
        _, found = self.two(written_before=False)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(3, regen.UNEXPLAINED)])


class RulingsBulkAndDue(unittest.TestCase):
    def setUp(self):
        without_n7(self)

    def test_the_message_bounds_the_request_or_it_does_not(self):
        for text in ("just the ones i already finished", "delete all the old ones", "only the done tasks", "clear them"):
            self.assertTrue(regen.bounded_wording(text), text)
        for text in ("delete all my tasks", "wipe everything", "delete every task"):
            self.assertFalse(regen.bounded_wording(text), text)

    def test_a_decline_for_a_bounded_request_becomes_the_cap_ask(self):
        args = {"verb": "delete", "kind": "task", "where": "status = \"completed\""}
        effect = {"ask": {"question": "this would delete 31 tasks; delete all of them?", "options": [], "count": 31},
                  "composed": True, "bulk": {"count": 31, "cap": 12, "verb": "delete"}, "verb": "delete"}
        gt = turn("fine just the ones i already finished", gold.decline("unbounded_destruction"),
                  ref=[{"tool": "act", "args": args}])
        res = one(gt, [composed("act", args, "ask", **effect)])
        self.assertEqual((res["convention"], res["gold"]), ("bulk-cap", [gold.ask()]))
        self.assertIn("bounds", res["evidence"])

    def due(self, user: str, kept: list[str], where: str = "status = open") -> dict:
        call = {"kind": "task", "when": '{"unit":"week","rel":0}', "where": where}
        gt = turn(user, rows("faucet", "dogfood", "plants"), ref=[{"tool": "answer", "args": call}])
        return one(gt, [rows_step(kept, call)])

    def test_what_is_due_leaves_out_the_tasks_done(self):
        res = self.due("what's due this week", ["faucet", "dogfood"])  # plants is completed in world A
        self.assertEqual((res["convention"], res["gold"]), ("due-active", [rows("faucet", "dogfood")]))
        self.assertIn("plants", res["evidence"])

    def test_a_follow_up_that_reads_the_result_of_a_due_turn_follows_it(self):
        call = {"kind": "task", "when": '{"unit":"week","rel":0}', "where": "status = open"}
        read = turn("what's due this week", rows("faucet", "dogfood", "plants"), ref=[{"tool": "answer", "args": call}])
        narrow = {"within": "@1", "order": "date asc"}
        again = turn("those by date", rows("faucet", "dogfood", "plants"), ref=[{"tool": "answer", "args": narrow}])
        run = run_of([rows_step(["faucet", "dogfood"], call, result="@1")],
                     [rows_step(["faucet", "dogfood"], narrow, result="@2")])
        _, found = regen_s(session(read, again), run)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "due-active"), (2, "due-active")])
        self.assertIn("result of a due turn", found[1]["evidence"])
        _, found = regen_s(session(turn("what's on this week", rows("faucet", "dogfood", "plants"),
                                        ref=[{"tool": "answer", "args": {"kind": "task"}}]), again), run)
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED, regen.UNEXPLAINED])

    def test_not_for_a_row_that_is_still_to_do_not_without_the_word_not_with_all(self):
        self.assertEqual(self.due("what's due this week", ["faucet", "plants"])["convention"], regen.UNEXPLAINED)
        self.assertEqual(self.due("what's on this week", ["faucet", "dogfood"])["convention"], regen.UNEXPLAINED)
        self.assertEqual(self.due("everything due this week", ["faucet", "dogfood"])["convention"], regen.UNEXPLAINED)

    def test_the_reference_read_of_a_due_span_says_status_open(self):
        call = {"kind": "task", "when": '{"unit":"week","rel":0}'}
        t = turn("what's due this week", rows("faucet"), ref=[{"tool": "answer", "args": call}])
        new = regen.rewrite_due_active(t)
        self.assertEqual(new["ref"][0]["args"], {**call, "where": "status = open"})
        self.assertEqual(t["ref"][0]["args"], call)  # the turn on file is not edited
        self.assertIsNone(regen.rewrite_due_active(new))  # idempotent
        counted = turn("how many tasks are due friday", gold.val(3),
                       ref=[{"tool": "answer", "args": {"op": "count", "kind": "task", "when": "{}", "where": "priority = 1"}}])
        self.assertEqual(regen.rewrite_due_active(counted)["ref"][0]["args"]["where"], "priority = 1 and status = open")

    def test_the_rewrite_leaves_alone_what_it_does_not_read(self):
        call = {"kind": "task", "when": "{}"}
        for t in (turn("what's due this week", rows("faucet"), ref=[{"tool": "answer", "args": {**call, "where": "status = completed"}}]),
                  turn("everything that was due this week", rows("faucet"), ref=[{"tool": "answer", "args": call}]),
                  turn("what's on this week", rows("faucet"), ref=[{"tool": "answer", "args": call}]),
                  turn("what's due on the house list", rows("faucet"),
                       ref=[{"tool": "answer", "args": {**call, "linked_to": "$home"}}]),
                  turn("what's due on the people", rows("tomas"), ref=[{"tool": "answer", "args": {**call, "kind": "person"}}]),
                  turn("what's due", gold.ask(), ref=[{"tool": "ask", "args": {}}])):
            self.assertIsNone(regen.rewrite_due_active(t), t["user"])


class RulingsComposed(unittest.TestCase):
    def setUp(self):
        without_n7(self)

    ARGS = {"verb": "star", "kind": "person", "name": "meera"}

    def test_the_ask_the_runtime_composes_over_other_candidates(self):
        gt = turn("star meera", gold.ask("jordan_b"), ref=[{"tool": "act", "args": self.ARGS}])
        res = one(gt, [composed("act", self.ARGS, "ask", ask={"question": "which?",
                                                              "options": [row("meera_i"), row("meera_s")]})])
        self.assertEqual((res["convention"], res["gold"]), ("composed-ask", [gold.ask("meera_i", "meera_s")]))

    def test_a_decline_not_found_becomes_the_ask_of_near_spellings(self):
        gt = turn("star meera", gold.decline("not_found"), ref=[{"tool": "act", "args": self.ARGS}])
        res = one(gt, [composed("act", self.ARGS, "ask", ask={"question": "did you mean #30?", "options": [row("meera_i")]})])
        self.assertEqual(res["convention"], "composed-ask")

    def test_a_write_gold_is_not_explained_by_a_composed_ask(self):
        gt = turn("star meera", gold.diff(gold.upd("meera_i", starred=True)), ref=[{"tool": "act", "args": self.ARGS}])
        res = one(gt, [composed("act", self.ARGS, "ask", ask={"question": "which?", "options": [row("meera_i")]})])
        self.assertEqual(res["convention"], regen.UNEXPLAINED)

    def test_the_decline_the_runtime_composes_where_the_model_would_ask(self):
        gt = turn("star meera", gold.ask("meera_i", "meera_s"), ref=[{"tool": "act", "args": self.ARGS}])
        res = one(gt, [composed("act", self.ARGS, "decline", decline={"reason": "not_found"})])
        self.assertEqual((res["convention"], res["gold"]), ("composed-decline", [gold.decline("not_found")]))

    def test_a_decline_of_the_model_is_not_composed(self):
        gt = turn("star meera", gold.ask("meera_i"), ref=[{"tool": "decline", "args": {}}])
        res = one(gt, [step("decline", {"reason": "not_found"}, {"decline": {"reason": "not_found"}})])
        self.assertEqual(res["convention"], regen.UNEXPLAINED)

    def test_a_refusal_of_a_verb_beyond_restore_and_delete_is_composed_refusal(self):
        args = {"verb": "add_to", "kind": "person", "name": "kenji", "args": "to: $bigbend"}
        refusal = {"verb": "add_to", "predicate": "person_into_event", "outcome": "decline"}
        gt = turn("put kenji on the dentist", gold.diff(gold.link("bigbend", "kenji")), ref=[{"tool": "act", "args": args}])
        res = one(gt, [composed("act", args, "decline", decline={"reason": "out_of_scope"}, composed=True,
                                refusal=refusal)])
        self.assertEqual((res["convention"], res["gold"]), ("composed-refusal", [gold.decline("out_of_scope")]))
        self.assertIn("person_into_event", res["evidence"])

    def test_restore_and_delete_stay_the_refusal_of_d_1044_10(self):
        args = {"verb": "restore", "kind": "person", "name": "craig"}
        gt = turn("bring craig back", rows("craig"), ref=[{"tool": "act", "args": args}])
        res = one(gt, [composed("act", args, "decline", decline={"reason": "not_found"}, composed=True,
                                refusal={"verb": "restore", "outcome": "decline"})])
        self.assertEqual(res["convention"], "refusal")


class RulingsMessaging(unittest.TestCase):
    def setUp(self):
        without_n7(self)

    def test_a_request_to_send_something_to_someone(self):
        for text in ("text jordan, running late", "tell sunita i said hi", "please email the landlord",
                     "can you message meera that i'm late", "send a text to dana"):
            self.assertTrue(regen.is_messaging(text), text)
        for text in ("tell me what's due", "text me the list", "log a text with jordan", "what did jordan text",
                     "note that i told meera", "remind me to text jordan"):
            self.assertFalse(regen.is_messaging(text), text)

    def test_the_last_turn_of_a_session_becomes_the_decline(self):
        t = turn("text jordan, running late", gold.ask("jordan_b", "jordan_l"),
                 ref=[{"tool": "act", "args": {"verb": "log", "name": "Jordan"}}, {"tool": "ask", "args": {}}])
        new = regen.rewrite_messaging(t, True)
        self.assertEqual((new["gold"], new["ref"]), ([gold.decline("out_of_scope")],
                                                     [{"tool": "decline", "args": {"reason": "out_of_scope"}}]))
        self.assertIsNone(regen.rewrite_messaging(t, False))  # a later turn would answer the ask
        self.assertIsNone(regen.rewrite_messaging(new, True))  # idempotent
        self.assertIsNone(regen.rewrite_messaging(turn("text jordan", rows("jordan_b")), True))

    def test_a_run_that_declines_explains_the_change(self):
        gt = turn("tell meera i said hi", gold.ask("meera_i", "meera_s"), ref=[{"tool": "decline", "args": {}}])
        res = one(gt, [step("decline", {"reason": "out_of_scope"}, {"decline": {"reason": "out_of_scope"}})])
        self.assertEqual((res["convention"], res["gold"]), ("messaging", [gold.decline("out_of_scope")]))

    def test_the_conventions_all_have_a_rule(self):
        self.assertEqual(sorted(regen.CONVENTIONS), sorted(regen.RULES))
        self.assertTrue(set(regen.WIDENING + regen.REWRITES + regen.REPORT_ONLY) <= set(regen.CONVENTIONS))


FIX_TURN = {"user": "ok", "gold": [{"type": "rows", "rows": ["dogfood"]}], "ref": [{"tool": "answer", "args": {}}], "tags": []}


def fixed(**fix) -> dict:
    return {"ruling": "G0", "why": "a test", "expect": regen.digest("ok"), **fix}


class RulingsFixes(unittest.TestCase):
    def test_a_fix_replaces_the_gold_and_the_calls_and_leaves_the_turn_on_file(self):
        fix = fixed(ref=[{"tool": "ask", "args": {"question": "?"}}], gold=[gold.ask()])
        new = regen.apply_fix(FIX_TURN, fix, "s1", 1)
        self.assertEqual((new["gold"], new["ref"]), ([gold.ask()], [{"tool": "ask", "args": {"question": "?"}}]))
        self.assertEqual(FIX_TURN["gold"], [{"type": "rows", "rows": ["dogfood"]}])
        self.assertEqual(regen.apply_fix(new, fix, "s1", 1), new)  # idempotent

    def test_an_added_alternative_stands_beside_the_gold_once(self):
        fix = fixed(add=[rows("amazon")])
        new = regen.apply_fix(FIX_TURN, fix, "s1", 1)
        self.assertEqual(new["gold"], [rows("dogfood"), rows("amazon")])
        self.assertEqual(regen.apply_fix(new, fix, "s1", 1), new)

    def test_a_rewritten_message_keeps_the_old_one_in_a_note(self):
        fix = fixed(user="okay then")
        new = regen.apply_fix(FIX_TURN, fix, "s1", 1)
        self.assertEqual((new["user"], new["rewritten"]), ("okay then", "G0: was 'ok'"))
        self.assertEqual(regen.apply_fix(new, fix, "s1", 1), new)

    def test_a_fix_never_lands_on_another_message(self):
        with self.assertRaises(ValueError):
            regen.apply_fix({**FIX_TURN, "user": "something else"}, fixed(gold=[gold.ask()]), "s1", 1)

    def test_prepare_applies_the_fixes_and_says_what_it_did(self):
        s = session(FIX_TURN, turn("later", rows("amazon"), ref=[{"tool": "answer", "args": {}}]))
        with mock.patch.dict(regen.FIXES, {("s1", 1): fixed(add=[rows("amazon")])}):
            new, found = regen.prepare_session(s)
            again, nothing = regen.prepare_session(new)
        self.assertEqual(new["turns"][0]["gold"], [rows("dogfood"), rows("amazon")])
        self.assertEqual([(r["id"], r["turn"], r["convention"], r["ref_changed"]) for r in found],
                         [("s1", 1, "fix G0", False)])
        self.assertIs(again, new)
        self.assertEqual(nothing, [])

    def test_prepare_rewrites_the_messaging_and_due_turns_unless_a_fix_owns_the_turn(self):
        due = turn("what's due friday", rows("faucet"),
                   ref=[{"tool": "answer", "args": {"kind": "task", "when": "{}"}}])
        text = turn("text meera", gold.ask("meera_i", "meera_s"), ref=[{"tool": "ask", "args": {}}])
        new, found = regen.prepare_session(session(due, text))
        self.assertEqual([r["convention"] for r in found], ["due-active", "messaging"])
        self.assertEqual(new["turns"][0]["ref"][0]["args"]["where"], "status = open")
        owned = fixed(ref=[{"tool": "answer", "args": {"kind": "task"}}])
        with mock.patch.dict(regen.FIXES, {("s1", 1): {**owned, "expect": regen.digest("what's due friday")}}):
            _, found = regen.prepare_session(session(due))
        self.assertEqual([r["convention"] for r in found], ["fix G0"])

    def run_session(self, fix: dict, kept: list[str]) -> tuple[dict, list[dict]]:
        s = session(FIX_TURN)
        with mock.patch.dict(regen.FIXES, {("s1", 1): fix}):
            if fix.get("gold") or fix.get("add"):
                s, _ = regen.prepare_session(s)
            return regen.regen_session(s, run_of([rows_step(kept)]))

    def test_a_pinned_gold_the_run_fails_is_unexplained_and_never_re_derived(self):
        new, found = self.run_session(fixed(gold=[rows("amazon")]), ["dogfood"])
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])
        self.assertIn("pins this gold", found[0]["note"])
        self.assertEqual(new["turns"][0]["gold"], [rows("amazon")])

    def test_a_pinned_gold_the_run_satisfies_is_left_as_it_is(self):
        new, found = self.run_session(fixed(gold=[rows("amazon")]), ["amazon"])
        self.assertEqual(found, [])

    def test_a_fix_the_input_lacks_is_unexplained_and_says_to_prepare_first(self):
        s = session(FIX_TURN)
        with mock.patch.dict(regen.FIXES, {("s1", 1): fixed(gold=[rows("amazon")])}):
            _, found = regen.regen_session(s, run_of([rows_step(["amazon"])]))
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])
        self.assertIn("prepares the sets first", found[0]["note"])

    def test_a_derive_fix_changes_the_calls_and_leaves_the_gold_to_a_convention(self):
        fix = fixed(derive=True, ref=[{"tool": "answer", "args": {}}])
        self.assertFalse(regen.pinned("s1", 1))
        with mock.patch.dict(regen.FIXES, {("s1", 1): fix}):
            self.assertFalse(regen.pinned("s1", 1))
        with mock.patch.dict(regen.FIXES, {("s1", 1): fixed(gold=[gold.ask()])}):
            self.assertTrue(regen.pinned("s1", 1))

    def test_a_pinned_turn_still_gets_the_widening_alternatives(self):
        call = {"op": "count", "group": "status", "kind": "task"}
        t = turn("ok", gold.vgroups({"open": 2}), ref=[{"tool": "answer", "args": call}])
        s = session(t)
        run = run_of([step("answer", call, {"value": {"op": "count", "group": "status", "groups": [
            {"key": "open", "values": [{"amount": 2, "unit": None}]}]}})])
        with mock.patch.dict(regen.FIXES, {("s1", 1): fixed(gold=[gold.vgroups({"open": 2})], ref=t["ref"])}):
            s, _ = regen.prepare_session(s)
            new, found = regen.regen_session(s, run)
        self.assertEqual([c["convention"] for c in found], ["group-or-value"])
        self.assertEqual(new["turns"][0]["gold"], [gold.vgroups({"open": 2}), gold.val(2)])

    def test_the_table_has_what_it_needs_and_no_test_session(self):
        from lib import read_jsonl

        for (sid, number), fix in regen.FIXES.items():
            self.assertGreaterEqual(number, 1)
            self.assertTrue({"ruling", "why", "expect"} <= set(fix), (sid, number))
            self.assertTrue({"user", "ref", "gold", "add"} & set(fix), (sid, number))
            self.assertFalse("gold" in fix and "add" in fix, (sid, number))
        sets = regen.Path(__file__).resolve().parent / "sets"
        if (sets / "test.jsonl").exists():
            held_out = {s["id"] for s in read_jsonl(sets / "test.jsonl")}
            self.assertEqual({sid for sid, _ in regen.FIXES} & held_out, set())  # ids only: no message is read

    def test_prepare_sets_refuses_a_test_id_in_the_table(self):
        import json
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "test.jsonl").write_text(json.dumps(session(FIX_TURN)) + "\n", encoding="utf-8")
            with mock.patch.dict(regen.FIXES, {("s1", 1): fixed(add=[rows("amazon")])}):
                with self.assertRaises(SystemExit):
                    regen.prepare_sets(tmp, tmp / "out", ["test"])
                found = regen.prepare_sets(tmp, tmp / "out", ["val"]) if (tmp / "val.jsonl").exists() else {}
            self.assertEqual(found, {})

    def test_prepare_sets_writes_the_sets_and_the_list(self):
        import json
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "val.jsonl").write_text(json.dumps(session(FIX_TURN)) + "\n" + json.dumps(
                {**session(FIX_TURN), "id": "s2"}) + "\n", encoding="utf-8")
            with mock.patch.dict(regen.FIXES, {("s1", 1): fixed(add=[rows("amazon")])}):
                found = regen.prepare_sets(tmp, tmp / "out", ["val"])
            written = [json.loads(line) for line in (tmp / "out" / "val.jsonl").read_text(encoding="utf-8").split("\n") if line]
            self.assertEqual([len(w["turns"][0]["gold"]) for w in written], [2, 1])
            self.assertEqual([r["id"] for r in found["val"]], ["s1"])
            self.assertIn("fix G0", regen.prepared_markdown(found))


if __name__ == "__main__":
    unittest.main()
