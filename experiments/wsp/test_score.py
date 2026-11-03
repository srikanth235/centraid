import unittest

import score

CAT = {
    "agenda.propose": {"type": "action", "params": {
        "title": {"type": "text", "required": True}, "starts": {"type": "when", "required": True},
        "status": {"type": "enum", "values": ["confirmed", "tentative"], "required": False},
        "attendees": {"type": "list", "items": "mention", "required": False},
        "n": {"type": "number", "required": False}, "flag": {"type": "bool", "required": False}}},
    "agenda.edit-event": {"type": "action", "params": {
        "target": {"type": "mention", "required": True}, "starts": {"type": "when", "required": False}}},
    "agenda.delete-event": {"type": "action", "params": {"target": {"type": "mention", "required": True}}},
    "agenda.day": {"type": "view", "params": {"day": {"type": "when", "required": False}}},
}


def call(tool, name=None, args=None, error=None):
    return {"tool": tool, "name": name, "args": args, "error": error}


def item(gold, iid="a-1", app="agenda"):
    return {"id": iid, "app": app, "gold": gold}


EDIT = {"tool": "act", "name": "agenda.edit-event",
        "args": {"target": "the dentist", "starts": ["thursday 4pm", "thursday at 4pm"]}, "optional": {}}


def sc(gold, c, **row):
    return score.score_item(item(gold), {"id": "a-1", "call": c, **row}, CAT)


class NormTest(unittest.TestCase):
    def test_norm(self):
        self.assertEqual(score.norm("  The   Dentist! "), "dentist")
        self.assertEqual(score.norm("My Mom's"), "moms")
        self.assertEqual(score.norm("Thursday, 4pm."), "thursday 4pm")
        self.assertEqual(score.norm("an apple"), "apple")
        self.assertEqual(score.norm("the"), "the")


