from gold import *

import json

world("T36", "2026-12-09T21:15", "Dev Mehra", "train")

def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T36-001-P", "relation chain group event role exclude besides in-laws para",
  T("sangeet attendees from the settle-up group who are in-laws", rows("sneha"),
    ref=[ans(kind="person", linked_to="$wedding, $sangeet", where='role contains "in-law"')]),
  T("what about the pune wedding", rows("baba"),
    ref=[ans(kind="person", linked_to="$wedding, $wedding_day", where='role contains "in-law"')]),
  T("who else came to the sangeet apart from sneha", rows("kunal", "rohan_m"),
    ref=[ans(kind="person", linked_to="$sangeet", exclude="$sneha")]),
  T("those two go into a new rupee group named sangeet crew",
    diff(new("group", name=has("sangeet"), currency="INR"), link("new", "me"), link("new", "kunal"),
         link("new", "rohan_m")),
    ref=[act("create", kind="group", args="name: Sangeet crew\ncurrency: INR", more=True),
         act("add_to", rows="$kunal, $rohan_m", args="to: $new")]))

S("T36-005-P", "scooter list open before event reschedule other one exclude para",
  T("scooter jobs still open ahead of the puc check, each under half an hour", rows("scooter_tyre", "scooter_puc_t"),
    ref=[ans(kind="task", linked_to="$scooter_list", where="status = open and effort < 30",
             when=J({"to": D("2026-12-18")}))]),
  T("tyre one moves to friday", diff(upd("scooter_tyre", date="2026-12-11")),
    ref=[act("reschedule", rows="$scooter_tyre", args=lines(to=U("week", 0, weekday=5)))]),
  T("other one, sunday", diff(upd("scooter_puc_t", date="2026-12-13")),
    ref=[act("reschedule", rows="$scooter_puc_t", args=lines(to=U("week", 0, weekday=7)))]),
  T("apart from those two, which scooter list tasks are open", rows("scooter_helmet", "scooter_ins", "emi_jan"),
    ref=[ans(kind="task", linked_to="$scooter_list", where="status = open", exclude="$scooter_tyre, $scooter_puc_t")]),
  T("anju already bought one so delete the helmet one, and then list what's open on the scooter list",
    rows("scooter_tyre", "scooter_puc_t", "scooter_ins", "emi_jan", also=diff(trash("scooter_helmet"))),
    ref=[act("delete", rows="$scooter_helmet", more=True),
         ans(kind="task", linked_to="$scooter_list", where="status = open")]),
  T("scooter service, tuesday instead", ask("scooter_service", "scooter_service_old"),
    ref=[act("reschedule", kind="event", name="scooter service", args=lines(to=U("week", 1, weekday=2)))]))

S("T36-009-P", "last query before-that empty create evening para",
  T("last dinner at aai's was when", rows("aai_dinner_1206"),
    ref=[ans(kind="event", name="dinner aai's", order="date desc", limit=1)]),
  T("apart from baba, who else was there", rows("aai"),
    ref=[ans(kind="person", linked_to="$aai_dinner_1206", exclude="$baba")]),
  T("the one prior to it?", rows("aai_dinner_1115"),
    ref=[ans(kind="event", name="dinner aai's", exclude="$aai_dinner_1206", order="date desc", limit=1)]),
  T("another one on the calendar yet?", rows(),
    ref=[ans(kind="event", name="dinner aai's", when=J({"from": U("day", 0)}))]),
  T("sunday the 27th at 7.30, book one", diff(new("event", name=has("aai"), date="2026-12-27T19:30")),
    ref=[act("create", kind="event", args=lines(name="Dinner at Aai's", date=D("2026-12-27", "19:30")))]))

S("T36-013-P", "parents list before event longest reschedule reopen para",
  T("parents list tasks still open ahead of the chandigarh flight", rows("baba_meds", "papa_report", "mummy_gift", "pack_chd"),
    ref=[ans(kind="task", linked_to="$parents_list", where="status = open", when=J({"to": D("2026-12-24")}))]),
  T("longest?", rows("mummy_gift"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]),
  T("saturday for that one", diff(upd("mummy_gift", date="2026-12-12")),
    ref=[act("reschedule", rows="$mummy_gift", args=lines(to=U("week", 0, weekday=6)))]),
  T("on the parents list, is the chandigarh flights task done", rows("book_fly"),
    ref=[find(kind="task", name="chandigarh flights", linked_to="$parents_list"), ans(rows="@prev")]),
  T("return needs changing so reopen it", diff(upd("book_fly", status="open", completed=None)),
    ref=[act("reopen", rows="$book_fly")]),
  T("mark the eye reports done and shift pack for chandigarh to the 22nd",
    diff(upd("papa_report", status="completed", completed=ANY), upd("pack_chd", date="2026-12-22")),
    ref=[act("complete", rows="$papa_report", more=True),
         act("reschedule", rows="$pack_chd", args=lines(to=D("2026-12-22")))]))

