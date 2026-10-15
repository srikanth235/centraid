from gold import *

import json

world("T33", "2026-12-12T08:50", "Hiro Tanaka-Lim", "train")

def J(d):
    return json.dumps(d, separators=(",", ":"))

WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))


S("T33-002-P", "events-today cancel-by-date weekend four-constraints tasks rename-by-date para",
  T("today's agenda?", rows("swim_1212", "cleaners", "movie"),
    ref=[ans(kind="event", when=J(U("day", 0)))]),
  T("mei has a cold so today's swim is off, cancel it", diff(upd("swim_1212", status="cancelled")),
    ref=[act("cancel", kind="event", name="toddler swim", when=J(U("day", 0)))]),
  T("this weekend's due tasks for kenji that take under 45 minutes", rows("k_swim"),
    ref=[ans(kind="task", linked_to="$kenji_l", where="status = open and effort < 45", when=J(WEEKEND))]),
  T("tomorrow's swim trunks task, retitle it size 2", diff(upd("k_swim", name=has("trunks", "size 2"))),
    ref=[act("edit", kind="task", name="swim trunks", when=J(U("day", 1)), args="name: Buy Kenji swim trunks size 2")]))

S("T33-006-P", "documents folder starred year add_to refused-delete still-in para",
  T("condo folder, starred documents dating from before this year", rows("d_sp25"),
    ref=[ans(kind="document", linked_to="$condo_f", where="starred = yes", when=J({"to": U("year", -1)}))]),
  T("kenji's folder items from this year?", rows("d_nursery"),
    ref=[ans(kind="document", linked_to="$kenji_f", when=J(U("year", 0)))]),
  T("home insurance policy goes into the money folder", diff(link("money_f", "d_insure_h")),
    ref=[act("add_to", rows="$d_insure_h", args="to: $money_f")]),
  T("penang flight confirmation into to file too", diff(link("empty_f", "d_flights")),
    ref=[act("add_to", rows="$d_flights", args="to: $empty_f")]),
  T("to file folder, get rid of it", ask("d_flights"),
    ref=[act("delete", rows="$empty_f")]),
  T("home loan statement, still sitting in money?", rows("d_loan"),
    ref=[ans(kind="document", name="home loan statement", linked_to="$money_f")]))

