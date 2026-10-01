"""Run a Qwen-class decoder over the evaluation corpora under a JSON grammar.

    python3 run_qwen.py --corpus all --out out/raw --arm zero
    python3 run_qwen.py --corpus all --out out/raw --arm knn --shots 6

The model is served by `llama-server` (CPU) and constrained by the JSON schema
`mkschema.py` derives from `frame.py`.  That makes a STRUCTURALLY malformed
frame impossible -- wrong key, invented enum member, missing required slot,
wrong arity -- and NOT a badly shaped string: llama.cpp's schema-to-GBNF
converter silently ignores `pattern`, which `grammar_probe.py` demonstrates in
one generation.  The instruction block is the SAME generated `Doctrine.swift`
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
import vocabblock     # noqa: E402

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


def slot_context():
    """The per-slot context, READ FROM THE SERVER, not inferred from `-c`.

    llama.cpp DIVIDES the `-c` total across `-np` slots, so `-c 16384 -np 4`
    gives each turn 4096 tokens, not 16384.  The flag and the reality differ
    by the slot count, which is exactly how a silent truncation hides: an
    over-long prompt would be cut and its answer scored as a model failure.
    """
    try:
        with urllib.request.urlopen(
                ENDPOINT.replace("/v1/chat/completions", "/props"),
                timeout=60) as fh:
            props = json.load(fh)
        return int((props.get("default_generation_settings") or {}).get("n_ctx")
                   or 0)
    except Exception:
        return 0


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
        # The doctrine text is BYTE-IDENTICAL across every arm; the only
        # variables are the vocabulary block and the retrieved examples.
        self.doctrine = doctrine.text()
        if args.block != "none":
            self.doctrine += "\n\n" + vocabblock.block(args.block)
        self.n_ctx = slot_context()
        self.lock = threading.Lock()
        self.empty = 0
        self.empty_length = 0
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

    def note_empty(self, finish):
        """ABORT rather than report a silent zero.

        A thinking-capable model streams its reasoning into
        `reasoning_content`, which the JSON grammar does not constrain.  If
        thinking is not actually off it spends the whole token budget there
        and returns `content: ""` with `finish_reason: "length"` -- every
        turn, and every one of them a legitimate failure by this harness's own
        rules and a worthless measurement.  A near-zero score with empty
        outputs is the dangerous outcome because it looks like a result, so a
        run that hits it dies loudly instead.
        """
        with self.lock:
            self.empty += 1
            self.empty_length += 1 if finish == "length" else 0
            seen, empties, truncated = len(self.rows), self.empty, self.empty_length
        if seen >= 12 and empties > 0.25 * seen and truncated >= empties / 2:
            sys.stderr.write(
                "\nABORTING: %d of the first %d turns returned an EMPTY "
                "content, %d of them cut off at the token cap.\nThis is "
                "almost always a THINKING model whose reasoning is not off: "
                "it fills `reasoning_content`,\nwhich the grammar does not "
                "constrain, and never reaches the JSON. `enable_thinking: "
                "false` is\nQwen-specific and Gemma ignores it; "
                "`reasoning_effort: \"none\"` is llama.cpp's generic switch "
                "and works\nfor both. Fix the request, do not report this "
                "run.\n")
            self.stream.flush()
            os._exit(2)

    def check_context(self, out):
        """A prompt that will not fit is a HARNESS failure, not a model one."""
        if not self.n_ctx:
            return
        needed = out["cache_n"] + out["prompt_n"] + self.args.max_tokens
        if needed <= self.n_ctx:
            return
        sys.stderr.write(
            "\nABORTING: %s/%s t%s needs %d tokens (%d cached + %d new + %d "
            "to generate) and the\nslot holds %d. llama.cpp divides -c across "
            "-np slots, so the per-slot budget is\n-c/-np, not -c. Raise -c "
            "or lower -np and re-run; a truncated prompt would be\nscored as "
            "a model failure.\n"
            % (out["corpus"], out["session"], out["turn"], needed,
               out["cache_n"], out["prompt_n"], self.args.max_tokens,
               self.n_ctx))
        self.stream.flush()
        os._exit(3)

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
            # THINKING OFF, BOTH WAYS, because one way is not enough.
            # Qwen honours `enable_thinking`; Gemma 4 E2B does not and instead
            # streams its reasoning into `reasoning_content`, where the grammar
            # does not apply -- so it spends the whole token budget thinking
            # and returns an EMPTY `content`, which this harness would score as
            # 145 failed turns. `reasoning_effort: "none"` is llama.cpp's own
            # switch and turns it off for both.
            "chat_template_kwargs": {"enable_thinking": False},
            "reasoning_effort": "none",
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
            finish = reply["choices"][0].get("finish_reason")
            if not out["stageB"]:
                out["error"] = "empty content (finish_reason=%s, " \
                    "reasoning_content=%d chars)" % (
                        finish, len(message.get("reasoning_content") or ""))
                self.note_empty(finish)
            timings = reply.get("timings") or {}
            out["ms_a"] = round(timings.get("prompt_ms", 0.0), 1)
            out["ms_b"] = round(timings.get("predicted_ms", 0.0), 1)
            out["prompt_n"] = timings.get("prompt_n", 0)
            out["predicted_n"] = timings.get("predicted_n", 0)
            out["cache_n"] = timings.get("cache_n", 0)
            self.check_context(out)
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
    ap.add_argument("--limit", type=int, help="the first N turns, for a smoke")
    ap.add_argument("--sessions", type=int,
                    help="the first N SESSIONS OF EACH CORPUS, whole -- the "
                         "subset shape a slow model is probed on. A session "
                         "is never cut in half, because a follow-up turn "
                         "without its opening turn is a different question.")
    ap.add_argument("--block", default="none",
                    choices=list(vocabblock.BLOCKS),
                    help="which GENERATED grammar block to append to the "
                         "system prompt. `slots` = every board with its own "
                         "fields plus the write registry; `contract` = the "
                         "output form and the closed vocabularies; `spec` = "
                         "both; `full` = `spec` plus every name behind the "
                         "`one of N` counts `contract` abbreviates -- the 25 "
                         "boards and all 172 columns, including the 17 the "
                         "ontology attributes to no board and `spec` "
                         "therefore never prints. All are derived from the "
                         "grammar, never from "
                         "anything we watched a model get wrong, and all are "
                         "STATIC so they join the CACHED prefix -- unlike the "
                         "kNN examples, which change every turn.")
    ap.add_argument("--dev", action="store_true",
                    help="the DEV-10 tuning sessions, proven disjoint from "
                         "screen90 -- fast feedback, never a measurement")
    ap.add_argument("--screen", action="store_true",
                    help="only the 90 sessions in screen90.json -- the same "
                         "set for every model, or the comparison is void")
    ap.add_argument("--model-name", default="qwen3.5-2b-q4_k_m")
    args = ap.parse_args()

    corpora = ({"suite", "blind", "holdout"} if args.corpus == "all"
               else set(args.corpus.split(",")))
    rows = turns(corpora)
    if args.screen or args.dev:
        import make_screen
        wanted = make_screen.dev_keys() if args.dev else make_screen.keys()
        rows = [r for r in rows if (r["corpus"], r["session"]) in wanted]
    if args.sessions:
        keep = set()
        for corpus in sorted(corpora):
            names = sorted({r["session"] for r in rows if r["corpus"] == corpus})
            keep |= {(corpus, name) for name in names[:args.sessions]}
        rows = [r for r in rows if (r["corpus"], r["session"]) in keep]
    if args.limit:
        rows = rows[:args.limit]
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    if args.stream is None:
        args.stream = "%s.stream-%s.jsonl" % (args.out, args.arm)
    print("prompt block: %s | arm: %s | turns: %d"
          % (args.block, args.arm, len(rows)), flush=True)
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
