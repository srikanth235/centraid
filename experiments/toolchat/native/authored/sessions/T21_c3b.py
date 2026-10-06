from gold import *
import json

world("T21", "2026-06-06T09:00", "Grace Mwangi", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T21-B001", "c3b superlative event next three briefings count",
  T("next 3 staff briefings", rows("brief_0608", "brief_0615", "brief_0622", order=True),
    ref=[ans(kind="event", name="Staff briefing", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("how many are left all together", val(8),
    ref=[ans(op="count", kind="event", name="Staff briefing", when=W({"from": U("day", 0)}))]))

S("T21-B003", "c3b superlative task biggest count newest document",
  T("bigest open job", rows("thesis"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]),
  T("and the number of open tasks overall", val(33),
    ref=[ans(op="count", kind="task", where=OPEN)]),
  T("what's my newest document", rows("insurance_doc"),
    ref=[ans(kind="document", order="date desc", limit=1)]))

S("T21-B004", "c4b state-change complete complete create contrast",
  T("sent the chama contribution", diff(upd("contrib", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="chama contribution")]),
  T("refilled the bp pills", diff(upd("bp_pills", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="blood pressure pills")]),
  T("add a task: buy airtime for tabby", diff(new("task", name=has("airtime"))),
    ref=[act("create", args=lines(kind="task", name="Buy airtime for Tabby"))]))

S("T21-B005", "c4b state-change cancel event restore trashed task",
  T("the county meeting was cancelled", diff(upd("county_meet", status="cancelled")),
    ref=[act("cancel", kind="event", name="County education meeting")]),
  T("get the curtains one back", diff(restore("curtains")),
    ref=[act("restore", kind="task", name="curtains", trashed=True)]))

S("T21-B006", "c4b state-change settle_debt log nickname",
  T("alice paid me for the tent hire", diff(upd("d_alice", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Tent hire")]),
  T("called shiru back", diff(upd("wanjiru", date=ANY)),
    ref=[search("shiru", kind="person"), act("log", rows="$wanjiru", args=lines(kind="call"))]))

S("T21-B007", "c4b state-change complete catch up create contrast",
  T("typed up the chama minutes", diff(upd("minutes", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="chama minutes")]),
  T("catch up with rose tuesday at 5", diff(new("event", name=has("Rose"), date="2026-06-09T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Rose", date=U("week", 1, weekday=2, time="17:00")))]))
