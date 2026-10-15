from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T11-076", "seven turns long events person count event count log docs",
  T("which events next week are three hours or more", rows("tb_test", "hoof", "show"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="duration >= 180")]),
  T("of those which have more than one person going", rows("show"),
    ref=[ans(within="@prev", where="person count > 1")]),
  T("who's down for the show", rows("declan", "aoife", "cian", "roisin"),
    ref=[ans(kind="person", linked_to="$show")]),
  T("which of the advisers have i one meeting or less with", rows("deirdre"),
    ref=[ans(kind="person", where='role contains "adviser" and event count <= 1')]),
  T("log a call with her, she rang about the loan", diff(upd("deirdre", date=ANY)),
    ref=[act("log", rows="@prev", args=lines(kind="call"))]),
  T("when was the AIB loan meeting", rows("bank"),
    ref=[ans(kind="event", name="AIB loan meeting")]),
  T("any docs from that day", rows("loan_offer"),
    ref=[ans(kind="document", when=W(D("2026-07-21")))]))

S("T11-077", "six turns find-only subtasks ordinal reschedule anchor task count effort complete",
  T("is there a task for the tb test", rows("tb_prep"),
    ref=[find(kind="task", name="TB test"),
         ans(rows="@prev")]),
  T("what's under it", rows("tb_pen", "tb_tags"),
    ref=[ans(kind="task", linked_to="$tb_prep")]),
  T("the second one, make it 7 that evening", diff(upd("tb_pen", date="2026-07-27T19:00")),
    ref=[act("reschedule", rows="$tb_pen", args=lines(to=U("day", 0, anchor="row", time="19:00")))]),
  T("farm list jobs with a priority and 2 subtasks or fewer", rows("fence", "calf_shed", "tb_prep", "herd_reg"),
    ref=[ans(kind="task", linked_to="$farm_l", where="priority is set and task count <= 2")]),
  T("which of them are an hour or less", rows("herd_reg"),
    ref=[ans(within="@prev", where="effort <= 60")]),
  T("done that one, emailed fergal", diff(upd("herd_reg", status="completed", completed=ANY)),
    ref=[act("complete", rows="$herd_reg")]))

S("T11-078", "six turns notes open span body != notebook count empty already pinned dead end",
  T("notes since 6am on the twentieth", rows("blank", "quote_note", "orla_tips", "coop_q"),
    ref=[ans(kind="note", when=W({"from": D("2026-07-20", "06:00")}))]),
  T("which have actual text, not tbc", rows("quote_note", "orla_tips", "coop_q"),
    ref=[ans(within="@prev", where='body != "tbc"')]),
  T("are any of them filed in a notebook", rows(),
    ref=[ans(kind="note", within="@prev", where="notebook count > 0")]),
  T("notes from the start of last month to the first of july", rows("min_jun", "calving", "book_list"),
    ref=[ans(kind="note", when=W(span(U("month", -1), D("2026-07-01"))))]),
  T("pin the calving one", rows("calving", also=diff(already=["calving"])),
    ref=[act("edit", rows="$calving", args=lines(pinned="yes")),
         ans(rows="$calving")]),
  T("is there a note about the solar panels", decline("not_found"),
    ref=[ans(kind="note", name="solar panels"),
         search("solar panels"),
         dec("not_found")]))

S("T11-079", "six turns photos album person count starred != star span add_to count",
  T("which photos in the farm album have one person or nobody in them",
    rows("p_angus", "p_silage1", "p_parlour", "p_sunset", "p_herd_lane"),
    ref=[ans(kind="photo", linked_to="$farm_al", where="person count <= 1")]),
  T("which of those aren't starred", rows("p_angus", "p_silage1", "p_parlour", "p_herd_lane"),
    ref=[ans(within="@prev", where="starred != yes")]),
  T("star milking parlour at dawn", diff(upd("p_parlour", starred=True)),
    ref=[act("star", kind="photo", name="Milking parlour at dawn")]),
  T("hurling photos from june first to the end of july",
    rows("p_cian_goal", "p_u12_team", "p_cian_helmet", "p_tadhg_speech"),
    ref=[ans(kind="photo", linked_to="$hurling_al", when=W(span(D("2026-06-01"), U("month", 0, name=7))))]),
  T("add cian in the new helmet to family", diff(link("family_al", "p_cian_helmet")),
    ref=[act("add_to", kind="photo", name="Cian in the new helmet", args=lines(to="$family_al"))]),
  T("how many in family", val(6),
    ref=[ans(op="count", kind="photo", linked_to="$family_al")]))

