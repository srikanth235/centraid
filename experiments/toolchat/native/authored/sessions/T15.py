from gold import *
import json

world("T15", "2026-11-09T10:15", "Ingrid Solberg", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T15-001", "event read cancel prev date",
  T("when's my haircut", rows("haircut"),
    ref=[ans(kind="event", name="Haircut")]),
  T("cancel it, jonas says he'll do it", diff(upd("haircut", status="cancelled")),
    ref=[act("cancel", rows="@prev")]),
  T("what's on for the twelfth", rows("kiel_call", "vet_1112"),
    ref=[ans(kind="event", when=W(D("2026-11-12")), where='status != "cancelled"')]))

S("T15-002", "single complete task named",
  T("seminar slides are done", diff(upd("slides", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="seminar slides")]))

S("T15-003", "log multi undo ledger",
  T("had coffee with marte and sofie this morning", diff(upd("marte", date=ANY), upd("sofie", date=ANY)),
    ref=[act("log", rows="$marte, $sofie", args=lines(kind="coffee"))]),
  T("undo that, it was friday actually", diff(),
    ref=[act("undo")]))

S("T15-004", "refused remove_from person ask settle_up group balance",
  T("take linnea off the crew mess fund, she's not on the next cruise", ask(),
    ref=[bad(act("remove_from", rows="$linnea", args=lines(from_="$mess"))),
         askc("linnea still has an unsettled balance in the crew mess fund, so she can't come off it yet. settle up with her?")]),
  T("yeah settle up with her", diff(settle=[("Linnea Holm", "340.00")]),
    ref=[act("settle_up", rows="$linnea", args=lines(group="$mess"))]),
  T("so where does she stand in the fund", val((230, "NOK")),
    ref=[ans(op="balance", kind="group", name="Crew mess fund", linked_to="$linnea")]))

S("T15-006", "reschedule event multi read",
  T("move the car service and the dentist an hour later",
    diff(upd("car_service", date="2026-11-19T09:00"), upd("dentist", date="2026-11-13T12:00")),
    ref=[act("reschedule", rows="$car_service, $dentist", args=lines(to=U("hour", 1, anchor="row")))]),
  T("what's on friday now", rows("labmtg_1113", "dentist", "erik_dinner"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=5)))]))

S("T15-007", "complete multi tasks list read",
  T("bought the thermal gloves and the wool socks", diff(upd("gloves", status="completed", completed=ANY),
                                                         upd("socks", status="completed", completed=ANY)),
    ref=[act("complete", rows="$gloves, $socks")]),
  T("anything else left on the shopping list", rows("batteries", "present"),
    ref=[ans(kind="task", linked_to="$shop_l", where='status = "open"')]),
  T("the headlamp ones too, grabbed them at the same time", diff(upd("batteries", status="completed", completed=ANY)),
    ref=[act("complete", rows="$batteries")]))

