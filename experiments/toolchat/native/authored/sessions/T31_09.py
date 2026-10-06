from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-145", "due before the 8th open longest first find-complete-within sum-rest",
  T("what's due before the 8th and still open",
    rows("rent_nov", "shopping", "pay_ola", "bin_rota", "handover", "kit_wash", "pay_pizza", "pay_marta"),
    ref=[ans(kind="task", where="status = open", when=J({"to": D("2026-11-07")}))]),
  T("of those, the one that takes longest", rows("shopping"),
    ref=[ans(within="@1", order="effort desc", limit=1)]),
  T("and which is due first", rows("rent_nov"),
    ref=[ans(within="@1", order="date asc", limit=1)]),
  T("tick off all of those under 10 minutes",
    diff(upd("pay_ola", status="completed", completed=ANY), upd("bin_rota", status="completed", completed=ANY),
         upd("pay_pizza", status="completed", completed=ANY), upd("pay_marta", status="completed", completed=ANY)),
    ref=[find(kind="task", within="@1", where="effort < 10"), act("complete", rows="@4")]),
  T("how many minutes of the rest are there", val(50),
    ref=[ans(op="sum", field="effort", within="@1", where="status = open")]))

S("T31-146", "night shifts left this month earliest after-it cancel-swap count",
  T("which night shifts are left this month", rows("shift_1109", "shift_1111", "night_swap", "shift_1123"),
    ref=[ans(kind="event", name="night shift", when=J(span(U("day", 0), D("2026-11-30"))))]),
  T("which of those is the earliest", rows("shift_1109"),
    ref=[ans(within="@1", order="date asc", limit=1)]),
  T("and the one after it", rows("shift_1111"),
    ref=[ans(within="@1", order="date asc", limit=1, exclude="$shift_1109")]),
  T("cancel the swap one, marcin took it", diff(upd("night_swap", status="cancelled")),
    ref=[act("cancel", rows="$night_swap")]),
  T("so how many night shifts are left this month", val(3),
    ref=[ans(op="count", kind="event", name="night shift", where="status != cancelled", when=J(span(U("day", 0), D("2026-11-30"))))]))

S("T31-147", "notes since october about-someone most-recent pin pinned",
  T("which notes did i write since october",
    rows("n_london_ideas", "n_league", "n_gifts", "n_physio", "n_diary_good", "n_ward_meet", "n_stag", "n_diary_shift"),
    ref=[ans(kind="note", when=J({"from": D("2026-10-01")}))]),
  T("keep the ones about a person", rows("n_london_ideas", "n_gifts", "n_physio", "n_ward_meet", "n_stag", "n_diary_shift"),
    ref=[ans(within="@1", where="person count >= 1")]),
  T("which of them is the most recent", rows("n_diary_shift"),
    ref=[ans(within="@1", order="date desc", limit=1)]),
  T("pin the physio advice one from october", diff(upd("n_physio", pinned=True)),
    ref=[act("edit", kind="note", name="physio advice", when=J(U("month", -1, name=10)), args="pinned: yes")]),
  T("and which notes are pinned now", rows("n_flat_rules", "n_handover", "n_physio"),
    ref=[ans(kind="note", where="pinned = yes")]))

S("T31-148", "when templates first league december last call kasia night shift day shift physio empty",
  T("when's the first league match in december", rows("league_1206"),
    ref=[ans(kind="event", name="league match", when=J(U("month", 0, name=12)), order="date asc", limit=1)]),
  T("and the last call with kasia before the 20th", rows("kasia_call"),
    ref=[ans(kind="event", name="call kasia", when=J({"to": D("2026-11-19")}), order="date desc", limit=1)]),
  T("the last night shift before the 20th", rows("night_swap"),
    ref=[ans(kind="event", name="night shift", when=J({"to": D("2026-11-19")}), order="date desc", limit=1)]),
  T("the next day shift after the 6th", rows("shift_1116"),
    ref=[ans(kind="event", name="day shift", when=J({"from": D("2026-11-07")}), order="date asc", limit=1)]),
  T("is there a physio in december", rows(),
    ref=[ans(kind="event", name="physio", when=J(U("month", 0, name=12)))]))

