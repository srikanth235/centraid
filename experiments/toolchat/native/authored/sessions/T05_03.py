from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T05-051", "temple meeting next attendees ambiguous pick edit complete",
  T("when's the next temple committee meeting", rows("tc_0124"),
    ref=[ans(kind="event", name="Temple committee meeting", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("who's coming to it", rows("gopal", "revathi", "balu"),
    ref=[ans(kind="person", linked_to="$tc_0124")]),
  T("move the committee meeting to 11, i'll be dead after the night", diff(upd("tc_0124", date="2026-01-24T11:00")),
    ref=[act("reschedule", kind="event", name="Temple committee meeting",
             args=lines(to=U("day", 0, anchor="row", time="11:00"))),
         act("reschedule", rows="$tc_0124", args=lines(to=U("day", 0, anchor="row", time="11:00")))]),
  T("add in its description: bring the donor spreadsheet", diff(upd("tc_0124", description="bring the donor spreadsheet")),
    ref=[act("edit", rows="$tc_0124", args=lines(description="bring the donor spreadsheet"))]),
  T("what's open on the temple committee list", rows("receipts", "banner", "donor_list"),
    ref=[ans(kind="task", linked_to="$templelist", where='status = "open"')]),
  T("tick off hand over receipts to revathi, gave them yesterday", diff(upd("receipts", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Hand over receipts to Revathi")]))

S("T05-052", "person ambiguity balance settle undo ledger",
  T("how much does divya owe me", ask("divya_s", "divya_k"),
    ref=[bad(ans(op="balance", kind="person", name="Divya")),
         askc("divya srinivasan or divya krishnan?", options="$divya_s, $divya_k")]),
  T("krishnan", val((433.32, "INR")),
    ref=[ans(op="balance", rows="$divya_k")]),
  T("she paid for the movie tickets", diff(upd("d_divya_k", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Movie tickets")]),
  T("how much is owed to me in total", val((5400, "INR")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("when's our next movie", rows("movie"),
    ref=[ans(kind="event", name="Movie with Divya")]))

S("T05-053", "surgery list tasks multi create reschedule",
  T("what's left on amma's surgery list", rows("reports", "insurance_claim", "eye_drops", "ride", "fasting"),
    ref=[ans(kind="task", linked_to="$surgerylist", where='status = "open"')]),
  T("which of those are priority one", rows("reports", "insurance_claim"),
    ref=[ans(within="@prev", where="priority = 1")]),
  T("drop both to priority two, the leave application is more urgent", diff(upd("reports", priority=2), upd("insurance_claim", priority=2)),
    ref=[act("edit", rows="@prev", args=lines(priority=2))]),
  T("add buy dark glasses for amma to that list, due next thursday",
    diff(new("task", name=has("dark glasses"), date="2026-01-29"), link("surgerylist", "new")),
    ref=[act("create", args=lines(kind="task", name="Buy dark glasses for Amma", date=U("week", 1, weekday=4),
                                  list="$surgerylist"))]),
  T("when's the surgery itself", rows("cataract_2"),
    ref=[ans(kind="event", name="Amma cataract surgery")]),
  T("and the follow-up?", rows("cataract_3"),
    ref=[ans(kind="event", name="Amma cataract follow-up")]),
  T("move the dark glasses one to the day before the surgery", diff(upd("+1", date="2026-02-12")),
    ref=[act("reschedule", rows="$c1", args=lines(to=D("2026-02-12")))]))

S("T05-054", "count completed lic",
  T("how many LIC premiums have i paid so far", val(7),
    ref=[ans(op="count", kind="task", name="Pay LIC premium", where='status = "completed"')]))

S("T05-055", "photos album linked all star prev delete multi",
  T("show me the pongal album", rows("pot", "kolam_pic", "cows", "sugarcane", "family_pongal", "big_temple", "blurry_kolam"),
    ref=[ans(kind="photo", linked_to="$pongal_al")]),
  T("delete the blurry kolam and the cows one", diff(trash("blurry_kolam"), trash("cows"), unlink("pongal_al", "blurry_kolam"),
                                                     unlink("pongal_al", "cows")),
    ref=[act("delete", rows="$blurry_kolam, $cows")]),
  T("which of the pongal ones with paati in them aren't starred", rows("kolam_pic"),
    ref=[search("paati", kind="person"), ans(kind="photo", linked_to="$pongal_al, $paati", where="starred = no")]),
  T("star that one then", diff(upd("kolam_pic", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T05-056", "compute max min debts",
  T("what's the most i owe any one person", val((15000, "INR")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'), ans(value="@prev")]),
  T("smallest one i owe?", val((250, "INR")),
    ref=[comp(op="min", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'), ans(value="@prev")]),
  T("which one is that", rows("d_jaya"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"', order="amount asc", limit=1)]))

S("T05-057", "delete group refused members balance delete empty group",
  T("delete the dubai trip group, trip's postponed", ask(),
    ref=[bad(act("delete", kind="group", name="Dubai trip")),
         askc("the dubai trip group still has expenses in it, so it can't be deleted. settle up first or keep it?")]),
  T("keep it. who's in it", rows("karthik", "harish", "anand", "me"),
    ref=[ans(kind="person", linked_to="$dubai_g")]),
  T("where do i stand in it", val((450, "AED")),
    ref=[comp(op="balance", kind="group", name="Dubai trip", linked_to="$me"), ans(value="@prev")]),
  T("delete the farhan farewell gift group though, we're doing cash", diff(gone("farewell_g"), unlink("farewell_g", "me")),
    ref=[act("delete", kind="group", name="Farhan farewell gift")]),
  T("how many groups have i got", val(5),
    ref=[ans(op="count", kind="group")]))

S("T05-058", "delete folder refused move docs delete",
  T("delete the insurance folder", ask(),
    ref=[bad(act("delete", kind="folder", name="Insurance")),
         askc("the insurance folder still has documents in it. move them somewhere first?")]),
  T("what's in it", rows("health_pol", "lic_pol"),
    ref=[ans(kind="document", linked_to="$ins_f")]),
  T("move both to medical", diff(unlink("ins_f", "health_pol"), unlink("ins_f", "lic_pol"), link("med_f", "health_pol"),
                                 link("med_f", "lic_pol")),
    ref=[act("add_to", rows="@prev", args=lines(to="$med_f"))]),
  T("now delete it", diff(gone("ins_f")),
    ref=[act("delete", kind="folder", name="Insurance")]),
  T("old bills folder too, its empty", diff(gone("old_f")),
    ref=[act("delete", kind="folder", name="Old bills")]))

S("T05-059", "person edit prev star",
  T("who's my charge nurse", rows("sowmya"),
    ref=[ans(kind="person", where='role contains "charge nurse"')]),
  T("she got promoted, change her role to ICU nurse manager", diff(upd("sowmya", role="ICU nurse manager")),
    ref=[act("edit", rows="@prev", args=lines(role="ICU nurse manager"))]),
  T("star her too", diff(upd("sowmya", starred=True)),
    ref=[act("star", rows="$sowmya")]))

S("T05-060", "list create task create on list",
  T("start a list called Anand's wedding, family area", diff(new("list", name="Anand's wedding", area="family")),
    ref=[act("create", args=lines(kind="list", name="Anand's wedding", area="family"))]),
  T("add book train tickets to bengaluru, due fifteenth feb", diff(new("task", name=has("train"), date="2026-02-15"), link("+1", "new")),
    ref=[act("create", args=lines(kind="task", name="Book train tickets to Bengaluru", date=D("2026-02-15"), list="$c1"))]),
  T("undo that, karthi already booked them", diff(trash("+2")),
    ref=[act("undo")]))

S("T05-061", "reveal cvv",
  T("hdfc card cvv?", diff(reveal=[("hdfc_card", "412")]),
    ref=[act("reveal", kind="locker item", name="HDFC debit card", args=lines(field="cvv"))]))

S("T05-062", "note restore multi undo restore",
  T("what notes have i deleted", rows("adai", "old_roster", "old_shopping", "hindi_words"),
    ref=[ans(kind="note", trashed=True)]),
  T("restore the december roster and the adai batter one", diff(restore("old_roster"), restore("adai")),
    ref=[act("restore", rows="$old_roster, $adai")]),
  T("undo that, don't need either", diff(trash("old_roster"), trash("adai")),
    ref=[act("undo")]),
  T("what's in recipes then", rows("vathal", "pongal_r", "rasam"),
    ref=[ans(kind="note", linked_to="$recipes_nb")]))

S("T05-063", "cricket next attendees debt settle prev",
  T("next cricket night?", rows("cric_0125"),
    ref=[ans(kind="event", name="Cricket night at Vicky's", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("who's coming to the cricket night at vicky's", rows("vignesh", "suresh", "divya_k"),
    ref=[ans(kind="person", linked_to="$cric_0125")]),
  T("does suri owe me for the bet", rows("d_suresh"),
    ref=[find(kind="debt", linked_to="$suresh", where='status = "open"'), ans(rows="@prev")]),
  T("he paid up, mark it", diff(upd("d_suresh", status="settled")),
    ref=[act("settle_debt", rows="@prev")]),
  T("tmrw's tasks?", rows("water_can", "projector", "reports"),
    ref=[ans(kind="task", when=W(U("day", 1)))]),
  T("push the projector one to saturday, vicky's out of town", diff(upd("projector", date="2026-01-24")),
    ref=[act("reschedule", kind="task", name="Return the projector", args=lines(to=U("week", 0, weekday=6)))]))

S("T05-064", "star document named",
  T("star the property tax receipt 2025", diff(upd("tax_receipt", starred=True)),
    ref=[act("star", kind="document", name="Property tax receipt 2025")]),
  T("what's starred in the house folder", rows("sale_deed", "tax_receipt"),
    ref=[ans(kind="document", linked_to="$house_f", where="starred = yes")]))

S("T05-065", "locker star already star named unstar multi",
  T("star the hospital HIS login", diff(already=["his"]),
    ref=[act("star", kind="locker item", name="Hospital HIS login"), ans(rows="$his")]),
  T("star the connemara library card", diff(upd("library", starred=True)),
    ref=[act("star", kind="locker item", name="Connemara library card")]),
  T("and unstar the sbi savings account and upi pin", diff(upd("sbi_acct", starred=False), upd("upi_pin", starred=False)),
    ref=[act("unstar", rows="$sbi_acct, $upi_pin")]))

S("T05-066", "folder edit named add_to doc",
  T("rename the old bills folder to Bills 2025", diff(upd("old_f", name="Bills 2025")),
    ref=[act("edit", kind="folder", name="Old bills", args=lines(name="Bills 2025"))]),
  T("and move the EB bill receipt december into it", diff(unlink("house_f", "eb_receipt"), link("old_f", "eb_receipt")),
    ref=[act("add_to", kind="document", name="EB bill receipt December", args=lines(to="$old_f"))]))

S("T05-067", "album delete create add photo",
  T("delete the ICU team album, i'll redo it after farhan leaves",
    diff(gone("icu_al"), unlink("icu_al", "icu_xmas"), unlink("icu_al", "night_team"), unlink("icu_al", "nurses_day"),
         unlink("icu_al", "farhan_pic")),
    ref=[act("delete", kind="album", name="ICU team")]),
  T("make an album called Farhan farewell", diff(new("album", name="Farhan farewell")),
    ref=[act("create", args=lines(kind="album", name="Farhan farewell"))]),
  T("put farhan's last night shift pic in it", diff(link("+1", "farhan_pic")),
    ref=[act("add_to", kind="photo", name="Farhan's last night shift", args=lines(to="$new"))]))

S("T05-068", "person create edit new",
  T("save dr anitha rao, amma's anaesthetist", diff(new("person", name=has("Anitha"), role=has("anaesthetist"))),
    ref=[act("create", args=lines(kind="person", name="Dr. Anitha Rao", role="Amma's anaesthetist"))]),
  T("put met: sankara nethralaya consult", diff(upd("+1", met="Sankara Nethralaya consult")),
    ref=[act("edit", rows="$c1", args=lines(met="Sankara Nethralaya consult"))]),
  T("who else did i meet at sankara nethralaya", rows(),
    ref=[ans(kind="person", where='met contains "Sankara"', exclude="$c1")]),
  T("and who's amma's ophthalmologist", rows("rao_doc"),
    ref=[find(kind="person", where='role contains "ophthalmologist"'), ans(rows="@prev")]))

S("T05-069", "add_to person multi group count",
  T("add karthik raman and venkatesh raman to the temple committee fund", diff(link("temple_g", "karthik"), link("temple_g", "appa")),
    ref=[act("add_to", rows="$karthik, $appa", args=lines(to="$temple_g"))]),
  T("how many in that group", val(5),
    ref=[ans(op="count", kind="person", linked_to="$temple_g")]))

S("T05-070", "remove_from where refused remove group balance",
  T("who's in the dubai trip group", rows("karthik", "harish", "anand", "me"),
    ref=[ans(kind="person", linked_to="$dubai_g")]),
  T("take out the bengaluru cousin, he's not coming", diff(unlink("dubai_g", "anand")),
    ref=[act("remove_from", kind="person", where='role contains "Bengaluru"', args=lines(from_="$dubai_g"))]),
  T("harish as well", ask(),
    ref=[bad(act("remove_from", rows="$harish", args=lines(from_="$dubai_g"))),
         askc("harish still has an unsettled balance in the dubai trip group, so he can't be removed yet. settle up with him first?")]),
  T("leave him then. what's his balance there", val((-300, "AED")),
    ref=[ans(op="balance", kind="group", name="Dubai trip", linked_to="$harish")]))

S("T05-071", "tasks today empty tomorrow edit named add_to prev",
  T("anything on my plate today", rows(),
    ref=[ans(kind="task", when=W(U("day", 0)))]),
  T("tomorrow?", rows("water_can", "projector", "reports"),
    ref=[ans(kind="task", when=W(U("day", 1)))]),
  T("order water cans is ten mins, and make it priority three", diff(upd("water_can", effort=10, priority=3)),
    ref=[act("edit", kind="task", name="Order water cans", args=lines(effort=10, priority=3))]),
  T("which of tomorrow's have no priority", rows("projector"),
    ref=[ans(kind="task", when=W(U("day", 1)), where="priority is empty")]),
  T("move it over to the home list instead", diff(unlink("cricketlist", "projector"), link("homelist", "projector")),
    ref=[act("add_to", rows="@prev", args=lines(to="$homelist"))]))

S("T05-072", "event create span",
  T("add karthik's send-off dinner on nineteenth feb at 8pm", diff(new("event", name=has("send-off"), date="2026-02-19T20:00")),
    ref=[act("create", args=lines(kind="event", name="Karthik's send-off dinner", date=D("2026-02-19", "20:00")))]),
  T("what's around then, eighteenth to twenty-first", rows("+1", "karthik_flight"),
    ref=[ans(kind="event", when=W({"from": D("2026-02-18"), "to": D("2026-02-21")}))]))

S("T05-073", "event edit prev",
  T("when's the BLS recertification", rows("bls"),
    ref=[ans(kind="event", name="BLS recertification")]),
  T("rename it BLS and ACLS recert", diff(upd("bls", name="BLS and ACLS recert")),
    ref=[act("edit", rows="@prev", args=lines(name="BLS and ACLS recert"))]),
  T("who else is going to BLS and ACLS recert", rows("divya_s", "farhan"),
    ref=[ans(kind="person", linked_to="$bls")]))

S("T05-074", "linked all ambiguous event ask pick",
  T("anything with both farhan and divya srinivasan", rows("bls", "farewell"),
    ref=[ans(kind="event", linked_to="$farhan, $divya_s")]),
  T("move the cataract thing to 9", ask("cataract_1", "cataract_2", "cataract_3"),
    ref=[act("reschedule", kind="event", name="cataract", args=lines(to=U("day", 0, anchor="row", time="09:00"))),
         askc("the consultation on thursday, the surgery on 13 feb or the follow-up on the 14th?",
              options="$cataract_1, $cataract_2, $cataract_3")]),
  T("the surgery", diff(upd("cataract_2", date="2026-02-13T09:00")),
    ref=[act("reschedule", rows="$cataract_2", args=lines(to=U("day", 0, anchor="row", time="09:00")))]),
  T("follow up an hour later too", diff(upd("cataract_3", date="2026-02-14T11:00")),
    ref=[act("reschedule", rows="$cataract_3", args=lines(to=U("day", 0, anchor="row", time="11:00")))]))

S("T05-075", "log visit",
  T("log a visit with paati today, went to see her after the shift", diff(upd("paati", date=ANY)),
    ref=[act("log", kind="person", name="Paati", args=lines(kind="visit")),
         search("paati", kind="person"),
         act("log", rows="$paati", args=lines(kind="visit"))]),
  T("wait undo that, it was a call not a visit", diff(),
    ref=[act("undo")]))
