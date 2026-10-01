from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T10-076", "linked_to all album count add_to undo photo span",
  T("which album has both the eid video call screenshot and yousef's kg graduation", rows("grand_album"),
    ref=[find(kind="photo", name="Yousef's KG graduation"),
         ans(kind="album", linked_to="$adha_call, $yousef_grad")]),
  T("how many pics in it", val(6),
    ref=[ans(op="count", kind="photo", linked_to="$grand_album")]),
  T("add layla's school play to eid al-adha 2026 as well", diff(link("adha_album", "layla_school")),
    ref=[act("add_to", rows="$layla_school", args=lines(to="$adha_album"))]),
  T("hm no undo that, it wasn't eid", diff(unlink("adha_album", "layla_school")),
    ref=[act("undo")]),
  T("photos from first june up to last sunday",
    rows("chess_board", "dump_receipt", "yousef_grad", "dump_meter", "blur_1", "layla_school", "mosque_tiles", "mosque_dome"),
    ref=[ans(kind="photo", when=W(span(D("2026-06-01"), U("week", -1, weekday=7))))]))

S("T10-077", "event overlap refused ask reschedule date",
  T("book coffee with tariq next tuesday at 10", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Coffee with Tariq", date=U("week", 1, weekday=2, time="10:00")))),
         askc("the ablution site visit is at 10 that morning. 11 instead?")]),
  T("fine, 11 then", diff(new("event", name="Coffee with Tariq", date="2026-06-23T11:00")),
    ref=[act("create", args=lines(kind="event", name="Coffee with Tariq", date=U("week", 1, weekday=2, time="11:00")))]),
  T("what's that tuesday look like", rows("blood_test", "site_visit", "+1", "chess_0623"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=2)))]))

S("T10-078", "task read add_to prev",
  T("when's yousef's bicycle due", rows("bike"),
    ref=[ans(kind="task", name="bicycle")]),
  T("can you add it to the home list too", diff(link("home_l", "bike")),
    ref=[act("add_to", rows="@prev", args=lines(to="$home_l"))]))

S("T10-079", "repair cadence weeks within to-date log",
  T("who am i meant to keep up with less than every two weeks", rows("abu_fadi", "jamal", "nizar", "umm_khalil"),
    ref=[bad(ans(kind="person", where="cadence > 2 weeks")),
         ans(kind="person", where="cadence > 14")]),
  T("which of them haven't i talked to since before april", rows("jamal", "nizar"),
    ref=[ans(within="@prev", when=W({"to": D("2026-03-31")}))]),
  T("rang jamal now, log it", diff(upd("jamal", date=ANY)),
    ref=[act("log", rows="$jamal", args=lines(kind="call"))]))

S("T10-080", "linked_to all album folder rename add_to",
  T("which albums have both zaid and sami in the snow and the eid video call screenshot", rows("grand_album"),
    ref=[ans(kind="album", linked_to="$zaid_sami_snow, $adha_call")]),
  T("other thing: rename the travel folder Visas and put the fide rating certificate in it",
    diff(upd("travel_f", name="Visas"), link("travel_f", "chess_rating")),
    ref=[act("edit", rows="$travel_f", args=lines(name="Visas"), more=True),
         act("add_to", rows="$chess_rating", args=lines(to="$travel_f"))]))

S("T10-081", "garden list remove_from prev task spans",
  T("anything on the garden list already on the go", rows("jasmine"),
    ref=[ans(kind="task", linked_to="$garden_l", where='status = "in_progress"')]),
  T("take that off the list, it's daily", diff(unlink("garden_l", "jasmine")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$garden_l"))]),
  T("what's due from monday to wednesday noon", rows("call_dana", "gas", "lecture_q", "fertilizer", "pair_list", "quotes"),
    ref=[ans(kind="task", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3, time="12:00"))))]),
  T("and july through august", rows("visa", "chess_fee", "license_26", "layla_gift", "water_q2", "elec_07", "bp_log", "flight", "taps", "bike", "ablution", "passport"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=7), U("month", 0, name=8))))]),
  T("what's the biggest job in july and august", val(120),
    ref=[ans(op="max", field="effort", within="@prev")]))

