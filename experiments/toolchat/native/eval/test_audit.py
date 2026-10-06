"""What the blind gold audit settled (D-1044-13, refined): K1 the kind of a kind-less read (`kindless`), K2 a balance
narrowed to one group (`narrowed-balance`, a widening), K3 a request broken off mid-sentence (`broken-off`), K4 a bare
plural is not "all" (`bare-plural`), the fix of the one gold-wrong turn (ruling A1); view_world.py on the authored
worlds; and M5d and M5e, a recurring event or task named without a date is asked about (`series-ask`).

    python3 -m unittest test_audit -v      # from experiments/toolchat/native/eval

Sessions and runs are made up on world A (hand-built as the runtime reports them), never a held-out message.
"""

from __future__ import annotations

import io
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import gold
import regen
import view_world
from lib import load_keys
from score import Ids

KEYS = load_keys("A")
RUNTIME = Path(__file__).resolve().parents[4] / "crates" / "nativetools" / "src"
GROUND = RUNTIME / "ground.rs"
DAY0 = {"unit": "day", "rel": 0}
WEEKEND = {"from": {"unit": "week", "rel": 0, "weekday": 6}, "to": {"unit": "week", "rel": 0, "weekday": 7}}


def vid(key: str) -> str:
    return KEYS[key]["id"]


def row(key: str, n: int = 30) -> dict:
    return {"id": vid(key), "kind": KEYS[key]["kind"], "n": n}


def step(tool: str, args: dict, effect: dict, ends: bool = True) -> dict:
    return {"model": "", "response": {"call": {"tool": tool, "args": args}, "effect": {"tool": tool, **effect},
                                      "ends_turn": ends, "text": ""}}


def rows_step(keys: list[str], args: dict, result: str = "@1") -> dict:
    return step("answer", args, {"answer": {"rows": [row(k) for k in keys], "ordered": False, "result": result}})


def value_step(amount: float, args: dict, unit: str = "USD", op: str = "balance") -> dict:
    return step("answer", args, {"value": {"op": op, "field": None, "values": [{"amount": amount, "unit": unit}]},
                                 "result": "@1"})


def act_step(verb: str, diff_rows: list[dict], args: dict | None = None, **extra) -> dict:
    return step("act", {"verb": verb, **(args or {})}, {"verb": verb, "diff": {"rows": diff_rows, "links": []}, **extra})


def composed_ask(keys: list[str], args: dict) -> dict:
    """An `act` the runtime ended in the ask it composed over the candidates (compose.rs: ambiguous_write)."""
    return step("act", args, {"tool": "ask", "composed": True,
                              "ask": {"question": "Which one?", "options": [row(k) for k in keys]},
                              "compose": {"family": "ambiguous_write", "action": "ask_options"}})


def complete(key: str) -> dict:
    return {"id": vid(key), "kind": KEYS[key]["kind"], "n": 30, "change": "updated",
            "fields": {"status": ["open", "completed"], "completed": [None, "2026-10-14T08:40:00"]}}


def turn(user: str, *accepts: dict, ref: list[dict]) -> dict:
    return {"user": user, "gold": list(accepts), "ref": ref, "tags": []}


def session(*turns: dict) -> dict:
    return {"id": "s1", "set": "val", "world": "A", "today": "2026-10-14T08:40", "me": "me", "tags": [],
            "turns": list(turns)}


def run_of(*turn_steps: list[dict]) -> dict:
    return {"id": "s1", "turns": [{"steps": s} for s in turn_steps]}


def listing(kind: str, when: dict = DAY0, **extra) -> list[dict]:
    return [{"tool": "answer", "args": {"kind": kind, "when": when, **extra}}]


def sess_of(world_session: dict | None = None) -> regen.Sess:
    return regen.Sess(world_session or session(), Ids("A"))


def kind_of(key: str) -> str | None:
    return regen.world_kinds("A").get(key)


TICK = turn("tick off the faucet", gold.diff(gold.upd("faucet", status="completed", completed=gold.ANY)),
            ref=[{"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "faucet"}}])
TICK_RUN = [act_step("complete", [complete("faucet")], {"kind": "task", "name": "faucet"})]


# ---------------------------------------------------------------------------------------------
# K1: the kind of a kind-less read
# ---------------------------------------------------------------------------------------------


class KindlessReading(unittest.TestCase):
    def kind(self, user: str, prev: str | None = None) -> str | None:
        return regen.kindless_kind(user, prev)

    def test_a_first_left_is_a_task_and_a_first_on_is_the_calendar(self):
        self.assertEqual(self.kind("what's left this weekend"), "task")
        self.assertEqual(self.kind("anything left today"), "task")
        self.assertEqual(self.kind("what's remaining for friday"), "task")
        self.assertEqual(self.kind("what's on today"), "event")
        self.assertEqual(self.kind("what's still on today"), "event")
        self.assertEqual(self.kind("anything on this weekend?"), "event")

    def test_left_takes_the_kind_the_turn_before_read_or_wrote(self):
        self.assertEqual(self.kind("what's left this weekend", "event"), "event")
        self.assertEqual(self.kind("what's left for today till the end of the day", "task"), "task")
        self.assertEqual(self.kind("what's left on friday after that", "event"), "event")

    def test_on_names_the_calendar_whatever_the_turn_before_read(self):
        self.assertEqual(self.kind("what's on the 16th now", "task"), "event")
        self.assertEqual(self.kind("what's on tomorrow", "task"), "event")
        self.assertEqual(self.kind("what's still on today", "event"), "event")

    def test_a_continuation_goes_on_with_the_kind_of_the_turn_before(self):
        self.assertEqual(self.kind("anything else on for this week", "task"), "task")
        self.assertEqual(self.kind("anything else on for this week", "event"), "event")
        self.assertEqual(self.kind("what other things are left", "event"), "event")
        self.assertEqual(self.kind("anything else on for this week"), "event")  # no turn before: "on" is the calendar
        self.assertEqual(self.kind("what else is left today"), "task")
        self.assertEqual(self.kind("what else is on today", "task"), "task")
        self.assertEqual(self.kind("what else is on thursday"), "event")
        self.assertIsNone(self.kind("what else did i jot down about it"))

    def test_a_kind_noun_or_a_word_that_implies_the_kind_is_not_kind_less(self):
        for user in ("what tasks are left this week", "what events are on today", "what's left on the school list",
                     "what's due this week", "what's still open", "what's left that isn't done", "anything overdue",
                     "what's still pinned", "what's on my calendar", "what's left of the photos",
                     "what's on my plate today"):
            self.assertIsNone(self.kind(user), user)

    def test_only_a_question_about_what_is_on_or_left(self):
        for user in ("tell me what's on today", "move what's left to friday", "what time is the flight",
                     "how many are left"):
            self.assertIsNone(self.kind(user), user)

    def test_the_reason_is_in_the_reading(self):
        self.assertEqual(regen.kindless_reading("what's on today", None), ("event", "'on' names the calendar"))
        self.assertEqual(regen.kindless_reading("what's left today", "event")[1], "'left' reads the events of the turn before")
        self.assertIn("goes on with the tasks", regen.kindless_reading("anything else on", "task")[1])


class KindlessSpan(unittest.TestCase):
    """B3b (D-1044-15): a kind-less question about a span with no "on", no "left" and no task word is the calendar too, and
    a fragment ("and tomorrow") keeps the kind of the turn before."""

    def kind(self, user: str, prev: str | None = None) -> str | None:
        return regen.kindless_kind(user, prev)

    def test_a_span_question_with_no_on_or_left_is_the_calendar(self):
        for user in ("what's the plan for next week", "anything next weekend", "what does next week look like",
                     "what've i got next monday", "what's the plan for tomorrow", "what do i have tomorrow",
                     "what have i got this weekend", "and what's monday looking like", "anything at 9 tomorrow",
                     "what does friday look like", "anything tomorrow?"):
            self.assertEqual(self.kind(user), "event", user)
            self.assertEqual(self.kind(user, "task"), "event", user)  # whatever the turn before read

    def test_the_reason_says_the_calendar(self):
        self.assertEqual(regen.kindless_reading("what's the plan for next week", None),
                         ("event", "a span question with no kind names the calendar"))

    def test_a_task_word_a_kind_noun_or_no_span_is_not_the_calendar(self):
        for user in ("what do i have to do tomorrow", "what've i got to do this weekend", "what's the plan for the garden",
                     "what does the garden look like", "anything to buy for tomorrow", "what's the plan for next week's tasks",
                     "what's the schedule for next week", "anything due tomorrow", "what's the weather tomorrow",
                     "what do i have", "anything", "what should i do tomorrow", "anything i need to do tomorrow"):
            self.assertIsNone(self.kind(user, "task"), user)

    def test_a_continuation_still_goes_on_with_the_kind_of_the_turn_before(self):
        self.assertEqual(self.kind("what else is the plan for next week", "task"), "task")
        self.assertEqual(self.kind("anything else next weekend", "event"), "event")

    def test_a_fragment_keeps_the_kind_of_the_turn_before(self):
        for user in ("and tomorrow", "and next week", "and on the 9th", "and the 14th", "and monday?", "so this weekend",
                     "and tonight"):
            self.assertEqual(self.kind(user, "event"), "event", user)
            self.assertEqual(self.kind(user, "task"), "task", user)
            self.assertIn("fragment", regen.kindless_reading(user, "task")[1])
            self.assertIsNone(self.kind(user), user)  # no turn before to keep the kind of

    def test_a_fragment_is_a_bare_span_and_nothing_else(self):
        for user in ("and move it to tomorrow", "and tomorrow's tasks", "and the dentist", "and ama", "and tomorrow at 3 star it",
                     "tomorrow", "and how many tomorrow"):
            self.assertIsNone(self.kind(user, "event"), user)

    def test_a_listing_read_with_another_kind_is_rewritten_to_the_kind_of_the_span_reading(self):
        read = turn("what's the plan for next week", gold.rows("faucet"), ref=listing("task", {"unit": "week", "rel": 1}))
        new = regen.rewrite_kindless(read, None, kind_of)
        self.assertEqual(new["ref"], listing("event", {"unit": "week", "rel": 1}))
        frag = turn("and tomorrow", gold.rows("faucet"), ref=listing("task", {"unit": "day", "rel": 1}))
        self.assertEqual(regen.rewrite_kindless(frag, "event", kind_of)["ref"], listing("event", {"unit": "day", "rel": 1}))
        self.assertIsNone(regen.rewrite_kindless(frag, None, kind_of))

    def test_prepare_finds_a_fragment_candidate_whatever_the_turn_before(self):
        first = turn("what's on today", gold.rows("physical"), ref=listing("event"))
        frag = turn("and tomorrow", gold.rows("faucet"), ref=listing("task", {"unit": "day", "rel": 1}))
        new, found = regen.prepare_session(session(first, frag))
        self.assertEqual([(r["turn"], r["convention"]) for r in found], [(2, "kindless")])
        self.assertEqual(new["turns"][1]["ref"][0]["args"]["kind"], "event")

    def test_the_explain_names_the_span_reading(self):
        read = turn("what does next week look like", gold.rows("faucet"), ref=listing("event", {"unit": "week", "rel": 1}))
        _, found = regen.regen_session(session(read), run_of([rows_step(["physical"], {"kind": "event",
                                                                                         "when": {"unit": "week", "rel": 1}})]))
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "kindless")])
        self.assertIn("names the calendar", found[0]["evidence"])


