#!/usr/bin/env python3
"""Assemble v5: Sonnet phrasings (raw/b5_*.jsonl over selected5.jsonl) + all v4 sessions,
each with a SYNTHETIC vault (vault.py) and every user message rendered with
retrieve.render (SPEC section 5) -> sessions.jsonl, heldout_sessions.jsonl, STATS.md.

Checks per assistant line: gbnf.Recognizer(gbnf.rules()).full, check.parse, SPEC §4
(violates_spec), and every quoted literal legal under §3+§5: a word span of a user
request so far (as typed / lowercased / first letter capitalised), a candidate label
shown so far (exactly), a derived checkValue, or a §3 default (incl. "colleague").
"""
import collections, glob, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "v4"))
import build_v4 as B  # noqa: E402
import cells as CELLS  # noqa: E402
import retrieve as R  # noqa: E402
import vault as V  # noqa: E402
import pools5 as P5  # noqa: E402

S, check, REC = B.S, B.check, B.REC
REJ = collections.Counter()
KSHOW = {"members": "parties", "albums": "album_titles", "notebooks": "notebooks"}
VKINDS = {"events", "tasks", "notes", "journal notes", "documents", "parties", "members", "photos", "albums", "places",
          "expenses", "groups", "locker items", "projects", "circles", "accounts", "notebooks"}
CALLED_RE = re.compile(r'\b(journal notes|locker items|events|tasks|notes|documents|parties|members|photos|albums|places|'
                       r'expenses|groups|projects|circles|accounts|notebooks|things) called "((?:[^"\\]|\\.)*)"')
FIELD_RE = re.compile(r'\b(folder|notebooks|album_titles|role|place) (=|contains) "((?:[^"\\]|\\.)*)"')


def vkind(k):
    return KSHOW.get(k, k)


def word_in(w, msg):
    return re.search(r"(?<![\w])" + r"\s+".join(re.escape(x) for x in w.split()) + r"(?![\w])", msg, re.I) is not None


# ---------------------------------------------------------------------------
def legal_literals(canon, reqs, shown):
    """SPEC §3+§5: re-case each literal that is a user span; None if any literal is illegal."""
    out = canon
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"', canon):
        lit = m.group(1)
        if lit in B.CHECKVALS or lit in B.DEFAULTS or lit in shown:
            continue
        typed = B.find_span(lit, reqs)
        if typed is None:
            return None
        ok = {typed, typed.lower(), typed[:1].upper() + typed[1:]}
        if lit in ok:
            continue
        pre = canon[max(0, m.start() - 16):m.start()]
        created = any(pre.rstrip().endswith(a + ":") for a in B.CREATE_ARGS)
        new = typed[:1].upper() + typed[1:] if (created or lit[:1].isupper()) else typed
        out = out.replace('"%s"' % lit, '"%s"' % new, 1)
    return out


def check_turns(canons, reqs, rendered):
    """-> (fixed canonicals, None) or (None, why)"""
    out = []
    shown = set()
    for i, (c, u) in enumerate(zip(canons, reqs)):
        if not u or not u.strip():
            return None, "empty"
        if B.LEAK.search(u):
            return None, "dialect leak"
        shown |= set(R.shown_labels(rendered[i]))
        f = legal_literals(c, reqs[:i + 1], shown)
        if f is None:
            return None, "literal illegal"
        isod = [int(x) for x in re.findall(r"\b\d{4}-\d\d-(\d\d)", re.sub(r", dtend: [^,}]+", "", f))]
        lw = {x for l in re.findall(r'"([^"]*)"', f) for x in l.lower().split()}
        why = B.reldate_ok(B.reldates(check.parse(re.sub(r", dtend: [^,}]+", "", f))), u, isod, lw)
        if why:
            return None, why.split(" ")[0] if why.startswith("reldate") and "time" not in why else why.split(" %")[0]
        m = re.search(r"\(the (\d+)(?:st|nd|rd|th) one\)", f)
        if m:
            n = int(m.group(1))
            ow = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth"}.get(n, "zz")
            if not re.search(r"\b(%s|%s|%d(st|nd|rd|th)?|#%d|no\.? ?%d)\b" % (ow, S.ordn(n), n, n, n) +
                             ("|top one|last one" if n == 1 else ""), u.lower()):
                return None, "ordinal unsaid"
        if not B.amount_ok(f, u):
            return None, "amount"
        v = B.valid_line(f)
        if v:
            return None, "invalid: " + v
        out.append(f)
    return out, None


