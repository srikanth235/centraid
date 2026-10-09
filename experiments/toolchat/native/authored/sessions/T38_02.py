from gold import *
import json


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T38-025", "finance week open within effort two-writes empty-week next-week",
  T("what's due this week on the finance list that i haven't done yet", rows("net_270515", "t_117"),
    ref=[find(kind="task", linked_to="$finance_l", where="status = open", when=J(U("week", 0))), ans(rows="@prev")]),
  T("which of those is the fifteen minute one", rows("t_117"),
    ref=[ans(within="@prev", where="effort = 15")]),
  T("pay that one and push the internet payment to monday",
    diff(upd("t_117", status="completed", completed=ANY), upd("net_270515", date="2027-05-17T12:00")),
    ref=[act("complete", rows="$t_117", more=True),
         act("reschedule", kind="task", name="Pay Orange internet", where="status = open",
             args=lines(to=U("week", 1, weekday=1)))]),
  T("anything left for this week on that list", rows(),
    ref=[ans(kind="task", linked_to="$finance_l", where="status = open", when=J(U("week", 0)))]),
  T("and next week then", rows("net_270515"),
    ref=[ans(kind="task", linked_to="$finance_l", where="status = open", when=J(U("week", 1)))]))

S("T38-026", "supplies series ask pick delete-both count-zero",
  T("tick off order clinic supplies", ask("sup_270517", "sup_250310", "sup_240805"),
    ref=[act("complete", kind="task", name="Order clinic supplies")]),
  T("the monday one", diff(upd("sup_270517", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Order clinic supplies", where="status = open",
             when=J(U("week", 1, weekday=1)))]),
  T("the other two are ancient, delete both", diff(trash("sup_250310"), trash("sup_240805")),
    ref=[find(kind="task", name="Order clinic supplies", where="status = open"), act("delete", rows="@prev")]),
  T("so how many supplies orders do i still have open", val(0),
    ref=[ans(op="count", kind="task", name="Order clinic supplies", where="status = open")]))

S("T38-027", "subtasks container active empty done parent",
  T("which subtasks of renew the clinic licence 2027 are still open", rows("licence27_3", "licence27_4", "licence27_5"),
    ref=[ans(kind="task", linked_to="$licence27", where="status = open")]),
  T("same for the 2026 one", rows(),
    ref=[ans(kind="task", linked_to="$licence26", where="status = open")]),
  T("i mean the ones from 2026 that were done", rows("licence26_1", "licence26_2", "licence26_3", "licence26_4", "licence26_5"),
    ref=[ans(kind="task", linked_to="$licence26", where="status = completed", when=J(U("year", -1)))]),
  T("and which 2027 ones are done", rows("licence27_1", "licence27_2"),
    ref=[ans(kind="task", linked_to="$licence27", where="status = completed")]))

S("T38-028", "task create list date edit two-fields list-read end-of-month",
  T("remind me to renew the car insurance on the car list by the 20th of june",
    diff(new("task", name=has("insurance"), date="2027-06-20"), link("car_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Renew the car insurance", date=D("2027-06-20"), list="$car_l"))]),
  T("make it priority one and about 45 minutes", diff(upd("+1", priority=1, effort=45)),
    ref=[act("edit", rows="$c1", args="priority: 1\neffort: 45")]),
  T("which car tasks are still open and due before july", rows("t_118", "+1"),
    ref=[ans(kind="task", linked_to="$car_l", where="status = open", when=J({"to": D("2027-06-30")}))]),
  T("push the tyres one to the end of the month", diff(upd("t_118", date="2027-05-31")),
    ref=[act("reschedule", kind="task", name="Buy new tyres", where="status = open", args=lines(to=D("2027-05-31")))]))