class DatedKind(unittest.TestCase):
    def test_a_listing_read_is_the_kind_it_lists(self):
        self.assertEqual(regen.dated_kind(turn("x", gold.rows("faucet"), ref=listing("task")), kind_of), "task")
        self.assertEqual(regen.dated_kind(turn("x", gold.rows(), ref=listing("event")), kind_of), "event")

    def test_a_write_is_the_kind_its_calls_name_or_else_the_kind_of_the_rows_it_wrote(self):
        self.assertEqual(regen.dated_kind(TICK, kind_of), "task")
        move = turn("push it to 6", gold.diff(gold.upd("physical", date="2026-10-14T18:00")),
                    ref=[{"tool": "act", "args": {"verb": "reschedule", "rows": "$physical"}}])
        self.assertEqual(regen.dated_kind(move, kind_of), "event")
        make = turn("add an event", gold.diff(gold.new("event", name=gold.has("x"))),
                    ref=[{"tool": "act", "args": {"verb": "create", "args": "name: x"}}])
        self.assertEqual(regen.dated_kind(make, kind_of), "event")

    def test_a_turn_that_touched_neither_or_both_has_none(self):
        undo = turn("undo", gold.diff(), ref=[{"tool": "act", "args": {"verb": "undo"}}])
        self.assertIsNone(regen.dated_kind(undo, kind_of))
        people = turn("who", gold.rows("tomas"), ref=[{"tool": "answer", "args": {"kind": "person"}}])
        self.assertIsNone(regen.dated_kind(people, kind_of))
        both = turn("x", gold.diff(gold.upd("faucet", date="x"), gold.upd("physical", date="y")), ref=[
            {"tool": "act", "args": {"verb": "reschedule", "rows": "$faucet, $physical"}}])
        self.assertIsNone(regen.dated_kind(both, kind_of))

    def test_the_session_looks_back_to_the_latest_turn_that_touched_one(self):
        sess = sess_of()
        sess.dated_kinds.update({0: "event", 1: None, 2: None})
        self.assertEqual(sess.prev_dated_kind(3), "event")
        self.assertIsNone(sess.prev_dated_kind(0))
        sess.dated_kinds[1] = "task"
        self.assertEqual(sess.prev_dated_kind(3), "task")


