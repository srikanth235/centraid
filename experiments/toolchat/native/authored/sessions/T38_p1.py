from gold import *

import json

world("T38", "2027-05-12T20:15", "Nour Al-Sayed", "train")

def J(d):
    return json.dumps(d, separators=(",", ":"))

FROM_NOW = J({"from": U("day", 0)})


S("T38-003-P", "clinic-list open before-event effort within complete reschedule two-dates para",
  T("clinic list tasks still open ahead of the anniversary party",
    rows("sup_240805", "sup_250310", "bak_270512", "sup_270517", "licence27_3", "t_048", "licence27_4"),
    ref=[ans(kind="task", linked_to="$clinic_l", where="status = open", when=J({"to": D("2027-06-03")}))]),
  T("of those, the ones taking less than half an hour", rows("sup_240805", "sup_250310", "bak_270512", "sup_270517"),
    ref=[ans(within="@prev", where="effort < 30")]),
  T("mark the backup one complete", diff(upd("bak_270512", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Back up patient records", linked_to="$clinic_l")]),
  T("supplies order shifts from monday to tuesday, and then what does the clinic have on that day",
    rows("sup_270517", "licence27_3", also=diff(upd("sup_270517", date="2027-05-18T09:00"))),
    ref=[act("reschedule", kind="task", name="Order clinic supplies", when=J(U("week", 1, weekday=1)),
             args=lines(to=U("week", 1, weekday=2)), more=True),
         ans(kind="task", linked_to="$clinic_l", when=J(U("week", 1, weekday=2)))]))

S("T38-007-P", "photos person album when starred para",
  T("aqaba album pictures with yazan", rows("ph_aqaba_a_01", "ph_aqaba_a_02", "ph_aqaba_a_06", "ph_aqaba_a_08",
                                              "ph_aqaba_a_09"),
    ref=[search("Yazan", kind="person"), ans(kind="photo", linked_to="$yazan, $aqaba_a")]),
  T("first day's only", rows("ph_aqaba_a_01", "ph_aqaba_a_02", "ph_aqaba_a_06"),
    ref=[ans(within="@prev", when=J(D("2026-05-08")))]))

S("T38-011-P", "weekend eid attendees last-year both relation chain para",
  T("this weekend's events with baba in them",
    rows("csm_270516", "eid_a27"),
    ref=[bad(ans(kind="event", linked_to="$baba", when=J({"from": {"weekday": 6}, "to": {"weekday": 7}}))),
         ans(kind="event", linked_to="$baba", when=J(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("eid lunch, who else is going apart from baba", rows("teta", "ammo_fadi"),
    ref=[ans(kind="person", linked_to="$eid_a27", exclude="$baba")]),
  T("last year's one, who showed up", rows("teta", "ammo_fadi"),
    ref=[find(kind="event", name="Eid al-Adha lunch at Teta's", when=J(U("year", -1))),
         ans(kind="person", linked_to="@prev")]),
  T("anyone at both?", rows("teta", "ammo_fadi"),
    ref=[ans(kind="person", linked_to="$eid_a27, $eid_a26")]))

S("T38-015-P", "locker trashed restore window find para",
  T("deleted locker items?", rows("old_wifi", "old_login"),
    ref=[ans(kind="locker item", trashed=True)]),
  T("old wifi needs to come back", diff(restore("old_wifi")),
    ref=[act("restore", rows="$old_wifi")]),
  T("old zain login too", decline("not_found"),
    ref=[find(kind="locker item", name="Old Zain login", trashed=True), act("restore", rows="$old_login")]))

S("T38-019-P", "near-names hussam husam role star unstar name-where para",
  T("hussam the neighbour gets a star", diff(upd("hussam", starred=True)),
    ref=[act("star", kind="person", name="Hussam", where='role = "neighbour"')]),
  T("husam, the uni friend, as well", diff(upd("husam", starred=True)),
    ref=[act("star", kind="person", name="Husam", where='role = "friend"')]),
  T("starred khourys?", rows("hussam", "husam", "salem_khoury"),
    ref=[ans(kind="person", name="Khoury", where="starred = yes")]),
  T("salem loses his star", diff(upd("salem_khoury", starred=False)),
    ref=[act("unstar", kind="person", name="Salem", where="starred = yes")]))

S("T38-023-P", "event edit duration week-weekday morning span para",
  T("this sunday's staff meeting should last an hour", diff(upd("csm_270516", duration=60)),
    ref=[bad(act("edit", kind="event", name="Clinic staff meeting", when=J(U("week", 0, weekday=7)), args="duration: 1 hour")),
         act("edit", kind="event", name="Clinic staff meeting", when=J(U("week", 0, weekday=7)), args="duration: 60")]),
  T("sunday morning, anything besides that", rows(),
    ref=[ans(kind="event", when=J(span(U("week", 0, weekday=7, time="06:00"), U("week", 0, weekday=7, time="11:59"))),
             exclude="$csm_270516")]))

S("T38-027-P", "subtasks container active empty done parent para",
  T("open subtasks under renew the clinic licence 2027", rows("licence27_3", "licence27_4", "licence27_5"),
    ref=[ans(kind="task", linked_to="$licence27", where="status = open")]),
  T("2026's?", rows(),
    ref=[ans(kind="task", linked_to="$licence26", where="status = open")]),
  T("no, the finished ones from 2026", rows("licence26_1", "licence26_2", "licence26_3", "licence26_4", "licence26_5"),
    ref=[ans(kind="task", linked_to="$licence26", where="status = completed", when=J(U("year", -1)))]),
  T("2027's finished ones?", rows("licence27_1", "licence27_2"),
    ref=[ans(kind="task", linked_to="$licence27", where="status = completed")]))

S("T38-031-P", "list create add_to move read rename para",
  T("create a social list named summer trip", diff(new("list", name="Summer Trip", area="social")),
    ref=[act("create", args=lines(kind="list", name="Summer Trip", area="social"))]),
  T("open print the hotel booking task goes into it", diff(unlink("travel_l", "t_055"), link("+1", "t_055")),
    ref=[act("add_to", kind="task", name="Print the hotel booking", where="status = open", args="to: $c1")]),
  T("download the offline maps one as well", diff(unlink("travel_l", "t_099"), link("+1", "t_099")),
    ref=[act("add_to", kind="task", name="Download the offline maps", where="status = open", args="to: $c1")]),
  T("summer trip list, open items?", rows("t_055", "t_099"),
    ref=[ans(kind="task", linked_to="$c1", where="status = open")]),
  T("list's new name should be holiday prep", diff(upd("+1", name="Holiday Prep")),
    ref=[act("edit", rows="$c1", args="name: Holiday Prep")]),
  T("maps one comes back out of it", diff(unlink("+1", "t_099")),
    ref=[act("remove_from", kind="task", name="Download the offline maps", args="from: $c1")]))

S("T38-035-P", "count events description year k4 para",
  T("count the friday lunches from 2025 whose note says mansaf", val(8),
    ref=[ans(op="count", kind="event", name="Friday lunch", where='description contains "mansaf"', when=J(U("year", -2)))]))

S("T38-039-P", "locker star two undo star-one para",
  T("visa and clinic card both get stars", diff(upd("visa_card", starred=True), upd("clinic_card", starred=True)),
    ref=[search("Visa", kind="locker item"), act("star", rows="$visa_card, $clinic_card")]),
  T("hold on, undo it", diff(upd("visa_card", starred=False), upd("clinic_card", starred=False)),
    ref=[act("undo")]),
  T("visa only", diff(upd("visa_card", starred=True)),
    ref=[act("star", rows="$visa_card")]))

S("T38-043-P", "cancel apply-all month undo-not-undone count-zero para",
  T("we'll be at the beach, so june's friday lunches are all off, cancel them",
    diff(upd("fl_270604", status="cancelled"), upd("fl_270611", status="cancelled"),
         upd("fl_270618", status="cancelled"), upd("fl_270625", status="cancelled")),
    ref=[find(kind="event", name="Friday lunch", when=J(U("month", 0, name=6))), act("cancel", rows="@prev")]),
  T("oops, undo it", diff(),
    ref=[act("undo")]),
  T("june friday lunches still going ahead, count", val(0),
    ref=[ans(op="count", kind="event", name="Friday lunch", where="status != cancelled", when=J(U("month", 0, name=6)))]))

S("T38-047-P", "photos starred album add_to ordinal unstar para",
  T("starred teta album photos from 2025 onwards", rows("ph_teta_a_13", "ph_teta_a_15"),
    ref=[ans(kind="photo", linked_to="$teta_a", where="starred = yes", when=J({"from": D("2025-01-01")}))]),
  T("both go into the eid 2026 album", diff(link("eid26", "ph_teta_a_13"), link("eid26", "ph_teta_a_15")),
    ref=[act("add_to", rows="@prev", args="to: $eid26")]),
  T("second one loses its star", diff(upd("ph_teta_a_15", starred=False)),
    ref=[act("unstar", rows="$ph_teta_a_15")]))

S("T38-051-P", "search log relation exclude friday-lunch attendees para",
  T("i called yazan, he says he'll be at friday lunch, log it", diff(upd("yazan", date=ANY)),
    ref=[search("Yazan", kind="person"), act("log", rows="$yazan", args="kind: call")]),
  T("this friday's lunch, apart from him who else is coming", rows("baba", "mama", "dana"),
    ref=[find(kind="event", name="Friday lunch", when=J(U("week", 0, weekday=5))),
         ans(kind="person", linked_to="@prev", exclude="$yazan")]))

S("T38-055-P", "diary date within name para",
  T("diary for the 16th, what remains", rows("csm_270516", "eid_a27"),
    ref=[ans(kind="event", where="status != cancelled", when=J(D("2027-05-16")))]),
  T("teta's among them?", rows("eid_a27"),
    ref=[ans(within="@prev", name="Teta")]),
  T("this sunday's staff meeting is off, delete it", diff(trash("csm_270516")),
    ref=[act("delete", kind="event", name="Clinic staff meeting", when=J(U("week", 0, weekday=7)))]),
  T("no wait, restore it", diff(restore("csm_270516")),
    ref=[find(kind="event", name="Clinic staff meeting", trashed=True, when=J(U("week", 0, weekday=7))),
         act("restore", rows="$csm_270516")]))

S("T38-059-P", "decline fabricated then locker edit sealed para",
  T("invent a fresh alarm code for the clinic", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("or rather, set it to 4455 then the star key", diff(upd("alarm", notes="sealed")),
    ref=[act("edit", rows="$alarm", args="notes: 4455 then the star key")]))

S("T38-063-P", "friday-lunch next exclude reschedule day-read cancel-and-move para",
  T("next friday lunch still on, when", rows("fl_270514"),
    ref=[ans(kind="event", name="Friday lunch", where="status != cancelled", when=J({"from": U("day", 0)}),
             order="date asc", limit=1)]),
  T("attendees?", rows("baba", "mama", "yazan", "dana"),
    ref=[ans(kind="person", linked_to="@prev")]),
  T("the following one?", rows("fl_270521"),
    ref=[ans(kind="event", name="Friday lunch", when=J({"from": U("day", 0)}), order="date asc", limit=1,
             exclude="$fl_270514")]),
  T("that one goes to saturday, who's still coming",
    rows("baba", "mama", "yazan", "dana", also=diff(upd("fl_270521", date="2027-05-22T13:30"))),
    ref=[act("reschedule", kind="event", name="Friday lunch", when=J(U("week", 1, weekday=5)),
             args=lines(to=U("week", 1, weekday=6)), more=True),
         ans(kind="person", linked_to="$fl_270521")]),
  T("that saturday's remaining events?", rows("fl_270521", "yf_270522"),
    ref=[ans(kind="event", where="status != cancelled", when=J(U("week", 1, weekday=6)))]),
  T("football that day is off, and the lunch should start an hour later",
    diff(upd("yf_270522", status="cancelled"), upd("fl_270521", date="2027-05-22T14:30")),
    ref=[act("cancel", kind="event", name="Yazan's football", when=J(U("week", 1, weekday=6)), more=True),
         act("reschedule", rows="$fl_270521", args=lines(to=U("hour", 1, anchor="row")))]))

S("T38-067-P", "documents restore-find year remove_from rename delete-year create-folder para",
  T("internet contract from 2024 got deleted by mistake, restore it", diff(restore("doc_003")),
    ref=[find(kind="document", name="Internet contract", trashed=True, when=J(U("year", -3))),
         act("restore", rows="$doc_003")]),
  T("out of the rent folder with it", diff(unlink("rentf", "doc_003")),
    ref=[act("remove_from", rows="$doc_003", args="from: $rentf")]),
  T("rename to old internet contract", diff(upd("doc_003", name="Old internet contract")),
    ref=[act("edit", rows="$doc_003", args="name: Old internet contract")]),
  T("get rid of the zakat calculation from 2024", diff(trash("doc_030")),
    ref=[act("delete", kind="document", name="Zakat calculation", when=J(U("year", -3)))]),
  T("tax folder needs a new document, clinic invoice may 2027",
    diff(new("document", name="Clinic invoice May 2027"), link("taxf", "new")),
    ref=[act("create", args=lines(kind="document", name="Clinic invoice May 2027", folder="$taxf"))]))

S("T38-071-P", "recovery empty-search not-found write read para",
  T("i called my cardiologist, log it", decline("not_found"),
    ref=[search("cardiologist", kind="person"), act("log", kind="person", name="cardiologist", args="kind: call")]),
  T("airport driver gets a star", decline("not_found"),
    ref=[search("driver", kind="person"), act("star", kind="person", name="driver")]),
  T("guitar tutor's phone number?", rows(),
    ref=[search("guitar"), ans(kind="person", name="guitar tutor")]))

S("T38-075-P", "recovery empty-search answer-empty babysitter para",
  T("babysitter's phone number?", rows(),
    ref=[search("babysitter", kind="person"), ans(kind="person", name="babysitter")]))

S("T38-079-P", "same-word school-photos debt-vs-task settle_debt person-possessor read complete para",
  T("settle the school photos debt, yazan paid me back", diff(upd("debt_39", status="settled")),
    ref=[search("Yazan", kind="person"),
         act("settle_debt", kind="debt", name="school photos", linked_to="$yazan")]),
  T("samar's school photos debt still open?", rows("debt_24"),
    ref=[search("Samar", kind="person"),
         ans(kind="debt", name="school photos", linked_to="$samar_shraideh", where="status = open")]),
  T("ordered dana's school photos today, mark it done", diff(upd("t_068", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Order Dana's school photos")]),
  T("the card i use for the clinic gets a star", diff(upd("clinic_card", starred=True)),
    ref=[act("star", kind="locker item", name="clinic", where="type = card")]))

S("T38-083-P", "create-args task-vs-event call-tradesperson appointment errand para",
  T("friday, call the plumber about the kitchen tap, it's been dripping all week",
    diff(new("task", name=has("plumber"), date="2027-05-14")),
    ref=[act("create", args=lines(kind="task", name="Call the plumber about the kitchen tap", date=U("week", 0, weekday=5)))]),
  T("thursday at 4 yazan has the dentist", diff(new("event", name=has("dentist"), date="2027-05-13T16:00")),
    ref=[act("create", args=lines(kind="event", name="Dentist - Yazan", date=U("week", 0, weekday=4, time="16:00")))]),
  T("saturday, pick up mama's cake from the bakery",
    diff(new("task", name=has("cake"), date="2027-05-15")),
    ref=[act("create", args=lines(kind="task", name="Pick up Mama's cake from the bakery",
                                  date=U("week", 0, weekday=6)))]))

S("T38-087-P", "verb-choice put-it-back after delete document restore same row as the remove session para",
  T("we changed provider, so get rid of the 2025 internet contract", diff(trash("doc_033")),
    ref=[act("delete", kind="document", name="Internet contract 2025")]),
  T("bring it back", diff(restore("doc_033")),
    ref=[act("restore", rows="$doc_033")]),
  T("2024's too, i deleted that last week", diff(restore("doc_003")),
    ref=[find(kind="document", name="Internet contract 2024", trashed=True), act("restore", rows="@prev")]))

S("T38-091-P", "stop-signals miss decoy-near-hit visit-events-on-vault-line empty answer then person-link miss then write miss para",
  T("vet visit date?", rows(),
    ref=[ans(kind="event", name="vet")]),
  T("dana's dentist appointment date?", rows(),
    ref=[ans(kind="event", name="dentist", linked_to="$dana")]),
  T("she's given it up, cancel the piano lesson", decline("not_found"),
    ref=[act("cancel", kind="event", name="Piano lesson")]))

S("T38-095-P", "stop-signals off-topic out_of_scope after a vault read decoy focus row para",
  T("yazan's next football game?", rows("yf_270522"),
    ref=[ans(kind="event", name="Yazan's football", where="status != cancelled", when=FROM_NOW, order="date asc", limit=1)]),
  T("which team won last time", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T38-099-P", "set-answers parent-task-vs-subtasks licence renewal open complete count para",
  T("2027 licence renewal subtasks still open", rows("licence27_3", "licence27_4", "licence27_5"),
    ref=[ans(kind="task", linked_to="$licence27", where="status = open")]),
  T("ministry inspection one is booked, so complete it, then count what's left",
    val(2, also=diff(upd("licence27_3", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Book the ministry inspection", more=True),
         ans(op="count", kind="task", linked_to="$licence27", where="status = open")]))
