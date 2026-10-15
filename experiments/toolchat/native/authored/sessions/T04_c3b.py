from gold import *
import json

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
S("T04-B001", "c3b superlative event next two food bank count",
  T("next two food bank shifts", rows("fb_1017", "fb_1024", order=True),
    ref=[ans(kind="event", name="Food bank shift", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("tally of the food bank shifts still to come?", val(6),
    ref=[ans(op="count", kind="event", name="Food bank shift", when=W({"from": U("day", 0)}))]))

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
