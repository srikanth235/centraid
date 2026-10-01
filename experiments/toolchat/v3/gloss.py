#!/usr/bin/env python3
"""Deterministic gloss: canonical -> stilted but unambiguous English.

One function per parser node (check.py's tree), so every alternative the
parser can build has exactly one reading. Used only to show a paraphraser what
a canonical means; never shown to the model being trained.

    python3 gloss.py                # glosses every line of canon.jsonl, reports failures
"""
import datetime, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import typing_v3  # noqa: E402,F401  (puts the grammar dir on sys.path)
import check  # noqa: E402

FIELD = {
    "due_at": "due date", "dtstart": "start time", "dtend": "end time", "summary": "title",
    "display_name": "name", "amount_minor": "amount (in pence)", "spent_on": "date spent",
    "captured_at": "date taken", "started_at": "start time", "ended_at": "end time",
    "paid_on": "date paid", "posted_at": "date posted", "incurred_on": "date incurred",
    "settled_at": "date settled", "completed_at": "completion date", "created_at": "date created",
    "updated_at": "date last changed", "deleted_at": "date deleted (trash)", "archived_at": "date archived",
    "last_contacted_at": "date last contacted", "next_occurrence": "next date it comes round",
    "birth_date": "date of birth", "password_set_at": "date the password was set",
    "opened_at": "date opened", "closed_at": "date closed", "rate_date": "exchange-rate date",
    "effort_min": "effort estimate in minutes", "remind_before_min": "reminder lead time in minutes",
    "cadence_days": "how often to keep in touch (days)", "owed_to_me": "amount they owe me",
    "owed_to_them": "amount I owe them", "from_party": "who pays / owes", "to_party": "who is paid / owed",
    "paid_by": "who paid", "project_id": "project", "parent_task_id": "parent task",
    "location_place_id": "place", "organizer_party_id": "organiser", "owner_party_id": "owner",
    "author_party_id": "author", "creator_party_id": "creator", "actor_party_id": "person involved",
    "party_id": "person", "group_id": "group", "circle_id": "circle", "account_id": "account",
    "counterparty_party_id": "counterparty", "institution_party_id": "bank / institution",
    "place_id": "place", "parent_place_id": "parent place", "album_titles": "albums it is in",
    "favorite": "favourite flag", "starred": "starred flag", "pinned": "pinned flag",
    "is_preferred": "preferred flag", "reminder_on": "reminder flag", "compromised": "compromised flag",
    "is_asset": "asset flag", "simplify_opt_in": "debt-simplification flag", "byte_size": "file size in bytes",
    "duration_s": "duration in seconds", "geo_lat": "latitude", "geo_lng": "longitude",
    "attendee_party_ids": "attendees", "member_party_ids": "members", "notebooks": "notebooks it is in",
    "original_amount_minor": "original amount (minor units)", "rrule": "repeat rule",
    "kind": "kind", "met": "how we met",
}
KIND = {"things": "anything at all (events, open tasks, important dates, …)"}
REF = {
    "it": "it (the one row the previous turn is about)",
    "them": "them (the rows the previous turn answered)",
    "that one": "that one (the row the previous turn is about)",
    "the other one": "the other one (of the two rows the previous turn answered)",
    "the earlier one": "the earlier one (what was answered TWO turns back)",
    "the last thing I added": "the last thing I added",
}
DUR = {"h": "hour", "d": "day", "m": "minute"}


def fname(f):
    return FIELD.get(f, f.replace("_id", "").replace("_", " "))


def day(iso):
    d = datetime.date.fromisoformat(iso[:10])
    return "%s %s" % (d.strftime("%A"), iso[:10])


def lit(node):
    """A literal operand/argument."""
    t, v = node.get("type"), node["value"]
    if t == "string":
        return '"%s"' % v
    if t == "date":
        return day(v)
    if t == "datetime":
        return "%s at %s" % (day(v), v[11:16])
    if t == "month":
        d = datetime.date.fromisoformat(v + "-01")
        return "the month of %s" % d.strftime("%B %Y")
    if t == "daterange":
        a, b = v.split("..")
        return "the days from %s to %s" % (day(a), day(b))
    if t == "duration":
        n, u = int(v[1:-1]), DUR[v[-1]]
        return "%d %s%s %s" % (n, u, "s" if n != 1 else "", "later" if v[0] == "+" else "earlier")
    if t == "keyword":
        return {"me": "me (the member)", "null": "nothing", "true": "yes", "false": "no"}[v]
    return v


def window(w):
    h = w["how"]
    if h == "phrase":
        v = w["value"]
        return {"before now": "before now (already past — overdue)",
                "recently": "recently (the last few days)"}.get(v, v)
    if h == "rolling":
        return "in the next %d %s" % (w["n"], w["unit"])
    if h == "anchored":
        return "between %s and %s" % (value(w["from"]), value(w["to"]))
    if h == "date":
        return "on " + day(w["value"])
    if h == "datetime":
        return "at %s on %s" % (w["value"][11:16], day(w["value"]))
    if h == "month":
        return "in " + datetime.date.fromisoformat(w["value"] + "-01").strftime("%B %Y")
    if h == "daterange":
        a, b = w["value"].split("..")
        return "between %s and %s" % (day(a), day(b))
    raise ValueError(h)


