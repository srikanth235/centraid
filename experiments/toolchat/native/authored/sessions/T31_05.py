from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-092", "compute-status groups open-long sum-within reschedule what-else",
  T("how many tasks have i got in each status",
    vgroups({"cancelled": 1, "completed": 14, "in_progress": 1, "open": 42}),
    ref=[comp(op="count", kind="task", group="status"), ans(value="@1")]),
  T("which of the open ones take longer than an hour", rows("cpr_prep", "london_gifts"),
    ref=[ans(kind="task", where="status = open and effort > 60")]),
  T("and how many minutes is that between them", val(210),
    ref=[ans(op="sum", field="effort", within="@prev")]),
  T("push the cpr module to friday week", diff(upd("cpr_prep", date="2026-11-20")),
    ref=[act("reschedule", rows="$cpr_prep", args=lines(to=U("week", 2, weekday=5)))]),
  T("anything else landing on that friday", rows("pit"),
    ref=[ans(kind="task", when=J(D("2026-11-20")), where="status = open", exclude="$cpr_prep")]))

S("T31-093", "compute-locker types within exclude star empty-cards",
  T("what kinds of stuff is in the locker, how many of each",
    vgroups({"api_credential": 1, "bank_account": 1, "card": 2, "crypto_wallet": 1, "document": 1, "driving_licence": 1,
             "identity": 1, "login": 3, "membership": 1, "note": 1, "passport": 1, "password": 1,
             "software_licence": 1, "ssh_key": 1, "wifi": 2}),
    ref=[comp(op="count", kind="locker item", group="type"), ans(value="@1")]),
  T("just the logins, apart from the bank one", rows("uh_portal", "netflix_login"),
    ref=[ans(kind="locker item", where="type = login", exclude="$pko_login")]),
  T("star the netflix one", diff(upd("netflix_login", starred=True)),
    ref=[act("star", rows="$netflix_login")]),
  T("which of my cards are starred", rows(),
    ref=[ans(kind="locker item", where="type = card and starred = yes")]))

S("T31-094", "debts max compute biggest settle max-again",
  T("what's the most i owe anyone at the moment", val((180, "PLN")),
    ref=[comp(op="max", field="amount", kind="debt", where="direction = i_owe and status = open"), ans(value="@1")]),
  T("which debt is that one", rows("d_natalia"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=1)]),
  T("settled it, paid natalia this morning", diff(upd("d_natalia", status="settled")),
    ref=[act("settle_debt", rows="$d_natalia")]),
  T("so what's the most i owe now", val((150, "PLN")),
    ref=[comp(op="max", field="amount", kind="debt", where="direction = i_owe and status = open"), ans(value="@prev")]))

S("T31-095", "mama calls count left within-babcia reschedule day-before",
  T("how many calls with mama have i got left", val(5),
    ref=[ans(op="count", kind="event", name="call mama", when=J({"from": U("day", 0)}))]),
  T("which of those have babcia on", rows("mama_1108", "mama_1122", "mama_1206"),
    ref=[ans(within="@1", where='description contains "Babcia"')]),
  T("move the december one to the day before", diff(upd("mama_1206", date="2026-12-05T18:30")),
    ref=[act("reschedule", rows="$mama_1206", args=lines(to=U("day", -1, anchor="row")))]))

S("T31-096", "effort sum this week within complete-two count-again",
  T("how many minutes of tasks are due this week", val(130),
    ref=[ans(op="sum", field="effort", kind="task", where="status = open", when=J(U("week", 0)))]),
  T("ones taking 15 minutes or longer", rows("shopping", "handover", "kit_wash", "boots"),
    ref=[ans(within="@1", where="effort >= 15")]),
  T("tick off the two for football, kit's washed and i bought the shoes",
    diff(upd("kit_wash", status="completed", completed=ANY), upd("boots", status="completed", completed=ANY)),
    ref=[act("complete", rows="$kit_wash, $boots")]),
  T("so how many minutes are still due this week", val(55),
    ref=[ans(op="sum", field="effort", kind="task", where="status = open", when=J(U("week", 0)))]))