S("T10-082", "reveal trashed locker restore undo",
  T("laptop password?", diff(reveal=[("laptop", "Lucena-Bridge-4")]),
    ref=[act("reveal", kind="locker item", name="Laptop password", args=lines(field="password"))]),
  T("and the visa card number", diff(reveal=[("visa_card", "4532 7788 1020 3344")]),
    ref=[act("reveal", kind="locker item", name="Arab Bank Visa", args=lines(field="card_number"))]),
  T("did i delete the old hotmail login", rows("old_email"),
    ref=[ans(kind="locker item", name="Old Hotmail", trashed=True)]),
  T("put it back", diff(restore("old_email")),
    ref=[act("restore", rows="$old_email")]),
  T("no, undo. leave it in the trash", diff(trash("old_email")),
    ref=[act("undo")]))

S("T10-083", "duration named month ambiguity cardiology context",
  T("anything in may that ran over three hours", rows("adha_lunch"),
    ref=[ans(kind="event", when=W(U("month", 0, name=5)), where="duration > 180 minutes")]),
  T("who came to eid al-adha lunch at nabil's", rows("nabil", "huda", "abu_fadi"),
    ref=[ans(kind="person", linked_to="$adha_lunch")]),
  T("move the cardiology check-up to 11", diff(upd("cardio_jul", date="2026-07-15T11:00")),
    ref=[act("reschedule", kind="event", name="Cardiology check-up", args=lines(to=U("day", 0, anchor="row", time="11:00"))),
         act("reschedule", kind="event", name="Cardiology check-up", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="11:00")))]),
  T("show everything from today through the end of next week", rows("nabil_lunch_0619", "satellite", "ac_service", "call_layla_0620", "call_omar_kids", "physio_0622", "huda_visit", "lecture", "blood_test", "site_visit", "chess_0623", "dentist", "abu_fadi_coffee", "nabil_lunch_0626", "tournament", "call_yousef_0628"),
    ref=[ans(kind="event", when=W(span(U("day", 0), U("week", 1))))]))

S("T10-084", "health notebook remove_from multi note spans",
  T("what's in the health log", rows("bp_june", "knee", "meds"),
    ref=[ans(kind="note", linked_to="$health_nb")]),
  T("take the knee and the medication list notes out of it", diff(unlink("health_nb", "knee"), unlink("health_nb", "meds")),
    ref=[act("remove_from", rows="$knee, $meds", args=lines(from_="$health_nb"))]),
  T("notes i wrote from first june 9am through june", rows("knee", "gift_list", "rook_end", "tile_specs", "reminder", "bp_june", "tourney_notes", "idea"),
    ref=[ans(kind="note", when=W(span(D("2026-06-01", "09:00"), U("month", 0, name=6))))]),
  T("just since monday 8am", rows("bp_june", "tourney_notes", "idea"),
    ref=[ans(kind="note", when=W({"from": U("week", 0, weekday=1, time="08:00")}))]))

S("T10-085", "event count cadence log person span",
  T("who do i keep in touch with but have nothing in the diary with", rows("dana", "umm_khalil"),
    ref=[find(kind="person", where="event count < 1 and cadence is set"), ans(rows="@prev")]),
  T("texted dana this morning", diff(upd("dana", date=ANY)),
    ref=[act("log", rows="$dana", args=lines(kind="message"))]),
  T("who have i been in touch with since first june", rows("omar", "walid", "huda", "layla", "umm_khalil", "hasan", "ziad", "yousef", "rami", "sami_k", "tariq", "lina", "nabil", "dana"),
    ref=[ans(kind="person", when=W(span(D("2026-06-01"), U("day", 0))))]))

