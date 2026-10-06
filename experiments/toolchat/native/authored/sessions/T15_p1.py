from gold import *
import json
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
LIVE = 'status = "open"'
OWE = 'direction = "i_owe" and status = "open"'
LIVE_EV = 'status != "cancelled"'
def next_vet():
    return find(kind="event", name="Vet", when=W({"from": U("day", 0)}), order="date asc", limit=1)
def boulder():
    return find(kind="event", name="Bouldering night", when=W({"from": U("day", 0)}))
def settled(gold, d):
    """a read gold after a settle_up in the same turn: gold.py's `also=` keeps only the row/link
    diff, so the settlement check is carried over by hand"""
    gold = dict(gold, diff=d["diff"])
    gold["settle"] = d["settle"]
    return gold
def J(d):
    return json.dumps(d, separators=(",", ":"))
WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))


S("T15-001-P", "event read cancel prev date para",
  T("what time is my haircut", rows("haircut"),
    ref=[ans(kind="event", name="Haircut")]),
  T("jonas says he'll do it, so cancel it", diff(upd("haircut", status="cancelled")),
    ref=[act("cancel", rows="@prev")]),
  T("what's booked on the twelfth", rows("kiel_call", "vet_1112"),
    ref=[ans(kind="event", when=W(D("2026-11-12")), where='status != "cancelled"')]))

S("T15-006-P", "reschedule event multi read para",
  T("car service and dentist, an hour later for both",
    diff(upd("car_service", date="2026-11-19T09:00"), upd("dentist", date="2026-11-13T12:00")),
    ref=[act("reschedule", rows="$car_service, $dentist", args=lines(to=U("hour", 1, anchor="row")))]),
  T("friday now, what's on", rows("labmtg_1113", "dentist", "erik_dinner"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=5)))]))

S("T15-011-P", "create document edit new folder para",
  T("new document named Havella cabin allocation", diff(new("document", name="Havella cabin allocation")),
    ref=[act("create", args=lines(kind="document", name="Havella cabin allocation"))]),
  T("it should be called Havella cabin list HV-2611 instead", diff(upd("+1", name="Havella cabin list HV-2611")),
    ref=[act("edit", rows="$c1", args=lines(name="Havella cabin list HV-2611"))]),
  T("put it in the cruise reports folder", diff(link("reports_f", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$reports_f"))]))

S("T15-019-P", "create notebook edit new add_to para",
  T("start a notebook named Cruise log HV-2611", diff(new("notebook", name="Cruise log HV-2611")),
    ref=[act("create", args=lines(kind="notebook", name="Cruise log HV-2611"))]),
  T("make that Cruise log HV-2611 Havella", diff(upd("+1", name="Cruise log HV-2611 Havella")),
    ref=[act("edit", rows="$c1", args=lines(name="Cruise log HV-2611 Havella"))]),
  T("station ideas note goes into it", diff(link("+1", "cruise_plan_note")),
    ref=[act("add_to", kind="note", name="station ideas", args=lines(to="$c1"))]))

S("T15-025-P", "linked_to all tasks para",
  T("tasks involving hallvard and erik nilsen together", rows("cruise_plan"),
    ref=[ans(kind="task", linked_to="$hallvard, $erik_n")]),
  T("wednesday for that one", diff(upd("cruise_plan", date="2026-11-11T12:00")),
    ref=[act("reschedule", rows="$cruise_plan", args=lines(to=U("week", 0, weekday=3, time="12:00")))]))

S("T15-030-P", "bouldering open span cancel span duration people para",
  T("bouldering nights from next monday onwards", rows("boulder_1117", "boulder_1215"),
    ref=[ans(kind="event", name="Bouldering night", when=W({"from": U("week", 1, weekday=1)}))]),
  T("marte's defence party is that night, so cancel the first one", diff(upd("boulder_1117", status="cancelled")),
    ref=[act("cancel", rows="$boulder_1117")]),
  T("next monday to friday lunchtime, what's on",
    rows("survival", "boulder_1117", "defence", "plan_1118", "car_service", "agm", "labmtg_1120", "drill"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=5, time="12:00"))))]),
  T("those lasting an hour and a half", rows("plan_1118"),
    ref=[ans(within="@prev", where="duration = 90")]),
  T("attendees for it?", rows("erik_n", "hallvard", "tor"),
    ref=[ans(kind="person", linked_to="$plan_1118")]))

S("T15-035-P", "task span effort reschedule para",
  T("due from the twelfth through next friday",
    rows("formalin", "station_log", "marte_ch", "report", "send_report", "firewood", "snow_shovel", "gloves", "tap",
         "rope", "cruise_plan", "suit", "freezer", "agenda", "crew_list", "ctd", "present", "nets", "jars", "claim",
         "batteries", "power_11"),
    ref=[ans(kind="task", when=W(span(D("2026-11-12"), U("week", 1, weekday=5))))]),
  T("from those, two hours or longer", rows("marte_ch", "report", "ctd", "jars"),
    ref=[ans(within="@prev", where="effort >= 120")]),
  T("label sample jars should be next thursday", diff(upd("jars", date="2026-11-19")),
    ref=[act("reschedule", kind="task", name="Label sample jars", args=lines(to=U("week", 1, weekday=4)))]),
  T("ctd calibration, is it in progress", rows("ctd"),
    ref=[ans(kind="task", name="Calibrate CTD sensors")]))

