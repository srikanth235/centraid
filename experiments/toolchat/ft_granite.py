"""Cheapest fine-tune probe: does Granite 350M learn request -> canonical?

    ft_granite.py time  --model M                 # seconds per training step
    ft_granite.py train --model M --rows N --out D [--ckpt-at 1000,4000]
    ft_granite.py dev15 --ckpt D --out out/X      # free-running, raw first
    ft_granite.py heldout --ckpt D                # distill_val, diagnostic

Training data is experiments/canon-model/data/distill.jsonl ONLY: Sonnet
paraphrases over an invented second world, leakage-gated against the suite
(DISTILL.md). Nothing here reads the suite except `dev15`, which decodes it.

Decoding is unconstrained greedy; every output is written raw, then checked by
the grammar recognizer, and a line outside the grammar is a FAILURE (empty
canonical), never repaired or retried.
"""
import argparse, datetime, json, os, random, re, sys, time
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(REPO, "experiments", "canon-model", "data")
EVAL = os.path.join(REPO, "crates", "evalsuite")
SUITE_TODAY = datetime.date(2026, 6, 15)
DISTILL_TODAY = SUITE_TODAY + datetime.timedelta(days=243)  # distill_world SHIFT
torch.set_num_threads(4)


def prompt(today, prev, request):
    return ("today: %s %s\nbefore: %s\nrequest: %s\ncanonical:"
            % (today.strftime("%A"), today.isoformat(), prev, request))


def rows(path, n=None, seed=0):
    out = []
    for line in open(path, encoding="utf-8"):
        r = json.loads(line)
        prev, req = r["input"].split(" ||| ", 1)
        out.append((prev, req, r["target"], r.get("today")))
    random.Random(seed).shuffle(out)
    return out[:n] if n else out


YEAR = re.compile(r"\b(20\d\d)\b")
SHORT = re.compile(r"\b(\d{1,2}/\d{1,2}/)(\d\d)\b")


def shift_years(prev, req, target, k):
    """Move every year by k: the request's stated years, the canonical's ISO
    years and the date line together, so `today` is not a constant the model
    can ignore. A date that stops existing (Feb 29) keeps the original year."""
    if k == 0:
        return DISTILL_TODAY, prev, req, target
    up = lambda m: str(int(m.group(1)) + k)  # noqa: E731
    new = [YEAR.sub(up, x) for x in (prev, req, target)]
    new[1] = SHORT.sub(lambda m: m.group(1) + "%02d" % (int(m.group(2)) + k), new[1])
    for d in re.findall(r"\b\d{4}-\d\d-\d\d\b", new[0] + " " + new[2]):
        try:
            datetime.date.fromisoformat(d)
        except ValueError:
            return DISTILL_TODAY, prev, req, target
    return (DISTILL_TODAY.replace(year=DISTILL_TODAY.year + k),) + tuple(new)


def encode(tok, prev, req, target, today=DISTILL_TODAY):
    p = tok(prompt(today, prev, req), add_special_tokens=False)["input_ids"]
    t = tok(" " + target, add_special_tokens=False)["input_ids"] + [tok.eos_token_id]
    return p + t, [-100] * len(p) + t


def batches(tok, data, bs, vary=False):
    rng = random.Random(7)
    enc = []
    for prev, req, tgt, fixed in data:
        today = DISTILL_TODAY
        if fixed:
            today = datetime.date.fromisoformat(fixed)
        elif vary:
            today, prev, req, tgt = shift_years(prev, req, tgt, rng.choice((-2, -1, 0, 1)))
        enc.append(encode(tok, prev, req, tgt, today))
    for i in range(0, len(enc), bs):
        chunk = enc[i:i + bs]
        L = max(len(x) for x, _ in chunk)
        ids = torch.full((len(chunk), L), tok.pad_token_id or tok.eos_token_id)
        lab = torch.full((len(chunk), L), -100)
        att = torch.zeros((len(chunk), L), dtype=torch.long)
        for j, (x, y) in enumerate(chunk):
            ids[j, :len(x)] = torch.tensor(x)
            lab[j, :len(y)] = torch.tensor(y)
            att[j, :len(x)] = 1
        yield ids, lab, att


def load(name):
    tok = AutoTokenizer.from_pretrained(name)
    model = AutoModelForCausalLM.from_pretrained(name, torch_dtype=torch.float32)
    return tok, model


