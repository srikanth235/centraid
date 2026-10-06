from gold import *

import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")

def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-001-P", "shifts follow-up within exclude cancel para",
  T("night shifts coming up next week?", rows("shift_1109", "shift_1111", "night_swap"),
    ref=[ans(kind="event", name="night shift", when=J(U("week", 1)))]),
  T("magda works which of them", rows("shift_1109", "shift_1111"),
    ref=[ans(within="@prev", linked_to="$magda")]),
  T("monday's shift, who's working it apart from magda", rows("przemek"),
    ref=[ans(kind="person", linked_to="$shift_1109", exclude="$magda")]),
  T("next friday's swap shift is off since marcin took it, cancel it", diff(upd("night_swap", status="cancelled")),
    ref=[act("cancel", kind="event", name="swap shift", when=J(U("week", 1, weekday=5)))]))

S("T31-007-P", "wifi reveal egress logins starred para",
  T("what's the wifi code", rows("flat_wifi", "nowysacz_wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("i want the flat one read out", diff(reveal=[("flat_wifi", "Krakowska3Pokoje")]),
    ref=[act("reveal", rows="$flat_wifi", args="field: password")]),
  T("send it to kuba by text", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("starred logins, list them", rows("pko_login"),
    ref=[ans(kind="locker item", where="type = login and starred = yes")]))

S("T31-013-P", "ward gifts members role balance settle-up para",
  T("ward 4b gifts, who's in it", rows("me", "marcin_b", "ewa", "magda", "przemek", "anna_w"),
    ref=[ans(kind="person", linked_to="$ward_gifts")]),
  T("the nurses among them", rows("marcin_b", "ewa", "magda", "anna_w"),
    ref=[ans(within="@prev", where='role contains "nurse"')]),
  T("ewa's balance?", val((-18, "PLN")),
    ref=[ans(op="balance", rows="$ewa")]),
  T("magda and me need settling up in the gifts group, do that", diff(upd("magda", balance=ANY)),
    ref=[act("settle_up", rows="$magda", args=lines(group="$ward_gifts"))]),
  T("upcoming events for the ward gifts group", rows("hospital_party"),
    ref=[find(kind="event", linked_to="$ward_gifts"), ans(kind="event", name="ward")]))

S("T31-019-P", "ambiguous dentist reschedule pick para",
  T("dentist should be on the 26th instead", ask("dentist_ev", "dentist_ev2"),
    ref=[act("reschedule", kind="event", name="dentist", args=lines(to=D("2026-11-26", "15:45")))]),
  T("the one in november", diff(upd("dentist_ev", date="2026-11-26T15:45")),
    ref=[act("reschedule", kind="event", name="dentist", when=J(U("month", 0)), args=lines(to=D("2026-11-26", "15:45")))]))

S("T31-025-P", "two agnieszkas near-name role-met log para",
  T("who's agnieszka", rows("agnieszka", "agnieszka_n"),
    ref=[ans(kind="person", name="agnieszka")]),
  T("agnieszka from the flat", rows("agnieszka_n"),
    ref=[ans(within="@prev", where='met = "Krakowska flat"')]),
  T("does the zakopane group include the other agnieszka", rows("agnieszka"),
    ref=[ans(kind="person", name="agnieszka", linked_to="$zakopane", exclude="$agnieszka_n")]),
  T("i messaged the flat one, put that in the log", diff(upd("agnieszka_n", date=ANY)),
    ref=[act("log", rows="$agnieszka_n", args="kind: message")]))

S("T31-031-P", "stag planning event people notes add-to-notebook para",
  T("guests at the stag planning dinner, who are they", rows("adrian", "marcin_l"),
    ref=[ans(kind="person", linked_to="$stag_planning")]),
  T("notes on adi?", rows("n_stag"),
    ref=[ans(kind="note", linked_to="$adrian")]),
  T("stick it in the ideas notebook", diff(link("ideas_nb", "n_stag")),
    ref=[act("add_to", rows="$n_stag", args=lines(to="$ideas_nb"))]))

S("T31-037-P", "write-then-read delete folder list empty para",
  T("get rid of the to file folder, then list the folders that remain",
    rows("work_f", "flat_f", "health_f", "taxes_f", also=diff(gone("empty_f"))),
    ref=[act("delete", kind="folder", name="To file", more=True), ans(kind="folder")]),
  T("empty ones?", rows(),
    ref=[ans(kind="folder", where="document count = 0")]))

S("T31-043-P", "restore note document para",
  T("undelete the old shopping list note", diff(restore("old_note")),
    ref=[find(kind="note", name="old shopping list", trashed=True), act("restore", rows="@1")]),
  T("2024 rental agreement as well", diff(restore("d_old_lease")),
    ref=[find(kind="document", name="rental agreement 2024", trashed=True), act("restore", rows="@2")]))

S("T31-049-P", "repair multi-kind where starred kasia para",
  T("starred things with kasia in them", rows("p_tr_london"),
    ref=[bad(ans(kind="photo,note", linked_to="$kasia", where="starred = yes")),
         ans(kind="photo", linked_to="$kasia", where="starred = yes")]),
  T("notes too?", rows("n_gifts"),
    ref=[ans(kind="note", linked_to="$kasia")]),
  T("london eye one is too dark so take its star off", diff(upd("p_tr_london", starred=False)),
    ref=[act("unstar", rows="$p_tr_london")]))

S("T31-055-P", "ambiguous delete pay rent pick para",
  T("pay rent task, get rid of it", ask("rent_sep", "rent_oct", "rent_nov"),
    ref=[act("delete", kind="task", name="pay rent")]),
  T("september's", diff(trash("rent_sep")),
    ref=[act("delete", kind="task", name="pay rent", when=J(U("month", -1, name=9)))]),
  T("pay rent one needs to come back actually", diff(restore("rent_sep")),
    ref=[find(kind="task", name="pay rent", trashed=True), act("restore", rows="@1")]))

S("T31-061-P", "create clash ask retime sunday-read para",
  T("sunday at 12, coffee with kuba", ask("league_1108"),
    ref=[act("create", kind="event", args=lines(name="Coffee with Kuba", date=D("2026-11-08", "12:00")))]),
  T("make it 4 on sunday instead", diff(new("event", name=has("Kuba"), date="2026-11-08T16:00")),
    ref=[act("create", kind="event", args=lines(name="Coffee with Kuba", date=D("2026-11-08", "16:00")))]),
  T("what does sunday look like for me", rows("league_1108", "brunch_adi", "+1", "mama_1108", "kasia_call"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=7)))]))