class KindlessRewrite(unittest.TestCase):
    def rewrite(self, user: str, ref: list[dict], *accepts: dict, prev: str | None = None):
        return regen.rewrite_kindless(turn(user, *accepts, ref=ref), prev, kind_of)

    def test_a_first_left_read_as_events_is_read_as_tasks(self):
        new = self.rewrite("what's left this weekend", listing("event", WEEKEND), gold.rows("physical"))
        self.assertEqual(new["ref"], listing("task", WEEKEND))
        self.assertEqual(new["gold"], [gold.rows("physical")])  # the gold is the run's to derive

    def test_the_turn_before_decides_left(self):
        self.assertIsNone(self.rewrite("what's left today", listing("event"), gold.rows("physical"), prev="event"))
        new = self.rewrite("what's left today", listing("event"), gold.rows("physical"), prev="task")
        self.assertEqual(new["ref"][0]["args"]["kind"], "task")

    def test_events_have_no_open_the_status_conditions_go(self):
        ref = listing("task", where="status = open")
        self.assertEqual(self.rewrite("what's still on today", ref, gold.rows("faucet"))["ref"], listing("event"))
        ref = listing("task", where="priority = 1 and status = open")
        self.assertEqual(self.rewrite("what's still on today", ref, gold.rows("faucet"))["ref"][0]["args"]["where"],
                         "priority = 1")

    def test_nothing_to_rewrite_when_the_kind_is_right_or_the_gold_accepts_it(self):
        self.assertIsNone(self.rewrite("what's on today", listing("event"), gold.rows("physical")))
        self.assertIsNone(self.rewrite("what's left today", listing("event"), gold.rows(), gold.rows("faucet")))
        self.assertIsNotNone(self.rewrite("what's left today", listing("event"), gold.rows(), gold.rows("physical")))

    def test_only_a_listing_of_a_span_with_a_gold_of_rows(self):
        for ref in (listing("event", **{"linked_to": "$tomas"}), listing("event", name="yoga"),
                    [{"tool": "answer", "args": {"kind": "event"}}], listing("person")):
            self.assertIsNone(self.rewrite("what's left today", ref, gold.rows("physical")))
        self.assertIsNone(self.rewrite("what's left today", listing("event"), gold.val(3)))
        self.assertIsNone(self.rewrite("what's due today", listing("event"), gold.rows("physical")))

    def test_the_rewrite_leaves_the_turn_on_file(self):
        t = turn("what's left today", gold.rows("physical"), ref=listing("event"))
        regen.rewrite_kindless(t, None, kind_of)
        self.assertEqual(t["ref"], listing("event"))

    def test_prepare_reads_the_kind_off_the_turn_before(self):
        read = turn("what's left for today", gold.rows("physical"), ref=listing("event"))
        new, found = regen.prepare_session(session(TICK, read))
        self.assertEqual([(r["turn"], r["convention"], r["ref_changed"]) for r in found], [(2, "kindless", True)])
        self.assertEqual(new["turns"][1]["ref"], listing("task"))
        again, nothing = regen.prepare_session(new)
        self.assertEqual((nothing, again), ([], new))
        _, found = regen.prepare_session(session(TICK, read), fixes=False)
        self.assertEqual([r["convention"] for r in found], ["kindless"])  # a convention: a test session gets it too

    def test_prepare_follows_its_own_rewrites_from_one_turn_to_the_next(self):
        first = turn("what's left today", gold.rows("physical"), ref=listing("event"))  # a first "left": tasks
        second = turn("what's left tomorrow", gold.rows("physical"), ref=listing("event", {"unit": "day", "rel": 1}))
        new, found = regen.prepare_session(session(first, second))
        self.assertEqual([r["turn"] for r in found], [1, 2])
        self.assertEqual([t["ref"][0]["args"]["kind"] for t in new["turns"]], ["task", "task"])

    def test_prepare_leaves_a_kind_the_gold_accepts_and_a_kind_noun_alone(self):
        covered = turn("anything left today", gold.rows(), gold.rows("faucet"), ref=listing("event"))
        named = turn("what tasks are left today", gold.rows("physical"), ref=listing("event"))
        _, found = regen.prepare_session(session(covered, named))
        self.assertEqual(found, [])


class KindlessExplain(unittest.TestCase):
    def two(self, user: str, old: list[dict], run_keys: list[str], kind: str = "task", first=TICK, first_run=TICK_RUN):
        read = turn(user, *old, ref=listing(kind))
        return regen.regen_session(session(first, read), run_of(first_run, [rows_step(run_keys, {"kind": kind,
                                                                                                     "when": DAY0})]))

    def test_the_rows_of_the_kind_the_rule_names_replace_the_rows_of_the_other(self):
        new, found = self.two("what's left for today", [gold.rows("physical")], ["faucet", "dogfood"])
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, "kindless")])
        self.assertEqual(new["turns"][1]["gold"], [gold.rows("faucet", "dogfood")])
        self.assertIn("names no kind", found[0]["evidence"])
        self.assertIn("reads tasks", found[0]["evidence"])

    def test_the_calendar_reading_of_on_after_a_task(self):
        new, found = self.two("what's on today", [gold.rows("faucet")], ["physical"], kind="event")
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, "kindless")])
        self.assertEqual(new["turns"][1]["gold"], [gold.rows("physical")])

    def test_not_when_the_run_reads_the_kind_the_rule_does_not_name(self):
        _, found = self.two("what's left for today", [gold.rows("faucet")], ["physical"], kind="event")
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])

    def test_not_when_the_old_rows_were_of_that_kind_already(self):
        _, found = self.two("what's left for today", [gold.rows("amazon")], ["faucet", "dogfood"])
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])

    def test_an_old_gold_with_no_rows_says_no_kind(self):
        """An empty answer is no evidence of the other kind: rows the run finds now come from a world that differs (a
        write of the turn before ended otherwise), and no convention of the kind explains that."""
        for user, kind in (("what's on today", "event"), ("what's left for today", "task")):
            _, found = self.two(user, [gold.rows()], ["physical"] if kind == "event" else ["faucet"], kind=kind)
            self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED], user)

    def test_not_for_a_message_that_names_a_kind_or_implies_it(self):
        _, found = self.two("what's due today", [gold.rows("physical")], ["faucet"])
        self.assertNotIn("kindless", [c["convention"] for c in found])
        _, found = self.two("what tasks are left today", [gold.rows("physical")], ["faucet"])
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])

    def test_the_kinds_of_the_turns_are_remembered_for_the_next(self):
        s = session(TICK, turn("what's on today", gold.rows("physical"), ref=listing("event")))
        sess_run = run_of(TICK_RUN, [rows_step(["physical"], {"kind": "event", "when": DAY0})])
        regen.regen_session(s, sess_run)  # nothing changes; the history is the session's own
        sess = sess_of(s)
        sess.dated_kinds[0] = regen.dated_kind(s["turns"][0], kind_of)
        self.assertEqual(sess.prev_dated_kind(1), "task")


# ---------------------------------------------------------------------------------------------
# K2: a balance narrowed to one group
# ---------------------------------------------------------------------------------------------

PERSON = {"op": "balance", "kind": "person", "name": "Tomás"}
GROUP = {"op": "balance", "kind": "group", "name": "Casa Bills", "linked_to": "$tomas"}


def balance_pair(user: str, asked: dict = GROUP, first: float = 157.55) -> dict:
    return session(turn("what's tomás's balance", gold.val((first, "USD")), ref=[{"tool": "answer", "args": PERSON}]),
                   turn(user, gold.val((-59.65, "USD")), ref=[{"tool": "answer", "args": asked}]))