S("T11-080", "five turns locker url empty username reveal create remove_from new",
  T("starred locker things with no website", rows("debit", "icmsa"),
    ref=[ans(kind="locker item", where="starred = yes and url is empty")]),
  T("any logins with farm in the username", rows("aib"),
    ref=[ans(kind="locker item", where='type = "login" and username contains "farm"')]),
  T("what's the password on it", diff(reveal=[("aib", "Clover-Meadow-88")]),
    ref=[act("reveal", rows="$aib", args=lines(field="password"))]),
  T("add a task to change the aib password, on the paperwork list",
    diff(new("task", name=has("password")), link("paper_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Change the AIB password", list="$paper_l"))]),
  T("no take it off the list, its not paperwork", diff(unlink("paper_l", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$paper_l"))]))

S("T11-083", "single ask without options",
  T("move the accounts meeting", ask(),
    ref=[askc("to when?")]))

S("T11-084", "single delete empty folder",
  T("delete the old tractor folder, sold it years ago", diff(gone("tractor_f")),
    ref=[act("delete", kind="folder", name="Old tractor")]))

S("T11-085", "single decline out of scope",
  T("will it rain in ennis tomorrow", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T11-086", "single empty answer name miss",
  T("any note on the drainage grant", decline("not_found"),
    ref=[ans(kind="note", name="drainage grant")]))

S("T11-087", "folder count trashed doc restore refused folder delete ask",
  T("folders with more than two docs", rows("herd_f", "dept_f"),
    ref=[ans(kind="folder", where="document count > 2")]),
  T("anything from herd records in the trash", rows("old_tractor_doc"),
    ref=[ans(kind="document", linked_to="$herd_f", trashed=True)]),
  T("restore it", diff(restore("old_tractor_doc")),
    ref=[act("restore", rows="$old_tractor_doc")]),
  T("now delete herd records, it's all on icbf", ask(),
    ref=[bad(act("delete", rows="$herd_f")),
         askc("herd records still has four documents in it, so it can't be deleted. move them somewhere first?")]))

S("T11-088", "event status != upcoming linked met empty ambiguous ask",
  T("any gaa committee meetings coming up that aren't cancelled", rows("gaa_0804", "gaa_0901"),
    ref=[ans(kind="event", name="GAA committee meeting", when=W({"from": U("day", 0)}), where='status != "cancelled"')]),
  T("who goes to them", rows("sean_h", "eileen"),
    ref=[ans(kind="person", linked_to="$gaa_0804")]),
  T("which of the two have no met on them", rows("sean_h", "eileen"),
    ref=[ans(within="@prev", where="met is empty")]),
  T("cancel the gaa meeting, sean's away", ask("gaa_0804", "gaa_0901"),
    ref=[act("cancel", kind="event", name="GAA committee meeting", when=W({"from": U("day", 0)})),
         find(kind="event", name="GAA committee meeting", when=W({"from": U("day", 0)})),
         askc("the august one or september?", options="$gaa_0804, $gaa_0901")]))

S("T11-090", "six turns knock-on list edit add_to create undo count priority",
  T("rename the school list to Kids and put collect aoife from camogie camp on it",
    diff(upd("school_l", name="Kids"), link("school_l", "camogie")),
    ref=[act("edit", kind="list", name="School", more=True, args=lines(name="Kids")),
         act("add_to", kind="task", name="Collect Aoife from camogie camp", args=lines(to="$school_l"))]),
  T("what's on kids now", rows("books", "tour_dep", "labels", "swim", "camogie"),
    ref=[ans(kind="task", linked_to="$school_l")]),
  T("add buy roisin a lunchbox, due the twenty-eighth of august, on it",
    diff(new("task", name=has("lunchbox"), date="2026-08-28"), link("school_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Buy Roisin a lunchbox", date=D("2026-08-28"), list="$school_l"))]),
  T("undo that, aoife has a spare one", diff(trash("+1")),
    ref=[act("undo")]),
  T("how many open on it", val(4),
    ref=[ans(op="count", kind="task", linked_to="$school_l", where='status = "open"')]),
  T("which of the open ones have a priority", rows("books"),
    ref=[ans(kind="task", linked_to="$school_l", where='status = "open" and priority is set')]))

S("T11-092", "ambiguous person ask log dead end search",
  T("log coffee with mary", ask("mary_l", "mary_c"),
    ref=[act("log", kind="person", name="Mary", args=lines(kind="coffee")),
         askc("mary lynch or mary considine?", options="$mary_l, $mary_c")]),
  T("lynch", diff(upd("mary_l", date=ANY)),
    ref=[act("log", rows="$mary_l", args=lines(kind="coffee"))]),
  T("when's the hurling blitz", rows("blitz"),
    ref=[ans(kind="event", name="hurling blitz"),
         search("hurling blitz"),
         ans(rows="$blitz")]))

S("T11-094", "five turns find-only date reschedule where month span effort complete",
  T("anything due on the first of august", rows("raffle", "swim", "nuts_08"),
    ref=[find(kind="task", when=W(D("2026-08-01"))),
         ans(rows="@prev")]),
  T("the club one, push it to monday week", diff(upd("raffle", date="2026-08-03")),
    ref=[act("reschedule", kind="task", when=W(D("2026-08-01")), linked_to="$club_l",
             args=lines(to=U("week", 2, weekday=1)))]),
  T("tasks from july first to next monday i haven't done",
    rows("esb_07", "milk_stmt", "troughs", "call_mam", "tb_prep", "tb_pen", "tb_tags", "herd_reg", "vet_calves"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=7), U("week", 1, weekday=1))), where='status = "open"')]),
  T("which of those are fifteen mins or less", rows("esb_07", "call_mam", "herd_reg", "vet_calves"),
    ref=[ans(within="@prev", where="effort <= 15")]),
  T("paid the esb one", diff(upd("esb_07", status="completed", completed=ANY)),
    ref=[act("complete", rows="$esb_07")]))