S("T10-086", "list area empty edit multi",
  T("any lists missing an area", rows("travel_l", "garden_l"),
    ref=[find(kind="list", where="area is empty"), ans(rows="@prev")]),
  T("call them both personal", diff(upd("travel_l", area="personal"), upd("garden_l", area="personal")),
    ref=[act("edit", rows="$travel_l, $garden_l", args=lines(area="personal"))]))

S("T10-087", "empty recovery trashed task restore window never mind",
  T("didn't i have a task to sell the mercedes", rows("mercedes"),
    ref=[ans(kind="task", name="Sell the old Mercedes"),
         ans(kind="task", name="Sell the old Mercedes", trashed=True)]),
  T("restore it please", ask(),
    ref=[bad(act("restore", rows="$mercedes")),
         askc("it's been in the bin over 30 days, so it can't be restored. want a new task for it?")]),
  T("no forget it, sold it to nabil's neighbour", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T10-088", "add_to document when docs weekday spans",
  T("the doc i added yesterday, put it in the pension folder", diff(link("pension_f", "chess_rating")),
    ref=[act("add_to", kind="document", when=W(U("day", -1)), args=lines(to="$pension_f"))]),
  T("what's in pension now", rows("pension_letter", "pension_june", "pension_may", "eng_cert", "chess_rating"),
    ref=[ans(kind="document", linked_to="$pension_f")]),
  T("docs from last month", rows("pension_may", "blood_may"),
    ref=[ans(kind="document", when=W(U("month", -1)))]),
  T("anything i added wednesday last week", rows("pension_june"),
    ref=[ans(kind="document", when=W(U("week", -1, weekday=3)))]),
  T("and since last monday", rows("pension_june", "tile_quote", "carpet_inv", "chess_rating"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=1), U("day", 0))))]))

S("T10-089", "note count people log span datetime",
  T("which of the daughters have i got no notes about", rows("lina", "maha"),
    ref=[find(kind="person", where='note count < 1 and role contains "daughter"'), ans(rows="@prev")]),
  T("log a call with lina, spoke last night", diff(upd("lina", date=ANY)),
    ref=[act("log", rows="$lina", args=lines(kind="call"))]),
  T("who've i talked to since last friday lunchtime", rows("hasan", "ziad", "yousef", "rami", "sami_k", "tariq", "nabil", "lina"),
    ref=[ans(kind="person", when=W(span(U("week", -1, weekday=5, time="12:00"), U("day", 0))))]))

S("T10-090", "album photo count delete multi",
  T("which albums have two photos or fewer", rows("dump_album", "blurry_album"),
    ref=[find(kind="album", where="photo count <= 2"), ans(rows="@prev")]),
  T("get rid of those two",
    diff(gone("dump_album"), gone("blurry_album"), unlink("dump_album", "dump_receipt"), unlink("dump_album", "dump_meter"),
         unlink("blurry_album", "blur_1"), unlink("blurry_album", "blur_2")),
    ref=[act("delete", rows="$dump_album, $blurry_album")]))

S("T10-091", "single sum owed",
  T("total of what i owe everyone", val((160, "JOD")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T10-092", "person count lte week within event spans",
  T("this weeks things with one person or fewer", rows("physio_0615", "walid_coffee", "nabil_lunch_0619", "satellite", "ac_service"),
    ref=[ans(kind="event", when=W(U("week", 0)), where="person count <= 1")]),
  T("anything from next monday to the third", rows("physio_0622", "huda_visit", "lecture", "blood_test", "site_visit", "chess_0623", "dentist", "abu_fadi_coffee", "nabil_lunch_0626", "tournament", "call_yousef_0628", "physio_0629", "contractor", "chess_0630", "airport_lina"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), D("2026-07-03"))))]),
  T("move friday lunch with nabil to 1:30", ask("nabil_lunch_0619", "nabil_lunch_0626"),
    ref=[act("reschedule", kind="event", name="Friday lunch with Nabil", args=lines(to=U("day", 0, anchor="row", time="13:30"))),
         find(kind="event", name="Friday lunch with Nabil"),
         askc("today's one or next friday?", options="$nabil_lunch_0619, $nabil_lunch_0626")]),
  T("next week's", diff(upd("nabil_lunch_0626", date="2026-06-26T13:30")),
    ref=[act("reschedule", rows="$nabil_lunch_0626", args=lines(to=U("day", 0, anchor="row", time="13:30")))]))

