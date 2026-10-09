from gold import *


S("T21-026", "five turns person datetime span cadence log undo ledger",
  T("who did i talk to thursday 7pm", rows("brian"),
    ref=[ans(kind="person", when=U("week", 0, weekday=4, time="19:00"))]),
  T("and everyone i was in touch with from last week up to yesterday 6pm",
    rows("kevin", "brian", "wanjiru", "peter_k", "mary_a", "rev_kiprono", "peter_o", "daniel", "joseph",
         "mary_w", "tabby"),
    ref=[ans(kind="person", when=span(U("week", -1), U("day", -1, time="18:00")))]),
  T("which of them am i meant to check on at least weekly", rows("kevin", "brian", "joseph", "mary_w"),
    ref=[ans(kind="person", within="@prev", where="cadence <= 7 days")]),
  T("log a call with kevin, hung up", diff(upd("kevin", date=ANY)),
    ref=[act("log", rows="$kevin", args=lines(kind="call"))]),
  T("undo that, it was naomi on his phone", diff(),
    ref=[act("undo")]))

S("T21-027", "person span weekday group count star",
  T("who have i contacted from monday till yesterday 3pm",
    rows("wanjiru", "peter_o", "daniel", "mary_a", "brian", "joseph"),
    ref=[ans(kind="person", when=span(U("week", 0, weekday=1), U("day", -1, time="15:00")))]),
  T("which of those aren't in any of my groups", rows("wanjiru", "daniel"),
    ref=[ans(kind="person", within="@prev", where="group count <= 0")]),
  T("star Daniel Ruto", diff(upd("daniel", starred=True)),
    ref=[act("star", rows="$daniel")]))

S("T21-028", "event named month within duration",
  T("what's on in july", rows("brief_0706", "brief_0713", "brief_0720", "brief_0727", "chama_07", "parents_day",
                             "brian_grad", "shiru_halfterm", "ruracio"),
    ref=[ans(kind="event", when=U("month", 0, name=7))]),
  T("and which of these take longer than three hours", rows("brian_grad", "ruracio"),
    ref=[ans(kind="event", within="@prev", where="duration > 180")]))

S("T21-029", "event span date rel description reschedule",
  T("what have i got from the tenth to the end of next week",
    rows("bom_june", "lunch_mary", "choir_0611", "dentist_shiru", "kevin_visit"),
    ref=[ans(kind="event", when=span(D("2026-06-10"), U("week", 1)))]),
  T("which of them have a location or note on them", rows("bom_june"),
    ref=[ans(kind="event", within="@prev", where="description is set")]),
  T("move lunch with mary to friday, same time", diff(upd("lunch_mary", date="2026-06-12T13:00")),
    ref=[act("reschedule", rows="$lunch_mary", args=lines(to=U("week", 1, weekday=5, time="13:00")))]))

S("T21-030", "event span month datetime open span",
  T("anything from the start of july up to noon on the tenth",
    rows("brief_0706", "chama_07", "parents_day", "brian_grad"),
    ref=[ans(kind="event", when=span(U("month", 0, name=7), D("2026-07-10", "12:00")))]),
  T("and from august on?", rows("chama_08", "heads_conf"),
    ref=[ans(kind="event", when={"from": U("month", 0, name=8)})]))

S("T21-031", "task span datetime weekday priority",
  T("school list stuff due between today noon and next friday", rows("term_report", "mock_tt", "obs_g4", "arrears"),
    ref=[ans(kind="task", linked_to="$school_l", when=span(U("day", 0, time="12:00"), U("week", 1, weekday=5)))]),
  T("of those, the ones with a priority that isn't 1", rows("term_report"),
    ref=[ans(kind="task", within="@prev", where="priority != 1")]),
  T("when's the PTA meeting", decline("not_found"),
    ref=[find(kind="event", name="PTA meeting"), search("PTA"), dec("not_found")]))

S("T21-032", "task span rel date complete",
  T("home list, what's due from tomorrow to the fifteenth", rows("gas", "kplc_06", "water_bill"),
    ref=[ans(kind="task", linked_to="$home_l", when=span(U("day", 1), D("2026-06-15")))]),
  T("gas is refilled already, tick it", diff(upd("gas", status="completed", completed=ANY)),
    ref=[act("complete", rows="$gas")]))

