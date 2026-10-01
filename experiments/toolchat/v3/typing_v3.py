"""The TYPING the v3 sampler walks under: every (kind, field, predicate form),
aggregate, link and executable command, read from derived.json + lexicon.py +
v2/arms.json. Nothing here is read from the evaluation suite (map.json,
suite.json, blind.json, holdout.json are never opened).

Hand-owned additions, each with its source:
  * reader fields (terminals.json readerFields; GRAMMAR.md 2.2) typed by hand;
  * `photos` = core.content_item + media.asset (terminals.json `composite`);
  * `albums`/`notebooks` read core.collection (terminals.json `ontologyEntity`);
  * join-table / composite links GRAMMAR.md 2.3 names that derived.json's FK
    list does not carry (photos<->albums, photos<->places, members<->groups,
    parties<->events via attendees, notes<->notebooks) — exec.rs walks them.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
GRAMMAR = os.path.join(ROOT, "crates", "evalsuite", "grammar")
sys.path.insert(0, GRAMMAR)
sys.path.insert(0, os.path.join(HERE, ".."))
import lexicon as L  # noqa: E402

DERIVED = json.load(open(os.path.join(GRAMMAR, "derive", "derived.json")))
ARMS = json.load(open(os.path.join(HERE, "..", "v2", "arms.json")))

SOURCES = {k: ["%s@%s" % v] for k, v in L.KINDS.items() if k != "things"}
SOURCES["photos"] = ["core.content_item@photos", "media.asset@photos"]
SOURCES["albums"] = ["core.collection@photos"]
SOURCES["notebooks"] = ["core.collection@notes"]

# fields a member never names: optimistic-lock counters, purge stamps, primary keys
NEVER = {"row_version", "purge_at", "sort_order"}
# opaque machinery: only presence (`is null` / `is not null`) is sayable
NULL_ONLY = {"ical_uid", "content_hash", "content_uri", "geohash", "key_id",
             "provenance_json", "split_params_json", "transfer_group_id",
             "external_id", "external_ref", "exif_json", "capture_group_id",
             "address_json", "normalized_value", "language", "rrule_support",
             "current_revision_id", "current_content_id", "body_content_id",
             "kind_concept_id", "source_app_id", "category_concept_id",
             "section_id", "series_id", "camera_device_id", "origin_device_id",
             "connection_id", "source_asset_id", "avatar_content_id",
             "cover_content_id", "recurring_template_id", "txn_id",
             "rate_scaled", "rate_scale", "asset_id", "content_id",
             "attendee_party_ids", "member_party_ids", "tz_offset_min"}
FLAG_FIELDS = {"pinned", "is_preferred", "reminder_on", "compromised", "is_asset", "simplify_opt_in"}
SEALED = {"password", "otp_seed", "card_number", "cvv", "content"}

READER = {  # terminals.json readerFields, typed here
    "photos": {"favorite": "bool", "album_titles": "textlist", "album": "text",
               "place": "text"},
    "documents": {"starred": "bool", "folder": "text"},
    "events": {"attendee_party_ids": "reflist"},
    "notes": {"notebooks": "textlist"},
    "groups": {"member_party_ids": "reflist"},
    "important dates": {"next_occurrence": "date"},
    "parties": {"owed_to_me": "money", "owed_to_them": "money"},
    "members": {"owed_to_me": "money", "owed_to_them": "money"},
}
READER_FORMS = {
    "bool": ["= true", "= false"],
    "text": ["contains Lit", "= Lit", "is null", "is not null"],
    "textlist": ["contains Lit"],
    "reflist": ["is null", "is not null"],
    "date": ["during Window", "< Date", "> Date"],
    "money": ["> Num", "< Num", "is not null"],
}

# the salient date `Set during Window` compares (exec.rs date_field)
SALIENT = {"events": "dtstart", "tasks": "due_at", "notes": "updated_at",
           "journal notes": "updated_at", "documents": "updated_at",
           "photos": "captured_at", "expenses": "spent_on",
           "settlements": "paid_on", "activities": "started_at",
           "important dates": "next_occurrence", "transactions": "posted_at"}
# the label `called` matches (exec.rs label_field + search domains)
LABEL = {"events": "summary", "tasks": "title", "notes": "title",
         "journal notes": "title", "documents": "title", "parties": "display_name",
         "members": "display_name", "photos": "title", "albums": "name",
         "notebooks": "name", "places": "name", "expenses": "description",
         "groups": "name", "circles": "name", "accounts": "name",
         "transactions": "description", "projects": "name", "locker items": "title"}

TABLE_OF = {}
for k in DERIVED["kinds"]:
    TABLE_OF["%s@%s" % (k["entity"], k["door"])] = k["table"]
TABLE_OF["media.asset@photos"] = "media_asset"
TABLE_OF["core.collection@photos"] = TABLE_OF.get("core.collection@photos", "core_collection")
TABLE_OF["core.collection@notes"] = "core_collection"
PK = {}
for k in DERIVED["kinds"]:
    PK["%s@%s" % (k["entity"], k["door"])] = k.get("idColumn")

# FK column -> referenced entity, from derived links ("t.col down the FK")
FK = {}
for l in DERIVED["links"]:
    if l["direction"].startswith("down"):
        FK[l["via"]] = l["to"]["entity"]
ENTITY_KIND = {"core.party": "parties", "core.place": "places",
               "schedule.project": "projects", "tally.group": "groups",
               "core.account": "accounts", "core.transaction": "transactions",
               "social.circle": "circles", "core.content_item": "photos",
               "schedule.task": "tasks", "core.event": "events",
               "knowledge.note": "notes", "core.document": "documents",
               "tally.expense": "expenses"}
TALLY_KINDS = {"members", "expenses", "groups", "circles", "settlements",
               "accounts", "transactions"}


def build():
    kinds = {}
    for kind, srcs in SOURCES.items():
        fields = {}
        for key in srcs:
            table = TABLE_OF.get(key)
            pk = PK.get(key)
            for f, v in DERIVED["predicates"][key].items():
                if f in fields or f in NEVER or f == pk or f not in L.FIELDS:
                    continue      # sealed columns are not grammar Fields (GRAMMAR.md 2.2)
                if kind == "photos" and f in ("asset_id", "content_id"):
                    continue
                if kind in ("albums", "notebooks") and f == "collection_id":
                    continue
                forms = list(v["predicates"])
                shape = v["shape"]
                target = None
                if shape == "reference":
                    ent = FK.get("%s.%s" % (table, f))
                    target = ENTITY_KIND.get(ent)
                    if target == "parties" and kind in TALLY_KINDS:
                        target = "members"
                    if target is None or f in NULL_ONLY:
                        forms = [x for x in forms if x.startswith("is")]
                        if "= me" in v["predicates"] and ent == "core.party":
                            forms.append("= me")
                if f in NULL_ONLY or f in SEALED:
                    forms = [x for x in forms if x.startswith("is")]
                if shape == "reference" and target not in ("parties", "members") and \
                        FK.get("%s.%s" % (table, f)) != "core.party":
                    forms = [x for x in forms if x != "= me"]   # only a party can be me
                if f == "month_day":
                    forms = []          # stores MM-DD: only sortable, never windowed
                fields[f] = {"shape": shape, "values": v.get("checkValues"),
                             "forms": forms, "target": target,
                             "house": bool(v.get("housekeeping"))}
        for f in FLAG_FIELDS & set(fields):
            fields[f]["forms"] = ["= Num"]
        for f, shape in READER.get(kind, {}).items():
            fields[f] = {"shape": shape, "values": None,
                         "forms": list(READER_FORMS[shape]), "target": None,
                         "house": False, "reader": True}
        sums, minmax = set(), set()
        for key in srcs:
            a = DERIVED["aggs"][key]
            sums |= set(a["sum|min|max"])
            minmax |= set(a["min|max"])
        sums = {f for f in sums if f in fields and fields[f]["shape"] in ("money", "integer", "real")
                and fields[f]["values"] is None and f not in NULL_ONLY}
        if kind in ("parties", "members"):
            sums |= {"owed_to_me", "owed_to_them"}
        minmax = {f for f in minmax if f in fields and f != "purge_at"}
        if kind == "important dates":
            minmax.add("next_occurrence"); minmax.discard("month_day")
        kinds[kind] = {"fields": fields, "sum": sorted(sums),
                       "minmax": sorted(minmax | sums),
                       "label": LABEL.get(kind), "salient": SALIENT.get(kind)}
    return kinds


KINFO = build()

# -- links: derived FK links between grammar kinds, symmetrised, plus the
#    join-table/composite walks GRAMMAR.md 2.3 names and exec.rs executes
def _links():
    rev = {}
    for kind, srcs in SOURCES.items():
        for s in srcs:
            rev.setdefault(s, kind)
    pairs = set()
    for l in DERIVED["links"]:
        a = rev.get("%s@%s" % (l["from"]["entity"], l["from"]["door"]))
        b = rev.get("%s@%s" % (l["to"]["entity"], l["to"]["door"]))
        if a and b and a != b:
            if {a, b} & {"members"} and not ({a, b} & TALLY_KINDS - {"members"}) and \
                    ("parties" in (a, b) or True):
                pass
            pairs.add((a, b)); pairs.add((b, a))
    extra = [("photos", "albums"), ("photos", "places"), ("members", "groups"),
             ("parties", "events"), ("notes", "notebooks")]
    for a, b in extra:
        pairs.add((a, b)); pairs.add((b, a))
    return pairs


LINKS = _links()
# walks exec.rs executes today (weighted up; the rest are legal and covered)
EXEC_WALKS = {("expenses", "groups"), ("groups", "expenses"), ("settlements", "groups"),
              ("members", "groups"), ("obligations", "parties"), ("profiles", "parties"),
              ("important dates", "parties"), ("contact channels", "parties"),
              ("activities", "parties"), ("parties", "obligations"),
              ("parties", "events"), ("events", "parties"), ("photos", "places"),
              ("places", "photos"), ("photos", "albums"), ("albums", "photos")}
# (walked kind, source kind): `B of (A)` reads as B-rows related to A-rows
# count of Kind over the walk: (filtered kind, counted kind) where one A has many B
COUNT_WALKS = sorted({(a, b) for (a, b) in LINKS if (a, b) in {
    ("places", "photos"), ("albums", "photos"), ("groups", "expenses"),
    ("groups", "settlements"), ("projects", "tasks"), ("accounts", "transactions"),
    ("parties", "activities"), ("parties", "obligations"), ("parties", "contact channels"),
    ("parties", "important dates"), ("parties", "events"), ("members", "expenses"),
    ("circles", "groups"), ("notebooks", "notes"), ("places", "events"),
    ("places", "activities"), ("parties", "tasks"), ("parties", "journal notes"),
    ("events", "parties"), ("groups", "members")}})
MEMBER_OF = [("photos", "albums"), ("notes", "notebooks"), ("members", "groups"),
             ("parties", "events"), ("parties", "circles"), ("members", "circles")]

# -- the executor: command -> (anchor kind, arg subsets); classes resolve by anchor
ENTITY_OF = {k: v[0] for k, v in L.KINDS.items()}
CMDS = {
    "schedule.edit_task": ("tasks", [("to",)]),
    "schedule.reschedule_event": ("events", [("to",), ("by",)]),
    "schedule.add_task": (None, [("title",), ("title", "due_at")]),
    "schedule.set_task_status": ("tasks", [("status",)]),
    "schedule.propose_event": (None, [("summary", "dtstart"), ("summary", "dtstart", "dtend")]),
    "schedule.cancel_event": ("events", [()]),
    "schedule.delete_task": ("tasks", [()]),
    "schedule.restore_task": ("tasks", [()]),
    "schedule.delete_event": ("events", [()]),
    "knowledge.create_note": (None, [("title",)]),
    "knowledge.delete_note": ("notes", [()]),
    "core.trash_document": ("documents", [()]),
    "core.star_document": ("documents", [()]),
    "core.restore_document": ("documents", [()]),
    "locker.add_item": (None, [("title", "type"), ("content", "title", "type")]),
    "locker.trash_item": ("locker items", [()]),
    "locker.reveal_receipt": ("locker items", [(), ("columns",)]),
    "media.add_to_album": ("photos", [("album_id",)]),
    "media.restore_asset": ("photos", [()]),
    "media.delete_asset": ("photos", [()]),
    "people.log_interaction": ("parties", [(), ("kind",)]),
    "people.settle_debt": ("obligations", [()]),
    "people.trash_person": ("parties", [()]),
    "people.undo_person": ("parties", [()]),
    "tally.add_expense": (None, [("amount_minor", "description"),
                                 ("amount_minor", "category", "description"),
                                 ("amount_minor", "description", "group_id"),
                                 ("amount_minor", "description", "paid_by"),
                                 ("amount_minor", "description", "group_id", "paid_by"),
                                 ("amount_minor", "category", "description", "group_id")]),
    "tally.delete_expense": ("expenses", [()]),
    "tally.undo_expense": ("expenses", [()]),
    "tally.settle_up": (None, [("amount_minor", "from_party", "group_id"),
                               ("amount_minor", "group_id")]),
    "tally.add_group_member": ("parties", [("group_id",)]),
}
assert set(CMDS) == set(ARMS), set(CMDS) ^ set(ARMS)
# verb classes that resolve to an ARMS command for a given anchor kind
CLASS_OK = {}
for cls, table in L.VERB_CLASSES.items():
    for kind, ent in ENTITY_OF.items():
        cmd = table.get(ent)
        if cmd in ARMS:
            CLASS_OK[(cls, kind)] = cmd
# journal notes delete goes through the same command as notes
REQUIRED = {"schedule.edit_task": {"to"}, "schedule.add_task": {"title"},
            "schedule.propose_event": {"dtstart"}, "knowledge.create_note": {"title"},
            "media.add_to_album": {"album_id"}, "tally.add_expense": {"amount_minor"},
            "tally.settle_up": {"amount_minor", "group_id"},
            "tally.add_group_member": {"group_id"}}
NEEDS_ANCHOR = {c for c, (a, _) in CMDS.items() if a is not None}


if __name__ == "__main__":
    n = 0
    for k, v in KINFO.items():
        fs = {f: x["forms"] for f, x in v["fields"].items() if x["forms"]}
        n += len(fs)
        print(k, "label=%s salient=%s" % (v["label"], v["salient"]))
        print("   sum:", v["sum"], " minmax:", v["minmax"])
        for f, x in v["fields"].items():
            print("   %-22s %-9s %-4s %s" % (f, x["shape"], x["target"] or "", x["forms"]))
    print("pairs with forms:", n)
    print("links:", len(LINKS), sorted(LINKS))
    print("count walks:", COUNT_WALKS)
    print("class ok:", CLASS_OK)
    covered = set()
    for v in KINFO.values():
        covered |= set(v["fields"])
    print("FIELDS never typed:", sorted(set(L.FIELDS) - covered))
