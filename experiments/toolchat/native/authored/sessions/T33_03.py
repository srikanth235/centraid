from gold import *


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T33-052", "find-superlative-then-complete three-constraints",
  T("tick off the quickest task on kenji's list, did it during the nap", diff(upd("k_vacc", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$kenji_l", where="status = open", order="effort asc", limit=1),
         act("complete", rows="@prev")]))

S("T33-053", "find-next-then-cancel",
  T("cancel the next committee meeting, the chairman's away", diff(upd("cm_budget", status="cancelled")),
    ref=[find(kind="event", name="committee meeting", order="date asc", limit=1, when=J({"from": U("day", 0)})),
         act("cancel", rows="@prev")]))

S("T33-054", "find-newest-unstarred-then-star three-constraints",
  T("star the latest photo of kenji that isn't starred yet", diff(upd("p_k_bubbles", starred=ANY)),
    ref=[find(kind="photo", linked_to="$kenji", where="starred = no", order="date desc", limit=1),
         act("star", rows="@prev")]))

S("T33-055", "role-search find-only",
  T("who's the maid agency contact again", rows("agency"),
    ref=[search("maid agency", kind="person"),
         ans(rows="@prev")]))

S("T33-056", "text-person decline",
  T("message mei i'm running late tonight", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T33-057", "bulk-cap ask-count yes-confirm delete-thirteen",
  T("delete all the done or cancelled tasks", ask(),
    ref=[find(kind="task", where='status in ("completed", "cancelled")'),
         act("delete", rows="@prev")]),
  T("yes go ahead",
    diff(trash("permit_b"), trash("fee_oct"), trash("minutes"), trash("k_diapers_old"), trash("fee_nov"),
         trash("utilities_nov"), trash("starhub"), trash("h_groceries_old"), trash("pg_flights"), trash("pg_carseat"),
         trash("rina_leave"), trash("w_leave"), trash("k_toys")),
    ref=[act("delete", rows="@prev")]))

S("T33-058", "ambiguous-star ask pick-by-month",
  T("star the committee minutes", ask("d_minutes_oct", "d_minutes_nov"),
    ref=[act("star", kind="document", name="committee minutes")]),
  T("the november one", diff(upd("d_minutes_nov", starred=ANY)),
    ref=[act("star", rows="$d_minutes_nov")]))

S("T33-059", "settle_debt write-read balance second-debt-by-name",
  T("paid wei jie back for the omakase, settle it and tell me what i owe him now",
    val((-160, "SGD"), also=diff(upd("d_weijie", status="settled"))),
    ref=[act("settle_debt", rows="$d_weijie", more="true"),
         ans(op="balance", kind="person", name="wei jie")]),
  T("and jia hui's pumpkin patch one too", diff(upd("d_jiahui", status="settled")),
    ref=[act("settle_debt", kind="debt", name="pumpkin patch", linked_to="$jiahui")]))

S("T33-060", "two-writes log-star then group-starred",
  T("log coffee with kim and star her", diff(upd("kim", date=ANY, starred=ANY)),
    ref=[act("log", rows="$kim", args="kind: coffee", more="true"),
         act("star", rows="$kim")]),
  T("starred people in the dinner club", rows("weijie", "kim"),
    ref=[ans(kind="person", linked_to="$dinner", where="starred = yes")]))

S("T33-061", "search-empty recovery then never-mind",
  T("who's our plumber", rows(),
    ref=[search("plumber"),
         ans(kind="person", name="plumber")]),
  T("actually forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T33-062", "search-empty-recovery repair-time two-writes three-constraints cancel-complete",
  T("when's the babysitter coming next week, i need to book dinner", rows("babysit_ma"),
    ref=[search("babysitter"),
         search("babysit"),
         ans(kind="event", name="babysits", when=J(U("week", 1)))]),
  T("make it start at 7:30 and add that rina should bring kenji's swim bag",
    diff(upd("babysit_ma", date="2026-12-19T19:30", description=has("swim bag"))),
    ref=[bad(act("reschedule", rows="$babysit_ma", args='to: {"date":"2026-12-19","time":"7:30"}', more="true")),
         act("reschedule", rows="$babysit_ma", args=lines(to=D("2026-12-19", "19:30")), more="true"),
         act("edit", rows="$babysit_ma", args="description: bring kenji's swim bag")]),
  T("which events next week with mei aren't cancelled", rows("swim_1219", "babysit_ma"),
    ref=[ans(kind="event", linked_to="$mei", where="status != cancelled", when=J(U("week", 1)))]),
  T("cancel the permit appointment and tick off the permit task",
    diff(upd("permit_visit", status="cancelled"), upd("permit_a", status="completed", completed=ANY)),
    ref=[act("cancel", rows="$permit_visit", more="true"),
         act("complete", kind="task", name="renew rina's work permit")]))

S("T33-063", "four-constraints debts ambiguous-delete-ask two-writes count-docs",
  T("which debts i owe from before december are still open and over fifty dollars", rows("d_weijie", "d_junhao", "d_jiahui"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open and amount > 50", when=J({"to": U("month", -1)}))]),
  T("delete the condo budget doc from the condo folder", ask("d_budget26", "d_budget27"),
    ref=[act("delete", kind="document", name="condo budget", linked_to="$condo_f")]),
  T("get rid of the 2026 one and unstar the 2027 one, david has his own copy",
    diff(trash("d_budget26"), upd("d_budget27", starred=ANY)),
    ref=[act("delete", rows="$d_budget26", more="true"),
         act("unstar", rows="$d_budget27")]),
  T("how many docs left in condo folder", val(5),
    ref=[ans(op="count", kind="document", linked_to="$condo_f")]))

S("T33-064", "search-empty-recovery write-read ambiguous-log-ask pick-by-group",
  T("did i note down kenji's tuition fees somewhere, i swear i wrote it", rows(),
    ref=[search("tuition"),
         ans(kind="note", where='body contains "tuition"')]),
  T("right, moving on: star the penang flight confirmation and tell me which documents aren't filed anywhere",
    rows("d_insure_h", "d_flights", also=diff(upd("d_flights", starred=ANY))),
    ref=[act("star", rows="$d_flights", more="true"),
         ans(kind="document", where="folder count = 0")]),
  T("log a call with priya", ask("priya_nair", "priya_nayar"),
    ref=[act("log", kind="person", name="priya", args="kind: call")]),
  T("the playgroup one", diff(upd("priya_nair", date=ANY)),
    ref=[act("log", rows="$priya_nair", args="kind: call")]))

S("T33-065", "day-plan already-so reschedule ambiguous-ask pick open-today complete",
  T("what's on tomorrow", rows("brunch_wj", "hotpot_kim"),
    ref=[ans(kind="event", when=J(U("day", 1)))]),
  T("cancel the hotpot", diff(already=["hotpot_kim"]),
    ref=[act("cancel", rows="$hotpot_kim"),
         ans(rows="$hotpot_kim")]),
  T("ok then move brunch to 12", diff(upd("brunch_wj", date="2026-12-13T12:00")),
    ref=[act("reschedule", rows="$brunch_wj", args=lines(to=U("day", 1, time="12:00")))]),
  T("move kenji's paediatrician check up to friday", ask("ped_a", "ped_b"),
    ref=[act("reschedule", kind="event", name="paediatrician check up", args=lines(to=U("week", 1, weekday=5)))]),
  T("the december one, same time", diff(upd("ped_a", date="2026-12-18T10:30")),
    ref=[act("reschedule", rows="$ped_a", args=lines(to=U("week", 1, weekday=5)))]),
  T("today's tasks that are still open", rows("noise"),
    ref=[ans(kind="task", where="status = open", when=J(U("day", 0)))]),
  T("tick it off, i replied this morning", diff(upd("noise", status="completed", completed=ANY)),
    ref=[act("complete", rows="$noise")]))
