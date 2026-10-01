from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T23-026", "person week span cadence unit log",
  T("everyone i was in touch with last week", rows("anvar", "ravshan", "oybek", "zarina", "dilnoza", "nigora", "bekzod", "dilbar",
                                        "malika_t", "aziz"),
    ref=[ans(kind="person", when=U("week", -1))]),
  T("and from last week up to tuesday", rows("anvar", "ravshan", "oybek", "zarina", "dilnoza", "nigora", "bekzod",
                                             "dilbar", "malika_t", "aziz", "farrukh", "farida", "gulnora", "rustam",
                                             "malika_y", "sardor_p", "kamola"),
    ref=[ans(kind="person", when=span(U("week", -1), U("week", 0, weekday=2)))]),
  T("of those who's on a monthly or rarer cadence", rows("ravshan", "oybek", "malika_t"),
    ref=[ans(kind="person", within="@prev", where="cadence > 14 days")]),
  T("log a call with oybek, he rang about the crowns", diff(upd("oybek", date=ANY)),
    ref=[act("log", rows="$oybek", args=lines(kind="call"))]))

S("T23-027", "person span weekday refused weeks repair star",
  T("who did i see from two weeks ago to last friday", rows("shakhnoza", "javlon", "anvar", "ravshan", "oybek",
                                                            "zarina", "dilnoza", "nigora", "bekzod"),
    ref=[ans(kind="person", when=span(U("week", -2), U("week", -1, weekday=5)))]),
  T("which of them am i supposed to catch up with every two weeks or more often",
    rows("shakhnoza", "javlon", "zarina", "dilnoza", "bekzod"),
    ref=[bad(ans(kind="person", within="@prev", where="cadence <= 2 weeks")),
         ans(kind="person", within="@prev", where="cadence <= 14 days")]),
  T("star Dilnoza Ahmedova", diff(upd("dilnoza", starred=True)),
    ref=[act("star", rows="$dilnoza")]))

S("T23-028", "event span date named month person count",
  T("what's on from aug twentieth through september", rows("ortho_samir", "housewarming", "fitting_2", "dacha_weekend",
                                                  "plov_0823", "staff_0824", "study_club", "parents_kg", "plov_0830",
                                                  "staff_0831", "school_start", "parents_school", "samarkand_trip",
                                                  "congress", "wedding", "swim_0822", "swim_0829"),
    ref=[ans(kind="event", when=span(D("2026-08-20"), U("month", 0, name=9)))]),
  T("leave out the ones with exactly one person on them", rows("ortho_samir", "plov_0823", "staff_0824", "study_club",
                                                               "plov_0830", "staff_0831", "school_start",
                                                               "parents_school", "samarkand_trip", "congress",
                                                               "wedding"),
    ref=[ans(kind="event", within="@prev", where="person count != 1")]))

S("T23-029", "event span name weekday duration attendees reschedule",
  T("anything longer than two hours from the start of august to next friday",
    rows("plov_0802", "plov_0809", "team_dinner"),
    ref=[ans(kind="event", when=span(U("month", 0, name=8), U("week", 1, weekday=5)), where="duration > 120")]),
  T("who's coming to the team dinner", rows("farrukh", "gulnora", "malika_y", "shakhnoza", "bekzod"),
    ref=[ans(kind="person", linked_to="$team_dinner")]),
  T("move it to 7:30, farrukh has a late patient", diff(upd("team_dinner", date="2026-08-14T19:30")),
    ref=[act("reschedule", rows="$team_dinner", args=lines(to=D("2026-08-14", "19:30")))]))

S("T23-030", "event open span datetime count rows",
  T("how many staff meetings were there up to twentieth july 9am", val(3),
    ref=[ans(op="count", kind="event", name="Staff meeting", when={"to": D("2026-07-20", "09:00")})]),
  T("and which plov sundays were before twenty-first june 2pm", rows("plov_0607", "plov_0614", "plov_0621"),
    ref=[ans(kind="event", name="Sunday plov", when={"to": D("2026-06-21", "14:00")})]),
  T("how many swimming sessions has samir had up to eighteenth july 10am", val(3),
    ref=[ans(op="count", kind="event", name="Samir swimming", when={"to": D("2026-07-18", "10:00")})]))

