from gold import *
import json

world("T16", "2026-12-16T18:00", "Rafiq Chowdhury", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T16-B001", "c3b superlative event next three nets count note latest",
  T("next 3 net practices", rows("nets_1218", "nets_1225", "nets_0101", order=True),
    ref=[ans(kind="event", name="Tigers net practice", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("and the number of net practices remaining?", val(7),
    ref=[ans(op="count", kind="event", name="Tigers net practice", when=W({"from": U("day", 0)}))]),
  T("what's the latest note i wrote", rows("rahim_feedback"),
    ref=[ans(kind="note", order="date desc", limit=1)]))

S("T16-B002", "c3b superlative task biggest count due last",
  T("which open job is the biggest", rows("audit_prep"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]),
  T("and how many are still open on my list", val(31),
    ref=[ans(op="count", kind="task", where=OPEN)]),
  T("which open one is due last", rows("passport"),
    ref=[ans(kind="task", where=OPEN, order="date desc", limit=1)]))

S("T16-B004", "c4b state-change complete complete create contrast",
  T("paid the dish line bill", diff(upd("tv_bill", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="dish line bill")]),
  T("bought the cricket balls", diff(upd("balls_1", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="cricket balls")]),
  T("add a task: ring nazmul about the overlock machine", diff(new("task", name=has("Nazmul"))),
    ref=[act("create", args=lines(kind="task", name="Ring Nazmul about the overlock machine"))]))

S("T16-B006", "c4b state-change settle_debt log nickname",
  T("shafiq paid me for the motorbike repair", diff(upd("d_shafiq", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Motorbike repair")]),
  T("popped round to monir's", diff(upd("monir", date=ANY)),
    ref=[search("monir", kind="person"), act("log", rows="$monir", args=lines(kind="visit"))]))

S("T16-B007", "c4b state-change complete catch up create contrast",
  T("ordered the rice sack", diff(upd("rice", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="rice sack")]),
  T("catch up with sohel friday at 5", diff(new("event", name=has("Sohel"), date="2026-12-18T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Sohel", date=U("week", 0, weekday=5, time="17:00")))]))