def render_session(r, U, reqs, canons, targets, misses):
    """targets: [(vkind, label, turn)], misses: [(vkind, kw)] -> (rendered msgs, vault) or (None, why)"""
    v = V.make_vault(r, U, [(k, l) for k, l, _ in targets], misses, reqs)
    prev = [None] + reqs[:-1]  # SPEC 5.1: the previous USER message's raw text
    for k, lab, t in targets:
        v = V.settle_target(v, k, lab, reqs[t], prev=prev[t], r=r)
        if v is None:
            return None, "target not retrievable"
    cands = [R.candidates(q, v, prev=p) for q, p in zip(reqs, prev)]
    rendered = [R.render(q, c) for q, c in zip(reqs, cands)]
    for k, lab, t in targets:
        if not any(V.ekind(e) == k and e["label"] == lab for e in cands[t]):
            return None, "target not in candidates"
    for k, kw in misses:
        for cs in cands:
            for e in cs:
                if V.ekind(e) == k and V.covers(e["label"], kw):
                    return None, "miss row shown"
    return rendered, v


def sysmsg(today):
    return B.sysmsg(today)


def skel(c):
    return B.skel(c)


def session_row(sid, today, reqs, rendered, fixed, tid, meta):
    msgs = [{"role": "system", "content": sysmsg(today)}]
    for u, c in zip(rendered, fixed):
        msgs += [{"role": "user", "content": u}, {"role": "assistant", "content": c}]
    row = {"id": sid, "today": today, "messages": msgs, "template_id": tid}
    row["_meta"] = meta
    return row


# ---------------------------------------------------------------------------
# new sessions (part a/b)
# ---------------------------------------------------------------------------
def build_new(U, rng):
    sel = [json.loads(l) for l in open(os.path.join(HERE, "selected5.jsonl"))]
    replies = {}
    for f in sorted(glob.glob(os.path.join(HERE, "raw", "b5_*.jsonl"))):
        for l in open(f):
            x = json.loads(l)
            replies[x["id"]] = x["v"]
    rows = []
    seen = set()
    for r in sel:
        vs = replies.get(r["id"])
        if not vs:
            REJ["no reply"] += 1
            continue
        canons = [t["canon"] for t in r["turns"]]
        for vi, v in enumerate(vs[:r["nver"]]):
            if not isinstance(v, list) or len(v) != len(canons) or not all(isinstance(x, str) for x in v):
                REJ["shape"] += 1
                continue
            reqs = [x.strip() for x in v]
            key = tuple(B.norm(x).lower() for x in reqs)
            if key in seen:
                REJ["near-duplicate"] += 1
                continue
            bad = None
            targets, misses = [], []
            for ref in r["refs"]:
                msg = reqs[ref["turn"]] if ref["turn"] < len(reqs) else ""
                m = ref["mode"]
                if m in ("span", "loose") and not word_in(ref["kw"], msg):
                    bad = "refer word unsaid"
                elif m == "loose" and word_in(ref["label"], msg) and ref["label"].lower() != ref["kw"].lower():
                    bad = "loose said full title"
                elif m == "full" and not word_in(ref["label"], msg):
                    bad = "full title unsaid"
                if bad:
                    break
                if m in ("span", "loose", "full"):
                    targets.append((ref["kind"], ref["label"], ref["turn"]))
                elif m == "miss":
                    misses.append((ref["kind"], ref["kw"]))
            if bad:
                REJ[bad] += 1
                continue
            rr = random.Random("%s/%d" % (r["id"], vi))
            rendered, why = render_session(rr, U, reqs, canons, targets, misses)
            if rendered is None:
                REJ[why] += 1
                continue
            fixed, why = check_turns(canons, reqs, rendered)
            if fixed is None:
                REJ[why] += 1
                continue
            seen.add(key)
            unsaid = any(m_ in ("span", "loose") for m_ in (x["mode"] for x in r["refs"]))
            meta = {"src": "new_" + r["part"], "cell": r["cell"], "label_unsaid": unsaid,
                    "label_target": bool(targets), "miss": bool(misses) or any(x["mode"] == "things" for x in r["refs"]),
                    "moves": [t["move"] for t in r["turns"]], "named": bool(r["refs"])}
            rows.append(session_row("%s_%d" % (r["id"], vi), r["today"], reqs, rendered, fixed, "v5_%s" % r["id"], meta))
    return rows