class NarrowedBalance(unittest.TestCase):
    def sess(self, first: float = 157.55, person: str | None = "tomas") -> regen.Sess:
        sess = sess_of()
        sess.balances[0] = (person, [{"amount": first, "unit": "USD"}]) if person else None
        return sess

    def part(self, user: str, core: dict = GROUP, sess: regen.Sess | None = None):
        return regen.narrowed_part(user, core, sess or self.sess(), 1)

    def test_the_persons_part_in_the_currency_of_the_group(self):
        self.assertEqual(self.part("just the casa one"), ("USD", 157.55))
        self.assertEqual(self.part("and in casa bills specifically?"), ("USD", 157.55))
        self.assertEqual(self.part("only the casa bills group"), ("USD", 157.55))

    def test_the_part_is_the_one_value_in_that_currency_of_several(self):
        sess = sess_of()
        sess.balances[0] = ("tomas", [{"amount": 12000, "unit": "JPY"}, {"amount": 872.6, "unit": "USD"}])
        self.assertEqual(regen.narrowed_part("just the casa one", GROUP, sess, 1), ("USD", 872.6))
        sess.balances[0] = ("tomas", [{"amount": 12000, "unit": "JPY"}])
        self.assertIsNone(regen.narrowed_part("just the casa one", GROUP, sess, 1))

    def test_not_without_a_word_that_narrows_nor_for_another_person_nor_after_another_turn(self):
        self.assertIsNone(self.part("and in casa bills"))
        self.assertIsNone(self.part("just the casa one", sess=self.sess(person="arjun")))
        self.assertIsNone(self.part("just the casa one", sess=self.sess(person=None)))
        self.assertIsNone(regen.narrowed_part("just the casa one", GROUP, self.sess(), 2))
        self.assertIsNone(self.part("just the casa one", {**GROUP, "linked_to": "$arjun"}))
        self.assertIsNone(self.part("just the casa one", {**GROUP, "op": "sum"}))
        self.assertIsNone(self.part("just the casa one", {**GROUP, "name": "No Such Group"}))

    def test_the_person_balance_a_turn_left_for_the_next(self):
        s = balance_pair("just the casa one")
        sess = sess_of(s)
        got = regen.person_balance(s["turns"][0], s["turns"][0]["gold"], sess)
        self.assertEqual(got, ("tomas", [{"amount": 157.55, "unit": "USD"}]))
        self.assertIsNone(regen.person_balance(s["turns"][1], s["turns"][1]["gold"], sess))  # a group's, not a person's
        by_key = turn("balance", gold.val((60, "USD")), ref=[{"tool": "answer", "args": {"op": "balance",
                                                                                         "rows": "$tomas"}}])
        self.assertEqual(regen.person_balance(by_key, by_key["gold"], sess), ("tomas", [{"amount": 60, "unit": "USD"}]))

    def test_the_gold_gets_the_persons_part_beside_the_groups_net(self):
        s = balance_pair("just the casa one")
        s["turns"][0]["gold"] = [gold.val((157.55, "USD"))]
        new, found = regen.regen_session(s, run_of([value_step(157.55, PERSON)], [value_step(-59.65, GROUP)]))
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(2, "narrowed-balance")])
        self.assertEqual(new["turns"][1]["gold"], [gold.val((-59.65, "USD")), gold.val((157.55, "USD"))])
        self.assertFalse(found[0]["was_failing"])

    def test_widening_is_idempotent_and_stays_off_without_the_words(self):
        s = balance_pair("just the casa one")
        s["turns"][0]["gold"] = [gold.val((157.55, "USD"))]
        new, _ = regen.regen_session(s, run_of([value_step(157.55, PERSON)], [value_step(-59.65, GROUP)]))
        again, found = regen.regen_session(new, run_of([value_step(157.55, PERSON)], [value_step(-59.65, GROUP)]))
        self.assertEqual((found, again), ([], new))
        plain = balance_pair("and in casa bills")
        plain["turns"][0]["gold"] = [gold.val((157.55, "USD"))]
        _, found = regen.regen_session(plain, run_of([value_step(157.55, PERSON)], [value_step(-59.65, GROUP)]))
        self.assertEqual(found, [])

    def test_a_run_that_answers_the_other_value_is_explained_and_both_are_kept(self):
        s = balance_pair("just the casa one")
        s["turns"][0]["gold"] = [gold.val((157.55, "USD"))]
        s["turns"][1]["gold"] = [gold.val((157.55, "USD"))]  # the gold took the person's part, the run gives the net
        new, found = regen.regen_session(s, run_of([value_step(157.55, PERSON)], [value_step(-59.65, GROUP)]))
        self.assertEqual([c["convention"] for c in found], ["narrowed-balance"])
        self.assertEqual(new["turns"][1]["gold"], [gold.val((157.55, "USD")), gold.val((-59.65, "USD"))])

    def test_any_other_value_is_not_the_rule(self):
        s = balance_pair("just the casa one")
        s["turns"][0]["gold"] = [gold.val((157.55, "USD"))]
        _, found = regen.regen_session(s, run_of([value_step(157.55, PERSON)], [value_step(-12.0, GROUP)]))
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])


# ---------------------------------------------------------------------------------------------
# K3: a request broken off mid-sentence
# ---------------------------------------------------------------------------------------------


class BrokenOff(unittest.TestCase):
    def test_the_last_complete_request_after_a_break(self):
        for user, last in (
                ("move the router setup note into... hmm i don't have a home notebook. create one called Home",
                 "create one called Home"),
                ("and the lab setup one to... no. delete the lab setup photo", "delete the lab setup photo"),
                ("book it for... ugh. just push it to january 6", "just push it to january 6"),
                ("move the bears game to... nah, cancel it. can't do both", "cancel it"),
                ("unstar the e-tickets after the trip... actually do it now", "do it now"),
                ("add it to the gift list... just change the line to kente scarf", "change the line to kente scarf"),
                ("star it… wait, unstar it", "unstar it")):
            self.assertEqual(regen.last_request(user), last, user)

    def test_no_request_when_nothing_breaks_off_or_the_message_ends_in_a_retraction_or_a_question(self):
        for user in ("create a notebook called Home", "move the note into the home notebook. then create one",
                     "book a table for valentine's... no wait lukas already did. never mind",
                     "remind me to call the ups guy about... actually never mind",
                     "and delete kyle the recruiter... oh he's already gone? fine",
                     "add oat milk... no. what does the shopping list say", "star churro in the snow... is it starred"):
            self.assertIsNone(regen.last_request(user), user)

    def diffs(self, user: str, run_links: bool = False):
        made = {"id": "00000000-0000-0000-0000-0000000000cc", "kind": "notebook", "n": 40, "change": "created",
                "fields": {"name": [None, "Home"]}}
        old = gold.diff(gold.new("notebook", name="Home"), gold.link("new", "w1"))
        t = turn(user, old, ref=[{"tool": "act", "args": {"verb": "create", "kind": "notebook", "args": "name: Home"}}])
        run = run_of([act_step("create", [made], {"kind": "notebook", "args": "name: Home"},
                               created=[{"id": made["id"], "kind": "notebook", "n": 40}])])
        return regen.regen_session(session(t), run)

    def test_only_the_last_request_runs_the_gold_of_the_broken_off_clause_goes(self):
        new, found = self.diffs("move the note w1 into... hmm there is no home notebook. create one called Home")
        self.assertEqual([c["convention"] for c in found], ["broken-off"])
        self.assertEqual(new["turns"][0]["gold"], [gold.diff(gold.new("notebook", name="Home"))])
        self.assertIn("create one called Home", found[0]["evidence"])
        self.assertIn("left out", found[0]["evidence"])

    def test_not_when_the_message_does_not_break_off(self):
        _, found = self.diffs("move the note w1 into the home notebook, and create it")
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])

    def test_not_when_the_new_diff_holds_something_the_old_did_not(self):
        made = {"id": "00000000-0000-0000-0000-0000000000cc", "kind": "notebook", "n": 40, "change": "created",
                "fields": {"name": [None, "Garage"]}}
        t = turn("move it into... hmm. create one called Home", gold.diff(gold.new("notebook", name="Home")),
                 ref=[{"tool": "act", "args": {"verb": "create", "kind": "notebook", "args": "name: Garage"}}])
        run = run_of([act_step("create", [made], {"kind": "notebook", "args": "name: Garage"},
                               created=[{"id": made["id"], "kind": "notebook", "n": 40}])])
        _, found = regen.regen_session(session(t), run)
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])


# ---------------------------------------------------------------------------------------------
# K4: a bare plural is not "all"
# ---------------------------------------------------------------------------------------------


