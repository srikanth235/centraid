"""Training set v2: distill.jsonl repaired against the executor, plus copies
that teach relative dates and name copying, plus the missing commands.

Row format is distill.jsonl's, with an optional "today" (ISO date). No row is
derived from the evaluation suite; the leakage gate runs afterwards.
"""
import collections, datetime, json, os, random, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "..", "canon-model", "data")
sys.path.insert(0, DATA); sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "crates", "evalsuite", "grammar"))
import distill_world as W, gbnf, lexicon as L

rng = random.Random(5)
REC = gbnf.Recognizer(gbnf.rules())
ARMS = json.load(open("/tmp/claude-0/-home-user-centraid/f31227f9-ca10-5f19-9c12-db2b239388c1/scratchpad/arms.json"))
WORLD_TODAY = datetime.date(2027, 2, 13)
stats = collections.Counter()

# -- 1. repair argument names the executor never reads ---------------------
def repair(c):
    c = re.sub(r'schedule\.edit_task\{ due_at: ([^,}]+) \}', r'schedule.edit_task{ to: \1 }', c)
    c = re.sub(r'schedule\.reschedule_event\{ dtstart: ([^,}]+) \}', r'schedule.reschedule_event{ to: \1 }', c)
    c = re.sub(r'schedule\.reschedule_event\{ shift: ([^,}]+) \}', r'schedule.reschedule_event{ by: \1 }', c)
    c = re.sub(r'media\.add_to_album\{ album: ("[^"]*") \}', r'media.add_to_album{ album_id: (albums called \1) }', c)
    m = re.fullmatch(r'tally\.add_group_member\{ party: ("[^"]*") \} on (.+)', c)
    if m:
        c = 'tally.add_group_member{ group_id: (%s) } on (parties called %s)' % (m.group(2), m.group(1))
    return c

def allowed(v):
    if v in L.VERB_CLASSES:
        return [set(ARMS[x]) for x in L.VERB_CLASSES[v].values() if x in ARMS] or None
    return [set(ARMS[v])] if v in ARMS else None

def executable(c):
    for v, a in re.findall(r'(?:^|then )([a-z_.]+)\{([^}]*)\}', c):
        ok = allowed(v)
        if ok is None:
            return False
        names = set(re.findall(r'([a-z_]+)\s*:', re.sub(r'"[^"]*"|\([^)]*\)', '', a)))
        if not any(names <= s for s in ok):
            return False
    return True

# -- 2. swap quoted names so the model must copy, not recall -----------------
POOLS = {"parties": None, "members": None, "profiles": None,
         "groups": W.GROUPS + W.TRIPS, "tasks": W.TASK_TITLES, "events": W.EVENT_TITLES,
         "notes": W.NOTE_TITLES, "documents": W.DOC_TITLES, "photos": W.PHOTO_TITLES,
         "albums": W.ALBUM_TITLES, "items": W.LOCKER_TITLES, "places": W.PLACES}
ALL_TITLES = sum((v for v in POOLS.values() if v), [])
EXTRA = ["Blue shed key", "Spring fair stall", "Garage roof quote", "Pond pump",
         "Allotment rota", "Choir summer trip", "Bike lock spare", "Loft ladder",
         "Rent review", "Harbour swim club", "Quiz night kitty", "Van hire"]

def novel(kind):
    if kind in ("parties", "members", "profiles"):
        f, l = rng.choice(W.FIRST), rng.choice(W.LAST)
        return rng.choice(["%s %s" % (f, l), f, "%s %s" % (f, l)])
    pool = POOLS.get(kind)
    return rng.choice(pool if pool and rng.random() < 0.6 else ALL_TITLES + EXTRA)

def recase(occ, new):
    return new.lower() if occ.islower() else new.upper() if occ.isupper() else new

def swap(prev, req, tgt):
    for kind, lit in re.findall(r'([a-z]+) called "([^"]+)"', tgt) + \
            [("tasks", x) for x in re.findall(r'title: "([^"]+)"', tgt)]:
        m = re.search(re.escape(lit), req, re.I)
        if not m or len(lit) < 3:
            continue
        new = novel(kind)
        if new.lower() == lit.lower():
            continue
        req = req[:m.start()] + recase(m.group(0), new) + req[m.end():]
        req = re.sub(re.escape(lit), lambda x: recase(x.group(0), new), req, flags=re.I)
        tgt = tgt.replace('"%s"' % lit, '"%s"' % new)
        prev = prev.replace('"%s"' % lit, '"%s"' % new)
    return prev, req, tgt

