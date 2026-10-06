from gold import *
import json

world("T07", "2026-03-12T12:30", "Maria Ines Quispe", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T07-B004", "c4b state-change complete task create contrast",
  T("paid the water bill", diff(upd("water_bill", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="water bill")]),
  T("done with the report too", diff(upd("scout_report", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="report")]),
  T("new task: call the gas company about the cylinder", diff(new("task", name=has("gas"))),
    ref=[act("create", args=lines(kind="task", name="Call the gas company about the cylinder"))]))

S("T07-B005", "c4b state-change cancel event book contrast",
  T("elena's office rang, they cancelled the dentist", diff(upd("dentist", status="cancelled")),
    ref=[act("cancel", kind="event", name="dentist")]),
  T("book drinks with hugo friday at 6", diff(new("event", name=has("Hugo"), date="2026-03-13T18:00")),
    ref=[act("create", args=lines(kind="event", name="Drinks with Hugo", date=U("week", 0, weekday=5, time="18:00")))]))

S("T07-B007", "c4b state-change log catch up create contrast",
  T("had a coffee with lucia", diff(upd("lucia", date=ANY)),
    ref=[act("log", kind="person", name="Lucia", args=lines(kind="coffee"))]),
  T("catch up with hugo thursday at 5", diff(new("event", name=has("Hugo"), date="2026-03-12T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Hugo", date=U("week", 0, weekday=4, time="17:00")))]))