class BarePlural(unittest.TestCase):
    def test_what_says_every_row_is_the_runtimes_closed_list(self):
        for user in ("move all the yoga classes to 8", "unstar both of them", "star everyone from the lab",
                     "cancel each one", "delete everything on it", "push every yoga class a day", "tell all of them"):
            self.assertTrue(regen.says_every_row(user), user)
        for user in ("push the mark 9 tests to friday", "star the yoga classes", "make it an all-day event",
                     "move it every week", "block the whole weekend", "do it all day", "every morning at 8",
                     "move the yoga classes"):
            self.assertFalse(regen.says_every_row(user), user)

    def test_the_words_are_read_as_the_runtime_reads_them(self):
        self.assertEqual(regen.runtime_words("Push Mark’s tests to Friday!"), ["push", "mark", "tests", "to", "friday"])
        self.assertEqual(regen.runtime_words("an all-day event, 'both'"), ["an", "all", "day", "event", "both"])
        self.assertTrue(regen.says_every_row("move them ALL"))
        self.assertTrue(regen.says_every_row("star 'both' of them"))
        self.assertFalse(regen.says_every_row("the weekend's plans, all day"))
        self.assertTrue(regen.says_every_row("the weekend's all-nighters"))  # "all nighters": a time span is a whole word

    @unittest.skipUnless(GROUND.exists(), "the runtime's source is not here")
    def test_the_list_agrees_with_the_runtime(self):
        """Reads crates/nativetools/src/ground.rs: when the runtime's closed list changes, this fails and says so."""
        text = GROUND.read_text(encoding="utf-8")
        spans = re.search(r"const TIME_SPANS: \[&str; \d+\] = \[(.*?)\];", text, re.S)
        self.assertIsNotNone(spans, "ground.rs no longer has TIME_SPANS")
        self.assertEqual(tuple(re.findall(r'"(\w+)"', spans.group(1))), regen.TIME_SPANS)
        fn = re.search(r"fn said_every_row\(.*?\n    \}\n", text, re.S)
        self.assertIsNotNone(fn, "ground.rs no longer has said_every_row")
        arms = re.findall(r"((?:\"\w+\"\s*\|\s*)*\"\w+\")\s*=>\s*(true|!)", fn.group(0))
        always = [w for names, kind in arms if kind == "true" for w in re.findall(r'"(\w+)"', names)]
        quantifiers = [w for names, kind in arms if kind == "!" for w in re.findall(r'"(\w+)"', names)]
        self.assertEqual(tuple(always), regen.EVERY_ROW)
        self.assertEqual(tuple(quantifiers), regen.EVERY_ROW_QUANTIFIERS)

    def old_gold(self) -> dict:
        return gold.diff(gold.upd("yoga0", date="2026-10-16T08:00"), gold.upd("yoga1", date="2026-10-16T08:00"))

    def ask(self, user: str, keys=("yoga0", "yoga1", "yoga2"), verb: str = "reschedule", old=None, ask_step=None):
        args = {"verb": verb, "kind": "event", "name": "yoga"}
        t = turn(user, old or self.old_gold(), ref=[{"tool": "act", "args": args}])
        return regen.regen_session(session(t), run_of([ask_step or composed_ask(list(keys), args)]))

    def test_several_rows_and_no_word_for_all_is_the_ask_not_the_write_to_all(self):
        new, found = self.ask("push the yoga classes to friday")
        self.assertEqual([c["convention"] for c in found], ["bare-plural"])
        self.assertEqual(new["turns"][0]["gold"], [gold.ask("yoga0", "yoga1", "yoga2")])
        self.assertIn("none of all, every, each, both or everyone", found[0]["evidence"])

    def test_the_runtime_that_ought_to_have_written_to_all_is_not_explained(self):
        for user in ("push all the yoga classes to friday", "push both yoga classes to friday",
                     "push every yoga class to friday", "push the yoga classes to friday, everyone"):
            _, found = self.ask(user)
            self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED], user)

    def test_a_time_span_after_all_is_not_all(self):
        _, found = self.ask("push the yoga classes to friday, all day")
        self.assertEqual([c["convention"] for c in found], ["bare-plural"])

    def test_not_for_an_ask_the_model_wrote_one_row_or_options_that_miss_a_row_or_another_family(self):
        args = {"verb": "reschedule", "kind": "event", "name": "yoga"}
        model_ask = step("ask", {"question": "which?", "options": "#1, #2"},
                         {"ask": {"question": "which?", "options": [row("yoga0"), row("yoga1")]}})
        _, found = self.ask("push the yoga classes to friday", ask_step=model_ask)
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])
        _, found = self.ask("push the yoga class to friday", old=gold.diff(gold.upd("yoga0", date="2026-10-16T08:00")))
        self.assertNotIn("bare-plural", [c["convention"] for c in found])
        _, found = self.ask("push the yoga classes to friday", keys=("yoga0", "yoga2"))
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])
        near = composed_ask(["yoga0", "yoga1"], args)
        near["response"]["effect"]["compose"] = {"family": "unmatched_write", "action": "ask_nearest"}
        _, found = self.ask("push the yoga classes to friday", ask_step=near)
        self.assertEqual([c["convention"] for c in found], [regen.UNEXPLAINED])

    def test_it_comes_before_the_refusal_of_a_delete_it_would_be_mistaken_for(self):
        self.assertLess(regen.CONVENTIONS.index("bare-plural"), regen.CONVENTIONS.index("refusal"))
        old = gold.diff(gold.trash("yoga0"), gold.trash("yoga1"))
        _, found = self.ask("delete the yoga classes", verb="delete", old=old)
        self.assertEqual([c["convention"] for c in found], ["bare-plural"])


# ---------------------------------------------------------------------------------------------
# M5d and M5e: a recurring event or task named without a date is asked about
# ---------------------------------------------------------------------------------------------

YOGA = [f"yoga{i}" for i in range(17)]  # "Yoga with Ananya" seventeen times, world A
RENT = [f"rent{i}" for i in range(4)]  # "Pay rent", tasks
SERIES_ARGS = {"verb": "reschedule", "kind": "event", "name": "yoga"}
TASK_ARGS = {"verb": "reschedule", "kind": "task", "name": "pay rent"}


def rust_names(path: Path, name: str) -> tuple[str, ...]:
    """The quoted names of the Rust constant `name` in a runtime source (a list of words, or of (word, number))."""
    found = re.search(rf"const {name}: \[.*?\] = \[(.*?)\];", path.read_text(encoding="utf-8"), re.S)
    assert found, f"{path.name} no longer has {name}"
    return tuple(re.findall(r'"([^"]+)"', found.group(1)))


