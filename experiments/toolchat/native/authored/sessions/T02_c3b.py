from gold import *
import json

world("T02", "2027-06-08T11:05", "Mei-Lin Chau", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
S("T02-B002", "c3b superlative event next three pottery count",
  T("next three pottery classes", rows("pottery_0610", "pottery_0617", "pottery_0624", order=True),
    ref=[ans(kind="event", name="Pottery class", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("how many are left altogether", val(4),
    ref=[ans(op="count", kind="event", name="Pottery class", when=W({"from": U("day", 0)}))]))

S("T02-B003", "c3b superlative task quickest latest due count",
  T("quickest open job?", rows("glaze_order"),
    ref=[ans(kind="task", where=OPEN, order="effort asc", limit=1)]),
  T("what's the number of tasks still open for me", val(30),
    ref=[ans(op="count", kind="task", where=OPEN)]),
  T("and which one is due last", rows("tenant_ins"),
    ref=[ans(kind="task", where=OPEN, order="date desc", limit=1)]))

S("T02-B004", "c4b state-change complete complete create contrast",
  T("hydro bill's paid", diff(upd("hydro", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="hydro bill")]),
  T("sent rachel the pdf too", diff(upd("rachel_followup", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Rachel PDF")]),
  T("add a task, back up the laptop on friday", diff(new("task", name=has("laptop"), date="2027-06-11")),
    ref=[act("create", args=lines(kind="task", name="Back up the laptop", date=U("week", 0, weekday=5)))]))

S("T02-B005", "c4b state-change cancel event restore trashed event",
  T("anita's off sick so the dentist cancelled", diff(upd("dentist", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dentist cleaning")]),
  T("put the coffee with siobhan back", diff(restore("coffee_siobhan")),
    ref=[act("restore", kind="event", name="Coffee with Siobhan", trashed=True)]))

S("T02-B007", "c4b state-change complete catch up create contrast",
  T("crossed off the celadon glaze", diff(upd("glaze_order", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="celadon glaze")]),
  T("catch up with rachel thursday at 5", diff(new("event", name=has("Rachel"), date="2027-06-10T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Rachel", date=U("week", 0, weekday=4, time="17:00")))]))
