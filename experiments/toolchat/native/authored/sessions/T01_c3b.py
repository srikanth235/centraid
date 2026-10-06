from gold import *
import json

world("T01", "2026-03-12T18:20", "Oluwaseun Adebayo-Clarke", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T01-B001", "c3b superlative event soonest night shift count",
  T("my next 3 night shifts", rows("night_0319", "night_0320", "night_0416", order=True),
    ref=[ans(kind="event", name="Night shift", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("how many nights have i got left in all", val(4),
    ref=[ans(op="count", kind="event", name="Night shift", when=W({"from": U("day", 0)}))]))

S("T01-B002", "c3b superlative debt biggest sum smallest",
  T("what's the biggest thing i owe", rows("d_mum_uniform"),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=1)]),
  T("and what do i owe all in", val((86.5, "GBP")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("who owes me the least", rows("d_priya_lunch"),
    ref=[ans(kind="debt", where=OWED, order="amount asc", limit=1)]))

S("T01-B003", "c3b superlative task overdue oldest effort count",
  T("what's been overdue the longest", rows("eye_test"),
    ref=[ans(kind="task", where=OPEN, order="date asc", limit=1)]),
  T("how many are overdue", val(2),
    ref=[ans(op="count", kind="task", where=OPEN, when=W({"to": U("day", -1)}))]),
  T("which open task takes the most time", rows("cupboards"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]))

S("T01-B004", "c4b state-change complete cancel-as-task create contrast",
  T("cancelled now tv", diff(upd("nowtv", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Now TV")]),
  T("and the skip's booked", diff(upd("skip", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="skip")]),
  T("new task: ring the council about the skip permit", diff(new("task", name=has("council"))),
    ref=[act("create", args=lines(kind="task", name="Ring the council about the skip permit"))]))

S("T01-B005", "c4b state-change cancel event restore",
  T("neil cancelled the plumber visit", diff(upd("plumber_visit", status="cancelled")),
    ref=[act("cancel", kind="event", name="Plumber quote visit")]),
  T("get the bike one back, i need it", diff(restore("bike_fix")),
    ref=[act("restore", kind="task", name="bike", trashed=True)]))

S("T01-B006", "c4b state-change settle_debt log nickname",
  T("callum finally coughed up his half of the skip", diff(upd("d_callum", status="settled")),
    ref=[act("settle_debt", kind="debt", name="skip")]),
  T("called mum back", diff(upd("mum", date=ANY)),
    ref=[search("mum", kind="person"), act("log", rows="$mum", args=lines(kind="call"))]))

S("T01-B007", "c4b state-change complete catch up create contrast",
  T("replied to chi about the dress", diff(upd("reply_chi", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Reply Chi")]),
  T("catch up with chioma saturday at 4", diff(new("event", name=has("Chioma"), date="2026-03-14T16:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Chioma", date=U("week", 0, weekday=6, time="16:00")))]))