S("T31-097", "ask-move-it no-referent bike gym pass friday open",
  T("move it to friday", ask(),
    ref=[askc("Move which one?")]),
  T("the bike brakes task on the admin list", diff(upd("bike_fix", date="2026-11-06")),
    ref=[act("reschedule", kind="task", name="bike brakes", linked_to="$admin_l", args=lines(to=U("week", 0, weekday=5)))]),
  T("and tick off the gym pass on the admin list, i renewed it", diff(upd("gym_pass", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="gym pass", linked_to="$admin_l")]),
  T("what's still open on friday", rows("shopping", "bike_fix", "pay_ola", "bin_rota", "handover", "kit_wash"),
    ref=[ans(kind="task", when=J(U("week", 0, weekday=5)), where="status = open")]))

S("T31-098", "ask-new-note gas meter notebook pin pinned",
  T("new note", ask(),
    ref=[askc("What should the note say?")]),
  T("gas meter reading 4521, taken today", diff(new("note", name=has("Gas meter"), body=has("4521"))),
    ref=[act("create", kind="note", args=lines(name="Gas meter reading", body="4521 taken today"))]),
  T("file it under ideas", diff(link("ideas_nb", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$ideas_nb"))]),
  T("pin it", diff(upd("+1", pinned=True)),
    ref=[act("edit", rows="$c1", args="pinned: yes")]),
  T("which notes are pinned now", rows("n_flat_rules", "n_handover", "+1"),
    ref=[ans(kind="note", where="pinned = yes")]))

S("T31-099", "ask-settle-up missing person group two-settles balance-compute",
  T("settle up", ask(),
    ref=[askc("With whom, and in which group?")]),
  T("with piotr in the football fund", diff(upd("piotr", balance=ANY)),
    ref=[act("settle_up", rows="$piotr", args=lines(group="$fiveaside"))]),
  T("and darek", diff(upd("darek", balance=ANY)),
    ref=[act("settle_up", rows="$darek", args=lines(group="$fiveaside"))]),
  T("where do i stand in the football fund now", val((10, "PLN")),
    ref=[search("Tomasz", kind="person"),
         comp(op="balance", kind="group", name="Tuesday Football Fund", linked_to="$me"), ans(value="@prev")]))

S("T31-100", "ask-diary-when create sunday read calls",
  T("put a call with babcia in the diary", ask(),
    ref=[askc("When should i put it?")]),
  T("sunday at 5", diff(new("event", name=has("Babcia"), date="2026-11-08T17:00")),
    ref=[act("create", kind="event", args=lines(name="Call with Babcia", date=U("week", 0, weekday=7, time="17:00")))]),
  T("which calls have i got on sunday now", rows("+1", "mama_1108", "kasia_call"),
    ref=[ans(kind="event", name="call", when=J(U("week", 0, weekday=7)))]))

S("T31-101", "decline-unbounded notes then bounded before-2026 delete",
  T("clear out all my notes", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("just the ones from before 2026", diff(trash("n_tactics"), trash("n_cpr"), trash("n_boiler"), trash("n_flat_rules"), trash("n_kit")),
    ref=[find(kind="note", when=J({"to": D("2025-12-31")})), act("delete", rows="@1")]),
  T("bring the flat rules note back", diff(restore("n_flat_rules")),
    ref=[find(kind="note", name="flat rules", trashed=True), act("restore", rows="@2")]))

S("T31-102", "decline-sealed-egress bank login username read",
  T("whatsapp my bank login to the accountant", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("which username did i save on it", rows("pko_login"),
    ref=[ans(kind="locker item", name="bank", where="type = login")]))

S("T31-103", "trashed delete-not-found restore past-window never-mind",
  T("delete the old gym contract", decline("not_found"),
    ref=[act("delete", kind="document", name="old gym contract")]),
  T("could it be sitting in the trash", rows("d_old_inv"),
    ref=[ans(kind="document", name="old gym contract", trashed=True)]),
  T("forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T31-104", "find-only dentist search count left reschedule anchor week",
  T("who's my dentist", rows("dentist"),
    ref=[search("dentist", kind="person"), ans(rows="@1")]),
  T("when am i seeing him next", rows("dentist_ev"),
    ref=[ans(kind="event", name="dentist", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("how many physio sessions have i got left", val(2),
    ref=[ans(op="count", kind="event", name="physio", where="status != cancelled", when=J({"from": U("day", 0)}))]),
  T("push the physio on the 26th back a week", diff(upd("physio_b", date="2026-12-03T16:30")),
    ref=[act("reschedule", kind="event", name="physio", when=J(D("2026-11-26")), args=lines(to=U("week", 1, anchor="row")))]))
