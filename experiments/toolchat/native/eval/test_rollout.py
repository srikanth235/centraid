"""Tests for rollout.py on synthetic runs, built in the exact format run.py writes (no model, no runtime).

    python3 -m unittest test_rollout -v      # from experiments/toolchat/native/eval

The transcript of a rollout is read off the run record by `StaticReplayer` (the export uses the runtime, which also compacts old tool
turns; that part is not under test here).
"""

from __future__ import annotations

import collections
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "train"), str(HERE.parent)]  # runs from native/ (`-m unittest eval/test_rollout.py`) or eval/

import render  # noqa: E402
import rollout as R  # noqa: E402

SYS = {"role": "system", "content": "today: Thursday 2026-03-12\nme: Me\n\nkinds: ...", "tools": []}


def msg(think: str, tool: str = "answer", **args) -> str:
    """One assistant message as the model writes it: the think, then the call."""
    return f"<think>\n{think}\n</think>\n\n{render.call_text(tool, args)}"


def step(text: str, reply: str = "answered: 1 task", ends: bool = True, error: bool = False, **extra) -> dict:
    eff = {"error": reply} if error else {"tool": "answer"}
    return {"model": text, "response": {"text": reply, "ends_turn": ends and not error, "effect": eff}, "think_cut": False, **extra}


def turn(user: str, *steps: dict, preground: str | None = "vault: #1 task \"x\"") -> dict:
    return {"user": user, "preground": preground, "steps": list(steps)}


def run_rec(rid: str, *turns: dict) -> dict:
    return {"id": rid, "model": "hf", "tools_mode": "sig", "turns": list(turns)}


def gold(sid: str, n_turns: int, world: str = "T01", tags=("read",)) -> dict:
    return {"id": sid, "set": "train", "world": world, "today": "2026-03-12T18:20", "me": "Me", "tags": list(tags),
            "turns": [{"user": f"u{i + 1}", "gold": [], "ref": [], "tags": []} for i in range(n_turns)]}


def good(i: int, tag: str = "") -> dict:
    """Turn i (1-based) answered right in one step."""
    return turn(f"u{i}", step(msg(f"intent: read u{i}{tag}", rows=f"#{i}"), f"answered: #{i}"))


def run_export(screen, runs, failed, m=2, p=2, **kw):
    return R.export_rollouts(screen, runs, failed, R.StaticReplayer(lambda s: SYS), m, p, **kw)


class Ids(unittest.TestCase):
    def test_round_trip(self):
        for sid in ("T01-K001", "T05-002-F", "T09-014"):
            for k in (1, 3, 6, 12):
                self.assertEqual(R.split_sample_id(R.sample_id(sid, k)), (sid, k))
        self.assertEqual(R.sample_id("T01-K001", 3), "T01-K001-s3")

    def test_a_screen_id_has_no_k(self):
        self.assertEqual(R.split_sample_id("T01-K001"), ("T01-K001", None))
        self.assertEqual(R.split_sample_id("T01-K001-s0"), ("T01-K001-s0", None))  # k counts from 1

    def test_a_session_id_that_ends_like_a_sample_id(self):
        known = {"T01-s2", "T01-x"}
        self.assertEqual(R.split_sample_id("T01-s2", known), ("T01-s2", None))  # the screen id of a real session
        self.assertEqual(R.split_sample_id("T01-s2-s1", known), ("T01-s2", 1))  # its first sample
        self.assertEqual(R.split_sample_id("T01-x-s4", known), ("T01-x", 4))


