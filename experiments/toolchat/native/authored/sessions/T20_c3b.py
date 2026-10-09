from gold import *
import json

world("T20", "2026-05-28T16:10", "Matteo Ricci", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T20-B001", "c3b superlative event next three briefings count",
  T("next three staff wine briefings", rows("brief_0602", "brief_0609", "brief_0616", order=True),
    ref=[ans(kind="event", name="Staff wine briefing", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("how many of those staff briefings are still to come, all told", val(5),
    ref=[ans(op="count", kind="event", name="Staff wine briefing", when=W({"from": U("day", 0)}))]))

S("T20-B004", "c4b state-change complete complete create contrast",
  T("picked up the dry cleaning", diff(upd("dry_clean", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="dry cleaning")]),
  T("paid the car tax", diff(upd("car_tax", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="car tax")]),
  T("new task: call piero about the sockets", diff(new("task", name=has("Piero"))),
    ref=[act("create", args=lines(kind="task", name="Call Piero about the sockets"))]))

S("T20-B005", "c4b state-change cancel event restore trashed task",
  T("piero cancelled the electrician visit at the new flat", diff(upd("electrician_visit", status="cancelled")),
    ref=[act("cancel", kind="event", name="Electrician")]),
  T("bring back the helmet one", diff(restore("helmet")),
    ref=[act("restore", kind="task", name="helmet", trashed=True)]))

S("T20-B006", "c4b state-change settle_debt log nickname",
  T("stefano paid me for the gran fondo entry", diff(upd("d_stefano", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Gran fondo entry")]),
  T("had coffee with mamma", diff(upd("mamma", date=ANY)),
    ref=[search("mamma", kind="person"), act("log", rows="$mamma", args=lines(kind="coffee"))]))

S("T20-B007", "c4b state-change complete catch up create contrast",
  T("ordered the chianti", diff(upd("chianti_1", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Chianti Classico")]),
  T("catch up with andrea saturday at 5", diff(new("event", name=has("Andrea"), date="2026-05-30T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Andrea", date=U("week", 0, weekday=6, time="17:00")))]))
