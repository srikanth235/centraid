from gold import *
import json

world("T37", "2027-03-09T10:40", "Liam O'Brien", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T37-029", "next act selector-k4 reschedule order-limit where when",
  T("push the next physio to the 18th", diff(upd("physio_0315", date="2027-03-18T10:00")),
    ref=[act("reschedule", kind="event", name="physio", when=W({"from": U("day", 0)}), where="status != cancelled",
             order="date asc", limit=1, args=lines(to=D("2027-03-18")))]))

S("T37-030", "k4 read list where-two when-to effort",
  T("which gaa tasks under half an hour are still open before the agm", rows("gaa_sliotars"),
    ref=[ans(kind="task", linked_to="$gaa_list", where="status = open and effort < 30",
             when=W({"to": D("2027-03-18")}))]),
  T("tick that off and tell me what's left on the gaa list before the agm",
    rows("gaa_report", also=diff(upd("gaa_sliotars", status="completed", completed=ANY))),
    ref=[act("complete", rows="$gaa_sliotars", more=True),
         ans(kind="task", linked_to="$gaa_list", where="status = open", when=W({"to": D("2027-03-18")}))]))

S("T37-031", "k4 read next-three link where order-limit",
  T("next three things with tadhg, not cancelled",
    rows("training_0309", "hurling_match", "training_0316", order=True),
    ref=[bad(ans(kind="event", linked_to="$tadhg", when=W({"from": U("day", 0)}), where="status != cancelled",
                 order="start asc", limit=3)),
         ans(kind="event", linked_to="$tadhg", when=W({"from": U("day", 0)}), where="status != cancelled",
             order="date asc", limit=3)]),
  T("which of those is the longest", rows("hurling_match"),
    ref=[ans(within="@prev", order="duration desc", limit=1)]))

S("T37-032", "k4 read superlative debts where-two when order",
  T("biggest debt i owe from before the new year", rows("d_declan"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", when=W({"to": D("2026-12-31")}),
             order="amount desc", limit=1)]))

S("T37-033", "k4 count link where-two",
  T("how many open health tasks take under half an hour", val(2),
    ref=[ans(op="count", kind="task", linked_to="$health_list", where="status = open and effort < 30")]))

S("T37-034", "k4 read exclude link where when",
  T("which family tasks are open before the christening, besides the lamb order",
    rows("aoife_key", "easter_flowers", "easter_eggs", "easter_beds", "easter_proj", "conor_visit", "communion_dress"),
    ref=[ans(kind="task", linked_to="$family_list", where="status = open", when=W({"to": D("2027-04-17")}),
             exclude="$easter_lamb")]))

S("T37-035", "already-so star order-limit then answer follow-up star",
  T("star the newest pension statement", diff(already=["pension_stmt"]),
    ref=[act("star", kind="document", name="pension statement", order="date desc", limit=1),
         ans(rows="$pension_stmt")]),
  T("ok star last year's pension statement too", diff(upd("pension_stmt25", starred=True)),
    ref=[find(kind="document", name="pension statement", when=W(U("year", -1))), act("star", rows="@prev")]))

S("T37-036", "search-role log person search-role again",
  T("spoke to the plumber, log it", diff(upd("plumber", date="2027-03-09T10:40")),
    ref=[search("plumber", kind="person"), act("log", rows="$plumber", args="kind: call")]),
  T("and the accountant, rang him earlier", diff(upd("pat", date="2027-03-09T10:40")),
    ref=[search("accountant", kind="person"), act("log", rows="$pat", args="kind: call")]),
  T("and the optician, popped in this morning", diff(upd("optician", date="2027-03-09T10:40")),
    ref=[search("optician", kind="person"), act("log", rows="$optician", args="kind: visit")]))

S("T37-037", "reveal cvv star-locker",
  T("what's the cvv on the aib card", diff(reveal=[("aib_card", "507")]),
    ref=[act("reveal", rows="$aib_card", args="field: cvv")]),
  T("star that card", diff(upd("aib_card", starred=True)),
    ref=[act("star", rows="$aib_card")]))

S("T37-038", "two-writes pin unpin then read-pinned",
  T("pin the agm agenda and unpin the book club rules",
    diff(upd("gaa_agm_note", pinned=True), upd("bk_rules", pinned=False)),
    ref=[act("edit", rows="$gaa_agm_note", args="pinned: yes", more=True),
         act("edit", rows="$bk_rules", args="pinned: no")]),
  T("which pinned notes are in the gaa notebook", rows("gaa_u12", "gaa_agm_note"),
    ref=[ans(kind="note", linked_to="$gaa_nb", where="pinned = yes")]))

