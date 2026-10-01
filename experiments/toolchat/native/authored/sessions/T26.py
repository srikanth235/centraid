from gold import *

world("T26", "2026-11-24T05:30", "Ahmed Bello", "train")


S("T26-001", "single person open span weekday",
  T("who have i been in touch with since last thursday", rows("ngozi", "mama", "aisha", "olumide", "segun"),
    ref=[ans(kind="person", when={"from": U("week", -1, weekday=4)})]))

S("T26-002", "person rel time log prev event named",
  T("who did i call yesterday at 9pm", rows("mama"),
    ref=[ans(kind="person", when=U("day", -1, time="21:00"))]),
  T("log another call with her, she rang again at 5", diff(upd("mama", date=ANY)),
    ref=[act("log", rows="$mama", args=lines(kind="call"))]),
  T("when's her birthday thing", rows("mama70"),
    ref=[ans(kind="event", name="Mama's 70th birthday")]))

S("T26-003", "refused unit cadence repair met contains cadence empty",
  T("people i'm meant to check on more often than every two weeks", rows("mama", "chidi", "olumide"),
    ref=[bad(ans(kind="person", where="cadence < 2 weeks")),
         ans(kind="person", where="cadence < 14")]),
  T("and the bonga guys with no cadence at all", rows("emeka_n", "emeka_o", "victor", "kunle_a"),
    ref=[ans(kind="person", where='met contains "Bonga" and cadence is empty')]))

S("T26-004", "refused unit cadence cousins cadence empty log debt linked",
  T("which cousins have a cadence longer than two weeks", rows("kunle_b", "ibrahim"),
    ref=[bad(ans(kind="person", where='role contains "cousin" and cadence > 2 weeks')),
         ans(kind="person", where='role contains "cousin" and cadence > 14')]),
  T("and the ones with none", rows("bayo", "funmi", "sade"),
    ref=[ans(kind="person", where='role contains "cousin" and cadence is empty')]),
  T("log a message with bayo, texted him about the loan", diff(upd("bayo", date=ANY)),
    ref=[act("log", rows="$bayo", args=lines(kind="message"))]),
  T("remind me how much that loan was", val((150000, "NGN")),
    ref=[ans(op="sum", field="amount", kind="debt", linked_to="$bayo")]))

S("T26-005", "role in star multi",
  T("show me everyone saved as cousin or builder", rows("bayo", "funmi", "sade", "ibrahim", "olumide"),
    ref=[ans(kind="person", where='role in ("cousin", "builder")')]),
  T("star funmi and sade, they're doing the party food", diff(upd("funmi", starred=True), upd("sade", starred=True)),
    ref=[act("star", rows="$funmi, $sade")]))

S("T26-006", "met contains substitution fragment",
  T("who did i meet in ibadan", rows("kunle_b", "bayo", "funmi"),
    ref=[ans(kind="person", where='met contains "Ibadan"')]),
  T("and lagos?", rows("sade"),
    ref=[ans(kind="person", where='met contains "Lagos"')]),
  T("pull up kunle", rows("kunle_b", "kunle_a"),
    ref=[find(kind="person", name="Kunle"),
         ans(rows="@prev")]))

S("T26-007", "person event count note count",
  T("any cousin i've got no events with?", rows("ibrahim"),
    ref=[ans(kind="person", where='role contains "cousin" and event count < 1')]),
  T("who's got two or more notes about them", rows("chidi", "garba", "olumide", "mama", "aisha"),
    ref=[ans(kind="person", where="note count >= 2")]),
  T("open garba", rows("garba"),
    ref=[ans(rows="$garba")]))

