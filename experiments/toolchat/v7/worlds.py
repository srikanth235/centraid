#!/usr/bin/env python3
"""v7 synthetic TRAINING vault worlds, seeded through the vault's command plane.

    python3 worlds.py --n 16 --out v7/worlds/            # w01.json … w16.json
    python3 worlds.py --n 16 --out v7/worlds/ --verify   # also build + probe each

Each world is a spec for `tool-loop serve --world spec:<file>`
(crates/candidates/src/bin/tool-loop.rs): `{"now_ms", "seed", "writes"}`, every
write a real command (`{"cmd", "body", "as"}`), a canonical line (`{"canon"}`,
used for locker items so the seat seals the content), or a field-door read
(`{"field": [entity, id, column], "as"}`, used to learn the place a
photograph's coordinates minted so it can be named).

A world is one invented household: its own "now" (weekday i % 7, a month and
year in 2025-2027, a daytime hour UTC), cast, places, groups and labels, all
sampled from the out-of-world pools in v3/pools.py, v5/pools5.py and
v5/vault.py plus the v7 word lists below. Nothing is read from an evaluation
world. Every string that ends up in a spec (labels, bodies, contents) is run
through the pools5 forbidden check (`P5.bad_token` over every token, and exact
match against the distillation world's labels); a hit raises.

Texture, on purpose:
  * numbered near-duplicate families ("Weekly shop (wk 03)", "Payslip (02)")
  * word-sharing distractors: a few theme words per world are spread over
    tasks, events, notes, documents, photos, expenses and more, so a name
    search returns several candidates of several kinds
  * at least two people share a first name (different surnames and roles)

Deterministic from --seed.
"""
import argparse
import datetime as dt
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(HERE, "..", "v5"))
import pools5 as P5  # noqa: E402  (also puts v3/ on the path)
import vault as V  # noqa: E402

# ---------------------------------------------------------------------------
# v7 additions to the pools (checked at import, below)
# ---------------------------------------------------------------------------

FAMILY_ROLES = ["Partner", "Son", "Daughter", "Mum", "Dad", "Sister", "Brother", "Cousin", "Aunt", "Uncle",
                "Grandmother", "Grandfather", "Sister-in-law", "Brother-in-law"]
FRIEND_ROLES = ["Friend", "Old school friend", "University friend", "Book club friend", "Climbing partner",
                "Running club friend", "Choir friend", "Friend from the allotment", "Godparent", "Best friend"]
WORK_ROLES = ["Colleague", "Manager", "Team lead", "Former colleague", "Client", "Mentor"]
NEIGHBOUR_ROLES = ["Neighbour", "Neighbour at number 4", "Neighbour across the road", "Landlord"]
ORG_KINDS = [("Dental", "Dentist"), ("Motors", "Mechanic"), ("Vets", "Vet"), ("Plumbing", "Plumber"),
             ("Builders", "Builder"), ("Opticians", "Optician"), ("Physio", "Physio"), ("Electrics", "Electrician"),
             ("Roofing", "Roofer"), ("Lettings", "Estate agent"), ("Accountants", "Accountant"),
             ("Garden Care", "Gardener")]
EMAIL_DOMAINS = ["example.com", "example.org", "example.net", "mail.example", "post.example"]
KINDS_OF_TALK = {
    "call": ["Rang about {topic}", "Quick call about {topic}", "Long call, mostly about {topic}",
             "Called back about {topic}"],
    "coffee": ["Coffee at {place}; talked about {topic}", "Flat whites at {place}", "Coffee and a walk round {place}"],
    "visit": ["Popped round with {thing}", "Visited for the afternoon; {topic}", "Dropped off the {thing}"],
    "message": ["Sent the photos from {place}", "Messaged about {topic}", "Shared the {thing} details"],
}
TOPICS = ["the move", "the new job", "half term", "the allotment", "the wedding plans", "the roof quote",
          "the kids' swimming", "the holiday dates", "the book club pick", "the car", "the garden",
          "the birthday plans", "the kayak club", "the chess league", "the house sale"]
MOODS_NOTE = ["Remember to", "Next time:", "Ideas:", "Checklist:", "Asked around:", "Prices so far:"]
CATEGORIES = ["groceries", "travel", "transport", "food", "fun", "rent", "utilities", "shopping", "general"]  # Tally's enum
GROUP_ICONS = ["🏕️", "🏠", "🛶", "♟️", "🎻", "🚲", "🍷", "⛵", "🎿", "🌷", "🏖️", "🎉"]
LOCKER_LOGIN_TAILS = ["login", "account", "portal", "app", "password"]
LOCKER_NOTE_TAILS = ["PIN", "code", "wifi", "backup codes"]
CARD_BRANDS = ["Visa", "Mastercard", "Amex"]
JOURNAL_MOODS = ["good", "tired", "calm", "happy", "busy", "low", "grateful", "restless"]
SECRET_WORDS = ["heron", "quartz", "lantern", "meadow", "copper", "thistle", "harbour", "pebble", "willow",
                "saffron", "juniper", "cobalt", "fennel", "marble", "orchid"]
V7_WORDS = (JOURNAL_MOODS + FAMILY_ROLES + FRIEND_ROLES + WORK_ROLES + NEIGHBOUR_ROLES + [a for a, _ in ORG_KINDS] +
            [b for _, b in ORG_KINDS] + TOPICS + CATEGORIES + SECRET_WORDS + MOODS_NOTE +
            [x for v in KINDS_OF_TALK.values() for x in v])

# Theme words: single nouns that read naturally in every kind's labels.
THEMES = ["kayak", "cabin", "boiler", "piano", "garden", "bike", "chess", "tulip", "roof", "violin", "pottery",
          "boat", "kitchen", "fence", "loft", "passport", "dog", "caravan", "greenhouse", "tent", "pond", "cheese",
          "choir", "allotment", "patio", "attic", "barbecue", "wetsuit"]

# ---------------------------------------------------------------------------
# the forbidden check
# ---------------------------------------------------------------------------

_W, _OLD = P5.old_world()
OLD_LOWER = {x.lower() for x in _OLD}
OLD_NAMES = set(_W.FIRST) | set(_W.LAST)