# -- 3. relative dates: an explicit date in the request becomes "friday" ----
MON = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
PHRASES = [
    (re.compile(r"\b(20\d\d)-(\d\d)-(\d\d)\b"), lambda m: (int(m[1]), int(m[2]), int(m[3]))),
    (re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})\b"),
     lambda m: ((int(m[3]) + 2000) if len(m[3]) == 2 else int(m[3]), int(m[2]), int(m[1]))),
    (re.compile(r"\b(%s)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)\b" % MON, re.I),
     lambda m: (int(m[3]), MONTHS.index(m[1][:3].lower()) + 1, int(m[2]))),
    (re.compile(r"\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(%s)\.?,?\s+(20\d\d)\b" % MON, re.I),
     lambda m: (int(m[3]), MONTHS.index(m[2][:3].lower()) + 1, int(m[1]))),
]

def ordinal(n):
    return "%d%s" % (n, "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))

def relative(prev, req, tgt):
    if re.search(r"\d{4}-\d\d", prev):
        return None
    dates = set(re.findall(r"\b(\d{4}-\d\d-\d\d)", tgt))
    if len(dates) != 1 or re.search(r"\b\d{4}-\d\d\b(?!-)", tgt):
        return None
    target = datetime.date.fromisoformat(dates.pop())
    found = []
    for rx, conv in PHRASES:
        for m in rx.finditer(req):
            try:
                found.append((m.start(), m.end(), datetime.date(*conv(m))))
            except ValueError:
                return None
    if len(found) != 1 or found[0][2] != target:
        return None
    s, e, _ = found[0]
    if rng.random() < 0.65:
        back = rng.randint(1, 6)
        wd = target.strftime("%A")
        phrase = rng.choice([wd.lower(), wd.lower(), wd, "this " + wd.lower()])
    else:
        if target.day < 3:
            return None
        back = rng.randint(1, target.day - 1)
        phrase = "the " + ordinal(target.day)
    today = target - datetime.timedelta(days=back)
    return today.isoformat(), req[:s] + phrase + req[e:]

# -- build -------------------------------------------------------------------
out = []
for line in open(os.path.join(DATA, "distill.jsonl")):
    r = json.loads(line)
    prev, req = r["input"].split(" ||| ", 1)
    tgt, prev = repair(r["target"]), repair(prev)
    if tgt != r["target"]:
        stats["args repaired"] += 1
    if not executable(tgt):
        stats["dropped: not executable"] += 1
        continue
    if not REC.full(tgt):
        stats["dropped: repair broke grammar"] += 1
        continue
    if rng.random() < 0.5:
        p2, q2, t2 = swap(prev, req, tgt)
        if t2 != tgt:
            stats["names swapped"] += 1
            prev, req, tgt = p2, q2, t2
    out.append({"prev": prev, "req": req, "target": tgt})
    rel = relative(prev, req, tgt)
    if rel:
        stats["relative-date copy"] += 1
        out.append({"prev": prev, "req": rel[1], "target": tgt, "today": rel[0]})

tasks = {}
for f in sorted(os.listdir(os.path.join(HERE, "batches"))):
    for t in json.load(open(os.path.join(HERE, "batches", f))):
        tasks[t["id"]] = t
for f in sorted(os.listdir(os.path.join(HERE, "out"))):
    if not f.endswith(".jsonl"):
        continue
    for line in open(os.path.join(HERE, "out", f)):
        g = json.loads(line)
        t = tasks[g["id"]]
        for u in g["u"]:
            if "{" in u or "}" in u:
                continue
            for lit in re.findall(r'title: "([^"]+)"', t["target"]):
                if lit.lower() not in u.lower():
                    break
            else:
                for _ in range(3):   # upsampled: a few hundred rows against 40k
                    stats["new-command rows"] += 1
                    row = {"prev": t["prev"], "req": u, "target": t["target"]}
                    out.append(row)
                rel = relative(t["prev"], u, t["target"])
                if rel:
                    stats["relative-date copy"] += 1
                    out.append({"prev": t["prev"], "req": rel[1], "target": t["target"], "today": rel[0]})

rng.shuffle(out)
with open(os.path.join(HERE, "train_v2.jsonl"), "w") as fh:
    for r in out:
        row = {"input": "%s ||| %s" % (r["prev"], r["req"]), "target": r["target"]}
        if "today" in r:
            row["today"] = r["today"]
        fh.write(json.dumps(row) + "\n")
for k, v in stats.items():
    print("%-28s %d" % (k, v))
print("rows", len(out))