S("T21-033", "note weekday time edit prev linked",
  T("the note i made on wednesday at 8:15 pm", rows("bom_agenda"),
    ref=[ans(kind="note", when=U("week", 0, weekday=3, time="20:15"))]),
  T("add the harambee tents to it", diff(upd("bom_agenda", body=has("harambee"))),
    ref=[act("edit", rows="@prev",
             args=lines(body="fees arrears, gutter repair, feeding contract, staffing, harambee tents"))]),
  T("who's tagged on it", rows("peter_k", "joseph"),
    ref=[ans(kind="person", linked_to="$bom_agenda")]))

S("T21-034", "note span weekdays notebook count",
  T("notes from last monday to last friday", rows("enrolment", "plot_notes", "staffing", "mock_plan"),
    ref=[ans(kind="note", when=span(U("week", -1, weekday=1), U("week", -1, weekday=5)))]),
  T("any of those not in a notebook", rows("plot_notes"),
    ref=[ans(kind="note", within="@prev", where="notebook count <= 0")]))

S("T21-036", "document span date month starred",
  T("docs from new year through march", rows("school_budget", "audit_letter", "fee_structure", "shiru_receipt",
                                            "chama_ledger"),
    ref=[ans(kind="document", when=span(D("2026-01-01"), U("month", 0, name=3)))]),
  T("which of those aren't starred", rows("audit_letter", "fee_structure", "shiru_receipt", "chama_ledger"),
    ref=[ans(kind="document", within="@prev", where="starred != yes")]))

S("T21-037", "document open span star",
  T("documents added since first may", rows("bom_minutes", "arrears_list", "survey_map", "bp_chart", "sha_letter",
                                        "tsc_payslip", "grad_invite", "insurance_doc", "scan_1", "scan_2"),
    ref=[ans(kind="document", when={"from": D("2026-05-01")})]),
  T("star Car insurance renewal", diff(upd("insurance_doc", starred=True)),
    ref=[act("star", rows="$insurance_doc")]))

S("T21-038", "document to datetime folder count",
  T("in school fees, what did i save before june first 11am", rows("fee_structure", "shiru_receipt"),
    ref=[ans(kind="document", linked_to="$fees_f", when={"to": D("2026-06-01", "11:00")})]),
  T("how many docs in that folder altogether", val(3),
    ref=[ans(op="count", kind="document", linked_to="$fees_f")]))

S("T21-039", "document to weekday folder create folder add_to new",
  T("any unfiled documents saved up to last friday", rows("tsc_payslip"),
    ref=[ans(kind="document", when={"to": U("week", -1, weekday=5)}, where="folder count = 0")]),
  T("make a Payslips folder and put it in there", diff(new("folder", name="Payslips"), link("new", "tsc_payslip")),
    ref=[act("create", args=lines(kind="folder", name="Payslips"), more=True),
         act("add_to", rows="$tsc_payslip", args=lines(to="$new"))]))

S("T21-040", "photo span rel count starred",
  T("how many photos did i take over the last two months", val(16),
    ref=[ans(op="count", kind="photo", when=span(U("month", -2), U("month", -1)))]),
  T("and how many got starred", val(2),
    ref=[ans(op="count", kind="photo", when=span(U("month", -2), U("month", -1)), where="starred = yes")]),
  T("restore the hair appointment", ask("salon", "salon_old"),
    ref=[act("restore", kind="event", name="Hair appointment", trashed=True),
         find(kind="event", name="Hair appointment", trashed=True),
         askc("there are two in the bin, 2 june and 14 april. which one?", options="$salon, $salon_old")]),
  T("the june one", diff(restore("salon")),
    ref=[act("restore", rows="$salon")]))

S("T21-042", "debt named month amount",
  T("debts from may", rows("d_mary_a", "d_rose", "d_kevin", "d_peter_o", "d_susan"),
    ref=[ans(kind="debt", when=U("month", 0, name=5))]),
  T("which are exactly 500", rows("d_mary_a", "d_rose", "d_susan"),
    ref=[ans(kind="debt", within="@prev", where="amount = 500")]))

