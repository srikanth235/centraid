"""Run a FRONTIER model (Sonnet, via `claude -p`) over the SAME screening set
the local sweep runs on, so the owner gets a comparable row in one table.

    python3 run_frontier.py --screen --arm knn --shots 6 \
        --out out/sonnet-knn --model sonnet

This is a MEASUREMENT of the task's ceiling, not a shippable component.  The
project forbids API LLMs at runtime; this is build-time, like the distillation
corpus.

MIRRORS `experiments/qwen-sanity/run_qwen.py` EXACTLY, except for the model
call.  Same `doctrine.text()` system prompt, same `knn.Index` retrieval, same
`ASK`, same free-running session threading, same raw-first discipline, same
output schema so `score.sh` and `summary.py` read it unchanged.

TWO DIFFERENCES, both irreducible and both reported:

 1. NO GRAMMAR.  The local arms decode under a GBNF grammar compiled from
    `mkschema.py`, so a structurally illegal frame is IMPOSSIBLE for them.
    Sonnet is free running.  A malformed output is a FAILURE and is counted as
    one; nothing is repaired, retried or re-prompted.
 2. THE SCHEMA IS NEVER IN THE PROMPT.  The local models never see it either --
    for them it is a decoding constraint, not prompt text, and the JSON shape
    reaches them through the 6 retrieved examples.  Sonnet gets exactly that.
    Inlining the ~398K-char schema would make the comparison LESS faithful.

RAW FIRST.  Every response is appended to the stream file the instant it
arrives, before anything parses it.  A call that fails is written with its
`error` set and an empty `stageB`.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
QWEN = os.path.normpath(os.path.join(HERE, "..", "qwen-sanity"))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
for path in (QWEN, AFM, HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

import doctrine        # noqa: E402
import mkschema        # noqa: E402
import frame           # noqa: E402  (re-exported paths)
import render_frames   # noqa: E402
import render_guard    # noqa: E402
import knn             # noqa: E402

MAP = os.path.join(mkschema.GRAMMAR, "map.json")

# VERBATIM from run_qwen.py -- do not reword.
ASK = ("Say what this turn MEANS by filling in the form. Use only the options "
       "offered. Copy any name, title or value WORD FOR WORD out of the "
       "sentence above, or out of the previous turn when the person is "
       "refining it. Leave a slot out when the sentence does not say it.")

# The single concession to a chat model with no grammar: a uniformly stripped
# ```json fence.  Applied to every row identically, counted, and reported.
# Anything beyond this is repair and is forbidden.
FENCE = re.compile(r"^\s*```(?:json)?\s*\n(.*?)\n\s*```\s*$", re.S)


def turns(corpora):
    rows = json.load(open(MAP, encoding="utf-8"))["turns"]
    rows = [r for r in rows if r["corpus"] in corpora]
    rows.sort(key=lambda r: (r["corpus"], r["session"], r["turn"]))
    return rows


class Runner:
    def __init__(self, args):
        self.args = args
        # BYTE-IDENTICAL doctrine across every arm and both models; the only
        # variables are the generated grammar block and the retrieved
        # examples.  `vocabblock` is the qwen-sanity lane's generator, imported
        # rather than copied so the two harnesses cannot drift.
        self.doctrine = doctrine.text()
        if getattr(args, "block", "none") != "none":
            import vocabblock
            self.doctrine += "\n\n" + vocabblock.block(args.block)
        # ONE fact, derived at runtime from the same corpus file the scorer
        # reads.  Appended last and unadorned so the arm differs from its
        # baseline by exactly this sentence and nothing else.
        if getattr(args, "date", False):
            import datefact
            self.doctrine += "\n\n" + datefact.line(args.date_corpora)
        self.lock = threading.Lock()
        self.stream = open(args.stream, "a", encoding="utf-8")
        self.rows = []
        self.shots = None
        if args.arm == "knn":
            self.shots = knn.Index(args.shots)

    def write(self, row):
        with self.lock:
            self.stream.write(json.dumps(row) + "\n")
            self.stream.flush()
            self.rows.append(row)

    def user_message(self, previous, request):
        """Byte-for-byte run_qwen.Runner.user_message."""
        head = ""
        if self.shots is not None:
            examples = self.shots.nearest(request)
            if examples:
                lines = ["Here are examples of other sentences and the form "
                         "filled in for them. They are examples only; answer "
                         "about the sentence at the end."]
                for ex_request, ex_frame in examples:
                    lines.append("")
                    lines.append("The person says: %s" % ex_request)
                    lines.append("The form: %s"
                                 % json.dumps(ex_frame, sort_keys=True))
                head = "\n".join(lines) + "\n\n"
        return "%sPrevious turn: %s\nThe person says: %s\n\n%s" % (
            head, previous or "NONE", request, ASK)

    def call(self, user):
        """One `claude -p` call.  Returns (text, usage, error).

        Every flag here exists to make this as close to a bare model call as
        the CLI allows: no MCP servers, no project/user settings, no
        CLAUDE.md discovery (cwd is a scratch dir), no tools, no skills, and
        `--system-prompt` REPLACES the agent preamble with the doctrine.
        """
        cmd = [
            self.args.claude, "-p", user,
            "--model", self.args.model,
            "--system-prompt", self.doctrine,
            "--restricted",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--setting-sources", "",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--tools", "",
            "--output-format", "json",
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=self.args.timeout, cwd=self.args.cwd)
        except subprocess.TimeoutExpired:
            return "", {}, "timeout after %ss" % self.args.timeout
        if proc.returncode != 0:
            return "", {}, "exit %d: %s" % (proc.returncode,
                                            (proc.stderr or "")[:400])
        try:
            reply = json.loads(proc.stdout)
        except Exception as exc:
            return "", {}, "cli json: %s: %s" % (exc, proc.stdout[:300])
        if reply.get("is_error") or reply.get("subtype") != "success":
            return "", reply.get("usage") or {}, "cli error: %s" % \
                str(reply.get("result"))[:400]
        return (reply.get("result") or ""), reply, ""

    def one(self, row, previous):
        user = self.user_message(previous, row["request"])
        started = time.time()
        out = {"corpus": row["corpus"], "session": row["session"],
               "turn": row["turn"], "mode": "free",
               "model": self.args.model_name, "request": row["request"],
               "prev_used": previous or "NONE", "stageA": "", "stageB": "",
               "error": "", "ms_a": 0, "ms_b": 0, "ms": 0,
               "prompt_n": 0, "predicted_n": 0, "arm": self.args.arm}
        text, reply, error = self.call(user)
        # RAW, before anything touches it.
        out["raw_text"] = text
        out["fenced"] = False
        if error:
            out["error"] = error
        else:
            stripped = text
            match = FENCE.match(text)
            if match:
                stripped = match.group(1)
                out["fenced"] = True
            out["stageB"] = stripped
            if not stripped.strip():
                out["error"] = "empty content"
            usage = (reply.get("usage") or {}) if isinstance(reply, dict) else {}
            out["prompt_n"] = (usage.get("input_tokens", 0)
                               + usage.get("cache_creation_input_tokens", 0)
                               + usage.get("cache_read_input_tokens", 0))
            out["predicted_n"] = usage.get("output_tokens", 0)
            out["cost_usd"] = reply.get("total_cost_usd", 0.0)
            out["ms_a"] = round(reply.get("ttft_ms", 0) or 0, 1)
            out["ms_b"] = round((reply.get("duration_api_ms", 0) or 0)
                                - (reply.get("ttft_ms", 0) or 0), 1)
        out["ms"] = round(1000.0 * (time.time() - started), 1)
        self.write(out)
        return out

    def session(self, rows):
        """One session, strictly in order, threading its OWN output forward."""
        said, previous = [], "NONE"
        for row in rows:
            out = self.one(row, previous)
            haystack = " ".join(said + [row["request"]])
            if out["error"]:
                canonical = ""
            else:
                canonical, _reason = render_guard.render_one(out["stageB"],
                                                             haystack)
            said.append(row["request"])
            said.append(canonical)
            previous = canonical or "NONE"

    def run(self, rows):
        sessions = {}
        for row in rows:
            sessions.setdefault((row["corpus"], row["session"]), []).append(row)
        work = queue.Queue()
        for key in sorted(sessions):
            work.put(sessions[key])
        total = len(rows)
        started = time.time()
        done = [0]

        def worker():
            while True:
                try:
                    batch = work.get_nowait()
                except queue.Empty:
                    return
                self.session(batch)
                with self.lock:
                    done[0] += len(batch)
                    n = done[0]
                print("%d/%d  %.0fs" % (n, total, time.time() - started),
                      flush=True)

        threads = [threading.Thread(target=worker)
                   for _ in range(self.args.slots)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        print("%d/%d  %.0fs" % (done[0], total, time.time() - started))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="all")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "sonnet"))
    ap.add_argument("--stream", default=None)
    ap.add_argument("--arm", choices=["zero", "knn"], default="knn")
    ap.add_argument("--shots", type=int, default=6)
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--sessions", type=int)
    ap.add_argument("--only", help="corpus:session -- re-run ONE session "
                    "WHOLE, in order, after a harness (not model) failure")
    import vocabblock  # noqa: E402  -- the qwen-sanity lane owns the blocks
    ap.add_argument("--block", default="none",
                    choices=list(vocabblock.BLOCKS),
                    help="which GENERATED grammar block to prepend, as in "
                         "run_qwen.py --block. `full` is `spec` plus every "
                         "name behind the `one of N` counts. Derived from the "
                         "grammar, never from anything a model was observed "
                         "to get wrong.")
    ap.add_argument("--date", action="store_true",
                    help="state the corpus's own `today` (and its weekday) in "
                         "the prompt, read at runtime from "
                         "crates/evalsuite/<corpus>.json. The corpora are "
                         "anchored to 2026-06-15 and no prompt has ever said "
                         "so; a quarter of the sessions in every corpus turn "
                         "on it.")
    ap.add_argument("--dev15", action="store_true",
                    help="DEV-15: dev10 plus one session each for correction, "
                         "reference_into_result, undo, write_only and "
                         "write_set. Proven disjoint from screen90.")
    ap.add_argument("--dev", action="store_true",
                    help="the DEV-10 tuning sessions, proven disjoint from "
                         "screen90")
    ap.add_argument("--screen", action="store_true",
                    help="only the 90 sessions in screen90.json -- the same "
                         "set for every model, or the comparison is void")
    ap.add_argument("--claude", default="claude")
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--cwd", default="/tmp", help="a neutral cwd, so no "
                    "CLAUDE.md is discovered and injected")
    ap.add_argument("--model-name", default="claude-sonnet (frontier probe)")
    args = ap.parse_args()

    corpora = ({"suite", "blind", "holdout"} if args.corpus == "all"
               else set(args.corpus.split(",")))
    args.date_corpora = sorted(corpora)
    rows = turns(corpora)
    if args.screen or args.dev or args.dev15:
        import make_screen
        if args.dev15:
            wanted = make_screen.dev15_keys()
        elif args.dev:
            wanted = make_screen.dev_keys()
        else:
            wanted = make_screen.keys()
        rows = [r for r in rows if (r["corpus"], r["session"]) in wanted]
    if args.sessions:
        keep = set()
        for corpus in sorted(corpora):
            names = sorted({r["session"] for r in rows if r["corpus"] == corpus})
            keep |= {(corpus, name) for name in names[:args.sessions]}
        rows = [r for r in rows if (r["corpus"], r["session"]) in keep]
    if args.only:
        corpus, session = args.only.split(":", 1)
        rows = [r for r in rows
                if r["corpus"] == corpus and r["session"] == session]
    if args.limit:
        rows = rows[:args.limit]
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    os.makedirs(args.cwd, exist_ok=True)
    if args.stream is None:
        args.stream = "%s.stream-%s.jsonl" % (args.out, args.arm)
    print("turns %d over %d sessions" % (
        len(rows), len({(r["corpus"], r["session"]) for r in rows})))
    runner = Runner(args)
    runner.run(rows)

    by_corpus = {}
    for row in runner.rows:
        by_corpus.setdefault(row["corpus"], []).append(row)
    for corpus, got in sorted(by_corpus.items()):
        got.sort(key=lambda r: (r["session"], r["turn"]))
        path = "%s-%s.jsonl" % (args.out, corpus)
        with open(path, "w", encoding="utf-8") as fh:
            for row in got:
                fh.write(json.dumps(row) + "\n")
        print("wrote %d -> %s" % (len(got), path))
    fenced = sum(1 for r in runner.rows if r.get("fenced"))
    cost = sum(r.get("cost_usd", 0.0) for r in runner.rows)
    print("code-fence stripped on %d/%d rows" % (fenced, len(runner.rows)))
    print("cost  $%.2f" % cost)
    return 0


if __name__ == "__main__":
    sys.exit(main())