class SeriesAsk(unittest.TestCase):
    ONE = gold.diff(gold.upd("yoga3", date="2026-10-15T08:00"))  # the write the old gold applied to one instance
    ONE_TASK = gold.diff(gold.upd("rent3", due="2026-10-15"))

    def task(self, user: str, **kw) -> list[str]:
        """The conventions of a turn on the task series `Pay rent` whose old gold wrote to one instance."""
        return self.convention(user, old=self.ONE_TASK, keys=RENT, args=TASK_ARGS, **kw)

    def regen(self, user: str, old: dict | None = None, keys=YOGA[:12], args=SERIES_ARGS, ask_step=None):
        t = turn(user, old or self.ONE, ref=[{"tool": "act", "args": args}])
        return regen.regen_session(session(t), run_of([ask_step or composed_ask(list(keys), args)]))

    def convention(self, user: str, **kw) -> list[str]:
        return [c["convention"] for c in self.regen(user, **kw)[1]]

    def test_a_series_named_without_a_date_is_asked_about_not_written_to_one_instance(self):
        new, found = self.regen("push yoga a day")
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "series-ask")])
        self.assertEqual(new["turns"][0]["gold"], [gold.ask(*YOGA[:12])])
        self.assertTrue(found[0]["was_failing"])
        self.assertIn("a recurring event named without a date is asked about", found[0]["evidence"])
        self.assertIn("12 events called 'Yoga with Ananya'", found[0]["evidence"])

    def test_the_evidence_names_the_sessions_whose_gold_asks_events_and_tasks(self):
        _, found = self.regen("push yoga a day")
        for session_id in ("B-E093", "D-E127", "D-E128", "T12-085", "T12-092", "T23-108", "T03-106", "T12-111"):
            self.assertIn(session_id, found[0]["evidence"])
        self.assertIn("val B-E093, D-E127, D-E128, T12-085, T12-092 for events, T23-108 for tasks", found[0]["evidence"])
        self.assertIn("test T03-106, T12-111 for tasks", found[0]["evidence"])

    def test_a_task_series_is_asked_about_like_an_event_series(self):
        new, found = self.regen("push pay rent a day", old=self.ONE_TASK, keys=RENT, args=TASK_ARGS)
        self.assertEqual([(c["turn"], c["convention"]) for c in found], [(1, "series-ask")])
        self.assertEqual(new["turns"][0]["gold"], [gold.ask(*RENT)])
        self.assertIn("a recurring task named without a date is asked about", found[0]["evidence"])
        self.assertIn("4 tasks called 'Pay rent'", found[0]["evidence"])
        self.assertEqual(self.task("tick off pay rent, paid"), ["series-ask"])  # a state word as a reason picks nothing
        old = gold.diff(gold.upd("rent3", status="completed", completed=gold.ANY))
        self.assertEqual(self.convention("tick off pay rent", old=old, keys=RENT,
                                         args={"verb": "complete", "kind": "task", "name": "pay rent"}), ["series-ask"])
        self.assertEqual(self.convention("delete pay rent", old=gold.diff(gold.trash("rent3")), keys=RENT,
                                         args={"verb": "delete", "kind": "task", "name": "pay rent"}), ["series-ask"])

    def test_a_message_that_aims_at_one_task_is_not_explained(self):
        for user in ("push the friday pay rent a day", "push pay rent to the 14th", "push the first pay rent a day",
                     "push pay rent before friday", "push the other pay rent a day", "move it to monday",
                     "push all the pay rent a day", "cancel pay rent for everyone", "push that one to monday"):
            self.assertEqual(self.task(user), [regen.UNEXPLAINED], user)

    def test_a_pronoun_for_the_name_the_message_states_aims_at_no_instance(self):
        for user in ("Pay rent, push it to monday", "pay rent, push them to monday", "pay rent, move that to friday",
                     "pay rent, push those to monday", "PAY RENT, push it to monday", "pay rent, push that one a day",
                     "push the pay rent one to monday", "pay rent, push one to monday", "Pay Rent: push it a day"):
            self.assertEqual(self.task(user), ["series-ask"], user)
        self.assertEqual(self.convention("Yoga with Ananya, push it a day"), ["series-ask"])  # an event series too
        # the ruling's reading, kept literal: a "that" or "those" that stands before the stated name is exempt like one that
        # stands alone ("push that pay rent a day"); a handle of the focus would have made the reference a write by rows
        self.assertEqual(self.task("push that pay rent a day"), ["series-ask"])

    def test_a_pronoun_for_a_name_the_message_does_not_state_picks(self):
        for user in ("push it to monday", "pay, push it to monday", "rent, push them to monday", "push that to friday",
                     "pay rent, push this to monday", "pay rent, push these to monday", "pay rent, push him to monday",
                     "pay rent, push they to monday".replace("they", "her"), "the rent, push it to monday"):
            self.assertEqual(self.task(user), [regen.UNEXPLAINED], user)
        self.assertEqual(self.convention("yoga, push it a day"), [regen.UNEXPLAINED])  # "yoga" is not all of the name

    def test_the_other_the_first_the_old_the_last_the_next_and_the_open_one_still_aim(self):
        for user in ("pay rent, push the other one to monday", "pay rent, push the first one to monday",
                     "pay rent, push the old one to monday", "pay rent, push the last one to monday",
                     "pay rent, push the next one to monday", "pay rent, tick off the open one",
                     "pay rent, push the same one again", "pay rent, the done ones", "pay rent, push the newest one"):
            self.assertEqual(self.task(user), [regen.UNEXPLAINED], user)

    def test_message_states_a_name_when_it_says_every_word_of_it(self):
        self.assertTrue(regen.message_states("Cafe Opening, move it", "Café Opening"))  # accents and case
        self.assertTrue(regen.message_states("kofi's tutoring, push it", "Kofi Tutoring"))  # a possessive is dropped
        self.assertTrue(regen.message_states("kofi tutoring, push it", "Kofi's Tutoring"))
        self.assertTrue(regen.message_states("push the rent, pay it", "Pay rent"))  # in any order
        self.assertFalse(regen.message_states("push it to monday", "Pay rent"))
        self.assertFalse(regen.message_states("pay, push it", "Pay rent"))  # one word of two
        self.assertFalse(regen.message_states("call vet, push it", "Call the vet"))  # an article is a word like any other
        self.assertTrue(regen.message_states("call the vet, push it", "Call the vet"))
        self.assertFalse(regen.message_states("anything", ""))  # an empty name states nothing

    def test_what_picks_nothing_and_what_stands_for_a_stated_name(self):
        """The rule's own words, no source to agree with: the state and repeat words, the pronouns for a stated name."""
        self.assertEqual(set(regen.NOT_A_PICK) - set(regen.PICKED), set())
        self.assertEqual(set(regen.STATED_PRONOUNS) - set(regen.PICKED), set())
        self.assertEqual(set(regen.NOT_A_PICK) & set(regen.STATED_PRONOUNS), set())
        for word in regen.NOT_A_PICK:
            self.assertFalse(regen.says_which(f"cancel yoga with ananya, {word}", "Yoga with Ananya"), word)
        for word in regen.STATED_PRONOUNS:
            said = f"yoga with ananya, cancel {word}"
            self.assertFalse(regen.says_which(said, "Yoga with Ananya"), word)  # it stands for the name the message states
            self.assertTrue(regen.says_which(said), word)  # and picks where no name is stated
            self.assertTrue(regen.says_which(said, "Yoga with Dana"), word)  # or a name the message does not say
        for word in set(regen.PICKED) - set(regen.NOT_A_PICK) - set(regen.STATED_PRONOUNS):
            self.assertTrue(regen.says_which(f"yoga with ananya, cancel {word}", "Yoga with Ananya"), word)

    def test_a_series_is_one_dated_kind_and_one_name(self):
        sess = sess_of()
        sess.rows["t1"] = ("task", {"name": "Oil change"})
        sess.rows["e1"] = ("event", {"name": "Oil Change"})
        sess.rows["e2"] = ("event", {"name": "oil change"})
        sess.rows["n1"] = ("note", {"name": "Oil change"})
        self.assertEqual(regen.series_of(["e1", "e2"], sess), ("event", "Oil Change"))
        self.assertIsNone(regen.series_of(["t1", "e1"], sess))  # an event and a task of one name are no series
        self.assertIsNone(regen.series_of(["n1", "n1"], sess))  # a note is not a dated kind
        self.assertIsNone(regen.series_of(["e1"], sess))  # one row is no series
        self.assertIsNone(regen.series_of(["e1", "nobody"], sess))
        self.assertEqual(regen.series_of(RENT, sess_of()), ("task", "Pay rent"))
        self.assertEqual(regen.series_of(YOGA, sess_of()), ("event", "Yoga with Ananya"))

    def test_a_date_that_only_says_where_the_write_goes_aims_at_no_instance(self):
        for user in ("move yoga to friday", "push yoga to 8pm", "move yoga to next friday", "reschedule yoga to 10:30",
                     "move yoga to 9 pm", "put yoga on instead on thursday", "make yoga due friday", "move yoga to 3"):
            self.assertEqual(self.convention(user), ["series-ask"], user)

    def test_a_message_that_aims_at_one_instance_is_not_explained(self):
        for user in ("push the friday yoga a day", "move yoga on friday to saturday", "cancel friday's yoga",
                     "move the first yoga to 8pm", "push the 14th yoga a day", "cancel yoga on the fourteenth",
                     "push that yoga a day", "move it to 8pm", "cancel the last yoga", "move the old yoga to 8pm",
                     "move yoga on tuesdays to 8pm", "move yoga from tuesday to wednesday", "move yoga to dec 11",
                     "push the yoga of next week a day", "push yoga back in an hour", "move the 6pm yoga to 7pm",
                     "cancel yoga before lunch", "cancel the other yoga", "reschedule the one due tomorrow",
                     "push yoga a day, she says it's fine"):
            self.assertEqual(self.convention(user), [regen.UNEXPLAINED], user)

    def test_all_is_not_one_instance(self):
        for user in ("push all the yoga a day", "move both yoga to 8pm", "cancel every yoga", "cancel yoga for everyone"):
            self.assertEqual(self.convention(user), [regen.UNEXPLAINED], user)

    def test_says_which_reads_what_aims_at_an_instance(self):
        for user in ("push the friday yoga a day", "move it to 6pm", "cancel the first one", "cancel yoga on tuesdays",
                     "move the may 3 yoga", "push yoga to the 14th", "move yoga until friday", "push yoga a week",
                     "cancel the old yoga", "cancel yoga at 6pm", "cancel all of them"):
            self.assertTrue(regen.says_which(user), user)
        for user in ("push movie night a day", "move my haircut to saturday", "push the call with javlon to 8:30pm",
                     "cancel the dress fitting", "move the accountant meeting to 3", "may i move yoga to 8pm",
                     "move the may meeting", "cancel therapy", "push the piano lesson back an hour, ama has a late class",
                     "move yoga to the gym", "cancel the swim lesson"):
            self.assertFalse(regen.says_which(user), user)

    def test_the_possessive_a_time_and_the_state_words(self):
        self.assertTrue(regen.says_which("cancel kofi's tutoring, he's got a school trip"))  # "he's" holds "he", a pick word
        self.assertTrue(regen.says_which("cancel friday's yoga"))  # a possessive day names the row
        self.assertTrue(regen.says_which("cancel the yoga, the next one"))  # "one" picks (no name stated), "next" does not
        self.assertFalse(regen.says_which("cancel the next yoga"))  # "next" is ported as no pick (see NOT_A_PICK)
        self.assertFalse(regen.says_which("cancel the open yoga"))  # a state word names what the verb filters by already

    def test_rows_of_different_names_are_no_series(self):
        self.assertEqual(self.convention("push yoga a day", keys=["yoga0", "oneonone0", "yoga1"]), [regen.UNEXPLAINED])
        self.assertEqual(self.convention("push yoga a day", keys=["yoga0", "physical"]), [regen.UNEXPLAINED])
        mixed = self.convention("push yoga a day", keys=["yoga0", "rent0"])  # an event and a task
        self.assertEqual(mixed, [regen.UNEXPLAINED])

    def test_one_row_is_no_series(self):
        self.assertEqual(self.convention("push yoga a day", keys=["yoga3"]), [regen.UNEXPLAINED])

    def test_the_old_gold_may_name_any_instance_of_the_series_even_one_the_ask_does_not_offer(self):
        old = gold.diff(gold.upd("yoga15", date="2026-10-15T08:00"))
        self.assertEqual(self.convention("push yoga a day", old=old), ["series-ask"])

    def test_not_when_the_old_gold_wrote_beyond_one_event_of_the_series(self):
        other = gold.diff(gold.upd("physical", date="2026-10-15T08:00"))
        self.assertEqual(self.convention("push yoga a day", old=other), [regen.UNEXPLAINED])
        mixed = gold.diff(gold.upd("yoga3", date="2026-10-15T08:00"), gold.upd("physical", date="2026-10-15T08:00"))
        self.assertNotIn("series-ask", self.convention("push yoga a day", old=mixed))
        linked = gold.diff(gold.upd("yoga3", date="2026-10-15T08:00"), gold.link("yoga3", "lo1"))
        self.assertEqual(self.convention("push yoga a day", old=linked), [regen.UNEXPLAINED])
        created = gold.diff(gold.new("event", name="Yoga with Ananya"))
        self.assertEqual(self.convention("push yoga a day", old=created), [regen.UNEXPLAINED])

    def test_not_for_an_ask_the_model_wrote_another_family_or_a_gold_that_is_not_a_write(self):
        model_ask = step("ask", {"question": "which?", "options": [row("yoga0"), row("yoga1")]},
                         {"ask": {"question": "which?", "options": [row("yoga0"), row("yoga1")]}})
        self.assertEqual(self.convention("push yoga a day", ask_step=model_ask), [regen.UNEXPLAINED])
        near = composed_ask(YOGA[:3], SERIES_ARGS)
        near["response"]["effect"]["compose"] = {"family": "unmatched_write", "action": "ask_nearest"}
        self.assertEqual(self.convention("push yoga a day", ask_step=near), [regen.UNEXPLAINED])
        self.assertEqual(self.convention("push yoga a day", old=gold.ask("yoga0", "yoga1")), [])  # an old ask is M1's

    def test_several_written_rows_keep_the_label_of_the_bare_plural(self):
        two = gold.diff(gold.upd("yoga3", date="2026-10-15T08:00"), gold.upd("yoga4", date="2026-10-15T08:00"))
        self.assertEqual(self.convention("push the yoga classes a day", old=two), ["bare-plural"])
        # the write to one instance is this rule's, the write to several is not: a row the ask does not offer is no match
        offered = self.convention("push the yoga classes a day", old=two, keys=["yoga3", "yoga5"])
        self.assertEqual(offered, [regen.UNEXPLAINED])

    def test_it_comes_before_the_refusal_of_a_delete_it_would_be_mistaken_for(self):
        order = regen.CONVENTIONS
        self.assertLess(order.index("bare-plural"), order.index("series-ask"))
        self.assertLess(order.index("series-ask"), order.index("refusal"))
        args = {"verb": "delete", "kind": "event", "name": "yoga"}
        self.assertEqual(self.convention("delete the yoga", old=gold.diff(gold.trash("yoga3")), args=args), ["series-ask"])

    def test_it_runs_once_the_ask_is_the_gold_nothing_changes(self):
        new, _ = self.regen("push yoga a day")
        again, found = regen.regen_session(new, run_of([composed_ask(YOGA[:12], SERIES_ARGS)]))
        self.assertEqual((found, again), ([], new))

    @unittest.skipUnless(RUNTIME.exists(), "the runtime's source is not here")
    def test_the_words_agree_with_the_runtime(self):
        """Reads act.rs and ground.rs: when a closed list `says_which` stands on changes, this fails and says so. The
        runtime's former default (compose.rs) is not read: `NOT_A_PICK` and `STATED_PRONOUNS` are the rule's own."""
        where = {"PICKED": "act.rs", **{n: "ground.rs" for n in (
            "BROAD", "SPANNING", "DESTINATIONS", "SETTERS", "ROW_MARKERS", "WEEKDAYS", "WORD_LIKE", "BEFORE_SHORT_WEEKDAY",
            "MONTHS")}}
        self.assertNotIn("compose.rs", where.values())
        for name, source in where.items():
            self.assertEqual(rust_names(RUNTIME / source, name), getattr(regen, name), f"{name} in {source}")
        text = GROUND.read_text(encoding="utf-8")
        self.assertEqual((*rust_names(GROUND, "UNITS"), "twentieth", "thirtieth"), regen.WORD_ORDINALS)
        for word in regen.DAY_WORDS:
            self.assertIn(f'"{word}"', text, f"ground.rs no longer reads {word}")