S("T10-093", "single priority empty chess list",
  T("which chess tasks have no priority", rows("clocks", "chess_fee", "yousef_chess", "endgames"),
    ref=[find(kind="task", linked_to="$chess_l", where="priority is empty"), ans(rows="@prev")]))

S("T10-094", "task count home open order limit spans",
  T("open home tasks with no subtasks", rows("leak", "ac", "gas", "prop_tax", "water_q2", "elec_07"),
    ref=[ans(kind="task", linked_to="$home_l", where='task count < 1 and status = "open"')]),
  T("which is due first", rows("leak"),
    ref=[ans(within="@prev", order="date asc", limit=1)]),
  T("tasks due from june first to the end of this week", rows("elec_06", "receipts", "leak", "sat_task", "ac", "pills"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=6), U("week", 0))))]),
  T("and from july to end of september", rows("visa", "chess_fee", "license_26", "layla_gift", "water_q2", "elec_07", "bp_log", "flight", "taps", "bike", "ablution", "passport"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=7), U("month", 0, name=9))))]))

S("T10-095", "find note body literal add_to notes span",
  T("find the note that says chess class for kids at the mosque", rows("idea"),
    ref=[find(kind="note", where='body = "chess class for kids at the mosque"'), ans(rows="@prev")]),
  T("put it in mosque fund", diff(link("mosque_nb", "idea")),
    ref=[act("add_to", rows="$idea", args=lines(to="$mosque_nb"))]),
  T("notes from tenth june 6pm to the end of june", rows("tile_specs", "reminder", "bp_june", "tourney_notes", "idea"),
    ref=[ans(kind="note", when=W(span(D("2026-06-10", "18:00"), U("month", 0, name=6))))]),
  T("and from first may noon onwards", rows("italian", "grandkids_sizes", "fund_may", "knee", "gift_list", "rook_end", "tile_specs", "reminder", "bp_june", "tourney_notes", "idea"),
    ref=[ans(kind="note", when=W({"from": D("2026-05-01", "12:00")}))]))

S("T10-096", "single photo datetime date",
  T("photos from eid al-adha morning, twenty-seventh may from 7am", rows("adha_family", "adha_lamb", "adha_lunch_p", "adha_call"),
    ref=[ans(kind="photo", when=W(span(D("2026-05-27", "07:00"), D("2026-05-27"))))]))

