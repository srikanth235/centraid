from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


def settled(gold, d):
    """a read gold after a settle_up in the same turn: gold.py's `also=` keeps only the row/link
    diff, so the settlement check is carried over by hand"""
    gold = dict(gold, diff=d["diff"])
    gold["settle"] = d["settle"]
    return gold


S("T15-051", "trashed person recovery restore prev add_to group members",
  T("find kristoffer dahl", rows("kristoffer"),
    ref=[ans(kind="person", name="Kristoffer Dahl"),
         ans(kind="person", name="Kristoffer Dahl", trashed=True)]),
  T("put kristoffer dahl back in my contacts", diff(restore("kristoffer")),
    ref=[act("restore", rows="@prev")]),
  T("and add him to whale safari, he's coming", diff(link("whale", "kristoffer")),
    ref=[act("add_to", rows="$kristoffer", args=lines(to="$whale"))]),
  T("who's on whale safari", rows("silje", "ingvild", "me", "kristoffer"),
    ref=[ans(kind="person", linked_to="$whale")]))

S("T15-052", "create person delete restore new",
  T("new contact: Oda Lie, vet nurse at the clinic", diff(new("person", name="Oda Lie", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Oda Lie", role="vet nurse"))]),
  T("delete oda lie, i already have the clinic", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("no wait, restore her. different clinic", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T15-053", "settle_up where role write read balance log",
  T("settle up with the bosun in the crew mess fund and tell me where we stand",
    settled(val((0, "NOK")), diff(settle=[("Bjørn Strand", "200.00")])),
    ref=[act("settle_up", kind="person", where='role = "bosun"', args=lines(group="$mess"), more=True),
         ans(op="balance", rows="$bjorn")]),
  T("log a visit with bjørn strand too, saw him on the quay", diff(upd("bjorn", date=ANY)),
    ref=[act("log", rows="$bjorn", args=lines(kind="visit"))]))

S("T15-054", "reschedule event multi minutes tomorrow people",
  T("push lunch with ingvild and the seminar talk back half an hour",
    diff(upd("lunch_ingvild", date="2026-11-10T12:30"), upd("seminar", date="2026-11-10T14:45")),
    ref=[act("reschedule", rows="$lunch_ingvild, $seminar", args=lines(to=U("minute", 30, anchor="row")))]),
  T("what does tomorrow look like", rows("lunch_ingvild", "seminar", "boulder_1110"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("who's coming to the seminar", rows("geir", "marte", "sofie"),
    ref=[ans(kind="person", linked_to="$seminar")]))

S("T15-055", "event month read cancel prev empty result",
  T("dinner at berit and knut's next month, when is it", rows("bergs_1206"),
    ref=[ans(kind="event", name="Dinner at Berit and Knut's", when=W(U("month", 1)))]),
  T("cancel it, i'm at sea", diff(upd("bergs_1206", status="cancelled")),
    ref=[act("cancel", rows="@prev")]),
  T("any bouldering nights left in while i'm away twenty-third nov to eleventh dec", rows(),
    ref=[ans(kind="event", name="Bouldering night", when=W(span(D("2026-11-23"), D("2026-12-11"))))]))

S("T15-056", "complete multi subtasks write read",
  T("done compile ctd profiles and draft station log summary. what's left on the cruise report",
    rows("send_report", also=diff(upd("ctd_profiles", status="completed", completed=ANY),
                                  upd("station_log", status="completed", completed=ANY))),
    ref=[act("complete", rows="$ctd_profiles, $station_log", more=True),
         find(kind="task", name="cruise report"),
         ans(kind="task", linked_to="@prev", where='status = "open"')]),
  T("tick off send report to hallvard as well", diff(upd("send_report", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Send report to Hallvard")]))

S("T15-057", "remove_from task prev count list",
  T("anything done on the climbing list", rows("club_fee"),
    ref=[ans(kind="task", linked_to="$climb_l", where='status = "completed"')]),
  T("take it off the list", diff(unlink("climb_l", "club_fee")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$climb_l"))]),
  T("how many on the climbing list", val(4),
    ref=[ans(op="count", kind="task", linked_to="$climb_l")]))

S("T15-058", "edit note where when notes span month name",
  T("rename the note from yesterday to Pusur limp - vet thursday", diff(upd("pusur_note", name="Pusur limp - vet thursday")),
    ref=[act("edit", kind="note", when=W(U("day", -1)), args=lines(name="Pusur limp - vet thursday"))]),
  T("notes from last month through end of november",
    rows("wishlist", "kiel_note", "waffles", "st12", "st19", "storm", "lapskaus", "ice_edge", "christmas_note",
         "gift_ideas", "debrief_note", "agm_note", "cruise_plan_note", "lipid", "seminar_notes", "lyngen_ice",
         "pusur_note"),
    ref=[ans(kind="note", when=W(span(U("month", -1), U("month", 0, name=11))))]))

S("T15-059", "create note in notebook remove_from new count",
  T("new note in galley recipes: Fish soup - cod, cream, leeks, a splash of white wine",
    diff(new("note", name=has("Fish soup"), body=has("cod")), link("galley_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Fish soup", body="cod, cream, leeks, a splash of white wine",
                                  notebook="$galley_nb"))]),
  T("take it out of galley recipes, it's jonas's recipe not svein's", diff(unlink("galley_nb", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$galley_nb"))]),
  T("how many notes are in galley recipes", val(2),
    ref=[ans(op="count", kind="note", linked_to="$galley_nb")]))

S("T15-060", "create document folder edit new folder read",
  T("save a doc called Tyre hotel receipt spring in home and car",
    diff(new("document", name="Tyre hotel receipt spring"), link("home_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Tyre hotel receipt spring", folder="$home_f"))]),
  T("sorry, rename it Tyre hotel receipt 2026", diff(upd("+1", name="Tyre hotel receipt 2026")),
    ref=[act("edit", rows="$c1", args=lines(name="Tyre hotel receipt 2026"))]),
  T("what's in home and car", rows("car_ins", "home_ins", "+1"),
    ref=[ans(kind="document", linked_to="$home_f")]))

S("T15-061", "unstar document multi write read already star",
  T("unstar the seafarer medical certificate and the cabin share agreement, then tell me what's starred",
    rows("stcw", "home_ins", "vaccine_card",
         also=diff(upd("medical_cert", starred=False), upd("cabin_agreement", starred=False))),
    ref=[act("unstar", rows="$medical_cert, $cabin_agreement", more=True),
         ans(kind="document", where="starred = yes")]),
  T("star pusur vaccination card", diff(already=["vaccine_card"]),
    ref=[act("star", rows="$vaccine_card"), ans(rows="$vaccine_card")]))

S("T15-062", "remove_from document where month folder",
  T("pull the september payslip out of pay and tax", diff(unlink("pay_f", "pay_sep")),
    ref=[act("remove_from", kind="document", linked_to="$pay_f", when=W(U("month", 0, name=9)),
             args=lines(from_="$pay_f"))]),
  T("which folder is the kiel data sharing agreement in", rows("kiel_f"),
    ref=[ans(kind="folder", linked_to="$kiel_dsa")]))

S("T15-063", "unstar photo named remove_from photo named count album",
  T("unstar abisko tracks", diff(upd("p_abisko", starred=False)),
    ref=[act("unstar", rows="$p_abisko")]),
  T("and take ice edge at dawn out of best of 2026", diff(unlink("best_al", "p_ice_edge")),
    ref=[act("remove_from", rows="$p_ice_edge", args=lines(from_="$best_al"))]),
  T("how many in best of 2026", val(4),
    ref=[ans(op="count", kind="photo", linked_to="$best_al")]))

S("T15-065", "delete locker where undo delete",
  T("delete the document type thing in my locker", diff(trash("boat_licence")),
    ref=[act("delete", kind="locker item", where='type = "document"')]),
  T("undo, i need that for the rib course", diff(restore("boat_licence")),
    ref=[act("undo")]))

S("T15-066", "unstar locker multi starred",
  T("unstar uit login and dnt membership", diff(upd("uit_login", starred=False), upd("dnt", starred=False)),
    ref=[act("unstar", rows="$uit_login, $dnt")]),
  T("what's starred in there", rows("visa"),
    ref=[ans(kind="locker item", where="starred = yes")]))

S("T15-067", "create notebook edit new add_to",
  T("make a notebook called Night series", diff(new("notebook", name="Night series")),
    ref=[act("create", args=lines(kind="notebook", name="Night series"))]),
  T("rename it Night series HV-2611", diff(upd("+1", name="Night series HV-2611")),
    ref=[act("edit", rows="$c1", args=lines(name="Night series HV-2611"))]),
  T("and put hv-2611 station ideas in it", diff(link("+1", "cruise_plan_note")),
    ref=[act("add_to", rows="$cruise_plan_note", args=lines(to="$c1"))]))

S("T15-068", "delete folder multi refused folder ask",
  T("delete scans to sort and old applications", diff(gone("scans_f"), gone("apps_f")),
    ref=[act("delete", rows="$scans_f, $apps_f")]),
  T("and kiel project", ask(),
    ref=[bad(act("delete", rows="$kiel_f")),
         askc("kiel project still has the data sharing agreement in it, so it can't be deleted. move that out first?")]))

S("T15-069", "compute max group priority order limit",
  T("biggest open job at each priority level",
    vgroups({"none": 180, "1": 300, "2": 60, "3": 60}),
    ref=[comp(op="max", field="effort", kind="task", where='status = "open"',
              group="priority"),
         ans(value="@prev")]),
  T("which one is the biggest priority one", rows("report"),
    ref=[ans(kind="task", where='priority = 1 and status = "open"', order="effort desc", limit=1)]))

S("T15-070", "task open spans to date reschedule people",
  T("what's open that's due by friday",
    rows("cat_food", "kiel_reply", "call_mum", "ctd_profiles", "formalin", "station_log", "marte_ch", "report", "send_report"),
    ref=[ans(kind="task", when=W({"to": U("week", 0, weekday=5)}), where='status = "open"')]),
  T("and by thursday 6pm", rows("cat_food", "kiel_reply", "call_mum", "ctd_profiles", "formalin", "station_log", "marte_ch"),
    ref=[ans(kind="task", when=W({"to": U("week", 0, weekday=4, time="18:00")}), where='status = "open"')]),
  T("what's due from thursday noon to sunday",
    rows("formalin", "station_log", "marte_ch", "report", "send_report", "firewood", "snow_shovel", "gloves", "tap", "rope"),
    ref=[ans(kind="task", when=W(span(U("week", 0, weekday=4, time="12:00"), U("week", 0, weekday=7))))]),
  T("fix the bathroom tap, who's on that", rows("jonas"),
    ref=[ans(kind="person", linked_to="$tap")]),
  T("push fix the bathroom tap to next saturday", diff(upd("tap", date="2026-11-21")),
    ref=[act("reschedule", rows="$tap", args=lines(to=U("week", 1, weekday=6)))]))

S("T15-071", "document span month name trashed restore add_to",
  T("docs from september up to last wednesday", rows("report_09", "pay_sep", "kiel_dsa", "pay_oct", "cabin_invoice"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=9), U("week", -1, weekday=3))))]),
  T("is cruise plan hv-2611 v1 in the trash", rows("plan_v1"),
    ref=[ans(kind="document", name="Cruise plan HV-2611 v1", trashed=True)]),
  T("restore it", diff(restore("plan_v1")),
    ref=[act("restore", rows="$plan_v1")]),
  T("and file it under cruise reports", diff(link("reports_f", "plan_v1")),
    ref=[act("add_to", rows="$plan_v1", args=lines(to="$reports_f"))]))

S("T15-072", "photo span delete undo albums",
  T("photos from first nov 10pm up to today",
    rows("p_aurora1", "p_boulder", "p_sauna", "p_pusur_window", "p_seminar", "p_cabin_snow", "p_aurora3", "p_fjord"),
    ref=[ans(kind="photo", when=W(span(D("2026-11-01", "22:00"), U("day", 0))))]),
  T("delete aurora at the cabin", diff(trash("p_aurora3"), unlink("aurora_al", "p_aurora3"), unlink("cabin_al", "p_aurora3")),
    ref=[act("delete", rows="$p_aurora3")]),
  T("no undo that, torstein likes it", diff(restore("p_aurora3"), link("aurora_al", "p_aurora3"), link("cabin_al", "p_aurora3")),
    ref=[act("undo")]))

S("T15-074", "single note body set notebook",
  T("which notes in the cabin book actually have text in them", rows("woodstove", "cabin_rules"),
    ref=[ans(kind="note", linked_to="$cabin_nb", where="body is set")]))

S("T15-075", "debt amount set sum date settle prev",
  T("debts i owe, anything with an amount on it",
    rows("d_jonas_groceries", "d_torstein", "d_hallvard", "d_kaja", "d_mum"),
    ref=[ans(kind="debt", where='amount is set and direction = "i_owe"')]),
  T("what's that all together", val((3455, "NOK")),
    ref=[ans(op="sum", field="amount", within="@prev")]),
  T("anything from seventh november", rows("d_torstein"),
    ref=[ans(kind="debt", when=W(D("2026-11-07")))]),
  T("settle that one, paid tosse on the ferry", diff(upd("d_torstein", status="settled")),
    ref=[act("settle_debt", rows="@prev")]))

X("T15-062",
  T("where's the polarfeed contract", decline("not_found"),
    ref=[search("Polarfeed"), dec("not_found")]))

X("T15-075",
  T("smallest open debt each way", vgroups({"i_owe": (95, "NOK"), "owes_me": (75, "NOK")}),
    ref=[comp(op="min", field="amount", kind="debt", where='status = "open"', group="direction"), ans(value="@prev")]))