S("T15-008", "remove_from task prev list",
  T("what's on the cruise gear list", rows("gloves", "jars", "suit", "boots"),
    ref=[ans(kind="task", linked_to="$gear_l")]),
  T("which of those are done", rows("boots"),
    ref=[ans(within="@prev", where='status = "completed"')]),
  T("take it off the list", diff(unlink("gear_l", "boots")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$gear_l"))]))

S("T15-009", "edit note where pin",
  T("pin the note that mentions imagej", diff(upd("lipid", pinned=True)),
    ref=[act("edit", kind="note", where='body contains "ImageJ"', args=lines(pinned="yes")),
         ]),
  T("what else is pinned", rows("st12", "fixation", "waffles"),
    ref=[ans(kind="note", where="pinned = yes", exclude="$lipid")]))

S("T15-010", "create note add_to remove_from new",
  T("note: Winch check - grease the drum before station 1",
    diff(new("note", name=has("Winch"), body=has("grease"))),
    ref=[act("create", args=lines(kind="note", name="Winch check", body="grease the drum before station 1"))]),
  T("put it in the cruise log", diff(link("cruise_nb", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$cruise_nb"))]),
  T("hm no, that's the old cruise. take it back out", diff(unlink("cruise_nb", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$cruise_nb"))]))

S("T15-011", "create document edit new folder",
  T("add a doc called Havella cabin allocation", diff(new("document", name="Havella cabin allocation")),
    ref=[act("create", args=lines(kind="document", name="Havella cabin allocation"))]),
  T("rename it Havella cabin list HV-2611", diff(upd("+1", name="Havella cabin list HV-2611")),
    ref=[act("edit", rows="$c1", args=lines(name="Havella cabin list HV-2611"))]),
  T("and file it with the cruise reports", diff(link("reports_f", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$reports_f"))]))

S("T15-012", "unstar document multi starred",
  T("which docs have i starred", rows("medical_cert", "stcw", "cabin_agreement", "home_ins", "vaccine_card"),
    ref=[find(kind="document", where="starred = yes"), ans(rows="@prev")]),
  T("unstar the stcw one and the home insurance", diff(upd("stcw", starred=False), upd("home_ins", starred=False)),
    ref=[act("unstar", rows="$stcw, $home_ins")]))

S("T15-014", "unstar photo named starred count",
  T("unstar the walrus pic", diff(already=["p_walrus"]),
    ref=[act("unstar", rows="$p_walrus"), ans(rows="$p_walrus")]),
  T("ok the ivory gull", diff(upd("p_gull", starred=False)),
    ref=[act("unstar", rows="$p_gull")]),
  T("how many starred photos", val(7),
    ref=[ans(op="count", kind="photo", where="starred = yes")]))

S("T15-015", "remove_from photo named album",
  T("take firewood stacked out of the lyngen cabin album", diff(unlink("cabin_al", "p_woodpile")),
    ref=[act("remove_from", rows="$p_woodpile", args=lines(from_="$cabin_al"))]),
  T("what's left in there", rows("p_aurora3", "p_cabin_snow"),
    ref=[ans(kind="photo", linked_to="$cabin_al")]))

S("T15-018", "unstar locker multi starred",
  T("what's starred in my locker", rows("uit_login", "visa", "dnt"),
    ref=[find(kind="locker item", where="starred = yes"), ans(rows="@prev")]),
  T("unstar the visa and dnt ones", diff(upd("visa", starred=False), upd("dnt", starred=False)),
    ref=[act("unstar", rows="$visa, $dnt")]))

S("T15-019", "create notebook edit new add_to",
  T("new notebook Cruise log HV-2611", diff(new("notebook", name="Cruise log HV-2611")),
    ref=[act("create", args=lines(kind="notebook", name="Cruise log HV-2611"))]),
  T("call it Cruise log HV-2611 Havella", diff(upd("+1", name="Cruise log HV-2611 Havella")),
    ref=[act("edit", rows="$c1", args=lines(name="Cruise log HV-2611 Havella"))]),
  T("and move my station ideas note into it", diff(link("+1", "cruise_plan_note")),
    ref=[act("add_to", kind="note", name="station ideas", args=lines(to="$c1"))]))

S("T15-020", "delete folder multi empty refused",
  T("which folders have nothing in them", rows("apps_f", "scans_f"),
    ref=[find(kind="folder", where="document count = 0"), ans(rows="@prev")]),
  T("delete both", diff(gone("apps_f"), gone("scans_f")),
    ref=[act("delete", rows="$apps_f, $scans_f")]))

S("T15-021", "where role in people",
  T("who are the deckhands and the bosun", rows("ailo", "linnea", "bjorn"),
    ref=[find(kind="person", where='role in ("deckhand", "bosun")'), ans(rows="@prev")]),
  T("log a coffee with ailo, we met at the quay", diff(upd("ailo", date=ANY)),
    ref=[act("log", rows="$ailo", args=lines(kind="coffee"))]))

S("T15-023", "compute max group",
  T("biggest open debt each way, what i owe and what i'm owed",
    vgroups({"owes_me": (1200, "NOK"), "i_owe": (2000, "NOK")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"), ans(value="@prev")]))

S("T15-024", "already complete ambiguous task",
  T("mark the seafarer medical as done", diff(upd("med_new", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Renew seafarer medical")]),
  T("and the september one too", diff(already=["med_old"]),
    ref=[find(kind="task", name="Renew seafarer medical"),
         act("complete", rows="$med_old"), ans(rows="$med_old")]))

S("T15-025", "linked_to all tasks",
  T("what tasks have i got with both hallvard and erik nilsen on them", rows("cruise_plan"),
    ref=[ans(kind="task", linked_to="$hallvard, $erik_n")]),
  T("push that to wednesday", diff(upd("cruise_plan", date="2026-11-11T12:00")),
    ref=[act("reschedule", rows="$cruise_plan", args=lines(to=U("week", 0, weekday=3, time="12:00")))]))

X("T15-011",
  T("undo that, wrong folder", diff(unlink("reports_f", "+1")),
    ref=[act("undo")]))
