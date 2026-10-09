from gold import *
import json

world("T33", "2026-12-12T08:50", "Hiro Tanaka-Lim", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))

S("T33-001", "committee relation-chain event-people narrow",
  T("who was at the november committee meeting", rows("chua", "david_l", "fong", "kuldeep", "rosnah"),
    ref=[find(kind="event", name="committee meeting", when=J(U("month", -1, name=11))),
         ans(kind="person", linked_to="@prev")]),
  T("what about the budget one", rows("chua", "david_l"),
    ref=[ans(kind="person", linked_to="$cm_budget")]),
  T("open condo list tasks about david lee due next week", rows("budget_sheet", "pay_david"),
    ref=[ans(kind="task", linked_to="$condo_l, $david_l", where="status = open", when=J(U("week", 1)))]))

S("T33-002", "events-today cancel-by-date weekend four-constraints tasks rename-by-date",
  T("what's on today", rows("swim_1212", "cleaners", "movie"),
    ref=[ans(kind="event", when=J(U("day", 0)))]),
  T("cancel today's swim, mei's got a cold", diff(upd("swim_1212", status="cancelled")),
    ref=[act("cancel", kind="event", name="toddler swim", when=J(U("day", 0)))]),
  T("which kenji tasks under 45 minutes are due this weekend", rows("k_swim"),
    ref=[ans(kind="task", linked_to="$kenji_l", where="status = open and effort < 45", when=J(WEEKEND))]),
  T("rename tomorrow's swim trunks task to size 2", diff(upd("k_swim", name=has("trunks", "size 2"))),
    ref=[act("edit", kind="task", name="swim trunks", when=J(U("day", 1)), args="name: Buy Kenji swim trunks size 2")]))