S("T38-029", "reopen month name-where within overdue",
  T("reopen the electricity payment from may, it bounced", diff(upd("elec_270510", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Pay clinic electricity", where="status = completed",
             when=J(U("month", 0, name=5)))]),
  T("what electricity payments are open this year", rows("elec_270510", "elec_270610"),
    ref=[ans(kind="task", name="Pay clinic electricity", where="status = open", when=J(U("year", 0)))]),
  T("which of those have slipped past their date", rows("elec_270510"),
    ref=[ans(within="@prev", when=J({"to": U("day", -1)}))]))

S("T38-030", "effort sum lists superlative order-limit",
  T("how much time is left on the clinic list before the anniversary party", val(70),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$clinic_l", where="status = open",
             when=J({"to": D("2027-06-03")}))]),
  T("and the garden one", val(120),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$garden_l", where="status = open")]),
  T("which garden job takes the longest", rows("t_146"),
    ref=[ans(kind="task", linked_to="$garden_l", where="status = open", order="effort desc", limit=1)]))

S("T38-031", "list create add_to move read rename",
  T("make a new list called summer trip, social", diff(new("list", name="Summer Trip", area="social")),
    ref=[act("create", args=lines(kind="list", name="Summer Trip", area="social"))]),
  T("put the print the hotel booking task that's still open in it", diff(unlink("travel_l", "t_055"), link("+1", "t_055")),
    ref=[act("add_to", kind="task", name="Print the hotel booking", where="status = open", args="to: $c1")]),
  T("and the download the offline maps one too", diff(unlink("travel_l", "t_099"), link("+1", "t_099")),
    ref=[act("add_to", kind="task", name="Download the offline maps", where="status = open", args="to: $c1")]),
  T("what's still open in the summer trip list", rows("t_055", "t_099"),
    ref=[ans(kind="task", linked_to="$c1", where="status = open")]),
  T("call the list holiday prep instead", diff(upd("+1", name="Holiday Prep")),
    ref=[act("edit", rows="$c1", args="name: Holiday Prep")]),
  T("take the maps one out of it again", diff(unlink("+1", "t_099")),
    ref=[act("remove_from", kind="task", name="Download the offline maps", args="from: $c1")]))

S("T38-032", "bulk cap ask yes confirm count",
  T("delete all the pay water bill tasks", ask(),
    ref=[act("delete", kind="task", name="Pay water bill")]),
  T("yes go ahead",
    diff(trash("wtr_240620"), trash("wtr_240920"), trash("wtr_241220"), trash("wtr_250320"), trash("wtr_250620"),
         trash("wtr_250920"), trash("wtr_251220"), trash("wtr_260320"), trash("wtr_260620"), trash("wtr_260920"),
         trash("wtr_261220"), trash("wtr_270320"), trash("wtr_270620")),
    ref=[act("delete", kind="task", name="Pay water bill")]),
  T("how many finance tasks are left open", val(8),
    ref=[ans(op="count", kind="task", linked_to="$finance_l", where="status = open")]))

S("T38-033", "debt person direction status year k4",
  T("what hasn't yousef abu ghosh paid me back from last year", rows("debt_40"),
    ref=[ans(kind="debt", linked_to="$yousef_a", where="direction = owes_me and status = open", when=J(U("year", -1)))]))

S("T38-034", "tasks garden effort status span k4",
  T("open garden jobs that take over an hour and are due before the end of june", rows("t_146"),
    ref=[bad(ans(kind="task", linked_to="$garden_l", where="status = open and effort > 1 hour", when=J({"to": D("2027-06-30")}))),
         ans(kind="task", linked_to="$garden_l", where="status = open and effort > 60", when=J({"to": D("2027-06-30")}))]))

S("T38-035", "count events description year k4",
  T("how many of the friday lunches in 2025 had the mansaf note", val(8),
    ref=[ans(op="count", kind="event", name="Friday lunch", where='description contains "mansaf"', when=J(U("year", -2)))]))