def sset(n):
    """A Set node."""
    k = n["node"]
    if k == "kind":
        return KIND.get(n["kind"], n["kind"])
    if k == "ref":
        if n["ref"] == "ordinal":
            return "the %s one (by position in the previous answer)" % ordinal(n["n"])
        return REF[n["ref"]]
    if k == "called":
        return '%s named "%s"' % (sset(n["set"]), n["lit"])
    if k == "filter":
        return "%s where %s" % (sset(n["set"]), pred(n["pred"]))
    if k == "during":
        return "%s dated %s" % (sset(n["set"]), window(n["window"]))
    if k == "order":
        return "%s, sorted by %s %s" % (sset(n["set"]), fname(n["field"]),
                                       "ascending (lowest/earliest first)" if n["dir"] == "asc"
                                       else "descending (highest/latest first)")
    if k == "first":
        return "the first %d of [%s]" % (n["n"], sset(n["set"]))
    if k == "walk":
        return "the %s linked to [%s]" % (n["kind"]["kind"], sset(n["from"]))
    if k == "union":
        return "[%s] together with [%s]" % (sset(n["left"]), sset(n["right"]))
    if k == "except":
        return "[%s] leaving out [%s]" % (sset(n["left"]), sset(n["right"]))
    raise ValueError(k)


