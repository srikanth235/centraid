from gold import *

import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")

def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-205-P", "search-role physio events-this-month within-duration edit-all para",
  T("this month's events involving the physio", rows("physio_a", "physio_b"),
    ref=[search("physio", kind="person"), ans(kind="event", linked_to="$physio", when=J(U("month", 0)))]),
  T("those running past 40 minutes?", rows("physio_a", "physio_b"),
    ref=[ans(within="@prev", where="duration > 40")]),
  T("set them all to 60 minutes", diff(upd("physio_a", duration=60), upd("physio_b", duration=60)),
    ref=[act("edit", rows="@3", args="duration: 60")]))

S("T31-211-P", "repair-settle-up-group kasia balance james open-trip para",
  T("kasia and i need settling up", diff(upd("kasia", balance=ANY)),
    ref=[bad(act("settle_up", rows="$kasia")),
         act("settle_up", rows="$kasia", args=lines(group="$london"))]),
  T("my position in the london group now?", val((0, "GBP")),
    ref=[search("Tomasz", kind="person"),
         ans(op="balance", kind="group", name="London Christmas", linked_to="$me")]),
  T("james's position?", val((-16, "GBP")),
    ref=[ans(op="balance", kind="group", name="London Christmas", linked_to="$james")]),
  T("open tasks for the trip?", rows("london_gifts", "london_pounds", "london_pack"),
    ref=[ans(kind="task", linked_to="$london_trip", where="status = open")]))

S("T31-223-P", "delete-event name-when kasia call restore para",
  T("kasia call on the 22nd, delete it", diff(trash("kasia_call2")),
    ref=[act("delete", kind="event", name="call kasia", when=J(D("2026-11-22")))]),
  T("the kasia call needs to come back", diff(restore("kasia_call2")),
    ref=[find(kind="event", name="call kasia", trashed=True), act("restore", rows="@1")]))

S("T31-229-P", "star-photos name-when linked-when nowy-sacz starred-count para",
  T("put a star on the roses photo from august", diff(upd("p_ns_babcia", starred=True)),
    ref=[act("star", kind="photo", name="roses", when=J(U("month", -1, name=8)))]),
  T("july's one of tata too", diff(upd("p_ns_tata", starred=True)),
    ref=[act("star", kind="photo", linked_to="$tata", when=J(U("month", -1, name=7)))]),
  T("starred photo count in the nowy sacz album now?", val(3),
    ref=[ans(op="count", kind="photo", linked_to="$family_a", where="starred = yes")]))

S("T31-235-P", "ask-missing-debt create kuba biggest count-open-small para",
  T("new debt", ask(),
    ref=[askc("Who, how much, and which way?")]),
  T("for the pizza, kuba owes me 15", diff(new("debt", name=has("pizza"), amount=15, direction="owes_me"), link("new", "kuba")),
    ref=[act("create", kind="debt", args=lines(person="$kuba", amount=15, direction="owes_me", name="the pizza"))]),
  T("kuba's biggest debt?", rows("d_kuba_gas"),
    ref=[ans(kind="debt", linked_to="$kuba", order="amount desc", limit=1)]),
  T("kuba's open debts under 40, count?", val(2),
    ref=[ans(op="count", kind="debt", linked_to="$kuba", where="status = open and amount < 40")]))

S("T31-253-P", "ambiguous-event delete kasia call pick eighth left edit-duration para",
  T("kasia call, delete it", ask("kasia_call", "kasia_call2"),
    ref=[act("delete", kind="event", name="call kasia")]),
  T("8th one", diff(trash("kasia_call")),
    ref=[act("delete", kind="event", name="call kasia", when=J(D("2026-11-08")))]),
  T("remaining calls with kasia?", rows("kasia_call2"),
    ref=[ans(kind="event", name="call kasia")]),
  T("60 minutes for it", diff(upd("kasia_call2", duration=60)),
    ref=[act("edit", rows="$kasia_call2", args="duration: 60")]))

S("T31-259-P", "decline-out-of-scope pay kuba settle-gas count-owed-over smallest-owed para",
  T("kuba needs paying back, do that for me", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("fine, my gas share is paid then, mark it", diff(upd("d_kuba_gas", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$kuba", where="direction = i_owe")]),
  T("debts i still owe over 30, how many", val(4),
    ref=[ans(op="count", kind="debt", where="direction = i_owe and status = open and amount > 30")]),
  T("smallest one i owe?", rows("d_ewa"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount asc", limit=1)]),
  T("october's cleaning supplies debt to ola, settle it", diff(upd("d_ola_clean", status="settled")),
    ref=[act("settle_debt", kind="debt", name="cleaning supplies", linked_to="$ola", when=J(U("month", -1, name=10)))]))

S("T31-265-P", "ask-delete-which five-a-side tenth marcin next-after para",
  T("delete that one", ask(),
    ref=[askc("Delete which one?")]),
  T("marcin lis's five-a-side game on the 10th", diff(trash("fas_1110")),
    ref=[act("delete", kind="event", name="five-a-side", when=J(D("2026-11-10")), linked_to="$marcin_l")]),
  T("next hall game following that one?", rows("fas_1117"),
    ref=[ans(kind="event", name="five-a-side hall", when=J({"from": D("2026-11-11")}), order="date asc", limit=1)]),
  T("piotr's hall game on the 17th goes back a day, same time", diff(upd("fas_1117", date="2026-11-18T20:00")),
    ref=[act("reschedule", kind="event", name="five-a-side hall", when=J(D("2026-11-17")), linked_to="$piotr", args=lines(to=D("2026-11-18", "20:00")))]))

S("T31-271-P", "decline-out-of-scope text barber reschedule-haircut twenty-first para",
  T("text the barber, i need my haircut moved", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok haircut on the 14th becomes the 21st at 11", diff(upd("barber_ev", date="2026-11-21T11:00")),
    ref=[act("reschedule", kind="event", name="haircut", when=J(D("2026-11-14")), args=lines(to=D("2026-11-21", "11:00")))]),
  T("21st, what's on now", rows("wedding_adi", "barber_ev"),
    ref=[ans(kind="event", when=J(D("2026-11-21")))]))

S("T31-277-P", "values-narrowing people cadence not-starred hospital then star para",
  T("number of people with a cadence set?", val(13),
    ref=[ans(op="count", kind="person", where="cadence is set")]),
  T("of those, count the unstarred", val(7),
    ref=[ans(op="count", kind="person", where="cadence is set and starred = no")]),
  T("from university hospital, how many of those", val(3),
    ref=[ans(op="count", kind="person", where='cadence is set and starred = no and met = "University Hospital"')]),
  T("put a star on the university hospital ones", diff(upd("anna_w", starred=True), upd("ewa", starred=True), upd("marcin_b", starred=True)),
    ref=[find(kind="person", where='cadence is set and starred = no and met = "University Hospital"'), act("star", rows="@4")]))