def train(a):
    tok, model = load(a.model)
    data = rows(a.data or os.path.join(DATA, "distill.jsonl"), a.rows, a.seed)
    ckpts = sorted(int(x) for x in a.ckpt_at.split(",")) if a.ckpt_at else []
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.0)
    steps = (len(data) + a.bs - 1) // a.bs
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / 30) * max(0.05, 1 - s / steps))
    model.train()
    seen, t0, run = 0, time.time(), []
    for step, (ids, lab, att) in enumerate(batches(tok, data, a.bs, a.vary_years)):
        loss = model(input_ids=ids, attention_mask=att, labels=lab).loss
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); sched.step(); opt.zero_grad()
        seen += ids.shape[0]; run.append(loss.item())
        if step % 10 == 0:
            print("step %d rows %d loss %.3f  %.1fs/step" % (
                step, seen, sum(run) / len(run), (time.time() - t0) / (step + 1)),
                flush=True)
            run = []
        while ckpts and seen >= ckpts[0]:
            d = "%s-%d" % (a.out, ckpts.pop(0))
            model.save_pretrained(d); tok.save_pretrained(d)
            print("saved", d, flush=True)
    model.save_pretrained(a.out); tok.save_pretrained(a.out)
    print("saved", a.out, "in %.0fs" % (time.time() - t0))


def time_steps(a):
    tok, model = load(a.model)
    data = rows(os.path.join(DATA, "distill.jsonl"), a.bs * 4)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-5)
    for i, (ids, lab, att) in enumerate(batches(tok, data, a.bs)):
        t = time.time()
        model(input_ids=ids, attention_mask=att, labels=lab).loss.backward()
        opt.step(); opt.zero_grad()
        print("step %d  len %d  %.2fs" % (i, ids.shape[1], time.time() - t), flush=True)


class Decoder:
    def __init__(self, ckpt):
        self.tok, self.model = load(ckpt)
        self.model.eval()
        sys.path.insert(0, HERE)
        import gbnf
        self.rec = gbnf.Recognizer(gbnf.rules())

    @torch.no_grad()
    def __call__(self, today, prev, req):
        p = self.tok(prompt(today, prev, req), return_tensors="pt",
                     add_special_tokens=False)
        out = self.model.generate(**p, max_new_tokens=96, do_sample=False,
                                  eos_token_id=self.tok.eos_token_id,
                                  pad_token_id=self.tok.eos_token_id)
        raw = self.tok.decode(out[0, p["input_ids"].shape[1]:],
                              skip_special_tokens=True)
        line = raw.split("\n")[0].strip()
        valid = bool(line) and self.rec.full(line)
        return raw, (line if valid else ""), valid


def dev15(a):
    dec = Decoder(a.ckpt)
    qs = os.path.join(REPO, "experiments", "qwen-sanity")
    corpus = a.set if a.set in ("blind", "holdout") else "suite"
    suite = json.load(open(os.path.join(EVAL, corpus + ".json")))
    if corpus != "suite":  # a whole sealed corpus: headline score only
        want = {s["id"] for s in suite["sessions"]}
    elif a.set == "dev90":   # every suite session outside the screening set
        screen = set(json.load(open(os.path.join(qs, "screen90.json")))["sessions"]["suite"])
        want = {s["id"] for s in suite["sessions"]} - screen
    else:
        want = set(json.load(open(os.path.join(qs, "dev15.json")))["sessions"]["suite"])
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    stream = open(a.out + ".stream.jsonl", "w")
    scored = open(a.out + "-scored.jsonl", "w")
    valid_n = total = 0
    for s in suite["sessions"]:
        if s["id"] not in want:
            continue
        prev = "NONE"
        for i, t in enumerate(s["turns"]):
            t0 = time.time()
            raw, canon, valid = dec(SUITE_TODAY, prev, t["request"])
            ms = round(1000 * (time.time() - t0))
            stream.write(json.dumps({"session": s["id"], "turn": i,
                                     "request": t["request"], "prev": prev,
                                     "raw_text": raw, "gbnf_valid": valid,
                                     "ms": ms}) + "\n"); stream.flush()
            scored.write(json.dumps({"corpus": corpus, "session": s["id"],
                                     "turn": i, "request": t["request"],
                                     "canonical": canon, "prev_used": prev,
                                     "mode": "free", "model": a.ckpt}) + "\n")
            valid_n += valid; total += 1
            print("%s t%d %4dms  %s" % (s["id"], i, ms, canon or "INVALID: " + raw[:80]),
                  flush=True)
            prev = canon or "NONE"
    print("grammar-valid %d/%d" % (valid_n, total))


def heldout(a):
    dec = Decoder(a.ckpt)
    data = rows(a.data or os.path.join(DATA, "distill_val.jsonl"), a.n, 1)
    hit = 0
    for prev, req, tgt, fixed in data:
        today = datetime.date.fromisoformat(fixed) if fixed else DISTILL_TODAY
        _, canon, _ = dec(today, prev, req)
        hit += canon == tgt
    print("heldout exact %d/%d" % (hit, len(data)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("--model", default="ibm-granite/granite-4.0-h-350m")
    ap.add_argument("--rows", type=int, default=4000)
    ap.add_argument("--bs", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out")
    ap.add_argument("--ckpt")
    ap.add_argument("--ckpt-at", default="")
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--vary-years", action="store_true")
    ap.add_argument("--data")
    ap.add_argument("--set", default="dev15", choices=["dev15", "dev90", "blind", "holdout"])
    a = ap.parse_args()
    {"time": time_steps, "train": train, "dev15": dev15, "heldout": heldout}[a.cmd](a)