# ---------------------------------------------------------------------------
# v4 sessions: synthetic vault, some literals rewritten to invented vault labels
# ---------------------------------------------------------------------------
SUFFIX = {
    "tasks": [" paperwork", " follow-up", " (urgent)", " for {first}", " at {place}", " properly"],
    "events": [" with {first}", " at {place}", " catch-up", " session", " (week {n})"],
    "notes": [" notes", " ideas", " list", " plan", " draft"],
    "journal notes": [" with {first}", " (long chat)", " reflections"],
    "documents": [" scan", " copy", " 2026", " letter", " (signed)"],
    "photos": [" at {place}", " at dusk", " close-up", " from above"],
    "groups": [" crew", " fund", " 2027", " kitty", " gang"],
    "locker items": [" backup", " (old)", " account", " 2027"],
    "expenses": [" deposit", " refund", " split", " (cash)"],
    "places": [" Gardens", " Market", " Quay", " Studio"],
    "album_titles": [" 2025", " highlights", " 2027", " (best)"],
    "notebooks": [" log", " notes", " 2027"],
    "projects": [" 2027", " (phase 2)"], "circles": [" crowd", " (old)"], "accounts": [" (joint)", " 2027"],
}


def invent(k, lit, r, U):
    if k == "parties":
        if len(lit.split()) == 1:
            return lit[:1].upper() + lit[1:] + " " + r.choice(P5.LAST)
        return lit
    pool = [x for x in (U.U.get(k, []) + [S.cap(y) for y in P5.POOL.get(k, [])])
            if word_in(lit, x) and x.lower() != lit.lower() and not re.search(r"\(\d\d\)$", x)]
    if pool and r.random() < 0.5:
        return r.choice(sorted(set(pool)))
    suf = r.choice(SUFFIX.get(k, [" 2027"])).format(first=r.choice(P5.FIRST), place=r.choice(P5.POOL["places"]),
                                                   n=r.randint(1, 9))
    return S.cap(lit) + suf


def lits_of(canon):
    out = []
    for m in CALLED_RE.finditer(canon):
        out.append(("called", m.group(1), m.group(2)))
    for m in FIELD_RE.finditer(canon):
        out.append((m.group(2), m.group(1), m.group(3)))
    return out


def convert_v4(path, U, prefix, rewrite_p=0.72):
    rows = []
    for line in open(path):
        r0 = json.loads(line)
        ms = r0["messages"]
        reqs = [m["content"] for m in ms if m["role"] == "user"]
        canons = [m["content"] for m in ms if m["role"] == "assistant"]
        rr = random.Random("v4/" + r0["id"])
        has_same = any(c.startswith("same?") for c in canons)
        plan = {}  # (vk, lit_lower) -> (label or None, first turn)
        for ti, c in enumerate(canons):
            for how, k, lit in lits_of(c):
                if k == "things" or lit in B.DEFAULTS or lit in B.CHECKVALS:
                    continue
                vk = "places" if k == "place" else vkind(k)
                key = (vk, lit.lower())
                if key in plan:
                    continue
                # the earliest request that says the literal
                t = next((i for i in range(ti + 1) if B.find_span(lit, [reqs[i]])), ti)
                if how == "=":  # exact-value fields: the value itself is the vault label
                    plan[key] = (S.cap(lit) if vk != "places" else lit, t, how)
                elif not has_same and rr.random() < rewrite_p:
                    plan[key] = (invent(vk, lit, rr, U), t, how)
                else:
                    plan[key] = (None, t, how)
        attempt = [plan, {k: (None if v[2] != "=" else v[0], v[1], v[2]) for k, v in plan.items()}]
        done = False
        for pi, pl in enumerate(attempt):
            new = []
            for c in canons:
                def sub_called(m):
                    k, lit = m.group(1), m.group(2)
                    key = (vkind(k), lit.lower())
                    if key in pl and pl[key][0]:
                        return '%s called "%s"' % (k, pl[key][0])
                    return m.group(0)

                def sub_field(m):
                    f, op, lit = m.group(1), m.group(2), m.group(3)
                    key = ("places" if f == "place" else vkind(f), lit.lower())
                    if key in pl and pl[key][0]:
                        return '%s %s "%s"' % (f, op, pl[key][0])
                    return m.group(0)
                new.append(FIELD_RE.sub(sub_field, CALLED_RE.sub(sub_called, c)))
            targets = [(k[0], v[0], v[1]) for k, v in pl.items() if v[0]]
            misses = [(k, lit) for (k, lit), v in pl.items() if not v[0]]
            rendered, why = render_session(rr, U, reqs, new, targets, misses)
            if rendered is None:
                REJ["v4 " + why + (" (retry)" if pi == 0 else "")] += 1
                continue
            fixed, why = check_turns(new, reqs, rendered)
            if fixed is None:
                REJ["v4 " + why + (" (retry)" if pi == 0 else "")] += 1
                continue
            unsaid = any(v[0] and not B.find_span(v[0], reqs) for v in pl.values())
            meta = {"src": prefix, "cell": None, "label_unsaid": unsaid, "label_target": bool(targets),
                    "miss": bool(misses), "moves": None, "named": bool(pl)}
            rows.append(session_row(r0["id"], r0["today"], reqs, rendered, fixed, r0.get("template_id", "v4"), meta))
            done = True
            break
        if not done:
            REJ["v4 dropped"] += 1
    return rows


