#!/usr/bin/env python3
"""Assemble v4: Sonnet session paraphrases (raw/*.jsonl over selected.jsonl) + v3
one-turn rows converted per SPEC §4 -> sessions.jsonl, heldout_sessions.jsonl, STATS.md.

Every assistant line is checked by gbnf.Recognizer(gbnf.rules()).full and
check.parse (the real ones, RelDate terminals included), and every quoted
literal against SPEC §3 (a word span of a user message so far, as typed /
lowercased / first letter capitalised, or a derived check value / default).
"""
import collections, datetime, glob, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sessgen as S  # noqa: E402
G = S.G
check = S.check
import gbnf  # noqa: E402  (v3/gen.py put experiments/toolchat on the path)

REC = gbnf.Recognizer(gbnf.rules())
DERIVED = json.load(open(os.path.join(G.GRAMMAR, "derive", "derived.json")))
CHECKVALS = set()
for kd in DERIVED["predicates"].values():
    for f in kd.values():
        for v in (f.get("checkValues") or []) if isinstance(f, dict) else []:
            CHECKVALS.add(str(v))
# "colleague": the brief's idiom `role contains "colleague"` for "the X I used to work with" (not a user span)
DEFAULTS = {"colleague", "password", "login", "phone", "email", "call", "visit", "message", "coffee", "completed", "Birthday",
            "note", "wifi", "card"}
WD = S.WD
CREATE_ARGS = ("title", "summary", "description", "name", "content", "body")
LEAK = re.compile(r"that \(|ordered by|\bof \(|[{}]|_[a-z]|\b(?:due_at|amount_minor|dtstart|status !=|called \")")
REJ = collections.Counter()


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s:/.-]", " ", s.replace("'", "").replace("\u2019", ""))).strip()


def find_span(lit, msgs):
    """the lit as a word span of any msg (case-insensitive) -> the span as typed, or None"""
    pat = re.compile(r"(?<![\w])" + r"\s+".join(re.escape(w) for w in lit.split()) + r"(?![\w])", re.I)
    for m in reversed(msgs):
        x = pat.search(m)
        if x:
            return x.group(0)
    return None


def lits(tree):
    out = []
    for n in check.walk(tree):
        if n.get("node") == "lit" and n.get("type") == "string":
            out.append(n["value"])
        for k in ("lit",):
            if isinstance(n.get(k), str) and n.get("node") in ("called", "contains"):
                out.append(n[k])
        if n.get("node") == "oneof":
            out.extend(n.get("lits") or [])
    return out


def repair_possessive(canon, msg):
    """'jaspers number' -> "jasper's number" when "Jasper" is a literal of the line"""
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"', canon):
        last = m.group(1).split()[-1] if m.group(1).split() else ""
        if len(last) >= 3 and last.isalpha() and last[0].isupper():
            msg = re.sub(r"(?<![\w'])(%s)s(?!\w)" % re.escape(last), lambda x: x.group(1) + "'s", msg, flags=re.I)
    return msg


def fix_literals(canon, msgs):
    """SPEC §3: re-case each quoted literal to a legal spelling; None when a literal is absent."""
    out = canon
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"', canon):
        lit = m.group(1)
        if lit in CHECKVALS or lit in DEFAULTS:
            continue
        typed = find_span(lit, msgs)
        if typed is None and "'" in lit:
            typed = find_span(lit.replace("'", ""), msgs)
        if typed is None:
            # apostrophe-free match ("jaspers" vs "Jasper's")
            return None
        ok = {typed, typed.lower(), typed[:1].upper() + typed[1:]}
        if lit in ok:
            continue
        pre = canon[max(0, m.start() - 16):m.start()]
        created = any(pre.rstrip().endswith(a + ":") for a in CREATE_ARGS)
        new = typed[:1].upper() + typed[1:] if (created or lit[:1].isupper()) else typed
        out = out.replace('"%s"' % lit, '"%s"' % new, 1)
    return out


NUMW = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
        11: "eleven", 12: "twelve"}


def reldates(tree):
    out = []
    for n in check.walk(tree):
        if n.get("node") == "lit" and n.get("type") == "reldate":
            out.append(n["value"])
        if n.get("node") == "window" and n.get("how") == "reldate":
            out.append(n["value"])
        if n.get("node") == "window" and n.get("how") == "phrase":
            out.append("#" + n["value"])
    return out


