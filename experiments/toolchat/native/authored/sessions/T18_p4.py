from gold import *
import json

world("T18", "2026-03-01T11:20", "Jordan Ellis", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T18-201", "both cancel events both star sams",
  T("whats on saturday", rows("dogclass_0307", "market"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=6)))]),
  T("cancel both, tess needs me", diff(upd("dogclass_0307", status="cancelled"), upd("market", status="cancelled")),
    ref=[act("cancel", rows="@prev")]),
  T("who's sam again", rows("sam_o", "sam_t"),
    ref=[ans(kind="person", name="Sam")]),
  T("star both", diff(upd("sam_o", starred=True), upd("sam_t", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T18-202", "ordinal third last shower list complete reschedule then second",
  T("what's left on the shower list",
    rows("invites", "balloons", "rsvps", "baby_gift", "chairs", "print_games", "playlist"),
    ref=[ans(kind="task", linked_to="$shower_l", where='status = "open"')]),
  T("tick the third one and the last one can wait till next friday",
    diff(upd("rsvps", status="completed", completed=ANY), upd("playlist", date="2026-03-06")),
    ref=[act("complete", rows="$rsvps", more=True),
         act("reschedule", rows="$playlist", args=lines(to=U("week", 1, weekday=5)))]),
  T("what's left on it now", rows("invites", "balloons", "baby_gift", "chairs", "print_games", "playlist"),
    ref=[ans(kind="task", linked_to="$shower_l", where='status = "open"')]),
  T("the second one's done too", diff(upd("balloons", status="completed", completed=ANY)),
    ref=[act("complete", rows="$balloons")]))

S("T18-203", "owe direction balance both signs settle mine sum",
  T("what does marcus owe me", val((54, "AUD")),
    ref=[ans(op="balance", rows="$marcus")]),
  T("and my side with nadia", val((-60, "AUD")),
    ref=[ans(op="balance", rows="$nadia")]),
  T("settle mine, gave her the cash", diff(upd("d_nadia", status="settled")),
    ref=[act("settle_debt", kind="debt", where=IOWE, linked_to="$nadia")]),
  T("how much do i still owe overall", val((205, "AUD")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]))

S("T18-204", "except cancel sprint reviews rest still on",
  T("sprint reviews this month", rows("sprint_0306", "sprint_0313", "sprint_0320", "sprint_0327"),
    ref=[ans(kind="event", name="Co-op sprint review", when=W(U("month", 0)))]),
  T("cancel them all except the first one, i'm away from the tenth",
    diff(upd("sprint_0313", status="cancelled"), upd("sprint_0320", status="cancelled"),
         upd("sprint_0327", status="cancelled")),
    ref=[find(within="@prev", exclude="$sprint_0306"), act("cancel", rows="@prev")]),
  T("which are still on", rows("sprint_0306"),
    ref=[ans(kind="event", name="Co-op sprint review", when=W(U("month", 0)), where='status != "cancelled"')]))

S("T18-205", "bare weekday at n reschedule create relative range",
  T("kieran can do monday, move the tax meeting", diff(upd("tax_meet", date="2026-03-02T14:00")),
    ref=[act("reschedule", kind="event", name="Tax meeting with Kieran", args=lines(to=U("week", 1, weekday=1)))]),
  T("dinner with mei saturday at 7", diff(new("event", name=has("Mei"), date="2026-03-07T19:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Mei", date=U("week", 1, weekday=6, time="19:00")))]),
  T("push the nana call to 5", diff(upd("call_nana", date="2026-03-01T17:00")),
    ref=[act("reschedule", kind="task", name="Call Nana", args=lines(to=D("2026-03-01", "17:00")))]),
  T("what was on monday to wednesday this week", rows("climb_feb", "zoe_dinner"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]))
