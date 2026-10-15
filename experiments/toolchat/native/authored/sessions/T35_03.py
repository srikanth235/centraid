from gold import *
import json

world("T35", "2026-11-12T19:20", "Freya Lindqvist", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T35-051", "near-spelling unstar applied delete did-you-mean",
  T("unstar the grant agrement", diff(upd("grant_agreement", starred=False)),
    ref=[act("unstar", kind="document", name="grant agrement")]),
  T("delete the club buget 2026", ask("club_budget"),
    ref=[act("delete", kind="document", name="club buget 2026")]))

S("T35-052", "cancelled reschedule ask create",
  T("move the dinner with siv from the 6th to next friday", ask("dinner_siv"),
    ref=[act("reschedule", kind="event", name="dinner with siv", when=D("2026-11-06"), args=lines(to=U("week", 1, weekday=5)))]),
  T("ok book a new one then, next friday at 7", diff(new("event", name=has("siv"), date="2026-11-20T19:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Siv", date=U("week", 1, weekday=5, time="19:00")))]))

S("T35-053", "two-writes cancel name-date reschedule",
  T("cancel the morning swims on the 17th and the 24th", diff(upd("swim_1117", status="cancelled"), upd("swim_1124", status="cancelled")),
    ref=[act("cancel", kind="event", name="morning swim", when=D("2026-11-17"), more=True),
         act("cancel", kind="event", name="morning swim", when=D("2026-11-24"))]),
  T("and move the handover on the 27th to 6", diff(upd("handover_1127", date="2026-11-27T18:00")),
    ref=[act("reschedule", kind="event", name="jonas handover", when=D("2026-11-27"), args=lines(to=D("2026-11-27", "18:00")))]))

S("T35-054", "person where-when cadence within",
  T("who from the marine lab have i spoken to this week", rows("marit", "lars_e", "sigrid"),
    ref=[ans(kind="person", where='met = "marine lab"', when=J(U("week", 0)))]),
  T("and the ones i'm on a weekly cadence with", rows("lars_e", "sigrid"),
    ref=[ans(within="@prev", where="cadence = 7 days")]))

S("T35-055", "jonas weekend find-only two-writes name-when count create",
  T("what's jonas got on this weekend that isn't cancelled", rows("ski_jonas", "football"),
    ref=[find(kind="event", linked_to="$jonas", where="status != cancelled",
              when=J(span(U("week", 0, weekday=6), U("week", 0, weekday=7)))),
         ans(rows="@prev")]),
  T("move sunday's football to 11 and cancel saturday's skiing, he's got a cold",
    diff(upd("football", date="2026-11-15T11:00"), upd("ski_jonas", status="cancelled")),
    ref=[act("reschedule", kind="event", name="football", when=U("week", 0, weekday=7),
             args=lines(to=U("week", 0, weekday=7, time="11:00")), more=True),
         act("cancel", kind="event", name="skiing", when=U("week", 0, weekday=6))]),
  T("how many handovers have i got left this year", val(3),
    ref=[ans(op="count", kind="event", name="jonas handover", when=J({"from": U("day", 0), "to": U("year", 0)}))]),
  T("add a fridge task for the 27th at noon on the jonas list",
    diff(new("task", name=has("fridge"), date="2026-11-27T12:00"), link("jonas_list", "new")),
    ref=[act("create", args="kind: task\nname: Stock the fridge for Jonas\ndate: " + J(D("2026-11-27", "12:00")) + "\nlist: $jonas_list")]))

S("T35-056", "no-link recovery find-only exclude log",
  T("which open tasks go with the agm", rows("agm_report"),
    ref=[ans(kind="task", linked_to="$club_agm", where="status = open"),
         ans(kind="task", name="agm", where="status = open")]),
  T("who's coming to it besides tuva", rows("lars_h", "hjordis"),
    ref=[find(kind="person", linked_to="$club_agm", exclude="$tuva"), ans(rows="@prev")]),
  T("log a message to both of them", diff(upd("lars_h", date=ANY), upd("hjordis", date=ANY)),
    ref=[act("log", rows="@prev", args="kind: message")]),
  T("and move the receipts task to the day before the agm", diff(upd("kitty_receipts", date="2026-11-27")),
    ref=[act("reschedule", rows="$kitty_receipts", args=lines(to=D("2026-11-27")))]))

