"""Constrained llama.cpp evaluation of a chat-format checkpoint (v4/SPEC.md
sections 2 and 3).

    eval_chat.py to-gguf --ckpt D --out F.gguf [--outtype f16|q8_0]
    eval_chat.py check-template --gguf F.gguf [--tokenizer D]
    eval_chat.py decode --gguf F.gguf --set dev15|dev90|blind|holdout --out out/NAME
    eval_chat.py score  --set ... --out out/NAME

(`eval_chat.sh` chains decode + score.)

decode starts its own llama-server (--jinja: the GGUF's chat template) and,
for every turn, posts /v1/chat/completions with the session so far as built
by ft_chat.context() -- the same function training windows with -- at
temperature 0 / top_k 1 / cache_prompt, under gbnf.rules() with its `string`
rule replaced by the per-turn literal constraint of SPEC section 3.

Before decoding, the prompt llama-server renders for a multi-turn session is
compared token for token with transformers' apply_chat_template(...,
add_generation_prompt=True); a mismatch aborts the run.

DISCIPLINE: the raw reply is written before anything parses it; an empty or
grammar-invalid reply is a FAILURE (empty canonical), never repaired or
retried. The model's own reply (raw, stripped) is what goes into the history.

Vault candidates (SPEC section 5): each user message is rendered with
v5/retrieve.py against the evaluation world's vault ($SP/vaults/
suite_world.json for dev90/dev15/blind, second_world.json for holdout --
runtime vault content, never training data). Earlier messages are replayed
with the content they were rendered with, and every candidate label shown so
far joins the per-turn literal constraint, exactly as shown.

blind and holdout are sealed: outputs go under out/sealed/, nothing per turn
is printed, and only the scorer's headline lines are shown.
"""
import argparse, datetime, json, os, re, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
EVAL = os.path.join(REPO, "crates", "evalsuite")
QS = os.path.join(REPO, "experiments", "qwen-sanity")
SP = os.environ.get("SP", "/tmp/claude-0/-home-user-centraid/"
                    "f31227f9-ca10-5f19-9c12-db2b239388c1/scratchpad")
LLAMA = os.environ.get("LLAMA_CPP", os.path.join(SP, "qwen-sanity", "llama.cpp"))
sys.path.insert(0, HERE)
import ft_chat  # noqa: E402  (torch-free at import)
sys.path.insert(0, os.path.join(HERE, "v5"))
import retrieve  # noqa: E402  (SPEC section 5: the one retriever)

SEALED = ("blind", "holdout")
DEFAULTS = ["password", "login", "phone", "email", "call", "visit", "message",
            "coffee", "completed", "Birthday", "note", "wifi", "card", "colleague"]
EDGE = "\"'`.,!?;:()[]{}"


# -- SPEC section 3: the literal constraint --------------------------------

def check_values():
    d = json.load(open(os.path.join(EVAL, "grammar", "derive", "derived.json")))
    out = set()
    for fields in d["predicates"].values():
        for f in fields.values():
            if isinstance(f, dict):
                out |= set(f.get("checkValues") or [])
    return sorted(out)


CHECK_VALUES = check_values()


def spans(text):
    """Every contiguous word span, as typed: words are whitespace runs with
    edge punctuation trimmed; a span is the original text from the first
    word's start to the last word's end (inner punctuation kept)."""
    words = []
    for m in re.finditer(r"\S+", text):
        s, e = m.start(), m.end()
        while s < e and text[s] in EDGE:
            s += 1
        while e > s and text[e - 1] in EDGE and text[e - 1] != "'":
            e -= 1
        if e > s:
            words.append((s, e))
    out = set()
    for i in range(len(words)):
        for j in range(i, len(words)):
            out.add(text[words[i][0]:words[j][1]])
    return out


def allowed_strings(user_msgs, shown=(), label_spans=False, values=True):
    out = set(shown)
    # opt-in: any word span of a shown label ("check-in" of "Cabin check-in"),
    # typed or lower-cased, like the user's own words
    srcs = list(user_msgs) + (list(shown) if label_spans else [])
    for msg in srcs:
        for sp in spans(msg):
            out |= {sp, sp.lower(), sp[:1].upper() + sp[1:]}
    if values:
        out |= set(CHECK_VALUES) | set(DEFAULTS)
    # unescapable in a canonical string, or unprintable as a GBNF \u escape
    return sorted(s for s in out if s and '"' not in s and "\\" not in s
                  and "\n" not in s and all(ord(c) < 0x10000 for c in s))