def reldate_ok(rels, msg, iso_days, litwords=()):
    low = " " + norm(msg).lower() + " "
    allowed = set(litwords)
    for rd in rels:
        if rd.startswith("#"):
            continue
        day, _, tm = rd.partition(" at ")
        w = day.split()
        if w[0] in ("next", "last"):
            if (" %s %s" % (w[0], w[1])) not in low:
                return "reldate %s" % day
            allowed.add(w[1])
        elif w[0] in WD:
            if (" %s " % w[0]) not in low and (" %ss " % w[0]) not in low:
                return "reldate %s" % day
            if re.search(r"\b(next|last) %s" % w[0], low):
                return "reldate next/last %s" % day
            allowed.add(w[0])
        elif w[0] in ("today", "tomorrow", "yesterday"):
            if w[0] not in low and not (w[0] == "today" and "tonight" in low):
                return "reldate %s" % day
        elif w[0] == "the":
            n = re.match(r"\d+", w[1]).group()
            if not re.search(r"\b%s(st|nd|rd|th)?\b" % n, low):
                return "reldate %s" % day
        elif w[0] == "in":
            n = int(w[1])
            if not re.search(r"\b(%d|%s)\b" % (n, NUMW.get(n, "zzz")), low) or "day" not in low:
                return "reldate %s" % day
        if tm:
            h = int(tm[:2])
            cands = {str(h), "%02d" % h, str(h - 12) if h > 12 else str(h), NUMW.get(h if h <= 12 else h - 12, "zz"),
                     "noon" if h == 12 else "zz", "midday" if h == 12 else "zz"}
            if not any(re.search(r"(?<![\w])%s(?![0-9])" % re.escape(c), low) for c in cands) and \
                    not any(x in low for x in ("half", "quarter", "noon", "midday")):
                return "reldate time %s" % tm
    for d in iso_days:
        if not re.search(r"\b%d(st|nd|rd|th)?\b" % d, low):
            return "iso day"
    wds = {x for x in WD if re.search(r"\b%s\b" % x, low)}
    if not wds <= allowed:
        return "stray weekday"
    return None


def amount_ok(canon, msg):
    for m in re.finditer(r"amount_minor: (\d+)", canon):
        a = int(m.group(1))
        units = a // 100
        low = msg.lower()
        if not (re.search(r"\b%d\b" % units, low) or (units == 0 and str(a) in low) or
                any(w in low for w in ("twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
                                       "hundred", "fifteen", "twelve", "eighteen", "nineteen", "five", "eight", "nine",
                                       "tenner", "quid"))):
            return False
    return True


def valid_line(c):
    if not REC.full(c):
        return "gbnf"
    try:
        check.parse(c)
    except check.ParseError as e:
        return "parse %s" % e
    return S.violates_spec(c)


def check_session(turns, msgs):
    """turns: canonicals; msgs: user messages -> (fixed canonicals, None) or (None, why)"""
    out = []
    for i, (c, u) in enumerate(zip(turns, msgs)):
        if not u or not u.strip():
            return None, "empty"
        if LEAK.search(u):
            return None, "dialect leak"
        u = msgs[i] = repair_possessive(c, u)
        f = fix_literals(c, msgs[:i + 1])
        if f is None:
            return None, "literal absent"
        tree = check.parse(f)
        isod = [int(x) for x in re.findall(r"\b\d{4}-\d\d-(\d\d)", re.sub(r", dtend: [^,}]+", "", f))]
        lw = {x for l in re.findall(r'"([^"]*)"', f) for x in l.lower().split()}
        # dtend is implied (+1h, SPEC §4 H): the user never has to say it
        why = reldate_ok(reldates(check.parse(re.sub(r", dtend: [^,}]+", "", f))), u, isod, lw)
        if why:
            return None, why.split(" ")[0] if why.startswith("reldate") and "time" not in why else why.split(" %")[0]
        m = re.search(r"\(the (\d+)(?:st|nd|rd|th) one\)", f)
        if m:
            n = int(m.group(1))
            ow = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth"}.get(n, "zz")
            if not re.search(r"\b(%s|%s|%d(st|nd|rd|th)?|#%d|no\.? ?%d)\b" % (ow, S.ordn(n), n, n, n) + ("|top one|last one" if n == 1 else ""), u.lower()):
                return None, "ordinal unsaid"
        if not amount_ok(f, u):
            return None, "amount"
        v = valid_line(f)
        if v:
            return None, "invalid: " + v
        out.append(f)
    return out, None