S("T15-042-P", "list area contains task count para",
  T("work lists?", rows("prep_l", "gear_l", "lab_l"),
    ref=[find(kind="list", where='area contains "work"'), ans(rows="@prev")]),
  T("lists holding five tasks or less", rows("climb_l", "gear_l", "shop_l"),
    ref=[ans(kind="list", where="task count <= 5")]))

S("T15-047-P", "debt open span weekday para",
  T("debts from last monday onwards", rows("d_hallvard", "d_silje", "d_jonas_groceries", "d_torstein"),
    ref=[ans(kind="debt", when=W({"from": U("week", -1, weekday=1)}))]),
  T("cut it off at the fifth", rows("d_hallvard", "d_silje"),
    ref=[ans(kind="debt", when=W(span(U("week", -1, weekday=1), D("2026-11-05"))))]))

S("T15-052-P", "create person delete restore new para",
  T("add Oda Lie to contacts, she's a vet nurse at the clinic", diff(new("person", name="Oda Lie", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Oda Lie", role="vet nurse"))]),
  T("i've got the clinic already, get rid of oda lie", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("wait, restore her, it's another clinic", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T15-057-P", "remove_from task prev count list para",
  T("climbing list, any completed ones", rows("club_fee"),
    ref=[ans(kind="task", linked_to="$climb_l", where='status = "completed"')]),
  T("remove that one from the list", diff(unlink("climb_l", "club_fee")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$climb_l"))]),
  T("climbing list count?", val(4),
    ref=[ans(op="count", kind="task", linked_to="$climb_l")]))

S("T15-062-P", "remove_from document where month folder para",
  T("pay and tax shouldn't hold the september payslip, pull it", diff(unlink("pay_f", "pay_sep")),
    ref=[act("remove_from", kind="document", linked_to="$pay_f", when=W(U("month", 0, name=9)),
             args=lines(from_="$pay_f"))]),
  T("kiel data sharing agreement, in which folder", rows("kiel_f"),
    ref=[ans(kind="folder", linked_to="$kiel_dsa")]))

S("T15-068-P", "delete folder multi refused folder ask para",
  T("scans to sort and old applications, get rid of them", diff(gone("scans_f"), gone("apps_f")),
    ref=[act("delete", rows="$scans_f, $apps_f")]),
  T("kiel project as well", ask(),
    ref=[bad(act("delete", rows="$kiel_f")),
         askc("kiel project still has the data sharing agreement in it, so it can't be deleted. move that out first?")]))

S("T15-074-P", "single note body set notebook para",
  T("cabin book notes with some text in them", rows("woodstove", "cabin_rules"),
    ref=[ans(kind="note", linked_to="$cabin_nb", where="body is set")]))

S("T15-080-P", "group currency in substitution refused remove_from ask para",
  T("groups using kroner or euro", rows("mess", "cabin", "climb", "kiel", "whale"),
    ref=[find(kind="group", where='currency in ("NOK", "EUR")'), ans(rows="@prev")]),
  T("swedish ones?", rows("abisko"),
    ref=[ans(kind="group", where='currency = "SEK"')]),
  T("ailo gaup leaves the crew mess fund, remove him", ask(),
    ref=[bad(act("remove_from", rows="$ailo", args=lines(from_="$mess"))),
         askc("ailo still has an unsettled balance in the crew mess fund, so he can't be taken out yet. settle up with him first?")]))

S("T15-085-P", "ambiguous vet cancel ask note overlap repair create para",
  T("pusur's vet appointment is off", ask("vet_1112", "vet_1215"),
    ref=[find(kind="event", name="Pusur"),
         askc("the check on thursday or the vaccination on 15 december?", options="$vet_1112, $vet_1215")]),
  T("we'll do it before the cruise instead, the vaccination one", diff(upd("vet_1215", status="cancelled")),
    ref=[act("cancel", rows="$vet_1215")]),
  T("notes involving ane?", rows("pusur_note"),
    ref=[ans(kind="note", linked_to="$ane")]),
  T("tomorrow 12:30, coffee with ingvild", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Coffee with Ingvild", date=U("day", 1, time="12:30")))),
         askc("you've got lunch with ingvild 12 to 1 tomorrow already. put the coffee at 13:00 instead?")]),
  T("1 works", diff(new("event", name="Coffee with Ingvild", date="2026-11-10T13:00")),
    ref=[act("create", args=lines(kind="event", name="Coffee with Ingvild", date=U("day", 1, time="13:00")))]))

S("T15-089-P", "locker url notes contains trashed note recovery restore window para",
  T("login for https://cruise.havella.no, which one", rows("cruise_portal"),
    ref=[find(kind="locker item", where='url = "https://cruise.havella.no"'), ans(rows="@prev")]),
  T("the one with sea ice in its notes", rows("copernicus"),
    ref=[ans(kind="locker item", where='notes contains "sea ice"')]),
  T("packing list 2025 note, still exists?", rows("old_packing"),
    ref=[ans(kind="note", name="Packing list 2025"),
         ans(kind="note", name="Packing list 2025", trashed=True)]),
  T("restore it, cruise needs it", ask(),
    ref=[bad(act("restore", rows="$old_packing")),
         askc("it's been in the bin since july, past the 30 days, so it can't come back. start a new packing list note?")]))

S("T15-095-P", "task open to weekday repair within priority para",
  T("open stuff due by thursday next week",
    rows("present", "cat_food", "kiel_reply", "ctd_profiles", "call_mum", "formalin", "station_log", "marte_ch", "report",
         "send_report", "firewood", "snow_shovel", "gloves", "tap", "rope", "cruise_plan", "suit", "freezer", "agenda",
         "crew_list"),
    ref=[bad(ans(kind="task", when=W({"to": {"weekday": 4}}), where='status = "open"')),
         ans(kind="task", when=W({"to": U("week", 1, weekday=4)}), where='status = "open"')]),
  T("priority one among them", rows("formalin", "report", "cruise_plan", "present"),
    ref=[ans(within="@prev", where="priority = 1")]))

S("T15-A001-P", "ask-options event reschedule never_mind c3a para",
  T("planning meeting at 2 instead", ask("plan_1111", "plan_1118"),
    ref=[act("reschedule", kind="event", name="Cruise planning meeting", args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         find(kind="event", name="Cruise planning meeting", when=J({"from": U("day", 0)})),
         askc("The one on 11 Nov or the one on 18 Nov?", options="$plan_1111, $plan_1118")]),
  T("leave it be, captain's moved it already", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T15-A009-P", "follow-up c3a para",
  T("money people owe me", rows("d_jonas_vet", "d_linnea", "d_erik_j", "d_silje", "d_anders", "d_marianne"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("over 300 from those", rows("d_jonas_vet", "d_erik_j", "d_anders"),
    ref=[ans(within="@prev", where="amount > 300 NOK")]),
  T("largest?", rows("d_anders"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T15-B005-P", "c4b state-change cancel event restore trashed task para",
  T("vet check got cancelled, ane rang", diff(upd("vet_1112", status="cancelled")),
    ref=[act("cancel", kind="event", name="Vet check")]),
  T("snow chains one, bring it back", diff(restore("chains")),
    ref=[act("restore", kind="task", name="snow chains", trashed=True)]))

S("T15-C003-P", "c3c compound cancel reschedule event task bare weekday para",
  T("cat food moves to friday, and the vet check for pusur gets cancelled",
    diff(upd("vet_1112", status="cancelled"), upd("cat_food", date="2026-11-13")),
    ref=[act("cancel", kind="event", name="Vet check for Pusur", more=True),
         act("reschedule", kind="task", name="Buy cat food for Pusur", args=lines(to=U("week", 0, weekday=5)))]))

S("T15-108-P", "ask-options task reschedule next-weekday weekday at-n para",
  T("report goes to next monday", ask("report", "send_report"),
    ref=[act("reschedule", kind="task", name="report", args=lines(to=U("week", 1, weekday=1))),
         askc("Write cruise report HV-2610 or send report to Hallvard?", options="$report, $send_report")]),
  T("the writing one", diff(upd("report", date="2026-11-16")),
    ref=[act("reschedule", rows="$report", args=lines(to=U("week", 1, weekday=1)))]),
  T("friday at 3 for the formalin order", diff(upd("formalin", date="2026-11-13T15:00")),
    ref=[act("reschedule", kind="task", name="Order formalin", args=lines(to=U("week", 0, weekday=5, time="15:00")))]))

S("T15-114-P", "ask-options task complete order para",
  T("order arrived, complete it", ask("formalin", "firewood", "bulb"),
    ref=[act("complete", kind="task", name="Order"),
         askc("Order formalin, order firewood for the cabin or order microscope bulb?",
              options="$formalin, $firewood, $bulb")]),
  T("the firewood one", diff(upd("firewood", status="completed", completed=ANY)),
    ref=[act("complete", rows="$firewood")]),
  T("formalin's on its way, complete it as well", diff(upd("formalin", status="completed", completed=ANY)),
    ref=[act("complete", rows="$formalin")]),
  T("this weekend's plans?", rows("aurora", "whale_trip", "mum_call"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]))

S("T15-119-P", "balance people repair where-name para",
  T("anders, what's he owe me", val((1200, "NOK")),
    ref=[ans(op="balance", rows="$anders")]),
  T("and silje", val((380, "NOK")),
    ref=[ans(op="balance", rows="$silje")]),
  T("tasks with formalin in their name", rows("formalin"),
    ref=[bad(ans(kind="task", where='name contains "formalin"')),
         ans(kind="task", name="formalin")]),
  T("sauna money came from silje, mark it settled", diff(upd("d_silje", status="settled")),
    ref=[search("sauna", kind="debt"),
         act("settle_debt", kind="debt", name="Sauna tickets")]))
