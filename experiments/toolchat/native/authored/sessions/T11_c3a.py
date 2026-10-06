from gold import *

world("T11", "2026-07-26T07:30", "Siobhan Kelly", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T11-A002", "ask-options task complete c3a",
  T("tick off the books", ask("books", "books_aoife", "books_cian"),
    ref=[act("complete", kind="task", name="books"),
         askc("Order school books, Aoife's books or Cian's books?", options="$books, $books_aoife, $books_cian")]),
  T("cian's, got them at the shop", diff(upd("books_cian", status="completed", completed=ANY)),
    ref=[act("complete", rows="$books_cian")]))

S("T11-A003", "ask-options event reschedule never_mind c3a",
  T("move the ennis thing to monday", ask("mart_cull", "uniforms"),
    ref=[act("reschedule", kind="event", name="Ennis", args=lines(to=U("week", 1, weekday=1))),
         askc("The cull cow sale at Ennis mart on 6 Aug or the uniform shopping in Ennis on 13 Aug?", options="$mart_cull, $uniforms")]),
  T("actually no, leave them. the mart date is fixed anyway", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and the spread one's done, tick it off", diff(upd("fert", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="spread")]))

S("T11-A004", "ask-options debt settle_debt c3a",
  T("settle the bales one", ask("d_sean_silage", "d_mick_silage"),
    ref=[act("settle_debt", kind="debt", name="bales"),
         askc("Sean's silage bales (you owe 850) or Mick's silage bales (he owes you 240)?", options="$d_sean_silage, $d_mick_silage")]),
  T("mick's, he dropped it in this morning", diff(upd("d_mick_silage", status="settled")),
    ref=[act("settle_debt", rows="$d_mick_silage")]))

S("T11-A005", "ask-options note delete never_mind c3a",
  T("delete the committee minutes", ask("min_jun", "min_jul"),
    ref=[act("delete", kind="note", name="committee minutes"),
         askc("The June minutes or the July ones?", options="$min_jun, $min_jul")]),
  T("no no leave them, the secretary asked for both", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T11-A006", "follow-up c3a",
  T("anything on next week", rows("tb_read", "u12_0729", "mass", "ortho", "draw_0802", "ai_call", "show", "hoof", "noreen_coffee", "tb_test"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the ones before thursday", rows("ortho", "ai_call", "tb_test", "u12_0729"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=3)}))]),
  T("and thursday on", rows("show", "tb_read", "mass", "draw_0802", "hoof", "noreen_coffee"),
    ref=[ans(within="@1", exclude="@2")]))

S("T11-A007", "follow-up c3a",
  T("anything due next week that's an hour or more", rows("fert", "nitrates", "tb_pen", "fence"),
    ref=[ans(kind="task", when=J(U("week", 1)), where="effort >= 60 and status = open")]),
  T("any of those priority 1", rows("nitrates"),
    ref=[ans(within="@prev", where="priority = 1")]))

S("T11-A008", "follow-up c3a",
  T("what do i still owe", rows("d_eileen", "d_fergal", "d_ger", "d_sean_silage", "d_mick_diesel", "d_mary_c"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("those but not the vet bill", rows("d_ger", "d_sean_silage", "d_mick_diesel", "d_eileen", "d_mary_c"),
    ref=[ans(within="@prev", exclude="$d_fergal")]),
  T("and the biggest one", rows("d_sean_silage"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T11-A009", "follow-up c3a",
  T("what's in the herd folder", rows("tb_cert", "herd_register", "ai_records"),
    ref=[ans(kind="document", linked_to="$herd_f")]),
  T("which of those are starred", rows("herd_register"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it now", diff(upd("herd_register", starred=False)),
    ref=[act("unstar", rows="@prev")]))
