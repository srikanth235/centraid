"""The loop agent `tool-loop score --agent` talks to (stdin/stdout JSON lines).

    tool-loop score --corpus suite --sessions dev90.json --agent \\
        python agent.py replay --file trajectories.jsonl
    tool-loop score --corpus suite --sessions dev90.json --agent \\
        python agent.py llama --gguf model.gguf --log out/x.steps.jsonl

`replay` plays recorded calls ({"session", "turns": [[call, ...], ...]}); a turn
whose calls run out says `done`. `llama` asks a llama-server for one call per
step, decoded FREELY — no grammar: the runtime is the only judge of a line.
Raw output is logged BEFORE anything reads it and is sent as is; a line the
runtime cannot run comes back as an `error: …` observation that spends the
step. Nothing is ever re-sampled.

A read turn ends on `answer <set|value>`; `done` only stops.
"""
import argparse
import json
import re
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from ft_chat import join_think, split_think  # noqa: E402  (pure helpers; no torch import)


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def recv():
    line = sys.stdin.readline()
    return json.loads(line) if line else {"op": "quit"}


# -- agents ----------------------------------------------------------------

def replay(a):
    book = {}
    for line in open(a.file, encoding="utf-8"):
        if line.strip():
            r = json.loads(line)
            book[r["session"]] = r["turns"]
    calls, turn = [], -1
    session = None
    while True:
        msg = recv()
        op = msg.get("op")
        if op == "quit":
            return
        if op == "session":
            session, turn = msg["id"], -1
        elif op == "turn":
            turn += 1
            turns = book.get(session, [])
            calls = list(turns[turn]) if turn < len(turns) else []
            # the Rust side says `end` on the step that closes the turn,
            # whatever closed it; a call past that would be read as the NEXT
            # turn's. `a.steps` is only a safety net above its own cap.
            for _ in range(a.steps):
                send({"call": calls.pop(0) if calls else "done"})
                if recv().get("end"):
                    break
            recv()  # turn_end


def template_check(srv, tokenizer):
    """llama-server's rendering of a TOOL conversation vs transformers'."""
    import eval_chat as E
    from ft_chat import prepare_tokenizer
    from transformers import AutoTokenizer
    tok = prepare_tokenizer(AutoTokenizer.from_pretrained(tokenizer))
    msgs = [{"role": "system", "content": "today: Monday 2026-06-15"},
            {"role": "user", "content": "who's coming to the cabin?"},
            {"role": "assistant", "content": 'search "cabin"'},
            {"role": "tool", "content": '#1 event "Cabin check-in" Thu 2026-06-18 15:00\n#2 task "Book the cabin"'},
            {"role": "assistant", "content": "show (parties of (#1))"},
            {"role": "tool", "content": '#3 party "Ana Ruiz"'},
            {"role": "assistant", "content": "done"},
            {"role": "user", "content": "what's her number"}]
    hf_text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    hf_ids = list(tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True,
                                          return_dict=False))
    srv_text = E.post(srv.url + "/apply-template", {"messages": msgs})["prompt"]
    srv_ids = E.post(srv.url + "/tokenize", {"content": srv_text, "add_special": True,
                                             "parse_special": True})["tokens"]
    ok = hf_text == srv_text and hf_ids == srv_ids
    sys.stderr.write("tool template identity: %s\n" % ("SAME" if ok else "DIFFER"))
    if not ok:
        sys.stderr.write("HF    : %r\nserver: %r\n" % (hf_text, srv_text))
    return ok


QUOTED = re.compile(r'"([^"]+)"')
# a word never carries its quote marks ("'Driftwood'" is the word Driftwood);
# an inner apostrophe or hyphen stays part of it (don't, Jean-Luc)
WORD = re.compile(r"\w+(?:['’-]\w+)*")
# `ns.verb{…}`: the braces hold the text the model chose to write, never snapped
WRITE_ARGS = re.compile(r"^\s*\w+\.\w+\{.*\}", re.S)


