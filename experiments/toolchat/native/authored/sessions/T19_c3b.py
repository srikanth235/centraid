from gold import *
import json

world("T19", "2026-04-14T20:40", "Fatima Al-Sayed", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T19-B001", "c3b superlative event next three swim lessons count",
  T("next 3 swimming lessons for adam", rows("swim_0415", "swim_0422", "swim_0429", order=True),
    ref=[ans(kind="event", name="swimming lesson", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("and adam still has how many swimming lessons booked", val(5),
    ref=[ans(op="count", kind="event", name="swimming lesson", when=W({"from": U("day", 0)}))]))

S("T19-B003", "c3b superlative debt top 3 sum owed most",
  T("top 3 things i owe", rows("d_youssef", "d_khalid", "d_samira", order=True),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=3)]),
  T("and how much do i owe all together", val((1800, "MAD")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("who owes me the most", rows("d_omar"),
    ref=[ans(kind="debt", where=OWED, order="amount desc", limit=1)]))

S("T19-B004", "c4b state-change complete complete create contrast",
  T("ordered the glucose strips", diff(upd("strips", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="glucose test strips")]),
  T("swapped the gas bottle", diff(upd("gas", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="gas bottle")]),
  T("new task: call abdelilah about the lease", diff(new("task", name=has("Abdelilah"))),
    ref=[act("create", args=lines(kind="task", name="Call Abdelilah about the lease"))]))

S("T19-B005", "c4b state-change cancel event restore trashed task",
  T("the parent teacher meeting got cancelled", diff(upd("ptm", status="cancelled")),
    ref=[act("cancel", kind="event", name="Parent-teacher meeting")]),
  T("put the balcony door one back", diff(restore("balcony")),
    ref=[act("restore", kind="task", name="balcony door", trashed=True)]))

S("T19-B006", "c4b state-change settle_debt log nickname",
  T("rachid paid me back for the phone credit", diff(upd("d_rachid", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Phone credit")]),
  T("went to see baba", diff(upd("baba", date=ANY)),
    ref=[search("baba", kind="person"), act("log", rows="$baba", args=lines(kind="visit"))]))

S("T19-B007", "c4b state-change complete catch up create contrast",
  T("bought adam's goggles", diff(upd("goggles", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="goggles")]),
  T("catch up with kenza wednesday at 5", diff(new("event", name=has("Kenza"), date="2026-04-15T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Kenza", date=U("week", 0, weekday=3, time="17:00")))]))
