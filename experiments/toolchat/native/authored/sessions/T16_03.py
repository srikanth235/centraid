from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T16-051", "seven turns abba health ambiguous event docs span",
  T("when's abba's next cardiology check-up", rows("cardio_jan"),
    ref=[ans(kind="event", name="Cardiology check-up for Abba", when=W({"from": U("day", 0)}))]),
  T("and the echo test?", rows("echo_test"),
    ref=[ans(kind="event", name="Abba's echo test")]),
  T("move the check-up to the thirteenth, same time", diff(upd("cardio_jan", date="2027-01-13T17:00")),
    ref=[act("reschedule", kind="event", name="Cardiology check-up for Abba", args=lines(to=D("2027-01-13", "17:00"))),
         act("reschedule", rows="$cardio_jan", args=lines(to=D("2027-01-13", "17:00")))]),
  T("what's on abba's health list", rows("abba_meds", "abba_reports", "bp_machine", "amma_glasses"),
    ref=[ans(kind="task", linked_to="$health_l")]),
  T("refill abba's heart medicine is done, got it from lazz pharma", diff(upd("abba_meds", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Refill Abba's heart medicine")]),
  T("what's still open there", rows("abba_reports"),
    ref=[ans(kind="task", linked_to="$health_l", where='status = "open"')]),
  T("his docs from november till today?", rows("ecg", "prescription"),
    ref=[ans(kind="document", name="Abba's", when=W(span(U("month", 0, name=11), U("day", 0))))]))

S("T16-052", "six turns photos today linked add_to span delete",
  T("pics from today", rows("smriti", "victory_flag", "victory_lunch_p"),
    ref=[ans(kind="photo", when=W(U("day", 0)))]),
  T("who's in the lunch one", rows("abba", "amma", "nasrin"),
    ref=[ans(kind="person", linked_to="$victory_lunch_p")]),
  T("add it to comilla too, amma wants to show it in the village", diff(link("comilla_album", "victory_lunch_p")),
    ref=[act("add_to", rows="$victory_lunch_p", args=lines(to="$comilla_album"))]),
  T("photos from the dhanmondi match at noon up to last sunday",
    rows("rahim_wickets", "scoreboard", "team_2026", "new_machines", "tutor_note", "receipt_balls", "rickshaw", "winter_market"),
    ref=[ans(kind="photo", when=W(span(D("2026-12-05", "12:00"), U("week", -1, weekday=7))))]),
  T("delete the receipt for balls one", diff(trash("receipt_balls")),
    ref=[act("delete", rows="$receipt_balls")]),
  T("and the photo of tutor's note", diff(trash("tutor_note")),
    ref=[act("delete", rows="$tutor_note")]))

S("T16-053", "find miss search miss decline create add_to group",
  T("is shirin in my contacts", decline("not_found"),
    ref=[find(kind="person", name="Shirin"), search("shirin", kind="person"), dec("not_found")]),
  T("add her then, Shirin Akhter, new overlock operator", diff(new("person", name="Shirin Akhter", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Shirin Akhter", role="overlock operator, Line 3"))]),
  T("put her in the eid bonus pool", diff(link("bonus", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$bonus"))]),
  T("who's in the pool", rows("rahim_u", "jahanara", "salma", "mizan", "me", "+1"),
    ref=[ans(kind="person", linked_to="$bonus")]))

S("T16-054", "empty result person search log undo ledger",
  T("jwel - last time we spoke?", rows("jewel"),
    ref=[find(kind="person", name="Jwel"), search("jwel", kind="person"), ans(rows="$jewel")]),
  T("log a call with him", diff(upd("jewel", date=ANY)),
    ref=[act("log", rows="$jewel", args=lines(kind="call"))]),
  T("undo that, it was rahim who rang", diff(),
    ref=[act("undo")]))

S("T16-055", "search compute balance nickname",
  T("how much is babu into me for, all in", val((1000, "BDT")),
    ref=[search("babu", kind="person"), comp(op="balance", rows="$babu"), ans(value="@prev")]),
  T("and does he have any tasks on him", rows("kitty_collect"),
    ref=[ans(kind="task", linked_to="$babu")]))

S("T16-056", "refused delete group ask delete empty group",
  T("delete the cox's bazar trip group, we're doing it in cash", ask(),
    ref=[bad(act("delete", rows="$coxs")),
         askc("it still has the hotel advance in it, so it can't be deleted. settle up with masud and shafiq first?")]),
  T("no leave it. delete factory picnic 2025 though, that's long done",
    diff(gone("picnic"), unlink("picnic", "kamal"), unlink("picnic", "rubina"), unlink("picnic", "me")),
    ref=[act("delete", rows="$picnic")]),
  T("what groups are left", rows("fund", "tigers", "bonus", "coxs", "kolkata"),
    ref=[ans(kind="group")]),
  T("where's shafiq in the cox's one", val((-3000, "BDT")),
    ref=[ans(op="balance", kind="group", name="Cox's Bazar trip", linked_to="$shafiq")]))

S("T16-057", "refused delete group ask balance settle_up named",
  T("delete the kolkata shopping group", ask(),
    ref=[bad(act("delete", kind="group", name="Kolkata shopping")),
         askc("the saree shopping is still in it, so the group can't go. want to settle up with farzana first?")]),
  T("what's farzana's position in it", val((3200, "INR")),
    ref=[ans(op="balance", kind="group", name="Kolkata shopping", linked_to="$farzana")]),
  T("ok settle up with farzana there", diff(settle=["Farzana Akter"]),
    ref=[act("settle_up", rows="$farzana", args=lines(group="$kolkata"))]))

S("T16-058", "five turns tigers balance find settle_up prev",
  T("who's in the tigers kitty", rows("rahim_m", "sohel", "imran", "babu", "jewel", "me"),
    ref=[find(kind="person", linked_to="$tigers"), ans(rows="@prev")]),
  T("rahim mia's position there", val((-950, "BDT")),
    ref=[ans(op="balance", kind="group", name="Mirpur Tigers kitty", linked_to="$rahim_m")]),
  T("who's our wicketkeeper again", rows("imran"),
    ref=[find(kind="person", where='role contains "wicketkeeper"'), ans(rows="@prev")]),
  T("square him up for the tigers kitty", diff(settle=["Imran Kabir"]),
    ref=[act("settle_up", rows="@prev", args=lines(group="$tigers"))]),
  T("does he owe me for the gloves", rows("d_imran"),
    ref=[ans(kind="debt", linked_to="$imran")]))

S("T16-059", "single ask without options",
  T("put the gas cylinder guy in the diary", ask(),
    ref=[askc("what day and time is he coming?")]))

S("T16-060", "single list area in",
  T("which of my lists are family or health", rows("home_l", "kids_l", "health_l"),
    ref=[ans(kind="list", where='area in ("family", "health")')]))

S("T16-061", "list area in find count",
  T("lists for work or sport", rows("factory_l", "cricket_l"),
    ref=[find(kind="list", where='area in ("work", "sport")'), ans(rows="@prev")]),
  T("how many open on the cricket one", val(3),
    ref=[ans(op="count", kind="task", linked_to="$cricket_l", where='status = "open"')]))

S("T16-062", "person contact spans log count",
  T("who did i contact from monday 9am onwards", rows("nasrin", "shafiq", "rahim_u", "jahanara"),
    ref=[ans(kind="person", when=W(span(U("week", 0, weekday=1, time="09:00"), U("day", 0))))]),
  T("and last week plus this week", rows("kamal", "karim_h", "mizan", "rahim_m", "sohel", "nasrin", "shafiq", "rahim_u", "jahanara"),
    ref=[ans(kind="person", when=W(span(U("week", -1), U("week", 0))))]),
  T("had tea with rubina", diff(upd("rubina", date=ANY)),
    ref=[act("log", kind="person", name="Rubina Akter", args=lines(kind="coffee"))]),
  T("so how many people have i been in touch with this month", val(10),
    ref=[ans(op="count", kind="person", when=W(U("month", 0)))]))

S("T16-063", "person contact spans month",
  T("who did i talk to from first dec 8am till last week", rows("rubina", "karim_h", "mizan", "rahim_m", "sohel", "kamal"),
    ref=[ans(kind="person", when=W(span(D("2026-12-01", "08:00"), U("week", -1))))]),
  T("last month through this month?", rows("sharmin", "rehana", "rubina", "karim_h", "mizan", "rahim_m", "sohel", "kamal",
                                           "shafiq", "jahanara", "rahim_u", "nasrin"),
    ref=[ans(kind="person", when=W(span(U("month", -1), U("month", 0))))]),
  T("masud chowdhuri isn't there, when did i last reach him", rows("masud"),
    ref=[find(kind="person", name="Masud Chowdhuri"), search("masud chowdhuri", kind="person"), ans(rows="$masud")]))

S("T16-064", "document spans star",
  T("docs i added in november", rows("payslip_oct", "ecg", "prescription", "tanvir_admit", "tax_return", "tigers_fixtures"),
    ref=[ans(kind="document", when=W(span(D("2026-11-01"), D("2026-11-30"))))]),
  T("october through november?", rows("blood_report", "payslip_oct", "ecg", "prescription", "tanvir_admit", "tax_return", "tigers_fixtures"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=10), U("month", 0, name=11))))]),
  T("star tanvir's admit card, results are on the thirtieth", diff(upd("tanvir_admit", starred=True)),
    ref=[act("star", rows="$tanvir_admit")]),
  T("anything since november in the school folder", rows("tanvir_admit", "mim_report"),
    ref=[ans(kind="document", linked_to="$school_f", when=W(span(U("month", 0, name=11), U("day", 0))))]))

S("T16-065", "document spans find within remove_from prev",
  T("which docs came in between first oct and thirtieth nov",
    rows("blood_report", "payslip_oct", "ecg", "prescription", "tanvir_admit", "tax_return", "tigers_fixtures"),
    ref=[ans(kind="document", when=W(span(D("2026-10-01"), D("2026-11-30"))))]),
  T("factory ones from october to december", rows("payslip_oct", "payslip_nov"),
    ref=[ans(kind="document", linked_to="$factory_f", when=W(span(U("month", 0, name=10), U("month", 0, name=12))))]),
  T("take the october one out of the factory folder, it's in the erp", diff(unlink("factory_f", "payslip_oct")),
    ref=[find(within="@prev", name="October"), act("remove_from", rows="@prev", args=lines(from_="$factory_f"))]))

S("T16-066", "photo span rel date star",
  T("photos from last week up to yesterday",
    rows("new_machines", "tutor_note", "receipt_balls", "rickshaw", "winter_market", "target_board", "sunset_roof", "fog"),
    ref=[ans(kind="photo", when=W(span(U("week", -1), U("day", -1))))]),
  T("star the rickshaw art one", diff(upd("rickshaw", starred=True)),
    ref=[act("star", rows="$rickshaw")]))

S("T16-067", "photo spans unstar where yesterday",
  T("any pics from last month till the first of dec", rows("abba_amma", "tanvir_bat", "fire_drill_p", "salma_stage", "wedding_group", "mim_prize"),
    ref=[ans(kind="photo", when=W(span(U("month", -1), D("2026-12-01"))))]),
  T("and from fifth dec 1pm to last saturday",
    rows("rahim_wickets", "scoreboard", "team_2026", "new_machines", "tutor_note", "receipt_balls", "rickshaw", "winter_market"),
    ref=[ans(kind="photo", when=W(span(D("2026-12-05", "13:00"), U("week", -1, weekday=6))))]),
  T("unstar the starred one i took yesterday", diff(upd("fog", starred=False)),
    ref=[act("unstar", kind="photo", when=W(U("day", -1)), where="starred = yes")]))

S("T16-068", "debt date time rel time settle multi",
  T("what did i borrow yesterday morning, the one on fourteenth dec around 10am, and whatever i owe sohel", rows("d_monir", "d_selim", "d_sohel"),
    ref=[find(kind="debt", when=W(U("day", -1, time="09:00"))),
         find(kind="debt", when=W(D("2026-12-14", "10:00"))),
         find(kind="debt", linked_to="$sohel", where='direction = "i_owe"'),
         ans(rows="$d_monir, $d_selim, $d_sohel")]),
  T("paid the first two today, settle them", diff(upd("d_monir", status="settled"), upd("d_selim", status="settled")),
    ref=[act("settle_debt", rows="$d_monir, $d_selim")]),
  T("what's left that i owe", rows("d_masud", "d_mizan", "d_sohel"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T16-069", "debt date time rel time status is set",
  T("the debt from friday at 6pm, what's that", rows("d_sohel"),
    ref=[ans(kind="debt", when=W(U("week", -1, weekday=5, time="18:00")))]),
  T("and anything from two days ago in the evening", rows("d_selim"),
    ref=[ans(kind="debt", when=W(U("day", -2, time="19:00")))]),
  T("every debt on the owes-me side, settled or not", rows("d_shafiq", "d_babu", "d_jewel", "d_imran", "d_rahim_u", "d_topu"),
    ref=[ans(kind="debt", where='status is set and direction = "owes_me"')]))

S("T16-070", "five turns debts status spans settle",
  T("all my debts, open or settled",
    rows("d_shafiq", "d_babu", "d_jewel", "d_imran", "d_masud", "d_mizan", "d_selim", "d_rahim_u", "d_topu", "d_farzana", "d_monir", "d_sohel"),
    ref=[ans(kind="debt", where="status is set")]),
  T("which from monday till today 6pm", rows("d_selim", "d_monir"),
    ref=[ans(kind="debt", when=W(span(U("week", 0, weekday=1), U("day", 0, time="18:00"))))]),
  T("from october to first nov?", rows("d_rahim_u", "d_babu"),
    ref=[ans(kind="debt", when=W(span(U("month", 0, name=10), D("2026-11-01"))))]),
  T("rahim uddin's advance, is it open", rows("d_rahim_u"),
    ref=[ans(kind="debt", linked_to="$rahim_u")]),
  T("he paid it back out of his bonus, settle it", diff(upd("d_rahim_u", status="settled")),
    ref=[act("settle_debt", rows="$d_rahim_u")]))

S("T16-071", "notes span rel name pin",
  T("notes from last week through december",
    rows("audit_list", "meeting_rahim", "batting", "comilla_trip", "uttara_scout", "fund_dec", "rahim_feedback"),
    ref=[ans(kind="note", when=W(span(U("week", -1), U("month", 0, name=12))))]),
  T("pin the comila plan note", diff(upd("comilla_trip", pinned=True)),
    ref=[act("edit", kind="note", name="Comila plan", args=lines(pinned="yes")),
         search("comila plan", kind="note"),
         act("edit", rows="$comilla_trip", args=lines(pinned="yes"))]))

S("T16-072", "notes span linked from within pinned",
  T("family fund notes from last month to end of december", rows("fund_dec"),
    ref=[ans(kind="note", linked_to="$fund_nb", when=W(span(U("month", -1), U("month", 0, name=12))))]),
  T("who's tagged on it", rows("shafiq"),
    ref=[ans(kind="person", linked_to="$fund_dec")]),
  T("any notes since last month", rows("bonus_rates", "abba_diet", "operators", "tanvir_marks", "line3_targets", "pitha_recipe",
                                       "gift_ideas", "audit_list", "meeting_rahim", "batting", "comilla_trip", "uttara_scout",
                                       "fund_dec", "rahim_feedback"),
    ref=[ans(kind="note", when=W({"from": U("month", -1)}))]),
  T("which of those are pinned", rows("line3_targets", "pitha_recipe", "batting"),
    ref=[ans(within="@prev", where="pinned = yes")]))

S("T16-073", "six turns event dates cancel named duration",
  T("what did i have in may this year", rows("eid_adha"),
    ref=[ans(kind="event", when=W(U("month", 0, name=5)))]),
  T("from saturday through next week, anything with nasrin", rows("ptm_mim", "wedding"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 1))), linked_to="$nasrin")]),
  T("cancel mim's parent-teacher meeting, school pushed it", diff(upd("ptm_mim", status="cancelled")),
    ref=[act("cancel", kind="event", name="Mim's parent-teacher meeting")]),
  T("from november till tenth dec, what did i have with kamal",
    rows("prod_1101", "prod_1108", "prod_1115", "prod_1122", "prod_1129", "prod_1206", "safety_walk"),
    ref=[ans(kind="event", when=W(span(U("month", 0, name=11), D("2026-12-10"))), linked_to="$kamal")]),
  T("set up the next safety walk with him", ask(),
    ref=[askc("which day and time for the next safety walk?")]),
  T("anything tomorrow that's an hour long", rows("line3_review", "kit_pickup"),
    ref=[ans(kind="event", when=W(U("day", 1)), where="duration = 60 minutes")]))

S("T16-074", "description overlap ask never mind linked",
  T("what's happening at abahani ground", rows("match_dhanmondi", "match_final"),
    ref=[ans(kind="event", where='description = "Abahani ground"')]),
  T("book a team warm-up there new year's day at 11", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Team warm-up", date=D("2027-01-01", "11:00")))),
         askc("the winter cup final runs 10 to 4 that day, so 11 clashes. want another time?")]),
  T("never mind, we'll warm up at the ground", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("who's in the final squad", rows("sohel", "rahim_m", "imran", "babu", "jewel"),
    ref=[ans(kind="person", linked_to="$match_final")]))

S("T16-075", "trashed person restore multi read log",
  T("are liton das and shahin mollah in the trash", rows("liton", "shahin"),
    ref=[find(kind="person", trashed=True), ans(rows="$liton, $shahin")]),
  T("bring him and shahin back", diff(restore("liton"), restore("shahin")),
    ref=[act("restore", rows="$liton, $shahin")]),
  T("what does shahin do", rows("shahin"),
    ref=[ans(rows="$shahin")]),
  T("log a call with him, he rang about the plot", diff(upd("shahin", date=ANY)),
    ref=[act("log", rows="$shahin", args=lines(kind="call"))]))
