from gold import *


S("T26-051", "seven turns events span dentist ambiguous overlap ask create cancelled delete",
  T("what's on from noon today to friday", rows("roof_insp", "dentist_femi", "car_service", "mortgage", "pta"),
    ref=[ans(kind="event", when=span(U("day", 0, time="12:00"), U("week", 0, weekday=5)))]),
  T("move the dentist to 10", diff(upd("dentist_femi", date="2026-11-26T10:00")),
    ref=[act("reschedule", kind="event", name="Dentist", args=lines(to=U("day", 0, anchor="row", time="10:00"))),
         act("reschedule", rows="$dentist_femi", args=lines(to=U("day", 0, anchor="row", time="10:00")))]),
  T("add Fuel the generator on thursday at 9:30", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Fuel the generator",
                                      date=U("week", 0, weekday=4, time="09:30")))),
         askc("thursday 9:30 runs into femi's dentist at 10. put it at 8 instead?")]),
  T("ok 8", diff(new("event", name="Fuel the generator", date="2026-11-26T08:00")),
    ref=[act("create", args=lines(kind="event", name="Fuel the generator",
                                  date=U("week", 0, weekday=4, time="08:00")))]),
  T("and when is kemi's dentist", rows("dentist_kemi"),
    ref=[ans(kind="event", name="Dentist for Kemi")]),
  T("anything cancelled before friday", rows("tunde_wedding", "chidi_dinner"),
    ref=[ans(kind="event", where='status = "cancelled"', when={"to": U("week", 0, weekday=5)})]),
  T("delete both", diff(trash("tunde_wedding"), trash("chidi_dinner")),
    ref=[act("delete", rows="@prev")]))

S("T26-052", "five turns balance person group settle_up add_to log knock-on person",
  T("where do i stand with chidi", val((45500, "NGN"), (-125, "USD")),
    ref=[ans(op="balance", kind="person", name="Chidi Okafor")]),
  T("and what's his position in the bonga crew kitty", val((29500, "NGN")),
    ref=[ans(op="balance", kind="group", name="Bonga crew kitty", linked_to="$chidi")]),
  T("go ahead and settle that kitty up with him", diff(settle=["Chidi Okafor"]),
    ref=[act("settle_up", rows="$chidi", args=lines(group="$rig_g"))]),
  T("put him in Christmas party 2026 and log a visit, he left the house",
    diff(link("xmas_g", "chidi"), upd("chidi", date=ANY)),
    ref=[act("add_to", rows="$chidi", args=lines(to="$xmas_g"), more=True),
         act("log", rows="$chidi", args=lines(kind="visit"))]),
  T("who's in that group", rows("me", "chidi"),
    ref=[ans(kind="person", linked_to="$xmas_g")]))