S("T31-067-P", "ask-missing-time create event friday read reschedule para",
  T("friday needs an entry in the diary", ask(),
    ref=[askc("What is it, and what time?")]),
  T("dinner with ola, at 8", diff(new("event", name=has("Ola"), date="2026-11-06T20:00")),
    ref=[act("create", kind="event", args=lines(name="Dinner with Ola", date=U("week", 0, weekday=5, time="20:00")))]),
  T("friday's agenda now?", rows("coffee_ola", "+1"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=5)))]),
  T("friday doesn't work for ola, so make it the day after", diff(upd("+1", date="2026-11-07T20:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("day", 1, anchor="row")))]))

S("T31-073-P", "decline-fabricated pin then reveal card number para",
  T("invent a pin number for the revolut card", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("then simply read out the card number", diff(reveal=[("revolut_card", "4165982233445566")]),
    ref=[act("reveal", rows="$revolut_card", args="field: card_number")]))

S("T31-079-P", "ambiguous-debt settle match balls pick sum para",
  T("match balls debt, mark it settled", ask("d_piotr_balls", "d_michal_balls"),
    ref=[act("settle_debt", kind="debt", name="match balls")]),
  T("piotr's one", diff(upd("d_piotr_balls", status="settled")),
    ref=[act("settle_debt", kind="debt", name="match balls", linked_to="$piotr")]),
  T("michal sent his as well, so same for him", diff(upd("d_michal_balls", status="settled")),
    ref=[act("settle_debt", kind="debt", name="match balls", linked_to="$michal")]),
  T("what's the sum people are still holding back", val((110, "PLN")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open")]))

S("T31-085-P", "repair-cadence-unit starred people within-date log exclude para",
  T("starred people i ought to contact at least every 3 weeks",
    rows("kuba", "ola", "kasia", "mama", "marcin_l", "adrian"),
    ref=[bad(ans(kind="person", where="starred = yes and cadence <= 3 weeks")),
         ans(kind="person", where="starred = yes and cadence <= 21")]),
  T("among those, who hasn't heard from me since monday", rows("kasia", "mama", "adrian"),
    ref=[ans(within="@1", when=J({"to": U("week", 0, weekday=1)}))]),
  T("i just rang kasia so put the call in the log", diff(upd("kasia", date=ANY)),
    ref=[act("log", rows="$kasia", args="kind: call")]),
  T("so who from that list is still waiting for a call", rows("mama", "adrian"),
    ref=[ans(within="@2", exclude="$kasia")]))

S("T31-091-P", "repair-date-field short open tasks within complete-bulk undo para",
  T("tasks under 20 minutes due before the 10th",
    rows("bin_rota", "handover", "kit_wash", "pay_ola", "pay_pizza", "pay_marta", "uniforms", "physio_book", "pay_kuba"),
    ref=[bad(ans(kind="task", where="date < 2026-11-10 and effort < 20")),
         ans(kind="task", where="effort < 20 and status = open", when=J({"to": D("2026-11-09")}))]),
  T("do any of them involve a person", rows("pay_ola", "pay_pizza", "pay_marta", "physio_book", "pay_kuba"),
    ref=[ans(within="@1", where="person count >= 1")]),
  T("paid everyone today, so mark all of those done", diff(
        upd("pay_ola", status="completed", completed=ANY), upd("pay_pizza", status="completed", completed=ANY),
        upd("pay_marta", status="completed", completed=ANY), upd("physio_book", status="completed", completed=ANY),
        upd("pay_kuba", status="completed", completed=ANY)),
    ref=[act("complete", rows="@2")]),
  T("undo it", diff(
        upd("pay_ola", status="open", completed=None), upd("pay_pizza", status="open", completed=None),
        upd("pay_marta", status="open", completed=None), upd("physio_book", status="open", completed=None),
        upd("pay_kuba", status="open", completed=None)),
    ref=[act("undo")]))

S("T31-097-P", "ask-move-it no-referent bike gym pass friday open para",
  T("put it on friday", ask(),
    ref=[askc("Move which one?")]),
  T("bike brakes, from the admin list", diff(upd("bike_fix", date="2026-11-06")),
    ref=[act("reschedule", kind="task", name="bike brakes", linked_to="$admin_l", args=lines(to=U("week", 0, weekday=5)))]),
  T("renewed the gym pass, so complete it on the admin list", diff(upd("gym_pass", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="gym pass", linked_to="$admin_l")]),
  T("friday's open items?", rows("shopping", "bike_fix", "pay_ola", "bin_rota", "handover", "kit_wash"),
    ref=[ans(kind="task", when=J(U("week", 0, weekday=5)), where="status = open")]))

S("T31-109-P", "football list find-delete-finished restore count compute two-completes para",
  T("on the football list, clear out the finished tasks, all of them", diff(trash("kit_wash_prev"), trash("league_fee")),
    ref=[find(kind="task", linked_to="$football_l", where="status = completed"), act("delete", rows="@1")]),
  T("league registration one needs to come back", diff(restore("league_fee")),
    ref=[find(kind="task", name="league registration", trashed=True), act("restore", rows="@2")]),
  T("open football tasks, count?", val(5),
    ref=[comp(op="count", kind="task", linked_to="$football_l", where="status = open"), ans(value="@prev")]),
  T("pizza and match balls are done, so complete them",
    diff(upd("pay_pizza", status="completed", completed=ANY), upd("match_balls", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pay_pizza", more=True), act("complete", rows="$match_balls")]))

S("T31-115-P", "mama calls edit-duration find-edit-all where when reschedule para",
  T("december's mama calls with babcia should run 45 minutes", diff(upd("mama_1206", duration=45)),
    ref=[act("edit", kind="event", name="call mama", where='description contains "Babcia"', when=J(U("month", 0, name=12)),
             args="duration: 45")]),
  T("november's as well, all of them", diff(upd("mama_1108", duration=45), upd("mama_1122", duration=45)),
    ref=[find(kind="event", name="call mama", where='description contains "Babcia"', when=J(U("month", 0))),
         act("edit", rows="@1", args="duration: 45")]),
  T("the 8th one, shift to 7pm", diff(upd("mama_1108", date="2026-11-08T19:00")),
    ref=[act("reschedule", kind="event", name="call mama", when=J(D("2026-11-08")), args=lines(to=D("2026-11-08", "19:00")))]))

S("T31-121-P", "people keep-up since-last-month longest next-after log left para",
  T("who haven't i talked to since last month, among the ones i keep up with",
    rows("james", "anna_wl", "babcia", "tata", "adrian", "anna_w"),
    ref=[ans(kind="person", where="cadence is set", when=J({"to": U("month", -1)}))]),
  T("the one longest ago?", rows("james"),
    ref=[ans(within="@1", order="date asc", limit=1)]),
  T("then who comes after him", rows("anna_wl"),
    ref=[ans(within="@1", order="date asc", limit=1, exclude="$james")]),
  T("put a call with her in the log", diff(upd("anna_wl", date=ANY)),
    ref=[act("log", rows="$anna_wl", args="kind: call")]),
  T("so who remains from that lot", rows("babcia", "tata", "adrian", "anna_w"),
    ref=[ans(within="@1", exclude="$james, $anna_wl")]))

S("T31-145-P", "due before the 8th open longest first find-complete-within sum-rest para",
  T("still-open stuff due before the 8th",
    rows("rent_nov", "shopping", "pay_ola", "bin_rota", "handover", "kit_wash", "pay_pizza", "pay_marta"),
    ref=[ans(kind="task", where="status = open", when=J({"to": D("2026-11-07")}))]),
  T("longest of those", rows("shopping"),
    ref=[ans(within="@1", order="effort desc", limit=1)]),
  T("and the earliest due?", rows("rent_nov"),
    ref=[ans(within="@1", order="date asc", limit=1)]),
  T("complete every one of those that's under 10 minutes",
    diff(upd("pay_ola", status="completed", completed=ANY), upd("bin_rota", status="completed", completed=ANY),
         upd("pay_pizza", status="completed", completed=ANY), upd("pay_marta", status="completed", completed=ANY)),
    ref=[find(kind="task", within="@1", where="effort < 10"), act("complete", rows="@4")]),
  T("total minutes for the rest?", val(50),
    ref=[ans(op="sum", field="effort", within="@1", where="status = open")]))

S("T31-169-P", "ambiguous-event delete night shift swap two pick october para",
  T("night shift swap, get rid of it", ask("night_swap", "night_swap_old"),
    ref=[act("delete", kind="event", name="night shift swap")]),
  T("october's", diff(trash("night_swap_old")),
    ref=[act("delete", kind="event", name="night shift swap", when=J(U("month", -1, name=10)))]),
  T("swap shift needs to come back", diff(restore("night_swap_old")),
    ref=[find(kind="event", name="swap", trashed=True), act("restore", rows="@1")]))

S("T31-175-P", "search-role grandmother name-day-lunch tasks-about para",
  T("which contact is my grandmother", rows("babcia"),
    ref=[search("grandmother", kind="person"), ans(rows="@1")]),
  T("her name day lunch is when", rows("babcia_name_day"),
    ref=[ans(kind="event", linked_to="$babcia", name="name day")]),
  T("tasks that mention her?", rows("babcia_gift"),
    ref=[ans(kind="task", linked_to="$babcia")]))

S("T31-187-P", "ambiguous-physio edit-duration pick knee para",
  T("physio should be 60 minutes", ask("physio_a", "physio_b", "physio_c"),
    ref=[act("edit", kind="event", name="physio", args="duration: 60")]),
  T("knee's", diff(upd("physio_c", duration=60)),
    ref=[act("edit", rows="$physio_c", args="duration: 60")]))

S("T31-199-P", "where4-read friends nursing-school star log para",
  T("unstarred friends from nursing school that i keep up with", rows("anna_wl"),
    ref=[ans(kind="person", where='met = "nursing school" and role = "friend" and cadence is set and starred = no')]),
  T("give her a star", diff(upd("anna_wl", starred=True)),
    ref=[act("star", rows="$anna_wl")]),
  T("rang her about saturday, so put a call in the log", diff(upd("anna_wl", date=ANY)),
    ref=[act("log", rows="$anna_wl", args="kind: call")]))
