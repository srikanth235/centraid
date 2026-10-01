from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T23-076", "single plov nickname is set",
  T("which of the plov lot have a nickname saved", rows("rustam", "kamola"),
    ref=[ans(kind="person", linked_to="$plov", where="nickname is set")]))

S("T23-077", "four turns cadence unit log misspelling recovery search",
  T("people i only need to check on monthly or less", rows("islom", "sardor_c", "ravshan", "oybek", "malika_t"),
    ref=[ans(kind="person", where="cadence > 14 days")]),
  T("when did i last see islom", rows("islom"),
    ref=[ans(kind="person", name="Islom")]),
  T("log a coffee with him, we met at the expo", diff(upd("islom", date=ANY)),
    ref=[act("log", rows="$islom", args=lines(kind="coffee"))]),
  T("and a call with farukh", diff(upd("farrukh", date=ANY)),
    ref=[act("log", kind="person", name="Farukh", args=lines(kind="call")), search("Farukh", kind="person"),
         act("log", rows="$farrukh", args=lines(kind="call"))]),
  T("move the Oyijon cardiologist appointment to 11", diff(upd("cardio", date="2026-08-11T11:00")),
    ref=[act("reschedule", kind="event", name="Oyijon cardiologist", args=lines(to=D("2026-08-11", "11:00"))),
         act("reschedule", rows="$cardio", args=lines(to=D("2026-08-11", "11:00")))]))

S("T23-078", "five turns group person count group count note count balance nickname recovery",
  T("groups with five or more people", rows("plov", "gift_fund", "lunch_fund"),
    ref=[ans(kind="group", where="person count >= 5")]),
  T("who's in two or more groups apart from the cousins", rows("bekzod", "rustam", "me"),
    ref=[ans(kind="person", where='group count >= 2 and role != "cousin"')]),
  T("which of them has nothing written about them in notes", rows("rustam", "me"),
    ref=[ans(kind="person", within="@prev", where="note count < 1")]),
  T("am i square with rustam", val((0, "UZS")),
    ref=[ans(op="balance", rows="$rustam")]),
  T("log a visit with Rus, he came by the clinic", diff(upd("rustam", date=ANY)),
    ref=[act("log", kind="person", name="Rus", args=lines(kind="visit")), search("Rus", kind="person"),
         act("log", rows="$rustam", args=lines(kind="visit"))]))

S("T23-079", "four turns task list count priority effort unit add_to list read",
  T("open tasks that aren't on any list, priority two or higher", rows("course_fee", "tax", "car_ins", "visa"),
    ref=[ans(kind="task", where='list count < 1 and priority <= 2 and status = "open"')]),
  T("which of those take less than an hour", rows("course_fee", "car_ins", "visa"),
    ref=[ans(kind="task", within="@prev", where="effort < 60 min")]),
  T("put Renew car insurance on the Home list", diff(link("home_l", "car_ins")),
    ref=[act("add_to", rows="$car_ins", args=lines(to="$home_l"))]),
  T("what's open on home", rows("gas", "aircon", "pills", "elec_08", "car_ins"),
    ref=[ans(kind="task", linked_to="$home_l", where='status = "open"')]))

S("T23-080", "clinic list task count subtasks complete",
  T("clinic list tasks with no subtasks that are open", rows("resin", "recalls", "bek_review", "gloves", "rota",
                                                                  "xray_lic"),
    ref=[ans(kind="task", linked_to="$clinic_l", where='task count <= 0 and status = "open"')]),
  T("subtasks under Prepare for clinic inspection", rows("steril_log", "waste", "extinguishers"),
    ref=[ans(kind="task", linked_to="$insp_prep")]),
  T("Check fire extinguishers is done, gulnora did it. what's left under it",
    rows("steril_log", "waste", also=diff(upd("extinguishers", status="completed", completed=ANY))),
    ref=[act("complete", rows="$extinguishers", more=True),
         ans(kind="task", linked_to="$insp_prep", where='status = "open"')]))

S("T23-081", "four turns parent meeting ambiguous ask reschedule attendees",
  T("when's the parent meeting", rows("parents_kg", "parents_school"),
    ref=[ans(kind="event", name="Parent meeting")]),
  T("move it to 6pm", ask("parents_kg", "parents_school"),
    ref=[act("reschedule", kind="event", name="Parent meeting", args=lines(to=D("2026-08-28", "18:00"))),
         askc("which one, laylo's kindergarten on the 28th or samir's school on 4 september?",
              options="$parents_kg, $parents_school")]),
  T("the kindergarten one", diff(upd("parents_kg", date="2026-08-28T18:00")),
    ref=[act("reschedule", rows="$parents_kg", args=lines(to=D("2026-08-28", "18:00")))]),
  T("who's on it", rows("lola"),
    ref=[ans(kind="person", linked_to="$parents_kg")]))

