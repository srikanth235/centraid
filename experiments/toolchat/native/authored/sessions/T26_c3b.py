from gold import *
import json

world("T26", "2026-11-24T05:30", "Ahmed Bello", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T26-B002", "c3b superlative event next two site visits count photo newest",
  T("next 2 site visits", rows("site_1128", "site_1205", order=True),
    ref=[ans(kind="event", name="Site visit", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("site visits coming up, give me the total number", val(2),
    ref=[ans(op="count", kind="event", name="Site visit", when=W({"from": U("day", 0)}))]),
  T("what's my newest photo", rows("p_meter"),
    ref=[ans(kind="photo", order="date desc", limit=1)]))

S("T26-B003", "c3b superlative debt owed most sum i owe most",
  T("who owes me the most", rows("d_bayo"),
    ref=[ans(kind="debt", where=OWED, order="amount desc", limit=1)]),
  T("and what's the total they owe me", val((415000, "NGN")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("and which of my debts is the biggest", rows("d_olumide"),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=1)]))

S("T26-B004", "c4b state-change complete complete create contrast",
  T("fixed kemi's phone screen", diff(upd("phone", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Kemi's phone screen")]),
  T("paid the electricity bill", diff(upd("power_11", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="electricity bill")]),
  T("add a task: call sunday about the brake pads", diff(new("task", name=has("Sunday"))),
    ref=[act("create", args=lines(kind="task", name="Call Sunday about the brake pads"))]))

S("T26-B005", "c4b state-change cancel event restore trashed task",
  T("the dentist cancelled kemi's appointment", diff(upd("dentist_kemi", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dentist Kemi")]),
  T("get the old generator one back", diff(restore("old_gen")),
    ref=[act("restore", kind="task", name="old generator", trashed=True)]))

S("T26-B006", "c4b state-change settle_debt log nickname",
  T("chidi paid me for the suya and drinks", diff(upd("d_chidi", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Suya drinks")]),
  T("rang mama just now", diff(upd("mama", date=ANY)),
    ref=[search("mama", kind="person"), act("log", rows="$mama", args=lines(kind="call"))]))

S("T26-B007", "c4b state-change complete catch up create contrast",
  T("ordered the roofing sheets", diff(upd("roofing", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="roofing sheets")]),
  T("catch up with segun friday at 5", diff(new("event", name=has("Segun"), date="2026-11-27T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Segun", date=U("week", 0, weekday=5, time="17:00")))]))
