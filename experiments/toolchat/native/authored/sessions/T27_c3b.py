from gold import *
import json

world("T27", "2026-12-03T04:50", "Sophie Dubois", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T27-B002", "c3b superlative event next three classes count task biggest",
  T("next 3 prenatal classes", rows("class_1208", "class_1215", "class_1222", order=True),
    ref=[ans(kind="event", name="Prenatal class", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("prenatal classes still to come: how many in all", val(8),
    ref=[ans(op="count", kind="event", name="Prenatal class", when=W({"from": U("day", 0)}))]),
  T("what's my biggest open job", rows("bake_night"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]))

S("T27-B004", "c4b state-change complete complete create contrast",
  T("bought the prenatal vitamins", diff(upd("vitamins", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="prenatal vitamins")]),
  T("took the glass out", diff(upd("glass", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="glass recycling")]),
  T("new task: ask sandrine about the vat", diff(new("task", name=has("Sandrine"))),
    ref=[act("create", args=lines(kind="task", name="Ask Sandrine about the VAT"))]))

S("T27-B005", "c4b state-change cancel event restore trashed task",
  T("the oven inspection is cancelled, olivier rang", diff(upd("oven_check", status="cancelled")),
    ref=[act("cancel", kind="event", name="Oven inspection")]),
  T("bring back the old stand mixer one", diff(restore("old_mixer")),
    ref=[act("restore", kind="task", name="stand mixer", trashed=True)]))

S("T27-B006", "c4b state-change settle_debt log nickname",
  T("chloé paid me for the concert tickets", diff(upd("d_chloe", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Concert tickets")]),
  T("called maman back", diff(upd("helene", date=ANY)),
    ref=[search("maman", kind="person"), act("log", rows="$helene", args=lines(kind="call"))]))

S("T27-B007", "c4b state-change complete catch up create contrast",
  T("ordered the flour", diff(upd("flour_b", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="flour")]),
  T("catch up with chloé saturday at 5", diff(new("event", name=has("Chlo"), date="2026-12-05T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Chloé", date=U("week", 0, weekday=6, time="17:00")))]))
