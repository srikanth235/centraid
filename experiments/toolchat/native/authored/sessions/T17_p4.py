from gold import *
import json

world("T17", "2026-01-30T13:35", "Elena Petrova", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


OWE = 'direction = "i_owe" and status = "open"'

S("T17-201", "both dentists reschedule prev read",
  T("when are the dentist appointments", rows("dentist_v", "dentist_me"),
    ref=[find(kind="event", name="dentist", when=W({"from": U("day", 0)})), ans(rows="@prev")]),
  T("push both back a day", diff(upd("dentist_v", date="2026-02-05T15:00"), upd("dentist_me", date="2026-02-11T09:00")),
    ref=[act("reschedule", rows="@1", args=lines(to=U("day", 1, anchor="row")))]),
  T("when's viktor's next basketball", rows("basket_feb"),
    ref=[ans(kind="event", name="Viktor's basketball game", when=W({"from": U("day", 0)}))]))

S("T17-202", "ordinal monday events reschedule cancel",
  T("what's on monday", rows("walkthrough", "ivan_0202", "vesi_reh", order=True),
    ref=[find(kind="event", when=W(U("week", 1, weekday=1)), order="date asc"), ans(rows="@prev")]),
  T("move the second one to 4", diff(upd("ivan_0202", date="2026-02-02T16:00")),
    ref=[act("reschedule", rows="$ivan_0202", args=lines(to=U("day", 0, anchor="row", time="16:00")))]),
  T("cancel the last one, vesi's ill", diff(upd("vesi_reh", status="cancelled")),
    ref=[act("cancel", kind="event", within="@2", order="date desc", limit=1)]))

S("T17-203", "owe direction nickname balance settle sum mine",
  T("do i owe mitko", val((-1500, "BGN")),
    ref=[search("Mitko", kind="person"), ans(op="balance", rows="$mitko")]),
  T("and what does maria koleva owe me", val((100, "BGN")),
    ref=[ans(op="balance", kind="person", name="Maria Koleva")]),
  T("settle mine with plamen, paid him cash", diff(upd("d_plamen", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$plamen")]),
  T("what's my side now, all i owe", val((2325, "BGN")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWE)]))

S("T17-204", "except wednesday events cancel rest read",
  T("what's on wednesday", rows("dentist_v", "maria_0204", "sectional", order=True),
    ref=[find(kind="event", when=W(U("week", 1, weekday=3)), order="date asc"), ans(rows="@prev")]),
  T("cancel everything except the dentist, i'm wiped", diff(upd("maria_0204", status="cancelled"), upd("sectional", status="cancelled")),
    ref=[act("cancel", rows="$maria_0204, $sectional")]),
  T("still on that day?", rows("dentist_v"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=3)), where='status != "cancelled"')]))

S("T17-205", "bare weekday at n range create",
  T("coffee with mila to sunday at 4", diff(upd("coffee_mila", date="2026-02-01T16:00")),
    ref=[act("reschedule", kind="event", name="Coffee with Mila", args=lines(to=U("week", 0, weekday=7, time="16:00")))]),
  T("what did i have monday to wednesday this week", rows("tiling_start", "ivan_0126", "choir_0127", "maria_0128"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("tuner can do friday at 4 instead", diff(upd("tuner", date="2026-01-30T16:00")),
    ref=[act("reschedule", kind="event", name="Piano tuner", args=lines(to=U("week", 0, weekday=5, time="16:00")))]),
  T("call mama sunday at 5", diff(new("event", name=has("Mama"), date="2026-02-01T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Mama", date=U("week", 0, weekday=7, time="17:00")))]))

S("T17-206", "two writes settle complete then complete reschedule",
  T("paid plamen the survey money and bought the metronome batteries",
    diff(upd("d_plamen", status="settled"), upd("batteries", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", linked_to="$plamen", more=True), act("complete", rows="$batteries")]),
  T("invoiced february, and the choir fees can wait till monday",
    diff(upd("invoice_feb", status="completed", completed=ANY), upd("choir_fees", date="2026-02-02")),
    ref=[act("complete", kind="task", name="Invoice February", more=True), act("reschedule", rows="$choir_fees", args=lines(to=U("week", 1, weekday=1)))]))