def pieces(s):
    return re.findall(r"\S+|\s+", s)


def string_rules(strings, rule="string", prefix="lit"):
    """A word-level trie: one rule per internal node, so the alternation
    llama.cpp walks is a branching factor, not the full span list."""
    import gbnf
    trie = {}
    for s in strings:
        node = trie
        for p in pieces(s):
            node = node.setdefault(p, {})
        node[None] = {}
    rules, n = {}, [0]

    def build(node):
        name = "%s%d" % (prefix, n[0]); n[0] += 1
        alts = []
        for p in sorted(k for k in node if k is not None):
            child = node[p]
            kids = [k for k in child if k is not None]
            if not kids:
                alts.append([gbnf.L(p)])
            elif None in child:
                alts.append([gbnf.L(p), gbnf.OPT(gbnf.R(build(child)))])
            else:
                alts.append([gbnf.L(p), gbnf.R(build(child))])
        rules[name] = alts
        return name

    root = build(trie)
    rules[rule] = [[gbnf.L('"'), gbnf.R(root), gbnf.L('"')]]
    return rules


def turn_grammar(user_msgs, shown=(), label_spans=False, typed=False):
    import gbnf
    g = gbnf.rules()
    g.update(string_rules(allowed_strings(user_msgs, shown, label_spans)))
    if typed:
        # a name after `called` is what the user typed or the vault
        # showed; schema check-values stay sayable only as compared values
        g.update(string_rules(allowed_strings(user_msgs, shown, label_spans, False),
                              "namestr", "nam"))
        g["suffix"] = [[gbnf.R("namestr") if it == gbnf.R("string") else it
                        for it in alt] for alt in g["suffix"]]
    return g


def grammar_text(g, llg=False):
    """GBNF for llama.cpp's own sampler, or the same rules as llguidance Lark
    (`%llguidance`), which needs a llama-server built with LLAMA_LLGUIDANCE."""
    import gbnf
    text = gbnf.emit(g)
    if not llg:
        return text
    import gbnf_to_lark
    return gbnf_to_lark.gbnf_to_lark(text)


# -- corpus selection (ft_granite.py dev15()) -------------------------------

def select(which):
    corpus = which if which in SEALED else "suite"
    data = json.load(open(os.path.join(EVAL, corpus + ".json"), encoding="utf-8"))
    if corpus != "suite":
        want = {s["id"] for s in data["sessions"]}
    elif which == "dev90":
        screen = set(json.load(open(os.path.join(QS, "screen90.json")))["sessions"]["suite"])
        want = {s["id"] for s in data["sessions"]} - screen
    else:
        want = set(json.load(open(os.path.join(QS, "dev15.json")))["sessions"]["suite"])
    return corpus, data["today"], [s for s in data["sessions"] if s["id"] in want]


def load_vault(which, vault_dir):
    world = "second_world" if which == "holdout" else "suite_world"
    return json.load(open(os.path.join(vault_dir, world + ".json"), encoding="utf-8"))


def system_line(today):
    d = datetime.date.fromisoformat(today)
    return "today: %s %s" % (d.strftime("%A"), d.isoformat())


# -- llama-server ------------------------------------------------------------

def post(url, body, timeout=600):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as fh:
        return json.loads(fh.read().decode())


class Server:
    def __init__(self, gguf, port, ctx, log):
        self.url = "http://127.0.0.1:%d" % port
        self.proc = subprocess.Popen(
            [os.path.join(LLAMA, os.environ.get("LLAMA_BUILD", "build"), "bin",
                          "llama-server"), "-m", gguf,
             "--port", str(port), "--host", "127.0.0.1", "--jinja",
             "-c", str(ctx), "-t", "4", "-np", "1", "--no-webui"],
            stdout=open(log, "w"), stderr=subprocess.STDOUT)
        for _ in range(600):
            try:
                with urllib.request.urlopen(self.url + "/health", timeout=2) as fh:
                    if fh.status == 200:
                        return
            except Exception:
                pass
            if self.proc.poll() is not None:
                raise SystemExit("llama-server exited; see " + log)
            time.sleep(0.5)
        raise SystemExit("llama-server did not come up; see " + log)

    def close(self):
        self.proc.terminate()
        self.proc.wait()