# ---------------------------------------------------------------------------
# v3 one-turn conversion
# ---------------------------------------------------------------------------
def resolve(phrase, today):
    """SPEC §1 resolution of a RelDay"""
    w = phrase.split()
    if w[0] in WD:
        k = (WD.index(w[0]) - today.weekday()) % 7
        return today + datetime.timedelta(days=k or 7)
    if w[0] == "next" and w[1] in WD:
        monday = today - datetime.timedelta(days=today.weekday()) + datetime.timedelta(days=7)
        return monday + datetime.timedelta(days=WD.index(w[1]))
    if w[0] == "last" and w[1] in WD:
        k = (today.weekday() - WD.index(w[1])) % 7
        return today - datetime.timedelta(days=k or 7)
    if w[0] in ("today", "tomorrow", "yesterday"):
        return today + datetime.timedelta(days={"today": 0, "tomorrow": 1, "yesterday": -1}[w[0]])
    if w[0] == "the":
        n = int(re.match(r"\d+", w[1]).group())
        y, m = today.year, today.month
        if n < today.day:
            m += 1
            if m == 13:
                y, m = y + 1, 1
        try:
            return datetime.date(y, m, n)
        except ValueError:
            return None
    if w[0] == "in":
        return today + datetime.timedelta(days=int(w[1]))
    return None


REL_RE = re.compile(r"\b(?:(next|last) )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b|"
                    r"\b(today|tomorrow|yesterday)\b|\bthe (\d{1,2})(?:st|nd|rd|th)\b|\bin (\d{1,2}) days\b", re.I)


def rel_candidates(utt):
    out = []
    for m in REL_RE.finditer(utt.lower()):
        if m.group(2):
            out.append(("%s %s" % (m.group(1), m.group(2))) if m.group(1) else m.group(2))
        elif m.group(3):
            out.append(m.group(3))
        elif m.group(4):
            out.append("the " + S.ordn(int(m.group(4))))
        elif m.group(5):
            out.append("in %s days" % m.group(5))
    return out


def month_named(utt, iso):
    d = datetime.date.fromisoformat(iso)
    return d.strftime("%B").lower() in utt.lower() or d.strftime("%b").lower() + " " in utt.lower() or \
        re.search(r"\b\d{1,2}/\d{1,2}", utt) is not None


def convert_v3(rows, n_refuse_max):
    out, why = [], collections.Counter()
    nref = 0
    for r in rows:
        prev, utt = r["input"].split(" ||| ", 1)
        if prev != "NONE":
            continue
        t = r["target"]
        today = datetime.date.fromisoformat(r["today"])
        if t.startswith("clarify"):
            why["clarify"] += 1
            continue
        if t.startswith("refuse"):
            if nref >= n_refuse_max:
                why["refuse cap"] += 1
                continue
        # capitalise created titles
        t = re.sub(r"\b(title|summary|description|name|content): \"(.)",
                   lambda m: '%s: "%s' % (m.group(1), m.group(2).upper()), t)
        # propose_event: dtend = dtstart + 1h
        if "schedule.propose_event" in t and "dtend" not in t:
            m = re.search(r"dtstart: (\d{4}-\d\d-\d\dT\d\d:\d\d)", t)
            if not m:
                why["propose no time"] += 1
                continue
            e = datetime.datetime.fromisoformat(m.group(1)) + datetime.timedelta(hours=1)
            t = t.replace(m.group(0), m.group(0) + ", dtend: " + e.strftime("%Y-%m-%dT%H:%M"))
        if "people.log_interaction" in t and "since:" not in t:
            why["log without since"] += 1
            continue
        # ISO -> RelDate where the utterance said a matching relative day
        cands = rel_candidates(utt)
        isos = re.findall(r"(?<![\d.])(\d{4}-\d\d-\d\d)(T\d\d:\d\d)?(?![\d.-])", t)
        bad = False
        for d, tm in isos:
            dd = datetime.date.fromisoformat(d)
            hit = [c for c in cands if resolve(c, today) == dd]
            if hit:
                c = hit[0]
                win = re.search(r"during " + re.escape(d + tm), t) is not None
                if win and c in ("today", "tomorrow", "yesterday"):
                    rep = c
                elif win:
                    rep = c
                else:
                    rep = c + (" at " + tm[1:] if tm else "")
                t = t.replace(d + tm, rep, 1)
                why["reldate"] += 1
            elif not month_named(utt, d) and not re.search(r"\b%d(st|nd|rd|th)?\b" % dd.day, utt):
                bad = True
        if bad:
            why["iso unsaid"] += 1
            continue
        t2 = S.normalize(t)
        if t2 is None:
            why["parse"] += 1
            continue
        t = t2
        f, w = check_session([t], [utt])
        if f is None:
            why[w] += 1
            continue
        if t.startswith("refuse"):
            nref += 1
        out.append({"today": r["today"], "utt": utt, "target": f[0], "template_id": r.get("template_id", "v3")})
    return out, why


