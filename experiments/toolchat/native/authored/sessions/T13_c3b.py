from gold import *
import json

world("T13", "2026-09-03T22:10", "Amara Nwosu", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T13-B002", "c3b superlative event next three lab group count task biggest",
  T("next 3 lab group meetings", rows("group_0907", "group_0914", "group_0928", order=True),
    ref=[ans(kind="event", name="Lab group meeting", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("ok so how many lab group meetings will there be from now on", val(7),
    ref=[ans(op="count", kind="event", name="Lab group meeting", when=W({"from": U("day", 0)}))]),
  T("and what's my biggest open job", rows("figures"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]))

S("T13-B003", "c3b superlative debt owed most sum smallest",
  T("which one owes me the most money", rows("d_chinedu"),
    ref=[ans(kind="debt", where=OWED, order="amount desc", limit=1)]),
  T("what's the total people owe me", val((203.5, "GBP")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("and the smallest one", rows("d_tom_b"),
    ref=[ans(kind="debt", where=OWED, order="amount asc", limit=1)]))

S("T13-B004", "c4b state-change complete complete create contrast",
  T("bought the toilet roll", diff(upd("loo_roll", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="toilet roll")]),
  T("reviewed fatima's abstract", diff(upd("abstract", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Fatima's abstract")]),
  T("new task: ask raj about the beam time", diff(new("task", name=has("Raj"))),
    ref=[act("create", args=lines(kind="task", name="Ask Raj about the beam time"))]))

S("T13-B005", "c4b state-change cancel event restore trashed task",
  T("gary rang, the landlord inspection is cancelled", diff(upd("landlord", status="cancelled")),
    ref=[act("cancel", kind="event", name="Landlord inspection")]),
  T("put the window latch one back", diff(restore("latch")),
    ref=[act("restore", kind="task", name="window latch", trashed=True)]))

S("T13-B006", "c4b state-change settle_debt log nickname",
  T("kasia finally paid me for the router", diff(upd("d_kasia", status="settled")),
    ref=[act("settle_debt", kind="debt", name="router")]),
  T("texted mummy back", diff(upd("mum", date=ANY)),
    ref=[search("mummy", kind="person"), act("log", rows="$mum", args=lines(kind="message"))]))

S("T13-B007", "c4b state-change complete catch up create contrast",
  T("sorted the broadband switch", diff(upd("broadband", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="broadband switch")]),
  T("catch up with fatima friday at 4", diff(new("event", name=has("Fatima"), date="2026-09-04T16:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Fatima", date=U("week", 0, weekday=5, time="16:00")))]))