S("T37-039", "settle_debt by link then still-owed read",
  T("nuala paid me back the bin collection money", diff(upd("d_nuala", status="settled")),
    ref=[act("settle_debt", kind="debt", name="bin collection", linked_to="$nuala")]),
  T("and what's still owed to me", rows("d_conor", "d_aoife_cake", "d_gerry", "d_sean_b"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]))

S("T37-040", "two-writes settle_debt complete different-rows then sum",
  T("i paid siobhan for the march books this morning so settle that and tick off the task for it",
    diff(upd("d_siobhan", status="settled"), upd("book_pay", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="march books", linked_to="$siobhan", more=True),
         act("complete", rows="$book_pay")]),
  T("how much do i still owe in total", val((262.5, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]))

S("T37-041", "delete all apply_all cancelled then restore find-trashed",
  T("delete all the cancelled tasks on the house list", diff(trash("cancelled_shed"), trash("cancelled_patio")),
    ref=[find(kind="task", linked_to="$house_list", where="status = cancelled"),
         act("delete", rows="@prev")]),
  T("bring the shed task back", diff(restore("cancelled_shed")),
    ref=[find(kind="task", name="shed", trashed=True), act("restore", rows="@prev")]),
  T("and the patio one too", diff(restore("cancelled_patio")),
    ref=[find(kind="task", name="patio", trashed=True), act("restore", rows="@prev")]))

S("T37-042", "two-writes edit-cadence log then who-weekly",
  T("brendan's on a 60 day cadence, make it 30 and log the coffee today",
    diff(upd("brendan", cadence=30, date="2027-03-09T10:40")),
    ref=[act("edit", rows="$brendan", args="cadence: 30", more=True),
         act("log", rows="$brendan", args="kind: coffee")]),
  T("who else is on a weekly cadence that's starred", rows("declan", "tadhg"),
    ref=[ans(kind="person", where="cadence = 7 and starred = yes")]))

S("T37-043", "create event retry edit-duration",
  T("lunch with maura on friday at 1", diff(new("event", name=has("lunch", "maura"), date="2027-03-12T13:00")),
    ref=[act("create", args="kind: event\nname: Lunch with Maura\n" + lines(date=U("week", 0, weekday=5, time="13:00")))]),
  T("make it an hour and a half", diff(upd("+1", duration=90)),
    ref=[act("edit", rows="$new", args="duration: 90")]),
  T("what else is on friday besides the lunch", rows("hearing"),
    ref=[ans(kind="event", when=W(D("2027-03-12")), exclude="$new")]))

S("T37-044", "restore near-spelling apply then restore past-window decline",
  T("restore ciaran", diff(restore("old_coach")),
    ref=[act("restore", kind="person", name="ciaran")]),
  T("and bernard the old plumber", decline("not_found"),
    ref=[act("restore", kind="person", name="bernard")]))

S("T37-045", "find-trashed restore note then read",
  T("bring back the scratch list note", diff(restore("old_scratch")),
    ref=[find(kind="note", name="scratch list", trashed=True), act("restore", rows="@prev")]),
  T("what's on it", rows("old_scratch"),
    ref=[ans(kind="note", name="scratch list")]))

S("T37-046", "trashed read note restore",
  T("is the old eir login still there", rows("old_login"),
    ref=[ans(kind="locker item", name="old eir login")]),
  T("restore it", diff(restore("old_login")),
    ref=[act("restore", rows="$old_login")]),
  T("and the old tuam road wifi", rows("old_wifi"),
    ref=[ans(kind="locker item", name="old tuam road wifi")]),
  T("restore that one too", decline("not_found"),
    ref=[act("restore", rows="$old_wifi")]))

S("T37-047", "delete notebook unlinks then where-count-zero",
  T("delete the garden notebook, notes stay",
    diff(gone("garden_nb"), unlink("garden_nb", "gd_roses"), unlink("garden_nb", "gd_veg")),
    ref=[act("delete", rows="$garden_nb")]),
  T("which notes from this year aren't in a notebook now",
    rows("gd_roses", "gd_veg", "diary_walk", "diary_cian", "boston_notes", "mo_gifts"),
    ref=[ans(kind="note", where="notebook count = 0", when=W(U("year", 0)))]))

S("T37-048", "create locker item star created",
  T("add the gym to the locker as a membership", diff(new("locker item", name="Gym", type="membership")),
    ref=[act("create", args="kind: locker item\nname: Gym\ntype: membership")]),
  T("and star it", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$new")]))