S("T26-053", "five turns debt span amount unit compute max settle add_to knock-on debt",
  T("debts from first october to the end of this month",
    rows("d_funmi", "d_emeka", "d_victor", "d_chidi", "d_tunde", "d_segun", "d_garba", "d_aisha", "d_olumide"),
    ref=[ans(kind="debt", when=span(D("2026-10-01"), U("month", 0)))]),
  T("the small ones under 30000", rows("d_emeka", "d_tunde", "d_segun", "d_garba"),
    ref=[ans(kind="debt", within="@prev", where="amount < 30000 NGN")]),
  T("biggest open debt each way", vgroups({"owes_me": (150000, "NGN"), "i_owe": (250000, "NGN")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]),
  T("garba paid back the transport advance, settle it and add him to the christmas party group",
    diff(upd("d_garba", status="settled"), link("xmas_g", "garba")),
    ref=[act("settle_debt", kind="debt", name="Transport advance", more=True),
         act("add_to", rows="$garba", args=lines(to="$xmas_g"))]),
  T("who still owes me", rows("d_chidi", "d_tunde", "d_bayo", "d_funmi", "d_ibrahim", "d_segun"),
    ref=[ans(kind="debt", where='direction = "owes_me" and status = "open"')]))

S("T26-054", "five turns notebook miss search empty add_to note count person count delete named",
  T("what's in my poltry notebook", rows(),
    ref=[find(kind="notebook", name="poltry"), search("poltry", kind="notebook"),
         ans(kind="note", linked_to="$poultry_nb")]),
  T("ok move the catfish pond note into it", diff(unlink("biz_nb", "fish_farm"), link("poultry_nb", "fish_farm")),
    ref=[act("add_to", kind="note", name="Catfish pond idea", args=lines(to="$poultry_nb"))]),
  T("which notebooks have more than three notes", rows("offshore_nb", "house_nb"),
    ref=[ans(kind="notebook", where="note count > 3")]),
  T("notes with nobody linked", rows("rotation_n", "socket_plan", "ajo_rules", "fish_farm", "mortgage_n"),
    ref=[ans(kind="note", where="person count < 1")]),
  T("delete Mortgage questions, the bank answered everything", diff(trash("mortgage_n")),
    ref=[act("delete", kind="note", name="Mortgage questions")]))

S("T26-055", "notebook typo miss search read delete prev pin",
  T("open the ofshore log notebook", rows("turbine", "handover_n", "crane_n", "permit_n", "rotation_n"),
    ref=[find(kind="notebook", name="ofshore log"), search("ofshore log", kind="notebook"),
         ans(kind="note", linked_to="$offshore_nb")]),
  T("what does the turbine one say", rows("turbine"),
    ref=[ans(rows="$turbine")]),
  T("delete it, the relay got swapped", diff(trash("turbine")),
    ref=[act("delete", rows="@prev")]),
  T("pin the handover one instead", diff(upd("handover_n", pinned=True)),
    ref=[act("edit", rows="$handover_n", args=lines(pinned="yes"))]))

S("T26-056", "five turns task typo miss search effort priority empty edit diesel ambiguous",
  T("where's the invertor task", rows("inverter"),
    ref=[find(kind="task", name="invertor"), search("invertor", kind="task"), ans(rows="$inverter")]),
  T("what else in the home list takes more than an hour", rows("gate"),
    ref=[bad(ans(kind="task", linked_to="$home_l", where="effort > 1 hour", exclude="$inverter")),
         ans(kind="task", linked_to="$home_l", where="effort > 60", exclude="$inverter")]),
  T("and open ones there with no priority", rows("diesel_2", "gen_service", "power_11"),
    ref=[ans(kind="task", linked_to="$home_l", where='priority is empty and status = "open"')]),
  T("set the generator service to priority three", diff(upd("gen_service", priority=3)),
    ref=[act("edit", rows="$gen_service", args=lines(priority=3))]),
  T("move the diesel one to wednesday", diff(upd("diesel_2", date="2026-11-25")),
    ref=[act("reschedule", kind="task", name="Buy diesel for generator", args=lines(to=U("week", 0, weekday=3))),
         act("reschedule", rows="$diesel_2", args=lines(to=U("week", 0, weekday=3)))]))

S("T26-057", "task span weeks priority list count person count complete",
  T("top priority stuff due this week or next", rows("roofing", "instalment", "fees_tobi", "fees_kemi", "inverter", "party"),
    ref=[ans(kind="task", where="priority = 1", when=span(U("week", 0), U("week", 1)))]),
  T("which of those are on a list", rows("roofing", "instalment", "fees_tobi", "fees_kemi", "inverter"),
    ref=[ans(kind="task", within="@prev", where="list count >= 1")]),
  T("and which have exactly one person on them", rows("roofing", "instalment", "fees_tobi", "fees_kemi"),
    ref=[ans(kind="task", within="@prev", where="person count = 1")]),
  T("paid Tobi's school fees yesterday, tick it", diff(upd("fees_tobi", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay Tobi's school fees")]))

S("T26-058", "task span weeks person count list count complete within",
  T("open stuff due this week or next that nobody's linked to",
    rows("power_11", "diesel_2", "ajo_pay_11", "canopy", "cables", "db_board", "aso_ebi", "c_of_o", "inverter"),
    ref=[ans(kind="task", where='person count = 0 and status = "open"', when=span(U("week", 0), U("week", 1)))]),
  T("which of those sit in a list", rows("power_11", "diesel_2", "ajo_pay_11", "inverter"),
    ref=[ans(kind="task", within="@prev", where="list count >= 1")]),
  T("tick the electricity one, paid it last night", diff(upd("power_11", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", within="@prev", name="Pay electricity bill")]),
  T("how many tasks have i got in each status", vgroups({"open": 32, "in_progress": 3, "completed": 16, "cancelled": 2}),
    ref=[comp(op="count", kind="task", group="status"), ans(value="@prev")]))

S("T26-059", "events duration person count status in delete named",
  T("events next week that are two hours or longer", rows("medical", "parents_day", "site_1205", "mama70"),
    ref=[ans(kind="event", where="duration >= 120 minutes", when=U("week", 1))]),
  T("now only the ones with more than 3 people", rows("mama70"),
    ref=[ans(kind="event", within="@prev", where="person count > 3")]),
  T("cancelled stuff last week or this week", rows("chidi_dinner", "beach"),
    ref=[ans(kind="event", where='status in ("cancelled")', when=span(U("week", -1), U("week", 0)))]),
  T("take Beach trip to Bonny off the diary", diff(trash("beach")),
    ref=[act("delete", kind="event", name="Beach trip to Bonny")]))

S("T26-060", "events person count status in duration within",
  T("events this week with more than three people, cancelled ones too", rows("ajo_1129"),
    ref=[ans(kind="event", where='person count > 3 and status in ("tentative", "cancelled")', when=U("week", 0))]),
  T("long ones this month, three hours plus", rows("kemi_bday", "anniversary", "aisha_visit", "beach"),
    ref=[ans(kind="event", where="duration >= 180 minutes", when=U("month", 0))]),
  T("which of those got cancelled", rows("beach"),
    ref=[ans(kind="event", within="@prev", where='status = "cancelled"')]))

S("T26-061", "note anchor day pin pinned exclude",
  T("notes from two days ago", rows("socket_plan", "tobi_waec", "party_menu"),
    ref=[ans(kind="note", when=U("day", -2, anchor="today"))]),
  T("pin the party menu", diff(upd("party_menu", pinned=True)),
    ref=[act("edit", kind="note", name="Party menu", args=lines(pinned="yes"))]),
  T("what else is pinned", rows("ajo_rota", "turbine", "block_count"),
    ref=[ans(kind="note", where="pinned = yes", exclude="$party_menu")]))

S("T26-062", "note anchor week within linked",
  T("what did i write down last week",
    rows("kemi_school", "gift_ideas", "solar_biz", "guest_list", "anniv_n", "roof_quotes", "socket_plan", "tobi_waec",
         "party_menu"),
    ref=[ans(kind="note", when=U("week", -1, anchor="today"))]),
  T("which of those mention aisha", rows("guest_list", "party_menu"),
    ref=[ans(kind="note", within="@prev", linked_to="$aisha")]))

S("T26-063", "note span month to week notebook edit body",
  T("offshore log notes from october up to last week", rows("permit_n", "crane_n", "turbine", "rotation_n", "handover_n"),
    ref=[ans(kind="note", linked_to="$offshore_nb", when=span(U("month", 0, name=10), U("week", -1)))]),
  T("update the handover one, MCC fan got replaced, spare breakers in store 3",
    diff(upd("handover_n", body=has("replaced"))),
    ref=[act("edit", rows="$handover_n", args=lines(body="MCC fan replaced, spare breakers in store 3"))]))

S("T26-064", "note span month to weekday and to week notebooks",
  T("house build notes from september until last friday", rows("archi_n", "site_n"),
    ref=[ans(kind="note", linked_to="$house_nb", when=span(U("month", 0, name=9), U("week", -1, weekday=5)))]),
  T("and ajo ones from september up to last week", rows("ajo_rota", "ajo_oct"),
    ref=[ans(kind="note", linked_to="$ajo_nb", when=span(U("month", 0, name=9), U("week", -1)))]))

S("T26-065", "note span dates kids span month weekday",
  T("notes between 1 and fifteenth november", rows("turbine", "rotation_n", "handover_n", "car_n", "site_n"),
    ref=[ans(kind="note", when=span(D("2026-11-01"), D("2026-11-15")))]),
  T("kids notes from october to last sunday", rows("bisi_health", "kemi_school", "tobi_waec"),
    ref=[ans(kind="note", linked_to="$kids_nb", when=span(U("month", 0, name=10), U("week", -1, weekday=7)))]))

S("T26-066", "document span datetime weekday add_to multi undo link delete multi",
  T("docs i saved since landing on the twelfth at 2pm, up to monday",
    rows("fees_letter", "receipt_cement", "elec_drawings", "kemi_report", "mortgage_offer", "scan_a", "scan_b"),
    ref=[ans(kind="document", when=span(D("2026-11-12", "14:00"), U("week", 0, weekday=1)))]),
  T("move the two scans into bank", diff(link("bank_f", "scan_a"), link("bank_f", "scan_b")),
    ref=[act("add_to", rows="$scan_a, $scan_b", args=lines(to="$bank_f"))]),
  T("hmm undo", diff(unlink("bank_f", "scan_a"), unlink("bank_f", "scan_b")),
    ref=[act("undo")]),
  T("just delete them", diff(trash("scan_a"), trash("scan_b")),
    ref=[act("delete", rows="$scan_a, $scan_b")]))

S("T26-067", "document span datetime month add_to folder read",
  T("docs from thirtieth september 8am to the end of october", rows("payslip_sep", "medical_form", "payslip_oct"),
    ref=[ans(kind="document", when=span(D("2026-09-30", "08:00"), U("month", 0, name=10)))]),
  T("file the Offshore medical form under offshore work", diff(link("rig_f", "medical_form")),
    ref=[act("add_to", kind="document", name="Offshore medical form", args=lines(to="$rig_f"))]),
  T("what's in offshore work", rows("contract", "payslip_oct", "payslip_sep", "roster", "medical_form"),
    ref=[ans(kind="document", linked_to="$rig_f")]))

S("T26-068", "document spans datetime weekday datetime month",
  T("which docs did i add between thirteenth nov 3pm and last sunday",
    rows("fees_letter", "receipt_cement", "elec_drawings", "kemi_report", "mortgage_offer", "scan_a", "scan_b"),
    ref=[ans(kind="document", when=span(D("2026-11-13", "15:00"), U("week", -1, weekday=7)))]),
  T("and from first november 9am through november, only the ones in a folder",
    rows("statement", "roster", "fees_letter", "elec_drawings", "kemi_report", "mortgage_offer"),
    ref=[ans(kind="document", where="folder count > 0",
             when=span(D("2026-11-01", "09:00"), U("month", 0, name=11)))]))

S("T26-069", "debt open spans named month settle named",
  T("debts since september",
    rows("d_bayo", "d_funmi", "d_emeka", "d_victor", "d_chidi", "d_tunde", "d_segun", "d_garba", "d_aisha", "d_olumide"),
    ref=[ans(kind="debt", when={"from": U("month", 0, name=9)})]),
  T("and older ones, up to end of august", rows("d_ibrahim", "d_sunday", "d_kunle"),
    ref=[ans(kind="debt", when={"to": U("month", 0, name=8)})]),
  T("settle the Brake pads one, paid sunday yesterday", diff(upd("d_sunday", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Brake pads")]))

S("T26-070", "debt spans datetime date and date month",
  T("debts between twelfth nov 2pm and the twentieth", rows("d_tunde", "d_segun", "d_garba", "d_aisha"),
    ref=[ans(kind="debt", when=span(D("2026-11-12", "14:00"), D("2026-11-20")))]),
  T("and from first october to the end of last month", rows("d_funmi", "d_emeka"),
    ref=[ans(kind="debt", when=span(D("2026-10-01"), U("month", -1)))]))

S("T26-071", "debt direction open spans",
  T("what have i lent people since october", rows("d_funmi", "d_emeka", "d_chidi", "d_tunde", "d_segun", "d_garba"),
    ref=[ans(kind="debt", where='direction = "owes_me"', when={"from": U("month", 0, name=10)})]),
  T("and before september", rows("d_ibrahim"),
    ref=[ans(kind="debt", where='direction = "owes_me"', when={"to": U("month", 0, name=8)})]),
  T("smallest open one each way", vgroups({"owes_me": (15000, "NGN"), "i_owe": (35000, "NGN")}),
    ref=[comp(op="min", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]))

S("T26-072", "debt person count empty count",
  T("any debt not tied to a person", rows(),
    ref=[ans(kind="debt", where="person count = 0")]),
  T("how many have exactly one person on them", val(13),
    ref=[ans(op="count", kind="debt", where="person count = 1")]),
  T("which ones are from twelfth nov 6pm to the nineteenth", rows("d_tunde", "d_segun", "d_garba", "d_aisha"),
    ref=[ans(kind="debt", when=span(D("2026-11-12", "18:00"), D("2026-11-19")))]))

S("T26-073", "person span weekday date log named other kunle",
  T("who did i talk to between last monday and sunday", rows("kunle_b", "chidi", "segun", "olumide", "aisha"),
    ref=[ans(kind="person", when=span(U("week", -1, weekday=1), U("week", -1, weekday=7)))]),
  T("log a call with Kunle Bello, rang him about the payout", diff(upd("kunle_b", date=ANY)),
    ref=[act("log", kind="person", name="Kunle Bello", args=lines(kind="call"))]),
  T("and the other kunle, when did i last talk to him", rows("kunle_a"),
    ref=[ans(kind="person", name="Kunle Adeyemi")]),
  T("log a call with emeka too", ask("emeka_n", "emeka_o"),
    ref=[act("log", kind="person", name="Emeka", args=lines(kind="call")),
         askc("emeka nwosu or emeka obi?", options="$emeka_n, $emeka_o")]))

S("T26-074", "person span weekday date rel time open span cadence",
  T("who have i been in touch with from last tuesday up to yesterday",
    rows("kunle_b", "chidi", "segun", "olumide", "aisha", "mama", "ngozi"),
    ref=[ans(kind="person", when=span(U("week", -1, weekday=2), U("day", -1)))]),
  T("who did i call on sunday at 8pm", rows("aisha"),
    ref=[ans(kind="person", when=U("day", -2, time="20:00"))]),
  T("and since last wednesday, only people with a cadence", rows("chidi", "segun", "olumide", "aisha", "mama"),
    ref=[ans(kind="person", where="cadence is set", when={"from": U("week", -1, weekday=3)})]))

S("T26-075", "single role in",
  T("who's the rig medic and the hse officer again", rows("victor", "kunle_a"),
    ref=[ans(kind="person", where='role in ("rig medic", "HSE officer")')]))