def template_check(server, tokenizer, today):
    """llama-server's rendering of a multi-turn session vs transformers'.
    Compares the templated TEXT and the token ids the server will evaluate
    (tokenized with special handling, exactly as the chat endpoint does,
    including any BOS it would add)."""
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(tokenizer)
    pairs = [("show my tasks for tomorrow", 'show (tasks that (due_at during tomorrow))'),
             ("and the Lisbon trip?", 'show (groups called "Lisbon")'),
             ("how many expenses in it", "count of (expenses of (it))"),
             ("what's the weather", "refuse: out_of_ontology")]
    msgs = ft_chat.context(system_line(today), pairs, "ok, add a task: call Ana")
    hf_text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    hf_ids = list(tok.apply_chat_template(msgs, tokenize=True,
                                          add_generation_prompt=True, return_dict=False))
    srv_text = post(server.url + "/apply-template", {"messages": msgs})["prompt"]
    srv_ids = post(server.url + "/tokenize", {"content": srv_text, "add_special": True,
                                              "parse_special": True})["tokens"]
    ok = hf_text == srv_text and hf_ids == srv_ids
    print("template identity: text %s, tokens %s (%d hf / %d server)"
          % ("SAME" if hf_text == srv_text else "DIFFER",
             "SAME" if hf_ids == srv_ids else "DIFFER", len(hf_ids), len(srv_ids)))
    if not ok:
        print("HF    :", repr(hf_text), hf_ids[:12])
        print("server:", repr(srv_text), srv_ids[:12])
    return ok


# -- commands --------------------------------------------------------------

def legacy_config(ckpt):
    """transformers 5 saves Granite's attention layers as "full_attention" and
    moves rope_theta under rope_parameters; llama.cpp's converter only knows
    the names the base checkpoint ships ("attention", top-level rope_theta)
    and otherwise builds every layer as a Mamba layer. Names only: no weight
    is touched."""
    path = os.path.join(ckpt, "config.json")
    cfg = json.load(open(path))
    if "layer_types" in cfg:
        cfg["layer_types"] = ["attention" if t == "full_attention" else t
                              for t in cfg["layer_types"]]
    rope = cfg.get("rope_parameters") or {}
    if cfg.get("rope_theta") is None and "rope_theta" in rope:
        cfg["rope_theta"] = rope["rope_theta"]
    json.dump(cfg, open(path, "w"), indent=2)


def to_gguf(a):
    legacy_config(a.ckpt)
    py = os.path.join(SP, "ft", "bin", "python")
    env = dict(os.environ, PYTHONPATH=os.path.join(LLAMA, "gguf-py"))
    subprocess.run([py, os.path.join(LLAMA, "convert_hf_to_gguf.py"), a.ckpt,
                    "--outfile", a.out, "--outtype", a.outtype], check=True, env=env)
    print("wrote", a.out, "%.0f MB" % (os.path.getsize(a.out) / 1e6))


def check_template(a):
    srv = Server(a.gguf, a.port, a.ctx, a.gguf + ".server.log")
    try:
        ok = template_check(srv, a.tokenizer, "2026-06-15")
    finally:
        srv.close()
    return 0 if ok else 1


def out_base(a):
    if a.set in SEALED and "sealed" not in a.out.split(os.sep):
        return os.path.join(os.path.dirname(a.out), "sealed", os.path.basename(a.out))
    return a.out