S("T10-097", "six turns debts date spans settle sum balance",
  T("debts from the start of last month up to the fifteenth at noon", rows("d_mounir", "d_huda", "d_nabil", "d_walid", "d_khaled_s", "d_ziad"),
    ref=[ans(kind="debt", when=W(span(U("month", -1), D("2026-06-15", "12:00"))))]),
  T("and from last monday to the eighteenth", rows("d_walid", "d_khaled_s", "d_ziad", "d_tariq", "d_umm_khalil", "d_hani"),
    ref=[ans(kind="debt", when=W(span(U("week", -1, weekday=1), D("2026-06-18"))))]),
  T("biggest of those", rows("d_walid"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]),
  T("settle walid's", diff(upd("d_walid", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$walid", where='status = "open"')]),
  T("how much do i owe", val((160, "JOD")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("and what's the balance with ziad", val((10, "JOD")),
    ref=[ans(op="balance", rows="$ziad")]))

S("T10-098", "five turns photo spans already count",
  T("pics between fifth may and last friday", rows("chess_mounir", "adha_family", "adha_lamb", "adha_lunch_p", "adha_call", "dump_receipt", "chess_board", "yousef_grad", "dump_meter", "blur_1", "layla_school"),
    ref=[ans(kind="photo", when=W(span(D("2026-05-05"), U("week", -1, weekday=5))))]),
  T("anything from before 2020", rows("umm_rami", "wedding_old"),
    ref=[ans(kind="photo", when=W({"to": D("2019-12-31")}))]),
  T("star the wedding one", diff(already=["wedding_old"]),
    ref=[act("star", rows="$wedding_old"), ans(rows="$wedding_old")]),
  T("everything up to february", rows("wedding_old", "umm_rami", "yousef_bike", "aqaba_boat", "aqaba_sea", "aqaba_fish", "chess_trophy", "layla_chess", "zaid_sami_snow"),
    ref=[ans(kind="photo", when=W({"to": U("month", 0, name=2)}))]),
  T("count those", val(9),
    ref=[ans(op="count", within="@prev")]))

S("T10-099", "five turns photo spans within star",
  T("pics taken before march", rows("wedding_old", "umm_rami", "yousef_bike", "aqaba_boat", "aqaba_sea", "aqaba_fish", "chess_trophy", "layla_chess", "zaid_sami_snow"),
    ref=[ans(kind="photo", when=W({"to": U("month", 0, name=2)}))]),
  T("just the grandkids ones", rows("yousef_bike", "layla_chess", "zaid_sami_snow"),
    ref=[ans(within="@prev", linked_to="$grand_album")]),
  T("and anything up to first jan 2025", rows("wedding_old", "umm_rami"),
    ref=[ans(kind="photo", when=W({"to": D("2025-01-01")}))]),
  T("eid al-fitr day from 1pm", rows("fitr_table", "fitr_huda"),
    ref=[ans(kind="photo", when=W(span(D("2026-03-20", "13:00"), D("2026-03-20"))))]),
  T("star the huda one", diff(upd("fitr_huda", starred=True)),
    ref=[act("star", rows="$fitr_huda")]))

S("T10-100", "notes spans pin notebook delete",
  T("notes i wrote from first june 9am to the end of june", rows("knee", "gift_list", "rook_end", "tile_specs", "reminder", "bp_june", "tourney_notes", "idea"),
    ref=[ans(kind="note", when=W(span(D("2026-06-01", "09:00"), U("month", 0, name=6))))]),
  T("only since monday 8am", rows("bp_june", "tourney_notes", "idea"),
    ref=[ans(kind="note", when=W({"from": U("week", 0, weekday=1, time="08:00")}))]),
  T("pin the tournament rules", diff(upd("tourney_notes", pinned=True)),
    ref=[act("edit", rows="$tourney_notes", args=lines(pinned="yes"))]),
  T("what's in the mosque fund notebook", rows("fund_may", "fund_donors", "tile_specs"),
    ref=[ans(kind="note", linked_to="$mosque_nb")]),
  T("delete the may summary, it's all in the ledger", diff(trash("fund_may")),
    ref=[act("delete", rows="$fund_may")]))


# ---- follow-up turns: ambiguity, recoveries, repairs, date spans, longer sessions ----

X("T10-020",
  T("cancel monday's physiotherapy session, the physio is away", diff(upd("physio_0622", status="cancelled")),
    ref=[act("cancel", kind="event", name="Physiotherapy session"),
         act("cancel", kind="event", name="Physiotherapy session", when=W(U("week", 1, weekday=1)))]),
  T("and move tiles quote back to thursday", diff(upd("quotes", date="2026-06-25")),
    ref=[act("reschedule", kind="task", name="Get three quotes for the tiles", args=lines(to=U("week", 1, weekday=4)))]))

X("T10-028",
  T("delete the july pay electricity bill task, it's on direct debit", diff(trash("elec_07")),
    ref=[act("delete", kind="task", name="Pay electricity bill"),
         act("delete", kind="task", name="Pay electricity bill", where='status = "open"')]),
  T("how many of those did i pay this year", val(6),
    ref=[ans(op="count", kind="task", name="Pay electricity bill", where='status = "completed"', when=W(U("year", 0)))]))

X("T10-029",
  T("mark renew car license done, did it this morning", diff(upd("license_26", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Renew car license"),
         act("complete", kind="task", name="Renew car license", where='status = "open"')]))

X("T10-037",
  T("log a call with khaled", ask("khaled_o", "khaled_s"),
    ref=[act("log", kind="person", name="Khaled", args=lines(kind="call")),
         askc("khaled omari or khaled sweidan the pharmacist?", options="$khaled_o, $khaled_s")]),
  T("omari", diff(upd("khaled_o", date=ANY)),
    ref=[act("log", rows="$khaled_o", args=lines(kind="call"))]))

X("T10-041",
  T("pay water bill is done, paid at the post office",
    diff(upd("water_q2", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay water bill"),
         act("complete", kind="task", name="Pay water bill", where='status = "open"')]),
  T("tick the carpet receipts one too and tell me what's left on the mosque list",
    rows("quotes", "pledges", "statement", also=diff(upd("receipts", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Scan the carpet receipts", more=True),
         ans(kind="task", linked_to="$mosque_l", where='status = "open"')]))

X("T10-045",
  T("move the video call with yousef to half 5", diff(upd("call_yousef_0628", date="2026-06-28T17:30")),
    ref=[act("reschedule", kind="event", name="Video call with Yousef", args=lines(to=U("day", 0, anchor="row", time="17:30"))),
         act("reschedule", kind="event", name="Video call with Yousef", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="17:30")))]))

X("T10-047",
  T("cancel the mosque committee meeting", ask("committee_0711", "committee_0808"),
    ref=[act("cancel", kind="event", name="Mosque committee meeting"),
         find(kind="event", name="Mosque committee meeting"),
         askc("the one on 11 july or 8 august?", options="$committee_0711, $committee_0808")]),
  T("july", diff(upd("committee_0711", status="cancelled")),
    ref=[act("cancel", rows="$committee_0711")]))

X("T10-052",
  T("find the sanad login", rows("sanad"),
    ref=[find(kind="locker item", name="Sanad"), ans(rows="@prev")]),
  T("delete the pension statement", ask("pension_june", "pension_may"),
    ref=[act("delete", kind="document", name="Pension statement"),
         askc("june's or may's?", options="$pension_june, $pension_may")]))

X("T10-062",
  T("unstar the eid photo", ask("fitr_table", "adha_call"),
    ref=[act("unstar", kind="photo", name="Eid"),
         askc("the eid table at nabil's or the eid video call screenshot?", options="$fitr_table, $adha_call")]))

X("T10-086",
  T("delete the video call with layla", ask("call_layla_0606", "call_layla_0620"),
    ref=[act("delete", kind="event", name="Video call with Layla"),
         find(kind="event", name="Video call with Layla"),
         askc("the one on 6 june or tomorrow's?", options="$call_layla_0606, $call_layla_0620")]),
  T("the old one", diff(trash("call_layla_0606")),
    ref=[act("delete", rows="$call_layla_0606")]))

X("T10-053",
  T("set up a new group", ask(),
    ref=[askc("what should it be called, and who's in it?")]),
  T("Tournament fund, with tariq and faris",
    diff(new("group", name="Tournament fund"), link("new", "me"), link("new", "tariq"), link("new", "faris")),
    ref=[act("create", more=True, args=lines(kind="group", name="Tournament fund")),
         act("add_to", rows="$tariq, $faris", args=lines(to="$new"))]))

X("T10-018",
  T("add a reminder", ask(),
    ref=[askc("sure, what for and when?")]),
  T("pay the chess club fee on the thirtieth", diff(upd("chess_fee", date="2026-06-30")),
    ref=[search("chess club fee", kind="task"),
         act("reschedule", kind="task", name="Pay club membership fee", args=lines(to=D("2026-06-30")))]))

X("T10-031",
  T("how's the mansaf recipe go", rows("mansaf"),
    ref=[ans(kind="document", name="Mansaf"), ans(kind="note", name="Mansaf")]),
  T("who haven't i talked to since before may", rows("khaled_o", "nizar", "jamal", "abu_fadi"),
    ref=[ans(kind="person", when=W({"to": D("2026-04-30")}))]))

X("T10-032",
  T("find mounier from chess", rows("mounir"),
    ref=[find(kind="person", name="Mounier"), search("Mounier", kind="person"), ans(rows="$mounir")]))

X("T10-034",
  T("when's the gas bill due", rows("gas"),
    ref=[ans(kind="task", name="gas bill"), search("gas", kind="task"), ans(rows="$gas")]))

X("T10-035",
  T("open the maqlouba note", rows("maqluba"),
    ref=[ans(kind="note", name="Maqlouba"), search("maqlouba", kind="note"), ans(rows="$maqluba")]))

X("T10-038",
  T("what's the zaytoun password", decline("not_found"),
    ref=[search("Zaytoun"), dec("not_found")]))

X("T10-042",
  T("who's walid azam", rows("walid"),
    ref=[ans(kind="person", name="Walid Azam"), search("Walid Azam", kind="person"), ans(rows="$walid")]))

X("T10-043",
  T("is the fund ledger note up to date", rows("fund_ledger"),
    ref=[ans(kind="note", name="Fund ledger"), ans(kind="document", name="Fund ledger")]))

X("T10-044",
  T("and what's in the tile specs doc", rows("tile_specs"),
    ref=[ans(kind="document", name="Tile specs"), ans(kind="note", name="Tile specs")]))

X("T10-046",
  T("any tasks called umrah", rows("umrah"),
    ref=[ans(kind="task", name="Umrah"), ans(kind="task", name="Umrah", trashed=True)]))

X("T10-054",
  T("any tasks under an hour that are in progress", rows("walk", "knee_ex", "jasmine"),
    ref=[bad(ans(kind="task", where='effort < 1 hour and status = "in_progress"')),
         ans(kind="task", where='effort < 60 and status = "in_progress"')]))

X("T10-063",
  T("move the ablution site visit to thursday next week at 11", diff(upd("site_visit", date="2026-06-25T11:00")),
    ref=[bad(act("reschedule", rows="$site_visit", args=lines(to=U("week", 1, time="11:00")))),
         act("reschedule", rows="$site_visit", args=lines(to=U("week", 1, weekday=4, time="11:00")))]),
  T("docs added since monday last week", rows("pension_june", "tile_quote", "carpet_inv", "chess_rating"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=1), U("day", 0))))]),
  T("and from the monday before that to the end of june", rows("pension_june", "tile_quote", "carpet_inv", "chess_rating"),
    ref=[ans(kind="document", when=W(span(U("week", -2, weekday=1), U("month", 0, name=6))))]))

X("T10-067",
  T("which photos is huda in", rows("fitr_table", "fitr_huda", "adha_family"),
    ref=[bad(ans(kind="photo", where='person = "Huda"')),
         ans(kind="photo", linked_to="$huda")]))

X("T10-015",
  T("who have i seen since tenth june", rows("umm_khalil", "hasan", "ziad", "yousef", "rami", "sami_k", "tariq", "lina", "nabil", "abu_fadi"),
    ref=[ans(kind="person", when=W(span(D("2026-06-10"), U("day", 0))))]))

X("T10-066",
  T("anyone i spoke to since monday 9am", rows("sami_k", "tariq", "lina", "nabil", "umm_khalil"),
    ref=[ans(kind="person", when=W(span(U("week", 0, weekday=1, time="09:00"), U("day", 0))))]))

X("T10-050",
  T("what's on between today and the end of the month", rows("nabil_lunch_0619", "satellite", "ac_service", "call_layla_0620", "call_omar_kids", "physio_0622", "huda_visit", "lecture", "blood_test", "site_visit", "chess_0623", "dentist", "abu_fadi_coffee", "nabil_lunch_0626", "tournament", "call_yousef_0628", "physio_0629", "contractor", "chess_0630"),
    ref=[ans(kind="event", when=W(span(U("day", 0), U("month", 0))))]))

X("T10-010",
  T("anything from next wednesday to the thirtieth", rows("dentist", "abu_fadi_coffee", "nabil_lunch_0626", "tournament", "call_yousef_0628", "physio_0629", "contractor", "chess_0630"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=3), D("2026-06-30"))))]))

