from gold import *
import json

world("T22", "2026-07-13T21:25", "Sven Lindqvist", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T22-B001", "c3b superlative event next three padel matches count",
  T("next 3 padel matches", rows("padel_0714", "padel_0721", "padel_0728", order=True),
    ref=[ans(kind="event", name="Padel league match", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("padel matches left this season, how many", val(7),
    ref=[ans(op="count", kind="event", name="Padel league match", when=W({"from": U("day", 0)}))]))

S("T22-B004", "c4b state-change complete complete create contrast",
  T("paid the parking fine", diff(upd("parking_fine", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="parking fine")]),
  T("bought the padel balls", diff(upd("balls", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="padel balls")]),
  T("new task: call kent about the summer house sink", diff(new("task", name=has("Kent"))),
    ref=[act("create", args=lines(kind="task", name="Call Kent about the summer house sink"))]))

S("T22-B005", "c4b state-change cancel event restore trashed task",
  T("kent cancelled the plumber visit", diff(upd("plumber", status="cancelled")),
    ref=[act("cancel", kind="event", name="Plumber")]),
  T("bring back the old bike one", diff(restore("bike")),
    ref=[act("restore", kind="task", name="old bike", trashed=True)]))

S("T22-B006", "c4b state-change settle_debt log nickname",
  T("erik paid me the court share", diff(upd("d_erik", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Court share")]),
  T("rang pappa", diff(upd("lennart", date=ANY)),
    ref=[search("pappa", kind="person"), act("log", rows="$lennart", args=lines(kind="call"))]))

S("T22-B007", "c4b state-change complete catch up create contrast",
  T("booked the court", diff(upd("court_1", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="padel court")]),
  T("catch up with mikael wednesday at 5", diff(new("event", name=has("Mikael"), date="2026-07-15T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Mikael", date=U("week", 0, weekday=3, time="17:00")))]))