S("T23-031", "task open span datetime edit priority literal",
  T("wedding list stuff due from the twentieth 9am onwards", rows("gift", "toast", "collect", "dress"),
    ref=[ans(kind="task", linked_to="$wedding_l", when={"from": D("2026-08-20", "09:00")})]),
  T("Collect gift fund money, make it priority one", diff(upd("collect", priority=1)),
    ref=[act("edit", rows="$collect", args=lines(priority=1))]),
  T("what's priority two or higher on that list", rows("gift", "collect"),
    ref=[ans(kind="task", linked_to="$wedding_l", where="priority <= 2")]))

S("T23-032", "task span rel rel task count",
  T("kids list, what's due from today to the end of next week", rows("party", "kg_forms"),
    ref=[ans(kind="task", linked_to="$kids_l", when=span(U("day", 0), U("week", 1)))]),
  T("and which kids list tasks have no subtasks at all", rows("swim_fee", "kg_forms", "uniform"),
    ref=[ans(kind="task", linked_to="$kids_l", where="task count <= 0")]),
  T("anything on no list at all due between today and end of next week",
    rows("gasket", "call_javlon", "invites", "cake", "steril_log", "balloons", "waste", "course_fee"),
    ref=[ans(kind="task", where="list count < 1", when=span(U("day", 0), U("week", 1)))]),
  T("Order composite resin, push it to monday", diff(upd("resin", date="2026-08-10")),
    ref=[act("reschedule", kind="task", name="Order composite resin", args=lines(to=U("week", 1, weekday=1))),
         act("reschedule", rows="$resin", args=lines(to=U("week", 1, weekday=1)))]))

S("T23-033", "single note weekday time",
  T("the note i wrote last friday at 9pm", rows("insp_list"),
    ref=[ans(kind="note", when=W(U("week", -1, weekday=5, time="21:00")))]))

S("T23-034", "note named month notebook count add_to",
  T("notes from july", rows("istanbul_hotels", "guests", "lagman", "gift_ideas", "bek_notes", "tax_docs", "prices",
                            "school_list", "insp_list", "july_thoughts"),
    ref=[ans(kind="note", when=U("month", 0, name=7))]),
  T("which of those aren't in a notebook", rows("istanbul_hotels", "tax_docs"),
    ref=[ans(kind="note", within="@prev", where="notebook count < 1")]),
  T("put the istanbul one in Clinic", diff(link("clinic_nb", "istanbul_hotels")),
    ref=[act("add_to", rows="$istanbul_hotels", args=lines(to="$clinic_nb"))]))

S("T23-035", "note since monday delete named",
  T("notes since monday", rows("autoclave_n", "car_noise"),
    ref=[ans(kind="note", when={"from": U("week", 0, weekday=1)})]),
  T("delete Car noises, the garage sorted it", diff(trash("car_noise")),
    ref=[act("delete", rows="$car_noise")]))

S("T23-036", "four turns document datetime spans star starred read",
  T("docs from first july 9am to the twentieth", rows("course_invite", "scan_a", "scan_b", "laylo_card", "hall_contract"),
    ref=[ans(kind="document", when=span(D("2026-07-01", "09:00"), D("2026-07-20")))]),
  T("and from nineteenth july noon till twenty-eighth july 12:30", rows("hall_contract", "catering", "income", "invoice"),
    ref=[ans(kind="document", when=span(D("2026-07-19", "12:00"), D("2026-07-28", "12:30")))]),
  T("star the catering quote", diff(upd("catering", starred=True)),
    ref=[act("star", rows="$catering")]),
  T("so what's starred in docs", rows("lease", "flat_cert", "hall_contract", "catering"),
    ref=[ans(kind="document", where="starred = yes")]))

S("T23-037", "document open span weekday delete named",
  T("stuff in clinic papers from before last friday", rows("lease", "waste_doc", "insp_report", "xray_doc", "invoice"),
    ref=[ans(kind="document", linked_to="$clinic_f", when={"to": U("week", -1, weekday=5)})]),
  T("delete Inspection report 2025, this year's replaces it", diff(trash("insp_report")),
    ref=[act("delete", kind="document", name="Inspection report 2025")]))