X("T10-012",
  T("tasks due between twenty-fifth june and twenty-seventh june noon", rows("clocks", "tiles", "pairings", "pair_print", "inspection", "pledges"),
    ref=[ans(kind="task", when=W(span(D("2026-06-25"), D("2026-06-27", "12:00"))))]))

X("T10-017",
  T("docs added last month", rows("pension_may", "blood_may"),
    ref=[ans(kind="document", when=W(U("month", -1)))]),
  T("and anything this wednesday", rows("carpet_inv"),
    ref=[ans(kind="document", when=W(U("week", 0, weekday=3)))]))

X("T10-088",
  T("docs from monday two weeks back to the end of june", rows("pension_june", "tile_quote", "carpet_inv", "chess_rating"),
    ref=[ans(kind="document", when=W(span(U("week", -2, weekday=1), U("month", 0, name=6))))]))

X("T10-049",
  T("debts from last week up to wednesday 6pm", rows("d_walid", "d_khaled_s", "d_ziad", "d_tariq", "d_umm_khalil"),
    ref=[ans(kind="debt", when=W(span(U("week", -1), U("week", 0, weekday=3, time="18:00"))))]),
  T("and from this monday to today", rows("d_ziad", "d_tariq", "d_umm_khalil", "d_hani"),
    ref=[ans(kind="debt", when=W(span(U("week", 0, weekday=1), U("day", 0))))]))

