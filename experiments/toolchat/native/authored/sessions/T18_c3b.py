from gold import *
import json

world("T18", "2026-03-01T11:20", "Jordan Ellis", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'

S("T18-B001", "c3b superlative task biggest open count",
  T("biggest open job", rows("trailer"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]),
  T("total open tasks right now", val(37),
    ref=[ans(op="count", kind="task", where=OPEN)]))

S("T18-B002", "c3b superlative event next three dnd count photo newest",
  T("next three d&d sessions", rows("dnd_0305", "dnd_0312", "dnd_0319", order=True),
    ref=[ans(kind="event", name="D&D session", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("how many are left", val(5),
    ref=[ans(op="count", kind="event", name="D&D session", when=W({"from": U("day", 0)}))]),
  T("what's my newest photo", rows("b_creek"),
    ref=[ans(kind="photo", order="date desc", limit=1)]))

S("T18-B003", "c3b superlative debt top 2 sum oldest document",
  T("top 2 things i owe", rows("d_alex", "d_nadia", order=True),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=2)]),
  T("and how much do i owe in total", val((265, "AUD")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("oldest document i've got", rows("microchip"),
    ref=[ans(kind="document", order="date asc", limit=1)]))

S("T18-B004", "c4b state-change complete complete create contrast",
  T("gave biscuit his flea treatment", diff(upd("flea", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="flea treatment")]),
  T("sorted the balloon arch", diff(upd("balloons", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="balloon arch")]),
  T("add a task: ring the cake lady about the topper", diff(new("task", name=has("topper"))),
    ref=[act("create", args=lines(kind="task", name="Ring the cake lady about the topper"))]))

S("T18-B005", "c4b state-change cancel event restore trashed task",
  T("crumb and co rang, the cake tasting is cancelled", diff(upd("cake_tasting", status="cancelled")),
    ref=[act("cancel", kind="event", name="Cake tasting")]),
  T("undelete the library books one", diff(restore("library")),
    ref=[act("restore", kind="task", name="library books", trashed=True)]))

S("T18-B006", "c4b state-change settle_debt log",
  T("ollie finally paid me for the microphone", diff(upd("d_ollie", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Microphone")]),
  T("texted dad back", diff(upd("dad", date=ANY)),
    ref=[search("dad", kind="person"), act("log", rows="$dad", args=lines(kind="message"))]))

S("T18-B007", "c4b state-change complete catch up create contrast",
  T("sent the shower invites", diff(upd("invites", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="shower invites")]),
  T("catch up with brooke wednesday at 5", diff(new("event", name=has("Brooke"), date="2026-03-04T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Brooke", date=U("week", 1, weekday=3, time="17:00")))]))
