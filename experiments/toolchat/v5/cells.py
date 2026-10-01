"""Coverage cells of a canonical line (kind x construct), for COVERAGE.md / STATS.md.

Cells are derived from the executor (crates/candidates/src/exec.rs): its kinds,
`walk` arms, filterable fields, aggregates and command arms. No evaluation data.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMMAR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "crates", "evalsuite", "grammar"))
sys.path.insert(0, GRAMMAR)
import check  # noqa: E402

# exec.rs `walk` arms: (target kind, source kind)
WALKS = [("expenses", "groups"), ("groups", "expenses"), ("settlements", "groups"), ("members", "groups"),
         ("obligations", "parties"), ("parties", "parties"), ("profiles", "parties"),
         ("important dates", "parties"), ("contact channels", "parties"), ("activities", "parties"),
         ("parties", "obligations"), ("parties", "events"), ("events", "parties"),
         ("photos", "places"), ("places", "photos"), ("photos", "albums"), ("albums", "photos"), ("tasks", "tasks")]
# exec.rs `body` arms (+ verb classes that resolve to one of them)
CMD_ARMS = ["schedule.edit_task", "schedule.reschedule_event", "schedule.add_task", "schedule.set_task_status",
            "schedule.propose_event", "schedule.cancel_event", "schedule.delete_task", "schedule.restore_task",
            "schedule.delete_event", "knowledge.create_note", "knowledge.delete_note", "core.trash_document",
            "core.star_document", "core.restore_document", "locker.add_item", "locker.trash_item",
            "locker.reveal_receipt", "media.add_to_album", "media.restore_asset", "media.delete_asset",
            "people.log_interaction", "people.settle_debt", "people.trash_person", "people.undo_person",
            "tally.add_expense", "tally.delete_expense", "tally.undo_expense", "tally.settle_up",
            "tally.add_group_member"]
CLASS_VERBS = ["reschedule", "delete", "restore", "cancel"]
KINDS = ["events", "tasks", "notes", "journal notes", "documents", "parties", "members", "important dates",
         "contact channels", "activities", "obligations", "photos", "albums", "places", "expenses", "groups",
         "settlements", "locker items", "things"]


def base_kind(s):
    if s is None:
        return None
    n = s.get("node")
    if n == "kind":
        return s["kind"]
    if n == "walk":
        return s["kind"]["kind"]
    if n in ("called", "filter", "during", "order", "first", "union", "except"):
        return base_kind(s.get("set") or s.get("left"))
    return None


def sets_in(node):
    for n in check.walk(node):
        if isinstance(n, dict) and n.get("node") in ("kind", "walk", "called", "filter", "during", "order", "first",
                                                      "union", "except", "ref"):
            yield n


def pred_fields(p, out):
    if not isinstance(p, dict):
        return
    n = p.get("node")
    if n in ("and", "or"):
        pred_fields(p.get("left"), out); pred_fields(p.get("right"), out)
    elif n == "not":
        pred_fields(p.get("pred") or p.get("inner"), out)
    elif "field" in p:
        f = p["field"]
        tag = f
        if n == "is":
            tag = "%s is %s%s" % (f, "not " if p.get("not") else "", p.get("what"))
        elif n == "cmp" and isinstance(p.get("rhs"), dict) and p["rhs"].get("node") == "lit" and p["rhs"].get("type") == "keyword":
            tag = "%s %s %s" % (f, p["op"], p["rhs"]["value"])
        elif n == "cmp" and f in ("status",):
            tag = "status %s %s" % (p["op"], p["rhs"].get("value") if isinstance(p.get("rhs"), dict) else "")
        elif n == "during":
            tag = f + " during"
        out.append(tag)
    elif n == "countwalk":
        out.append("count of walk")


def cells(line):
    """-> set of cell names for one canonical line"""
    t = check.parse(line)
    out = set()
    top = t.get("node")
    if top == "nothing":
        return {"nothing"}
    if top == "refuse":
        return {"refuse"}
    if top == "cmd":
        v = t["verb"]
        k = base_kind(t.get("on")) if t.get("on") else None
        on = t.get("on") or {}
        ref = on.get("node") == "ref"
        out.add("cmd %s%s" % (v, (" on " + (k or ("ref" if ref else "?"))) if v in CLASS_VERBS else ""))
        for a, val in (t.get("args") or {}).items():
            if isinstance(val, dict) and val.get("node") == "setarg":
                out.add("cmd %s %s:(set)" % (v, a))
        if v == "locker.add_item":
            ty = (t["args"].get("type") or {}).get("value")
            out.add("cmd locker.add_item type=%s" % ty)
        if on and not ref and base_kind(on) == "obligations":
            out.add("money act via obligations of")
    if top in ("agg",):
        k = base_kind(t.get("set"))
        out.add("%s %s" % ("count" if t["agg"] == "count" else t["agg"] + " " + str(t.get("field")), k or "ref"))
    if top in ("project", "field"):
        out.add("field-of %s %s" % (t.get("field"), base_kind(t.get("set")) or "ref"))
    if top == "balance":
        out.add("balance")
    if top == "same":
        out.add("same?")
    root = t.get("set") if top in ("show", "agg", "project", "field") else None
    for s in sets_in(t):
        n = s["node"]
        if n == "kind" and s is root:
            out.add("bare %s" % s["kind"])
        if n == "called":
            out.add("called %s" % base_kind(s["set"]))
        if n == "walk":
            out.add("walk %s of %s" % (s["kind"]["kind"], base_kind(s["from"]) or "ref"))
        if n == "filter":
            fs = []
            pred_fields(s.get("pred"), fs)
            for f in fs:
                out.add("filter %s: %s" % (base_kind(s["set"]) or "ref", f))
                base = f.split(" ")[0]
                out.add("filter %s: %s" % (base_kind(s["set"]) or "ref", base))
            p = s.get("pred") or {}
            if p.get("node") == "is" and p.get("field") == "party_id" and p.get("what") == "me":
                out.add("members excluding me")
        if n == "order":
            out.add("order %s" % (base_kind(s["set"]) or "ref"))
        if n == "during":
            out.add("during %s" % (base_kind(s["set"]) or "ref"))
        if n == "first":
            out.add("first N %s" % (base_kind(s["set"]) or "ref"))
        if n == "except":
            out.add("except")
    return out


if __name__ == "__main__":
    import collections
    c = collections.Counter()
    for l in open(sys.argv[1]):
        r = json.loads(l)
        for m in r["messages"]:
            if m["role"] == "assistant":
                c.update(cells(m["content"]))
    for k, v in sorted(c.items()):
        print(v, k)


# ---------------------------------------------------------------------------
# The target cells: what the executor answers, with the idiomatic English.
# ---------------------------------------------------------------------------
def _target():
    T = {}
    for k in ["tasks", "events", "notes", "documents", "parties", "photos", "albums", "places", "expenses", "groups",
              "locker items", "settlements", "important dates", "obligations"]:
        T["bare " + k] = "all my %s / how many %s" % (k, k)
    for k in ["events", "tasks", "notes", "journal notes", "documents", "parties", "members", "photos", "albums",
              "places", "expenses", "groups", "locker items", "things"]:
        T["called " + k] = "the <name> %s" % k
    T["called things"] = "what do I have about X (things called)"
    for a, b in WALKS:
        if a in ("parties", "profiles") and b == "parties":
            continue
        T["walk %s of %s" % (a, b)] = "%s of a named %s" % (a, b)
    T["walk photos of places"] = "photos from/taken at a place"
    F = {
        "tasks": [("status != completed", "open / still to do"), ("status = completed", "done / ticked off"),
                  ("due_at is null", "no due date"), ("due_at", "due before/after/during"),
                  ("completed_at", "finished when"), ("deleted_at is not null", "in the trash / deleted"),
                  ("priority", "high-priority")],
        "events": [("status", "cancelled / tentative"), ("deleted_at is not null", "deleted events"),
                   ("dtstart", "starting before/after")],
        "notes": [("notebooks", "in notebook X"), ("pinned = true", "pinned notes"),
                  ("deleted_at is not null", "deleted notes"), ("updated_at", "edited recently")],
        "documents": [("folder", "in folder X"), ("starred = true", "starred docs"),
                      ("deleted_at is not null", "binned docs"), ("updated_at", "changed recently")],
        "photos": [("album_titles", "in album X"), ("favorite = true", "my favourite photos"),
                   ("deleted_at is not null", "deleted photos"), ("place", "taken at X")],
        "parties": [("role", "my dentist / plumber"), ("owed_to_me is not null", "who owes me"),
                    ("owed_to_them is not null", "who I owe"), ("deleted_at is not null", "removed contacts"),
                    ("kind", "organisations / pets"), ("birth_date", "born before/after")],
        "obligations": [("settled_at is null", "outstanding debts"), ("from_party = me", "debts I owe"),
                        ("to_party = me", "money owed to me")],
        "contact channels": [("kind", "phone / email / address"), ("label", "work / home number")],
        "important dates": [("label", "birthday / anniversary"), ("next_occurrence", "coming up when")],
        "locker items": [("type", "cards / wifi / notes in the locker"), ("compromised = true", "compromised logins")],
        "expenses": [("category", "food / travel spending"), ("spent_on", "spent when"), ("amount_minor", "over / under N")],
        "members": [("party_id is not me", "the others in the group, not me")],
        "places": [("kind", "home / work / venue places")],
        "activities": [("started_at", "calls/visits when")],
        "things": [("folder", "anything filed under X"), ("notebooks", "anything in notebook X")],
    }
    for k, fs in F.items():
        for f, e in fs:
            T["filter %s: %s" % (k, f)] = e
    for k in ["tasks", "events", "expenses", "photos", "documents", "notes", "parties", "activities", "obligations",
              "journal notes"]:
        T["order " + k] = "%s sorted by / latest / earliest" % k
    for k in ["tasks", "events", "notes", "documents", "parties", "photos", "albums", "places", "expenses", "groups",
              "locker items", "obligations", "contact channels", "activities", "important dates", "members"]:
        T["count " + k] = "how many %s" % k
    for c in ["sum amount_minor expenses", "sum amount_minor obligations", "max amount_minor expenses",
              "min amount_minor expenses", "min due_at tasks", "max dtstart events"]:
        T[c] = "total / biggest / smallest / earliest"
    for c in ["field-of dtstart events", "field-of due_at tasks", "field-of amount_minor expenses",
              "field-of spent_on expenses", "field-of next_occurrence important dates", "field-of value contact channels"]:
        T[c] = "when is / how much was / what is"
    for v in CMD_ARMS:
        T["cmd " + v] = "write"
    for k in ["tasks", "events"]:
        T["cmd reschedule on " + k] = "move / push"
    for k in ["tasks", "events", "notes", "documents", "expenses", "locker items", "photos"]:
        T["cmd delete on " + k] = "delete / bin (class verb)"
    for k in ["tasks", "documents", "photos"]:
        T["cmd restore on " + k] = "put it back (class verb)"
    T["cmd cancel on events"] = "cancel (class verb)"
    T.update({
        "cmd media.add_to_album album_id:(set)": "add these photos to album X",
        "cmd locker.add_item type=note": "save the code 4417 in my locker",
        "members excluding me": "who else is in the group (not me)",
        "money act via obligations of": "settle/sum/show money with a person",
        "nothing": "forget it / never mind",
        "cmd tally.undo_expense": "put it back after deleting an expense",
        "cmd people.undo_person": "put them back after deleting a person",
        "filter photos: favorite = true": "my favourite photos",
        "count locker items": "how many things in my locker",
    })
    return T


TARGET = _target()
# executor-supported but deliberately not generated (COVERAGE.md section 4)
NOT_GENERATED = {c for c in TARGET if c.startswith(("cmd delete on ", "cmd restore on ", "cmd cancel on "))} | {
    "cmd schedule.edit_task", "cmd schedule.reschedule_event", "filter parties: birth_date"}