X("T10-009",
  T("which debts are over 100", rows("d_rami", "d_jamal"),
    ref=[ans(kind="debt", where="amount > 100")]))

X("T10-036",
  T("any where the direction's blank", rows(),
    ref=[ans(kind="debt", where="direction is empty")]))

X("T10-080",
  T("folders holding a max of two docs", rows("car_f", "misc_f", "scans_f", "deeds_f", "travel_f"),
    ref=[ans(kind="folder", where="document count <= 2")]))

X("T10-026",
  T("what's the ablution area renovation due", rows("ablution"),
    ref=[ans(kind="task", name="Ablution area renovation")]),
  T("under that job: tick choose tiles, push order taps to first august, then show me what's open",
    rows("plumber", "taps", also=diff(upd("tiles", status="completed", completed=ANY), upd("taps", date="2026-08-01"))),
    ref=[find(kind="task", linked_to="$ablution"),
         act("complete", rows="$tiles", more=True),
         act("reschedule", rows="$taps", args=lines(to=D("2026-08-01")), more=True),
         ans(kind="task", linked_to="$ablution", where='status = "open"')]))

X("T10-021",
  T("log that i called him today", diff(upd("yousef", date=ANY)),
    ref=[act("log", kind="person", name="Yousef", args=lines(kind="call"))]),
  T("undo that, it was rami on the phone", diff(),
    ref=[act("undo")]))

X("T10-073",
  T("what's my balance with lina", val((56, "JOD")),
    ref=[ans(op="balance", rows="$lina")]))

X("T10-057",
  T("remind me what the debt with him is about", rows("d_jamal"),
    ref=[ans(kind="debt", linked_to="$jamal")]))

X("T10-065",
  T("what's tariq's position in the chess kitty", val((84, "JOD")),
    ref=[ans(op="balance", kind="group", name="Chess club kitty", linked_to="$tariq")]))

X("T10-033",
  T("undo that, she's flying back that day", diff(trash("+1")),
    ref=[act("undo")]))

X("T10-068",
  T("and the sanad one and the laptop password too, i'm at the ministry tomorrow",
    diff(reveal=[("sanad", "Jabal-Amman-44"), ("laptop", "Lucena-Bridge-4")]),
    ref=[act("reveal", rows="$sanad, $laptop", args=lines(field="password"))]))