# ---------------------------------------------------------------------------
def main():
    U = V.Universe()
    rng = random.Random(5151)
    new = build_new(U, rng)
    v4 = convert_v4(os.path.join(HERE, "..", "v4", "sessions.stripped.jsonl"), U, "v4")
    v4h = convert_v4(os.path.join(HERE, "..", "v4", "heldout_sessions.stripped.jsonl"), U, "v4_held")

    def seq(r):
        return tuple(skel(m["content"]) for m in r["messages"] if m["role"] == "assistant")
    # held-out: v4's held-out + new multi-turn sessions whose skeleton sequence occurs once in the pool
    newb = [r for r in new if r["_meta"]["src"] == "new_b"]
    cnt = collections.Counter(seq(r) for r in new + v4)
    tid_seq = collections.defaultdict(set)
    for r in new + v4:
        tid_seq[r["template_id"]].add(seq(r))
    cand = sorted({r["template_id"] for r in newb if all(cnt[s] == sum(1 for x in newb if x["template_id"] == r["template_id"] and seq(x) == s) for s in tid_seq[r["template_id"]])})
    rng.shuffle(cand)
    held_t = set(cand[:26])
    held = v4h + [r for r in new if r["template_id"] in held_t]
    train = [r for r in new + v4 if r["template_id"] not in held_t]
    tseqs = {seq(r) for r in train}
    nh = len(held)
    held = [r for r in held if seq(r) not in tseqs]
    REJ["held-out dropped (skeleton in train)"] += nh - len(held)
    # final validation with the real recognizer + parser
    for r in train + held:
        for m in r["messages"]:
            if m["role"] == "assistant":
                assert REC.full(m["content"]), m["content"]
                check.parse(m["content"])
    rng.shuffle(train)
    for name, rows in (("sessions.jsonl", train), ("heldout_sessions.jsonl", held)):
        with open(os.path.join(HERE, name), "w") as o:
            for r in rows:
                o.write(json.dumps({k: r[k] for k in ("id", "today", "messages", "template_id")}) + "\n")
    stats(train, held, v4)


