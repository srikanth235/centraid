from gold import *
import json

world("T09", "2026-05-13T08:05", "Hanae Okafor", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
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