class ItemTest(unittest.TestCase):
    def test_correct_with_anyof_and_normalisation(self):
        r = sc(EDIT, call("act", "agenda.edit-event", {"target": "Dentist", "starts": "Thursday at 4pm"}))
        self.assertTrue(r["correct"] and r["valid"] and r["args_ok"])

    def test_wrong_arg_value(self):
        r = sc(EDIT, call("act", "agenda.edit-event", {"target": "dentist", "starts": "friday"}))
        self.assertTrue(r["name_ok"] and not r["args_ok"] and not r["correct"])

    def test_missing_gold_arg(self):
        r = sc(EDIT, call("act", "agenda.edit-event", {"target": "dentist"}))
        self.assertFalse(r["args_ok"])

    def test_extra_arg_fails_but_optional_ok(self):
        gold = {"tool": "act", "name": "agenda.propose", "args": {"title": "lunch", "starts": "noon"}, "optional": {"status": ["tentative"]}}
        ok = sc(gold, call("act", "agenda.propose", {"title": "lunch", "starts": "noon", "status": "tentative"}))
        self.assertTrue(ok["correct"])
        bad_opt = sc(gold, call("act", "agenda.propose", {"title": "lunch", "starts": "noon", "status": "confirmed"}))
        self.assertTrue(bad_opt["valid"] and not bad_opt["args_ok"])
        extra = sc(gold, call("act", "agenda.propose", {"title": "lunch", "starts": "noon", "n": 3}))
        self.assertTrue(extra["valid"] and not extra["args_ok"])
        bare = sc(gold, call("act", "agenda.propose", {"title": "lunch", "starts": "noon"}))
        self.assertTrue(bare["correct"])

    def test_list_values(self):
        gold = {"tool": "act", "name": "agenda.propose", "args": {"title": "x", "starts": "y", "attendees": ["Ann", "Bo"]}, "optional": {}}
        self.assertTrue(sc(gold, call("act", "agenda.propose", {"title": "x", "starts": "y", "attendees": ["bo", "the Ann"]}))["correct"])
        self.assertFalse(sc(gold, call("act", "agenda.propose", {"title": "x", "starts": "y", "attendees": ["Ann"]}))["correct"])

    def test_valid_checks(self):
        v = lambda c: score.check_valid(c, CAT)
        self.assertTrue(v(call("act", "agenda.propose", {"title": "a", "starts": "b"}))[0])
        self.assertFalse(v(call("act", "agenda.nope", {}))[0])
        self.assertFalse(v(call("load", "agenda.propose", {}))[0])  # action called as view
        self.assertFalse(v(call("act", "agenda.day", {}))[0])  # view called as action
        self.assertEqual(v(call("act", "agenda.propose", {"title": "a"}))[1], "missing_arg:starts")
        self.assertEqual(v(call("act", "agenda.propose", {"title": "a", "starts": "b", "zz": 1}))[1], "extra_arg:zz")
        self.assertFalse(v(call("act", "agenda.propose", {"title": "a", "starts": "b", "status": "maybe"}))[0])
        self.assertFalse(v(call("act", "agenda.propose", {"title": "a", "starts": "b", "n": "3"}))[0])
        self.assertFalse(v(call("act", "agenda.propose", {"title": "a", "starts": "b", "n": True}))[0])
        self.assertTrue(v(call("act", "agenda.propose", {"title": "a", "starts": "b", "n": 3, "flag": False}))[0])
        self.assertFalse(v(call("act", "agenda.propose", {"title": "a", "starts": "b", "flag": "yes"}))[0])
        self.assertFalse(v(call("act", "agenda.propose", {"title": "a", "starts": "b", "attendees": "ann"}))[0])
        self.assertFalse(v(call("act", "agenda.propose", {"title": "a", "starts": 5}))[0])
        self.assertTrue(v(call("load", "agenda.day", {}))[0])
        self.assertTrue(v(call("ask", None, {"question": "which?"}))[0])
        self.assertFalse(v(call("ask", None, {"question": ""}))[0])
        self.assertTrue(v(call("decline", None, {"reason": "never_mind"}))[0])
        self.assertFalse(v(call("decline", None, {"reason": "rude"}))[0])
        self.assertFalse(v(call(None, error="no_tool_call"))[0])

    def test_invalid_is_not_correct(self):
        gold = {"tool": "act", "name": "agenda.delete-event", "args": {"target": "dentist"}, "optional": {}}
        r = sc(gold, call("act", "agenda.delete-event", {"target": "dentist", "junk": "x"}))
        self.assertFalse(r["valid"] or r["correct"])

    def test_unparsed(self):
        r = sc(EDIT, call(None, error="no_tool_call"))
        self.assertFalse(r["parse_ok"] or r["correct"] or r["wrong_write"] or r["over_ask"])

    def test_decline_and_ask_gold(self):
        gd = {"tool": "decline", "args": {"reason": "out_of_scope"}, "optional": {}}
        self.assertTrue(sc(gd, call("decline", None, {"reason": "out_of_scope"}))["correct"])
        self.assertFalse(sc(gd, call("decline", None, {"reason": "never_mind"}))["correct"])
        ga = {"tool": "ask", "args": {}, "optional": {}}
        self.assertTrue(sc(ga, call("ask", None, {"question": "Which one?"}))["correct"])

    def test_wrong_write(self):
        dele = {"tool": "act", "name": "agenda.delete-event", "args": {"target": "dentist"}, "optional": {}}
        self.assertFalse(sc(EDIT, call("act", "agenda.edit-event", {"target": "dentist", "starts": "x"}))["wrong_write"])  # right act, wrong arg
        self.assertTrue(sc(EDIT, call("act", "agenda.delete-event", {"target": "dentist"}))["wrong_write"])  # other act
        self.assertTrue(sc(EDIT, call("act", "agenda.edit-event", {"target": "the plumber", "starts": "x"}))["wrong_write"])  # other target
        self.assertTrue(sc(dele, call("act", "agenda.delete-event", {}))["wrong_write"])  # no target
        gl = {"tool": "load", "name": "agenda.day", "args": {}, "optional": {}}
        self.assertTrue(sc(gl, call("act", "agenda.delete-event", {"target": "x"}))["wrong_write"])  # act where gold reads
        self.assertFalse(sc(EDIT, call("load", "agenda.day", {}))["wrong_write"])
        self.assertTrue(sc({"tool": "ask", "args": {}, "optional": {}}, call("act", "agenda.delete-event", {"target": "x"}))["wrong_write"])

    def test_ask_rates(self):
        ga = {"tool": "ask", "args": {}, "optional": {}}
        over = sc(EDIT, call("ask", None, {"question": "when?"}))
        self.assertTrue(over["over_ask"] and not over["under_ask"])
        under = sc(ga, call("act", "agenda.delete-event", {"target": "x"}))
        self.assertTrue(under["under_ask"] and not under["over_ask"])
        self.assertTrue(sc(ga, call(None, error="no_tool_call"))["under_ask"])

    def test_repeat_loop(self):
        span = " ".join(f"w{i}" for i in range(20)) + ". "
        self.assertTrue(score.has_loop(span * 3))
        self.assertFalse(score.has_loop(span * 2 + "something else entirely " * 5))
        self.assertFalse(score.has_loop(None))
        self.assertTrue(sc(EDIT, call(None, error="x"), think=span * 4)["loop"])

    def test_retrieval(self):
        r = sc(EDIT, call("act", "agenda.edit-event", {}), candidates=["x", "agenda.edit-event"])
        self.assertTrue(r["retrieved"])
        self.assertFalse(sc(EDIT, call(None, error="x"), candidates=["x"])["retrieved"])
        self.assertIsNone(sc({"tool": "ask", "args": {}, "optional": {}}, call(None, error="x"))["retrieved"])