S("T21-043", "debt span date datetime status",
  T("debts between first may and june first 6pm", rows("d_mary_a", "d_rose", "d_kevin", "d_peter_o", "d_susan",
                                                 "d_githinji"),
    ref=[ans(kind="debt", when=span(D("2026-05-01"), D("2026-06-01", "18:00")))]),
  T("only the open ones i owe", rows("d_kevin", "d_susan", "d_githinji"),
    ref=[ans(kind="debt", within="@prev", where='status = "open" and direction = "i_owe"')]))

S("T21-044", "single debt span month date status settled",
  T("any debts from march up to the fifteenth of may that are settled", rows("d_tabby"),
    ref=[ans(kind="debt", when=span(U("month", 0, name=3), D("2026-05-15")), where='status = "settled"')]))

S("T21-045", "debt open span sum rows",
  T("total i've lent since april that's owed to me", val((3000, "KES")),
    ref=[ans(op="sum", field="amount", kind="debt", when={"from": U("month", 0, name=4)},
             where='direction = "owes_me" and status = "open"')]),
  T("list them", rows("d_mary_a", "d_rose", "d_peter_o"),
    ref=[ans(kind="debt", when={"from": U("month", 0, name=4)}, where='direction = "owes_me" and status = "open"')]))

S("T21-046", "create person star new add_to group count",
  T("new contact Agnes Chepkemoi, the kiswahili teacher TSC is sending",
    diff(new("person", name="Agnes Chepkemoi", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Agnes Chepkemoi", role="Kiswahili teacher"))]),
  T("star her, put her in BOM tea fund and log a call, i rang her. who's in the fund",
    rows("peter_k", "mary_w", "joseph", "me", "+1",
         also=diff(upd("+1", starred=True, date=ANY), link("bom_tea", "+1"))),
    ref=[act("star", rows="$c1", more=True),
         act("add_to", rows="$c1", args=lines(to="$bom_tea"), more=True),
         act("log", rows="$c1", args=lines(kind="call"), more=True),
         ans(kind="person", linked_to="$bom_tea")]),
  T("how many is that", val(5),
    ref=[ans(op="count", kind="person", linked_to="$bom_tea")]))

S("T21-047", "create event delete new undo delete",
  T("dinner with the area MCA friday 7pm", diff(new("event", name=has("MCA"), date="2026-06-12T19:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with the area MCA",
                                  date=U("week", 1, weekday=5, time="19:00")))]),
  T("delete it, he postponed", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("no wait undo, he says its on", diff(restore("+1")),
    ref=[act("undo")]),
  T("when is Heads' conference", rows("heads_conf"),
    ref=[ans(kind="event", name="Heads' conference")]),
  T("push it back a bit", ask(),
    ref=[askc("how much later, or to which day?")]))

S("T21-048", "event overlap refused ask create",
  T("add choir concert on the twenty-first 2 to 4pm", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Choir concert", date=D("2026-06-21", "14:00"),
                                      duration=120))),
         askc("the harambee runs 11 to 3 that sunday. start the concert at 3 instead?")]),
  T("make it 3:30 for an hour and a half", diff(new("event", name="Choir concert", date="2026-06-21T15:30")),
    ref=[act("create", args=lines(kind="event", name="Choir concert", date=D("2026-06-21", "15:30"),
                                  duration=90))]))

S("T21-049", "restore window photo refused ask",
  T("restore the blurry prize giving photo", ask(),
    ref=[bad(act("restore", kind="photo", name="Blurry prize giving", trashed=True)),
         askc("that one went to the bin in april, past the 30 days, so it can't come back. want to star the prize giving stage photo instead?")]),
  T("no leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T21-050", "ambiguous folder ask delete refused",
  T("delete the school folder", ask("board_f", "fees_f"),
    ref=[act("delete", kind="folder", name="School"),
         askc("school board or school fees?", options="$board_f, $fees_f")]),
  T("fees", ask(),
    ref=[bad(act("delete", rows="$fees_f")),
         askc("school fees still has 3 documents in it so it can't go. move them out first?")]),
  T("forget it then", decline("never_mind"),
    ref=[dec("never_mind")]))