class Fraction(unittest.TestCase):
    IDS = [f"T01-{i:03d}-F" for i in range(2000)]

    def test_deterministic_and_order_free(self):
        a = [i for i in self.IDS if R.keep_fraction(i, 0.3, 1044)]
        b = [i for i in reversed(self.IDS) if R.keep_fraction(i, 0.3, 1044)]
        self.assertEqual(a, sorted(b, key=self.IDS.index))
        self.assertEqual(a, [i for i in self.IDS if R.keep_fraction(i, 0.3, 1044)])

    def test_share_and_seed(self):
        a = {i for i in self.IDS if R.keep_fraction(i, 0.3, 1044)}
        self.assertTrue(500 < len(a) < 700, len(a))  # 30% of 2,000, give or take
        other = {i for i in self.IDS if R.keep_fraction(i, 0.3, 7)}
        self.assertNotEqual(a, other)
        self.assertEqual(sum(R.keep_fraction(i, 0.0, 1) for i in self.IDS), 0)
        self.assertEqual(sum(R.keep_fraction(i, 1.0, 1) for i in self.IDS), len(self.IDS))

    def test_sample_rows(self):
        screen = [gold(f"T01-{i:03d}-F", 2) for i in range(100)]
        failed = {f"T01-{i:03d}-F": {1} for i in range(0, 100, 4)}  # 25 failed the screen
        rows, stats = R.sample_rows(screen, failed, 6, 0.3, 1044)
        again, _ = R.sample_rows(screen, failed, 6, 0.3, 1044)
        self.assertEqual(rows, again)
        ids = [r["id"] for r in rows]
        self.assertEqual(len(ids), len(set(ids)))
        by = collections.Counter(R.split_sample_id(i)[0] for i in ids)
        self.assertTrue(all(v == 6 for v in by.values()))
        self.assertTrue(set(failed) <= set(by))  # every failed session is sampled
        passing = set(by) - set(failed)
        self.assertEqual(passing, {s["id"] for s in screen if s["id"] not in failed and R.keep_fraction(s["id"], 0.3, 1044)})
        self.assertEqual(stats["sessions_sampled"], len(by))
        self.assertEqual(stats["rows"], len(rows))
        base = {s["id"]: s for s in screen}
        for r in rows:  # a copy is its session, only the id differs
            sid, k = R.split_sample_id(r["id"])
            self.assertEqual({**r, "id": sid}, base[sid])
            self.assertIn(k, range(1, 7))


class Tags(unittest.TestCase):
    def test_skill_tags_are_one_key(self):
        self.assertEqual(R.tag_keys(["referent", "locker", "i3skill", "S1"]), ["referent", "locker", "i3skill S1"])
        self.assertEqual(R.tag_keys(["i3skill"]), ["i3skill"])
        self.assertEqual(R.tag_keys([]), [])


