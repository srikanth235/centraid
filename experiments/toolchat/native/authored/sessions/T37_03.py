from gold import *
import json

world("T37", "2027-03-09T10:40", "Liam O'Brien", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T37-049", "wifi read reveal egress",
  T("what's the wifi password at aoife's", rows("aoife_wifi"),
    ref=[ans(kind="locker item", name="aoife wifi")]),
  T("read it out, i'm round at hers", diff(reveal=[("aoife_wifi", "CianSaoirse2019")]),
    ref=[act("reveal", rows="$aoife_wifi", args="field: password")]),
  T("whatsapp it to maura so she has it too", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T37-050", "create-in-list then read exclude-new priority where-read",
  T("add ring the audiologist to the health list for friday and tell me what else is due this week",
    rows("knee_ex", "hearing_aid",
         also=diff(new("task", name=has("audiologist"), date="2027-03-12"), link("health_list", "new"))),
    ref=[act("create", args="kind: task\nname: Ring the audiologist\n" + lines(date=U("week", 0, weekday=5)) +
             "\nlist: $health_list", more=True),
         ans(kind="task", linked_to="$health_list", where="status = open", when=W(U("week", 0)), exclude="$new")]),
  T("make that one a priority", diff(upd("+1", priority=1)),
    ref=[act("edit", rows="$c1", args="priority: 1")]),
  T("which open tasks are priority one", rows("esb_mar", "rx_apr", "camino_flights", "gaa_dues", "pay_declan", "+1"),
    ref=[ans(kind="task", where="status = open and priority = 1")]))

S("T37-051", "fabricated decline reveal sealed-egress",
  T("make me up a new password for the revolut app", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("fine, what's the one i've got saved", diff(reveal=[("revolut_pw", "GalwayRev#44")]),
    ref=[act("reveal", rows="$revolut_pw", args="field: password")]),
  T("email it to conor", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T37-052", "repair effort-unit then narrow link",
  T("which open tasks take over an hour", rows("camino_boots", "book_next"),
    ref=[bad(ans(kind="task", where="status = open and effort > 1 hour")),
         ans(kind="task", where="status = open and effort > 60")]),
  T("and under twenty minutes", rows("easter_lamb", "bp_log", "conor_visit", "aoife_key", "gaa_minibus", "golf_fee", "book_pay"),
    ref=[ans(kind="task", where="status = open and effort < 20")]),
  T("which of those are on the family list", rows("easter_lamb", "conor_visit", "aoife_key"),
    ref=[ans(within="@prev", linked_to="$family_list")]))

S("T37-053", "repair cadence-unit within-when log",
  T("who's on a cadence of more than two weeks", rows("mary_o", "mary_k", "siobhan", "brendan", "pat"),
    ref=[bad(ans(kind="person", where="cadence > 2 weeks")), ans(kind="person", where="cadence > 14")]),
  T("which of them have i spoken to this month", rows("mary_k"),
    ref=[ans(within="@prev", when=W(U("month", 0)))]),
  T("rang mary o'brien this morning, log it", diff(upd("mary_o", date="2027-03-09T10:40")),
    ref=[act("log", rows="$mary_o", args="kind: call")]))

S("T37-054", "balance person then narrowed group K2 substitution",
  T("where am i with dec", val((-140, "EUR")),
    ref=[ans(op="balance", kind="person", name="dec")]),
  T("just the boston one", val((16.67, "USD")),
    ref=[ans(op="balance", kind="group", name="Boston Trip", linked_to="$declan")]),
  T("and kathleen's", val((-120, "USD")),
    ref=[ans(op="balance", kind="group", name="Boston Trip", linked_to="$kathleen")]),
  T("photos with kathleen from the boston album in december", rows("p_bos_northend", "p_bos_kath"),
    ref=[ans(kind="photo", linked_to="$kathleen, $boston_album", when=W(U("month", -1, name=12)))]))

S("T37-055", "create subtask container read complete-two exclude",
  T("add a subtask to the easter project, iron the good tablecloth, due the 26th",
    diff(new("task", name=has("tablecloth"), date="2027-03-26"), link("easter_proj", "new")),
    ref=[act("create", args="kind: task\nname: Iron the good tablecloth\n" + lines(date=D("2027-03-26")) +
             "\nparent: $easter_proj")]),
  T("what's left under it", rows("easter_lamb", "easter_eggs", "easter_beds", "easter_flowers", "+1"),
    ref=[ans(kind="task", linked_to="$easter_proj", where="status = open")]),
  T("tick off the lamb and the eggs",
    diff(upd("easter_lamb", status="completed", completed=ANY), upd("easter_eggs", status="completed", completed=ANY)),
    ref=[act("complete", rows="$easter_lamb, $easter_eggs")]),
  T("what's left now besides the tablecloth", rows("easter_beds", "easter_flowers"),
    ref=[ans(kind="task", linked_to="$easter_proj", where="status = open", exclude="$c1")]))

S("T37-056", "find-miss search-role recovery chain",
  T("who's the priest at oisin's christening", rows("fr_tom"),
    ref=[find(kind="person", name="priest"), search("priest", kind="person"), ans(rows="$fr_tom")]),
  T("and who else is going", rows("conor", "oisin"),
    ref=[ans(kind="person", linked_to="$mass_baptism", exclude="$fr_tom")]),
  T("star the christening invitation from february", diff(upd("christening_inv", starred=True)),
    ref=[act("star", kind="document", name="christening invitation", when=W(U("month", 0, name=2)))]))


S("T37-057", "long chain exclude write-then-read two-writes unstar search-role count-group k4-next-event",
  T("who's going to the april book club besides siobhan", rows("mary_k", "sean_b"),
    ref=[find(kind="event", name="book club", when=W(U("month", 0, name=4))),
         search("Siobhan", kind="person"),
         ans(kind="person", linked_to="@1", exclude="$siobhan")]),
  T("tick off the book club pick and tell me what's left on the club and golf list this month",
    rows("camino_flights", "golf_fee", "camino_knee",
         also=diff(upd("book_next", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="book club pick", more=True),
         ans(kind="task", linked_to="$club_list", where="status = open", when=W(U("month", 0)))]),
  T("cancel the golf outing on the 20th and star the golf outing photo",
    diff(upd("golf_outing", status="cancelled"), upd("p_golf", starred=True)),
    ref=[act("cancel", kind="event", name="golf society outing", when=W(D("2027-03-20")), more=True),
         act("star", kind="photo", name="golf outing")]),
  T("actually unstar that photo, keep the cancellation", diff(upd("p_golf", starred=False)),
    ref=[act("unstar", rows="$p_golf")]),
  T("and log a call with the golf friend, he rang about the cancellation",
    diff(upd("gerry", date="2027-03-09T10:40")),
    ref=[search("golf friend", kind="person"), act("log", rows="$gerry", args="kind: call")]),
  T("how many things have i got on in march by status", vgroups({"tentative": 36, "cancelled": 2}),
    ref=[comp(op="count", kind="event", group="status", when=W(U("month", 0))), ans(value="@prev")]),
  T("longest thing i've got next week with cian that isn't cancelled", rows("grandkids_0317"),
    ref=[ans(kind="event", linked_to="$cian", when=W(U("week", 1)), where="status != cancelled",
             order="duration desc", limit=1)]))

S("T37-058", "rename-then-count delete-event-where reschedule-edit-two cancel-by-date undo-not-undone",
  T("rename the book club notes notebook to book club and tell me how many notes are in it", val(5, also=diff(upd("book_nb", name="Book Club"))),
    ref=[act("edit", rows="$book_nb", args="name: Book Club", more=True),
         ans(op="count", kind="note", linked_to="$book_nb")]),
  T("delete the cancelled one from the minding series", diff(trash("grandkids_0217")),
    ref=[act("delete", kind="event", name="minding cian and saoirse", where="status = cancelled")]),
  T("set the lamb order to priority one and move it to thursday",
    diff(upd("easter_lamb", priority=1, date="2027-03-11")),
    ref=[act("edit", rows="$easter_lamb", args="priority: 1", more=True),
         act("reschedule", rows="$easter_lamb", args=lines(to=U("week", 0, weekday=4)))]),
  T("cancel dec's call on the 21st", diff(upd("calldec_0321", status="cancelled")),
    ref=[act("cancel", kind="event", name="call declan", when=W(D("2027-03-21")))]),
  T("undo that", diff(),
    ref=[act("undo")]),
  T("what's left on the family list this week besides the lamb order", rows("aoife_key"),
    ref=[ans(kind="task", linked_to="$family_list", where="status = open", when=W(U("week", 0)),
             exclude="$easter_lamb")]))

S("T37-059", "two-writes star-unstar then read starred ambiguous-person ask pick unstar-two where-two",
  T("unstar the home wifi and star the aoife one, then show me which starred ones aren't logins",
    rows("joint_acct", "aoife_wifi", "gaa_member",
         also=diff(upd("home_wifi", starred=False), upd("aoife_wifi", starred=True))),
    ref=[act("unstar", rows="$home_wifi", more=True), act("star", rows="$aoife_wifi", more=True),
         ans(kind="locker item", where='starred = yes and type != "login"')]),
  T("star sean", ask("sean_b", "sean_m"),
    ref=[act("star", kind="person", name="sean")]),
  T("the one from the gaa", diff(upd("sean_m", starred=True)),
    ref=[find(kind="person", name="sean", linked_to="$gaa"), act("star", rows="@prev")]),
  T("unstar tadhg and cian", diff(upd("tadhg", starred=False), upd("cian", starred=False)),
    ref=[act("unstar", rows="$tadhg, $cian")]),
  T("which starred people are on weekly cadence", rows("declan"),
    ref=[ans(kind="person", where="starred = yes and cadence = 7")]),
  T("which starred people are in golf pot", rows("sean_m"),
    ref=[ans(kind="person", linked_to="$golf", where="starred = yes")]))

S("T37-060", "debts k4 settle-then-read superlative min link",
  T("what do i still owe over twenty euro before christmas", rows("d_mary_k"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open and amount > 20 EUR",
             when=W({"to": D("2026-12-25")}))]),
  T("settle that and show me what else i owe", rows("d_siobhan", "d_tadhg", "d_padraig", "d_declan",
                                                    also=diff(upd("d_mary_k", status="settled"))),
    ref=[act("settle_debt", rows="$d_mary_k", more=True),
         ans(kind="debt", where="direction = i_owe and status = open", exclude="$d_mary_k")]),
  T("and the smallest one anyone owes me", rows("d_sean_b"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", order="amount asc", limit=1)]),
  T("what's sean burke's march debt for", rows("d_sean_b"),
    ref=[ans(kind="debt", linked_to="$sean_b", when=W(U("month", 0, name=3)))]))

S("T37-061", "k3 completed-since reopen reschedule-then-read link",
  T("what did i finish on the gaa list since the start of february", rows("gaa_vests"),
    ref=[ans(kind="task", linked_to="$gaa_list", where="status = completed", when=W({"from": D("2027-02-01")}))]),
  T("reopen it", diff(upd("gaa_vests", status="open", completed=None)),
    ref=[act("reopen", rows="$gaa_vests")]),
  T("push it to friday and show me what else is due on the gaa list by then",
    rows("gaa_sliotars", also=diff(upd("gaa_vests", date="2027-03-12"))),
    ref=[act("reschedule", rows="$gaa_vests", args=lines(to=U("week", 0, weekday=5)), more=True),
         ans(kind="task", linked_to="$gaa_list", where="status = open", when=W({"to": D("2027-03-12")}),
             exclude="$gaa_vests")]))


S("T37-062", "chain find-event balance repair-create-date two-writes ambiguous-person pick",
  T("who from the golf pot was at the february outing", rows("gerry", "brendan", "sean_m"),
    ref=[find(kind="event", name="golf society outing", when=W(U("month", 0, name=2))),
         ans(kind="person", linked_to="$golf, @prev")]),
  T("where am i with sean murphy", val((70, "EUR")),
    ref=[ans(op="balance", kind="person", name="sean murphy")]),
  T("put a golf lesson with gerry in the diary friday at 11",
    diff(new("event", name=has("golf", "lesson"), date="2027-03-12T11:00")),
    ref=[bad(act("create", args="kind: event\nname: Golf lesson with Gerry\ndate: friday 11:00")),
         act("create", args="kind: event\nname: Golf lesson with Gerry\n" + lines(date=U("week", 0, weekday=5, time="11:00")))]),
  T("move the lesson to four and cancel the call with dec on the 14th",
    diff(upd("+1", date="2027-03-12T16:00"), upd("calldec_0314", status="cancelled")),
    ref=[act("reschedule", rows="$new", args=lines(to=U("week", 0, weekday=5, time="16:00")), more=True),
         act("cancel", kind="event", name="call declan", when=W(D("2027-03-14")))]),
  T("star mary", ask("mary_k", "mary_o"),
    ref=[act("star", kind="person", name="mary")]),
  T("the book club one", diff(upd("mary_k", starred=True)),
    ref=[find(kind="person", name="mary", linked_to="$bookclub"), act("star", rows="@prev")]))

S("T37-063", "repair where-date two-writes search-role star count-group delete-where undo-restore",
  T("health list due before the 20th", rows("knee_ex", "hearing_aid"),
    ref=[bad(ans(kind="task", linked_to="$health_list", where="status = open and due < 2027-03-20")),
         ans(kind="task", linked_to="$health_list", where="status = open", when=W({"to": D("2027-03-20")}))]),
  T("tick off the knee exercises and move the hearing aid moulds to monday",
    diff(upd("knee_ex", status="completed", completed=ANY), upd("hearing_aid", date="2027-03-15")),
    ref=[act("complete", kind="task", name="knee exercises", more=True),
         act("reschedule", rows="$hearing_aid", args=lines(to=U("week", 1, weekday=1)))]),
  T("and star the audiologist", diff(upd("audio", starred=True)),
    ref=[search("audiologist", kind="person"), act("star", rows="$audio")]),
  T("how many family tasks by status", vgroups({"open": 9, "in_progress": 1}),
    ref=[comp(op="count", kind="task", group="status", linked_to="$family_list"), ans(value="@prev")]),
  T("wipe the done ones on family list", diff(trash("easter_menu")),
    ref=[act("delete", kind="task", linked_to="$family_list", where="status = completed")]),
  T("undo that", diff(restore("easter_menu")),
    ref=[act("undo")]))

S("T37-064", "repair where-field note-open create-note-notebook already-so-star model-ask",
  T("which of the health log notes mention bloods", rows("hl_cardio"),
    ref=[bad(ans(kind="note", linked_to="$health_nb", where='text contains "bloods"')),
         ans(kind="note", linked_to="$health_nb", where='body contains "bloods"')]),
  T("what does it say", rows("hl_cardio"),
    ref=[opn("$hl_cardio"), ans(rows="$hl_cardio")]),
  T("new note in the health log, bring the echo report to the clinic",
    diff(new("note", name=has("echo"), body=has("echo report", "clinic")), link("health_nb", "new")),
    ref=[act("create", args="kind: note\nname: Echo report\nbody: bring the echo report to the clinic\nnotebook: $health_nb")]),
  T("star echo report in the health folder", diff(already=["echo_report"]),
    ref=[act("star", kind="document", name="echo report", linked_to="$health_f"), ans(rows="$echo_report")]),
  T("add a note about the meeting", ask(),
    ref=[askc("What should the note say?")]))

S("T37-065", "k4-act-next reschedule cancel-by-date undo trashed-delete-decline count-k4 reveal-note",
  T("push tonight's training to thursday at 7", diff(upd("training_0309", date="2027-03-11T19:00")),
    ref=[act("reschedule", kind="event", name="hurling training", when=W({"from": U("day", 0)}),
             where="status != cancelled", order="date asc", limit=1,
             args=lines(to=U("week", 0, weekday=4, time="19:00")))]),
  T("and cancel the training on the 16th", diff(upd("training_0316", status="cancelled")),
    ref=[act("cancel", kind="event", name="hurling training", when=W(D("2027-03-16")))]),
  T("undo that", diff(),
    ref=[act("undo")]),
  T("what's on tonight and tomorrow", rows("grandkids_0310"),
    ref=[ans(kind="event", when=W(span(U("day", 0), U("day", 1))))]),
  T("delete the old gate task for good", decline("not_found"),
    ref=[act("delete", kind="task", name="garden gate")]),
  T("how many physio sessions are left this month that aren't cancelled", val(4),
    ref=[ans(op="count", kind="event", name="physio", when=W(span(D("2027-03-10"), D("2027-03-31"))),
             where="status != cancelled")]),
  T("and what's the gate code for the pitch", diff(reveal=[("gate_code", "1916")]),
    ref=[act("reveal", rows="$gate_code", args="field: content")]))