S("T23-038", "photo date star add_to",
  T("photos from eighteenth july", rows("p_garden", "p_park", "p_sunset"),
    ref=[find(kind="photo", when=D("2026-07-18")), ans(rows="@prev")]),
  T("the one of oyijon, star it", diff(upd("p_garden", starred=True)),
    ref=[act("star", rows="$p_garden")]),
  T("and the sunset one goes in family", diff(link("family_a", "p_sunset")),
    ref=[act("add_to", rows="$p_sunset", args=lines(to="$family_a"))]))

S("T23-039", "photo span weekday datetime delete prev",
  T("pics from last saturday till sunday 6pm", rows("p_chorsu", "p_receipt", "p_pool", "p_table"),
    ref=[find(kind="photo", when=span(U("week", -1, weekday=6), D("2026-08-02", "18:00"))), ans(rows="@prev")]),
  T("delete the receipt one", diff(trash("p_receipt")),
    ref=[act("delete", rows="$p_receipt")]))

S("T23-040", "photo spans albums person count",
  T("family album pics from last week to the end of august", rows("p_anniv", "p_chorsu", "p_melons"),
    ref=[ans(kind="photo", linked_to="$family_a", when=span(U("week", -1), U("month", 0, name=8)))]),
  T("and kids album from three weeks ago through july", rows("p_brave", "p_park"),
    ref=[ans(kind="photo", linked_to="$kids_a", when=span(U("week", -3), U("month", 0, name=7)))]),
  T("how many photos have two or more people in them", val(7),
    ref=[ans(op="count", kind="photo", where="person count >= 2")]))

S("T23-041", "debt anchor time settle_debt undo ledger",
  T("which debt did i put in two days ago around 1pm", rows("d_aziz"),
    ref=[ans(kind="debt", when=W(U("day", -2, anchor="today", time="13:00")))]),
  T("aziz paid me, settle it", diff(upd("d_aziz", status="settled")),
    ref=[act("settle_debt", rows="$d_aziz")]),
  T("undo that, he only sent half", diff(),
    ref=[act("undo")]))

S("T23-042", "debt span date weekday within sum",
  T("debts from july first to last wednesday", rows("d_bekzod", "d_otabek", "d_malika_t", "d_javlon", "d_gulnora"),
    ref=[ans(kind="debt", when=span(D("2026-07-01"), U("week", -1, weekday=3)))]),
  T("the ones i owe", rows("d_javlon", "d_gulnora"),
    ref=[ans(kind="debt", within="@prev", where='direction = "i_owe"')]),
  T("total?", val((1580000, "UZS")),
    ref=[ans(op="sum", field="amount", rows="@prev")]))

S("T23-043", "debt span month week open span datetime",
  T("debts from june up to last week", rows("d_shahlo", "d_kamola", "d_ravshan", "d_bekzod", "d_otabek", "d_malika_t",
                                            "d_javlon", "d_gulnora", "d_nigora", "d_zarina"),
    ref=[ans(kind="debt", when=span(U("month", 0, name=6), U("week", -1)))]),
  T("and anything before tenth july 6pm", rows("d_anvar", "d_shahlo", "d_kamola", "d_ravshan", "d_bekzod"),
    ref=[ans(kind="debt", when={"to": D("2026-07-10", "18:00")})]))

S("T23-044", "event overlap refused ask create read",
  T("book a heart checkup for oyijon tuesday at 10", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Heart checkup for Oyijon",
                                      date=U("week", 1, weekday=2, time="10:00")))),
         askc("tuesday 10 clashes with her cardiologist appointment. is that the same thing, or another time?")]),
  T("different doctor, make it 11", diff(new("event", name=has("Oyijon"), date="2026-08-11T11:00")),
    ref=[act("create", args=lines(kind="event", name="Heart checkup for Oyijon",
                                  date=U("week", 1, weekday=2, time="11:00")))]),
  T("what's on tuesday now", rows("cardio", "+1"),
    ref=[ans(kind="event", when=U("week", 1, weekday=2))]),
  T("and move the call with javlon to 9pm", ask("javlon_call_1", "javlon_call_2"),
    ref=[act("reschedule", kind="event", name="Call with Javlon", args=lines(to=D("2026-08-09", "21:00"))),
         askc("there are two calls with javlon in the calendar, 26 july and this sunday the 9th. which one?",
              options="$javlon_call_1, $javlon_call_2")]))

