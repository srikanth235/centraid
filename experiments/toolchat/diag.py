"""Zero-training diagnostics on dev-90 (suite minus screen90) for a GGUF +
its HF checkpoint. Evaluation-side only: reads suite.json and the grammar
map's gold canonicals, never feeds training.

    diag.py run --gguf F --ckpt D --out out/NAME-diag [--k 6]

Per turn it records:
  gold_pass   the gold canonical, gold history, passes the executor (ceiling)
  reachable   the gold line is sayable under the turn's grammar + literal trie
  missing     gold string literals the trie cannot produce
  recall      gold literals that are vault labels: in this turn's candidates /
              shown anywhere so far in the session
  tf          the model's line with GOLD history (teacher forcing: no cascade)
  tf_pass     that line passes the executor
  lp_gold, lp_tf   summed assistant-token log-prob under the same prompt
and prints the harness-vs-model partition of every teacher-forced miss.
"""
import argparse, collections, json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import eval_chat as E  # noqa: E402
import ft_chat  # noqa: E402
import retrieve  # noqa: E402  (eval_chat put v5/ on the path)

REPO = E.REPO
REUSE = True  # identical canonicals -> reuse an existing executor pass


def gold_map():
    m = json.load(open(os.path.join(E.EVAL, "grammar", "map.json")))["turns"]
    return {(t["session"], t["turn"]): t["canonical"] for t in m if t["corpus"] == "suite"}


def lits(line):
    return re.findall(r'"([^"]*)"', line or "")


def score_rows(rows, tag):
    """rows: [{session, turn, request, canonical}] -> {(session, turn): (passed, complaint)}"""
    path = os.path.abspath(tag + "-scored.jsonl")
    tpath = os.path.abspath(tag + ".turns.jsonl")
    if REUSE and os.path.exists(tpath) and os.path.exists(path):
        old = [json.loads(l)["canonical"] for l in open(path)]
        if old == [r["canonical"] for r in rows]:
            return _read_turns(tpath)
    with open(path, "w") as fh:
        for r in rows:
            fh.write(json.dumps(dict(r, corpus="suite", prev_used="", mode="chat",
                                     model="diag")) + "\n")
    p = subprocess.run(["cargo", "run", "--release", "-q", "-p", "centraid-candidates",
                        "--bin", "run-model", "--", "--corpus", "suite",
                        "--outputs", path, "--turns", tpath], cwd=REPO,
                       capture_output=True, text=True,
                       env=dict(os.environ, CARGO_INCREMENTAL="0"))
    if p.returncode:
        raise SystemExit(p.stdout + p.stderr)
    return _read_turns(tpath)


def _read_turns(tpath):
    out = {}
    for l in open(tpath):
        t = json.loads(l)
        out[(t["session"], t["turn"])] = (t["passed"], t["complaint"])
    return out


def logprob(torch, tok, model, msgs, answer):
    full = msgs + [{"role": "assistant", "content": answer}]
    n = sum(m["role"] == "assistant" for m in full)
    ids, labels = ft_chat.encode(tok, full, [False] * (n - 1) + [True])
    x = torch.tensor([ids])
    with torch.no_grad():
        lg = model(input_ids=x).logits[0, :-1].float().log_softmax(-1)
    y = torch.tensor(labels[1:])
    keep = y != -100
    return lg[keep].gather(1, y[keep].unsqueeze(1)).sum().item()