S("T35-058", "create album find add_to two-finds",
  T("make an album called summer friends", diff(new("album", name=has("summer", "friends"))),
    ref=[act("create", args="kind: album\nname: Summer friends")]),
  T("put the photos of kjersti and siv in it", diff(link("+1", "p_kjersti"), link("+1", "p_siv_yoga")),
    ref=[find(kind="photo", linked_to="$kjersti"), find(kind="photo", linked_to="$siv"),
         act("add_to", rows="@1, @2", args="to: $c1")]),
  T("which photos from july are in there", rows("p_kjersti", "p_siv_yoga"),
    ref=[ans(kind="photo", linked_to="$c1", when=J(U("month", 0, name=7)))]))

S("T35-059", "december events exclude within count find-act superlative",
  T("what's on in december apart from the lab meetings",
    rows("swim_1201", "symposium", "swim_1208", "health_check", "tax_meeting", "handover_1211", "swim_1215",
         "fly_bergen", "xmas", "fly_back"),
    ref=[find(kind="event", name="lab meeting", when=J(U("month", 0, name=12))),
         ans(kind="event", when=J(U("month", 0, name=12)), exclude="@prev")]),
  T("which of those are before the 9th", rows("swim_1201", "symposium", "swim_1208", "health_check"),
    ref=[ans(within="@prev", when=J({"to": D("2026-12-09")}))]),
  T("how many of those are swims", val(2),
    ref=[ans(op="count", within="@prev", name="morning swim")]),
  T("cancel both of them", diff(upd("swim_1201", status="cancelled"), upd("swim_1208", status="cancelled")),
    ref=[find(kind="event", within="@3", name="morning swim"), act("cancel", rows="@prev")]),
  T("what's the longest thing i've got in december", rows("symposium"),
    ref=[ans(kind="event", when=J(U("month", 0, name=12)), order="duration desc", limit=1)]))

