from gold import *
import json

world("T19", "2026-04-14T20:40", "Fatima Al-Sayed", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'

S("T19-201", "both reschedule dentists earlier both log call samiras",
  T("dentist appointments coming up", rows("dentist_adam", "dentist_me"),
    ref=[ans(kind="event", name="Dentist", when=W({"from": U("day", 0)}))]),
  T("push both an hour earlier, the clinic changed its hours",
    diff(upd("dentist_adam", date="2026-04-24T17:00"), upd("dentist_me", date="2026-05-07T17:30")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("hour", -1, anchor="row")))]),
  T("who's samira", rows("samira_b", "samira_a"),
    ref=[ans(kind="person", name="Samira")]),
  T("log a call with both", diff(upd("samira_b", date=ANY), upd("samira_a", date=ANY)),
    ref=[act("log", rows="@prev", args=lines(kind="call"))]))

S("T19-202", "ordinal second last baba list complete then reschedule",
  T("what's open on baba's list", rows("strips", "insulin", "reimburse", "shoes"),
    ref=[ans(kind="task", linked_to="$baba_l", where='status = "open"')]),
  T("the second one's done, got them on the way home", diff(upd("insulin", status="completed", completed=ANY)),
    ref=[act("complete", rows="$insulin")]),
  T("what's still open there", rows("strips", "reimburse", "shoes"),
    ref=[ans(kind="task", linked_to="$baba_l", where='status = "open"')]),
  T("the last one can be friday instead", diff(upd("shoes", date="2026-04-17")),
    ref=[act("reschedule", rows="$shoes", args=lines(to=U("week", 0, weekday=5)))]))

S("T19-203", "owe direction sum owed balance negative settle mine sum",
  T("what do they owe me all in", val((3150, "MAD")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]),
  T("my side with khalid", val((-350, "MAD")),
    ref=[ans(op="balance", rows="$khalid")]),
  T("settle mine, paid cash", diff(upd("d_khalid", status="settled")),
    ref=[act("settle_debt", kind="debt", where=IOWE, linked_to="$khalid")]),
  T("what do i still owe", val((1450, "MAD")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]))

S("T19-204", "except cancel swimming lessons rest still on",
  T("what swimming lessons are left", rows("swim_0415", "swim_0422", "swim_0429", "swim_0506", "swim_0513"),
    ref=[ans(kind="event", name="swimming lesson", when=W({"from": U("day", 0)}))]),
  T("cancel them all except tomorrow's, the pool's shut for works",
    diff(upd("swim_0422", status="cancelled"), upd("swim_0429", status="cancelled"),
         upd("swim_0506", status="cancelled"), upd("swim_0513", status="cancelled")),
    ref=[find(within="@prev", exclude="$swim_0415"), act("cancel", rows="@prev")]),
  T("which are still on", rows("swim_0415"),
    ref=[ans(kind="event", name="swimming lesson", when=W({"from": U("day", 0)}), where='status != "cancelled"')]))

S("T19-205", "bare weekday at n reschedule create relative range",
  T("move the podiatrist to monday", diff(upd("podiatrist", date="2026-04-20T17:00")),
    ref=[act("reschedule", kind="event", name="Podiatrist", args=lines(to=U("week", 1, weekday=1)))]),
  T("push the plumber call to thursday at 5", diff(upd("sink", date="2026-04-16T17:00")),
    ref=[act("reschedule", kind="task", name="plumber", args=lines(to=U("week", 0, weekday=4, time="17:00")))]),
  T("coffee with nadia sunday at 4", diff(new("event", name=has("Nadia"), date="2026-04-19T16:00")),
    ref=[act("create", args=lines(kind="event", name="Coffee with Nadia", date=U("week", 0, weekday=7, time="16:00")))]),
  T("what's on monday to wednesday this week", rows("plumber_pharm", "run_0414", "berrada_meet", "lina_vacc", "swim_0415"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]))

S("T19-206", "two writes settle debt complete task both directions",
  T("paid aicha for the bread and milk and signed adam's homework book",
    diff(upd("d_aicha", status="settled"), upd("homework", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="Bread and milk for Baba", more=True),
         act("complete", kind="task", name="Sign Adam's homework book")]),
  T("omar sent the glucometer money and i ordered the strips",
    diff(upd("d_omar", status="settled"), upd("strips", status="completed", completed=ANY)),
    ref=[find(kind="debt", name="glucometer"),
         act("settle_debt", kind="debt", name="Baba's new glucometer", more=True),
         act("complete", kind="task", name="Order glucose test strips")]),
  T("what do i owe now", rows("d_nadia", "d_samira", "d_youssef", "d_khalid"),
    ref=[ans(kind="debt", where=IOWE)]))
