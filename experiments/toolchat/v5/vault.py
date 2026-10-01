"""Synthetic vaults for v5 training sessions (SPEC section 5).

A global UNIVERSE of invented labels per kind/field (combinatorial over the
out-of-world pools; near-duplicate numbered labels and shared-word families),
from which each session samples 800-4,000 entries and then adds its own
targets and word-sharing distractors. Nothing here comes from an evaluation
world; every token is checked against pools.FORBIDDEN and the distillation
world by pools5.check().
"""
import random, re

import pools5 as P5
import retrieve as R

NOUNS = ["cabin", "kettle", "chimney", "tent", "wiper", "tyre", "parcel", "bench", "licence", "roof", "radiator",
         "magazine", "print", "freezer", "piano", "shed", "cable", "knife", "card", "monitor", "watch", "tulip",
         "loft", "boiler", "gate", "gutter", "passport", "bike", "car", "fence", "mirror", "tap", "garden", "kitchen",
         "bathroom", "window", "hall", "attic", "van", "boat", "kayak", "violin", "pottery", "chess", "cheese",
         "carpet", "dog", "cat", "hedge", "lawnmower", "patio", "drill", "ladder", "curtain", "sofa", "mattress",
         "fridge", "oven", "dishwasher", "washing machine", "router", "printer", "laptop", "phone", "camera",
         "suitcase", "school uniform", "football boots", "swimming kit", "lunchbox", "wardrobe",
         "bookshelf", "desk", "lamp", "doorbell", "smoke alarm", "letterbox", "driveway", "greenhouse", "pond",
         "compost", "barbecue", "hot tub", "caravan", "trailer", "roof rack", "helmet", "wetsuit", "paddleboard",
         "sleeping bag", "rucksack", "insurance", "mortgage", "pension", "savings", "tax", "invoice", "deposit",
         "rent", "council", "vet", "dentist", "optician", "physio", "tutor", "choir", "quiz", "allotment",
         "birthday", "anniversary", "wedding", "christening", "reunion", "housewarming", "retirement", "graduation"]
VERBS = ["Book", "Fix", "Clean", "Order", "Return", "Replace", "Check", "Paint", "Renew", "Cancel", "Collect",
         "Measure", "Sort out", "Pay for", "Chase", "Post", "Print", "Service", "Repair", "Recycle", "Label", "Oil",
         "Buy", "Sell", "Insure", "Photograph", "Empty", "Tidy", "Move", "Research", "Quote for", "Ring about"]
TASK_TAILS = ["", "", "", " again", " before winter", " this month", " properly", " for {first}", " with {first}",
              " at {place}", " (urgent)", " next week"]
ACTS = ["Yoga", "Pottery", "Chess", "Kayak", "Dentist", "Haircut", "Book club", "Choir", "Piano", "Violin",
        "Swimming", "Tennis", "Climbing", "Running club", "Pilates", "Physio", "Vet", "Optician", "Parents evening",
        "Quiz night", "Supper club", "Wine tasting", "Cheese tasting", "Boat licence", "Driving lesson",
        "Football", "Rugby", "Netball", "Drama club", "Coding club", "Spanish class", "Life drawing", "Bread making",
        "Dog training", "Allotment", "Car service", "Boiler service", "Roof survey", "Gutter clean", "Carpet fitting"]
EVENT_TAILS = [" with {first}", " at {place}", " lesson", " class", " session", " appointment", " meetup",
               " catch-up", " (week {n})", " rehearsal", " trial", " final"]
NOTE_TAILS = ["ideas", "list", "notes", "plan", "checklist", "measurements", "log", "budget", "draft", "questions",
              "shopping list", "recipe", "tips", "contacts"]
DOC_TAILS = ["receipt", "invoice", "contract", "warranty", "quote", "certificate", "statement", "letter", "manual",
             "policy", "form", "scan", "renewal", "bill", "agreement"]
PHOTO_TAILS = ["at {place}", "in the garden", "at dusk", "close-up", "from above", "in the snow", "after the rain",
               "with {first}", "by the window", "at night"]
GROUP_TAILS = ["crew", "kitty", "fund", "club", "trip", "weekend", "gang", "pot", "share", "tour"]
LOCKER_SVC = ["Streaming", "Bank", "Gym", "Library", "Pharmacy", "School", "Council", "Water", "Energy", "Parking",
              "Train", "Airline", "Broadband", "Mobile", "Pension", "Insurance", "Alarm", "Garage", "Router", "Cloud",
              "Kayak club", "Chess club", "Pottery studio", "Dentist", "Vet", "Supermarket", "Payroll"]
LOCKER_TAILS = ["login", "account", "PIN", "code", "wifi", "card", "app", "portal", "password", "backup codes"]
EXP_TAILS = ["deposit", "refund", "hire", "fee", "repair", "tickets", "top-up", "parts", "delivery", "subscription"]
PLACE_W = ["Ashgrove", "Bramley", "Cinder", "Dovecote", "Elderberry", "Farthing", "Gorsley", "Hollin", "Ivybridge",
           "Juniper", "Kestrel", "Linnet", "Mossley", "Nettlebed", "Orchard", "Pebble", "Quillon", "Rushmere",
           "Sedgefield", "Thistle", "Umber", "Vetch", "Wherry", "Yarrow"]
