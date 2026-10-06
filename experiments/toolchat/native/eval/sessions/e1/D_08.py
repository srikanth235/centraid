from gold import *
import json

world("D", "2026-12-20T19:40", "Marisol Reyes-Kapoor", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("D-E122", "ambiguous-person ask seven star compute",
  T("star grace, she's the one i keep needing to text", ask("pp2", "pp7", "pp27", "pp63", "pp117", "pp128", "pp156"),
    ref=[act("star", kind="person", name="grace"),
         askc("Which Grace? I have seven.", options="$pp2, $pp7, $pp27, $pp63, $pp117, $pp128, $pp156")]),
  T("the babysitter", diff(upd("pp7", starred=True)),
    ref=[act("star", rows="$pp7")]),
  T("and the neighbor one, costa", diff(upd("pp27", starred=True)),
    ref=[act("star", rows="$pp27")]),
  T("how many graces do i have", val(7),
    ref=[comp(op="count", kind="person", name="grace"), ans(value="@prev")]))

S("D-E123", "ambiguous-task ask three-open pick",
  T("tick off pick up prescription, grabbed it on the way home", ask("tk85", "tk449", "tk750"),
    ref=[act("complete", kind="task", name="pick up prescription"),
         find(kind="task", name="pick up prescription", where="status = open"),
         askc("Three are open, which one?", options="@1")]),
  T("the one from yesterday", diff(upd("tk750", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tk750")]),
  T("and the other two are old, clear those out too", diff(trash("tk85"), trash("tk449")),
    ref=[act("delete", rows="$tk85, $tk449")]),
  T("undo", diff(restore("tk85"), restore("tk449")),
    ref=[act("undo")]))

S("D-E124", "ambiguous-document ask delete undo read",
  T("delete the report card", ask("dc17", "dc18", "dc19"),
    ref=[act("delete", kind="document", name="report card"),
         askc("Which year: 2024, 2025 or 2026?", options="$dc17, $dc18, $dc19")]),
  T("2024", diff(trash("dc17")),
    ref=[act("delete", rows="$dc17")]),
  T("actually undo that", diff(restore("dc17")),
    ref=[act("undo")]),
  T("what's in the kids folder", rows("dc17", "dc18", "dc19", "dc20", "dc21", "dc22", "passport_lucia", "passport_arun"),
    ref=[find(kind="folder", name="kids"), ans(kind="document", linked_to="$kids_f")]))

S("D-E125", "ask-open babysitter then log unstar",
  T("log a call with the babysitter", ask(),
    ref=[askc("Which babysitter?")]),
  T("rosa", rows("nanny", also=diff(upd("nanny", date=ANY))),
    ref=[act("log", rows="$nanny", args="kind: call", more=True), ans(rows="$nanny")]),
  T("when did i last call her before that", rows("nanny"),
    ref=[ans(rows="$nanny")]),
  T("unstar rosa, she's only here sometimes now", diff(upd("nanny", starred=False)),
    ref=[act("unstar", kind="person", name="rosa")]))

S("D-E126", "ask-open appointment then reschedule",
  T("move my appointment to friday", ask(),
    ref=[askc("Which appointment?")]),
  T("the kids dentist, friday at 9, they have a cancellation", diff(upd("dentist_kids", date="2026-12-25T09:00")),
    ref=[act("reschedule", kind="event", name="kids dentist", args=lines(to=U("week", 1, weekday=5, time="09:00")))]),
  T("who's going to that", rows("lucia", "arun", "dentist_d"),
    ref=[ans(kind="person", linked_to="$dentist_kids")]),
  T("and is dr shah around that day", rows(),
    ref=[search("Shah", kind="person"), ans(kind="event", linked_to="$dr_shah", when=W(U("week", 1, weekday=5)))]))

S("D-E127", "no-upcoming ask-open create",
  T("move my haircut to saturday", ask(),
    ref=[act("reschedule", kind="event", name="haircut", args=lines(to=U("week", 1, weekday=6))),
         find(kind="event", name="haircut", when=W({"from": U("day", 0)})),
         askc("There's no haircut coming up, want me to book one for saturday?")]),
  T("yeah saturday at 11", diff(new("event", name="Haircut", date="2026-12-26T11:00")),
    ref=[act("create", args=lines(kind="event", name="Haircut", date=U("week", 1, weekday=6, time="11:00")))]),
  T("when was the last one", rows("ev38"),
    ref=[ans(kind="event", name="haircut", when=W({"to": U("day", 0)}), order="date desc", limit=1)]))

S("D-E128", "no-upcoming cancel ask never-mind",
  T("call off the swim lesson, the pool is closed for the holidays", ask(),
    ref=[act("cancel", kind="event", name="swim lesson"),
         find(kind="event", name="swim lesson", when=W({"from": U("day", 0)})),
         askc("No swim lesson is coming up, which one do you mean?")]),
  T("forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("when's the next one then", rows(),
    ref=[ans(kind="event", name="swim lesson", when=W({"from": U("day", 0)}))]),
  T("and the last one", rows("ev398"),
    ref=[ans(kind="event", name="swim lesson", when=W({"to": U("day", 0)}), order="date desc", limit=1)]))
