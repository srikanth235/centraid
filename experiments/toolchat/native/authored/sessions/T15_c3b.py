from gold import *
import json

world("T15", "2026-11-09T10:15", "Ingrid Solberg", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T15-B002", "c3b superlative event next two plankton count longest next week",
  T("next 2 plankton group meetings", rows("labmtg_1113", "labmtg_1120", order=True),
    ref=[ans(kind="event", name="Plankton group meeting", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("count the plankton group meetings still to come", val(3),
    ref=[ans(op="count", kind="event", name="Plankton group meeting", when=W({"from": U("day", 0)}))]),
  T("longest thing on next week", rows("survival"),
    ref=[ans(kind="event", when=W(U("week", 1)), order="duration desc", limit=1)]))

S("T15-B003", "c3b superlative debt owed most sum smallest",
  T("biggest debt owed to me", rows("d_anders"),
    ref=[ans(kind="debt", where=OWED, order="amount desc", limit=1)]),
  T("and what's the total people owe me", val((2505, "NOK")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("and the smallest one", rows("d_linnea"),
    ref=[ans(kind="debt", where=OWED, order="amount asc", limit=1)]))

S("T15-B004", "c4b state-change complete complete find then create contrast",
  T("what's due tomorrow", rows("kiel_reply", "cat_food", "slides"),
    ref=[ans(kind="task", when=W(U("day", 1)))]),
  T("bought the cat food", diff(upd("cat_food", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="cat food")]),
  T("and replied to jan", diff(upd("kiel_reply", status="completed", completed=ANY)),
    ref=[act("complete", rows="$kiel_reply")]),
  T("new task: send jan the signed dsa copy", diff(new("task", name=has("Jan"))),
    ref=[act("create", args=lines(kind="task", name="Send Jan the signed DSA copy"))]))

S("T15-B005", "c4b state-change cancel event restore trashed task",
  T("ane rang, the vet check is cancelled", diff(upd("vet_1112", status="cancelled")),
    ref=[act("cancel", kind="event", name="Vet check")]),
  T("get the snow chains one back", diff(restore("chains")),
    ref=[act("restore", kind="task", name="snow chains", trashed=True)]))

S("T15-B006", "c4b state-change settle_debt log nickname",
  T("silje paid me for the sauna tickets", diff(upd("d_silje", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Sauna tickets")]),
  T("rang mamma just now", diff(upd("mum", date=ANY)),
    ref=[search("mamma", kind="person"), act("log", rows="$mum", args=lines(kind="call"))]))

S("T15-B007", "c4b state-change complete catch up create contrast",
  T("gave hallvard his book back", diff(upd("halle_book", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Hallvard book")]),
  T("catch up with marianne thursday at 5", diff(new("event", name=has("Marianne"), date="2026-11-12T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Marianne", date=U("week", 0, weekday=4, time="17:00")))]))