def snap(line, texts):
    """--snap: a quoted string the model garbled ("Tahde" for "Tahoe") is
    replaced by the closest same-length-ish span of words in what the person
    said or the tool showed, when one is close enough; otherwise left as is.
    A write call's arguments are the model's own text (a title, a description)
    and are never rewritten."""
    import difflib
    words = [w for t in texts for w in WORD.findall(t)]

    def best(q):
        n = len(q.split())
        spans = {" ".join(words[i:i + k]) for k in (n - 1, n, n + 1) if k > 0
                 for i in range(len(words) - k + 1)}
        low = {sp.lower(): sp for sp in spans}
        if q.lower() in low:
            return q
        hit = difflib.get_close_matches(q.lower(), list(low), n=1, cutoff=0.75)
        return low[hit[0]] if hit else q

    w = WRITE_ARGS.match(line)
    keep = w.end() if w else 0
    return line[:keep] + QUOTED.sub(lambda m: '"%s"' % best(m.group(1)), line[keep:])


def llama(a):
    import eval_chat as E
    srv = E.Server(a.gguf, a.port, a.ctx, a.log + ".server.log")
    log = open(a.log, "w", encoding="utf-8")
    try:
        if not template_check(srv, a.tokenizer):
            raise SystemExit("prompt rendering differs from training; aborting")
        msgs, session, turn = [], None, -1
        while True:
            msg = recv()
            op = msg.get("op")
            if op == "quit":
                return
            if op == "session":
                session, turn = msg["id"], -1
                msgs = [{"role": "system", "content": msg["today"]}]
                continue
            if op != "turn":
                continue
            turn += 1
            msgs.append({"role": "user", "content": msg["request"]})
            for step in range(a.steps):
                t0 = time.time()
                raw, err, think = "", "", ""
                n = a.predict + (a.think_tokens if a.think else 0)
                body = {"messages": msgs, "temperature": 0, "top_k": 1, "cache_prompt": True,
                        "n_predict": n, "max_tokens": n}
                if a.think:
                    body["chat_template_kwargs"] = {"enable_thinking": True}
                try:
                    r = E.post(srv.url + "/v1/chat/completions", body)
                    m = r["choices"][0].get("message") or {}
                    raw = m.get("content") or ""
                    if a.think:
                        think = (m.get("reasoning_content") or "").strip()
                except Exception as exc:
                    err = "llama: %s" % exc
                ms = round(1000 * (time.time() - t0))
                rec = {"session": session, "turn": turn, "step": step,
                       "request": msg["request"], "raw_text": raw, "error": err, "ms": ms}
                if a.think:
                    # the server may leave the tags in content (no reasoning parser)
                    t2, raw_call = split_think(raw)
                    think = think or t2
                    rec["think"] = think
                log.write(json.dumps(rec) + "\n")
                log.flush()
                line = raw_call if a.think else raw.strip()
                if a.snap:
                    line = snap(line, [m["content"] for m in msgs
                                       if m["role"] in ("user", "tool")])
                # sent AS IS: the runtime answers a bad line with `error: …`
                send({"call": line})
                r = recv()
                msgs.append({"role": "assistant",
                             "content": join_think(think, line) if a.think else line})
                if r.get("end"):
                    if r.get("obs"):
                        msgs.append({"role": "tool", "content": r["obs"]})
                    break
                msgs.append({"role": "tool", "content": r["obs"]})
            recv()  # turn_end
    finally:
        srv.close()


class Convo:
    """The hf prompt, built exactly as training rendered it (scratchpad final/export.py):
    system = the session's today line, then user / assistant / tool messages, every tool
    message — the closing one included, even when empty — with its ontology slice lines
    prepended by toolslice (the module export.py uses)."""
    def __init__(self, today, think=False):
        from toolslice import Slicer
        self.think = think   # --think: generate from the thinking prompt (ends "<think>\n")
        self.slicer = Slicer()
        self.msgs = [{"role": "system", "content": today}]

    def user(self, text):
        self.msgs.append({"role": "user", "content": text})

    def assistant(self, line):
        self.msgs.append({"role": "assistant", "content": line})

    def tool(self, obs):
        self.msgs.append({"role": "tool", "content": self.slicer.observe(obs or "")})

    def prompt(self, tok):
        from ft_chat import prepare_tokenizer   # idempotent; a trained checkpoint already carries it
        return prepare_tokenizer(tok).apply_chat_template(self.msgs, tokenize=False,
                                                          add_generation_prompt=True,
                                                          **self.kwargs())

    def kwargs(self):
        # off: no kwarg at all, so the default render is byte-identical to before
        return {"enable_thinking": True} if self.think else {}