S("T23-045", "gift fund members refused remove_from settle_up",
  T("who's in the kamola wedding gift group", rows("aziz", "sardor_c", "zarina", "malika_t", "farida", "me"),
    ref=[ans(kind="person", linked_to="$gift_fund")]),
  T("take sardor out, he says he's not chipping in", ask(),
    ref=[bad(act("remove_from", rows="$sardor_c", args=lines(from_="$gift_fund"))),
         askc("sardor still owes his share of the earrings deposit, so he can't leave the group yet. settle up with him first?")]),
  T("yeah settle him", diff(settle=["Sardor Nazarov"]),
    ref=[act("settle_up", rows="$sardor_c", args=lines(group="$gift_fund"))]))

S("T23-046", "empty result album ask create",
  T("show me the samarkand album", ask(),
    ref=[ans(kind="album", name="Samarkand"),
         askc("there's no samarkand album, only the samarkand weekend event and group. want me to make one?")]),
  T("yes make it", diff(new("album", name="Samarkand")),
    ref=[act("create", args=lines(kind="album", name="Samarkand"))]),
  T("hmm undo, i'll make it after the trip", diff(gone("+1")),
    ref=[act("undo")]))

S("T23-047", "create document edit add_to knock-on",
  T("save a doc Hall seating plan", diff(new("document", name="Hall seating plan")),
    ref=[act("create", args=lines(kind="document", name="Hall seating plan"))]),
  T("rename it Seating plan v1 and file it under wedding",
    diff(upd("+1", name="Seating plan v1"), link("wedding_f", "+1")),
    ref=[act("edit", rows="$c1", args=lines(name="Seating plan v1"), more=True),
         act("add_to", rows="$c1", args=lines(to="$wedding_f"))]))

S("T23-048", "list linked_to all task count",
  T("Buy devzira rice and Buy lamb for plov, which list are those on", rows("shop_l"),
    ref=[ans(kind="list", linked_to="$rice, $lamb")]),
  T("which lists have more than four things on them", rows("clinic_l", "home_l", "kids_l", "wedding_l"),
    ref=[ans(kind="list", where="task count > 4")]))

S("T23-049", "add_to task list undo link",
  T("put Order gloves on the shopping list", diff(unlink("clinic_l", "gloves"), link("shop_l", "gloves")),
    ref=[act("add_to", kind="task", name="Order gloves", args=lines(to="$shop_l"))]),
  T("undo, farrukh orders those", diff(link("clinic_l", "gloves"), unlink("shop_l", "gloves")),
    ref=[act("undo")]))

S("T23-050", "six turns sunday plov group balances compute balance min",
  T("who's in sunday plov", rows("aziz", "kamola", "sardor_c", "zarina", "malika_t", "rustam", "me"),
    ref=[ans(kind="person", linked_to="$plov")]),
  T("where do i stand with zarina", val((530000, "UZS")),
    ref=[comp(op="balance", rows="$zarina"), ans(value="@prev")]),
  T("and with aziz", val((870000, "UZS")),
    ref=[comp(op="balance", rows="$aziz"), ans(value="@prev")]),
  T("smallest open debt each way", vgroups({"owes_me": (60000, "UZS"), "i_owe": (80000, "UZS")}),
    ref=[comp(op="min", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]),
  T("whose is the 60k one", rows("d_nigora"),
    ref=[ans(kind="debt", where='status = "open" and amount = 60000')]),
  T("plov people with no notes about them", rows("rustam", "malika_t", "me", "sardor_c"),
    ref=[ans(kind="person", linked_to="$plov", where="note count < 1")]))