S("T36-021-P", "documents unfiled add_to two writes folder count para",
  T("unfiled documents?", rows("payslip_nov", "dubai_visa"),
    ref=[ans(kind="document", where="folder count = 0")]),
  T("payslip goes in work, visa copy in ids",
    diff(link("work_f", "payslip_nov"), link("id_f", "dubai_visa")),
    ref=[act("add_to", rows="$payslip_nov", args="to: $work_f", more=True),
         act("add_to", rows="$dubai_visa", args="to: $id_f")]),
  T("ids contents?", rows("aadhaar_dev", "aadhaar_anjali", "pan_dev", "passport_scan", "dubai_visa"),
    ref=[ans(kind="document", linked_to="$id_f")]))

S("T36-025-P", "find act prev reschedule list when status within effort para",
  T("work list, tomorrow's due items all move to monday",
    diff(upd("release_notes", date="2026-12-14"), upd("pr_review", date="2026-12-14")),
    ref=[find(kind="task", linked_to="$work_list", where="status = open", when=J(U("day", 1))),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]),
  T("work list remainder?", rows("exam_pending", "leave_apply", "tax_proofs", "perf_review", "release_notes", "pr_review"),
    ref=[ans(kind="task", linked_to="$work_list", where="status = open")]),
  T("work ones over half an hour among them?", rows("perf_review", "tax_proofs", "release_notes", "pr_review"),
    ref=[ans(within="@prev", where="effort > 30")]))

S("T36-029-P", "photos person decoy month starred unstar para",
  T("october pictures of rohan, my college friend", rows("p_dubai_dune", "p_dubai_burj"),
    ref=[ans(kind="photo", linked_to="$rohan_k", when=J(U("month", 0, name=10)))]),
  T("starred ones?", rows("p_dubai_dune"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("take the star off", diff(upd("p_dubai_dune", starred=False)),
    ref=[act("unstar", rows="$p_dubai_dune")]),
  T("burj one gets the star instead, and how many starred photos has rohan in them",
    val(1, also=diff(upd("p_dubai_burj", starred=True))),
    ref=[act("star", rows="$p_dubai_burj", more=True),
         ans(op="count", kind="photo", linked_to="$rohan_k", where="starred = yes")]))

S("T36-033-P", "notes body contains notebook month pin para",
  T("caterer mentions across my notes", rows("w_vendors", "w_settle"),
    ref=[ans(kind="note", where='body contains "caterer"')]),
  T("restrict to wedding planning notebook and november", rows("w_settle"),
    ref=[ans(kind="note", linked_to="$wedding_nb", where='body contains "caterer"', when=J(U("month", 0, name=11)))]),
  T("pin that one", diff(upd("w_settle", pinned=True)),
    ref=[act("edit", rows="$w_settle", args="pinned: yes")]))

S("T36-037-P", "create clash ask evening retry day read para",
  T("friday at 1, lunch with kunal", ask("lunch_rohan_k"),
    ref=[act("create", kind="event", args=lines(name="Lunch with Kunal", date=U("week", 0, weekday=5, time="13:00")))]),
  T("2.30 instead then", diff(new("event", name=has("kunal"), date="2026-12-11T14:30")),
    ref=[act("create", kind="event", args=lines(name="Lunch with Kunal", date=U("week", 0, weekday=5, time="14:30")))]),
  T("friday's plans?", rows("lunch_rohan_k", "+1"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=5)))]))

S("T36-041-P", "write read more wrap-up open sum within para",
  T("choose photos for the album is finished, mark it; what remains open under the wedding wrap-up",
    rows("wrap_settle", "wrap_thanks_cards", "wrap_video", also=diff(upd("wrap_album", status="completed", completed=ANY))),
    ref=[act("complete", rows="$wrap_album", more=True),
         ans(kind="task", linked_to="$wrap", where="status = open")]),
  T("total time for those?", val(110),
    ref=[ans(op="sum", field="effort", kind="task", within="@prev")]))