def run(a):
    import gbnf
    corpus, today, sessions = E.select("dev90")
    gold = gold_map()
    vault = E.load_vault("dev90", a.vault_dir)
    labels = {e["label"] for e in vault}
    system = E.system_line(today)
    base = a.out
    os.makedirs(os.path.dirname(base) or ".", exist_ok=True)

    # 1. static: prompts under gold history, reachability, retrieval recall
    recs = []
    for s in sessions:
        pairs, users, shown = [], [], []
        for i, t in enumerate(s["turns"]):
            req = t["request"]
            prev = users[-1] if users else None
            users.append(req)
            cands = retrieve.candidates(req, vault, k=a.k, prev=prev, collapse=a.collapse,
                                        per_kind=a.per_kind or None)
            content = retrieve.render(req, cands)
            shown.extend(c["label"] for c in cands)
            g_line = gold[(s["id"], i)]
            allowed = set(E.allowed_strings(users, shown, a.label_spans))
            g = E.turn_grammar(users, shown, a.label_spans)
            gl = lits(g_line)
            vl = [x for x in gl if x in labels]
            recs.append({
                "session": s["id"], "turn": i, "request": req, "gold": g_line,
                "category": s["category"],
                "msgs": ft_chat.context(system, pairs, content, a.max_pairs),
                "reachable": gbnf.Recognizer(g).full(g_line),
                "missing": [x for x in gl if x not in allowed],
                "vault_lits": vl,
                "in_cands": [x for x in vl if x in {c["label"] for c in cands}],
                "in_shown": [x for x in vl if x in shown],
                "cands": [c["label"] for c in cands],
                "grammar": gbnf.emit(g),
            })
            pairs.append((content, g_line))

    # 2. teacher-forced decode (llama-server, same settings as eval_chat decode)
    srv = E.Server(a.gguf, a.port, a.ctx, base + ".server.log")
    try:
        for r in recs:
            try:
                resp = E.post(srv.url + "/v1/chat/completions", {
                    "messages": r["msgs"], "temperature": 0, "top_k": 1,
                    "cache_prompt": True, "max_tokens": a.predict,
                    "grammar": r["grammar"]})
                raw = (resp["choices"][0].get("message") or {}).get("content") or ""
            except Exception as exc:
                raw = ""
                r["error"] = str(exc)
            r["tf_raw"] = raw
            line = raw.strip()
            r["tf"] = line if line and "\n" not in line else ""
    finally:
        srv.close()

    # 3. executor: gold ceiling, then one pass per turn index for teacher forcing
    g_rows = [{"session": r["session"], "turn": r["turn"], "request": r["request"],
               "canonical": r["gold"]} for r in recs]
    gv = score_rows(g_rows, base + "-gold")
    for r in recs:
        r["gold_pass"], r["gold_complaint"] = gv[(r["session"], r["turn"])]
    for j in range(max(r["turn"] for r in recs) + 1):
        rows = [dict(gr, canonical=(r["tf"] if r["turn"] == j else r["gold"]))
                for gr, r in zip(g_rows, recs)]
        v = score_rows(rows, base + "-tf%d" % j)
        for r in recs:
            if r["turn"] == j:
                r["tf_pass"], r["tf_complaint"] = v[(r["session"], r["turn"])]

    # 4. log-probs for teacher-forced misses
    import torch
    torch.set_num_threads(4)
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.ckpt)
    model = AutoModelForCausalLM.from_pretrained(a.ckpt, dtype=torch.float32).eval()
    for r in recs:
        if not r["tf_pass"] and r["tf"] != r["gold"]:
            r["lp_gold"] = logprob(torch, tok, model, r["msgs"], r["gold"])
            r["lp_tf"] = logprob(torch, tok, model, r["msgs"], r["tf"]) if r["tf"] else None

    with open(base + ".jsonl", "w") as fh:
        for r in recs:
            fh.write(json.dumps({k: v for k, v in r.items() if k not in ("grammar",)}) + "\n")
    report(recs)


def classify(r):
    if r["tf_pass"]:
        return "pass"
    if not r["gold_pass"]:
        return "gold fails executor"
    if not r["reachable"]:
        return "gold unreachable (literal/retrieval)"
    if r.get("lp_tf") is None:
        return "invalid output"
    if r["lp_gold"] > r["lp_tf"]:
        return "search error (model prefers gold)"
    return "model prefers wrong line (data)"


def report(recs):
    n = len(recs)
    print("dev-90 turns: %d" % n)
    print("gold passes executor (ceiling): %d/%d" % (sum(r["gold_pass"] for r in recs), n))
    print("gold reachable under grammar:   %d/%d" % (sum(r["reachable"] for r in recs), n))
    vt = [r for r in recs if r["vault_lits"]]
    print("turns whose gold names a vault label: %d; label in this turn's candidates %d, "
          "shown so far %d" % (len(vt), sum(set(r["vault_lits"]) <= set(r["in_cands"]) for r in vt),
                               sum(set(r["vault_lits"]) <= set(r["in_shown"]) for r in vt)))
    print("teacher-forced turn accuracy:   %d/%d" % (sum(r["tf_pass"] for r in recs), n))
    c = collections.Counter(classify(r) for r in recs)
    for k, v in c.most_common():
        print("  %-40s %d" % (k, v))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run", "report"])
    ap.add_argument("--gguf")
    ap.add_argument("--ckpt")
    ap.add_argument("--out", required=True)
    ap.add_argument("--k", type=int, default=6)
    ap.add_argument("--port", type=int, default=8933)
    ap.add_argument("--ctx", type=int, default=4096)
    ap.add_argument("--predict", type=int, default=96)
    ap.add_argument("--max-pairs", type=int, default=ft_chat.MAX_PAIRS)
    ap.add_argument("--collapse", action="store_true")
    ap.add_argument("--per-kind", type=int, default=0)
    ap.add_argument("--label-spans", action="store_true")
    ap.add_argument("--vault-dir", default=os.path.join(E.SP, "vaults"))
    a = ap.parse_args()
    if a.cmd == "run":
        run(a)
    else:
        report([json.loads(l) for l in open(a.out + ".jsonl")])