S("T35-060", "tasks next week find-only complete reschedule superlative",
  T("what's due next week that's still open and under an hour", rows("pay_lars", "cod_gear", "heat_pump"),
    ref=[find(kind="task", where="status = open and effort < 60 minutes", when=J(U("week", 1))), ans(rows="@prev")]),
  T("tick off the first two", diff(upd("pay_lars", status="completed", completed=ANY), upd("cod_gear", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pay_lars, $cod_gear")]),
  T("and the third one, push it to the 30th", diff(upd("heat_pump", date="2026-11-30")),
    ref=[act("reschedule", rows="$heat_pump", args=lines(to=D("2026-11-30")))]),
  T("what's left on the home list that's due by the end of the month", rows("elec_bill", "lights", "chimney", "heat_pump"),
    ref=[find(kind="task", linked_to="$home_list", where="status = open", when=J({"to": D("2026-11-30")})), ans(rows="@prev")]),
  T("which one is due first", rows("elec_bill"),
    ref=[ans(within="@prev", order="date asc", limit=1)]))

S("T35-061", "repair operator within two-writes edit priority",
  T("which lab tasks are priority 1 or 2 and still open", rows("cod", "cod_echo", "grant_progress", "ethics"),
    ref=[bad(ans(kind="task", linked_to="$lab_list", where="priority <= 2 and status == open")),
         ans(kind="task", linked_to="$lab_list", where="priority <= 2 and status = open")]),
  T("which of those are due before the symposium", rows("cod_echo", "grant_progress"),
    ref=[ans(within="@prev", when=J({"to": D("2026-12-02")}))]),
  T("push the echosounder one to the 3rd of december and make the report priority 2",
    diff(upd("cod_echo", date="2026-12-03"), upd("grant_progress", priority=2)),
    ref=[act("reschedule", rows="$cod_echo", args=lines(to=D("2026-12-03")), more=True),
         act("edit", rows="$grant_progress", args="priority: 2")]),
  T("how long are those two together", val(420),
    ref=[ans(op="sum", field="effort", within="@2")]),
  T("and which of the two is the bigger one", rows("grant_progress"),
    ref=[ans(within="@2", order="effort desc", limit=1)]))


S("T35-063", "lab recovery ambiguous delete search-pin edit-find repair",
  T("anything open for the symposium that takes under an hour", rows("poster"),
    ref=[ans(kind="task", linked_to="$symposium", where="status = open and effort < 60 minutes"),
         ans(kind="task", name="symposium", where="status = open and effort < 60 minutes")]),
  T("move that to next thursday", diff(upd("poster", date="2026-11-19")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=4)))]),
  T("which of the cod acoustic survey 2027 subtasks are still open, take over an hour and are due this month", rows("cod_echo"),
    ref=[bad(ans(kind="task", linked_to="$cod", where="status = open and effort > 60 minutes", when=J({"unit": "month"}))),
         ans(kind="task", linked_to="$cod", where="status = open and effort > 60 minutes", when=J(U("month", 0)))]),
  T("delete the cod survey planning note in the lab notes notebook", ask("lab_cod1", "lab_cod2"),
    ref=[act("delete", kind="note", name="cod survey planning", linked_to="$lab_nb")]),
  T("the september one", diff(trash("lab_cod1")),
    ref=[act("delete", rows="$lab_cod1")]),
  T("notes from november about the animal ethics renewal", rows("lab_meeting2"),
    ref=[ans(kind="note", linked_to="$ethics", when=J(U("month", 0, name=11))),
         ans(kind="note", where='body contains "ethics"', when=J(U("month", 0, name=11)))]),
  T("pin the note about the freezer alarm", diff(upd("lab_meeting1", pinned=True)),
    ref=[search("freezer alarm", kind="note"),
         act("edit", rows="$lab_meeting1", args="pinned: yes")]),
  T("make all the open lab tasks over an hour that are due before the symposium priority 2",
    diff(upd("review_paper", priority=2), upd("grant_progress", priority=2)),
    ref=[act("edit", kind="task", linked_to="$lab_list", where="status = open and effort > 60 minutes", when=J({"to": D("2026-12-02")}), args="priority: 2")]),
  T("anything overdue", rows(),
    ref=[ans(kind="task", where="status = open", when=J({"to": U("day", -1)}))]))

S("T35-065", "trash restore decline recovery write-read add_to repair",
  T("bring back the old telenor logn", diff(restore("old_login")),
    ref=[act("restore", kind="locker item", name="old telenor logn")]),
  T("and the old flat wifi", decline("not_found"),
    ref=[act("restore", kind="locker item", name="old flat wifi", trashed=True)]),
  T("photos for the poster from november", rows("p_poster"),
    ref=[ans(kind="photo", linked_to="$poster", when=J(U("month", 0, name=11))),
         ans(kind="photo", name="poster", when=J(U("month", 0, name=11)))]),
  T("any photos in the trash", rows("p_blurry", "p_receipt"),
    ref=[ans(kind="photo", trashed=True)]),
  T("restore the blurry photo, then what's left in the trash", rows("p_receipt", also=diff(restore("p_blurry"))),
    ref=[act("restore", rows="$p_blurry", more=True),
         ans(kind="photo", trashed=True)]),
  T("put the passport scan and the dive certificate in the to file folder",
    diff(link("empty_f", "passport_scan"), link("empty_f", "dive_cert")),
    ref=[bad(act("add_to", rows="$passport_scan, $dive_cert", args="to: To file")),
         act("add_to", rows="$passport_scan, $dive_cert", args="to: $empty_f")]))
