"""Emit the CANONICAL GRAMMAR -- the language the executor already speaks.

    python3 run_canon.py --out out/sonnet-canon --model sonnet
    ./canon_score.sh out/sonnet-canon

Three output formats have now been asked of a model for the same 434 turns:

    SQL over 34 tables          ~60 tokens   the two-tool probe
    the flat JSON frame         ~39 tokens   the frame probe
    the canonical string        ~12 tokens   this

    show (tasks that (due_at during 2026-06-17 and status != "completed"))

The canonical is a THIRD the size of the frame and reads as English, and it is
what `crates/candidates`'s `run-model` already executes, so this is scored by
the same binary as every earlier number with nothing new in the scoring path.
The rules-and-kNN baseline emits this same language at 44.2% / 56.7% / 39.7%,
so for the first time a model and the baseline are being asked for the same
thing.

TWO THINGS DIFFER from the frame probe, and the comparison is not single
variable because of it:

 1. the OUTPUT LANGUAGE is the canonical, not the JSON frame;
 2. the model sees the WHOLE session so far -- every question and its own
    every answer -- where the frame probe passed one previous canonical and
    dropped the person's words. 14 of the 29 dev-15 turns are follow-ups, and
    "and Ray?" cannot be read without the turn that set the subject.

Both are changes the evidence already argued for; running them separately
would cost two runs to learn what one teaches. If this beats the frame probe,
which of the two did it is a further experiment, not a claim made here.

DISCIPLINE unchanged: free-running (the model's own canonical threads forward,
never gold), raw text written before anything parses it, and a malformed or
empty reply is a FAILURE that is counted and never repaired or retried.
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
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
EVAL = os.path.join(REPO, "crates", "evalsuite")
GRAMMAR_MD = os.path.join(EVAL, "grammar", "GRAMMAR.md")
QWEN = os.path.join(REPO, "experiments", "qwen-sanity")
for path in (QWEN, os.path.join(REPO, "experiments", "afm-spike")):
    if path not in sys.path:
        sys.path.insert(0, path)

FENCE = re.compile(r"^\s*```[a-z]*\s*\n(.*?)\n\s*```\s*$", re.S)


def vocabulary():
    """The terminals, from the schema the grammar generates -- not retyped."""
    import mkschema
    s = mkschema.schema()
    d = s["$defs"]
    kinds = d["set1"]["anyOf"][0]["properties"]["kind"]["enum"]
    fields = d["value"]["anyOf"][1]["properties"]["field"]["enum"]
    verbs = d["cmd"]["properties"]["verb"]["enum"]
    return ("THE TERMINALS\n\n"
            "Kind -- one of these %d, exactly as spelled:\n  %s\n\n"
            "Field -- one of these %d:\n  %s\n\n"
            "Cmd verb -- one of these %d:\n  %s\n"
            % (len(kinds), ", ".join(kinds),
               len(fields), ", ".join(fields),
               len(verbs), ", ".join(verbs)))


def gbnf_block():
    """The compiled grammar itself (gbnf.py), in place of the terminal list:
    it carries every terminal AND the syntax, where the list carried only
    the terminals."""
    import gbnf
    return ("THE SYNTAX, as a GBNF grammar compiled from the parser the "
            "executor uses. Your line must match rule `root` exactly -- one "
            "space between words, lower case, strings in double quotes.\n\n"
            + gbnf.emit(gbnf.rules()))


def system_text(corpus, use_gbnf=False):
    import datetime
    with open(os.path.join(EVAL, "%s.json" % corpus), encoding="utf-8") as fh:
        today = json.load(fh)["today"]
    day = datetime.date.fromisoformat(today)
    with open(GRAMMAR_MD, encoding="utf-8") as fh:
        grammar = fh.read()
    return """\
You turn what a person says to their own vault into ONE line of a formal
language. That line is executed as written. You never write SQL and never name
a table: the language below is the whole of what you may say.

TODAY IS %s %s. Every relative date -- "friday", "tomorrow", "the 21st",
"last week" -- resolves against that date and no other calendar.

Reply with the canonical line ALONE. No explanation, no code fence, no
preamble. Examples of well-formed lines:

  show (events during tomorrow)
  show (tasks that (due_at during 2026-06-17 and status != "completed"))
  sum amount_minor of (expenses of (groups called "Tahoe Trip"))
  reschedule{to: 2026-06-19} on (it)
  refuse: out_of_ontology
  nothing

%s

THE GRAMMAR, in full. It is the specification, and where it states a rule
about what a turn MEANS -- which door a Kind is reached through, what "due"
carries, what a Ref points at -- that rule is binding.