S("T36-045-P", "decline email unbounded para",
  T("send my tax proofs to the ca by email", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("honestly, wipe out every task i have", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T36-049-P", "event edit duration description date where cancel write read exclude person para",
  T("dentist check-up on the 21st should be an hour long, and put a note on it to ask about the braces",
    diff(upd("dentist_ev", duration=60, description=has("braces"))),
    ref=[bad(act("edit", kind="event", name="dentist check-up", when=J(D("2026-12-21")),
                 args="duration: an hour\ndescription: ask about the braces")),
         act("edit", kind="event", name="dentist check-up", when=J(D("2026-12-21")),
             args="duration: 60\ndescription: ask about the braces")]),
  T("december events carrying a note", rows("dentist_ev"),
    ref=[ans(kind="event", where="description is set", when=J(U("month", 0, name=12)))]),
  T("cancel it, and what else do i have that day", rows(also=diff(upd("dentist_ev", status="cancelled"))),
    ref=[act("cancel", rows="$dentist_ev", more=True),
         ans(kind="event", when=J(D("2026-12-21")), exclude="$dentist_ev")]),
  T("this week's remaining plans with priya from work", rows("sprint_1210", "office_party"),
    ref=[ans(kind="event", linked_to="$priya_d", where="status != cancelled",
             when=J({"from": U("day", 0), "to": U("week", 0)}))]))

S("T36-053-P", "note add_to linked undo restore where body add_to count para",
  T("rajma recipe leaves kitchen for flat notes",
    diff(link("home_nb", "kit_rajma"), unlink("kitchen_nb", "kit_rajma")),
    ref=[act("add_to", kind="note", name="rajma", linked_to="$kitchen_nb", args="to: $home_nb")]),
  T("nope, undo it", diff(link("kitchen_nb", "kit_rajma"), unlink("home_nb", "kit_rajma")),
    ref=[act("undo")]),
  T("bring back the scratch note with milk and eggs, then file it in kitchen",
    diff(restore("old_scratch"), link("kitchen_nb", "old_scratch")),
    ref=[act("restore", kind="note", name="scratch list", where='body contains "milk"', trashed=True, more=True),
         act("add_to", rows="$old_scratch", args="to: $kitchen_nb")]),
  T("kitchen notebook notes about onions?", rows("kit_poha", "kit_rajma"),
    ref=[ans(kind="note", linked_to="$kitchen_nb", where='body contains "onion"')]))

S("T36-061-P", "find only trashed photo para",
  T("did that blurry photo end up in the trash", rows("p_blurry"),
    ref=[find(kind="photo", name="blurry", trashed=True), ans(rows="@prev")]))

S("T36-065-P", "empty search recovery mechanic log next event para",
  T("mechanic at the garage, i rang him", diff(upd("ganesh", date=ANY)),
    ref=[search("garage", kind="person"), search("mechanic", kind="person"),
         act("log", rows="$ganesh", args="kind: call")]),
  T("scooter service date?", rows("scooter_service"),
    ref=[ans(kind="event", name="scooter service", when=J({"from": U("day", 0)}))]))

S("T36-069-P", "same-word-pick verb-decides gloss ask star person para",
  T("rohan gets a star", diff(upd("rohan_m", starred=True)),
    ref=[act("star", kind="person", name="rohan")]),
  T("college one loses his star", diff(upd("rohan_k", starred=False)),
    ref=[act("unstar", kind="person", name="rohan", where='role contains "college"')]),
  T("joshi gets one as well", ask("baba", "sneha", "priest", "dentist"),
    ref=[act("star", kind="person", name="joshi")]),
  T("the sister in law one", diff(upd("sneha", starred=True)),
    ref=[act("star", rows="$sneha")]))

S("T36-073-P", "create-args task-vs-event chore errand appointment para",
  T("saturday, call ganesh about the chain",
    diff(new("task", name=has("ganesh"), date="2026-12-12")),
    ref=[act("create", kind="task", args=lines(name="Call Ganesh about the chain", date=U("week", 0, weekday=6)))]),
  T("need to call the caterer about the final bill on monday",
    diff(new("task", name=has("caterer"), date="2026-12-14")),
    ref=[act("create", kind="task", args=lines(name="Call the caterer about the final bill", date=U("week", 1, weekday=1)))]),
  T("saturday at 5, call papa", diff(new("event", name=has("papa"), date="2026-12-12T17:00")),
    ref=[act("create", kind="event", args=lines(name="Call Papa", date=U("week", 0, weekday=6, time="17:00")))]))

S("T36-077-P", "verb-choice put-it-back restore add_to para",
  T("puncture photo, get rid of it", diff(trash("p_ride_puncture"), unlink("rides_album", "p_ride_puncture")),
    ref=[act("delete", rows="$p_ride_puncture")]),
  T("bring it back", diff(restore("p_ride_puncture")),
    ref=[act("restore", rows="$p_ride_puncture")]),
  T("add it to scooter rides again too", diff(link("rides_album", "p_ride_puncture")),
    ref=[act("add_to", rows="$p_ride_puncture", args="to: $rides_album")]),
  T("blurry one needs rescuing from the trash", diff(restore("p_blurry")),
    ref=[act("restore", kind="photo", name="blurry", trashed=True)]))

S("T36-081-P", "stop-signals not_found near-hit remind-me para",
  T("plumber in my contacts?", rows(),
    ref=[ans(kind="person", name="plumber")]),
  T("electrician?", rows(),
    ref=[ans(kind="person", name="electrician")]),
  T("home insurance policy, do i have it stored", rows("scooter_ins_d"),
    ref=[ans(kind="document", name="home insurance")]),
  T("remind me tomorrow to look for it", diff(new("task", name=has("insurance"), date="2026-12-10")),
    ref=[act("create", kind="task", args=lines(name="Look for the home insurance policy", date=U("day", 1)))]))

S("T36-085-P", "stop-signals fyi ask create-note para",
  T("news, anju's cousin priya is visiting in january", ask(),
    ref=[askc("Do you want me to save that, as a note or a reminder?")]),
  T("as a note, yes", diff(new("note", name=has("priya"), body=has("january"))),
    ref=[act("create", kind="note", args=lines(name="Priya visiting", body="Anju's cousin Priya is visiting in January"))]),
  T("society gate code changes next week, heads up", ask(),
    ref=[askc("Should I remind you to update the gate code?")]))

S("T36-089-P", "set-answers parent-vs-subtasks para",
  T("wedding wrap-up task status, finished?", rows("wrap"),
    ref=[ans(kind="task", name="wedding wrap-up")]),
  T("its finished parts?", rows("wrap_gifts_list", "wrap_return_decor", "wrap_pay_caterer"),
    ref=[ans(kind="task", linked_to="$wrap", where="status = completed")]),
  T("decor quotes task deleted?", rows("old_decor"),
    ref=[find(kind="task", name="decor quotes", trashed=True), ans(rows="@prev")]))

S("T36-093-P", "container-link-reads person-appointments within when para",
  T("upcoming plans with papa", rows("dinner_mummy", "doc_papa", "lohri"),
    ref=[ans(kind="event", linked_to="$papa", when=J({"from": U("day", 0)}))]),
  T("december ones?", rows("dinner_mummy", "doc_papa"),
    ref=[ans(within="@prev", when=J(U("month", 0, name=12)))]),
  T("mummy's on which of them", rows("dinner_mummy"),
    ref=[ans(within="@prev", linked_to="$mummy")]))

S("T36-097-P", "stray-conditions by-name-star inert-clause role-noun-name para",
  T("decorator's invoice needs a star, it's for the balance", diff(upd("decor_inv", starred=True)),
    ref=[act("star", rows="$decor_inv")]),
  T("photographer contract also", diff(upd("photog_contract", starred=True)),
    ref=[act("star", rows="$photog_contract")]))

S("T36-101-P", "date-window-reads before closed time-of-day-pick past-tense para",
  T("my plans before sunday", rows("sprint_1210", "lunch_rohan_k", "badm_1212", "office_party"),
    ref=[ans(kind="event", when=J(span(U("day", 0), U("week", 0, weekday=6))))]),
  T("the one in the evening", rows("office_party"),
    ref=[ans(rows="$office_party")]),
  T("badminton games played before the 15th, count", val(8),
    ref=[ans(op="count", kind="event", name="badminton", where="status != cancelled",
             when=J({"to": D("2026-11-14")}))]))

S("T36-105-P", "date-window-reads duration year-arithmetic para",
  T("events lasting over 4 hours", rows("sangeet", "wedding_day", "goa", "dubai_trip", "ny_party"),
    ref=[bad(ans(kind="event", where="duration > 4 hours")), ans(kind="event", where="duration > 240")]),
  T("any of them still ahead of us", rows("ny_party"),
    ref=[ans(within="@prev", when=J({"from": U("day", 0)}))]),
  T("next year's events?", rows("lohri", "engagement"),
    ref=[ans(kind="event", when=J(U("year", 1)))]),
  T("documents dated two years back", rows("offer_letter"),
    ref=[ans(kind="document", when=J(U("year", -2)))]))
