"""Fallback smoke examples, rendered by driving the real runtime over the fixture world.

Used only when the Data agent's files are not there yet. Every observation comes from
`nativetools session` (default `--tools sig`); the assistant steps are hand-written calls with a
short §7-style trace. One example = one whole session in render.py's records (SPEC §11.7):
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
REPO = HERE.parents[3]
BIN = os.environ.get("NATIVETOOLS", str(REPO / "target" / "debug" / "nativetools"))
WORLD = REPO / "crates" / "nativetools" / "tests" / "fixtures" / "world.json"
TODAY, ME = "2026-09-27", "Sam Park"

W = {"unit": "week", "rel": 0}
# (user text, [(think, tool, args)]) — date keys in the generator's canonical order
TURNS = {
    "benedikt": ("what have I got with Benedikt?", [
        ('intent: read rows ("what have I got" = list) · named: "Benedikt"\nkind: task, event · cond: name ~ Benedikt · plan: answer (selector is enough)',
         "answer", {"kind": "task,event", "name": "Benedikt"})]),
    "nextweek": ("what's due next week?", [
        ('intent: read rows · kind: task\ndate: "next week" → week, rel 1 · plan: answer',
         "answer", {"kind": "task", "when": {"unit": "week", "rel": 1}})]),
    "thisweek": ("anything on my calendar this week?", [
        ('intent: read rows ("calendar" = events) · kind: event\ndate: "this week" → week, rel 0 · plan: answer',
         "answer", {"kind": "event", "when": W})]),
    "count": ("how many open tasks do I have?", [
        ('intent: read value ("how many" = count) · kind: task · cond: status = open\nplan: answer op count',
         "answer", {"kind": "task", "op": "count", "where": "status = open"})]),
    "cabin": ("mark the cabin one done", [
        ('intent: write complete ("mark … done" = complete) · not: read · named: "cabin"\nkind: task · plan: act on the selector',
         "act", {"kind": "task", "name": "cabin", "verb": "complete"})]),
    "summer": ("what's in the Summer album?", [
        ('intent: read rows · named: "Summer" = album #4 (directory)\nkind: photo · link: album #4 · plan: look first',
         "find", {"kind": "photo", "linked_to": "#4"}),
        ('intent: read rows · shown: @1 = the Summer photos\nplan: answer @1', "answer", {"rows": "@1"})]),
    "joke": ("tell me a joke", [
        ('intent: outside the vault · plan: decline out_of_scope', "decline", {"reason": "out_of_scope"})]),
    "neha": ("how much does Neha owe me?", [
        ('intent: read value (balance) · named: "Neha" fits two people\nplan: ask which Neha',
         "ask", {"question": "Which Neha: Neha Rao or Neha Kulkarni?"})]),
    "dentist": ("when is the dentist?", [
        ('intent: read rows · named: "dentist"\nkind: event · plan: answer (selector is enough)',
         "answer", {"kind": "event", "name": "Dentist"})]),
    "effort": ("total effort on my tasks?", [
        ('intent: read value ("total" = sum) · kind: task · field: effort\nplan: answer op sum',
         "answer", {"field": "effort", "kind": "task", "op": "sum"})]),
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
    """SPEC §6.1 / render.py: the harness prepends the vault block to the user turn."""
    return (resp["preground"] + "\n\n" + text) if resp.get("preground") else text


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
            for think, tool, args in steps:
                res = rt.req({"op": "call", "tool": tool, "args": args})
                msgs.append({"role": "assistant", "think": think, "tool": tool, "args": args})
                msgs.append({"role": "tool", "content": res["text"], "obs": res["obs"]})
        msgs = msgs[:-1]  # a session ends on the model's last call
        for m in msgs:
            m.pop("obs", None)
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
