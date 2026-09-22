"""Run a Qwen-class decoder over the evaluation corpora under a JSON grammar.

    python3 run_qwen.py --corpus all --out out/raw --arm zero
    python3 run_qwen.py --corpus all --out out/raw --arm knn --shots 6

The model is served by `llama-server` (CPU) and constrained by the JSON schema
`mkschema.py` derives from `frame.py`, so a malformed frame is impossible by
construction.  The instruction block is the SAME generated `Doctrine.swift`
text the Apple spike uses.

FREE RUNNING.  The previous turn handed to the model is the harness's OWN
rendered canonical, never gold -- `infer.py`'s and the Apple spike's `--mode
free`.  Sessions are independent, so they run across the server's slots; the
turns WITHIN a session are strictly sequential.

RAW FIRST.  Every model response is appended to a stream file the instant it
arrives, before anything parses it, and the per-corpus `raw-<corpus>.jsonl` is
that stream sorted.  A request that fails is written with its `error` set and
an empty `stageB`; nothing is retried, repaired or dropped.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
for path in (HERE, AFM):
    if path not in sys.path:
        sys.path.insert(0, path)

import doctrine        # noqa: E402
import mkschema        # noqa: E402
import frame           # noqa: E402
import render_frames   # noqa: E402
import knn             # noqa: E402

MAP = os.path.join(mkschema.GRAMMAR, "map.json")
ENDPOINT = "http://127.0.0.1:8080/v1/chat/completions"

# The Apple spike's Stage-B wording, minus the head and kind Stage A would
# have named -- this lane asks for the whole frame in one generation.
ASK = ("Say what this turn MEANS by filling in the form. Use only the options "
       "offered. Copy any name, title or value WORD FOR WORD out of the "
       "sentence above, or out of the previous turn when the person is "
       "refining it. Leave a slot out when the sentence does not say it.")


def turns(corpora):
    rows = json.load(open(MAP, encoding="utf-8"))["turns"]
    rows = [r for r in rows if r["corpus"] in corpora]
    rows.sort(key=lambda r: (r["corpus"], r["session"], r["turn"]))
    return rows


def post(body, timeout):
    req = urllib.request.Request(
        ENDPOINT, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as fh:
        return json.load(fh)


class Runner:
    def __init__(self, args):
        self.args = args
        self.schema = mkschema.schema()
        self.doctrine = doctrine.text()
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

    def one(self, row, previous, slot):
        user = self.user_message(previous, row["request"])
        body = {
            "messages": [{"role": "system", "content": self.doctrine},
                         {"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "frame", "schema": self.schema, "strict": True}},
            "temperature": 0, "top_k": 1, "max_tokens": self.args.max_tokens,
            "chat_template_kwargs": {"enable_thinking": False},
            "cache_prompt": True, "id_slot": slot,
        }
        started = time.time()
        out = {"corpus": row["corpus"], "session": row["session"],
               "turn": row["turn"], "mode": "free",
               "model": self.args.model_name, "request": row["request"],
               "prev_used": previous or "NONE", "stageA": "", "stageB": "",
               "error": "", "ms_a": 0, "ms_b": 0, "ms": 0,
               "prompt_n": 0, "predicted_n": 0, "arm": self.args.arm}
        try:
            reply = post(body, self.args.timeout)
            message = reply["choices"][0]["message"]
            out["stageB"] = message.get("content") or ""
            if not out["stageB"]:
                out["error"] = "empty content (finish_reason=%s)" % \
                    reply["choices"][0].get("finish_reason")
            timings = reply.get("timings") or {}
            out["ms_a"] = round(timings.get("prompt_ms", 0.0), 1)
            out["ms_b"] = round(timings.get("predicted_ms", 0.0), 1)
            out["prompt_n"] = timings.get("prompt_n", 0)
            out["predicted_n"] = timings.get("predicted_n", 0)
            out["cache_n"] = timings.get("cache_n", 0)
        except urllib.error.HTTPError as exc:
            out["error"] = "http %s: %s" % (exc.code,
                                            exc.read()[:400].decode("utf-8", "replace"))
        except Exception as exc:  # a transport failure is a FAILED turn
            out["error"] = "%s: %s" % (type(exc).__name__, exc)
        out["ms"] = round(1000.0 * (time.time() - started), 1)
        self.write(out)
        return out

    def session(self, rows, slot):
        """One session, strictly in order, threading its OWN output forward."""
        said, previous = [], "NONE"
        for row in rows:
            out = self.one(row, previous, slot)
            haystack = " ".join(said + [row["request"]])
            if out["error"]:
                canonical = ""
            else:
                canonical, _reason = render_frames.render_one(out["stageB"],
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

        def worker(slot):
            while True:
                try:
                    batch = work.get_nowait()
                except queue.Empty:
                    return
                self.session(batch, slot)
                with self.lock:
                    done[0] += len(batch)
                    n = done[0]
                if n % 25 < len(batch):
                    print("%d/%d  %.0fs" % (n, total, time.time() - started),
                          flush=True)

        threads = [threading.Thread(target=worker, args=(i,))
                   for i in range(self.args.slots)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        print("%d/%d  %.0fs" % (done[0], total, time.time() - started))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="all")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "raw"))
    ap.add_argument("--stream", default=None)
    ap.add_argument("--arm", choices=["zero", "knn"], default="zero")
    ap.add_argument("--shots", type=int, default=6)
    ap.add_argument("--slots", type=int, default=4)
    ap.add_argument("--max-tokens", type=int, default=512)
    ap.add_argument("--timeout", type=int, default=1800)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--model-name", default="qwen3.5-2b-q4_k_m")
    args = ap.parse_args()

    corpora = ({"suite", "blind", "holdout"} if args.corpus == "all"
               else set(args.corpus.split(",")))
    rows = turns(corpora)
    if args.limit:
        rows = rows[:args.limit]
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    if args.stream is None:
        args.stream = "%s.stream-%s.jsonl" % (args.out, args.arm)
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
