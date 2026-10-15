from gold import *
import json

world("T17", "2026-01-30T13:35", "Elena Petrova", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T17-B001", "c3b superlative event next three rehearsals count",
  T("next 3 choir rehearsals", rows("choir_0203", "choir_0210", "choir_0217", order=True),
    ref=[ans(kind="event", name="Choir rehearsal", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("so what's the headcount of choir rehearsals still on", val(6),
    ref=[ans(op="count", kind="event", name="Choir rehearsal", when=W({"from": U("day", 0)}))]))

S("T17-B004", "c4b state-change complete complete create contrast",
  T("paid the building fee", diff(upd("building_fee", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="building fee")]),
  T("got the metronome batteries", diff(upd("batteries", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="metronome batteries")]),
  T("new task: ask mitko about the shower drain", diff(new("task", name=has("Mitko"))),
    ref=[act("create", args=lines(kind="task", name="Ask Mitko about the shower drain"))]))

S("T17-B005", "c4b state-change cancel event restore trashed task",
  T("the piano tuner cancelled on me", diff(upd("tuner", status="cancelled")),
    ref=[act("cancel", kind="event", name="Piano tuner")]),
  T("get the hallway lamp one back, i need it", diff(restore("hall_lamp")),
    ref=[act("restore", kind="task", name="hallway lamp", trashed=True)]))

S("T17-B007", "c4b state-change complete catch up create contrast",
  T("picked the shower cabin", diff(upd("shower", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="shower cabin")]),
  T("catch up with desi saturday at 4", diff(new("event", name=has("Desi"), date="2026-01-31T16:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Desi", date=U("week", 0, weekday=6, time="16:00")))]))
