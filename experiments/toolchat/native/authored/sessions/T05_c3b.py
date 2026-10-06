from gold import *
import json

world("T05", "2026-01-20T06:40", "Priya Raman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'

S("T05-B001", "c3b superlative event next three night shifts count",
  T("next 3 night shifts", rows("night_0123", "night_0124", "night_0127", order=True),
    ref=[ans(kind="event", name="ICU night shift", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("how many nights do i have left", val(6),
    ref=[ans(op="count", kind="event", name="ICU night shift", when=W({"from": U("day", 0)}))]))

S("T05-B002", "c3b superlative task due last count photo newest",
  T("which open task is due last", rows("passport"),
    ref=[ans(kind="task", where=OPEN, order="date desc", limit=1)]),
  T("and all open tasks together?", val(32),
    ref=[ans(op="count", kind="task", where=OPEN)]),
  T("newest photo on my phone", rows("farhan_pic"),
    ref=[ans(kind="photo", order="date desc", limit=1)]))

S("T05-B003", "c3b superlative debt biggest sum smallest",
  T("which debt is the biggest one i owe", rows("d_appa"),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=1)]),
  T("and how much do i owe all in", val((18570, "INR")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("the smalest of them", rows("d_jaya"),
    ref=[ans(kind="debt", where=IOWE, order="amount asc", limit=1)]))

S("T05-B004", "c4b state-change complete complete create contrast",
  T("eye drops are bought", diff(upd("eye_drops", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="eye drops")]),
  T("gas cylinder is booked", diff(upd("gas", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="gas cylinder")]),
  T("remind me to buy sugar for the pongal friday", diff(new("task", name=has("sugar"), date="2026-01-23")),
    ref=[act("create", args=lines(kind="task", name="Buy sugar for the pongal", date=U("week", 0, weekday=5)))]))

S("T05-B006", "c4b state-change settle_debt log nickname",
  T("karthik sent me the visa money back", diff(upd("d_karthik", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Visa fee")]),
  T("popped round to paati's", diff(upd("paati", date=ANY)),
    ref=[search("paati", kind="person"), act("log", rows="$paati", args=lines(kind="visit"))]))

S("T05-B007", "c4b state-change complete catch up create contrast",
  T("gave revathi the receipts", diff(upd("receipts", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="receipts")]),
  T("catch up with kavya friday at 6", diff(new("event", name=has("Kavya"), date="2026-01-23T18:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Kavya", date=U("week", 0, weekday=5, time="18:00")))]))