class SetFiles(unittest.TestCase):
    def test_built_gold_keeps_the_sessions_that_verified(self):
        with tempfile.TemporaryDirectory() as d:
            w = Path(d) / "T01"
            w.mkdir()
            rows = [dict(gold(f"T01-{i}", 1), replay=[1]) for i in range(3)]
            (w / "T01.gold.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
            (w / "T01.report.json").write_text(json.dumps([{"id": "T01-0", "pass": True}, {"id": "T01-1", "pass": False},
                                                           {"id": "T01-2", "pass": True}]))
            kept, per = R.built_gold([d])
            self.assertEqual([r["id"] for r in kept], ["T01-0", "T01-2"])
            self.assertTrue(all("replay" not in r for r in kept))
            self.assertEqual(per, {"T01": {"kept": 2, "dropped": 1}})

    def test_failed_turns_and_report_coverage(self):
        rep = {"sessions": 3, "failed": [{"id": "a", "turn": 2}, {"id": "a", "turn": 3}, {"id": "b (blocked: x)", "turn": 1}]}
        self.assertEqual(R.failed_turns(rep), {"a": {2, 3}, "b": {1}})
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "report.json"
            p.write_text(json.dumps(rep))
            self.assertEqual(R.stage_failed([{}, {}, {}], None, [p])["a"], {2, 3})
            with self.assertRaises(SystemExit):  # a report of another set (or a part of it) is refused
                R.stage_failed([{}, {}], None, [p])


class Runs(unittest.TestCase):
    """valid_run, read_json_lines, collect: what a run file may hold."""

    def test_a_torn_line_is_skipped_and_counted(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "run.jsonl"
            p.write_text(json.dumps(run_rec("a", good(1))) + "\n" + '{"id": "b", "turns": [{"user": "u1", "ste')
            c = collections.Counter()
            self.assertEqual([r["id"] for r in R.read_json_lines(p, c)], ["a"])
            self.assertEqual(c["torn_lines"], 1)

    def test_malformed_and_partial_records_are_skipped(self):
        g = gold("S", 2)
        ok = run_rec("S", good(1), good(2))
        self.assertIsNone(R.valid_run(ok, g))
        self.assertEqual(R.valid_run({**ok, "error": "RuntimeError('boom')", "turns": []}, g), "error")
        self.assertEqual(R.valid_run({"id": "S", "turns": "x"}, g), "malformed")
        self.assertEqual(R.valid_run({"id": "S"}, g), "malformed")
        self.assertEqual(R.valid_run([1, 2], g), "malformed")
        self.assertEqual(R.valid_run(run_rec("S", {"user": "u1", "steps": [{"response": {}}]}, good(2)), g), "malformed")  # no model
        self.assertEqual(R.valid_run(run_rec("S", {"user": "u1", "steps": ["x"]}, good(2)), g), "malformed")
        self.assertEqual(R.valid_run(run_rec("S", good(1)), g), "partial")  # one turn of two
        self.assertEqual(R.valid_run({**ok, "tools_mode": "full"}, g), "tools_mode")  # the records are for the `sig` prompt

    def test_collect_counts_what_it_leaves_out(self):
        screen = [gold("S", 1), gold("T", 1)]
        recs = [run_rec("S", good(1)), run_rec("S", good(1)), run_rec("Z-s1", good(1)), run_rec("T-s1", {"user": "u1"}), "junk",
                {"model": "hf"}, run_rec("T-s2", good(1)), {"id": "S-s1", "error": "x", "turns": []}]
        c = collections.Counter()
        out = R.collect(screen, {"screen": recs}, {}, c)
        self.assertEqual(sorted(r.id for rs in out.values() for r in rs), ["S", "T-s2"])
        self.assertEqual((c["skipped_duplicate"], c["skipped_unknown_id"], c["skipped_malformed"], c["skipped_error"]), (1, 1, 3, 1))

    def test_export_survives_a_run_made_of_junk(self):
        screen = [gold("S", 1)]
        recs = [{"id": "S", "turns": [{"steps": [{"model": 1}]}]}, {"id": "S-s1", "turns": None}, 7]
        rft, pairs, summary = run_export(screen, {"screen": recs, "sample": []}, {})
        self.assertEqual((rft, pairs, summary["rft_records"], summary["pairs"]), ([], [], 0, 0))
        self.assertEqual(summary["sessions_screened"], 1)

    def test_a_session_whose_scoring_is_missing_still_counts_only_when_it_ran(self):
        # failed has no entry for a session that was never run: it has no rollout, so it yields no record
        rft, _, summary = run_export([gold("S", 1), gold("T", 1)], {"screen": [run_rec("S", good(1))], "sample": []}, {})
        self.assertEqual([r["id"] for r in rft], ["rft-S-r1"])
        self.assertEqual(summary["screen_pass"], 1)
        self.assertEqual(summary["screen_pass_rate"], 0.5)


class Rft(unittest.TestCase):
    def test_a_rollout_counts_only_if_every_turn_passes(self):
        screen = [gold("S", 3)]
        run = run_rec("S", good(1), good(2), good(3))
        rft, _, summary = run_export(screen, {"screen": [run], "sample": []}, {"S": {3}})
        self.assertEqual(rft, [])
        rft, _, summary = run_export(screen, {"screen": [run], "sample": []}, {})
        self.assertEqual(len(rft), 1)
        self.assertEqual(summary["sessions_with_pass"], 1)
        self.assertEqual(rft[0]["n_turns"], 3)

    def test_dedup_by_exact_assistant_text(self):
        screen = [gold("S", 2)]
        a = [good(1), good(2)]
        b = [good(1), good(2, " alt")]
        recs = [run_rec("S", *a), run_rec("S-s1", *a), run_rec("S-s2", *b), run_rec("S-s3", *a), run_rec("S-s4", good(1), good(2, " other"))]
        rft, _, summary = run_export(screen, {"screen": recs[:1], "sample": recs[1:]}, {}, m=2)
        self.assertEqual([r["id"] for r in rft], ["rft-S-r1", "rft-S-r2"])
        self.assertEqual(rft[0]["messages"][2]["think"], "intent: read u1")
        self.assertEqual(rft[1]["messages"][5]["think"], "intent: read u2 alt")  # the second distinct text, not the copy of the first
        rft, _, _ = run_export(screen, {"screen": recs[:1], "sample": [recs[1], recs[3]]}, {}, m=2)
        self.assertEqual(len(rft), 1)  # every rollout wrote the same messages
        rft, _, _ = run_export(screen, {"screen": recs[:1], "sample": recs[1:]}, {}, m=3)
        self.assertEqual(len(rft), 3)

    def test_the_replies_do_not_make_a_rollout_new(self):
        screen = [gold("S", 1)]
        a = run_rec("S", good(1))
        b = run_rec("S-s1", turn("u1", step(msg("intent: read u1", rows="#1"), "answered: something else")))
        rft, _, _ = run_export(screen, {"screen": [a], "sample": [b]}, {}, m=2)
        self.assertEqual(len(rft), 1)

    def test_unclean_rollouts_are_no_examples(self):
        screen = [gold("S", 1)]
        loop = turn("u1", step(msg("intent: read u1", rows="#1"), "hint", ends=False, ),
                    step(msg("intent: read u1", rows="#1"), "ended", ends=True))
        loop["steps"][1]["response"]["effect"] = {"loop": True}
        cut = turn("u1", {**step(msg("intent: read u1", rows="#1")), "think_cut": True})
        rft, _, summary = run_export(screen, {"screen": [run_rec("S", loop)], "sample": [run_rec("S-s1", cut)]}, {}, m=2)
        self.assertEqual(rft, [])
        self.assertEqual(summary["counters"]["unclean_loop"], 1)
        self.assertEqual(summary["counters"]["unclean_think_cut"], 1)
        rft, _, _ = run_export(screen, {"screen": [run_rec("S", loop)], "sample": []}, {}, m=2, keep_loops=True)
        self.assertEqual(len(rft), 1)

    def test_an_unparseable_assistant_message_is_skipped(self):
        screen = [gold("S", 1)]
        bad = run_rec("S", turn("u1", step("no think and no call here", "answered: 1")))
        rft, _, summary = run_export(screen, {"screen": [bad], "sample": []}, {})
        self.assertEqual(rft, [])
        self.assertEqual(summary["counters"]["rft_skipped_unparseable"], 1)

    def test_error_steps_carry_no_loss(self):
        screen = [gold("S", 1)]
        t = turn("u1", step(msg("intent: write u1", "act", verb="create", args="kind: note"), "error: create takes kind as...", error=True),
                 step(msg("retry: rejected", "act", verb="create", kind="note"), "created: #9 note"))
        rft, _, _ = run_export(screen, {"screen": [run_rec("S", t)], "sample": []}, {})
        a = [m for m in rft[0]["messages"] if m["role"] == "assistant"]
        self.assertIs(a[0].get("loss"), False)
        self.assertNotIn("loss", a[1])


# A record as authored/build.py writes it (two turns; the first has a rejected call and its repair), reduced to a small system block.
BUILD_MESSAGES = [
    SYS,
    {"role": "user", "content": "vault: #19 notebook \"Work Notes\" (5 notes)\n\nnew note in work notes: bring the big flask"},
    {"role": "assistant", "think": "intent: write \"new\"\nverb: create\nset: kind = note", "tool": "act",
     "args": {"verb": "create", "args": "kind: note\nname: Flask"}, "loss": False},
    {"role": "tool", "content": "error: create takes kind as the top-level kind parameter"},
    {"role": "assistant", "think": "retry: rejected\nintent: write \"new\"\nkind: note", "tool": "act",
     "args": {"verb": "create", "kind": "note", "args": "name: Flask\nbody: bring the big flask\nnotebook: #19"}},
    {"role": "tool", "content": "created: #37 note \"Flask\""},
    {"role": "user", "content": "vault: #16 notebook \"Family\" (6 notes)\nfocus: created #37 note \"Flask\"\n\nstick it in the family one"},
    {"role": "assistant", "think": "intent: write \"stick\"\nverb: add_to\nrows: #37", "tool": "act",
     "args": {"verb": "add_to", "rows": "#37", "args": "to: #16"}},
    {"role": "tool", "content": "added: #37 to #16"},
]


def run_of(messages: list[dict], rid: str) -> tuple[dict, dict]:
    """The run record and gold session a build record's messages would give (what run.py writes for those messages)."""
    turns, cur = [], None
    for m in messages[1:]:
        if m["role"] == "user":
            block, _, text = m["content"].rpartition("\n\n")
            cur = {"user": text, "preground": block or None, "steps": []}
            turns.append(cur)
        elif m["role"] == "assistant":
            reply = None
            cur["steps"].append({"model": f"<think>\n{m['think']}\n</think>\n\n{render.call_text(m['tool'], m['args'])}", "reply": None,
                                 "bad": m.get("loss") is False})
        else:
            cur["steps"][-1]["reply"] = m["content"]
    for t in turns:
        t["steps"] = [{"model": s["model"], "think_cut": False, "response": {
            "text": s["reply"], "ends_turn": i == len(t["steps"]) - 1,
            "effect": {"error": s["reply"]} if s["bad"] else {"tool": "act"}}} for i, s in enumerate(t["steps"])]
    return {"id": rid, "model": "hf", "tools_mode": "sig", "turns": turns}, \
        {**gold(rid, len(turns)), "turns": [{"user": t["user"], "gold": [], "ref": [], "tags": []} for t in turns]}


class RecordShape(unittest.TestCase):
    def test_a_passing_rollout_is_a_build_record(self):
        run, g = run_of(BUILD_MESSAGES, "T01-022-F")
        g["tags"] = ["create", "i3skill", "S4"]
        # the build's tool turns of the LAST turn are dropped (trailing), those of the others stay
        want_msgs = BUILD_MESSAGES[:-1]
        rft, _, _ = run_export([g], {"screen": [run], "sample": []}, {})
        self.assertEqual(len(rft), 1)
        rec = rft[0]
        # what authored/build.py writes for a session (its writer's key set and order, its values for the same session)
        want = {"id": "train-T01-022-F", "split": "train", "world": "T01", "today": "2026-03-12T18:20", "me": "Me",
                "tools_mode": "sig", "messages": want_msgs, "n_turns": 2, "tags": ["create", "i3skill", "S4"], "source": "authored"}
        self.assertEqual(list(rec), list(want))
        self.assertEqual({k: v for k, v in rec.items() if k not in ("id", "source")}, {k: v for k, v in want.items() if k not in ("id", "source")})
        self.assertEqual(rec["id"], "rft-T01-022-F-r1")
        self.assertEqual(rec["source"], "rft")
        self.assertEqual(json.dumps(rec["messages"]), json.dumps(want_msgs))  # byte for byte: key order of every message too
        for m in rec["messages"][1:]:
            self.assertEqual(sorted(m), sorted({"user": ["role", "content"], "tool": ["role", "content"]}.get(m["role"], m)))

    def test_the_records_encode_for_the_trainer(self):
        """The real check: train.py's own reader takes the RFT record and the pair records (loss mask, decision spans)."""
        try:
            from transformers import AutoTokenizer

            tok = AutoTokenizer.from_pretrained("Qwen/Qwen3.5-0.8B")
        except Exception as e:  # noqa: BLE001
            self.skipTest(f"no tokenizer: {e!r:.80}")
        import fmt

        tools = [{"type": "function", "function": {"name": "answer", "description": "answer(...)", "parameters": {"type": "object", "properties": {}}}}]
        sysrec = {**SYS, "tools": tools}
        run, g = run_of(BUILD_MESSAGES, "T01-022-F")
        rft, _, _ = export_with(sysrec, [g], [run], [])
        enc = fmt.encode(tok, rft[0], None)
        fmt.check_spans(rft[0], enc)
        fmt.check_decisions(enc)
        labelled = [m for m in enc["records"] if m["role"] == "assistant" and m.get("loss", True)]
        self.assertEqual(len(labelled), 2)  # the rejected call is context only
        # pairs: train.py's own loader (--dpo) takes both sides, with the context turns unlabelled
        import train as T

        wrong = json.loads(json.dumps(run))
        wrong["id"] = "T01-022-F-s1"
        wrong["turns"][1]["steps"][0]["model"] = wrong["turns"][1]["steps"][0]["model"].replace("to: #16", "to: #99")
        _, pairs, _ = export_with(sysrec, [g], [run], [wrong], failed={"T01-022-F-s1": {2}})
        self.assertEqual(len(pairs), 1)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "dpo.jsonl.gz"
            R.write_jsonl(path, pairs)
            loaded = T.load_pairs(tok, str(path), 8192, 0, None, 8, fmt.DecisionConfig())
        self.assertEqual(len(loaded), 1)
        c, r = loaded[0].chosen, loaded[0].rejected
        first = [next(i for i, y in enumerate(x[1]) if y != fmt.IGNORE) for x in (c, r)]
        self.assertEqual(first[0], first[1])  # both start labelling at the same place, in the same context:
        self.assertEqual(c[0][:first[0]], r[0][:first[0]])
        self.assertGreater(first[0], 300)  # after the system block, turn 1 and the user message of turn 2


def export_with(sysrec, screen, screen_runs, sample_runs, failed=None, **kw):
    return R.export_rollouts(screen, {"screen": screen_runs, "sample": sample_runs}, failed or {},
                             R.StaticReplayer(lambda s: sysrec), kw.pop("m", 2), kw.pop("p", 2), **kw)


class Pairs(unittest.TestCase):
    def setUp(self):
        self.screen = [gold("S", 3)]

    def two_step(self, tag: str, second: str, reply: str = "answered: ok", ends=True) -> dict:
        """Turn 2 as two steps: a find (same text for every rollout) then a second step that varies."""
        return turn("u2", step(msg("intent: look u2", "find", kind="task"), "found: #4", ends=False),
                    step(msg(f"intent: {second}{tag}", rows="#4"), reply, ends=ends))

    def test_exact_pair_labels_the_divergent_step_only(self):
        p = run_rec("S", good(1), self.two_step("", "read u2"), good(3))
        f = run_rec("S-s1", good(1), self.two_step("", "read the wrong thing", "answered: wrong"), good(3))
        rft, pairs, summary = run_export(self.screen, {"screen": [p], "sample": [f]}, {"S-s1": {2, 3}})
        self.assertEqual(len(pairs), 1)
        pr = pairs[0]
        self.assertEqual(set(pr), {"id", "chosen", "rejected"})
        self.assertEqual(pr["id"], "S-p1")
        for side, think in (("chosen", "intent: read u2"), ("rejected", "intent: read the wrong thing")):
            rec = pr[side]
            self.assertEqual(list(rec), ["id", "split", "world", "today", "me", "tools_mode", "messages", "n_turns", "tags", "source"])
            self.assertEqual(rec["n_turns"], 2)  # cut at the end of the failing turn: turn 3 is gone
            self.assertEqual(rec["source"], "dpo-exact")
            a = [m for m in rec["messages"] if m["role"] == "assistant"]
            self.assertEqual([m.get("loss", True) for m in a], [False, False, True])  # turn 1, the shared find, the divergent step
            self.assertEqual(a[-1]["think"], think)
            self.assertEqual(rec["messages"][-1]["role"], "assistant")
            self.assertNotIn("u3", json.dumps(rec["messages"]))
        # the shared prefix is the same text on both sides
        self.assertEqual(pr["chosen"]["messages"][:-1], pr["rejected"]["messages"][:-1])
        self.assertEqual(summary["pairs"], 1)
        self.assertEqual(summary["pairs_exact"], 1)

    def test_pair_at_the_first_turn(self):
        p = run_rec("S", good(1), good(2), good(3))
        f = run_rec("S-s1", good(1, " wrong"), good(2), good(3))
        _, pairs, _ = run_export(self.screen, {"screen": [p], "sample": [f]}, {"S-s1": {1}})
        self.assertEqual(len(pairs), 1)
        a = [m for m in pairs[0]["rejected"]["messages"] if m["role"] == "assistant"]
        self.assertEqual(len(a), 1)
        self.assertEqual(pairs[0]["rejected"]["n_turns"], 1)
        self.assertEqual(pairs[0]["chosen"]["messages"][2]["think"], "intent: read u1")

    def test_the_first_failing_turn_is_the_one_cut_at(self):
        p = run_rec("S", good(1), good(2), good(3))
        f = run_rec("S-s1", good(1), good(2, " wrong"), good(3, " wrong"))
        _, pairs, _ = run_export(self.screen, {"screen": [p], "sample": [f]}, {"S-s1": {3, 2}})
        self.assertEqual(pairs[0]["rejected"]["n_turns"], 2)  # not 3: turn 3 fails only downstream of turn 2

    def test_context_pair_keeps_each_sides_own_earlier_turns_as_context(self):
        p = run_rec("S", good(1), good(2), good(3))
        f = run_rec("S-s1", good(1, " other way"), good(2, " wrong"), good(3))  # turn 1 passes too, written differently
        _, pairs, summary = run_export(self.screen, {"screen": [p], "sample": [f]}, {"S-s1": {2}})
        self.assertEqual(summary["pairs_context"], 1)
        c, r = pairs[0]["chosen"], pairs[0]["rejected"]
        self.assertEqual(c["source"], "dpo-context")
        ca = [m for m in c["messages"] if m["role"] == "assistant"]
        ra = [m for m in r["messages"] if m["role"] == "assistant"]
        self.assertEqual([m["think"] for m in ca], ["intent: read u1", "intent: read u2"])
        self.assertEqual([m["think"] for m in ra], ["intent: read u1 other way", "intent: read u2 wrong"])  # its own turn 1, not the other's
        self.assertEqual([m.get("loss", True) for m in ca], [False, True])
        self.assertEqual([m.get("loss", True) for m in ra], [False, True])

    def test_exact_pairs_come_first_and_p_caps_them(self):
        p = run_rec("S", good(1), good(2), good(3))
        p2 = run_rec("S-s1", good(1, " other way"), good(2), good(3))
        f1 = run_rec("S-s2", good(1), good(2, " wrong a"), good(3))
        f2 = run_rec("S-s3", good(1), good(2, " wrong b"), good(3))
        f3 = run_rec("S-s4", good(1, " other way"), good(2, " wrong c"), good(3))
        failed = {"S-s2": {2}, "S-s3": {2}, "S-s4": {2}}
        _, pairs, summary = run_export(self.screen, {"screen": [p], "sample": [p2, f1, f2, f3]}, failed, p=2)
        self.assertEqual(len(pairs), 2)
        self.assertEqual({pr["chosen"]["source"] for pr in pairs}, {"dpo-exact"})
        self.assertEqual(len({pr["rejected"]["messages"][-1]["think"] for pr in pairs}), 2)  # two different rejected, not one twice
        _, pairs3, _ = run_export(self.screen, {"screen": [p], "sample": [p2, f1, f2, f3]}, failed, p=3)
        self.assertEqual([pr["id"] for pr in pairs3], ["S-p1", "S-p2", "S-p3"])
        self.assertEqual(len({pr["rejected"]["messages"][-1]["think"] for pr in pairs3}), 3)  # all three failures, each once
        self.assertEqual(len({pr["chosen"]["messages"][-1]["think"] for pr in pairs3 if pr["chosen"]["messages"][2]["think"].endswith("way")}), 1)
        self.assertEqual(summary["pairs"], 2)

    def test_no_pair_without_both_sides(self):
        p = run_rec("S", good(1), good(2), good(3))
        f = run_rec("S-s1", good(1), good(2, " wrong"), good(3))
        _, pairs, _ = run_export(self.screen, {"screen": [p], "sample": []}, {})
        self.assertEqual(pairs, [])
        f = run_rec("S", good(1), good(2, " wrong"), good(3))
        _, pairs, _ = run_export(self.screen, {"screen": [f], "sample": [run_rec("S-s2", good(1), good(2, " wrong2"), good(3))]},
                                 {"S": {2}, "S-s2": {2}})
        self.assertEqual(pairs, [])  # two failures

    def test_identical_failing_rollouts_make_one_pair(self):
        p = run_rec("S", good(1), good(2), good(3))
        fs = [run_rec(f"S-s{i}", good(1), good(2, " wrong"), good(3)) for i in (1, 2)]
        _, pairs, _ = run_export(self.screen, {"screen": [p], "sample": fs}, {"S-s1": {2}, "S-s2": {2}})
        self.assertEqual(len(pairs), 1)

    def test_error_steps_chosen_unlabelled_rejected_labelled(self):
        err = step(msg("intent: write u2", "act", verb="create", args="kind: note"), "error: create takes kind", error=True)
        fix = step(msg("retry: rejected", rows="#4"), "answered: ok")
        p = run_rec("S", good(1), turn("u2", err, fix), good(3))
        f = run_rec("S-s1", good(1), turn("u2", step(msg("intent: write u2", "act", verb="create", args="kind: note"), "error: create takes kind", error=True),
                                           step(msg("giving up", rows="#9"), "answered: wrong")), good(3))
        _, pairs, _ = run_export(self.screen, {"screen": [p], "sample": [f]}, {"S-s1": {2}})
        c = [m.get("loss", True) for m in pairs[0]["chosen"]["messages"] if m["role"] == "assistant"]
        r = [m.get("loss", True) for m in pairs[0]["rejected"]["messages"] if m["role"] == "assistant"]
        # the shared first call of turn 2 (an error both times) is context; the chosen's repair is the label, the rejected's reply too
        self.assertEqual(c, [False, False, True])
        self.assertEqual(r, [False, False, True])

    def test_a_rejected_message_that_is_not_a_record_gives_no_pair(self):
        p = run_rec("S", good(1), good(2), good(3))
        f = run_rec("S-s1", good(1), turn("u2", step("I do not know", "error: nothing to call", error=True)), good(3))
        _, pairs, summary = run_export(self.screen, {"screen": [p], "sample": [f]}, {"S-s1": {2}})
        self.assertEqual(pairs, [])
        self.assertEqual(summary["counters"]["pair_skipped_rejected_unparseable"], 1)

    def test_a_divergence_one_side_has_no_step_for_gives_no_pair(self):
        p = run_rec("S", good(1), self.two_step("", "read u2"), good(3))
        short = turn("u2", step(msg("intent: look u2", "find", kind="task"), "found: #4", ends=True))  # the turn ends after the find
        f = run_rec("S-s1", good(1), short, good(3))
        _, pairs, summary = run_export(self.screen, {"screen": [p], "sample": [f]}, {"S-s1": {2}})
        self.assertEqual(pairs, [])
        self.assertEqual(summary["counters"]["pair_skipped_no_label"], 1)

    def test_summary_counts(self):
        screen = [gold("S", 3, "T01", ["a", "i3skill", "S2"]), gold("U", 1, "T02", ["b"]), gold("V", 1, "T02", ["b"])]
        runs = [run_rec("S", good(1), good(2), good(3)), run_rec("U", good(1)), run_rec("V", good(1, " wrong"))]
        samples = [run_rec("S-s1", good(1), good(2, " wrong"), good(3)), run_rec("V-s1", good(1)), run_rec("V-s2", good(1, " w2"))]
        failed = {"S-s1": {2}, "V": {1}, "V-s2": {1}}
        rft, pairs, s = run_export(screen, {"screen": runs, "sample": samples}, failed)
        self.assertEqual((s["sessions_screened"], s["screen_pass"], s["screen_pass_rate"]), (3, 2, 0.6667))
        self.assertEqual((s["sessions_sampled"], s["sample_rollouts"], s["sample_rollouts_passed"]), (2, 3, 1))
        self.assertEqual((s["sessions_with_pass"], s["sessions_with_rft"], s["rft_records"], s["pairs"]), (3, 3, 3, 3))
        self.assertEqual(s["per_world"]["T01"]["rft"], 1)
        self.assertEqual(s["per_world"]["T02"], {"pairs": 2, "rft": 2, "screen_pass": 1, "screened": 2, "with_pass": 2, "with_rft": 2})
        self.assertEqual(s["per_tag"]["i3skill S2"]["pairs"], 1)
        self.assertNotIn("S2", s["per_tag"])
        self.assertEqual(s["per_tag"]["b"]["rft"], 2)


if __name__ == "__main__":
    unittest.main()