# ---------------------------------------------------------------------------------------------
# the registry, the fix, view_world
# ---------------------------------------------------------------------------------------------


class Registry(unittest.TestCase):
    def test_the_new_conventions_are_named_with_a_rule_and_a_kind(self):
        for name in ("kindless", "narrowed-balance", "broken-off", "bare-plural", "series-ask"):
            self.assertIn(name, regen.CONVENTIONS)
            self.assertIn(name, regen.RULES)
        self.assertNotIn("series-ask", regen.WIDENING + regen.REWRITES)
        self.assertIn("narrowed-balance", regen.WIDENING)
        self.assertIn("narrowed-balance", regen.WIDENERS)
        self.assertIn("kindless", regen.REWRITES)
        self.assertEqual(sorted(regen.CONVENTIONS), sorted(regen.RULES))

    def test_the_audit_fix_completes_the_one_row_the_message_singles_out_and_keeps_the_ask(self):
        fix = regen.FIXES[("D-E066", 1)]
        self.assertEqual(fix["ruling"], "A1")
        self.assertNotIn("derive", fix)
        self.assertEqual([a["type"] for a in fix["gold"]], ["diff", "ask"])  # the complete first, the safe ask beside it
        self.assertEqual(len(fix["gold"][0]["diff"]["rows"]), 1)
        self.assertEqual(fix["gold"][0]["diff"]["rows"][0]["fields"]["status"], "completed")
        self.assertEqual(fix["gold"][0]["diff"]["rows"][0]["key"], fix["gold"][1]["candidates"][-1])
        call = fix["ref"][0]["args"]
        self.assertEqual((call["verb"], call["kind"]), ("complete", "task"))
        self.assertIn('"name":12', call["when"])  # the message's month is a condition of the selector
        self.assertTrue(regen.pinned("D-E066", 1))

    def test_the_next_fix_answers_the_members_of_the_group_the_call_is_linked_to(self):
        fix = regen.FIXES[("D-E132", 1)]
        self.assertEqual(fix["ruling"], "M1d-next")
        self.assertEqual(fix["expect"], regen.digest("book club members, for the invite to the next one"))
        self.assertEqual(fix["gold"], [gold.rows("pp40", "pp41", "liz", "me", "pp42")])  # the five members, no event
        self.assertNotIn("derive", fix)
        self.assertTrue(regen.pinned("D-E132", 1))


    def test_the_who_owes_fix_adds_the_debt_row_beside_the_person(self):
        fix = regen.FIXES[("T03-052", 3)]
        self.assertEqual(fix["ruling"], "D-1044-15")
        self.assertEqual(fix["expect"], regen.digest("who's that to"))
        self.assertEqual(fix["add"], [gold.rows("d_glasses")])  # the biggest debt i owe (150 EUR, Marta's): the person stays
        self.assertNotIn("gold", fix)
        self.assertEqual(regen.world_kinds("T03")["d_glasses"], "debt")
        self.assertTrue(regen.pinned("T03-052", 3))

    def test_the_number_fix_adds_the_ask_and_the_out_of_scope_decline_beside_the_balance(self):
        fix = regen.FIXES[("D-E132", 2)]
        self.assertEqual(fix["ruling"], "D-1044-15")
        self.assertEqual(fix["expect"], regen.digest("what's my number for that one"))
        self.assertEqual(fix["add"], [gold.ask(), gold.decline("out_of_scope")])
        self.assertNotIn("gold", fix)
        self.assertTrue(regen.pinned("D-E132", 2))
        old = [{"type": "value", "values": [{"amount": -138.4, "unit": "USD"}]}]
        t = {"user": "what's my number for that one", "gold": old, "ref": [], "tags": []}
        new = regen.apply_fix(t, fix, "D-E132", 2)
        self.assertEqual(new["gold"], [*old, gold.ask(), gold.decline("out_of_scope")])
        self.assertEqual(regen.apply_fix(new, fix, "D-E132", 2)["gold"], new["gold"])  # idempotent