S("T26-008", "group currency edit refused ask never mind",
  T("which groups are in dollars", rows("aberdeen_g", "welfare_g"),
    ref=[ans(kind="group", where='currency = "USD"')]),
  T("switch both to naira, we settle locally", ask(),
    ref=[bad(act("edit", rows="@prev", args=lines(currency="NGN"))),
         askc("a group's currency can't be changed once it has one. want new naira groups for aberdeen and the welfare fund instead?")]),
  T("no leave them", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T26-009", "single edit group notebook folder multi named",
  T("rename the house build folder, the house build notebook and Rumuokoro house build group all to Rumuokoro house",
    diff(upd("house_f", name="Rumuokoro house"), upd("house_nb", name="Rumuokoro house"),
         upd("house_g", name="Rumuokoro house")),
    ref=[act("edit", rows="$house_f, $house_nb, $house_g", args=lines(name="Rumuokoro house"))]))

S("T26-010", "delete group where currency knock-on",
  T("any group in pounds?", rows("fivea_g"),
    ref=[ans(kind="group", where='currency = "GBP"')]),
  T("delete it, that five-a-side never took off",
    diff(gone("fivea_g"), unlink("fivea_g", "tunde"), unlink("fivea_g", "ifeanyi"), unlink("fivea_g", "me")),
    ref=[act("delete", kind="group", where='currency = "GBP"')]))

S("T26-011", "single delete group where person count",
  T("delete whichever group has me in it", diff(gone("xmas_g"), unlink("xmas_g", "me")),
    ref=[act("delete", kind="group", where="person count = 1")]))

S("T26-012", "restore event named trashed reschedule",
  T("restore Meeting with the surveyor, i deleted it by mistake", diff(restore("surveyor")),
    ref=[act("restore", kind="event", name="Meeting with the surveyor", trashed=True)]),
  T("and move it to friday 4pm", diff(upd("surveyor", date="2026-11-27T16:00")),
    ref=[act("reschedule", rows="$surveyor", args=lines(to=U("week", 0, weekday=5, time="16:00")))]))

S("T26-013", "find trashed events restore named restore window ask",
  T("what's in the calendar trash", rows("surveyor", "cinema", "golf"),
    ref=[find(kind="event", trashed=True), ans(rows="@prev")]),
  T("bring back the kids cinema outing", diff(restore("cinema")),
    ref=[act("restore", kind="event", name="Kids cinema outing", trashed=True)]),
  T("golf with john too", ask(),
    ref=[bad(act("restore", kind="event", name="Golf with John", trashed=True)),
         askc("golf with john went in the bin on 22 september, past the 30 days, so it can't come back. want me to make it again as a new event?")]))

S("T26-014", "create event delete new restore new",
  T("put Lunch with the tiles supplier on saturday at 1", diff(new("event", name="Lunch with the tiles supplier",
                                                                     date="2026-11-28T13:00")),
    ref=[act("create", args=lines(kind="event", name="Lunch with the tiles supplier",
                                  date=U("week", 0, weekday=6, time="13:00")))]),
  T("hmm delete it, he's not sure", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("ok he's coming after all, bring it back", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T26-015", "create event delete restore new day read",
  T("add Call with Zenith mortgage desk tomorrow at 3", diff(new("event", name="Call with Zenith mortgage desk",
                                                                  date="2026-11-25T15:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Zenith mortgage desk",
                                  date=U("day", 1, time="15:00")))]),
  T("delete it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("no restore it, they confirmed", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]),
  T("so what have i got tomorrow", rows("roof_insp", "+1"),
    ref=[ans(kind="event", when=U("day", 1))]))

S("T26-016", "delete task where cancelled undo delete",
  T("delete the cancelled one in the house build list", diff(trash("bq")),
    ref=[act("delete", kind="task", linked_to="$house_l", where='status = "cancelled"')]),
  T("undo that, i might build the bq", diff(restore("bq")),
    ref=[act("undo")]))

S("T26-017", "delete task prev multi list done",
  T("which completed tasks are in the offshore list", rows("timesheet", "permit"),
    ref=[ans(kind="task", linked_to="$rig_l", where='status = "completed"')]),
  T("delete those", diff(trash("timesheet"), trash("permit")),
    ref=[act("delete", rows="@prev")]),
  T("what's left in there", rows("bosiet_t", "pack", "handover_t", "multimeter", "coveralls"),
    ref=[ans(kind="task", linked_to="$rig_l")]))

S("T26-018", "find trashed task miss restore named list",
  T("did i delete the task about selling the old generator", rows("old_gen"),
    ref=[find(kind="task", name="old generator"), ans(rows="$old_gen")]),
  T("restore Sell old generator, a guy in Eleme wants it", diff(restore("old_gen")),
    ref=[act("restore", kind="task", name="Sell old generator", trashed=True)]),
  T("give it priority two and due friday", diff(upd("old_gen", priority=2, date="2026-11-27")),
    ref=[act("edit", rows="$old_gen", args=lines(priority=2), more=True),
         act("reschedule", rows="$old_gen", args=lines(to=U("week", 0, weekday=5)))]))

S("T26-019", "restore task named restore window gym ask",
  T("put Sell old generator back from the trash", diff(restore("old_gen")),
    ref=[act("restore", kind="task", name="Sell old generator", trashed=True)]),
  T("and the gym membership one", decline("not_found"),
    ref=[bad(act("restore", kind="task", name="Renew gym membership", trashed=True)),
         dec("not_found")]))

S("T26-020", "note find delete prev undo",
  T("find my note on the crane limit switch", rows("crane_n"),
    ref=[ans(kind="note", name="Crane limit switch")]),
  T("emeka fixed it, delete that", diff(trash("crane_n")),
    ref=[act("delete", rows="@prev")]),
  T("undo, i want the history", diff(restore("crane_n")),
    ref=[act("undo")]))

S("T26-021", "note span delete prev",
  T("notes i made from 20 to twenty-second november", rows("guest_list", "anniv_n", "roof_quotes", "socket_plan", "tobi_waec",
                                                  "party_menu"),
    ref=[ans(kind="note", when=span(D("2026-11-20"), D("2026-11-22")))]),
  T("delete the anniversary one", diff(trash("anniv_n")),
    ref=[act("delete", kind="note", within="@prev", name="Anniversary")]))

S("T26-022", "trashed note restore prev",
  T("is there a budget note in the trash", rows("old_budget"),
    ref=[ans(kind="note", name="budget", trashed=True)]),
  T("restore it", diff(restore("old_budget")),
    ref=[act("restore", rows="@prev")]))

S("T26-023", "find trashed note restore prev notebook",
  T("is my old house budget note in the trash?", rows("old_budget"),
    ref=[find(kind="note", name="Old house budget", trashed=True), ans(rows="@prev")]),
  T("bring it back and put it in house build", diff(restore("old_budget"), link("house_nb", "old_budget")),
    ref=[act("restore", rows="@prev", more=True),
         act("add_to", rows="$old_budget", args=lines(to="$house_nb"))]))

S("T26-024", "create document delete new",
  T("save a doc called Roofing sheet invoice", diff(new("document", name="Roofing sheet invoice")),
    ref=[act("create", args=lines(kind="document", name="Roofing sheet invoice"))]),
  T("oh wrong one, delete it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T26-025", "create document folder delete new undo",
  T("new document Plastering quote in the house build folder",
    diff(new("document", name="Plastering quote"), link("house_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Plastering quote", folder="$house_f"))]),
  T("hmm garba hasn't sent it yet, delete it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("undo that, he did", diff(restore("+1")),
    ref=[act("undo")]))
