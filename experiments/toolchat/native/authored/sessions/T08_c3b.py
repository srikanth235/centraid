from gold import *
import json

world("T08", "2026-04-06T17:50", "Deshawn Carter", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
S("T08-B002", "c3b superlative note latest document oldest count",
  T("latest note i wrote", rows("franklin"),
    ref=[ans(kind="note", order="date desc", limit=1)]),
  T("and the oldest document i've got", rows("epa_cert"),
    ref=[ans(kind="document", order="date asc", limit=1)]),
  T("how many documents is that in all", val(19),
    ref=[ans(op="count", kind="document")]))

S("T08-B004", "c4b state-change complete complete create contrast",
  T("topped up the lunch accounts", diff(upd("lunch", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="lunch accounts")]),
  T("furnace filter's changed", diff(upd("filter_apr", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="furnace filter")]),
  T("new task: call mike about the on-call schedule", diff(new("task", name=has("Mike"))),
    ref=[act("create", args=lines(kind="task", name="Call Mike about the on-call schedule"))]))

S("T08-B005", "c4b state-change cancel event restore trashed note",
  T("cancelled the haircut saturday, the shop's shut", diff(upd("haircut", status="cancelled")),
    ref=[act("cancel", kind="event", name="Haircut")]),
  T("get the old minisplit quote back", diff(restore("old_quote")),
    ref=[act("restore", kind="note", name="minisplit quote", trashed=True)]))

S("T08-B007", "c4b state-change complete catch up create contrast",
  T("paid the water bill", diff(upd("water_04", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="water bill")]),
  T("catch up with trey thursday at 5", diff(new("event", name=has("Trey"), date="2026-04-09T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Trey", date=U("week", 0, weekday=4, time="17:00")))]))