S("T31-149", "when templates mama after-15th five-a-side flat dinner league year count december",
  T("when's the next call with mama after the 15th", rows("mama_1122"),
    ref=[ans(kind="event", name="call mama", when=J({"from": D("2026-11-16")}), order="date asc", limit=1)]),
  T("and the last five-a-side before the 3rd", rows("fas_1027"),
    ref=[ans(kind="event", name="five-a-side", when=J({"to": D("2026-11-02")}), order="date desc", limit=1)]),
  T("when's the next flat dinner", rows("flat_dinner"),
    ref=[ans(kind="event", name="flat dinner", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("when's the last league match this year", rows("league_1206"),
    ref=[ans(kind="event", name="league match", when=J(U("year", 0)), order="date desc", limit=1)]),
  T("how many league matches are in december", val(1),
    ref=[ans(op="count", kind="event", name="league match", when=J(U("month", 0, name=12)))]))

S("T31-150", "debts over a hundred older other-one min max owed-to-me compute",
  T("which debts over a hundred are still open", rows("d_natalia", "d_kasia"),
    ref=[ans(kind="debt", where="amount > 100 and status = open")]),
  T("which of those is older", rows("d_natalia"),
    ref=[ans(within="@1", order="date asc", limit=1)]),
  T("and what's the other one for", rows("d_kasia"),
    ref=[ans(within="@1", exclude="$d_natalia")]),
  T("lowest amount someone still owes me", val((20, "PLN")),
    ref=[comp(op="min", field="amount", kind="debt", where="direction = owes_me and status = open"), ans(value="@prev")]),
  T("and the highest one", val((90, "PLN")),
    ref=[comp(op="max", field="amount", kind="debt", where="direction = owes_me and status = open"), ans(value="@prev")]))

S("T31-151", "find-act four facets flat jobs football photos admin tasks ward priority",
  T("tick off the open flat jobs due before the weekend that take under 15 minutes",
    diff(upd("bin_rota", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$flat_l", where="status = open and effort < 15", when=J({"to": D("2026-11-08")})),
         act("complete", rows="@1")]),
  T("star all the football album photos from this year that aren't starred",
    diff(upd("p_fb_goal", starred=True), upd("p_fb_cup", starred=True), upd("p_fb_hall", starred=True),
         upd("p_fb_pizza", starred=True), upd("p_fb_boots", starred=True)),
    ref=[find(kind="photo", linked_to="$football_a", where="starred = no", when=J(U("year", 0))), act("star", rows="@2")]),
  T("push the open admin tasks due before the 20th that take over half an hour to the 27th",
    diff(upd("pit_docs", date="2026-11-27"), upd("bike_fix", date="2026-11-27")),
    ref=[find(kind="task", linked_to="$admin_l", where="status = open and effort > 30", when=J({"to": D("2026-11-19")})),
         act("reschedule", rows="@3", args=lines(to=D("2026-11-27")))]),
  T("set the open ward tasks due this month that are about someone to priority 2",
    diff(upd("swap_shift", priority=2), upd("gift_card", priority=2)),
    ref=[find(kind="task", linked_to="$ward_l", where="status = open and person count >= 1", when=J(U("month", 0))),
         act("edit", rows="@4", args="priority: 2")]))

S("T31-152", "recovery-nolink london group tasks zakopane packing ward list events",
  T("what's due for the london group", rows("london_gifts", "london_pounds", "london_pack"),
    ref=[ans(kind="task", linked_to="$london", where="status = open"),
         ans(kind="task", linked_to="$london_trip", where="status = open")]),
  T("tick off the zakopane group's packing list", diff(upd("zak_pack", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", linked_to="$zakopane"),
         act("complete", kind="task", name="zakopane packing list")]),
  T("what's on the ward list this year", rows("hospital_party"),
    ref=[find(kind="event", linked_to="$ward_l", when=J(U("year", 0))),
         ans(kind="event", name="ward", when=J(U("year", 0)))]))

S("T31-153", "compute max min sum open tasks debts",
  T("which open task eats the most time", val(120),
    ref=[comp(op="max", field="effort", kind="task", where="status = open"), ans(value="@prev")]),
  T("and the shortest", val(5),
    ref=[comp(op="min", field="effort", kind="task", where="status = open"), ans(value="@prev")]),
  T("sum up everything i owe", val((546, "PLN")),
    ref=[comp(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open"), ans(value="@prev")]))

S("T31-154", "write-then-read complete star log create read-where",
  T("tick off the cpr module and show me what's still open that takes over an hour",
    rows("london_gifts", also=diff(upd("cpr_prep", status="completed", completed=ANY))),
    ref=[act("complete", rows="$cpr_prep", more=True), ans(kind="task", where="status = open and effort > 60")]),
  T("star the nfz confirmation and show me which documents are starred",
    rows("d_licence", "d_contract", "d_nfz", "d_lease26", also=diff(upd("d_nfz", starred=True))),
    ref=[act("star", kind="document", name="nfz", more=True), ans(kind="document", where="starred = yes")]),
  T("log a call with tata and show me who i've spoken to today",
    rows("kuba", "marcin_b", "tata", also=diff(upd("tata", date=ANY))),
    ref=[act("log", rows="$tata", args="kind: call", more=True), ans(kind="person", when=J(U("day", 0)))]),
  T("create a task to collect the keys on the 12th and show me what else is due that day",
    rows("train_ticket", "gas_pay", also=diff(new("task", name=has("keys"), date="2026-11-12"))),
    ref=[act("create", kind="task", args=lines(name="Collect the keys", date=D("2026-11-12")), more=True),
         ans(kind="task", when=J(D("2026-11-12")), where="status = open", exclude="$new")]))
