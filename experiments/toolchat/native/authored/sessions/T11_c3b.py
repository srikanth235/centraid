from gold import *
import json

world("T11", "2026-07-26T07:30", "Siobhan Kelly", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T11-B001", "c3b superlative event next three training count",
  T("next 3 u12 trainings", rows("u12_0729", "u12_0805", "u12_0812", order=True),
    ref=[ans(kind="event", name="U12 hurling training", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("how many are left altogether", val(5),
    ref=[ans(op="count", kind="event", name="U12 hurling training", when=W({"from": U("day", 0)}))]))

S("T11-B004", "c4b state-change complete complete create contrast",
  T("paid the esb bill", diff(upd("esb_07", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="ESB bill")]),
  T("troughs are checked", diff(upd("troughs", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="water troughs")]),
  T("add a task: ring joe about the herd insurance", diff(new("task", name=has("Joe"))),
    ref=[act("create", args=lines(kind="task", name="Ring Joe about the herd insurance"))]))

S("T11-B006", "c4b state-change settle_debt log nickname",
  T("tadhg paid me the jersey deposit", diff(upd("d_tadhg", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Jersey deposit")]),
  T("just rang mam", diff(upd("mam", date=ANY)),
    ref=[search("mam", kind="person"), act("log", rows="$mam", args=lines(kind="call"))]))

S("T11-B007", "c4b state-change complete catch up create contrast",
  T("ordered the dairy nuts", diff(upd("nuts_08", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="dairy nuts")]),
  T("catch up with noreen tuesday at 4", diff(new("event", name=has("Noreen"), date="2026-07-28T16:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Noreen", date=U("week", 1, weekday=2, time="16:00")))]))