class ViewWorld(unittest.TestCase):
    WORLD = {"me": "Priya", "tasks": [{"key": "t1", "name": "Pay rent", "due": "2026-10-14"}]}

    def test_a_world_without_today_shows_the_today_it_is_given(self):
        text = view_world.show(self.WORLD, None, None, today="2026-10-14T08:40")
        self.assertIn("me: Priya  today: 2026-10-14T08:40 (Wednesday)", text)
        self.assertIn("t1: Pay rent", text)

    def test_a_world_without_one_and_no_today_says_so_instead_of_failing(self):
        self.assertIn("today: (none", view_world.show(self.WORLD, None, None))

    def test_the_today_of_the_world_json_wins_over_the_lookup(self):
        self.assertIn("today: 2026-11-28T10:15", view_world.show({**self.WORLD, "today": "2026-11-28T10:15"}, None, None))

    def test_the_today_of_an_authored_world_is_found_in_the_sets_or_the_authored_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            eval_dir = Path(tmp) / "eval"
            (eval_dir / "sets").mkdir(parents=True)
            (eval_dir / "sets" / "val.jsonl").write_text('{"id": "Z1-001", "world": "Z1", "today": "2030-01-02T03:04"}\n'
                                                         '{"id": "Z9-001", "world": "Z9", "today": "2031-05-06T07:08"}\n')
            sources = Path(tmp) / "authored" / "sessions"
            sources.mkdir(parents=True)
            (sources / "Z5_02.py").write_text('from gold import *\nworld("Z5", "2032-09-10T11:12", "Ada", "train")\n')
            with mock.patch.object(view_world, "HERE", eval_dir):
                self.assertEqual(view_world.lookup_today("Z1"), "2030-01-02T03:04")
                self.assertEqual(view_world.lookup_today("Z5"), "2032-09-10T11:12")
                self.assertIsNone(view_world.lookup_today("Z7"))

    def test_the_authored_val_worlds_view(self):
        for name in ("T03", "T12", "T23"):
            out = io.StringIO()
            with redirect_stdout(out), mock.patch("sys.argv", ["view_world.py", name]):
                view_world.main()
            self.assertRegex(out.getvalue().splitlines()[0], r"^me: .*  today: \d{4}-\d\d-\d\dT\d\d:\d\d \(\w+day\)$")

    def test_an_explicit_today_wins(self):
        out = io.StringIO()
        with redirect_stdout(out), mock.patch("sys.argv", ["view_world.py", "T03", "--today", "2026-12-24T09:00"]):
            view_world.main()
        self.assertIn("today: 2026-12-24T09:00 (Thursday)", out.getvalue().splitlines()[0])


CHECK_SH = Path(__file__).resolve().parents[1] / "authored" / "evalkit" / "check.sh"
# a stand-in for authored/build.py that does what STUB says, under a private copy of the tree
STUB_BUILD = """import json, os, pathlib, sys
mode = os.environ["STUB"]
args = sys.argv[1:]
out, world = pathlib.Path(args[args.index("--out") + 1]), args[0]
if mode == "ok":
    (out / f"{world}.report.json").write_text(json.dumps([{"id": "A-E001", "pass": True, "problems": []}]))
elif mode == "failing":
    (out / f"{world}.report.json").write_text(json.dumps([{"id": "A-E001", "pass": False, "problems": ["turn 2: x"]}]))
elif mode == "crash":
    print("OSError: [Errno 28] No space left on device", file=sys.stderr)
    sys.exit(1)
"""


class CheckShTest(unittest.TestCase):
    """evalkit/check.sh never reads the report of an earlier run: it is deleted before the build, and a build that
    does not finish (a crash, a full disk) ends the check in FAIL instead of printing the old `verified N/N`."""

    STALE = '[{"id": "A-E001", "pass": true, "problems": []}, {"id": "A-E002", "pass": true, "problems": []}]'

    def check(self, mode: str) -> tuple[int, str]:
        import os
        import subprocess

        with tempfile.TemporaryDirectory() as tmp:
            tree, out = Path(tmp) / "p", Path(tmp) / "out"
            (tree / "authored").mkdir(parents=True)
            out.mkdir()
            (tree / "authored" / "build.py").write_text(STUB_BUILD)
            (out / "A.report.json").write_text(self.STALE)  # the report of a run before this one
            env = {**os.environ, "STUB": mode, "P": str(tree), "OUT": str(out), "NATIVETOOLS": "/bin/true"}
            done = subprocess.run(["bash", str(CHECK_SH), "A", "--only", "A-E001"], env=env, capture_output=True, text=True)
            return done.returncode, done.stdout + done.stderr

    def test_a_finished_build_is_verified_from_its_own_report(self):
        code, said = self.check("ok")
        self.assertEqual(code, 0, said)
        self.assertIn("verified 1/1", said)
        self.assertNotIn("verified 2/2", said)

    def test_a_build_that_fails_verification_fails_the_check(self):
        code, said = self.check("failing")
        self.assertNotEqual(code, 0, said)
        self.assertIn("FAIL A-E001", said)
        self.assertIn("verified 0/1", said)

    def test_a_build_that_crashes_fails_loudly_and_reads_no_old_report(self):
        code, said = self.check("crash")
        self.assertNotEqual(code, 0, said)
        self.assertIn("build.py exited with status 1", said)
        self.assertIn("No space left on device", said)
        self.assertTrue(said.rstrip().endswith("FAIL"), said)
        self.assertNotIn("verified", said)

    def test_a_build_that_writes_no_report_fails_the_check(self):
        code, said = self.check("silent")
        self.assertNotEqual(code, 0, said)
        self.assertIn("wrote no A.report.json", said)
        self.assertNotIn("verified", said)


if __name__ == "__main__":
    unittest.main()
