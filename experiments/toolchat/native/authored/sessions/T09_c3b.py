from gold import *
import json

world("T09", "2026-05-13T08:05", "Hanae Okafor", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T09-B003", "c3b superlative debt top 3 sum biggest owed",
  T("top 3 debts people owe me", rows("d_mom", "d_ada", "d_kemi", order=True),
    ref=[ans(kind="debt", where=OWED, order="amount desc", limit=3)]),
  T("and what's the total they owe me", val((527.5, "CAD")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("which debt of mine is the biggest", rows("d_dad"),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=1)]))

S("T09-B004", "c4b state-change complete complete create contrast",
  T("sent fatou the barrister index", diff(upd("index_fatou", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Barrister index")]),
  T("reviewed the northvale nda", diff(upd("nda", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Northvale NDA")]),
  T("book drinks with marcus friday at 6", diff(new("event", name=has("Marcus"), date="2026-05-15T18:00")),
    ref=[act("create", args=lines(kind="event", name="Drinks with Marcus", date=U("week", 0, weekday=5, time="18:00")))]))

S("T09-B005", "c4b state-change cancel event restore trashed task",
  T("the cake tasting is cancelled, they double booked", diff(upd("cake", status="cancelled")),
    ref=[act("cancel", kind="event", name="Cake tasting")]),
  T("bring back the pottery signup task", diff(restore("pottery_signup")),
    ref=[act("restore", kind="task", name="pottery", trashed=True)]))

S("T09-B006", "c4b state-change settle_debt log nickname",
  T("ada's settled up for the alterations", diff(upd("d_ada", status="settled")),
    ref=[act("settle_debt", kind="debt", name="alterations")]),
  T("messaged mom back", diff(upd("mom", date=ANY)),
    ref=[search("mom", kind="person"), act("log", rows="$mom", args=lines(kind="message"))]))