S("T33-014-P", "condo-fee series find-then-complete repair-completed-field count-four next-empty reopen para",
  T("condo fee paid via giro this morning, mark it done", diff(upd("fee_dec", status="completed", completed=ANY)),
    ref=[find(kind="task", name="pay condo maintenance fee", where="status = open"),
         act("complete", rows="@prev")]),
  T("number of condo fees i've paid this year", val(3),
    ref=[bad(ans(op="count", kind="task", name="pay condo maintenance fee", where="status = completed and completed >= 2026-01-01")),
         ans(op="count", kind="task", name="pay condo maintenance fee", where="status = completed", when=J(U("year", 0)))]),
  T("next one falls due when", rows(),
    ref=[ans(kind="task", name="pay condo maintenance fee", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("wrong amount on the october one, so reopen it", diff(upd("fee_oct", status="open", completed=ANY)),
    ref=[act("reopen", kind="task", name="pay condo maintenance fee", when=J(U("month", 0, name=10)))]))

S("T33-026-P", "okaasan notes narrow recipes exclude para",
  T("this year's notes about okaasan", rows("rc_okonomi", "gift_okaasan"),
    ref=[ans(kind="note", linked_to="$okaasan", when=J(U("year", 0)))]),
  T("the recipe among them?", rows("rc_okonomi"),
    ref=[ans(within="@prev", linked_to="$recipes_nb")]),
  T("other recipes in there?", rows("rc_laksa", "rc_bakkutteh", "rc_kaya"),
    ref=[ans(kind="note", linked_to="$recipes_nb", exclude="$rc_okonomi")]))

S("T33-030-P", "unbounded-decline bounded-delete-apply-all undo-restore para",
  T("clear out all my tasks", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("money list, the finished ones, all of them",
    diff(trash("fee_oct"), trash("fee_nov"), trash("utilities_nov"), trash("starhub")),
    ref=[find(kind="task", linked_to="$money_l", where="status = completed"),
         act("delete", rows="@prev")]),
  T("undo it", diff(restore("fee_oct"), restore("fee_nov"), restore("utilities_nov"), restore("starhub")),
    ref=[act("undo")]))

S("T33-042-P", "swim before-christmas ordinal-cancel undo para",
  T("swim lessons before christmas, upcoming and not cancelled", rows("swim_1212", "swim_1219"),
    ref=[bad(ans(kind="event", name="toddler swim", where="status != cancelled and date <= 2026-12-24")),
         ans(kind="event", name="toddler swim", where="status != cancelled", when=J(span(U("day", 0), D("2026-12-24"))))]),
  T("the second one is off, cancel it", diff(upd("swim_1219", status="cancelled")),
    ref=[act("cancel", rows="$swim_1219")]),
  T("mei's feeling better, so undo that", diff(),
    ref=[act("undo")]))

S("T33-047-P", "okaasan-calls next-empty create count-since para",
  T("next call with okaasan?", rows(),
    ref=[ans(kind="event", name="call okaasan", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("add one for tomorrow at 8:30", diff(new("event", name=has("okaasan"), date="2026-12-13T20:30")),
    ref=[act("create", kind="event", args="name: Call Okaasan\ndate: " + J(U("day", 1, time="20:30")))]),
  T("calls with her since october that went ahead, count", val(9),
    ref=[ans(op="count", kind="event", name="call okaasan", where="status != cancelled", when=J({"from": U("month", 0, name=10)}))]))

S("T33-051-P", "documents star-two unstar rename folder-read para",
  T("november minutes and 2026 budget both get stars", diff(upd("d_minutes_nov", starred=ANY), upd("d_budget26", starred=ANY)),
    ref=[act("star", rows="$d_minutes_nov, $d_budget26")]),
  T("condo folder docs that carry a star now?", rows("d_sp25", "d_budget27", "d_minutes_nov", "d_budget26"),
    ref=[ans(kind="document", linked_to="$condo_f", where="starred = yes")]),
  T("take the star off the old agreement in the condo folder", diff(upd("d_sp25", starred=ANY)),
    ref=[act("unstar", kind="document", name="agreement", linked_to="$condo_f")]),
  T("2026 budget gets renamed condo budget 2026 final", diff(upd("d_budget26", name="Condo budget 2026 final")),
    ref=[act("edit", rows="$d_budget26", args="name: Condo budget 2026 final")]))

S("T33-055-P", "role-search find-only para",
  T("maid agency contact, who was it", rows("agency"),
    ref=[search("maid agency", kind="person"),
         ans(rows="@prev")]))

S("T33-071-P", "create-args login username-label purpose-clause para",
  T("for the parking fines i need a town council portal login, user hiro.tl",
    diff(new("locker item", name=has("town council"), type="login", username="hiro.tl")),
    ref=[act("create", args=lines(kind="locker item", name="Town council portal", type="login", username="hiro.tl"))]),
  T("singtel app login too, username hirotl88, it's for the bill",
    diff(new("locker item", name=has("singtel"), type="login", username="hirotl88")),
    ref=[act("create", args=lines(kind="locker item", name="Singtel app", type="login", username="hirotl88"))]))

S("T33-075-P", "create-args one-attribute-per-line login-url event-description person-role-nickname para",
  T("nparks login, user hiro.tl2, site nparks.gov.sg, save it",
    diff(new("locker item", name=has("nparks"), type="login", username="hiro.tl2", url=has("nparks.gov.sg"))),
    ref=[act("create", args=lines(kind="locker item", name="NParks", type="login", username="hiro.tl2", url="nparks.gov.sg"))]),
  T("physio session monday at 6, bring the knee brace",
    diff(new("event", name=has("physio"), date="2026-12-14T18:00", description=has("knee brace"))),
    ref=[act("create", args=lines(kind="event", name="Physio session", date=U("week", 1, weekday=1, time="18:00"),
                                  description="bring the knee brace"))]),
  T("kelvin lim the plumber, nicknamed pipe, new contact",
    diff(new("person", name=has("kelvin"), role="plumber", nickname="Pipe")),
    ref=[act("create", args=lines(kind="person", name="Kelvin Lim", role="plumber", nickname="Pipe"))]))

S("T33-079-P", "verb-choice block-time create-event no-wait-weekday reschedule bare-fragment edit-duration repair-date para",
  T("thursday 2 to 4 is taken by the lift quote visit, put it in",
    diff(new("event", name=has("lift"), date="2026-12-17T14:00", duration=120)),
    ref=[bad(act("create", args=lines(kind="event", name="Lift quote visit",
                                      date={"unit": "week", "rel": 1, "weekday": 4, "time": "2:00"}, duration=120))),
         act("create", args=lines(kind="event", name="Lift quote visit", date=U("week", 1, weekday=4, time="14:00"), duration=120))]),
  T("friday instead, sorry", diff(upd("+1", date="2026-12-18T14:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 1, weekday=5)))]),
  T("an hour only", diff(upd("+1", duration=60)),
    ref=[act("edit", rows="$c1", args="duration: 60")]))

S("T33-083-P", "stop-signals fyi-no-request ask then create-note-in-notebook para",
  T("just so you know, the lift will be down all of tuesday", ask(),
    ref=[askc("Do you want me to note that down somewhere?")]),
  T("yes, condo notes as a note", diff(new("note", name=ANY, body=has("lift")), link("condo_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Lift down on tuesday", body="the lift will be down all of tuesday", notebook="$condo_nb"))]),
  T("kenji's nap today was just 40 minutes", ask(),
    ref=[askc("Is there anything you want me to do about that?")]))

S("T33-087-P", "set-answers role-noun colleagues within-month treasurer role-contains para",
  T("my colleagues, who are they", rows("david_n", "priya_nayar"),
    ref=[ans(kind="person", where='role = "colleague"')]),
  T("of those, who've i talked to this month", rows("david_n"),
    ref=[ans(within="@prev", when=J(U("month", 0)))]),
  T("treasurer?", rows("david_l"),
    ref=[ans(kind="person", where='role contains "treasurer"')]),
  T("marcus teo, did he get deleted", rows("old_col"),
    ref=[ans(kind="person", name="marcus teo", trashed="true")]))

S("T33-091-P", "container-link whats-left theme-word-is-list-name within effort complete para",
  T("penang, what's still open", rows("penang_trip", "pg_ringgit", "pg_gifts", "pg_pack"),
    ref=[ans(kind="task", linked_to="$penang_l", where="status = open")]),
  T("anything over half an hour among them", rows("pg_gifts", "pg_pack"),
    ref=[ans(within="@prev", where="effort > 30")]),
  T("home list for next week, what remains", rows("h_bulbs", "permit_a", "h_return", "h_curtain"),
    ref=[ans(kind="task", linked_to="$home_l", where="status = open", when=J(U("week", 1)))]),
  T("hallway bulbs bought yesterday, mark them done", diff(upd("h_bulbs", status="completed", completed=ANY)),
    ref=[act("complete", rows="$h_bulbs")]))

S("T33-095-P", "container-link within-linked_to narrowing restate-where kenji-list para",
  T("friday's due tasks?", rows("lift_quote", "k_concert", "k_teacher", "cc_bill", "w_review"),
    ref=[ans(kind="task", where="status = open", when=J(U("week", 1, weekday=5)))]),
  T("only the kenji list ones", rows("k_concert", "k_teacher"),
    ref=[ans(within="@prev", linked_to="$kenji_l")]))

S("T33-099-P", "stray-conditions description-contains photo-name notebook-via-note para",
  T("swim classes this month with the blue towel in their description", rows("swim_1212"),
    ref=[ans(kind="event", name="toddler swim", where='description contains "blue towel"', when=J(U("month", 0)))]),
  T("fireworks photos?", rows("p_c_ndp"),
    ref=[ans(kind="photo", name="fireworks")]),
  T("roof note, which notebook is it in", rows("condo_nb"),
    ref=[find(kind="note", where='body contains "roof"'),
         ans(kind="notebook", linked_to="@prev")]))