def ordinal(n):
    return "%d%s" % (n, "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))


OPS = {"=": "is", "!=": "is not", "<": "is less than / before", ">": "is more than / after",
       "<=": "is at most / on or before", ">=": "is at least / on or after"}


def operand(o):
    if o["node"] == "setarg":
        return "[%s]" % sset(o["set"])
    if o["node"] == "fieldref":
        return "its own " + fname(o["field"])
    return lit(o)


def pred(p):
    k = p["node"]
    if k == "and":
        return "%s and %s" % (pred(p["left"]), pred(p["right"]))
    if k == "or":
        return "(%s or %s)" % (pred(p["left"]), pred(p["right"]))
    if k == "not":
        return "NOT (%s)" % pred(p["pred"])
    if k == "countwalk":
        return "the number of their %s %s %d" % (p["kind"], OPS[p["op"]].split(" /")[0], p["n"])
    if k == "member":
        return "they belong to [%s]" % sset(p["set"])
    if k == "is":
        what = "me (the member)" if p["what"] == "me" else None
        if what:
            return "the %s is %s%s" % (fname(p["field"]), "not " if p["not"] else "", what)
        return ("the %s is set" if p["not"] else "there is no %s") % fname(p["field"])
    if k == "pwindow":
        return "the %s falls %s" % (fname(p["field"]), window(p["window"]))
    if k == "band":
        c = p["centre"]
        return "the %s is around %s" % (fname(p["field"]), int(c) if c == int(c) else c)
    if k == "contains":
        return 'the %s contains "%s"' % (fname(p["field"]), p["lit"])
    if k == "oneof":
        return "the %s is one of %s" % (fname(p["field"]), ", ".join('"%s"' % x for x in p["lits"]))
    if k == "cmp":
        rhs = p["rhs"]
        if rhs.get("type") == "keyword" and rhs["value"] == "me":
            return "the %s %s me (the member)" % (fname(p["field"]), "is" if p["op"] == "=" else "is not")
        if rhs.get("type") == "number" and p["field"] in ("pinned", "is_preferred", "reminder_on",
                                                           "compromised", "is_asset", "simplify_opt_in"):
            return "the %s is %s" % (fname(p["field"]), "on" if rhs["value"] == "1" else "off")
        return "the %s %s %s" % (fname(p["field"]), OPS[p["op"]], operand(rhs))
    raise ValueError(k)


def value(v):
    k = v["node"]
    if k == "agg":
        if v["agg"] == "count":
            return "the number of [%s]" % sset(v["set"])
        word = {"sum": "total", "min": "lowest / earliest", "max": "highest / latest"}[v["agg"]]
        return "the %s %s of [%s]" % (word, fname(v["field"]), sset(v["set"]))
    if k == "project":
        return "the %s of [%s]" % (fname(v["field"]), sset(v["set"]))
    if k == "balance":
        return "the balance of [%s] within [%s]" % (sset(v["of"]), sset(v["in"]))
    raise ValueError(k)


def argval(a):
    if a["node"] == "setarg":
        return "[%s]" % sset(a["set"])
    if a["node"] == "lit":
        return lit(a)
    return value(a)


def money(a):
    if a["node"] == "lit" and a.get("type") == "number":
        n = int(float(a["value"]))
        return "%d.%02d (%s pence)" % (n // 100, n % 100, a["value"])
    return argval(a)


def cmd(c):
    v, a = c["verb"], c["args"]
    on = sset(c["on"]) if c["on"] else None
    g = lambda k: argval(a[k]) if k in a else None  # noqa: E731
    if v in ("reschedule", "schedule.edit_task", "schedule.reschedule_event"):
        if "by" in a:
            return "Shift [%s] %s" % (on, g("by"))
        return "Move [%s] to %s" % (on, g("to"))
    if v in ("delete", "schedule.delete_task", "schedule.delete_event", "knowledge.delete_note",
             "tally.delete_expense", "media.delete_asset", "locker.trash_item", "core.trash_document",
             "people.trash_person"):
        return "Delete (move to trash) [%s]" % on
    if v in ("restore", "schedule.restore_task", "core.restore_document", "media.restore_asset"):
        return "Restore [%s] from the trash" % on
    if v in ("cancel", "schedule.cancel_event"):
        return "Cancel [%s]" % on
    if v in ("people.undo_person", "tally.undo_expense"):
        return "Undo the last change made to [%s]" % on
    if v == "schedule.add_task":
        return "Add a task titled %s%s" % (g("title"), " due %s" % g("due_at") if "due_at" in a else "")
    if v == "schedule.set_task_status":
        return "Set the status of [%s] to %s" % (on, g("status"))
    if v == "schedule.propose_event":
        return "Put an event titled %s in the calendar starting %s%s" % (
            g("summary"), g("dtstart"), " and ending %s" % g("dtend") if "dtend" in a else "")
    if v == "knowledge.create_note":
        return "Create a note titled %s" % g("title")
    if v == "core.star_document":
        return "Star [%s]" % on
    if v == "locker.add_item":
        return "Save a new locker item titled %s of type %s%s" % (
            g("title"), g("type"), ", whose secret is %s" % g("content") if "content" in a else "")
    if v == "locker.reveal_receipt":
        return "Reveal the %s of [%s]" % (g("columns") or "password", on)
    if v == "media.add_to_album":
        return "Add [%s] to the album %s" % (on, g("album_id"))
    if v == "people.log_interaction":
        k = a["kind"]["value"] if "kind" in a else "call"
        return "Log that I had a %s with [%s]" % (k, on)
    if v == "people.settle_debt":
        return "Mark [%s] as settled / paid off" % on
    if v == "tally.add_expense":
        s = "Add an expense %s of %s" % (g("description"), money(a["amount_minor"]))
        if "category" in a:
            s += ", category %s" % g("category")
        if "group_id" in a:
            s += ", in the group %s" % g("group_id")
        if "paid_by" in a:
            s += ", paid by %s" % g("paid_by")
        return s
    if v == "tally.settle_up":
        if on:
            return "Settle up with [%s]: pay %s, in the group %s" % (on, money(a["amount_minor"]), g("group_id"))
        return "Record a settle-up payment of %s from %s in the group %s" % (
            money(a["amount_minor"]), g("from_party"), g("group_id"))
    if v == "tally.add_group_member":
        return "Add [%s] to the group %s" % (on, g("group_id"))
    raise ValueError(v)


REASON = {
    "out_of_ontology": "the request is outside what this vault/app can do or know",
    "sealed_egress": "it would send sealed secrets (passwords, card numbers) out of the vault",
    "fabricated_secret": "it needs a secret the member has not supplied, and the assistant must not invent one",
    "unbounded_destruction": "it would delete an unbounded set (everything of a kind)",
}


def gloss(canonical):
    t = check.parse(canonical)
    k = t["node"]
    if k == "nothing":
        return "Do nothing: the member withdraws the request."
    if k == "refuse":
        return "Refuse, because %s (%s)." % (REASON[t["reason"]], t["reason"])
    if k == "clarify":
        return "Ask the member to clarify: the request cannot be resolved as said (%s)." % t["reason"]
    if k == "show":
        return "List %s." % sset(t["set"])
    if k == "same":
        return "Are [%s] and [%s] the same (do they share a row)?" % (sset(t["left"]), sset(t["right"]))
    if k == "cmd":
        return cmd(t) + "."
    if k == "seq":
        return "First: %s. Then: %s." % tuple(cmd(s) for s in t["steps"][:2]) if len(t["steps"]) == 2 else \
            " Then: ".join(cmd(s) for s in t["steps"]) + "."
    return "What is %s?" % value(t)


def main():
    bad = 0
    n = 0
    for name in ("canon.jsonl", "heldout_canon.jsonl"):
        for line in open(os.path.join(HERE, name)):
            r = json.loads(line)
            for c in (r["target"], r["prev"]):
                if c == "NONE":
                    continue
                n += 1
                try:
                    g = gloss(c)
                    if re.search(r"that \(|ordered by|\{", g):
                        raise ValueError("dialect leaked: " + g)
                except Exception as e:  # noqa: BLE001
                    bad += 1
                    print("FAIL", c, "->", e)
    print("glossed %d canonicals, %d failures" % (n, bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