def sysmsg(today):
    d = datetime.date.fromisoformat(today)
    return "today: %s %s" % (d.strftime("%A"), today)


def skel(c):
    return json.dumps(check.skeleton(check.parse(c)), sort_keys=True)


def main():
    rng = random.Random(4004)
    sel = {}
    for l in open(os.path.join(HERE, "selected.jsonl")):
        r = json.loads(l)
        sel[r["id"]] = r
    replies = {}
    for f in sorted(glob.glob(os.path.join(HERE, "raw", "b*.jsonl"))):
        for l in open(f):
            r = json.loads(l)
            replies[r["id"]] = r["v"]
    train, held = [], []
    moves, tags = collections.Counter(), collections.Counter()
    seen_msgs = set()
    for sid, r in sel.items():
        vs = replies.get(sid)
        if not vs:
            REJ["no reply"] += 1
            continue
        canons = [t["canon"] for t in r["turns"]]
        if len(canons) == 1:
            flat = []
            for x in vs:
                for y in (x if isinstance(x, list) else [x]):
                    if isinstance(y, str) and y not in flat:
                        flat.append(y)
            vs = [[y] for y in flat[:2]]
        for vi, v in enumerate(vs[:2]):
            if not isinstance(v, list) or len(v) != len(canons) or not all(isinstance(x, str) for x in v):
                REJ["shape"] += 1
                continue
            key = tuple(norm(x).lower() for x in v)
            if key in seen_msgs:
                REJ["near-duplicate"] += 1
                continue
            fixed, why = check_session(canons, v)
            if fixed is None:
                REJ[why] += 1
                continue
            seen_msgs.add(key)
            msgs = [{"role": "system", "content": sysmsg(r["today"])}]
            for u, c in zip(v, fixed):
                msgs += [{"role": "user", "content": u.strip()}, {"role": "assistant", "content": c}]
            row = {"id": "%s_%d" % (sid, vi), "today": r["today"], "messages": msgs,
                   "template_id": "v4_%s" % sid}
            row["_moves"] = [t["move"] for t in r["turns"]]
            row["_tags"] = sorted({x for t in r["turns"] for x in t["tags"]})
            (held if r["split"] == "held" else train).append(row)
    n_gen = len(train)
    gen_turns = sum(len(r["_moves"]) for r in train)
    # v3 conversion: refuse up to 3 % of all final turns
    v3rows = [json.loads(l) for l in open(os.path.join(HERE, "..", "v3", "train_v3.stripped.jsonl"))]
    rng.shuffle(v3rows)
    gen_ref = sum(1 for r in train for m in r["messages"] if m["role"] == "assistant" and m["content"].startswith("refuse"))
    conv, cwhy = convert_v3(v3rows, 10 ** 9)
    conv_nonref = [c for c in conv if not c["target"].startswith("refuse")]
    conv_ref = [c for c in conv if c["target"].startswith("refuse")]
    hseqs = {tuple(skel(m["content"]) for m in r["messages"] if m["role"] == "assistant") for r in held}
    conv_nonref = [c for c in conv_nonref if (skel(c["target"]),) not in hseqs]
    take_non = conv_nonref[:1500]
    total_turns = gen_turns + len(take_non)
    ref_budget = max(0, int(0.03 * (total_turns + 60)) - gen_ref)
    take_ref = conv_ref[:ref_budget]
    take = take_non[:1500 - len(take_ref)] + take_ref
    for i, c in enumerate(take):
        train.append({"id": "c%04d" % i, "today": c["today"], "messages": [
            {"role": "system", "content": sysmsg(c["today"])}, {"role": "user", "content": c["utt"]},
            {"role": "assistant", "content": c["target"]}], "template_id": c["template_id"], "_moves": ["first"],
            "_tags": ["v3conv"]})
    # held-out: no session skeleton sequence may appear in train
    tseqs = {tuple(skel(m["content"]) for m in r["messages"] if m["role"] == "assistant") for r in train}
    held = [r for r in held if tuple(skel(m["content"]) for m in r["messages"] if m["role"] == "assistant") not in tseqs]
    # final validation with the real recognizer + parser
    for r in train + held:
        for m in r["messages"]:
            if m["role"] == "assistant":
                assert REC.full(m["content"]), m["content"]
                check.parse(m["content"])
    rng.shuffle(train)
    with open(os.path.join(HERE, "sessions.jsonl"), "w") as o:
        for r in train:
            o.write(json.dumps({k: r[k] for k in ("id", "today", "messages", "template_id")}) + "\n")
    with open(os.path.join(HERE, "heldout_sessions.jsonl"), "w") as o:
        for r in held:
            o.write(json.dumps({k: r[k] for k in ("id", "today", "messages", "template_id")}) + "\n")
    stats(train, held, n_gen, cwhy, len(take_ref))


