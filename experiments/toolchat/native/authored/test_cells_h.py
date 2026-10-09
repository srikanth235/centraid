"""Unit tests for table H of the scenario cells (authored/cells.py phrase lists, authored/coverage.py detectors):
the message-side decisions. Each detector gets a hand-built gold session for BOTH sides of the distinction it
measures (an idiom with each of its verbs, an inert clause and a carried one, ...), so a regex edit that loses
one side fails here. Nothing here needs the `nativetools` binary: table H is static.

    python3 -m unittest authored/test_cells_h.py
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cells as C  # noqa: E402

spec = importlib.util.spec_from_file_location("authored_coverage", HERE / "coverage.py")  # not PyPI's `coverage`
V = importlib.util.module_from_spec(spec)
sys.modules["authored_coverage"] = V
spec.loader.exec_module(V)

NF = [{"type": "decline", "reasons": ["not_found"]}]  # the gold of a miss
RAW = {
    "people": [
        {"key": "dr_mehta", "name": "Dr Mehta", "role": "dentist"},
        {"key": "dr_shah", "name": "Dr Shah", "role": "dentist"},
        {"key": "mum", "name": "Mum", "role": "mum"},
        {"key": "ria", "name": "Ria Cole", "role": "wedding planner"},
    ],
    "lists": [{"key": "kit_list", "name": "Kitchen Reno"}, {"key": "home_list", "name": "Home"}],
    "tasks": [
        {"key": "kit_tiles", "name": "Order tiles", "list": "kit_list"},
        {"key": "grout", "name": "Kitchen grout", "list": "home_list"},
        {"key": "diy", "name": "Paint the shed", "list": "home_list"},
        {"key": "tiles2", "name": "Order tiles again", "list": "home_list"},
    ],
    "notebooks": [{"key": "work_nb", "name": "Work"}],
    "notes": [{"key": "kit_note", "name": "Kitchen measurements", "notebook": "work_nb", "body": "tiles are 10cm"}],
    "documents": [
        {"key": "pass_scan", "name": "Passport scan"},
        {"key": "pass_old", "name": "Passport scan old", "trashed": True},
        {"key": "tax_doc", "name": "Tax return 2025"},
    ],
    "locker": [{"key": "nig_pass", "name": "Nigerian passport"}],
    "events": [{"key": "dent_visit", "name": "Dentist visit"}],
}
W = V.World.from_raw(RAW)


def act(verb, **a):
    return {"tool": "act", "args": {"verb": verb, **a}}


def call(tool, **a):
    return {"tool": tool, "args": a}


def turn(user, *refs, gold=None, clean=None):
    t = {"user": user, "ref": list(refs), "gold": gold or [{"type": "diff", "diff": {"rows": []}}]}
    if clean:
        t["noise"] = {"clean": clean}
    return t


def uses(*turns, replay=None):
    """H cells of the LAST turn of a session made of `turns` (earlier ones give context)."""
    s = {"id": "T00-001", "world": "T00", "turns": list(turns), "replay": replay or []}
    return {c[1:] for c in V.h_turn_uses(s, len(turns) - 1, W)}


def has(u, *cell):
    return (cell[0], *cell[1:]) in u


class Universe(unittest.TestCase):
    def test_static_and_unique(self):
        r = C.universe_h()["reachable"]
        self.assertEqual(len(r), len(set(r)))
        self.assertTrue(all(c[0] == "H" for c in r))
        self.assertEqual({c[1] for c in r}, {"H1 idiom", "H2 inert clause", "H3 lookalike", "H4 stop signal",
                                             "H5 role noun", "H6 date phrase", "H7 container word"})
        self.assertGreater(len(r), 100)

    def test_every_h1_side_is_a_token_a_call_can_produce(self):
        tokens = set(C.universe_h()["reachable"][0:0])
        for fam, (rx, sides) in C.H1_IDIOMS.items():
            V._rx(rx)  # compiles
            for side in sides:
                ok = (side in {"ask", "read", "undo"} or side.startswith(("create:", "decline:"))
                      or side in {"restore", "add_to", "reschedule", "edit", "log", "create"})
                self.assertTrue(ok, f"{fam}: {side}")
        self.assertFalse(tokens)

    def test_phrase_lists_compile(self):
        for p in list(C.H2_CLAUSES.values()) + [C.H4_RETRACT, C.H4_ALL, C.H4_EXCEPT, C.H4_DESTROY, C.H4_COMMAND, C.H4_FYI,
                                                C.H6_PAST, C.H6_FUTURE] + [rx for rx, _ in C.H6_PHRASES.values()]:
            V._rx(p)

    def test_in_universe_universe(self):
        """A cell a detector emits for the cases below must be a cell of the universe (no silent strays)."""
        u = set(C.universe_h()["reachable"])
        for t in (turn("put it back", act("restore", rows="$a")), turn("make it 4pm", act("reschedule", rows="$a"))):
            for c in uses(t):
                self.assertIn(("H", *c), u)


class H1Idioms(unittest.TestCase):
    def test_put_it_back_has_both_sides(self):
        self.assertTrue(has(uses(turn("put it back", act("restore", rows="$x"))), "H1 idiom", "put-it-back", "restore"))
        self.assertTrue(has(uses(turn("put the team photo back in the football album",
                                      act("add_to", rows="$p", to="$football"))), "H1 idiom", "put-it-back", "add_to"))
        self.assertTrue(has(uses(turn("put the tb test back to wednesday at 10", act("reschedule", rows="$x"))),
                            "H1 idiom", "put-it-back", "reschedule"))
        self.assertFalse(any(c[0] == "H1 idiom" and c[1] == "put-it-back" for c in uses(turn("put it in the shower folder", act("add_to", rows="$x")))))

    def test_bring_it_back_is_pronoun_only(self):
        self.assertTrue(has(uses(turn("bring it back", act("restore", rows="$x"))), "H1 idiom", "bring-it-back", "restore"))
        self.assertFalse(any(c[0] == "H1 idiom" and c[1] == "bring-it-back" for c in uses(turn("bring back the pay rent one", act("restore", rows="$x")))))

    def test_in_progress_edit_and_read(self):
        self.assertTrue(has(uses(turn("set it to in progress", act("edit", rows="$x", args="status: in_progress"))),
                            "H1 idiom", "mark-in-progress", "edit"))
        self.assertTrue(has(uses(turn("which ones are in progress", call("answer", kind="task", where="status = in_progress"))),
                            "H1 idiom", "mark-in-progress", "read"))

    def test_make_it_clock_vs_duration(self):
        u = uses(turn("dentist, make it 4pm on monday", act("reschedule", rows="$x")))
        self.assertTrue(has(u, "H1 idiom", "make-it-clock", "reschedule"))
        u = uses(turn("make it 90 mins", act("edit", rows="$x", args="duration: 90")))
        self.assertTrue(has(u, "H1 idiom", "make-it-duration", "edit"))
        self.assertFalse(any(c[0] == "H1 idiom" and c[1] == "make-it-clock" for c in u))
        self.assertTrue(has(uses(turn("ok make it 8:45", act("create", kind="event"))), "H1 idiom", "make-it-clock", "create:event"))

    def test_block_time_for(self):
        self.assertTrue(has(uses(turn("block friday afternoon for the report", act("create", kind="event"))),
                            "H1 idiom", "block-time-for", "create:event"))
        self.assertTrue(has(uses(turn("which one should i block time for on my off day", call("answer", kind="task"))),
                            "H1 idiom", "block-time-for", "read"))
        self.assertFalse(any(c[0] == "H1 idiom" and c[1] == "block-time-for" for c in uses(turn("hold the pinhole button for ten seconds",
                                                                         act("create", kind="note")))))

    def test_jot_down(self):
        self.assertTrue(has(uses(turn("jot down biscuit ate a sock", act("create", kind="note"))),
                            "H1 idiom", "jot-down-note-that", "create:note"))
        self.assertTrue(has(uses(turn("the seed one, note that sonia brings 40 sacks", act("edit", rows="$x"))),
                            "H1 idiom", "jot-down-note-that", "edit"))
        self.assertFalse(any(c[0] == "H1 idiom" and c[1] == "jot-down-note-that" for c in uses(turn("find the note that says chess", call("find", kind="note")))))

    def test_no_wait_day(self):
        self.assertTrue(has(uses(turn("no wait, make it friday at 10", act("reschedule", rows="$x"))),
                            "H1 idiom", "no-wait-day", "reschedule"))
        self.assertTrue(has(uses(turn("no wait, friday", call("decline", reason="never_mind"))),
                            "H1 idiom", "no-wait-day", "decline:never_mind"))

    def test_add_another(self):
        self.assertTrue(has(uses(turn("book another one for next tuesday at 10", act("create", kind="event"))),
                            "H1 idiom", "add-one-another", "create"))
        self.assertTrue(has(uses(turn("is there another one booked", call("answer", kind="event"))),
                            "H1 idiom", "add-one-another", "read"))
        self.assertFalse(any(c[0] == "H1 idiom" and c[1] == "add-one-another" for c in uses(turn("cancel the second one", act("cancel", rows="$x")))))

    def test_log_and_contact(self):
        self.assertTrue(has(uses(turn("log a call with marcus", act("log", rows="$m"))), "H1 idiom", "log-a-call-word", "log"))
        self.assertTrue(has(uses(turn("log a call", call("ask", question="Who?"))), "H1 idiom", "log-a-call-word", "ask"))
        self.assertTrue(has(uses(turn("rang bisi now", act("log", rows="$b"))), "H1 idiom", "contact-happened", "log"))
        self.assertTrue(has(uses(turn("the last three people i spoke to", call("answer", kind="person"))),
                            "H1 idiom", "contact-happened", "read"))

    def test_call_someone_request(self):
        self.assertTrue(has(uses(turn("call aunty ngozi saturday at 5", act("create", kind="event"))),
                            "H1 idiom", "call-someone-request", "create:event"))
        self.assertTrue(has(uses(turn("remind me to call ramesh tomorrow", act("create", kind="task"))),
                            "H1 idiom", "call-someone-request", "create:task"))
        self.assertFalse(any(c[0] == "H1 idiom" and c[1] == "call-someone-request" for c in uses(turn("call it cny shopping", act("edit", rows="$c1")))))

    def test_noisy_message_uses_the_clean_text(self):
        u = uses(turn("pu it bakc", act("restore", rows="$x"), clean="put it back"))
        self.assertTrue(has(u, "H1 idiom", "put-it-back", "restore"))


class H2InertClause(unittest.TestCase):
    def test_purpose_write_inert_vs_carried(self):
        u = uses(turn("restore the old rates for the grain quote", act("restore", rows="$old_rates")))
        self.assertTrue(has(u, "H2 inert clause", "purpose", "write", "inert"))
        u = uses(turn("restore the old rates for the grain quote", act("restore", kind="note", name="Grain quote rates")))
        self.assertTrue(has(u, "H2 inert clause", "purpose", "write", "carried"))

    def test_purpose_read(self):
        u = uses(turn("who is the dentist, need it for the school form", call("answer", kind="person", where='role = "dentist"')))
        self.assertTrue(has(u, "H2 inert clause", "aside", "read", "inert") or has(u, "H2 inert clause", "purpose", "read", "inert"))
        u = uses(turn("what's left for the kitchen", call("answer", kind="task", linked_to="$kit_list")))
        self.assertTrue(has(u, "H2 inert clause", "purpose", "read", "carried"))

    def test_reason_class(self):
        u = uses(turn("delete the shed task because the landlord sold it", act("delete", rows="$diy")))
        self.assertTrue(has(u, "H2 inert clause", "reason", "write", "inert"))
        u = uses(turn("delete the task because grout is done", act("delete", rows="$grout")))
        self.assertTrue(has(u, "H2 inert clause", "reason", "write", "carried"))

    def test_aside_class_and_date_only_clause_is_not_a_clause(self):
        u = uses(turn("take pappa out, it's a surprise", act("remove_from", rows="$pappa")))
        self.assertTrue(has(u, "H2 inert clause", "aside", "write", "inert"))
        u = uses(turn("what's on for the weekend", call("answer", kind="event", when="{}")))
        self.assertFalse(any(c[0] == "H2 inert clause" for c in u))

    def test_asks_declines_and_undo_are_skipped(self):
        for t in (turn("delete it, i need space for the photos", act("delete", rows="$x"), call("ask", question="which?")),
                  turn("scratch that, i need it for the quote", act("undo")),
                  turn("delete everything for the new year", call("decline", reason="unbounded_destruction"))):
            self.assertFalse(any(c[0] == "H2 inert clause" for c in uses(t)))


class H3Lookalike(unittest.TestCase):
    def test_other_kind_partial_name(self):
        u = uses(turn("star the passport", act("star", rows="$nig_pass"),
                      gold=[{"type": "diff", "diff": {"rows": [{"key": "nig_pass"}]}}]))
        self.assertTrue(has(u, "H3 lookalike", "other-kind", "partial", "name"))
        self.assertTrue(has(u, "H3 lookalike", "trashed", "partial", "name"))  # the trashed namesake document

    def test_a_distinguishing_word_removes_the_lookalike(self):
        u = uses(turn("star the nigerian passport", act("star", rows="$nig_pass"),
                      gold=[{"type": "diff", "diff": {"rows": [{"key": "nig_pass"}]}}]))
        self.assertFalse(any(c[0] == "H3 lookalike" for c in u))

    def test_same_kind_whole_and_qualifier(self):
        u = uses(turn("complete the order tiles task", act("complete", kind="task", name="Order tiles", where="status = open"),
                      gold=[{"type": "diff", "diff": {"rows": [{"key": "kit_tiles"}]}}]))
        self.assertTrue(has(u, "H3 lookalike", "same-kind", "whole", "name+qualifier"))  # "Order tiles again" is the lookalike

    def test_hash_n_and_where_forms(self):
        g = [{"type": "diff", "diff": {"rows": [{"key": "pass_scan"}]}}]
        u = uses(turn("delete the scan", act("delete", rows="@2"), gold=g))
        self.assertTrue(has(u, "H3 lookalike", "trashed", "partial", "#n"))
        u = uses(turn("star the passport scan", act("star", kind="document", where="starred = no"), gold=g))
        self.assertTrue(has(u, "H3 lookalike", "trashed", "whole", "where"))

    def test_ask_form_needs_a_real_ambiguity(self):
        t = turn("star the passport", act("star", rows="$x"), call("ask", question="which", options="a, b"))
        self.assertTrue(any(c[0] == "H3 lookalike" and c[3] == "ask" for c in uses(t)))
        t = turn("star the passport", call("ask", question="which one?"))
        self.assertFalse(any(c[0] == "H3 lookalike" for c in uses(t)))


class H4StopSignals(unittest.TestCase):
    def test_not_found_forms(self):
        for refs, form in (([call("search"), call("decline", reason="not_found")], "search-miss"),
                           ([call("find", kind="event", name="x"), call("decline", reason="not_found")], "find-miss"),
                           ([call("answer", kind="album", name="Tokyo"), call("decline", reason="not_found")], "read-by-name-miss"),
                           ([act("reschedule", kind="task", name="buy couch"), call("decline", reason="not_found")],
                            "write-by-name-miss")):
            self.assertTrue(has(uses(turn("move the zorp to friday", *refs, gold=NF)), "H4 stop signal", "not_found", form), form)

    def test_not_found_composed_miss_is_read_from_the_gold(self):
        """SPEC 8.5 / 4.8: the model writes the by-name call and stops; the runtime composes the ending, the gold carries it."""
        dnf = [{"type": "decline", "reasons": ["not_found"]}]
        u = uses(turn("is there a tokyo album yet", call("answer", kind="album", name="Tokyo"), gold=dnf))
        self.assertTrue(has(u, "H4 stop signal", "not_found", "read-by-name-miss"))
        u = uses(turn("push the zorp task to friday", act("reschedule", kind="task", name="Zorp"), gold=dnf))
        self.assertTrue(has(u, "H4 stop signal", "not_found", "write-by-name-miss"))
        empty = [{"type": "rows", "rows": []}]  # the composed empty answer of a plain miss
        u = uses(turn("got any photos of the zorp", call("answer", kind="photo", name="Zorp"), gold=empty))
        self.assertTrue(has(u, "H4 stop signal", "not_found", "read-by-name-miss"))
        near = [{"type": "rows", "rows": ["kit_note"]}]  # the near-spelling answer
        u = uses(turn("show me the kichen measurements note", call("answer", kind="note", name="Kichen measurements"), gold=near))
        self.assertTrue(has(u, "H4 stop signal", "not_found", "read-by-name-miss"))
        # a find miss is a lookup the turn goes on from: the miss is the by-name read it ends at, `find` is what was tried first
        u = uses(turn("what's in the zorp folder", call("find", kind="folder", name="Zorp"),
                      call("answer", kind="folder", name="Zorp"), gold=empty))
        self.assertTrue(has(u, "H4 stop signal", "not_found", "find-miss"))
        # ... and a name the model then repaired (search, then a call by handle) is no miss
        u = uses(turn("when's the zorp", call("find", kind="task", name="Zorp"), call("search", text="zorp"),
                      call("answer", rows="$grout"), gold=[{"type": "rows", "rows": ["grout"]}]))
        self.assertFalse(any(c[1] == "not_found" for c in u if c[0] == "H4 stop signal"))
        # a model-written decline after a search still reads (the old reference shape)
        u = uses(turn("when is the zorp", call("search"), call("decline", reason="not_found"), gold=dnf))
        self.assertTrue(has(u, "H4 stop signal", "not_found", "search-miss"))
        # the retraction axis reads the same outcome
        u = uses(turn("forget it, delete the zorp", act("delete", kind="task", name="Zorp"), gold=dnf))
        self.assertTrue(has(u, "H4 stop signal", "retraction", "any>decline:not_found"))

    def test_an_empty_answer_that_is_not_a_miss(self):
        empty = [{"type": "rows", "rows": []}]
        # conditions alone leave nothing: an answer, not a miss
        u = uses(turn("what's due next friday", call("answer", kind="task", when={"date": "2026-01-01"}), gold=empty))
        self.assertFalse(any(c[0] == "H4 stop signal" and c[1] == "not_found" for c in u))
        # the name reaches a row (word start), a condition leaves none: still an answer
        u = uses(turn("any kit tasks due friday", call("answer", kind="task", name="Order til", when={"date": "x"}), gold=empty))
        self.assertFalse(any(c[1] == "not_found" for c in u if c[0] == "H4 stop signal"))
        # another kind has the name in full: the runtime answers with that, no miss
        u = uses(turn("any task called dentist visit", call("answer", kind="task", name="Dentist visit"), gold=empty))
        self.assertFalse(any(c[1] == "not_found" for c in u if c[0] == "H4 stop signal"))
        # a trashed-only name is a miss unless the call asks for trashed rows
        u = uses(turn("is the old passport scan there", call("answer", kind="document", name="Passport scan old"), gold=empty))
        self.assertTrue(has(u, "H4 stop signal", "not_found", "read-by-name-miss"))
        u = uses(turn("is the old passport scan in the trash", call("answer", kind="document", name="Passport scan old", trashed=True),
                      gold=empty))
        self.assertFalse(any(c[1] == "not_found" for c in u if c[0] == "H4 stop signal"))

    def test_not_found_near_hit_row(self):
        refs = [call("search"), call("decline", reason="not_found")]
        self.assertTrue(has(uses(turn("is there a passport photo", *refs, gold=NF)), "H4 stop signal", "not_found", "with-near-hit-row"))
        self.assertTrue(has(uses(turn("is there a zorp photo", *refs, gold=NF)), "H4 stop signal", "not_found", "no-near-hit-row"))

    def test_retraction_positions_and_outcomes(self):
        nm = call("decline", reason="never_mind")
        self.assertTrue(has(uses(turn("never mind, i'll do it from my phone", nm)), "H4 stop signal", "retraction", "start>decline:never_mind"))
        self.assertTrue(has(uses(turn("move the dentist to six, no wait, leave it, i will call them", nm)),
                            "H4 stop signal", "retraction", "middle>decline:never_mind"))
        self.assertTrue(has(uses(turn("delete the report and the old budget, actually no, never mind", nm)),
                            "H4 stop signal", "retraction", "end>decline:never_mind"))
        self.assertTrue(has(uses(turn("scratch that, i still need it", act("undo"))), "H4 stop signal", "retraction", "start>undo"))
        self.assertTrue(has(uses(turn("nah delete it, i'll email them", act("delete", rows="$x"))), "H4 stop signal", "retraction", "start>act"))
        self.assertTrue(has(uses(turn("forget it, delete the zorp", call("search"), call("decline", reason="not_found"), gold=NF)),
                            "H4 stop signal", "retraction", "any>decline:not_found"))

    def test_fyi_outcomes(self):
        self.assertTrue(has(uses(turn("alice paid me for the tent hire", act("settle_debt", rows="$d"))), "H4 stop signal", "fyi-only", "act"))
        self.assertTrue(has(uses(turn("i owe mat for the movie", call("ask", question="how much?"))), "H4 stop signal", "fyi-only", "ask"))
        self.assertTrue(has(uses(turn("i forgot the pin for my visa", call("decline", reason="fabricated_secret"))),
                            "H4 stop signal", "fyi-only", "decline"))

    def test_fyi_is_not_a_fragment_or_a_command(self):
        for msg in ("the one from the gaa", "he paid up, mark it", "what did i owe mat", "the three debts i owe the most"):
            self.assertFalse(any(c[1] == "H4 stop signal" and c[2] == "fyi-only" for c in uses(turn(msg, act("star", rows="$x")))), msg)
        t1 = turn("he rang about the quote", act("log", rows="$x"))
        self.assertTrue(has(uses(turn("what's on friday", call("answer", kind="event")), t1), "H4 stop signal", "fyi-only", "act"))
        # right after an ask the same words are the answer to it, not a fact volunteered
        self.assertFalse(any(c[1] == "H4 stop signal" and c[2] == "fyi-only" for c in uses(turn("pick one", call("ask", question="?")), t1)))

    def test_all_but_one(self):
        self.assertTrue(has(uses(turn("delete everything except the passport scan", call("decline", reason="unbounded_destruction"))),
                            "H4 stop signal", "all-but-one", "decline:unbounded_destruction"))
        self.assertTrue(has(uses(turn("delete all of them except the november one", call("find", kind="task"), act("delete", rows="@prev"))),
                            "H4 stop signal", "all-but-one", "delete-by-find"))
        self.assertTrue(has(uses(turn("push them all a week except the pledges", call("find"), act("reschedule", rows="@prev"))),
                            "H4 stop signal", "all-but-one", "act-other"))
        self.assertTrue(has(uses(turn("show everything in the locker except memberships", call("answer", kind="locker item"))),
                            "H4 stop signal", "all-but-one", "read"))
        self.assertFalse(any(c[1] == "H4 stop signal" and c[2] == "all-but-one" for c in uses(turn("delete the passport", act("delete", rows="$x")))))

    def test_off_topic(self):
        d = call("decline", reason="out_of_scope")
        self.assertTrue(has(uses(turn("book me a taxi to the airport", d)), "H4 stop signal", "off-topic", "first-turn"))
        t0 = turn("what's on friday", call("answer", kind="event"))
        self.assertTrue(has(uses(t0, turn("what's the weather in lyon", d)), "H4 stop signal", "off-topic", "later-turn"))
        self.assertTrue(has(uses(turn("book me a table for the dentist dinner", d)), "H4 stop signal", "off-topic", "vault-word-decoy"))


class H5RoleNoun(unittest.TestCase):
    def test_forms(self):
        self.assertTrue(has(uses(turn("who is my dentist", call("answer", kind="person", where='role = "dentist"'))),
                            "H5 role noun", "trade", "role-filter"))
        self.assertTrue(has(uses(turn("rang the dentist", call("search", kind="person"), act("log", rows="$dr_mehta"))),
                            "H5 role noun", "trade", "name-or-key"))
        self.assertTrue(has(uses(turn("who is the dentist", call("search", kind="person"), call("answer", rows="@1"))),
                            "H5 role noun", "trade", "pick"))
        self.assertTrue(has(uses(turn("when did i last see the dentist", call("search", kind="person"))),
                            "H5 role noun", "trade", "whole-set"))

    def test_kinship_and_world_role(self):
        self.assertTrue(has(uses(turn("what do i owe mum", call("answer", kind="person", where='role = "mum"'))),
                            "H5 role noun", "kinship", "role-filter"))
        self.assertTrue(has(uses(turn("star the wedding planner", act("star", kind="person", where='role contains "planner"'))),
                            "H5 role noun", "world-role", "role-filter"))

    def test_create_and_non_person_calls_do_not_count(self):
        self.assertFalse(any(c[0] == "H5 role noun" for c in uses(turn("add my dentist as a contact", act("create", kind="person", name="x")))))
        self.assertFalse(any(c[0] == "H5 role noun" for c in uses(turn("when is the dentist", call("answer", kind="event")))))


class H6DatePhrase(unittest.TestCase):
    def ev(self, msg, when=None, where=None):
        a = {"kind": "event"}
        if when is not None:
            a["when"] = when
        if where:
            a["where"] = where
        return turn(msg, call("answer", **a))

    def test_before_by_until_by_tense(self):
        self.assertTrue(has(uses(self.ev("who haven't i heard from since before february", {"to": {"date": "2026-02-01"}})),
                            "H6 date phrase", "before-X", "open-to", "past"))
        self.assertTrue(has(uses(self.ev("what do i have before the 20th", {"from": {"date": "2026-11-01"}, "to": {"date": "2026-11-19"}})),
                            "H6 date phrase", "before-X", "closed", "future"))
        self.assertTrue(has(uses(self.ev("anything due by the 15th", {"to": {"date": "2026-12-15"}})),
                            "H6 date phrase", "by-X", "open-to", "future"))
        self.assertTrue(has(uses(self.ev("everything i had through october", {"to": {"date": "2026-10-31"}})),
                            "H6 date phrase", "until-X", "open-to", "past"))

    def test_before_a_clause_is_not_a_date_phrase(self):
        self.assertFalse(any(c[0] == "H6 date phrase" for c in uses(self.ev("what do i have before i go", {"to": {"date": "x"}}))))

    def test_from_x_on_and_month(self):
        self.assertTrue(has(uses(self.ev("anything due from january onwards", {"from": {"date": "2027-01-01"}})),
                            "H6 date phrase", "from-X-on", "open-from", "future"))
        self.assertTrue(has(uses(self.ev("how many days did i have in january", {"unit": "month", "rel": 0, "name": 1})),
                            "H6 date phrase", "named-month", "point", "past"))
        self.assertTrue(has(uses(self.ev("how many days did i have in january", {"from": {"date": "2026-01-01"}, "to": {"date": "2026-01-31"}})),
                            "H6 date phrase", "named-month", "closed", "past"))

    def test_or_older_and_years_ago(self):
        self.assertTrue(has(uses(self.ev("recipes from january or earlier that i had", {"to": {"unit": "month", "name": 1}})),
                            "H6 date phrase", "or-older", "open-to", "past"))
        self.assertTrue(has(uses(self.ev("what did i have two years ago", {"unit": "year", "rel": -2})),
                            "H6 date phrase", "N-years-ago", "point", "past"))
        self.assertTrue(has(uses(self.ev("notes from last year", {"from": {"date": "2025-01-01"}, "to": {"date": "2025-12-31"}})),
                            "H6 date phrase", "last-year", "closed", "past"))

    def test_longer_than_is_a_where_condition(self):
        self.assertTrue(has(uses(self.ev("what's on next week that runs longer than three hours",
                                         {"from": {"date": "2026-07-27"}, "to": {"date": "2026-08-02"}}, "duration > 180")),
                            "H6 date phrase", "longer-than-N-hours", "where-duration", "future"))
        u = uses(turn("tasks over an hour due next week", call("answer", kind="task", where="effort > 60 minutes",
                                                              when={"from": {"date": "a"}, "to": {"date": "b"}})))
        self.assertTrue(has(u, "H6 date phrase", "longer-than-N-hours", "where-effort", "future"))
        self.assertFalse(has(u, "H6 date phrase", "longer-than-N-hours", "closed", "future"))

    def test_no_tense_no_cell(self):
        self.assertFalse(any(c[0] == "H6 date phrase" for c in uses(self.ev("events before march", {"to": {"date": "x"}}))))


class H7ContainerWord(unittest.TestCase):
    def test_linked_to_vs_name_filter(self):
        u = uses(turn("what's left on the kitchen list", call("answer", kind="task", linked_to="$kit_list")))
        self.assertTrue(has(u, "H7 container word", "list", "kind-word", "linked_to"))
        u = uses(turn("what's left on the kitchen list", call("answer", kind="task", name="kitchen")))
        self.assertTrue(has(u, "H7 container word", "list", "kind-word", "name-filter"))

    def test_naming_forms(self):
        u = uses(turn("show me kitchen stuff", call("answer", kind="note", name="kitchen")))
        self.assertTrue(has(u, "H7 container word", "list", "theme-word", "name-filter"))
        u = uses(turn("what is in work notes about kitchen", call("answer", kind="note", linked_to="$work_nb")))
        self.assertFalse(any(c[0] == "H7 container word" and c[1] == "notebook" for c in u))  # nothing outside carries "work"

    def test_no_collision_no_cell(self):
        u = uses(turn("what's left on the home list", call("answer", kind="task", linked_to="$home_list")))
        self.assertFalse(any(c[0] == "H7 container word" and c[1] == "list" for c in u))


class Census(unittest.TestCase):
    def test_report_flags_empty_and_thin(self):
        reach = C.universe_h()["reachable"]
        a, b = reach[0], reach[1]
        text = V.h_report({a: [("T01", "T01-001")] * 3 + [("T02", "T02-001")], b: [("T01", "T01-002")]})
        self.assertIn("| ok |", text)
        self.assertIn("| THIN |", text)
        self.assertIn("| EMPTY |", text)
        self.assertIn(f"{len(reach)} cells: 1 ok, 1 thin", text)

    def test_classify_h_counts_worlds_and_sessions(self):
        s = {"id": "T00-001", "world": "T00", "turns": [turn("put it back", act("restore", rows="$x"))], "replay": []}
        d = V.World.__init__  # keep the linter honest: classify_h reads worlds from disk, so test the per-session path
        self.assertIsNotNone(d)
        self.assertEqual(V.h_turn_uses(s, 0, W)[0][:3], ("H", "H1 idiom", "put-it-back"))


if __name__ == "__main__":
    unittest.main()
