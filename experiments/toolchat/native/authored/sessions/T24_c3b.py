from gold import *
import json

world("T24", "2026-09-18T15:05", "Carlos Mendoza", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T24-B001", "c3b superlative event next three open gyms count",
  T("next 3 open gyms", rows("gym_0922", "gym_0924", "gym_0929", order=True),
    ref=[ans(kind="event", name="Open gym", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("any idea how many open gyms are still scheduled", val(8),
    ref=[ans(op="count", kind="event", name="Open gym", when=W({"from": U("day", 0)}))]))

S("T24-B004", "c4b state-change complete complete create contrast",
  T("returned the library books", diff(upd("library", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="library books")]),
  T("emailed the team parents", diff(upd("email_parents", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="team parents")]),
  T("new task: ring sandra about the cleaning", diff(new("task", name=has("Sandra"))),
    ref=[act("create", args=lines(kind="task", name="Ring Sandra about the cleaning"))]))

S("T24-B005", "c4b state-change cancel event restore trashed task",
  T("dr anand's office cancelled the checkup", diff(upd("checkup", status="cancelled")),
    ref=[act("cancel", kind="event", name="Checkup")]),
  T("put the treadmill one back", diff(restore("treadmill")),
    ref=[act("restore", kind="task", name="treadmill", trashed=True)]))

S("T24-B007", "c4b state-change complete catch up create contrast",
  T("garage door's fixed", diff(upd("garage_door", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="garage door")]),
  T("catch up with ray monday at 5", diff(new("event", name=has("Ray"), date="2026-09-21T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Ray", date=U("week", 1, weekday=1, time="17:00")))]))