class Forbidden(Exception):
    pass


def bad_text(text):
    """why `text` may not appear in a training world, or None"""
    if text.lower() in OLD_LOWER:
        return "is a distillation-world label"
    for tok in re.findall(r"[a-z]+", text.lower()):
        if P5.bad_token(tok):
            return "has forbidden token %r" % tok
    return None


def assert_clean(texts, where):
    hits = [(t, bad_text(t)) for t in texts]
    hits = [h for h in hits if h[1]]
    if hits:
        raise Forbidden("%s: %s" % (where, hits[:10]))


def _pool_check():
    bad = P5.check(V7_WORDS + THEMES)
    if bad:
        raise Forbidden("v7 pools: %s" % bad)
    names = [x for x in P5.FIRST + P5.LAST if x in OLD_NAMES]
    if names:
        raise Forbidden("name pools: %s" % names)


_pool_check()


def spec_strings(spec):
    """every human-readable string in a spec (data URIs decoded, refs skipped)"""
    out = []

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str):
            if v.startswith("$"):
                return
            if v.startswith("data:"):
                out.append(urllib.parse.unquote(v.split(",", 1)[1]))
            else:
                out.append(v)

    walk(spec["writes"])
    return out


def check_spec(spec, where):
    texts = spec_strings(spec)
    for t in texts:
        why = bad_text(t)
        # whole-label match only matters for short labels; long bodies are
        # covered token by token
        if why:
            raise Forbidden("%s: %r %s" % (where, t, why))


# ---------------------------------------------------------------------------
# time
# ---------------------------------------------------------------------------

UTC = dt.timezone.utc


def iso(t):
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def pick_now(i, r):
    """weekday i % 7 (0 = Monday), a month in 2025-2027, a daytime hour"""
    while True:
        year = r.choice([2025, 2026, 2027])
        month = r.randint(1, 12)
        day = r.randint(1, 28)
        d = dt.date(year, month, day)
        d += dt.timedelta(days=(i % 7 - d.weekday()) % 7)
        if d.year == year:
            break
    return dt.datetime(d.year, d.month, d.day, r.randint(8, 17), r.choice([0, 10, 15, 25, 30, 40, 45, 50]),
                       tzinfo=UTC)


def day_at(now, days, hour, minute=0):
    d = (now + dt.timedelta(days=days)).date()
    return dt.datetime(d.year, d.month, d.day, hour, minute, tzinfo=UTC)


def week_no(t):
    return t.isocalendar()[1]


# ---------------------------------------------------------------------------
# the spec builder
# ---------------------------------------------------------------------------

class Spec:
    def __init__(self):
        self.writes = []
        self.n = 0
        self.count = {}

    def ref(self, prefix):
        self.n += 1
        return "%s%d" % (prefix, self.n)

    def cmd(self, name, body, kind=None, as_=None):
        w = {"cmd": name, "body": body}
        if as_:
            w["as"] = as_
        self.writes.append(w)
        if kind:
            self.count[kind] = self.count.get(kind, 0) + 1
        return as_

    def canon(self, line, kind=None):
        self.writes.append({"canon": line})
        if kind:
            self.count[kind] = self.count.get(kind, 0) + 1

    def field(self, entity, id_ref, column, as_):
        self.writes.append({"field": [entity, id_ref, column], "as": as_})
        return as_


def cap(s):
    return s[:1].upper() + s[1:]


class Labels:
    """unique, checked labels per kind for one world"""

    def __init__(self, r):
        self.r = r
        self.used = {}

    def take(self, kind, gen, tries=200):
        used = self.used.setdefault(kind, set())
        for _ in range(tries):
            x = gen()
            x = re.sub(r"\s+", " ", x).strip()
            if not x or x.lower() in used or bad_text(x):
                continue
            used.add(x.lower())
            return x
        raise RuntimeError("no fresh %s label" % kind)

    def force(self, kind, x):
        why = bad_text(x)
        if why:
            raise Forbidden("%s label %r %s" % (kind, x, why))
        self.used.setdefault(kind, set()).add(x.lower())
        return x


# ---------------------------------------------------------------------------
# one world
# ---------------------------------------------------------------------------