S("T33-003", "balance group-narrow substitution next-empty last",
  T("how much does ravi owe me", val((142.5, "SGD")),
    ref=[ans(op="balance", kind="person", name="ravi")]),
  T("just the dinner club one", val((-231.25, "SGD")),
    ref=[ans(op="balance", kind="group", name="NUS Dinner Club", linked_to="$ravi")]),
  T("and kim?", val((-71.25, "SGD")),
    ref=[ans(op="balance", kind="group", name="NUS Dinner Club", linked_to="$kim")]),
  T("when's the next dinner club", rows(),
    ref=[ans(kind="event", name="dinner club", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("and the last one", rows("dinner_club"),
    ref=[ans(kind="event", name="dinner club", order="date desc", limit=1, when=J({"to": U("day", 0)}))]))

S("T33-004", "subtasks narrow complete-more reschedule",
  T("what's still open under plan the penang christmas trip", rows("pg_gifts", "pg_ringgit", "pg_pack", "pg_pet"),
    ref=[ans(kind="task", linked_to="$penang_trip", where="status = open")]),
  T("those over half an hour and due before christmas eve", rows("pg_gifts", "pg_pack"),
    ref=[ans(within="@prev", where="effort > 30", when=J({"to": D("2026-12-24")}))]),
  T("ringgit's changed already, tick it off and what's left on the trip",
    rows("pg_gifts", "pg_pack", "pg_pet", also=diff(upd("pg_ringgit", status="completed", completed=ANY))),
    ref=[act("complete", rows="$pg_ringgit", more="true"),
         ans(kind="task", linked_to="$penang_trip", where="status = open")]),
  T("and the gifts one, move it from next saturday to friday", diff(upd("pg_gifts", date="2026-12-18")),
    ref=[act("reschedule", kind="task", name="gifts", when=J(U("week", 1, weekday=6)), args=lines(to=U("week", 1, weekday=5)))]))

S("T33-005", "notes body-contains newest edit-pin broken-clause create add_to",
  T("notes in condo notes that mention lift", rows("cn_nov", "cn_lift"),
    ref=[ans(kind="note", linked_to="$condo_nb", where='body contains "lift"')]),
  T("the newest of those", rows("cn_lift"),
    ref=[ans(within="@prev", order="date desc", limit=1)]),
  T("pin it", diff(upd("cn_lift", pinned=ANY)),
    ref=[act("edit", rows="$cn_lift", args="pinned: yes")]),
  T("put the budget note in... hmm, actually make a notebook called Money", diff(new("notebook", name="Money")),
    ref=[act("create", kind="notebook", args="name: Money")]),
  T("ok now stick the monthly budget note in it", diff(link("+1", "budget")),
    ref=[act("add_to", rows="$budget", args="to: $c1")]))

S("T33-006", "documents folder starred year add_to refused-delete still-in",
  T("which starred documents in the condo folder were made before this year", rows("d_sp25"),
    ref=[ans(kind="document", linked_to="$condo_f", where="starred = yes", when=J({"to": U("year", -1)}))]),
  T("and anything in kenji's folder from this year", rows("d_nursery"),
    ref=[ans(kind="document", linked_to="$kenji_f", when=J(U("year", 0)))]),
  T("put the home insurance policy in the money folder", diff(link("money_f", "d_insure_h")),
    ref=[act("add_to", rows="$d_insure_h", args="to: $money_f")]),
  T("and the penang flight confirmation in to file", diff(link("empty_f", "d_flights")),
    ref=[act("add_to", rows="$d_flights", args="to: $empty_f")]),
  T("delete the to file folder", ask("d_flights"),
    ref=[act("delete", rows="$empty_f")]),
  T("is the home loan statement still in money", rows("d_loan"),
    ref=[ans(kind="document", name="home loan statement", linked_to="$money_f")]))

S("T33-007", "photos album person since-date starred add_to-and-star undo find-restore trashed",
  T("kenji's photos in growing up since october", rows("p_k_bday", "p_k_swim", "p_k_bubbles"),
    ref=[ans(kind="photo", linked_to="$kenji, $kenji_a", when=J({"from": U("month", 0, name=10)}))]),
  T("just the starred ones from this year", rows("p_k_bday"),
    ref=[ans(within="@prev", where="starred = yes", when=J(U("year", 0)))]),
  T("put rina's cake pic in the kenji album and star it", diff(link("kenji_a", "p_rina_cake"), upd("p_rina_cake", starred=ANY)),
    ref=[act("add_to", rows="$p_rina_cake", args="to: $kenji_a", more="true"),
         act("star", rows="$p_rina_cake")]),
  T("undo that", diff(unlink("kenji_a", "p_rina_cake"), upd("p_rina_cake", starred=ANY)),
    ref=[act("undo")]),
  T("bring back the blurry photo", diff(restore("p_blurry")),
    ref=[find(kind="photo", name="blurry photo", trashed="true"),
         act("restore", rows="@prev")]))

S("T33-008", "locker wifi reveal egress where-two narrow cvv",
  T("home wifi password?", rows("home_wifi"),
    ref=[ans(kind="locker item", name="home wifi")]),
  T("show me it", diff(reveal=[("home_wifi", "ParcVistaStack12")]),
    ref=[act("reveal", rows="$home_wifi", args="field: password")]),
  T("text it to rina", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("which logins have hiro in the username", rows("dbs_login", "sp_login"),
    ref=[ans(kind="locker item", where='type = login and username contains "hiro"')]),
  T("which of those is starred", rows("dbs_login"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("what's the cvv on the uob card", diff(reveal=[("uob_card", "627")]),
    ref=[act("reveal", kind="locker item", name="uob card", args="field: cvv")]))

S("T33-009", "trash restore window decline people-trashed task-vs-person",
  T("any trashed events", rows("old_lunch", "old_viewing", "old_expo"),
    ref=[ans(kind="event", trashed="true")]),
  T("bring back the flat viewing with pamela, i deleted it by mistake", diff(restore("old_viewing")),
    ref=[find(kind="event", name="flat viewing", trashed="true"),
         act("restore", rows="@prev")]),
  T("and the lunch with marcus", decline("not_found"),
    ref=[act("restore", kind="event", name="lunch with marcus")]),
  T("are any of my contacts sitting in the trash", rows("old_col", "old_agent"),
    ref=[ans(kind="person", trashed="true")]),
  T("restore the property agent task too", diff(restore("old_agent_t")),
    ref=[find(kind="task", name="property agent", trashed="true"),
         act("restore", rows="@prev")]))

S("T33-010", "debts sum biggest person settle undo-not-undone",
  T("what's the total of everything i still owe from before december", val((689, "SGD")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open", when=J({"to": U("month", -1)}))]),
  T("which one's the biggest", rows("d_junhao"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount desc", limit=1)]),
  T("who's that with", rows("junhao"),
    ref=[ans(kind="person", linked_to="$d_junhao")]),
  T("paid him back, settle it", diff(upd("d_junhao", status="settled")),
    ref=[act("settle_debt", rows="$d_junhao")]),
  T("undo that", diff(),
    ref=[act("undo")]))

S("T33-011", "aircon next-query reschedule exclude ambiguous-ask",
  T("when's the next aircon servicing", rows("aircon_a"),
    ref=[ans(kind="event", name="aircon servicing", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("move it to wednesday afternoon", diff(upd("aircon_a", date="2026-12-16T15:00")),
    ref=[act("reschedule", rows="$aircon_a", args=lines(to=U("week", 1, weekday=3, time="15:00")))]),
  T("so what else is happening that wednesday", rows("permit_visit"),
    ref=[ans(kind="event", when=J(U("week", 1, weekday=3)), exclude="$aircon_a")]),
  T("move the aircon servicing to friday", ask("aircon_a", "aircon_b"),
    ref=[act("reschedule", kind="event", name="aircon servicing", args=lines(to=U("week", 1, weekday=5)))]))

S("T33-012", "near-spelling-month edit-description person-links search-empty-recovery",
  T("when's kenji's pediatrician check up this month", rows("ped_a"),
    ref=[ans(kind="event", name="pediatrician check up", when=J(U("month", 0)))]),
  T("add a note to this month's paediatrician check up, bring the booklet", diff(upd("ped_a", description=has("booklet"))),
    ref=[act("edit", kind="event", name="paediatrician check up", when=J(U("month", 0)), args="description: bring the health booklet")]),
  T("which open tasks are about dr ong and due this month", rows("k_vacc"),
    ref=[ans(kind="task", linked_to="$ong", where="status = open", when=J(U("month", 0)))]),
  T("any referral letter from the clinic saved", rows(),
    ref=[search("referral"),
         ans(kind="document", name="referral")]))

S("T33-013", "same-name-tasks status-split reschedule ordinal-date event-link",
  T("renew rina's work permit, which one's still open and due this month", rows("permit_a"),
    ref=[ans(kind="task", name="renew rina's work permit", where="status = open", when=J(U("month", 0)))]),
  T("and the one we did last year", rows("permit_b"),
    ref=[ans(kind="task", name="renew rina's work permit", where="status = completed", when=J(U("year", -1)))]),
  T("move the open one to the 18th", diff(upd("permit_a", date="2026-12-18")),
    ref=[act("reschedule", kind="task", name="renew rina's work permit", where="status = open", args=lines(to=D("2026-12-18")))]),
  T("when's her permit appointment", rows("permit_visit"),
    ref=[ans(kind="event", name="permit", linked_to="$rina")]))

S("T33-014", "condo-fee series find-then-complete repair-completed-field count-four next-empty reopen",
  T("tick off the condo fee, i paid it through giro this morning", diff(upd("fee_dec", status="completed", completed=ANY)),
    ref=[find(kind="task", name="pay condo maintenance fee", where="status = open"),
         act("complete", rows="@prev")]),
  T("how many condo fees paid this year", val(3),
    ref=[bad(ans(op="count", kind="task", name="pay condo maintenance fee", where="status = completed and completed >= 2026-01-01")),
         ans(op="count", kind="task", name="pay condo maintenance fee", where="status = completed", when=J(U("year", 0)))]),
  T("when's the next one due", rows(),
    ref=[ans(kind="task", name="pay condo maintenance fee", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("actually reopen the october one, wrong amount", diff(upd("fee_oct", status="open", completed=ANY)),
    ref=[act("reopen", kind="task", name="pay condo maintenance fee", when=J(U("month", 0, name=10)))]))

S("T33-015", "playgroup find-then-people count-four cancelled",
  T("who was at last week's playgroup", rows("amanda", "priya_nair", "kenji"),
    ref=[find(kind="event", name="playgroup", when=J(U("week", -1))),
         ans(kind="person", linked_to="@prev")]),
  T("how many playgroups got cancelled in november", val(1),
    ref=[ans(op="count", kind="event", name="playgroup", when=J(U("month", 0, name=11)), where="status = cancelled")]))

S("T33-016", "swim cancelled count rows-of-value refused-reschedule",
  T("how many swim lessons got cancelled this year", val(1),
    ref=[ans(op="count", kind="event", name="toddler swim", where="status = cancelled", when=J(U("year", 0)))]),
  T("which one", rows("swim_1017"),
    ref=[ans(rows="@prev")]),
  T("fine, shift it to next saturday instead", ask("swim_1017"),
    ref=[act("reschedule", rows="$swim_1017", args=lines(to=U("week", 1, weekday=6)))]))

S("T33-017", "group balance-zero delete-group unlink",
  T("where do i stand in the birthday gift group", val((0, "SGD")),
    ref=[ans(op="balance", kind="group", name="okaasan birthday gift", linked_to="$me")]),
  T("get rid of that group, we're not doing it", diff(gone("okaasan_gift"), unlink("okaasan_gift", "mei"), unlink("okaasan_gift", "me")),
    ref=[act("delete", rows="$okaasan_gift")]))

S("T33-018", "pa balance narrow-group refused-remove-ask",
  T("where am i with pa", val((-1941.68, "MYR")),
    ref=[ans(op="balance", kind="person", name="pa")]),
  T("just the penang fund one", val((4108.34, "MYR")),
    ref=[ans(op="balance", kind="group", name="Penang Family Fund", linked_to="$pa")]),
  T("take pa out of the penang fund", ask("pa", "penang"),
    ref=[act("remove_from", rows="$pa", args="from: $penang")]))

S("T33-019", "wei jie debts settle_up group-vs-debt balance-after",
  T("how much do i owe wei jie", val((-320, "SGD")),
    ref=[ans(op="balance", kind="person", name="wei jie")]),
  T("settle up with him in the dinner club", diff(upd("weijie", balance=ANY), settle=[("Wei Jie", "160.00")]),
    ref=[act("settle_up", rows="$weijie", args="group: $dinner")]),
  T("and how much is left between us now", val((-160, "SGD")),
    ref=[ans(op="balance", kind="person", name="wei jie")]))

S("T33-020", "bulk-selector apply-all reschedule three-constraints",
  T("push both home tasks due tomorrow to monday",
    diff(upd("h_aircon", date="2026-12-14"), upd("h_groceries", date="2026-12-14")),
    ref=[find(kind="task", linked_to="$home_l", where="status = open", when=J(U("day", 1))),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]))

S("T33-021", "sunday clash create-ask",
  T("what's on sunday that isn't cancelled", rows("brunch_wj"),
    ref=[ans(kind="event", where="status != cancelled", when=J(U("week", 0, weekday=7)))]),
  T("put a call with grace in at 11", ask("brunch_wj"),
    ref=[act("create", kind="event", args="name: Call with Grace\ndate: " + J(U("week", 0, weekday=7, time="11:00")))]))

S("T33-022", "priya decoys balance-by-group balance-by-met log",
  T("how much do i owe priya from playgroup", val((-24, "SGD")),
    ref=[ans(op="balance", kind="person", name="priya", linked_to="$playgroup")]),
  T("and priya from work", val((0, "SGD")),
    ref=[ans(op="balance", kind="person", name="priya", where='met = "work"')]),
  T("star her and log a call with her", diff(upd("priya_nayar", date=ANY, starred=ANY)),
    ref=[act("star", rows="$priya_nayar", more="true"),
         act("log", rows="$priya_nayar", args="kind: call")]))

S("T33-023", "david decoys committee tasks-about three-constraints rename-by-link",
  T("which david's on the committee", rows("david_l"),
    ref=[ans(kind="person", name="david", linked_to="$committee")]),
  T("tasks about him that are still open and due next week", rows("budget_sheet", "pay_david"),
    ref=[ans(kind="task", linked_to="$david_l", where="status = open", when=J(U("week", 1)))]),
  T("rename the gift task for the david from work to team gift", diff(upd("w_gift", name="Team gift")),
    ref=[act("edit", kind="task", name="gift", linked_to="$david_n", args="name: Team gift")]))

S("T33-024", "mei-yin decoy committee balance",
  T("who's mei from the committee", rows("fong"),
    ref=[ans(kind="person", name="mei", linked_to="$committee")]),
  T("so how much am i down with her", val((-180, "SGD")),
    ref=[ans(op="balance", kind="person", name="fong")]))

S("T33-025", "home list week count-four narrow-effort",
  T("home list tasks under half an hour due this week", rows("h_aircon", "h_groceries"),
    ref=[ans(kind="task", linked_to="$home_l", where="status = open and effort < 30", when=J(U("week", 0)))]),
  T("how many is that for next week", val(4),
    ref=[ans(op="count", kind="task", linked_to="$home_l", where="status = open", when=J(U("week", 1)))]),
  T("any of those longer than 15 minutes", rows("h_return", "h_curtain"),
    ref=[ans(within="@prev", where="effort > 15")]))

S("T33-026", "okaasan notes narrow recipes exclude",
  T("okaasan notes written this year", rows("rc_okonomi", "gift_okaasan"),
    ref=[ans(kind="note", linked_to="$okaasan", when=J(U("year", 0)))]),
  T("which of them is the recipe", rows("rc_okonomi"),
    ref=[ans(within="@prev", linked_to="$recipes_nb")]),
  T("and what other recipes are in there", rows("rc_laksa", "rc_bakkutteh", "rc_kaya"),
    ref=[ans(kind="note", linked_to="$recipes_nb", exclude="$rc_okonomi")]))