PLACE_T = ["Street", "Lane", "Park", "Market", "Bay", "Hill", "Common", "Quay", "Wood", "Gardens", "Pool", "Studio",
           "Cafe", "Library", "Station", "Farm"]
ALBUM_T = ["{act}", "{act} {year}", "{noun} {year}", "Summer {year}", "Winter {year}", "{place}", "{first}",
           "Best of {year}", "{act} highlights"]
YEARS = ["2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026", "2027"]


def _cap(s):
    return s[:1].upper() + s[1:]


def _fmt(t, r):
    return t.format(first=r.choice(P5.FIRST), place=r.choice(P5.POOL["places"]), n=r.randint(1, 12),
                    act=r.choice(ACTS), year=r.choice(YEARS), noun=_cap(r.choice(NOUNS)))


def build_universe(seed=5005, per_kind=None):
    r = random.Random(seed)
    per = {"tasks": 3000, "events": 2200, "notes": 1400, "documents": 1400, "photos": 2200, "parties": 1600,
           "expenses": 1000, "locker items": 400, "places": 300, "groups": 150, "journal notes": 300,
           "album_titles": 120, "notebooks": 40, "folder": 40, "role": 40}
    per.update(per_kind or {})
    U = {k: set(P5.POOL.get(k, [])) for k in per}
    U = {k: {_cap(x) for x in v} for k, v in U.items()}
    gens = {
        "tasks": lambda: "%s the %s%s" % (r.choice(VERBS), r.choice(NOUNS), _fmt(r.choice(TASK_TAILS), r)),
        "events": lambda: r.choice(ACTS) + _fmt(r.choice(EVENT_TAILS), r),
        "notes": lambda: "%s %s" % (_cap(r.choice(NOUNS + [a.lower() for a in ACTS])), r.choice(NOTE_TAILS)),
        "documents": lambda: "%s %s%s" % (_cap(r.choice(NOUNS)), r.choice(DOC_TAILS), r.choice(["", "", " " + r.choice(YEARS)])),
        "photos": lambda: ("%s %s" % (_cap(r.choice(NOUNS)), _fmt(r.choice(PHOTO_TAILS), r))) if r.random() < 0.7
        else "IMG_%04d" % r.randint(1000, 9999),
        "parties": lambda: "%s %s" % (r.choice(P5.FIRST), r.choice(P5.LAST)) if r.random() < 0.85
        else "%s %s" % (r.choice(PLACE_W), r.choice(["Dental", "Motors", "Vets", "Plumbing", "Builders", "Bakery"])),
        "expenses": lambda: ("%s %s" % (_cap(r.choice(NOUNS)), r.choice(EXP_TAILS))) if r.random() < 0.7 else _cap(r.choice(NOUNS)),
        "locker items": lambda: "%s %s" % (r.choice(LOCKER_SVC), r.choice(LOCKER_TAILS)),
        "places": lambda: "%s %s" % (r.choice(PLACE_W), r.choice(PLACE_T)),
        "groups": lambda: "%s %s" % (r.choice(ACTS), r.choice(GROUP_TAILS)),
        "journal notes": lambda: "%s with %s" % (r.choice(["Chat", "Coffee", "Walk", "Call", "Lunch", "Dinner"]), r.choice(P5.FIRST)),
        "album_titles": lambda: _fmt(r.choice(ALBUM_T), r),
        "notebooks": lambda: _cap(r.choice(NOUNS + [a.lower() for a in ACTS])),
        "folder": lambda: _cap(r.choice(NOUNS)),
        "role": lambda: r.choice(["Dentist", "Plumber", "Tutor", "Coach", "Mechanic", "Accountant", "Vet", "Builder",
                                  "Neighbour", "Babysitter", "Cleaner", "Florist", "Surveyor", "Architect", "Midwife",
                                  "Nurse", "Barber", "Locksmith", "Tailor", "Beekeeper", "Chiropodist", "Decorator",
                                  "Tiler", "Joiner", "Glazier", "Farrier", "Groomer", "Caterer", "Photographer",
                                  "Driving instructor", "Swimming coach", "Yoga teacher", "GP", "Therapist", "Nanny",
                                  "Carer", "Landscaper", "Roofer", "Upholsterer", "Piano tuner"]),
    }
    for k, n in per.items():
        tries = 0
        while len(U[k]) < n and tries < n * 20:
            tries += 1
            U[k].add(gens[k]())
    # near-duplicate texture: numbered copies of ~12 % of labels
    for k in ("tasks", "events", "notes", "documents", "photos", "expenses", "locker items"):
        base = sorted(U[k])
        for x in r.sample(base, len(base) // 8):
            for i in range(1, r.choice([2, 3, 3, 4, 6]) + 1):
                U[k].add("%s (%02d)" % (x, i))
    _, old = P5.old_world()
    oldl = {x.lower() for x in old}
    out = {k: sorted(x for x in v if x.lower() not in oldl) for k, v in U.items()}
    bad = [x for v in out.values() for x in v if any(P5.bad_token(t) for t in re.findall(r"[a-z]+", x.lower()))]
    for k in out:
        out[k] = [x for x in out[k] if x not in set(bad)]
    return out


KIND_W = {"tasks": 20, "events": 15, "notes": 9, "documents": 9, "photos": 15, "parties": 12, "expenses": 8,
          "locker items": 3, "places": 3, "groups": 1.2, "journal notes": 2, "album_titles": 1, "notebooks": 0.6,
          "folder": 0.6, "role": 0.6}
FIELDS = {"album_titles", "notebooks", "folder", "role"}


def entry(kind, label):
    return {"field": kind, "label": label} if kind in FIELDS else {"kind": kind, "label": label}


def ekind(e):
    return e.get("kind") or e.get("field")


class Universe:
    def __init__(self, seed=5005):
        self.U = build_universe(seed)
        self.words = {}
        for k, labels in self.U.items():
            for x in labels:
                for t in set(R.tokens(x)):
                    self.words.setdefault(t, []).append((k, x))

    def sample(self, r, n):
        tot = sum(KIND_W.values())
        out = []
        for k, w in KIND_W.items():
            m = max(3, int(n * w / tot))
            pool = self.U[k]
            out += [entry(k, x) for x in r.sample(pool, min(m, len(pool)))]
        return out

    def sharing(self, r, word_tokens, n):
        """entries from the universe that share any of the tokens"""
        cands = []
        for t in word_tokens:
            cands += self.words.get(t, [])
        r.shuffle(cands)
        return [entry(k, x) for k, x in cands[:n]]


def covers(label, kw):
    """does the label contain every token of kw (prefix-aware, as a retrieval hit would)"""
    lt = R.tokens(label)
    for t in R.tokens(kw):
        if not any(x == t or (len(t) >= 4 and x.startswith(t)) for x in lt):
            return False
    return bool(R.tokens(kw))


def make_vault(r, U, targets, misses, texts, extra_near=()):
    """targets: [(kind, label)] that must be present; misses: [(kind, kw)] that must be ABSENT
    (no same-kind entry covering kw). texts: the session's user messages (distractors share their words).
    Returns list of entries (800-4000)."""
    n = r.randint(800, 4000)
    v = U.sample(r, n)
    toks = set()
    for t in texts:
        toks |= set(R.tokens(t))
    for k, lab in targets:
        toks |= set(R.tokens(lab))
    v += U.sharing(r, sorted(toks), r.randint(20, 60))
    # near-duplicates of the targets' words in OTHER kinds, and numbered copies there
    for k, lab in targets:
        if k not in ("tasks", "events", "notes", "documents", "photos", "expenses"):
            continue
        for ok in r.sample(["tasks", "events", "notes", "documents", "photos", "expenses"], 2):
            if ok != k:
                v.append(entry(ok, lab))
                if r.random() < 0.4:
                    v.append(entry(ok, "%s (%02d)" % (lab, r.randint(1, 3))))
    for k, lab in extra_near:
        v.append(entry(k, lab))
    # misses: nothing of that kind covering the words
    miss_rm = [(k, kw) for k, kw in misses]
    tset = {(k, lab) for k, lab in targets}
    def keep(e):
        if (ekind(e), e["label"]) in tset:
            return False  # re-added below, once
        for k, kw in miss_rm:
            if ekind(e) == k and covers(e["label"], kw):
                return False
        for k, lab in targets:
            # no same-kind twin of a target (numbered copies of the target itself would make it ambiguous)
            if ekind(e) == k and re.sub(r" \(\d\d\)$", "", e["label"]) == lab:
                return False
        return True
    v = [e for e in v if keep(e)]
    v += [entry(k, lab) for k, lab in targets]
    r.shuffle(v)
    return v


def settle_target(v, k, lab, text, cap=6, prev=None, r=None):
    """make the target the best of its kind for `text` and put it in the top `cap`.
    Removes same-kind entries scoring >= the target, then other entries above it
    beyond cap-1 (the fewest needed). Returns the (possibly smaller) vault, or None."""
    sc = R.scored(text, v, prev)
    ts = None
    for s, e in sc:
        if ekind(e) == k and e["label"] == lab:
            ts = s
            break
    if ts is None:
        return None
    drop = set()
    above = []
    for s, e in sc:
        if ekind(e) == k and e["label"] == lab:
            break
        if ekind(e) == k:
            drop.add((ekind(e), e["label"]))
        else:
            above.append((ekind(e), e["label"]))
    # entries tied with the target but sorted after it are also same-kind competitors
    for s, e in sc:
        if s == ts and ekind(e) == k and e["label"] != lab:
            drop.add((ekind(e), e["label"]))
    if len(above) > cap - 1 or (r is not None and above):
        # how many other-kind entries stay above the target: at most cap-1, and a random
        # number when an rng is given (so the right row is not always last or first)
        keep_n = min(cap - 1, len(above)) if r is None else r.randint(0, min(cap - 1, len(above)))
        drop |= set(above[keep_n:])
    return [e for e in v if (ekind(e), e["label"]) not in drop]