def build_world(i, seed):
    r = random.Random("%s/w%02d" % (seed, i))
    now = pick_now(i, r)
    S = Spec()
    L = Labels(r)
    themes = r.sample(THEMES, 4)
    ex = {}  # one example row per link walk, for verification

    # -- cast ----------------------------------------------------------------
    firsts = list(P5.FIRST)
    lasts = list(P5.LAST)
    r.shuffle(firsts)
    r.shuffle(lasts)
    fi = iter(firsts)
    li = iter(lasts)
    home_last = next(li)
    partner_last = r.choice([home_last, home_last, next(li)])
    people = []  # dicts: name, first, last, role, group, ref

    def person(first, last, role, group):
        name = "%s %s" % (first, last)
        people.append({"name": L.force("parties", name), "first": first, "last": last, "role": role,
                       "group": group})

    person(next(fi), partner_last, "Partner", "family")
    for _ in range(r.randint(1, 2)):
        person(next(fi), home_last, r.choice(["Son", "Daughter"]), "family")
    person(next(fi), home_last, "Mum", "family")
    if r.random() < 0.6:
        person(next(fi), home_last, "Dad", "family")
    person(next(fi), r.choice([home_last, next(li)]), r.choice(["Sister", "Brother"]), "family")
    for _ in range(r.randint(1, 3)):
        person(next(fi), r.choice([home_last, partner_last, next(li)]),
               r.choice(["Cousin", "Aunt", "Uncle", "Grandmother", "Sister-in-law", "Brother-in-law"]), "family")
    total = r.randint(40, 60)
    n_org = r.randint(3, 6)
    n_service = r.randint(7, 11)
    n_work = r.randint(5, 8)
    n_neigh = r.randint(3, 5)
    n_friend = max(8, total - len(people) - n_org - n_service - n_work - n_neigh)
    for _ in range(n_friend):
        person(next(fi), next(li), r.choice(FRIEND_ROLES), "friend")
    for _ in range(n_work):
        person(next(fi), next(li), r.choice(WORK_ROLES), "work")
    for _ in range(n_neigh):
        person(next(fi), next(li), r.choice(NEIGHBOUR_ROLES), "neighbour")
    service_roles = r.sample(P5.ROLES, n_service)
    for role in service_roles:
        person(next(fi), next(li), role, "service")
    # shared first names: two (sometimes three) pairs, different surnames and roles
    pool = [p for p in people if p["group"] in ("friend", "work", "neighbour", "service")]
    for _ in range(r.choice([2, 2, 3])):
        src = r.choice(pool)
        twin_group = r.choice(["friend", "work", "neighbour", "service"])
        role = {"friend": r.choice(FRIEND_ROLES), "work": r.choice(WORK_ROLES),
                "neighbour": r.choice(NEIGHBOUR_ROLES), "service": r.choice(P5.ROLES)}[twin_group]
        person(src["first"], next(li), role, twin_group)
    orgs = r.sample(ORG_KINDS, n_org)
    for suffix, role in orgs:
        name = L.take("parties", lambda: "%s %s" % (r.choice(V.PLACE_W), suffix))
        people.append({"name": name, "first": None, "last": None, "role": role, "group": "org"})
    for k, p in enumerate(people):
        p["ref"] = "p%02d" % (k + 1)
        S.cmd("people.add_person", {"display_name": p["name"], "role": p["role"],
                                    "cadence_days": r.choice([0, 7, 14, 30, 60, 90])
                                    if p["group"] != "org" else 0},
              kind="parties", as_=p["ref"])
    by_group = {}
    for p in people:
        by_group.setdefault(p["group"], []).append(p)
    humans = [p for p in people if p["group"] != "org"]
    social = by_group["family"] + by_group["friend"]

    def pid(p):
        return "$%s.party_id" % p["ref"]

    # contact channels
    phone_n = iter(r.sample(range(1000), 200))
    for p in people:
        if p["group"] == "org":
            S.cmd("people.save_contact_channel", {"party_id": pid(p), "kind": "phone", "label": "office",
                                                  "value": "+44 20 7946 0%03d" % next(phone_n)},
                  kind="contact channels")
            slug = re.sub(r"[^a-z]", "", p["name"].lower())
            S.cmd("people.save_contact_channel", {"party_id": pid(p), "kind": "email", "label": "work",
                                                  "value": "hello@%s.example" % slug}, kind="contact channels")
            continue
        if r.random() < 0.65:
            S.cmd("people.save_contact_channel", {"party_id": pid(p), "kind": "phone",
                                                  "label": r.choice(["mobile", "mobile", "home"]),
                                                  "value": "+44 7700 900%03d" % next(phone_n)},
                  kind="contact channels")
        if r.random() < 0.5:
            S.cmd("people.save_contact_channel", {
                "party_id": pid(p), "kind": "email", "label": r.choice(["personal", "work"]),
                "value": "%s.%s@%s" % (p["first"].lower(), p["last"].lower(), r.choice(EMAIL_DOMAINS))},
                kind="contact channels")

    # important dates: birthdays (a few soon), anniversaries
    soon = r.sample(social, 3)
    ex["date_party"] = soon[0]["name"]
    for k, p in enumerate(humans):
        if p in soon:
            d = (now + dt.timedelta(days=[2, r.randint(4, 12), r.randint(13, 28)][soon.index(p)])).date()
        elif p["group"] in ("family", "friend") and r.random() < 0.55:
            d = dt.date(2001, r.randint(1, 12), r.randint(1, 28))
        elif r.random() < 0.08:
            d = dt.date(2001, r.randint(1, 12), r.randint(1, 28))
        else:
            continue
        S.cmd("people.add_important_date", {"party_id": pid(p), "label": "Birthday",
                                            "month_day": "%02d-%02d" % (d.month, d.day),
                                            "reminder_on": r.random() < 0.5}, kind="important dates")
    partner = by_group["family"][0]
    d = now.date() + dt.timedelta(days=r.randint(-40, 40))
    S.cmd("people.add_important_date", {"party_id": pid(partner), "label": "Anniversary",
                                        "month_day": "%02d-%02d" % (d.month, min(d.day, 28)),
                                        "reminder_on": True}, kind="important dates")
    for p in r.sample(by_group["friend"], 2):
        S.cmd("people.add_important_date", {"party_id": pid(p), "label": r.choice(["Wedding anniversary",
                                                                                   "Name day", "Graduation"]),
                                            "month_day": "%02d-%02d" % (r.randint(1, 12), r.randint(1, 28)),
                                            "reminder_on": False}, kind="important dates")

    # -- places (named through their first photograph) -------------------------
    base_lat, base_lng = r.uniform(50.4, 54.6), r.uniform(-3.8, 0.9)
    n_places = r.randint(5, 10)
    place_names = []
    pool_places = [x for x in P5.POOL["places"] if not x.startswith("the ")]
    for _ in range(n_places):
        if r.random() < 0.5:
            place_names.append(L.take("places", lambda: r.choice(pool_places)))
        else:
            place_names.append(L.take("places", lambda: "%s %s" % (r.choice(V.PLACE_W), r.choice(V.PLACE_T))))
    places = []
    for k, name in enumerate(place_names):
        places.append({"name": name, "ref": "pl%02d" % (k + 1),
                       "lat": round(base_lat + (k % 4) * 0.021 + r.uniform(0, 0.004), 5),
                       "lng": round(base_lng + (k // 4) * 0.027 + r.uniform(0, 0.004), 5)})

    def plid(pl):
        return "$%s.value" % pl["ref"]

    # label generators that use this world's cast and places
    def fmt(t):
        return t.format(first=r.choice(humans)["first"], place=r.choice(places)["name"], n=r.randint(1, 12),
                        act=r.choice(V.ACTS), year=r.choice(["2023", "2024", str(now.year - 1), str(now.year)]),
                        noun=cap(r.choice(V.NOUNS)))

    # -- photos, places, albums -----------------------------------------------
    n_photos = r.randint(27, 46)  # + the numbered burst
    photos = []
    th_photo = ["{w} at {place}", "{W} close-up", "{W} in the rain", "The {w} at dusk", "{W} from above",
                "New {w}", "{W} with {first}"]
    for k in range(n_photos):
        at_place = places[k] if k < len(places) else (r.choice(places) if r.random() < 0.4 else None)
        if k < len(themes) * 1 + len(places) and k >= len(places):
            w = themes[k - len(places)]
            title = L.take("photos", lambda: fmt(r.choice(th_photo).replace("{w}", w).replace("{W}", cap(w))))
        elif r.random() < 0.12:
            title = L.take("photos", lambda: "IMG_%04d" % r.randint(1000, 9999))
        elif r.random() < 0.45:
            title = L.take("photos", lambda: cap(r.choice(P5.POOL["photos"])))
        else:
            title = L.take("photos", lambda: "%s %s" % (cap(r.choice(V.NOUNS)), fmt(r.choice(V.PHOTO_TAILS))))
        back = r.randint(1, 45) if r.random() < 0.72 else r.randint(46, 1100)
        when = day_at(now, -back, r.randint(7, 20), r.randint(0, 59))
        photos.append({"title": title, "place": at_place, "when": when.replace(second=0, microsecond=0)})
    # a numbered burst: near-duplicate family
    base = r.choice([p for p in photos if not p["title"].startswith("IMG_")])
    burst_when = day_at(now, -r.randint(1, 20), r.randint(9, 18), r.randint(0, 50))
    for j in range(1, r.randint(3, 4) + 1):
        photos.append({"title": L.force("photos", "%s (%02d)" % (base["title"], j)), "place": base["place"],
                       "when": burst_when.replace(second=0, microsecond=0) + dt.timedelta(minutes=j)})
    photos.sort(key=lambda p: p["when"])
    named = set()
    for k, ph in enumerate(photos):
        ph["ref"] = "ph%02d" % (k + 1)
        body = {"data_uri": "data:text/plain,%s" % urllib.parse.quote("photo %s/w%02d/%d %s" % (seed, i, k,
                                                                                                ph["title"])),
                "kind": "photo", "title": ph["title"], "captured_at": iso(ph["when"]),
                "width": r.choice([3024, 4032, 1080]), "height": r.choice([3024, 2268, 1920])}
        pl = ph["place"]
        if pl:
            body["latitude"] = round(pl["lat"] + r.uniform(-0.0004, 0.0004), 6) if pl["ref"] in named else pl["lat"]
            body["longitude"] = round(pl["lng"] + r.uniform(-0.0004, 0.0004), 6) if pl["ref"] in named else pl["lng"]
        S.cmd("media.add_asset", body, kind="photos", as_=ph["ref"])
        if pl and pl["ref"] not in named:
            S.field("core.content_item", "$%s.asset_id" % ph["ref"], "place_id", pl["ref"])
            S.cmd("media.name_place", {"place_id": plid(pl), "name": pl["name"]}, kind="places")
            named.add(pl["ref"])
    for ph in r.sample(photos, r.randint(3, 6)):
        S.cmd("media.update_asset", {"asset_id": "$%s.asset_id" % ph["ref"], "favorite": 1})
    n_albums = r.randint(3, 6)
    album_titles = []
    for k in range(n_albums):
        if k == 0:
            album_titles.append(L.take("albums", lambda: fmt(r.choice(["{place}", "{place} {year}"]))))
        elif k == 1:
            album_titles.append(L.force("albums", cap(themes[0]) + r.choice(["", " " + str(now.year)])))
        elif r.random() < 0.5:
            album_titles.append(L.take("albums", lambda: r.choice(P5.POOL["album_titles"])))
        else:
            album_titles.append(L.take("albums", lambda: fmt(r.choice(V.ALBUM_T))))
    for k, title in enumerate(album_titles):
        ref = "al%02d" % (k + 1)
        S.cmd("media.create_album", {"title": title}, kind="albums", as_=ref)
        if k == 0:
            # the place album holds that place's photographs
            members = [p for p in photos if p["place"] is places[0]]
            members += r.sample([p for p in photos if p not in members], 2)
        else:
            members = r.sample(photos, r.randint(3, 9))
        for ph in members:
            S.cmd("media.add_to_album", {"album_id": "$%s.album_id" % ref, "asset_id": "$%s.asset_id" % ph["ref"]})

    # -- calendar ---------------------------------------------------------------
    busy = []

    def slot(day, dur, hours=None):
        hours = hours or list(range(7, 21))
        hs = list(hours)
        r.shuffle(hs)
        for h in hs:
            for m in r.sample([0, 15, 30, 45], 4):
                s = day_at(now, day, h, m)
                e = s + dt.timedelta(minutes=dur)
                if e.date() != s.date():
                    continue
                if all(e <= b0 or s >= b1 for b0, b1 in busy):
                    busy.append((s, e))
                    return s, e
        return None

    monday = -now.weekday()                       # days from now to this week's Monday
    sat = (5 - now.weekday()) % 7                 # the coming Saturday (today if Saturday)
    weekend = [sat, sat + 1] if now.weekday() != 6 else [0, 6]
    days = []
    days += [monday + d for d in range(7) for _ in range(1) if r.random() < 0.9]   # this week
    days += [monday + d for d in r.sample(range(7), r.randint(2, 4))]              # denser
    days += [weekend[0]] * r.randint(2, 3) + [weekend[1]] * r.randint(1, 2)       # the coming weekend
    n_events = r.randint(25, 40)
    while len(days) < n_events - 4:
        days.append(r.randint(-30, 30))
    events = []
    ev_single = ["{W} lesson", "{W} club", "Look at the {w}", "{W} viewing", "{W} fair", "{W} workshop"]
    for k, day in enumerate(days):
        if k < len(themes):
            w = themes[k]
            title = L.take("events", lambda: r.choice(ev_single).replace("{w}", w).replace("{W}", cap(w)))
        elif r.random() < 0.45:
            title = L.take("events", lambda: cap(r.choice(P5.POOL["events"])))
        else:
            title = L.take("events", lambda: r.choice(V.ACTS) + fmt(r.choice(V.EVENT_TAILS)))
        events.append({"title": title, "day": day})
    # a weekly family: "<act> (week NN)"
    act = L.take("event-family", lambda: r.choice(["Swimming lesson", "Choir practice", "Chess club",
                                                   "Violin lesson", "Running club", "Spanish class",
                                                   "Pilates", "Book club"]))
    wd = r.randint(0, 6)
    first_day = monday - 21 + wd
    for j in range(4):
        d = first_day + 7 * j
        events.append({"title": None, "family": act, "day": d})
    ev_n = 0
    for ev in events:
        dur = r.choice([30, 45, 60, 60, 90, 120, 180])
        got = slot(ev["day"], dur)
        if not got:
            continue
        s, e = got
        if ev.get("family"):
            ev["title"] = L.force("events", "%s (week %02d)" % (ev["family"], week_no(s)))
        body = {"calendar_id": "$me.calendar_id", "summary": ev["title"], "dtstart": iso(s), "dtend": iso(e)}
        role_hit = [p for p in people if re.search(r"\b%s\b" % re.escape(p["role"].lower()), ev["title"].lower())]
        if role_hit:
            att = role_hit[:1]
        elif r.random() < 0.85:
            grp = r.choice([social, social, by_group["work"], by_group["neighbour"], humans])
            att = r.sample(grp, min(len(grp), r.choice([1, 1, 2, 2, 3, 4])))
        else:
            att = []
        if att:
            body["attendee_party_ids"] = [pid(p) for p in att]
            ex.setdefault("event_with_attendees", ev["title"])
        if r.random() < 0.4:
            pl = r.choice(places)
            body["location_place_id"] = plid(pl)
            ex.setdefault("event_place", pl["name"])
        if r.random() < 0.3:
            body["description"] = r.choice(["Bring the {thing}.", "Parking behind {place}.", "Confirm with {first}.",
                                            "Deposit already paid.", "Remember the {thing} for {first}."]).format(
                thing=r.choice(V.NOUNS), place=r.choice(places)["name"], first=r.choice(humans)["first"])
        ev_n += 1
        S.cmd("schedule.propose_event", body, kind="events", as_="ev%02d" % ev_n)

    # -- tasks --------------------------------------------------------------------
    n_tasks = r.randint(22, 36)  # + subtasks and the weekly family: 30-50 in all
    tasks = []
    th_task = ["{V} the {w}", "{V} the {w} before {first} comes", "Ask {first} about the {w}", "{V} the {w} again"]
    for k in range(n_tasks):
        if k < len(themes):
            w = themes[k]
            title = L.take("tasks", lambda: fmt(r.choice(th_task).replace("{w}", w).replace(
                "{V}", r.choice(V.VERBS))))
        elif r.random() < 0.35:
            title = L.take("tasks", lambda: cap(r.choice(P5.POOL["tasks"])))
        else:
            title = L.take("tasks", lambda: "%s the %s%s" % (r.choice(V.VERBS), r.choice(V.NOUNS),
                                                             fmt(r.choice(V.TASK_TAILS))))
        tasks.append({"title": title})
    # weekly family
    fam = L.take("task-family", lambda: r.choice(["Weekly shop", "Put the bins out", "Water the plants",
                                                  "Pay the cleaner", "Top up the lunch account"]))
    for j in range(r.randint(3, 5)):
        d = monday - 14 + 7 * j + r.randint(0, 1)
        t = day_at(now, d, 9)
        tasks.append({"title": L.force("tasks", "%s (wk %02d)" % (fam, week_no(t))), "due": t,
                      "status": "completed" if t < now else None})
    t_n = 0

    def add_task(t, parent=None, defer=False):
        nonlocal t_n
        t_n += 1
        ref = "t%02d" % t_n
        body = {"title": t["title"]}
        due = t.get("due", "unset")
        if due == "unset":
            due = None if r.random() < 0.15 else day_at(now, r.randint(-30, 30), r.choice([9, 9, 12, 17, 18]))
        if due:
            body["due_at"] = iso(due)
        if r.random() < 0.45:
            body["effort_min"] = r.choice([15, 30, 45, 60, 90, 120])
        if r.random() < 0.5:
            body["priority"] = r.randint(1, 9)
        if r.random() < 0.2:
            body["description"] = "%s %s." % (r.choice(MOODS_NOTE), r.choice(TOPICS))
        if parent:
            body["parent_task_id"] = "$%s.task_id" % parent
        S.cmd("schedule.add_task", body, kind="tasks", as_=ref)
        status = t.get("status")
        if status is None and "status" not in t:
            if due and due < now:
                status = r.choice(["completed", "completed", "completed", None, "in-process"])
            else:
                status = r.choice([None] * 7 + ["completed", "in-process"])
            if r.random() < 0.04:
                status = "cancelled"
        if status and defer:
            return ref, status
        if status:
            S.cmd("schedule.set_task_status", {"task_id": "$%s.task_id" % ref, "status": status})
        return ref, None

    parents = set(r.sample(range(len(tasks)), 3))
    for k, t in enumerate(tasks):
        # a parent must be open while its subtasks are added; its own status comes after
        ref, later = add_task(t, defer=k in parents)
        if k in parents:
            ex.setdefault("parent_task", t["title"])
            for _ in range(r.randint(2, 3)):
                sub = {"title": L.take("tasks", lambda: "%s the %s" % (r.choice(V.VERBS), r.choice(V.NOUNS)))}
                if r.random() < 0.5:
                    sub["due"] = None
                add_task(sub, parent=ref)
            if later and later != "completed":
                S.cmd("schedule.set_task_status", {"task_id": "$%s.task_id" % ref, "status": later})

    # -- notes ----------------------------------------------------------------------
    n_nb = r.randint(3, 5)
    nb_names = [L.force("notebooks", cap(themes[1]))]
    while len(nb_names) < n_nb:
        nb_names.append(L.take("notebooks", lambda: r.choice(P5.POOL["notebooks"]) if r.random() < 0.6
                               else cap(r.choice(V.NOUNS + [a.lower() for a in V.ACTS]))))
    for k, nb in enumerate(nb_names):
        S.cmd("knowledge.create_notebook", {"name": nb}, kind="notebooks", as_="nb%02d" % (k + 1))
    n_notes = r.randint(17, 26)  # + the weekly family
    notes = []
    for k in range(n_notes):
        if k < len(themes):
            w = themes[k]
            title = L.take("notes", lambda: "%s %s" % (cap(w), r.choice(V.NOTE_TAILS)))
        elif r.random() < 0.35:
            title = L.take("notes", lambda: cap(r.choice(P5.POOL["notes"])))
        else:
            title = L.take("notes", lambda: "%s %s" % (cap(r.choice(V.NOUNS + [a.lower() for a in V.ACTS])),
                                                       r.choice(V.NOTE_TAILS)))
        notes.append(title)
    fam = L.take("note-family", lambda: r.choice(["Meal plan", "Training log", "Reading notes", "Shopping list"]))
    for j in range(r.randint(3, 4)):
        notes.append(L.force("notes", "%s (wk %02d)" % (fam, week_no(now - dt.timedelta(days=7 * j)))))
    # a few rows go to the TRASH (soft delete), so "delete the X note" can find
    # only a trashed row and "put back the X I deleted" has something to restore
    trash_notes = set(r.sample(range(len(notes) - 4), 2))
    for at, title in enumerate(notes):
        lines = [title, "", "%s %s" % (r.choice(MOODS_NOTE), r.choice(TOPICS)),
                 "- %s" % cap(r.choice(V.NOUNS)), "- ask %s" % r.choice(humans)["first"],
                 "- %s" % r.choice(places)["name"]]
        body = {"title": title, "body_text": "\n".join(lines), "format": "markdown"}
        if r.random() < 0.8 or title.startswith(nb_names[0]):
            k = 0 if themes[1] in title.lower() else r.randrange(len(nb_names))
            body["notebook_id"] = "$nb%02d.notebook_id" % (k + 1)
        S.cmd("knowledge.create_note", body, kind="notes", as_="n%02d" % (at + 1))
        if at in trash_notes:
            S.cmd("knowledge.delete_note", {"note_id": "$n%02d.note_id" % (at + 1)})
            ex.setdefault("trashed", []).append(title)

    # -- documents ------------------------------------------------------------------
    folders = r.sample(P5.FOLDERS, r.randint(3, 5))
    for k, f in enumerate(folders):
        L.force("folders", f)
        S.cmd("core.create_folder", {"name": f}, kind="folders", as_="fo%02d" % (k + 1))
    n_docs = r.randint(12, 21)  # + the numbered family
    docs = []
    for k in range(n_docs):
        if k < len(themes):
            w = themes[k]
            title = L.take("documents", lambda: "%s %s" % (cap(w), r.choice(V.DOC_TAILS)))
        elif r.random() < 0.4:
            title = L.take("documents", lambda: cap(r.choice(P5.POOL["documents"])))
        else:
            title = L.take("documents", lambda: "%s %s%s" % (cap(r.choice(V.NOUNS)), r.choice(V.DOC_TAILS),
                                                             r.choice(["", "", " " + str(now.year - 1)])))
        docs.append(title)
    fam = L.take("doc-family", lambda: r.choice(["Payslip", "Energy bill", "Bank statement", "Water bill"]))
    for j in range(r.randint(3, 4)):
        docs.append(L.force("documents", "%s (%02d)" % (fam, j + 1)))
    starred = set(r.sample(range(len(docs)), r.randint(3, 5)))
    trash_doc = r.choice([k for k in range(len(docs) - 4) if k not in starred])
    for k, title in enumerate(docs):
        text = "# %s\n\nRef %s-%04d. Contact: %s. Filed %s." % (
            title, re.sub(r"[^A-Z]", "", title.upper())[:3] or "DOC", r.randint(0, 9999),
            r.choice(people)["name"], (now - dt.timedelta(days=r.randint(1, 400))).date().isoformat())
        body = {"title": title, "data_uri": "data:text/markdown," + urllib.parse.quote(text)}
        if r.random() < 0.85:
            body["folder_id"] = "$fo%02d.folder_id" % (r.randrange(len(folders)) + 1)
        ref = "d%02d" % (k + 1)
        S.cmd("core.add_document", body, kind="documents", as_=ref)
        if k in starred:
            S.cmd("core.star_document", {"document_id": "$%s.document_id" % ref})
        elif k == trash_doc and body.get("folder_id") != "$fo01.folder_id":
            S.cmd("core.trash_document", {"document_id": "$%s.document_id" % ref})
            ex.setdefault("trashed", []).append(title)

    # -- people's ledger: interactions, debts ------------------------------------------
    for p in r.sample(humans, r.randint(10, 16)):
        kind = r.choice(list(KINDS_OF_TALK))
        text = r.choice(KINDS_OF_TALK[kind]).format(topic=r.choice(TOPICS), place=r.choice(places)["name"],
                                                     thing=r.choice(V.NOUNS))
        S.cmd("people.log_interaction", {"party_id": pid(p), "kind": kind, "text": text}, kind="activities")
        ex.setdefault("interaction_party", p["name"])
    for p in r.sample(social + by_group["work"], r.randint(4, 8)):
        reason = r.choice([cap(r.choice(P5.POOL["expenses"])), "%s %s" % (cap(r.choice(themes)),
                                                                           r.choice(V.EXP_TAILS))])
        S.cmd("people.add_debt", {"party_id": pid(p), "direction": r.choice(["owe", "owed"]),
                                  "amount_minor": r.choice([500, 1200, 2000, 2500, 3500, 4800, 7500, 15000]),
                                  "reason": reason}, kind="obligations")
        ex.setdefault("debt_party", p["name"])

    # -- tally ------------------------------------------------------------------------------
    n_groups = r.randint(2, 4)
    n_exp = r.randint(20, 40)
    groups = []
    for k in range(n_groups):
        if k == 0:
            name = L.take("groups", lambda: "%s %s" % (cap(themes[2]), r.choice(V.GROUP_TAILS)))
        elif r.random() < 0.5:
            name = L.take("groups", lambda: r.choice(P5.POOL["groups"]))
        else:
            name = L.take("groups", lambda: "%s %s" % (r.choice(V.ACTS), r.choice(V.GROUP_TAILS)))
        members = r.sample(social + by_group["neighbour"], r.randint(2, 5))
        ref = "g%02d" % (k + 1)
        S.cmd("tally.create_group", {"name": name, "icon": r.choice(GROUP_ICONS), "currency": "GBP",
                                     "member_ids": [pid(p) for p in members]}, kind="groups", as_=ref)
        groups.append({"ref": ref, "members": members, "name": name})
    fam = L.take("exp-family", lambda: r.choice(["Groceries", "Petrol", "Takeaway", "Coffee run"]))
    fam_left = r.randint(3, 4)
    for k in range(n_exp):
        g = groups[k % n_groups] if k < n_groups * 2 else r.choice(groups)
        spent = (now - dt.timedelta(days=r.randint(0, 38))).date()
        if fam_left and k % 5 == 1:
            g = groups[0]
            desc = L.force("expenses", "%s (wk %02d)" % (fam, week_no(dt.datetime(spent.year, spent.month,
                                                                                    spent.day))))
            fam_left -= 1
        elif k < len(themes):
            desc = L.take("expenses", lambda: "%s %s" % (cap(themes[k]), r.choice(V.EXP_TAILS)))
        elif r.random() < 0.5:
            desc = L.take("expenses", lambda: cap(r.choice(P5.POOL["expenses"])))
        else:
            desc = L.take("expenses", lambda: "%s %s" % (cap(r.choice(V.NOUNS)), r.choice(V.EXP_TAILS)))
        everyone = ["$me.party_id"] + [pid(p) for p in g["members"]]
        payer = r.choice(everyone[:1] * 2 + everyone[1:])
        split = [x for x in everyone if x == payer or r.random() < 0.8]
        if len(split) < 2:
            split = everyone[:2] if payer in everyone[:2] else [payer, everyone[0]]
        amount = r.choice([r.randint(3, 60) * 100 + r.choice([0, 50, 99]), r.randint(300, 25000)])
        base_share = amount // len(split)
        rest = amount - base_share * len(split)
        splits = [{"party_id": x, "share_minor": base_share + (rest if x == payer else 0)} for x in split]
        S.cmd("tally.add_expense", {"group_id": "$%s.group_id" % g["ref"], "description": desc,
                                    "amount_minor": amount, "paid_by": payer,
                                    "category": r.choice(CATEGORIES), "spent_on": spent.isoformat(),
                                    "splits": splits}, kind="expenses")
    g = groups[-1]
    S.cmd("tally.settle_up", {"from_party": pid(g["members"][0]), "to_party": "$me.party_id",
                              "amount_minor": r.choice([1000, 2000, 2500]), "group_id": "$%s.group_id" % g["ref"],
                              "paid_on": (now - dt.timedelta(days=r.randint(1, 6))).date().isoformat()})

    # -- locker (canonical lines: the seat seals the content) -------------------------------
    n_lock = r.randint(8, 15)
    items = []
    items.append(("login", L.take("locker", lambda: "%s %s" % (cap(themes[3]) + " club", r.choice(
        LOCKER_LOGIN_TAILS)))))
    while len(items) < n_lock:
        roll = r.random()
        if roll < 0.5:
            items.append(("login", L.take("locker", lambda: "%s %s" % (r.choice(V.LOCKER_SVC),
                                                                       r.choice(LOCKER_LOGIN_TAILS)))))
        elif roll < 0.7:
            items.append(("card", L.take("locker", lambda: "%s %s card" % (r.choice(
                ["Joint", "Travel", "Savings", "Credit", "Library", "Gym", "Business"]), r.choice(CARD_BRANDS)))))
        else:
            items.append(("note", L.take("locker", lambda: "%s %s" % (r.choice(V.LOCKER_SVC),
                                                                      r.choice(LOCKER_NOTE_TAILS)))))
    for typ, title in items:
        p = r.choice(humans)
        if typ == "login":
            content = "username %s.%s · password %s-%s-%d" % (
                p["first"].lower(), p["last"].lower()[:1], r.choice(SECRET_WORDS), r.choice(SECRET_WORDS),
                r.randint(10, 99))
        elif typ == "card":
            content = "card number 4%03d %04d %04d %04d · expires %02d/%02d · cvc %03d" % (
                r.randint(0, 999), r.randint(0, 9999), r.randint(0, 9999), r.randint(0, 9999), r.randint(1, 12),
                (now.year + r.randint(1, 4)) % 100, r.randint(0, 999))
        else:
            content = r.choice(["PIN %04d" % r.randint(0, 9999), "code %06d" % r.randint(0, 999999),
                                "network %s-%s · key %s%d" % (cap(r.choice(SECRET_WORDS)), r.randint(1, 9),
                                                              r.choice(SECRET_WORDS), r.randint(100, 999))])
        S.canon('locker.add_item{type: "%s", title: "%s", content: "%s"}' % (typ, title, content), kind="locker items")

    # -- the People journal -------------------------------------------------------
    # Its own random stream, appended last, so every row above is what it was
    # before the journal existed. One entry always lands on last weekend's
    # Saturday and one earlier this week (when there is an earlier day).
    jr = random.Random("%s/w%02d/journal" % (seed, i))
    back = set(jr.sample(range(1, 22), jr.randint(5, 8)))
    back.add(now.weekday() + 2)
    if now.weekday() > 0:
        back.add(jr.randint(1, now.weekday()))
    for d in sorted(back, reverse=True):
        t = day_at(now, -d, 12)
        text = jr.choice(["Long day; mostly %s", "Thinking about %s", "Good news about %s",
                          "Worried about %s", "Sorted out %s at last", "Quiet evening after %s"]) % jr.choice(TOPICS)
        S.cmd("people.add_journal_entry", {"mood": jr.choice(JOURNAL_MOODS), "text": text,
                                           "entry_date": t.strftime("%Y-%m-%d")}, kind="journal notes")

    spec = {"now_ms": int(now.timestamp() * 1000), "seed": "v7-trainworld/%s/w%02d" % (seed, i), "writes": S.writes,
            "meta": {"now": iso(now), "weekday": now.strftime("%A"), "themes": themes, "counts": S.count,
                     "shared_first_names": sorted({p["first"] for p in humans
                                                   if sum(q["first"] == p["first"] for q in humans) > 1}),
                     "places": place_names, "groups": [g["name"] for g in groups], "folders": folders,
                     "notebooks": nb_names, "albums": album_titles,
                     "examples": dict(ex, album=album_titles[0], photo_place=places[0]["name"],
                                      group=groups[0]["name"], channel_party=people[-1]["name"])}}
    check_spec(spec, "w%02d" % i)
    return spec


# ---------------------------------------------------------------------------
# verification: build each world with tool-loop and walk its links
# ---------------------------------------------------------------------------

BIN = os.path.join(REPO, "target", "release", "tool-loop")


class Server:
    def __init__(self, path):
        t0 = time.time()
        self.p = subprocess.Popen([BIN, "serve", "--world", "spec:" + path], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.today = self.send({"op": "open"})
        self.build_s = time.time() - t0

    def send(self, msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError("tool-loop exited: " + self.p.stderr.read())
        return json.loads(line)

    def call(self, line):
        """one call in a fresh turn (a refused or clarifying call ends its turn)"""
        self.send({"op": "turn", "request": "verify"})
        return self.send({"op": "call", "line": line}).get("obs", "")

    def peek(self, line):
        return self.send({"op": "peek", "line": line})

    def close(self):
        try:
            self.send({"op": "quit"})
        except Exception:
            pass
        self.p.wait()


def rows_of(obs):
    return re.findall(r'^#(\d+) ([a-z]+(?: [a-z]+)?) "', obs, re.M)


def count_of(obs):
    m = re.search(r"… (\d+) rows in all", obs)
    return int(m.group(1)) if m else len(rows_of(obs))


def walk(sv, source, label, link):
    """`show (<source> called "<label>")`, then `show (<link> of (#n))` on its rows until one answers"""
    # A fresh session per walk: row numbers are keyed by id, so a party first shown as a
    # tally member keeps that member row behind its number, and `obligations of (#n)` on
    # it finds nothing (a reader quirk, not a seed gap).
    sv.send({"op": "open"})
    for n, _ in rows_of(sv.call('show (%s called "%s")' % (source, label)))[:6]:
        got = sv.call("show (%s of (#%s))" % (link, n))
        if rows_of(got):
            return count_of(got)
    return 0


def verify(path, spec):
    sv = Server(path)
    meta, ex = spec["meta"], spec["meta"]["examples"]
    out = {"build_s": round(sv.build_s, 2), "today": sv.today.get("today")}
    kinds = ["parties", "events", "tasks", "notes", "documents", "photos", "albums", "places", "groups", "members",
             "expenses", "locker items", "notebooks", "contact channels", "important dates", "activities",
             "obligations"]
    out["counts"] = {k: len(sv.peek("show (%s)" % k).get("rows", [])) for k in kinds}
    checks = {}
    for w in meta["themes"]:
        checks['search "%s"' % w] = sorted({k for _, k in rows_of(sv.call('search "%s"' % w))})
    walks = [("parties of (#event)", "events", ex.get("event_with_attendees"), "parties"),
             ("photos of (#album)", "albums", ex["album"], "photos"),
             ("photos of (#place)", "places", ex["photo_place"], "photos"),
             ("events of (#place)", "places", ex.get("event_place"), "events"),
             ("expenses of (#group)", "groups", ex["group"], "expenses"),
             ("members of (#group)", "groups", ex["group"], "members"),
             ("contact channels of (#party)", "parties", ex["channel_party"], "contact channels"),
             ("important dates of (#party)", "parties", ex["date_party"], "important dates"),
             ("activities of (#party)", "parties", ex["interaction_party"], "activities"),
             ("obligations of (#party)", "parties", ex["debt_party"], "obligations"),
             ("tasks of (#task) (subtasks)", "tasks", ex["parent_task"], "tasks")]
    for label, source, name, link in walks:
        checks[label] = walk(sv, source, name, link) if name else 0
    for label, line in [
        ("documents that (folder = …)", 'show (documents that (folder = "%s"))' % meta["folders"][0]),
        ("notes that (notebooks contains …)", 'show (notes that (notebooks contains "%s"))' % meta["notebooks"][0]),
        ('locker items that (type = "login")', 'show (locker items that (type = "login"))'),
        ('tasks that (status != "completed")', 'show (tasks that (status != "completed"))'),
        ('tasks that (status = "completed")', 'show (tasks that (status = "completed"))'),
        ("things during this weekend", "show (things during this weekend)"),
        ("events during this week", "show (events during this week)"),
        ("photos that (favorite = true)", 'show (photos that (favorite = "true"))'),
        ("documents that (starred = true)", 'show (documents that (starred = "true"))'),
        ('parties called "%s"' % meta["shared_first_names"][0],
         'show (parties called "%s")' % meta["shared_first_names"][0]),
    ]:
        checks[label] = count_of(sv.call(line))
    out["checks"] = checks
    out["failed"] = [k for k, v in checks.items() if not v or (k.startswith("search") and len(v) < 3)]
    sv.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=16)
    ap.add_argument("--out", default=os.path.join(HERE, "worlds"))
    ap.add_argument("--seed", default="v7")
    ap.add_argument("--verify", action="store_true", help="build each world with tool-loop and probe its links")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    report = {}
    for i in range(1, a.n + 1):
        spec = build_world(i, a.seed)
        path = os.path.abspath(os.path.join(a.out, "w%02d.json" % i))
        with open(path, "w", encoding="utf-8") as f:
            json.dump(spec, f, ensure_ascii=False, indent=0)
        line = "w%02d %s %-9s writes=%d %s" % (i, spec["meta"]["now"], spec["meta"]["weekday"], len(spec["writes"]),
                                               json.dumps(spec["meta"]["counts"]))
        print(line, flush=True)
        if a.verify:
            report["w%02d" % i] = verify(path, spec)
            print(json.dumps(report["w%02d" % i]), flush=True)
    if a.verify:
        with open(os.path.join(a.out, "verify.json"), "w") as f:
            json.dump(report, f, indent=1)


if __name__ == "__main__":
    main()