def hf(a):
    """Same loop as `llama`, decoded greedily by transformers (GPU when there
    is one), over the prompt `Convo` builds (checked byte-for-byte against the
    training prefixes by scratchpad final/check_prompt.py)."""
    import torch
    from ft_chat import prepare_tokenizer, stop_ids
    from transformers import AutoModelForCausalLM, AutoTokenizer
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    tok = prepare_tokenizer(AutoTokenizer.from_pretrained(a.ckpt))
    model = AutoModelForCausalLM.from_pretrained(a.ckpt, dtype=torch.float32).to(dev).eval()
    eos = stop_ids(tok, model)   # Qwen: <|im_end|> closes the call, not only <|endoftext|>
    log = open(a.log, "w", encoding="utf-8")
    cv, session, turn = None, None, -1
    while True:
        msg = recv()
        op = msg.get("op")
        if op == "quit":
            return
        if op == "session":
            session, turn = msg["id"], -1
            cv = Convo(msg["today"], a.think)
            continue
        if op != "turn":
            continue
        turn += 1
        cv.user(msg["request"])
        for step in range(a.steps):
            t0 = time.time()
            ids = tok.apply_chat_template(cv.msgs, add_generation_prompt=True, return_tensors="pt",
                                          return_dict=True, **cv.kwargs()).to(dev)
            n = a.predict + (a.think_tokens if a.think else 0)
            with torch.no_grad():
                out = model.generate(**ids, max_new_tokens=n, do_sample=False, eos_token_id=eos,
                                     pad_token_id=tok.pad_token_id or tok.eos_token_id)
            raw = tok.decode(out[0, ids["input_ids"].shape[1]:], skip_special_tokens=True)
            rec = {"session": session, "turn": turn, "step": step,
                   "request": msg["request"], "raw_text": raw, "error": "",
                   "ms": round(1000 * (time.time() - t0))}
            think = ""
            if a.think:
                think, line = split_think(raw)
                rec["think"] = think
            else:
                line = raw.strip()
            log.write(json.dumps(rec) + "\n")
            log.flush()
            if a.snap:
                line = snap(line, [m["content"] for m in cv.msgs if m["role"] in ("user", "tool")])
            send({"call": line})
            r = recv()
            # history carries reasoning + call, exactly as a traced turn is trained
            cv.assistant(join_think(think, line) if a.think else line)
            cv.tool(r.get("obs", ""))
            if r.get("end"):
                break
        recv()  # turn_end


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["replay", "llama", "hf"])
    ap.add_argument("--file")
    ap.add_argument("--gguf")
    ap.add_argument("--ckpt", help="hf: a saved checkpoint directory")
    ap.add_argument("--log", default=os.path.join(HERE, "out", "agent.steps.jsonl"))
    ap.add_argument("--port", type=int, default=8941)
    ap.add_argument("--ctx", type=int, default=8192)
    ap.add_argument("--predict", type=int, default=96)
    ap.add_argument("--steps", type=int, default=64,
                    help="safety net only: the Rust side's --steps/--budget close the turn")
    ap.add_argument("--tokenizer", default="ibm-granite/granite-4.0-350m")
    ap.add_argument("--snap", action="store_true",
                    help="snap a garbled quoted name to the closest words the person or tool said")
    ap.add_argument("--think", action="store_true",
                    help="traced checkpoints: generate from the thinking prompt, send only the "
                         "call, log the reasoning as `think`, keep reasoning+call in history")
    ap.add_argument("--think-tokens", type=int, default=256,
                    help="--think: extra new tokens on top of --predict for the reasoning")
    a = ap.parse_args()
    {"replay": replay, "llama": llama, "hf": hf}[a.mode](a)
