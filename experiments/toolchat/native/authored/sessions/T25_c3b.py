from gold import *
import json

world("T25", "2026-10-11T18:45", "Yuki Tanaka", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OWED = 'direction = "owes_me" and status = "open"'

S("T25-B002", "c3b superlative event next three piano count note latest",
  T("next 3 piano lessons", rows("piano_1014", "piano_1021", "piano_1028", order=True),
    ref=[ans(kind="event", name="Piano lesson", when=W({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("how many piano lessons do i have lined up from here on", val(6),
    ref=[ans(op="count", kind="event", name="Piano lesson", when=W({"from": U("day", 0)}))]),
  T("what's the latest note i wrote", rows("grocery_tg"),
    ref=[ans(kind="note", order="date desc", limit=1)]))

S("T25-B004", "c4b state-change complete complete create contrast",
  T("picked up mom's prescription", diff(upd("pharmacy", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="prescription")]),
  T("and the dry cleaning", diff(upd("dry_clean", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="dry cleaning")]),
  T("new task: ask matthieu about the dolly", diff(new("task", name=has("Matthieu"))),
    ref=[act("create", args=lines(kind="task", name="Ask Matthieu about the dolly"))]))

S("T25-B005", "c4b state-change cancel event restore trashed task",
  T("the airline cancelled mom's flight home", diff(upd("mom_flight", status="cancelled")),
    ref=[act("cancel", kind="event", name="flight")]),
  T("bring back the couch one", diff(restore("couch")),
    ref=[act("restore", kind="task", name="couch", trashed=True)]))

S("T25-B006", "c4b state-change settle_debt log nickname",
  T("nadia paid me for the gas to orford", diff(upd("d_nadia", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Gas Orford")]),
  T("texted zozo back", diff(upd("zoe", date=ANY)),
    ref=[search("zozo", kind="person"), act("log", rows="$zoe", args=lines(kind="message"))]))

S("T25-B007", "c4b state-change complete catch up create contrast",
  T("wrote the thank-you card to rachel", diff(upd("thank_you", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="thank-you card")]),
  T("catch up with elise thursday at 5", diff(new("event", name=has("Elise"), date="2026-10-15T17:00")),
    ref=[act("create", args=lines(kind="event", name="Catch up with Elise", date=U("week", 1, weekday=4, time="17:00")))]))
