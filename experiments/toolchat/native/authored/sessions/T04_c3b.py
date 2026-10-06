from gold import *
import json

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T04-B001", "c3b superlative event next two food bank count",
  T("next two food bank shifts", rows("fb_1017", "fb_1024", order=True),
    ref=[ans(kind="event", name="Food bank shift", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("tally of the food bank shifts still to come?", val(6),
    ref=[ans(op="count", kind="event", name="Food bank shift", when=W({"from": U("day", 0)}))]))

S("T04-B002", "c3b superlative debt biggest sum smallest",
  T("biggest amount anyone owes me", rows("d_sana"),
    ref=[ans(kind="debt", where=OWED, order="amount desc", limit=1)]),
  T("and what's the total they owe me", val((306.3, "GBP")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("and the least", rows("d_aoife"),
    ref=[ans(kind="debt", where=OWED, order="amount asc", limit=1)]))

S("T04-B003", "c3b superlative task effort latest due count",
  T("biggest open job?", rows("als_prep"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]),
  T("which open task is due last", rows("gmc_fee"),
    ref=[ans(kind="task", where=OPEN, order="date desc", limit=1)]),
  T("open tasks in total?", val(32),
    ref=[ans(op="count", kind="task", where=OPEN)]))

S("T04-B005", "c4b state-change cancel event restore trashed event",
  T("the cake tasting is off, they rang this morning", diff(upd("cake", status="cancelled")),
    ref=[act("cancel", kind="event", name="Cake tasting")]),
  T("undelete the gym induction", diff(restore("gym")),
    ref=[act("restore", kind="event", name="Gym induction", trashed=True)]))

S("T04-B006", "c4b state-change settle_debt log nickname",
  T("chloe paid me back for the takeaway", diff(upd("d_chloe", status="settled")),
    ref=[act("settle_debt", kind="debt", name="takeaway")]),
  T("texted ammi back", diff(upd("mum", date=ANY)),
    ref=[search("ammi", kind="person"), act("log", rows="$mum", args=lines(kind="message"))]))