def decode(a):
    import gbnf
    corpus, today, sessions = select(a.set)
    sealed = a.set in SEALED
    base = out_base(a)
    vault = load_vault(a.set, a.vault_dir)
    os.makedirs(os.path.dirname(base) or ".", exist_ok=True)
    srv = Server(a.gguf, a.port, a.ctx, base + ".server.log")
    try:
        if not template_check(srv, a.tokenizer, today):
            raise SystemExit("prompt rendering differs from training; aborting")
        system = system_line(today)
        stream = open(base + ".stream.jsonl", "w", encoding="utf-8")
        rows, valid_n, total, t_all = [], 0, 0, time.time()
        for s in sessions:
            pairs, users, shown = [], [], []
            for i, t in enumerate(s["turns"]):
                req = t["request"]
                prev = users[-1] if users else None  # SPEC 5.1: raw previous user text
                users.append(req)
                cands = retrieve.candidates(req, vault, prev=prev, collapse=a.collapse,
                                            per_kind=a.per_kind or None)
                content = retrieve.render(req, cands)
                shown.extend(c["label"] for c in cands)
                g = turn_grammar(users, shown, a.label_spans, a.typed)
                msgs = ft_chat.context(system, pairs, content, a.max_pairs)
                t0 = time.time()
                err, raw = "", ""
                try:
                    r = post(srv.url + "/v1/chat/completions", {
                        "messages": msgs, "temperature": 0, "top_k": 1,
                        "cache_prompt": True, "n_predict": a.predict,
                        "max_tokens": a.predict, "grammar": grammar_text(g, a.llg)})
                    raw = (r["choices"][0].get("message") or {}).get("content") or ""
                except Exception as exc:
                    err = "llama: %s" % exc
                ms = round(1000 * (time.time() - t0))
                # RAW FIRST, before anything parses it
                stream.write(json.dumps({"session": s["id"], "turn": i, "request": req,
                                         "raw_text": raw, "error": err, "ms": ms,
                                         "n_msgs": len(msgs), "candidates": cands})
                             + "\n")
                stream.flush()
                line = raw.strip()
                valid = bool(line) and "\n" not in line and gbnf.Recognizer(g).full(line)
                canon = line if valid else ""
                rows.append({"corpus": corpus, "session": s["id"], "turn": i,
                             "request": req, "canonical": canon,
                             "prev_used": pairs[-1][1] if pairs else "NONE",
                             "mode": "chat", "model": a.gguf})
                valid_n += valid; total += 1
                if not sealed:
                    print("%s t%d %5dms  %s" % (s["id"], i, ms,
                                                canon or "INVALID: %r" % raw[:80]),
                          flush=True)
                pairs.append((content, line))
        with open(base + "-scored.jsonl", "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")
        el = time.time() - t_all
        print("%s: %d sessions, %d turns, grammar-valid %d/%d, %.0fs (%.0f ms/turn)"
              % (a.set, len(sessions), total, valid_n, total, el, 1000 * el / max(total, 1)))
        print("wrote", base + "-scored.jsonl")
    finally:
        srv.close()


def score(a):
    corpus = a.set if a.set in SEALED else "suite"
    scored = os.path.abspath(out_base(a) + "-scored.jsonl")
    p = subprocess.run(["cargo", "run", "--release", "-q", "-p", "centraid-candidates",
                        "--bin", "run-model", "--", "--corpus", corpus,
                        "--outputs", scored], cwd=REPO, capture_output=True, text=True,
                       env=dict(os.environ, CARGO_INCREMENTAL="0"))
    out = p.stdout + p.stderr
    if a.set in SEALED:
        with open(out_base(a) + ".score.txt", "w") as fh:
            fh.write(out)
        for l in out.splitlines():
            if re.match(r"\s*(SESSIONS PASSED|GRADED SESSION|TURNS PASSED)", l):
                print(l.strip())
    else:
        print(out)
    return p.returncode


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["to-gguf", "check-template", "decode", "score"])
    ap.add_argument("--ckpt")
    ap.add_argument("--gguf")
    ap.add_argument("--out")
    ap.add_argument("--outtype", default="f16", choices=["f16", "q8_0", "bf16", "f32"])
    ap.add_argument("--set", default="dev15", choices=["dev15", "dev90", "blind", "holdout"])
    ap.add_argument("--tokenizer", default="ibm-granite/granite-4.0-350m",
                    help="HF tokenizer the checkpoint was trained with (for the identity check)")
    ap.add_argument("--port", type=int, default=8931)
    ap.add_argument("--ctx", type=int, default=4096)
    ap.add_argument("--predict", type=int, default=96)
    ap.add_argument("--vault-dir", default=os.path.join(SP, "vaults"))
    ap.add_argument("--max-pairs", type=int, default=ft_chat.MAX_PAIRS)
    ap.add_argument("--collapse", action="store_true",
                    help="retriever: numbered near-duplicate families take one slot")
    ap.add_argument("--label-spans", action="store_true",
                    help="literal constraint: word spans of shown labels are sayable")
    ap.add_argument("--typed", action="store_true",
                    help="names (called/contains) exclude schema check-values")
    ap.add_argument("--llg", action="store_true",
                    help="constrain with llguidance (Lark) instead of GBNF; set LLAMA_BUILD=build-llg")
    ap.add_argument("--per-kind", type=int, default=0,
                    help="retriever: at most N candidates per kind/field (0 = no cap)")
    a = ap.parse_args()
    sys.exit({"to-gguf": to_gguf, "check-template": check_template,
              "decode": decode, "score": score}[a.cmd](a) or 0)