def stats(train, held, v4):
    import cells as C
    before = collections.Counter()
    for l in open(os.path.join(HERE, "..", "v4", "sessions.stripped.jsonl")):
        for m in json.loads(l)["messages"]:
            if m["role"] == "assistant":
                before.update(C.cells(m["content"]))
    after = collections.Counter()
    for r in train:
        for m in r["messages"]:
            if m["role"] == "assistant":
                after.update(C.cells(m["content"]))
    # candidate hit rates
    turns = [(r, i) for r in train for i, m in enumerate(r["messages"]) if m["role"] == "user"]
    with_line = sum(1 for r, i in turns if "\nvault: " in r["messages"][i]["content"])
    ncand = collections.Counter(len(R.shown_labels(r["messages"][i]["content"])) for r, i in turns)
    lit_turns = lab_turns = 0
    for r in train:
        shown = set()
        for i, m in enumerate(r["messages"]):
            if m["role"] == "user":
                shown |= set(R.shown_labels(m["content"]))
            elif m["role"] == "assistant":
                ls = [x for x in re.findall(r'"((?:[^"\\]|\\.)*)"', m["content"]) if x not in B.DEFAULTS and x not in B.CHECKVALS]
                named = [x for x in CALLED_RE.findall(m["content"])] + FIELD_RE.findall(m["content"])
                if named:
                    lit_turns += 1
                    if any(x in shown for x in ls):
                        lab_turns += 1
    first_rank = collections.Counter()
    for r in train:
        reqs = [m for m in r["messages"] if m["role"] == "user"]
        asst = [m for m in r["messages"] if m["role"] == "assistant"]
        for u, a in zip(reqs, asst):
            sl = R.shown_labels(u["content"])
            for x in re.findall(r'called "((?:[^"\\]|\\.)*)"', a["content"]):
                if x in sl:
                    first_rank[min(sl.index(x) + 1, 6)] += 1
    n = len(train)
    src = collections.Counter(r["_meta"]["src"] for r in train)
    unsaid = sum(1 for r in train if r["_meta"]["label_unsaid"])
    labt = sum(1 for r in train if r["_meta"]["label_target"])
    miss = sum(1 for r in train if r["_meta"]["miss"])
    named = sum(1 for r in train if r["_meta"]["named"])
    calls = len([l for l in open(os.path.join(HERE, "raw", "calls.log")) if l.strip()])
    asst = [m["content"] for r in train for m in r["messages"] if m["role"] == "assistant"]
    L = ["# v5 STATS", "",
         "Built by `gen5.py` (canonical sessions for the under-covered cells, COVERAGE.md) -> `make_batches5.py` -> "
         "`run.sh` (Sonnet, PROMPT_V5.md) -> `build5.py` (synthetic vaults via `vault.py`, rendering via `retrieve.py`, "
         "checks, v4 conversion, this file).", "",
         "| | count |", "|---|---|",
         "| train sessions (sessions.jsonl) | %d |" % n,
         "| - new single/two-turn (part a) | %d |" % src["new_a"],
         "| - new multi-turn (part b) | %d |" % src["new_b"],
         "| - v4 sessions re-rendered | %d (of %d) |" % (src["v4"], sum(1 for _ in open(os.path.join(HERE, "..", "v4", "sessions.stripped.jsonl")))),
         "| held-out sessions | %d (v4 held-out %d, new %d) |" % (len(held), sum(1 for r in held if r["_meta"]["src"] == "v4_held"),
                                                              sum(1 for r in held if r["_meta"]["src"] != "v4_held")),
         "| assistant turns (train) | %d |" % len(asst),
         "| unique session skeleton sequences (train) | %d |" % len({tuple(skel(m["content"]) for m in r["messages"] if m["role"] == "assistant") for r in train}),
         "| sessions naming a stored row | %d (%.1f%%) |" % (named, 100 * named / n),
         "| sessions whose target literal is a vault label | %d (%.1f%%) |" % (labt, 100 * labt / n),
         "| sessions whose target is a vault label the user did NOT say verbatim | %d (%.1f%%) |" % (unsaid, 100 * unsaid / n),
         "| sessions with a named row ABSENT from the vault/candidates (user's words written) | %d (%.1f%%) |" % (miss, 100 * miss / n),
         "| user turns with a `vault:` line | %d / %d (%.1f%%) |" % (with_line, len(turns), 100 * with_line / len(turns)),
         "| assistant turns naming a row (called / field value) | %d |" % lit_turns,
         "| - of which the literal is a shown candidate label (candidate hit) | %d (%.1f%%) |" % (lab_turns, 100 * lab_turns / max(1, lit_turns)),
         "| refuse share of turns | %.1f%% |" % (100 * sum(1 for a in asst if a.startswith("refuse")) / len(asst)),
         "| Sonnet calls (raw/calls.log) | %d |" % calls, "",
         "## Candidates shown per user turn", "", "| candidates | turns |", "|---|---|"]
    for k in sorted(ncand):
        L.append("| %d | %d |" % (k, ncand[k]))
    L += ["", "## Rank of the written label among the shown candidates (`called` literals)", "", "| rank | turns |", "|---|---|"]
    for k in sorted(first_rank):
        L.append("| %d | %d |" % (k, first_rank[k]))
    L += ["", "## Coverage cells (assistant turns containing the cell): v4 before -> v5 after", "",
          "Cells are the executor-supported (kind x construct) cells of COVERAGE.md.", "",
          "| cell | v4 | v5 | |", "|---|---|---|---|"]
    for c in sorted(C.TARGET):
        L.append("| %s | %d | %d | %s |" % (c, before[c], after[c], "" if after[c] >= 15 else
                                           ("<15, not generated (COVERAGE.md s.4)" if c in C.NOT_GENERATED else "**<15**")))
    L += ["", "## Rejects", "", "| reason | count |", "|---|---|"]
    for k, v in REJ.most_common():
        L.append("| %s | %d |" % (k, v))
    open(os.path.join(HERE, "STATS.md"), "w").write("\n".join(L) + "\n")
    print("\n".join(L[:26]))


if __name__ == "__main__":
    main()