def stats(train, held, n_gen, cwhy, n_conv_ref):
    gen = [r for r in train if not r["id"].startswith("c")]
    conv = [r for r in train if r["id"].startswith("c")]
    asst = [m["content"] for r in train for m in r["messages"] if m["role"] == "assistant"]
    tc = collections.Counter(min(len(r["_moves"]), 5) for r in gen)
    mv = collections.Counter(m for r in gen for m in r["_moves"][1:])
    tg = collections.Counter(t for r in gen for t in r["_tags"])
    nref = sum(1 for a in asst if a.startswith("refuse"))
    nrel = 0
    for a in asst:
        if reldates(check.parse(a)) and any(not x.startswith("#") for x in reldates(check.parse(a))):
            nrel += 1
    sk = {skel(a) for a in asst}
    calls = len(open(os.path.join(HERE, "raw", "calls.log")).read().split("\n")) - 1
    L = ["# v4 STATS", "", "Built by `sessgen.py` (canonical sessions) -> `select_batches.py` (selection, Sonnet batches) -> "
         "`run.sh` (Sonnet, PROMPT_V4.md) -> `build_v4.py` (checks, v3 conversion, this file).", "",
         "| | count |", "|---|---|",
         "| sessions (sessions.jsonl) | %d |" % len(train),
         "| generated sessions | %d |" % len(gen), "| converted v3 one-turn sessions | %d |" % len(conv),
         "| (v3 rows with an ISO date rewritten to a RelDate: see conversion table, `reldate`) | |",
         "| assistant turns (all) | %d |" % len(asst),
         "| assistant turns (generated) | %d |" % sum(len(r["_moves"]) for r in gen),
         "| held-out sessions | %d |" % len(held),
         "| refuse share of turns | %.1f%% (%d; %d converted) |" % (100 * nref / len(asst), nref, n_conv_ref),
         "| turns with a RelDate | %.1f%% (%d) |" % (100 * nrel / len(asst), nrel),
         "| clarify turns | %d |" % sum(1 for a in asst if a.startswith("clarify")),
         "| unique turn skeletons (literals masked) | %d |" % len(sk),
         "| unique session skeleton sequences | %d |" % len({tuple(skel(m["content"]) for m in r["messages"] if m["role"] == "assistant") for r in train}),
         "| Sonnet calls | %d |" % calls, "",
         "## Turn-count mix (generated sessions)", "", "| turns | sessions | share |", "|---|---|---|"]
    for k in sorted(tc):
        L.append("| %s | %d | %.1f%% |" % ("5-6" if k == 5 else k, tc[k], 100 * tc[k] / len(gen)))
    L += ["", "## Follow-up moves (turns after the first, generated sessions)", "", "| move | turns | share |", "|---|---|---|"]
    tot = sum(mv.values())
    for k, v in mv.most_common():
        L.append("| %s | %d | %.1f%% |" % (k, v, 100 * v / tot))
    L += ["", "## Idioms and refs (generated sessions containing each)", "", "| tag | sessions |", "|---|---|"]
    for k, v in sorted(tg.items(), key=lambda x: -x[1]):
        L.append("| %s | %d |" % (k, v))
    L += ["", "## Paraphrase rejects (per session variant)", "", "| reason | count |", "|---|---|"]
    for k, v in REJ.most_common():
        L.append("| %s | %d |" % (k, v))
    L += ["", "## v3 conversion (rows dropped / rewritten)", "", "| reason | count |", "|---|---|"]
    for k, v in cwhy.most_common():
        L.append("| %s | %d |" % (k, v))
    open(os.path.join(HERE, "STATS.md"), "w").write("\n".join(L) + "\n")
    print("\n".join(L[:20]))


if __name__ == "__main__":
    main()
