"""Fallback smoke examples, rendered by driving the real runtime over the fixture world.

Used only when no data file is given. Every observation comes from `nativetools session`
(default `--tools sig`); the assistant steps are hand-written calls, and each think is the slot trace
of CONTRACT_V3.md derived from its call and the context in front of it (authored/trace.py), the way
authored/build.py writes it. One example = one whole session in render.py's records (SPEC §11.7):
system (with tools), user (vault block prepended), assistant {think, tool, args}, tool
(compacted as the harness shows it on later turns).

    python smoke_data.py <out.jsonl.gz> [--n 20]
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fmt  # noqa: E402  (the shared renderer, and the loader of authored/trace.py)

REPO = HERE.parents[3]
BIN = os.environ.get("NATIVETOOLS", str(REPO / "target" / "debug" / "nativetools"))
WORLD = REPO / "crates" / "nativetools" / "tests" / "fixtures" / "world.json"
TODAY, ME = "2026-09-27", "Sam Park"

W = '{"unit":"week","rel":0}'
# (user text, [(tool, args)]): the calls as the runtime reads them (every value a string, a date as compact JSON in the
# authored key order)
TURNS = {
    "benedikt": ("what have I got with Benedikt?", [
        ("answer", {"kind": "task,event", "name": "Benedikt"})]),
    "nextweek": ("what's due next week?", [
        ("answer", {"kind": "task", "when": '{"unit":"week","rel":1}'})]),
    "thisweek": ("anything on my calendar this week?", [
        ("answer", {"kind": "event", "when": W})]),
    "count": ("how many open tasks do I have?", [
        ("answer", {"kind": "task", "op": "count", "where": "status = open"})]),
    "cabin": ("mark the cabin one done", [
        ("act", {"verb": "complete", "kind": "task", "name": "cabin"})]),
    "summer": ("what's in the Summer album?", [
        ("find", {"kind": "photo", "linked_to": "#4"}),
        ("answer", {"rows": "@1"})]),
    "joke": ("tell me a joke", [
        ("decline", {"reason": "out_of_scope"})]),
    "neha": ("how much does Neha owe me?", [
        ("ask", {"question": "Which Neha: Neha Rao or Neha Kulkarni?"})]),
    "dentist": ("when is the dentist?", [
        ("answer", {"kind": "event", "name": "Dentist"})]),
    "effort": ("total effort on my tasks?", [
        ("answer", {"op": "sum", "field": "effort", "kind": "task"})]),
}
# sessions: 1–3 turns each, so compaction and kept thinking on follow-ups are covered
PLAN = [[k] for k in TURNS] + [
    ["benedikt", "nextweek"], ["summer", "count"], ["thisweek", "cabin"], ["count", "summer"],
    ["dentist", "benedikt", "effort"], ["joke", "neha"], ["nextweek", "dentist"],
    ["effort", "thisweek"], ["summer", "cabin", "joke"], ["neha", "summer"],
]


class Rt:
    def __init__(self, vault):
        self.p = subprocess.Popen([BIN, "session", str(vault), "--today", TODAY, "--me", ME],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def req(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def close(self):
        self.p.stdin.close()
        self.p.wait()


def user_content(resp, text):
    """SPEC §6.1 / render.py: the harness prepends the block (vault, focus and dates lines) to the user turn."""
    block = resp.get("block")
    return (block + "\n\n" + text) if block else text


def session_example(vault, keys):
    rt = Rt(vault)
    try:
        p = rt.req({"op": "prompt"})
        msgs = [{"role": "system", "content": p["system"], "tools": p["tools"]}]
        for key in keys:
            text, steps = TURNS[key]
            r = rt.req({"op": "user", "text": text})
            by_obs = {c["obs"]: c["text"] for c in r.get("compacted", [])}
            for m in msgs:
                if m.get("obs") in by_obs:
                    m["content"] = by_obs[m["obs"]]
            msgs.append({"role": "user", "content": user_content(r, text)})
            for tool, args in steps:
                res = rt.req({"op": "call_text", "text": fmt.render.call_text(tool, args)})
                msgs.append({"role": "assistant", "think": "", "tool": tool, "args": args})
                msgs.append({"role": "tool", "content": res["text"], "obs": res["obs"]})
        msgs = msgs[:-1]  # a session ends on the model's last call
        for m in msgs:
            m.pop("obs", None)
        # the think of every call, from the context in front of it; the call is rewritten in the call order, and the
        # decoder's rendering of the think must be the call
        T = fmt.trace3()
        for i, tr in T.trace_messages3(msgs, TODAY).items():
            m = msgs[i]
            m["think"] = T.render3(tr.slots)
            m["args"] = T.canon_call({"tool": m["tool"], "args": m["args"]})["args"]
            assert fmt.call_of_think(m["think"], None, "v3.1") == fmt.render.call_text(m["tool"], m["args"]), m["think"]
        return {"id": "smoke-" + "+".join(keys), "messages": msgs}
    finally:
        rt.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--n", type=int, default=20)
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as d:
        base = Path(d) / "base.db"
        subprocess.run([BIN, "seed", str(WORLD), str(base)], check=True, capture_output=True)
        out = []
        for i, keys in enumerate(PLAN[:a.n]):
            v = Path(d) / ("v%d.db" % i)
            subprocess.run([BIN, "copy", str(base), str(v)], check=True, capture_output=True)
            out.append(session_example(v, keys))
    with gzip.open(a.out, "wt") as fh:
        for ex in out:
            fh.write(json.dumps(ex, ensure_ascii=False) + "\n")
    print("wrote %d sessions to %s" % (len(out), a.out), file=sys.stderr)


if __name__ == "__main__":
    main()
