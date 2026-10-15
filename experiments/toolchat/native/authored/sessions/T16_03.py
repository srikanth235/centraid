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

S("T16-054", "empty result person search log undo ledger",
  T("jwel - last time we spoke?", rows("jewel"),
    ref=[find(kind="person", name="Jwel"), search("jwel", kind="person"), ans(rows="$jewel")]),
  T("log a call with him", diff(upd("jewel", date=ANY)),
    ref=[act("log", rows="$jewel", args=lines(kind="call"))]),
  T("undo that, it was rahim who rang", diff(),
    ref=[act("undo")]))

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
