from gold import *
import json

world("T21", "2026-06-06T09:00", "Grace Mwangi", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


LEFT = 'status = "open"'

S("T21-201", "both reschedule tasks same day both star peters",
  T("what's due on the fourteenth", rows("seedlings", "cards"),
    ref=[ans(kind="task", when=W(D("2026-06-14")))]),
  T("bring both forward to monday", diff(upd("seedlings", date="2026-06-08"), upd("cards", date="2026-06-08")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]),
  T("who's peter", rows("peter_k", "peter_o"),
    ref=[ans(kind="person", name="Peter")]),
  T("star both", diff(upd("peter_k", starred=True), upd("peter_o", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T21-202", "ordinal first relist last school list complete reschedule date",
  T("what's open on the school list",
    rows("tsc", "term_report", "obs_g4", "arrears", "ribbons", "gutter", "feeding"),
    ref=[ans(kind="task", linked_to="$school_l", where=LEFT)]),
  T("the first one's done, submitted it yesterday", diff(upd("tsc", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tsc")]),
  T("what's left there now",
    rows("term_report", "obs_g4", "arrears", "ribbons", "gutter", "feeding"),
    ref=[ans(kind="task", linked_to="$school_l", where=LEFT)]),
  T("the last one is due on the twenty-sixth", diff(upd("feeding", date="2026-06-26")),
    ref=[act("reschedule", rows="$feeding", args=lines(to=D("2026-06-26")))]))

S("T21-204", "except reschedule church list relist then complete last",
  T("what's left on the church list", rows("robes", "cards", "pledges"),
    ref=[ans(kind="task", linked_to="$church_l", where=LEFT)]),
  T("push them all a week except the pledges, the harambee's been moved",
    diff(upd("robes", date="2026-06-18"), upd("cards", date="2026-06-21")),
    ref=[find(within="@prev", exclude="$pledges"),
         act("reschedule", rows="@prev", args=lines(to=U("day", 7, anchor="row")))]),
  T("what's left there now", rows("robes", "cards", "pledges"),
    ref=[ans(kind="task", linked_to="$church_l", where=LEFT)]),
  T("the last one's done, all the pledges are in", diff(upd("pledges", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pledges")]))

S("T21-205", "bare weekday at n reschedule create today counts relative range",
  T("wycliffe can do monday, move the plot survey", diff(upd("survey", date="2026-06-08T15:00")),
    ref=[act("reschedule", kind="event", name="Plot survey with Wycliffe", args=lines(to=U("week", 1, weekday=1)))]),
  T("move the esther call to tuesday at 5", diff(upd("call_esther", date="2026-06-09T17:00")),
    ref=[act("reschedule", kind="task", name="Call Esther about Shiru's visit", args=lines(to=U("week", 1, weekday=2, time="17:00")))]),
  T("supper with kevin saturday at 6", diff(new("event", name=has("Kevin"), date="2026-06-06T18:00")),
    ref=[act("create", args=lines(kind="event", name="Supper with Kevin", date=U("week", 0, weekday=6, time="18:00")))]),
  T("any events from monday to wednesday coming up next week",
    rows("brief_0608", "survey", "harambee_plan", "clinic_june", "bom_june"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]))
