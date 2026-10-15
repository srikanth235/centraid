from gold import *
import json

world("T14", "2026-10-24T19:30", "Tomás Ferreira", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T14-B001", "c3b superlative event next two handovers count",
  T("my next two car pool handovers", rows("hand_1026", "hand_1102", order=True),
    ref=[ans(kind="event", name="Car pool handover", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("how many are left all together", val(6),
    ref=[ans(op="count", kind="event", name="Car pool handover", when=W({"from": U("day", 0)}))]))

S("T14-B004", "c4b state-change complete complete create contrast",
  T("paid juninho for the tyres", diff(upd("tyre_pay", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Juninho tyres")]),
  T("sent otavio his receipts", diff(upd("otavio_receipt", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="receipts")]),
  T("add a task: call jhonatan about the wash", diff(new("task", name=has("Jhonatan"))),
    ref=[act("create", args=lines(kind="task", name="Call Jhonatan about the wash"))]))

S("T14-B005", "c4b state-change cancel event restore trashed task",
  T("otavio cancelled the airport run", diff(upd("airport_otavio", status="cancelled")),
    ref=[act("cancel", kind="event", name="Airport run")]),
  T("bring back the gym signup one", diff(restore("gym")),
    ref=[act("restore", kind="task", name="gym", trashed=True)]))

S("T14-B007", "c4b state-change complete catch up create contrast",
  T("headphone cable's fixed", diff(upd("headphones", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="headphone cable")]),
  T("catch up with thiago sunday at 5", diff(new("event", name=has("Thiago"), date="2026-10-25T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Thiago", date=U("week", 0, weekday=7, time="17:00")))]))
