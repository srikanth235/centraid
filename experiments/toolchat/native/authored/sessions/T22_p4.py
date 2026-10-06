from gold import *
import json

world("T22", "2026-07-13T21:25", "Sven Lindqvist", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
LEFT = 'status = "open"'

S("T22-201", "both reschedule swimming lessons both star johans",
  T("what swimming lessons does elias have", rows("swim_1", "swim_2"),
    ref=[ans(kind="event", name="Swimming lesson", when=W({"from": U("day", 0)}))]),
  T("push both to 6, the pool changed times",
    diff(upd("swim_1", date="2026-07-14T18:00"), upd("swim_2", date="2026-07-21T18:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("who's johan", rows("johan_b", "johan_n"),
    ref=[ans(kind="person", name="Johan")]),
  T("star both", diff(upd("johan_b", starred=True), upd("johan_n", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T22-202", "ordinal first relist third home list complete reschedule",
  T("what's open on the home list",
    rows("parking_fine", "smoke_alarm", "dishwasher", "el_07", "car_insurance"),
    ref=[ans(kind="task", linked_to="$home_l", where=LEFT)]),
  T("the first one's done, paid it at lunch", diff(upd("parking_fine", status="completed", completed=ANY)),
    ref=[act("complete", rows="$parking_fine")]),
  T("what's left on it", rows("smoke_alarm", "dishwasher", "el_07", "car_insurance"),
    ref=[ans(kind="task", linked_to="$home_l", where=LEFT)]),
  T("move the third one to friday", diff(upd("el_07", date="2026-07-17")),
    ref=[act("reschedule", rows="$el_07", args=lines(to=U("week", 0, weekday=5)))]))

S("T22-203", "owe direction positive balance negative balance settle mine sum owed",
  T("what does samira owe me", val((2000, "SEK")),
    ref=[ans(op="balance", rows="$samira")]),
  T("and my side with gunnar", val((-800, "SEK")),
    ref=[ans(op="balance", rows="$gunnar")]),
  T("settle mine, paid him back for the ladder", diff(upd("d_gunnar", status="settled")),
    ref=[act("settle_debt", kind="debt", where=IOWE, linked_to="$gunnar")]),
  T("what do they owe me all in", val((2920, "SEK")),
    ref=[ans(op="sum", field="amount", kind="debt", where=OWED)]))

S("T22-204", "except complete shopping list rest then reschedule the remaining one",
  T("what's on the shopping list", rows("charcoal", "mamma_gift", "sunscreen"),
    ref=[ans(kind="task", linked_to="$shop_l", where=LEFT)]),
  T("got everything except mamma's present, tick them off",
    diff(upd("charcoal", status="completed", completed=ANY), upd("sunscreen", status="completed", completed=ANY)),
    ref=[find(within="@prev", exclude="$mamma_gift"), act("complete", rows="@prev")]),
  T("what's left on it", rows("mamma_gift"),
    ref=[ans(kind="task", linked_to="$shop_l", where=LEFT)]),
  T("move that to friday", diff(upd("mamma_gift", date="2026-07-17")),
    ref=[act("reschedule", rows="$mamma_gift", args=lines(to=U("week", 0, weekday=5)))]))

S("T22-205", "bare weekday today counts at n reschedule create friday night relative range",
  T("friday works better for the car service now", diff(upd("car_service", date="2026-07-17T07:30")),
    ref=[act("reschedule", kind="event", name="Car service at Bilia", args=lines(to=U("week", 0, weekday=5)))]),
  T("move the agency call to thursday at 3", diff(upd("agency", date="2026-07-16T15:00")),
    ref=[act("reschedule", kind="task", name="Call the adoption agency about Elias's file",
             args=lines(to=U("week", 0, weekday=4, time="15:00")))]),
  T("drinks with david friday night at 9", diff(new("event", name=has("David"), date="2026-07-17T21:00")),
    ref=[act("create", args=lines(kind="event", name="Drinks with David", date=U("week", 0, weekday=5, time="21:00")))]),
  T("what events fall between next monday and next wednesday",
    rows("inventory", "swim_2", "padel_0721", "forklift_training", "leads_0722"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]))
