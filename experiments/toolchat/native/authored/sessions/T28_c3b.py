from gold import *
import json

world("T28", "2026-02-21T12:00", "Wiremu Tane", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T28-B001", "c3b superlative event next three kapa haka count longest",
  T("next 3 kapa haka practices", rows("kapa_0225", "kapa_0304", "kapa_0311", order=True),
    ref=[ans(kind="event", name="Kapa haka practice", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("how many are left altogether", val(5),
    ref=[ans(op="count", kind="event", name="Kapa haka practice", when=W({"from": U("day", 0)}))]),
  T("longest thing on this week", rows("hemi_visit"),
    ref=[ans(kind="event", when=W(U("week", 0)), order="duration desc", limit=1)]))

S("T28-B002", "c3b superlative task biggest count due last",
  T("biggest open job", rows("slideshow"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]),
  T("and how many tasks are still open", val(36),
    ref=[ans(op="count", kind="task", where=OPEN)]),
  T("which open one is due last", rows("will"),
    ref=[ans(kind="task", where=OPEN, order="date desc", limit=1)]))

S("T28-B003", "c3b superlative debt top 2 sum owed most",
  T("top 2 debts i owe", rows("d_hemi", "d_ngaire", order=True),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=2)]),
  T("and how much do i owe in total", val((690, "NZD")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("and who owes me the most", rows("d_rawiri"),
    ref=[ans(kind="debt", where=OWED, order="amount desc", limit=1)]))

S("T28-B004", "c4b state-change complete complete create contrast",
  T("mowed the lawns", diff(upd("lawns", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="lawns")]),
  T("bought the kūmara", diff(upd("kumara", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="kūmara")]),
  T("new task: ring tony about the ute", diff(new("task", name=has("Tony"))),
    ref=[act("create", args=lines(kind="task", name="Ring Tony about the ute"))]))

S("T28-B005", "c4b state-change cancel event restore trashed task",
  T("tony cancelled the car wof", diff(upd("wof", status="cancelled")),
    ref=[act("cancel", kind="event", name="Car WOF")]),
  T("undelete the garage one", diff(restore("garage")),
    ref=[act("restore", kind="task", name="garage", trashed=True)]))

S("T28-B006", "c4b state-change settle_debt log nickname",
  T("mere paid me back her share of the power", diff(upd("d_mere", status="settled")),
    ref=[act("settle_debt", kind="debt", name="power share")]),
  T("popped in to see nanny ria", diff(upd("ria", date=ANY)),
    ref=[search("nanny ria", kind="person"), act("log", rows="$ria", args=lines(kind="visit"))]))

S("T28-B007", "c4b state-change complete catch up create contrast",
  T("sorted the hāngī stones", diff(upd("stones", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="hāngī stones")]),
  T("catch up with pita monday at 3", diff(new("event", name=has("Pita"), date="2026-02-23T15:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Pita", date=U("week", 1, weekday=1, time="15:00")))]))