S("T23-082", "five turns note span month date notebook count weekday time edit pin",
  T("notes from may up to june twentieth", rows("chuchvara", "aziz_plov", "meds", "feedback"),
    ref=[ans(kind="note", when=span(U("month", 0, name=5), D("2026-06-20")))]),
  T("which of those are in a notebook", rows("chuchvara", "aziz_plov", "feedback"),
    ref=[ans(kind="note", within="@prev", where="notebook count >= 1")]),
  T("and the note from monday 10:15pm", rows("autoclave_n"),
    ref=[ans(kind="note", when=W(U("week", 0, weekday=1, time="22:15")))]),
  T("add that the new gasket is ordered", diff(upd("autoclave_n", body=has("gasket"))),
    ref=[act("edit", rows="$autoclave_n",
             args=lines(body="cycle 134 degrees, pressure dropping on cycle 3. new gasket ordered"))]),
  T("pin it", diff(upd("autoclave_n", pinned=True)),
    ref=[act("edit", rows="$autoclave_n", args=lines(pinned="yes"))]))

S("T23-083", "four turns notes since monday june delete count",
  T("anything i jotted down since monday", rows("autoclave_n", "car_noise"),
    ref=[ans(kind="note", when={"from": U("week", 0, weekday=1)})]),
  T("and in june", rows("aziz_plov", "meds", "feedback", "kg_contacts", "june_thoughts"),
    ref=[ans(kind="note", when=U("month", 0, name=6))]),
  T("delete June thoughts", diff(trash("june_thoughts")),
    ref=[act("delete", rows="$june_thoughts")]),
  T("how many left in the journal", val(1),
    ref=[ans(op="count", kind="note", linked_to="$journal_nb")]))

S("T23-084", "four turns document datetime spans delete multi within folder",
  T("what did i save between first july ninth in the morning and twentieth july", rows("course_invite", "scan_a", "scan_b",
                                                                        "laylo_card", "hall_contract"),
    ref=[ans(kind="document", when=span(D("2026-07-01", "09:00"), D("2026-07-20")))]),
  T("the two scans are blank, delete both", diff(trash("scan_a"), trash("scan_b")),
    ref=[act("delete", rows="$scan_a, $scan_b")]),
  T("docs from nineteenth july 12:00 to twenty-eighth july 12:30", rows("hall_contract", "catering", "income", "invoice"),
    ref=[ans(kind="document", when=span(D("2026-07-19", "12:00"), D("2026-07-28", "12:30")))]),
  T("which of those are in the wedding folder", rows("hall_contract", "catering"),
    ref=[ans(kind="document", within="@prev", linked_to="$wedding_f")]))

S("T23-085", "document before weekday folder count counts",
  T("taxes folder stuff from before last friday", rows("tax_2025", "income"),
    ref=[ans(kind="document", linked_to="$tax_f", when={"to": U("week", -1, weekday=5)})]),
  T("how many docs are filed in some folder", val(13),
    ref=[ans(op="count", kind="document", where="folder count != 0")]),
  T("and how many aren't", val(4),
    ref=[ans(op="count", kind="document", where="folder count = 0")]))

S("T23-086", "five turns photo date spans star",
  T("any photos taken on july eighteenth", rows("p_garden", "p_park", "p_sunset"),
    ref=[ans(kind="photo", when=D("2026-07-18"))]),
  T("and from saturday last week up to sunday 6 in the evening", rows("p_chorsu", "p_receipt", "p_pool", "p_table"),
    ref=[ans(kind="photo", when=span(U("week", -1, weekday=6), D("2026-08-02", "18:00")))]),
  T("kids album from three weeks ago to the end of july", rows("p_brave", "p_park"),
    ref=[ans(kind="photo", linked_to="$kids_a", when=span(U("week", -3), U("month", 0, name=7)))]),
  T("family album, last week through august", rows("p_anniv", "p_chorsu", "p_melons"),
    ref=[ans(kind="photo", linked_to="$family_a", when=span(U("week", -1), U("month", 0, name=8)))]),
  T("star Anniversary dinner", diff(upd("p_anniv", starred=True)),
    ref=[act("star", rows="$p_anniv")]))

