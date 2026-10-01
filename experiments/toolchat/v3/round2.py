"""Round 2: weekday resolution and verbatim copying, built by rewriting
train_v3.stripped rows. Targets are never re-derived: a weekday row keeps its
target and moves `today`; a copy row swaps one literal in request, prev and
target together."""
import datetime, json, os, random, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import gbnf, pools
REC = gbnf.Recognizer(gbnf.rules())
rng = random.Random(22)
rows = [json.loads(l) for l in open(os.path.join(HERE, "train_v3.stripped.jsonl"))]
v3 = [r for r in rows if r["template_id"].startswith("v3_")]
stats = {}
def bump(k, n=1): stats[k] = stats.get(k, 0) + n

# -- weekdays ----------------------------------------------------------------
MONTHS = ["january", "february", "march", "april", "may", "june", "july",
          "august", "september", "october", "november", "december"]
MON = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
mi = lambda s: [m[:3] for m in MONTHS].index(s[:3].lower()) + 1
FIND = [  # (regex, fn(match, target, today) -> bool)
    (re.compile(r"\b(20\d\d)-(\d\d)-(\d\d)\b"),
     lambda m, t, d: (int(m[1]), int(m[2]), int(m[3])) == (t.year, t.month, t.day)),
    (re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b"),
     lambda m, t, d: (int(m[2]), int(m[1])) == (t.month, t.day)),
    (re.compile(r"\b%s\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?\b" % MON, re.I),
     lambda m, t, d: (mi(m[1]), int(m[2])) == (t.month, t.day) and (not m[3] or int(m[3]) == t.year)),
    (re.compile(r"\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?%s\.?(?:,?\s+(20\d\d))?\b" % MON, re.I),
     lambda m, t, d: (mi(m[2]), int(m[1])) == (t.month, t.day) and (not m[3] or int(m[3]) == t.year)),
    (re.compile(r"\b(?:this\s+|on\s+)?(%s)\b" % "|".join(DAYS), re.I),
     lambda m, t, d: m[1].lower() == DAYS[t.weekday()] and 1 <= (t - d).days <= 6
     and not re.search(r"(next|last)\s+$", m.string[:m.start()], re.I)),
    (re.compile(r"\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:of\s+)?%s)" % MON, re.I),
     lambda m, t, d: int(m[1]) == t.day and t.month == d.month),
    (re.compile(r"\btomorrow\b", re.I), lambda m, t, d: (t - d).days == 1),
]
ISO = re.compile(r"\d{4}-\d\d-\d\d")
def weekday_rows(r):
    prev, req = r["input"].split(" ||| ", 1)
    dates = set(ISO.findall(r["target"]))
    if len(dates) != 1 or ".." in r["target"] or ISO.search(prev):
        return []
    t = datetime.date.fromisoformat(dates.pop())
    d = datetime.date.fromisoformat(r["today"])
    hits = [(m.start(), m.end()) for rx, ok in FIND for m in rx.finditer(req) if ok(m, t, d)]
    spans = {h for h in hits if not any(o != h and o[0] <= h[0] and h[1] <= o[1] for o in hits)}
    if len(spans) != 1:
        bump("weekday: date phrase not found once"); return []
    s, e = spans.pop()
    out = []
    for back in rng.sample(range(1, 7), 4):
        wd = DAYS[t.weekday()]
        lead = req[:s].rstrip().lower()
        word = "tomorrow" if back == 1 and rng.random() < 0.4 else \
            rng.choice([wd, wd, wd.capitalize(), wd[:3], "this " + wd])
        if lead.endswith(("on", "this", "for")) and word.startswith("this "):
            word = wd
        q = req[:s] + word + req[e:]
        if len(re.findall(r"\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|nesday|rday|urday)?\b", q, re.I)) != 1 or \
                re.search(r"\b(since|ago|last|next\s+(%s)|past|before|until)\b" % "|".join(DAYS), q, re.I):
            bump("weekday: rejected rewrite"); continue
        out.append({"input": prev + " ||| " + q, "target": r["target"],
                    "today": (t - datetime.timedelta(days=back)).isoformat(),
                    "template_id": "r2w_" + r["template_id"]})
    return out

# -- copying -----------------------------------------------------------------
PARTICLE = ["pick up", "drop off", "sort out", "chase up", "check in on", "top up",
            "print off", "fill in", "hand back", "look into", "clear out", "send off"]
OBJ = [w.lower() for w in pools.TASKS + pools.DOCS + pools.EXPENSES][:200]
GRAMMARY = ["People of mine", "things to sort", "Tasks for the weekend", "notes on the move",
            "Photos of home", "the list", "Groups and clubs", "Albums from school",
            "places to try", "events at work", "Before the move", "that summer", "Called back",
            "Due next", "Places of mine", "count of sheep"]
def title():
    k = rng.random()
    if k < 0.3:
        t = "%s the %s" % (rng.choice(PARTICLE), rng.choice(["prescription", "dry cleaning",
            "parcel", "keys", "car", "form", "library books", "tickets", "boiler",
            "gutters", "passport photos", "school forms", "bins", "shed"]))
    elif k < 0.5:
        t = rng.choice(GRAMMARY)
    elif k < 0.8:
        t = rng.choice(OBJ)
    else:
        t = rng.choice(pools.NOTES + pools.PHOTOS + pools.ALBUMS + pools.EVENTS)
    c = rng.random()
    return t.lower() if c < 0.4 else (t[0].upper() + t[1:] if c < 0.8 else t.title())
PERSON = re.compile(r'\b(parties|members|profiles) called "([^"]*)"')
LIT = re.compile(r'(?:\bcalled|\b(?:title|summary|name|content|label|description):)\s*"([^"]*)"')
def copy_row(r):
    prev, req = r["input"].split(" ||| ", 1)
    lits = [s for s in LIT.findall(r["target"]) if len(s) >= 3 and s in req]
    if not lits:
        return None
    old = rng.choice(lits)
    person = any(m[2] == old for m in PERSON.finditer(r["target"]))
    new = ("%s %s" % (rng.choice(pools.FIRST), rng.choice(pools.LAST)) if person
           and " " in old else rng.choice(pools.FIRST) if person else title())
    wb = re.compile(r"(?<![\w-])%s(?![\w-])" % re.escape(old))
    if len(wb.findall(req)) != 1 or new.lower() in req.lower() or any(f in new.lower().split() for f in pools.FORBIDDEN):
        return None
    tgt = r["target"].replace('"%s"' % old, '"%s"' % new)
    out = {"input": prev.replace('"%s"' % old, '"%s"' % new) + " ||| " + wb.sub(lambda m: new, req),
           "target": tgt, "today": r["today"], "template_id": "r2c_" + r["template_id"]}
    return out if REC.full(tgt) else None

W = [x for r in v3 for x in weekday_rows(r)]
C = []
for r in v3:
    for _ in range(2 if rng.random() < 0.5 else 1):
        x = copy_row(r)
        if x: C.append(x)
C = C[:1600]
R = rng.sample(rows, 600)
bump("weekday rows", len(W)); bump("copy rows", len(C)); bump("replay rows", len(R))
allr = W + C + R
assert all(REC.full(x["target"]) for x in allr)
rng.shuffle(allr)
with open(os.path.join(HERE, "round2.jsonl"), "w") as fh:
    for x in allr: fh.write(json.dumps(x) + "\n")
print(json.dumps(stats, indent=1), "total", len(allr))