S("T38-036", "find-only exclude group decline-email",
  T("let me see everyone in the clinic supplies pool apart from nurse rasha",
    rows("ahmad", "mahmoud", "dr_tala", "issa_khoury", "wafa_hijazi", "jawad_zoubi", "me"),
    ref=[find(kind="person", linked_to="$clinic_supplies", exclude="$rasha"), ans(rows="@prev")]),
  T("email them all that the supplies are late", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T38-037", "ambiguous event reschedule anchor ask pick",
  T("push the eye test to 11", ask("oo_065", "oo_047", "oo_073"),
    ref=[act("reschedule", kind="event", name="Eye test", args=lines(to=U("day", 0, anchor="row", time="11:00")))]),
  T("mama's one next week", diff(upd("oo_065", date="2027-05-19T11:00")),
    ref=[act("reschedule", kind="event", name="Eye test", where="status != cancelled", when=J(U("week", 1)),
             args=lines(to=U("day", 0, anchor="row", time="11:00")))]))

S("T38-038", "person restore past-window decline then restore ok",
  T("bring back bashar mdanat, i deleted him by mistake", decline("not_found"),
    ref=[find(kind="person", name="Bashar Mdanat", trashed=True), act("restore", rows="$bashar_mdanat")]),
  T("and maryam alawneh", diff(restore("maryam_alawneh")),
    ref=[find(kind="person", name="Maryam Alawneh", trashed=True), act("restore", rows="$maryam_alawneh")]))

S("T38-039", "locker star two undo star-one",
  T("star the visa and the clinic card", diff(upd("visa_card", starred=True), upd("clinic_card", starred=True)),
    ref=[search("Visa", kind="locker item"), act("star", rows="$visa_card, $clinic_card")]),
  T("no wait, undo that", diff(upd("visa_card", starred=False), upd("clinic_card", starred=False)),
    ref=[act("undo")]),
  T("just the visa one", diff(upd("visa_card", starred=True)),
    ref=[act("star", rows="$visa_card")]))

S("T38-040", "balance person narrowed group settle_up",
  T("where am i with dr tala", val((138.333, "JOD"), (165, "AED")),
    ref=[ans(op="balance", kind="person", rows="$dr_tala")]),
  T("just the clinic supplies one", val((-138.333, "JOD")),
    ref=[ans(op="balance", kind="group", name="Clinic Supplies Pool", linked_to="$dr_tala")]),
  T("settle up with her there", diff(settle=[("Tala Khoury", "138.333")]),
    ref=[act("settle_up", rows="$dr_tala", args="group: $clinic_supplies")]))

S("T38-041", "log undo-not-undone search log",
  T("rang khalto rima, she's sending the recipe", diff(upd("khalto_rima", date=ANY)),
    ref=[act("log", kind="person", name="Khalto Rima", args="kind: call")]),
  T("wait that was dana not her, undo it", diff(),
    ref=[act("undo")]),
  T("ok log it for dana then", diff(upd("dana", date=ANY)),
    ref=[search("Dana", kind="person"), act("log", rows="$dana", args="kind: call")]))

S("T38-042", "add_to group person role-contains relation",
  T("add fadwa obeidat to yazan's study group", diff(link("study_group", "fadwa_obeidat")),
    ref=[act("add_to", kind="person", name="Fadwa Obeidat", args="to: $study_group")]),
  T("and usama yaghmour, he's in the same class", diff(link("study_group", "usama_yaghmour")),
    ref=[act("add_to", kind="person", name="Usama Yaghmour", args="to: $study_group")]),
  T("which classmates are in the group now", rows("raji_anabtawi", "dania_nabulsi", "fadwa_obeidat", "usama_yaghmour"),
    ref=[ans(kind="person", linked_to="$study_group", where='role contains "classmate"')]),
  T("take fadwa back out, wrong class", diff(unlink("study_group", "fadwa_obeidat")),
    ref=[act("remove_from", kind="person", name="Fadwa Obeidat", args="from: $study_group")]))

S("T38-043", "cancel apply-all month undo-not-undone count-zero",
  T("cancel all the friday lunches in june, we'll be at the beach",
    diff(upd("fl_270604", status="cancelled"), upd("fl_270611", status="cancelled"),
         upd("fl_270618", status="cancelled"), upd("fl_270625", status="cancelled")),
    ref=[find(kind="event", name="Friday lunch", when=J(U("month", 0, name=6))), act("cancel", rows="@prev")]),
  T("oops, undo that", diff(),
    ref=[act("undo")]),
  T("so how many friday lunches are still on in june", val(0),
    ref=[ans(op="count", kind="event", name="Friday lunch", where="status != cancelled", when=J(U("month", 0, name=6)))]))

S("T38-044", "recovery empty-search not-found log task next reschedule",
  T("log a call with grandma", decline("not_found"),
    ref=[search("grandma", kind="person"), act("log", kind="person", name="grandma", args="kind: call")]),
  T("i mean teta", diff(upd("teta", date=ANY)),
    ref=[act("log", rows="$teta", args="kind: call")]),
  T("when's her next doctor run from now on", rows("tdoc_270609"),
    ref=[ans(kind="task", name="Take Teta to the doctor", where="status = open", when=J({"from": U("day", 0)}),
             order="date asc", limit=1)]),
  T("move that to thursday at ten", diff(upd("tdoc_270609", date="2027-05-13T10:00")),
    ref=[act("reschedule", kind="task", name="Take Teta to the doctor", where="status = open",
             args=lines(to=U("week", 0, weekday=4, time="10:00")))]))

S("T38-045", "recovery empty-search answer-empty landlord debts settle-both",
  T("when did i last see the landlady", rows(),
    ref=[search("landlady", kind="person"), ans(kind="person", name="landlady")]),
  T("i mean anwar, the clinic landlord", rows("landlord"),
    ref=[ans(kind="person", name="Anwar", where='role = "clinic landlord"')]),
  T("what does he owe me", rows("debt_04"),
    ref=[bad(ans(kind="debt", linked_to="$landlord", where="owes = me and status = open")),
         ans(kind="debt", linked_to="$landlord", where="direction = owes_me and status = open")]),
  T("net it off, settle both of them", diff(upd("debt_04", status="settled"), upd("debt_35", status="settled")),
    ref=[find(kind="debt", linked_to="$landlord", where="status = open"), act("settle_debt", rows="@prev")]))

S("T38-046", "documents ask star pick folder-read unstar year",
  T("star the car registration", ask("doc_025", "doc_085"),
    ref=[act("star", kind="document", name="Car registration")]),
  T("the 2026 one", diff(upd("doc_085", starred=True)),
    ref=[act("star", kind="document", name="Car registration", where="starred = no", when=J(U("year", -1)))]),
  T("which car documents from 2025 on are starred now", rows("doc_055", "doc_085"),
    ref=[ans(kind="document", linked_to="$carf", where="starred = yes", when=J({"from": D("2025-01-01")}))]),
  T("unstar the 2025 one", diff(upd("doc_055", starred=False)),
    ref=[act("unstar", kind="document", name="Car registration", when=J(U("year", -2)))]))

S("T38-047", "photos starred album add_to ordinal unstar",
  T("which photos in the teta album from 2025 on are starred", rows("ph_teta_a_13", "ph_teta_a_15"),
    ref=[ans(kind="photo", linked_to="$teta_a", where="starred = yes", when=J({"from": D("2025-01-01")}))]),
  T("add both to the eid 2026 album", diff(link("eid26", "ph_teta_a_13"), link("eid26", "ph_teta_a_15")),
    ref=[act("add_to", rows="@prev", args="to: $eid26")]),
  T("and take the star off the second one", diff(upd("ph_teta_a_15", starred=False)),
    ref=[act("unstar", rows="$ph_teta_a_15")]))