S("T23-087", "five turns debt anchor time settle spans",
  T("the debt from yesterday evening, 6ish", rows("d_sardor_p"),
    ref=[ans(kind="debt", when=W(U("day", -1, anchor="today", time="18:00")))]),
  T("paid sardor this morning, settle it", diff(upd("d_sardor_p", status="settled")),
    ref=[act("settle_debt", rows="$d_sardor_p")]),
  T("debts from the first of july through last wednesday", rows("d_bekzod", "d_otabek", "d_malika_t", "d_javlon",
                                                              "d_gulnora"),
    ref=[ans(kind="debt", when=span(D("2026-07-01"), U("week", -1, weekday=3)))]),
  T("and june up to last week", rows("d_shahlo", "d_kamola", "d_ravshan", "d_bekzod", "d_otabek", "d_malika_t",
                                     "d_javlon", "d_gulnora", "d_nigora", "d_zarina"),
    ref=[ans(kind="debt", when=span(U("month", 0, name=6), U("week", -1)))]),
  T("anything older than tenth july 6pm", rows("d_anvar", "d_shahlo", "d_kamola", "d_ravshan", "d_bekzod"),
    ref=[ans(kind="debt", when={"to": D("2026-07-10", "18:00")})]))

S("T23-088", "four turns debt amount status in person count sum settle",
  T("open debts people owe me, apart from the 500k ones", rows("d_shahlo", "d_malika_t", "d_nigora", "d_aziz"),
    ref=[ans(kind="debt", where='status in ("open") and direction = "owes_me" and amount != 500000')]),
  T("what do they add up to", val((760000, "UZS")),
    ref=[ans(op="sum", field="amount", rows="@prev")]),
  T("nigora gave me the 60k, settle Bread and milk", diff(upd("d_nigora", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Bread and milk")]),
  T("which settled ones have a person on them", rows("d_ravshan", "d_anvar", "d_nigora"),
    ref=[ans(kind="debt", where='person count >= 1 and status = "settled"')]))

S("T23-089", "locker notes contains reveal wifi reveal note",
  T("anything in the locker mentioning clinic", rows("backup", "crm", "assoc", "imaging", "sms_api"),
    ref=[ans(kind="locker item", where='notes contains "clinic"')]),
  T("what's the clinic wifi password", diff(reveal=[("clinic_wifi", "smile2026")]),
    ref=[act("reveal", kind="locker item", name="Clinic wifi", args=lines(field="password"))]),
  T("and the safe code", diff(reveal=[("safe", "4-8-1-6")]),
    ref=[act("reveal", kind="locker item", name="Clinic safe", args=lines(field="content"))]))

S("T23-090", "four turns notebook note count list task count linked_to all lists",
  T("notebooks with notes in them", rows("clinic_nb", "journal_nb", "kids_nb", "recipes_nb", "wedding_nb"),
    ref=[ans(kind="notebook", where="note count != 0")]),
  T("and lists with more than four tasks", rows("clinic_l", "home_l", "kids_l", "wedding_l"),
    ref=[ans(kind="list", where="task count > 4")]),
  T("Buy school supplies and Buy Samir's school uniform, same list?", rows("kids_l"),
    ref=[ans(kind="list", linked_to="$supplies, $uniform")]),
  T("what about Pay gas bill and Order gloves", rows(),
    ref=[ans(kind="list", linked_to="$gas, $gloves")]))

S("T23-091", "empty result album ask never_mind",
  T("open the chorsu album", ask(),
    ref=[ans(kind="album", name="Chorsu"),
         askc("there's no chorsu album. there is a photo called Chorsu spices in Family, want that one?")]),
  T("nah never mind", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T23-092", "four turns malika ambiguous refused remove_from settle_up refused ask never_mind",
  T("take malika out of sunday plov", ask(),
    ref=[act("remove_from", kind="person", name="Malika", args=lines(from_="$plov")),
         bad(act("remove_from", rows="$malika_t", args=lines(from_="$plov"))),
         askc("malika tosheva still owes her share of the lamb and rice, so she can't leave yet. settle up with her first?")]),
  T("yes settle up", diff(settle=["Malika Tosheva"]),
    ref=[act("settle_up", rows="$malika_t", args=lines(group="$plov"))]),
  T("ok now take her out", ask(),
    ref=[bad(act("remove_from", rows="$malika_t", args=lines(from_="$plov"))),
         askc("still refused: she owes sardor for the kazan repair, and that's between the two of them. leave her in for now?")]),
  T("fine leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T23-093", "four turns loose docs edit add_to knock-on folder read star",
  T("which docs are loose, not in any folder", rows("course_invite", "car_policy", "scan_a", "scan_b"),
    ref=[ans(kind="document", where="folder count = 0")]),
  T("rename Istanbul course invitation to Istanbul course letter and put it in clinic papers",
    diff(upd("course_invite", name="Istanbul course letter"), link("clinic_f", "course_invite")),
    ref=[act("edit", rows="$course_invite", args=lines(name="Istanbul course letter"), more=True),
         act("add_to", rows="$course_invite", args=lines(to="$clinic_f"))]),
  T("what's in clinic papers", rows("xray_doc", "lease", "waste_doc", "insp_report", "invoice", "course_invite"),
    ref=[ans(kind="document", linked_to="$clinic_f")]),
  T("star the clinic lease while you are at it", diff(already=["lease"]),
    ref=[act("star", rows="$lease"), ans(rows="$lease")]))

S("T23-094", "five turns groups refused delete group delete undo",
  T("which groups have three or more members", rows("plov", "gift_fund", "lunch_fund", "istanbul", "samarkand_g"),
    ref=[ans(kind="group", where="person count >= 3")]),
  T("delete sunday plov, we track it in whatsapp", ask(),
    ref=[bad(act("delete", rows="$plov")),
         askc("sunday plov still has expenses (lamb and rice, watermelons, the kazan repair), so it can't be deleted. settle everyone up first?")]),
  T("no leave it then. delete the Samarkand weekend group instead, we'll pay cash",
    diff(gone("samarkand_g"), unlink("samarkand_g", "rustam"), unlink("samarkand_g", "dilbar"),
         unlink("samarkand_g", "me")),
    ref=[act("delete", kind="group", name="Samarkand weekend")]),
  T("undo that", diff(),
    ref=[act("undo")]),
  T("ok what groups do i have left", rows("plov", "gift_fund", "lunch_fund", "istanbul", "umrah"),
    ref=[ans(kind="group")]))

S("T23-095", "seven turns saturday plan reschedule create nickname recovery balance cancel",
  T("what's on saturday", rows("swim_0808", "coffee_shahlo", "fitting_1"),
    ref=[ans(kind="event", when=U("week", 0, weekday=6))]),
  T("who's the coffee with", rows("shahlo"),
    ref=[ans(kind="person", linked_to="$coffee_shahlo")]),
  T("move it to sunday 11", diff(upd("coffee_shahlo", date="2026-08-09T11:00")),
    ref=[act("reschedule", rows="$coffee_shahlo", args=lines(to=U("week", 0, weekday=7, time="11:00")))]),
  T("put lunch with kami on saturday at 1", diff(new("event", name=has("Kami"), date="2026-08-08T13:00")),
    ref=[act("create", args=lines(kind="event", name="Lunch with Kami", date=U("week", 0, weekday=6, time="13:00")))]),
  T("remind me who kami is", rows("kamola"),
    ref=[ans(kind="person", name="Kami"), search("Kami", kind="person"), ans(rows="$kamola")]),
  T("how do we stand money wise", val((-200000, "UZS")),
    ref=[ans(op="balance", rows="$kamola")]),
  T("cancel the saturday lunch actually, she's busy with the atelier", diff(upd("+1", status="cancelled")),
    ref=[act("cancel", rows="$c1")]))

S("T23-096", "five turns home effort unit complete ambiguous electricity undo",
  T("home list jobs under twenty minutes", rows("pills", "gas", "elec_08"),
    ref=[ans(kind="task", linked_to="$home_l", where="effort < 20 min")]),
  T("Refill Oyijon's heart pills, done", diff(upd("pills", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pills")]),
  T("and Pay electricity, paid it on click", diff(upd("elec_08", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay electricity"),
         act("complete", rows="$elec_08")]),
  T("undo that one, the payment bounced", diff(upd("elec_08", status="open", completed=None)),
    ref=[act("undo")]),
  T("what's open on home", rows("gas", "aircon", "elec_08"),
    ref=[ans(kind="task", linked_to="$home_l", where='status = "open"')]),
  T("clinic list, due from tomorrow till the end of next week", rows("resin", "autoclave", "recalls", "bek_review",
                                                                     "gloves"),
    ref=[ans(kind="task", linked_to="$clinic_l", when=span(U("day", 1), U("week", 1)))]))

S("T23-097", "single find miss search miss decline not_found",
  T("find the dental chair invoice", decline("not_found"),
    ref=[find(kind="document", name="dental chair invoice"), search("dental chair invoice", kind="document"),
         dec("not_found")]))

S("T23-098", "single restore window refused person ask",
  T("restore Timur Valiev to my contacts", ask(),
    ref=[bad(act("restore", kind="person", name="Timur Valiev", trashed=True)),
         askc("timur valiev was deleted on 10 may, past the 30-day window, so he can't be restored. add him again as a new contact?")]))

S("T23-099", "single decline unbounded destruction",
  T("wipe every photo i have", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T23-100", "single sum open i owe",
  T("how much do i owe people right now in total", val((2300000, "UZS")),
    ref=[ans(op="sum", field="amount", kind="debt", where='status = "open" and direction = "i_owe"')]))
