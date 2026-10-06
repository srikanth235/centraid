from gold import *

world("T18", "2026-03-01T11:20", "Jordan Ellis", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T18-A002", "ask-options task complete c3a",
  T("tick off the invite one", ask("inv_draft", "inv_ok"),
    ref=[act("complete", kind="task", name="invite"),
         askc("Draft invite wording or Get Tess to sign off the invite?", options="$inv_draft, $inv_ok")]),
  T("the draft, wrote it this morning", diff(upd("inv_draft", status="completed", completed=ANY)),
    ref=[act("complete", rows="$inv_draft")]))

S("T18-A003", "ask-options event reschedule c3a",
  T("move the shower to 2", ask("shower_ev", "shower_call"),
    ref=[act("reschedule", kind="event", name="shower", args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         askc("Tess's baby shower on the 21st or the planning call with Chloe on the 3rd?", options="$shower_ev, $shower_call")]),
  T("the actual shower, the 21st", diff(upd("shower_ev", date="2026-03-21T14:00")),
    ref=[act("reschedule", rows="$shower_ev", args=lines(to=U("day", 0, anchor="row", time="14:00")))]),
  T("and the finish one's done, tick it off", diff(upd("slice", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="finish")]))

S("T18-A004", "ask-options document delete never_mind c3a",
  T("delete the shower doc", ask("budget", "guests"),
    ref=[act("delete", kind="document", name="shower"),
         askc("The shower budget or the shower guest list?", options="$budget, $guests")]),
  T("oh wait no, chloe needs both of them", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T18-A005", "ask-options debt settle_debt c3a",
  T("mark the pizza as settled", ask("d_marcus_pizza", "d_jules_pizza"),
    ref=[act("settle_debt", kind="debt", name="pizza"),
         askc("Marcus's pizza (he owes you 24) or Jules's pizza (you owe 18)?", options="$d_marcus_pizza, $d_jules_pizza")]),
  T("marcus, he venmo'd me", diff(upd("d_marcus_pizza", status="settled")),
    ref=[act("settle_debt", rows="$d_marcus_pizza")]))

S("T18-A007", "follow-up c3a",
  T("what's open on the co-op dev list", rows("cart", "slice", "loc", "trailer", "grant_report", "capsule", "tutorial", "ci", "press_kit"),
    ref=[ans(kind="task", linked_to="$dev_l", where="status = open")]),
  T("which of those are priority 1", rows("slice", "trailer"),
    ref=[ans(within="@prev", where="priority = 1")]),
  T("what about the others", rows("cart", "loc", "press_kit", "grant_report", "capsule", "tutorial", "ci"),
    ref=[ans(within="@1", exclude="@2")]))

S("T18-A008", "follow-up c3a",
  T("show me next week", rows("dogclass_0307", "mum_lunch", "climb_mar", "shower_call", "pitch", "vax", "market", "playtest_mar", "dnd_0305", "sprint_0306"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just next weekend", rows("dogclass_0307", "market", "mum_lunch"),
    ref=[ans(within="@prev", when=J(span(U("week", 1, weekday=6), U("week", 1, weekday=7))))]),
  T("what about before that", rows("sprint_0306", "pitch", "vax", "dnd_0305", "climb_mar", "playtest_mar", "shower_call"),
    ref=[ans(within="@1", exclude="@2")]))

S("T18-A009", "follow-up c3a",
  T("who do i owe", rows("d_priya", "d_alex", "d_chloe", "d_nadia", "d_jules_pizza"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("those but not the pizza", rows("d_nadia", "d_alex", "d_chloe", "d_priya"),
    ref=[ans(within="@prev", exclude="$d_jules_pizza")]),
  T("the biggest of those?", rows("d_alex"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T18-A010", "follow-up c3a",
  T("show me the biscuit album", rows("b_class", "b_beach", "b_snow", "b_vet", "b_puppy", "b_creek", "b_couch", "b_bday"),
    ref=[ans(kind="photo", linked_to="$biscuit_al")]),
  T("which have a star", rows("b_beach", "b_bday", "b_puppy"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("what about the rest", rows("b_snow", "b_class", "b_vet", "b_creek", "b_couch"),
    ref=[ans(within="@1", exclude="@2")]))