class SummaryTest(unittest.TestCase):
    def test_summary_and_markdown(self):
        items = [item(EDIT, "a-1", "agenda"), item(EDIT, "b-1", "notes")]
        rows = [{"id": "a-1", "call": call("act", "agenda.edit-event", {"target": "dentist", "starts": "thursday 4pm"}), "capped": True, "think_tokens": 200, "candidates": ["agenda.edit-event"]},
                {"id": "b-1", "call": call("ask", None, {"question": "?"}), "think_tokens": 10, "candidates": []}]
        scored = score.score_rows(items, rows, CAT)
        s = score.summarize(scored)
        self.assertEqual(s["overall"]["n"], 2)
        self.assertEqual(s["overall"]["correct"], 1)
        self.assertEqual(s["overall"]["capped_rate"], 0.5)
        self.assertEqual(s["overall"]["mean_think_tokens"], 105.0)
        self.assertEqual(s["overall"]["retrieval_recall"], 0.5)
        self.assertEqual(s["overall"]["over_ask"], 1)
        self.assertEqual(sorted(s["per_app"]), ["agenda", "notes"])
        self.assertIn("| agenda |", score.to_markdown(s))

    def test_pair(self):
        a = [{"id": str(i), "correct": c} for i, c in enumerate([1, 1, 0, 0, 0, 0, 0, 0, 0, 0])]
        b = [{"id": str(i), "correct": c} for i, c in enumerate([1, 0, 1, 1, 1, 1, 1, 1, 1, 0])]
        p = score.pair(a, b)
        self.assertEqual((p["won"], p["lost"], p["n"]), (7, 1, 10))
        self.assertAlmostEqual(p["z"], 6 / 8 ** 0.5, places=3)
        self.assertEqual(score.pair(a, a)["z"], 0.0)




class MentionTest(unittest.TestCase):
    def test_kind_noun_and_lead_fold(self):
        import score
        for a, b in [("sunset pic", "sunset"), ("one of mum at the lake", "mum at the lake"),
                     ("checking account", "checking"), ("scan of the 2019 receipt", "2019 receipt")]:
            self.assertEqual(score.mention_norm(a), score.mention_norm(b), (a, b))

    def test_never_empties_and_text_params_stay_strict(self):
        import score
        self.assertEqual(score.mention_norm("pic"), "pic")
        gold = {"args": {"target": "sunset", "title": "beach pic"}, "optional": {}}
        self.assertTrue(score.args_match({"target": "sunset pic", "title": "beach pic"}, gold, {"target"}))
        self.assertFalse(score.args_match({"target": "sunset", "title": "beach"}, gold, {"target"}))


if __name__ == "__main__":
    unittest.main()
