"""Readable dump of examples (markdown), for hand review.

usage: python show.py FILE.jsonl.gz [--n 20] [--seed 0] [--grep TEXT] > out.md
"""
from __future__ import annotations

import argparse
import gzip
import json
import random


def fmt_call(m: dict) -> str:
    args = ", ".join(f"{k}={json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v!r}" for k, v in m["args"].items())
    return f"{m['tool']}({args})"


def show(e: dict) -> str:
    out = [f"### {e['id']}  ·  {e['n_turns']} turns  ·  {e['n_tokens']} tok ({e['n_system_tokens']} system)  ·  "
           f"flags {e['flags']}  ·  today {e['today']}"]
    msgs = e["messages"]
    starts = {t["msg_index"]: t for t in e["turns"]}
    for i, m in enumerate(msgs[1:], 1):
        if i in starts:
            t = starts[i]
            out.append(f"#### turn {t['turn']} · {t['family']} · pattern {t['pattern']} · tags {', '.join(t['tags'])}"
                       f" · outcome {t['outcome']}")
        if m["role"] == "user":
            out.append("**USER**: " + m["content"].replace("\n", " ⏎ "))
        elif m["role"] == "assistant":
            out.append("```\n" + (m.get("think") or "") + "\n```")
            out.append("**CALL** `" + fmt_call(m) + "`")
        else:
            txt = m["content"]
            out.append("**OBS**: " + ("\n    " + txt.replace("\n", "\n    ") if "\n" in txt else txt))
    last = e["turns"][-1]["steps"][-1]
    out.append("**OBS (final, not in the sequence)**: " + last["text"].replace("\n", "\n    "))
    return "\n\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--grep", default="")
    a = ap.parse_args()
    exs = [json.loads(l) for l in gzip.open(a.file, "rt")]
    if a.grep:
        exs = [e for e in exs if a.grep in json.dumps(e["turns"], ensure_ascii=False)]
    random.Random(a.seed).shuffle(exs)
    for e in exs[:a.n]:
        print(show(e))
        print("\n---\n")


if __name__ == "__main__":
    main()