S("T11-095", "task spans year effort ambiguous resolve reschedule",
  T("what's due from the fifteenth of august to the end of the year",
    rows("house_ins", "nct", "labels", "bulk_tank", "boiler", "herd_ins", "reseed"),
    ref=[ans(kind="task", when=W(span(D("2026-08-15"), U("year", 0))))]),
  T("any of them over an hour of work", rows("reseed"),
    ref=[ans(within="@prev", where="effort > 60")]),
  T("paperwork stuff due since june that's open", rows("receipts", "herd_ins", "nitrates", "milk_stmt"),
    ref=[ans(kind="task", linked_to="$paper_l", when=W({"from": U("month", 0, name=6)}), where='status = "open"')]),
  T("push the dairy nuts order to wednesday", diff(upd("nuts_08", date="2026-07-29")),
    ref=[act("reschedule", kind="task", name="Order dairy nuts", args=lines(to=U("week", 1, weekday=3))),
         act("reschedule", rows="$nuts_08", args=lines(to=U("week", 1, weekday=3)))]))

S("T11-096", "photo datetime spans star dead end other kind",
  T("communion photos between 1 and 3", rows("p_comm_grans", "p_comm_family"),
    ref=[ans(kind="photo", linked_to="$comm_al", when=W(span(D("2026-05-16", "13:00"), D("2026-05-16", "15:00"))))]),
  T("pics of cian from before 6pm on the first of july",
    rows("p_pollock", "p_comm_family", "p_xmas", "p_cian_goal", "p_u12_team"),
    ref=[ans(kind="photo", linked_to="$cian", when=W({"to": D("2026-07-01", "18:00")}))]),
  T("star the pollock holes one", diff(upd("p_pollock", starred=True)),
    ref=[act("star", kind="photo", name="Pollock holes")]),
  T("when's roisin's swimming", rows("swim"),
    ref=[find(kind="event", name="swimming"),
         ans(rows="$swim")]))

S("T11-097", "five turns documents find-only weekday time spans dead end search",
  T("docs from wednesday", rows("tams_doc"),
    ref=[find(kind="document", when=W(U("week", 0, weekday=3))),
         ans(rows="@prev")]),
  T("and the one from tuesday at half 12", rows("loan_offer"),
    ref=[ans(kind="document", when=W(U("week", 0, weekday=2, time="12:30")))]),
  T("docs between monday and friday last week", rows("fence_quote", "ai_records"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=1), U("week", -1, weekday=5))))]),
  T("docs since friday last week", rows("ai_records", "loan_offer", "tams_doc", "scc_report", "supply_agree"),
    ref=[ans(kind="document", when=W({"from": U("week", -1, weekday=5)}))]),
  T("where's the loan letter", rows("loan_offer"),
    ref=[ans(kind="document", name="loan letter"),
         search("loan letter", kind="document"),
         ans(rows="$loan_offer")]))

S("T11-099", "ambiguous person star ask",
  T("star sean", ask("sean_m", "sean_h"),
    ref=[act("star", kind="person", name="Sean"),
         askc("sean mahon the contractor or sean hehir from the club?", options="$sean_m, $sean_h")]),
  T("hehir, the chairman", diff(upd("sean_h", starred=True)),
    ref=[act("star", rows="$sean_h")]))
