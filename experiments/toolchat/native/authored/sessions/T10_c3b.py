from gold import *
import json

world("T10", "2026-06-19T14:20", "Bashir Haddad", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T10-B001", "c3b superlative event next three chess nights count photo newest",
  T("when are the next three chess nights", rows("chess_0623", "chess_0630", "chess_0707", order=True),
    ref=[ans(kind="event", name="Chess club night", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("chess club nights still ahead of us, what is the number", val(6),
    ref=[ans(op="count", kind="event", name="Chess club night", when=W({"from": U("day", 0)}))]),
  T("what's my newest photo", rows("olive_p"),
    ref=[ans(kind="photo", order="date desc", limit=1)]))

S("T10-B003", "c3b superlative debt biggest sum owed biggest",
  T("which one do i owe the most", rows("d_nabil"),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=1)]),
  T("and all up, what am i on the hook for", val((160, "JOD")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("who owes me the most", rows("d_jamal"),
    ref=[ans(kind="debt", where=OWED, order="amount desc", limit=1)]))

S("T10-B004", "c4b state-change complete complete create contrast",
  T("paid adel for the dish", diff(upd("sat_task", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Adel dish")]),
  T("gas cylinder is ordered", diff(upd("gas", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="gas cylinder")]),
  T("new task: tell abu ahmad about the airport run", diff(new("task", name=has("airport"))),
    ref=[act("create", args=lines(kind="task", name="Tell Abu Ahmad about the airport run"))]))

S("T10-B005", "c4b state-change cancel event restore trashed task",
  T("the dentist rang, he's cancelled on me", diff(upd("dentist", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dentist appointment")]),
  T("need the balcony door one back", diff(restore("balcony")),
    ref=[act("restore", kind="task", name="balcony door", trashed=True)]))

S("T10-B006", "c4b state-change settle_debt log nickname",
  T("walid paid me for the chess book", diff(upd("d_walid", status="settled")),
    ref=[act("settle_debt", kind="debt", name="chess book")]),
  T("called umm tareq back", diff(upd("huda", date=ANY)),
    ref=[search("umm tareq", kind="person"), act("log", rows="$huda", args=lines(kind="call"))]))

S("T10-B007", "c4b state-change complete catch up create contrast",
  T("done with the lecture questions", diff(upd("lecture_q", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="questions lecture")]),
  T("catch up with nabil sunday at 4", diff(new("event", name=has("Nabil"), date="2026-06-21T16:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Nabil", date=U("week", 0, weekday=7, time="16:00")))]))
