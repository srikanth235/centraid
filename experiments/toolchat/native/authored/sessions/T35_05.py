from gold import *
import json

world("T35", "2026-11-12T19:20", "Freya Lindqvist", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


# ---- container-link-reads: collision cases ---------------------------------------------------

S("T35-091", "container-link-reads notebook lab-notes name-collision within body-contains",
  T("lab notes notebook, anything since september",
    rows("lab_cod1", "lab_cod2", "lab_meeting1", "lab_meeting2", "lab_seminar"),
    ref=[ans(kind="note", linked_to="$lab_nb", when=J({"from": U("month", 0, name=9)}))]),
  T("which of those are from this month", rows("lab_cod2", "lab_meeting2"),
    ref=[ans(within="@prev", when=J(U("month", 0)))]),
  T("any other notes that mention the lab", rows("diary_whale"),
    ref=[ans(kind="note", where='body contains "lab"')]))

S("T35-092", "container-link-reads owner-row groups-i-am-in count within person-link",
  T("how many groups am i in", val(6),
    ref=[ans(op="count", kind="group", linked_to="$me")]),
  T("and which of those is bjorn in", rows("seilklubb", "kiel"),
    ref=[ans(within="@prev", linked_to="$bjorn")]))

S("T35-093", "container-link-reads person-appointments role-lookup linked-event name-filter-misses",
  T("who's the group leader at the lab", rows("marit"),
    ref=[ans(kind="person", where='role = "group leader"')]),
  T("anything with her next week", rows("lab_1116"),
    ref=[ans(kind="event", linked_to="$marit", when=J(U("week", 1)))]),
  T("and move the dinner with astrid to 8", ask("dinner_astrid", "dinner_astrid_old"),
    ref=[act("reschedule", kind="event", name="dinner with astrid", args=lines(to=U("day", 0, anchor="row", time="20:00")))]))

S("T35-094", "container-link-reads person-attendee jonas name-collision within",
  T("what's jonas got coming up", rows("handover_1113", "ski_jonas", "football", "dentist_jonas", "handover_1127", "handover_1211"),
    ref=[ans(kind="event", linked_to="$jonas", when=J({"from": U("day", 0)}))]),
  T("which of those has eirik", rows("football"),
    ref=[ans(within="@prev", linked_to="$eirik")]),
  T("move the handover to 6", ask("handover_1113", "handover_1127", "handover_1211"),
    ref=[act("reschedule", kind="event", name="handover", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("any open tasks for the football match", rows("jonas_fees"),
    ref=[ans(kind="task", linked_to="$football", where="status = open"),
         ans(kind="task", name="football", where="status = open")]))

S("T35-095", "container-link-reads list-vs-person-vs-album collision jonas",
  T("what's left for jonas", rows("fridge_1113", "jonas_boots", "jonas_form", "jonas_fees", "jonas_bday"),
    ref=[ans(kind="task", linked_to="$jonas_list", where="status = open")]),
  T("what's in the jonas album from this year",
    rows("p_jonas_boat", "p_jonas_goal", "p_jonas_birthday", "p_jonas_exam", "p_jonas_snow", "p_jonas_kitchen"),
    ref=[ans(kind="photo", linked_to="$jonas_album", when=J(U("year", 0)))]))


# ---- stray-or-operator-conditions ------------------------------------------------------------

S("T35-096", "stray-conditions by-name writes inert purpose clause star reschedule complete",
  T("star the club budget, i need it for the agm", diff(upd("club_budget", starred=True)),
    ref=[act("star", kind="document", name="club budget")]),
  T("can you push the poster task to the 25th, the printer's free then", diff(upd("poster", date="2026-11-25")),
    ref=[act("reschedule", kind="task", name="poster", args=lines(to=D("2026-11-25")))]),
  T("tick off the sample log, did it before the cod team meeting",
    diff(upd("sample_log", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="sample log")]),
  T("push the grant report to the 4th of december, need the extra week", ask("grant_progress", "grant_final"),
    ref=[act("reschedule", kind="task", name="grant report", args=lines(to=D("2026-12-04")))]))

S("T35-097", "stray-conditions reads inert purpose clause photos documents tasks-effort",
  T("photos of kjersti from july for the christmas card", rows("p_kjersti"),
    ref=[ans(kind="photo", linked_to="$kjersti", when=J(U("month", 0, name=7)))]),
  T("docs on the boat, for the insurance renewal", rows("boat_reg"),
    ref=[ans(kind="document", name="boat")]),
  T("lab tasks under an hour, got a quiet afternoon", rows("cod_gear", "poster", "sample_log", "buy_ice"),
    ref=[ans(kind="task", linked_to="$lab_list", where="status = open and effort < 60 minutes")]))

S("T35-098", "stray-conditions role-looking noun club teacher group-link role-exact event-link",
  T("who's in the coffee club that i've spoken to this month", rows("lars_e", "sigrid", "marit"),
    ref=[ans(kind="person", linked_to="$lab_coffee", when=J(U("month", 0)))]),
  T("and who's the club treasurer", rows("tuva"),
    ref=[ans(kind="person", where='role = "club treasurer"')]),
  T("who's at the parent-teacher meeting", rows("hanne"),
    ref=[ans(kind="person", linked_to="$parent_teacher")]))

S("T35-099", "stray-conditions right-condition description-contains met-contains body-contains",
  T("which event in december has the poster session", rows("symposium"),
    ref=[ans(kind="event", where='description contains "poster"', when=J(U("month", 0, name=12)))]),
  T("who do i know from the seilforening", rows("lars_h", "tuva", "hjordis", "bjorn"),
    ref=[ans(kind="person", where='met contains "Seilforening"')]),
  T("notes from this month that mention the aurora", rows("polar_notes"),
    ref=[ans(kind="note", where='body contains "aurora"', when=J(U("month", 0)))]),
  T("and any open tasks for the poster session", rows("poster"),
    ref=[ans(kind="task", linked_to="$symposium", where="status = open"),
         ans(kind="task", name="poster", where="status = open")]))

S("T35-100", "stray-conditions field-the-kind-lacks person-status photo-description document-priority notebook-body",
  T("which of the lab people are still active", rows("marit", "lars_e", "ola", "sigrid", "torunn"),
    ref=[ans(kind="person", where='met contains "lab"')]),
  T("photos from november that show the humpback", rows("p_field_whale"),
    ref=[ans(kind="photo", name="humpback", when=J(U("month", 0, name=11)))]),
  T("which tax documents from this year are urgent", rows("tax_2025"),
    ref=[ans(kind="document", linked_to="$tax_f", when=J(U("year", 0)))]),
  T("which notebook are the cod survey notes in", rows("lab_nb"),
    ref=[find(kind="note", name="cod survey"), ans(kind="notebook", linked_to="@prev")]))


# ---- date-window-reads -----------------------------------------------------------------------

S("T35-101", "date-window before-X closed-from-today future past-tense count",
  T("what's on before the 20th that isn't cancelled", rows("cod_team", "handover_1113", "ski_jonas", "football", "lab_1116", "coffee_kjersti",
                                       "swim_1117", "dentist", "parent_teacher"),
    ref=[ans(kind="event", when=J({"from": U("day", 0), "to": D("2026-11-19")}), where="status != cancelled")]),
  T("how many lab meetings before the 20th of october, minus the cancelled", val(6),
    ref=[ans(op="count", kind="event", name="lab meeting", when=J({"to": D("2026-10-19")}), where="status != cancelled")]))

S("T35-102", "date-window named-month whole-month or-older from-X-on photos",
  T("how many swims did i do in october", val(3),
    ref=[ans(op="count", kind="event", name="swim", when=J(U("month", 0, name=10)), where="status != cancelled")]),
  T("photos from june or older that aren't starred",
    rows("p_jonas_birthday", "p_kiel_fleet", "p_kiel_dinner", "p_field_trawl", "p_field_ship", "p_bergen_table", "p_bergen_mamma"),
    ref=[ans(kind="photo", where="starred = no", when=J({"to": U("month", 0, name=6)}))]),
  T("and from november on", rows("p_jonas_kitchen", "p_field_whale", "p_house", "p_poster", "p_sunrise"),
    ref=[ans(kind="photo", when=J({"from": U("month", 0, name=11)}))]),
  T("how many events have i got in december", val(12),
    ref=[ans(op="count", kind="event", when=J(U("month", 0, name=12)))]))

S("T35-103", "date-window ordinal past-reading upcoming-reading open-span count",
  T("what did i have on the 2nd that wasn't cancelled", rows("lab_1102"),
    ref=[ans(kind="event", where="status != cancelled", when=J(D("2026-11-02")))]),
  T("and what's on the 8th", rows("swim_1208", "health_check"),
    ref=[ans(kind="event", when=J(D("2026-12-08")))]),
  T("how many events from the 23rd on", val(21),
    ref=[ans(op="count", kind="event", when=J({"from": D("2026-11-23")}))]))

S("T35-104", "date-window past-perfect-count since year-arithmetic duration-longer-than repair-unit",
  T("how many wednesday races have i done since september", val(4),
    ref=[ans(op="count", kind="event", name="wednesday race", when=J({"from": U("month", 0, name=9)}), where="status != cancelled")]),
  T("which documents are from two years ago", rows("custody", "boat_reg", "heat_manual"),
    ref=[ans(kind="document", when=J(U("year", -2)))]),
  T("anything this month that's longer than three hours", rows("ski_jonas", "polar_party"),
    ref=[bad(ans(kind="event", when=J(U("month", 0)), where="duration > 3 hours")),
         ans(kind="event", when=J(U("month", 0)), where="duration > 180 minutes")]))

S("T35-105", "date-window time-of-day narrowing pick no-when",
  T("what's on tomorrow that isn't cancelled", rows("cod_team", "handover_1113"),
    ref=[ans(kind="event", where="status != cancelled", when=J(U("day", 1)))]),
  T("the morning one", rows("cod_team"),
    ref=[ans(rows="$cod_team")]),
  T("push the coffee with kjersti back an hour", ask("coffee_kjersti", "coffee_kjersti_old"),
    ref=[act("reschedule", kind="event", name="coffee with kjersti", args=lines(to=U("hour", 1, anchor="row")))]),
  T("any open tasks for the bergen flight", rows("pack_xmas"),
    ref=[ans(kind="task", linked_to="$fly_bergen", where="status = open"),
         ans(kind="task", name="bergen", where="status = open")]))


# ---- mixed -----------------------------------------------------------------------------------

S("T35-106", "mixed rename quoted-span edit-name",
  T('can you rename the heat pump filter task to "filter and vents", doing both',
    diff(upd("heat_pump", name="filter and vents")),
    ref=[act("edit", kind="task", name="heat pump filter", args=lines(name="filter and vents"))]),
  T("and bring back the team lunch from the trash", diff(restore("old_lunch")),
    ref=[find(kind="event", name="team lunch", trashed=True), act("restore", rows="@prev")]))

S("T35-107", "mixed body-append note open-then-edit",
  T('add "buy a spare headlamp" to the polar night plans note',
    diff(upd("polar_notes", body=has("sunrise lamp", "aurora trip", "spare headlamp"))),
    ref=[opn("$polar_notes"),
         act("edit", rows="$polar_notes",
             args=lines(body="sunrise lamp at 7, vitamin D, one outdoor evening a week, aurora trip with Gunnhild, buy a spare headlamp"))]),
  T("is the old kayak idea still in the trash", rows("old_idea"),
    ref=[ans(kind="note", name="kayak", trashed=True)]))

S("T35-108", "mixed settle_up amount person group",
  T("bjorn gave me 1000 towards the kitty, settle that", diff(upd("bjorn", balance=ANY), settle=[("Bjorn Nilsen", "1000.00")]),
    ref=[act("settle_up", rows="$bjorn", args=lines(group="$seilklubb", amount="1000"))]))

S("T35-109", "mixed read kind-word-decides cod photos notes documents",
  T("the cod photos from this year", rows("p_field_cod"),
    ref=[ans(kind="photo", name="cod", when=J(U("year", 0)))]),
  T("and the cod notes", rows("lab_cod1", "lab_cod2", "lab_seminar"),
    ref=[ans(kind="note", name="cod")]),
  T("any cod documents", rows("cruise_plan"),
    ref=[ans(kind="document", name="cod")]),
  T("and the photos from the kiel regatta", rows("p_kiel_fleet", "p_kiel_dinner"),
    ref=[ans(kind="photo", linked_to="$kiel_regatta"),
         ans(kind="photo", name="kiel")]))

S("T35-110", "mixed date-argument weekday-and-clock one-phrase reschedule create",
  T("could you move the car service to next thursday at 9", diff(upd("car_service", date="2026-11-19T09:00")),
    ref=[act("reschedule", kind="event", name="car service", args=lines(to=U("week", 1, weekday=4, time="09:00")))]),
  T("put lunch with kjersti on wednesday at 12", diff(new("event", name=has("lunch", "kjersti"), date="2026-11-18T12:00")),
    ref=[act("create", args=lines(kind="event", name="Lunch with Kjersti", date=U("week", 1, weekday=3, time="12:00")))]))