%s
""" % (day.strftime("%A"), today,
       gbnf_block() if use_gbnf else vocabulary(), grammar)


class Runner:
    def __init__(self, args):
        self.args = args
        self.system = system_text(args.corpus, args.gbnf)
        self.recognizer = None
        if args.gbnf:
            import gbnf
            self.recognizer = gbnf.Recognizer(gbnf.rules())
        self.lock = threading.Lock()
        self.stream = open(args.stream, "a", encoding="utf-8")
        self.rows = []

    def write_row(self, row):
        with self.lock:
            self.stream.write(json.dumps(row) + "\n")
            self.stream.flush()
            self.rows.append(row)

    def call(self, user):
        if self.args.backend == "llama":
            return self.call_llama(user)
        cmd = [self.args.claude, "-p", user,
               "--model", self.args.model,
               "--system-prompt", self.system,
               "--restricted", "--strict-mcp-config",
               "--mcp-config", '{"mcpServers":{}}',
               "--setting-sources", "", "--disable-slash-commands",
               "--no-session-persistence", "--tools", "",
               "--output-format", "json"]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=self.args.timeout, cwd=self.args.cwd)
        except subprocess.TimeoutExpired:
            return "", {}, "timeout"
        if proc.returncode != 0:
            return "", {}, "exit %d" % proc.returncode
        try:
            reply = json.loads(proc.stdout)
        except Exception as exc:
            return "", {}, "cli json: %s" % exc
        if reply.get("is_error") or reply.get("subtype") != "success":
            return "", reply.get("usage") or {}, "cli error"
        return (reply.get("result") or ""), (reply.get("usage") or {}), ""

    def call_llama(self, user):
        """A local llama-server decoding UNDER the compiled GBNF: the model
        cannot produce a line outside the grammar except by running out of
        tokens, and a truncated line fails the recognizer like any other."""
        import urllib.request
        import gbnf
        body = json.dumps({
            "messages": [{"role": "system", "content": self.system},
                         {"role": "user", "content": user}],
            "temperature": 0, "top_k": 1, "cache_prompt": True,
            "n_predict": self.args.predict,
            "reasoning_effort": "none",
            "chat_template_kwargs": {"enable_thinking": False},
            "grammar": gbnf.emit(gbnf.rules()),
        }).encode("utf-8")
        req = urllib.request.Request(
            "%s/v1/chat/completions" % self.args.server.rstrip("/"),
            data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.args.timeout) as fh:
                reply = json.loads(fh.read().decode("utf-8"))
            choice = reply["choices"][0]
        except Exception as exc:
            return "", {}, "llama: %s" % exc
        text = (choice.get("message") or {}).get("content") or ""
        return text, (reply.get("usage") or {}), ""

    def session(self, corpus, session, turns):
        history = []
        for index, request in enumerate(turns):
            lines = list(history)
            lines.append("The person says: %s" % request)
            lines.append("")
            lines.append("The canonical line for THIS turn:")
            started = time.time()
            text, usage, err = self.call("\n".join(lines))
            # RAW FIRST, before anything parses it
            self.write_row({"kind": "raw", "corpus": corpus,
                            "session": session, "turn": str(index),
                            "request": request, "raw_text": text,
                            "error": err, "usage": usage})
            canonical = ""
            if not err:
                body = text.strip()
                fenced = FENCE.match(body)
                if fenced:
                    body = fenced.group(1).strip()
                # one line, the first non-empty one; anything more is the
                # model ignoring the instruction and is recorded as given
                canonical = next((ln.strip() for ln in body.split("\n")
                                  if ln.strip()), "")
            # Under --gbnf a line outside the grammar is a FAILURE: recorded
            # as given in the raw row above, and never repaired.
            valid = None
            if self.recognizer is not None:
                valid = bool(canonical) and self.recognizer.full(canonical)
                if not valid:
                    canonical = ""
            self.write_row({"kind": "turn", "gbnf_valid": valid, "corpus": corpus,
                            "session": session, "turn": str(index),
                            "request": request, "canonical": canonical,
                            "prev_used": history[-1] if history else "NONE",
                            "mode": "canon", "model": self.args.model_name,
                            "error": err,
                            "ms": round(1000.0 * (time.time() - started), 1)})
            history.append("The person says: %s" % request)
            history.append("You answered: %s" % (canonical or "(nothing)"))

    def run(self, items):
        work = queue.Queue()
        for item in items:
            work.put(item)
        total = sum(len(t) for _, _, t in items)
        done, started = [0], time.time()

        def worker():
            while True:
                try:
                    corpus, session, turns = work.get_nowait()
                except queue.Empty:
                    return
                self.session(corpus, session, turns)
                with self.lock:
                    done[0] += len(turns)
                    print("%d/%d  %.0fs" % (done[0], total,
                                            time.time() - started))

        threads = [threading.Thread(target=worker)
                   for _ in range(self.args.slots)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="suite")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "canon"))
    ap.add_argument("--stream", default=None)
    ap.add_argument("--sessions", default=None)
    ap.add_argument("--slots", type=int, default=5)
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--claude", default="claude")
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--model-name", default="claude-sonnet (canonical)")
    ap.add_argument("--cwd", default="/tmp")
    ap.add_argument("--backend", default="claude", choices=("claude", "llama"))
    ap.add_argument("--server", default="http://127.0.0.1:8080")
    ap.add_argument("--predict", type=int, default=160)
    ap.add_argument("--gbnf", action="store_true",
                    help="put the compiled GBNF in the prompt and fail any "
                         "reply that does not match it")
    args = ap.parse_args()

    if args.sessions:
        want = set(args.sessions.split(","))
    else:
        want = set(json.load(open(os.path.join(QWEN, "dev15.json"),
                                  encoding="utf-8"))["sessions"]["suite"])
    with open(os.path.join(EVAL, "%s.json" % args.corpus), encoding="utf-8") as fh:
        corpus = json.load(fh)
    items = [(args.corpus, s["id"], [t["request"] for t in s["turns"]])
             for s in corpus["sessions"] if s["id"] in want]

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    if args.stream is None:
        args.stream = "%s.stream.jsonl" % args.out
    runner = Runner(args)
    print("%d sessions, %d turns, system prompt %d chars"
          % (len(items), sum(len(t) for _, _, t in items), len(runner.system)))
    runner.run(items)
    # the shape `run-model` reads
    with open("%s-scored.jsonl" % args.out, "w", encoding="utf-8") as fh:
        for row in runner.rows:
            if row.get("kind") == "turn":
                out = {k: v for k, v in row.items()
                       if k in ("canonical", "corpus", "mode", "model",
                                "prev_used", "request", "session", "turn")}
                out["turn"] = int(out["turn"])   # run-model wants a number
                fh.write(json.dumps(out) + "\n")
    print("wrote %s-scored.jsonl" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
