from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# --- selectors with several conditions: a read, then the write on what it found ---------------------

S("T31-197", "where4-read nurses hospital cadence star count-starred",
  T("which nurses at university hospital do i keep up with that i haven't starred", rows("anna_w", "ewa", "marcin_b"),
    ref=[ans(kind="person", where='met = "University Hospital" and role contains "nurse" and cadence is set and starred = no')]),
  T("star them", diff(upd("anna_w", starred=True), upd("ewa", starred=True), upd("marcin_b", starred=True)),
    ref=[act("star", rows="@1")]),
  T("how many people from the hospital are starred now", val(3),
    ref=[ans(op="count", kind="person", where='met = "University Hospital" and starred = yes')]))

S("T31-198", "where4-read debts between settle-selector october sum",
  T("what do i still owe that's between 30 and 100", rows("d_kuba_gas", "d_darek_pizza", "d_marcin_hall"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open and amount >= 30 and amount <= 100")]),
  T("settle the ones under 40 from october", diff(upd("d_ola_clean", status="settled"), upd("d_darek_pizza", status="settled")),
    ref=[find(kind="debt", where="direction = i_owe and status = open and amount < 40", when=J(U("month", -1, name=10))),
         act("settle_debt", rows="@2")]),
  T("what's my total debt after that", val((484, "PLN")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]))

S("T31-199", "where4-read friends nursing-school star log",
  T("which friends from nursing school do i keep up with that i haven't starred", rows("anna_wl"),
    ref=[ans(kind="person", where='met = "nursing school" and role = "friend" and cadence is set and starred = no')]),
  T("star her", diff(upd("anna_wl", starred=True)),
    ref=[act("star", rows="$anna_wl")]),
  T("and log a call with her, rang her about saturday", diff(upd("anna_wl", date=ANY)),
    ref=[act("log", rows="$anna_wl", args="kind: call")]))

S("T31-200", "find-act4 delete cancelled five-a-side october marcin restore",
  T("delete the cancelled five-a-side games from october that marcin lis is on", diff(trash("fas_1013")),
    ref=[find(kind="event", name="five-a-side", linked_to="$marcin_l", where="status = cancelled", when=J(U("month", -1, name=10))),
         act("delete", rows="@1")]),
  T("bring that five-a-side game back", diff(restore("fas_1013")),
    ref=[find(kind="event", name="five-a-side", trashed=True), act("restore", rows="@2")]))

S("T31-201", "find-act4 star rental agreements flat-folder last-year starred-read unstar",
  T("star the rental agreements in the flat folder from last year that aren't starred yet", diff(upd("d_lease25", starred=True)),
    ref=[find(kind="document", name="rental agreement", linked_to="$flat_f", where="starred = no", when=J(U("year", -1))),
         act("star", rows="@1")]),
  T("which documents are starred in the flat folder now", rows("d_lease25", "d_lease26"),
    ref=[ans(kind="document", linked_to="$flat_f", where="starred = yes")]),
  T("unstar the older one", diff(upd("d_lease25", starred=False)),
    ref=[act("unstar", rows="$d_lease25")]))

S("T31-202", "find-act4 add-to-list flat jobs admin undo count",
  T("add the open flat jobs due before the 10th that take under half an hour to the admin list",
    diff(link("admin_l", "bin_rota"), link("admin_l", "shopping"), unlink("flat_l", "bin_rota"), unlink("flat_l", "shopping")),
    ref=[find(kind="task", linked_to="$flat_l", where="status = open and effort < 30", when=J({"to": D("2026-11-09")})),
         act("add_to", rows="@1", args=lines(to="$admin_l"))]),
  T("undo that one, leave it for later", diff(link("flat_l", "bin_rota"), link("flat_l", "shopping"), unlink("admin_l", "bin_rota"), unlink("admin_l", "shopping")),
    ref=[act("undo")]),
  T("how many open tasks are on the admin list", val(9),
    ref=[ans(op="count", kind="task", linked_to="$admin_l", where="status = open")]))

S("T31-203", "where3-read logins url not-starred star starred",
  T("which logins have a url saved and aren't starred", rows("uh_portal", "netflix_login"),
    ref=[ans(kind="locker item", where="type = login and url is set and starred = no")]),
  T("star the netflix one", diff(upd("netflix_login", starred=True)),
    ref=[act("star", rows="$netflix_login")]),
  T("and which logins are starred now", rows("pko_login", "netflix_login"),
    ref=[ans(kind="locker item", where="type = login and starred = yes")]))

# --- find the person by what they are, then what is open for them ------------------------------------

S("T31-204", "search-role dad open-tasks star",
  T("any open tasks about my dad", rows("train_ticket"),
    ref=[search("dad", kind="person"), ans(kind="task", linked_to="$tata", where="status = open")]),
  T("star him", diff(upd("tata", starred=True)),
    ref=[act("star", rows="$tata")]))

S("T31-205", "search-role physio events-this-month within-duration edit-all",
  T("any events with the physio this month", rows("physio_a", "physio_b"),
    ref=[search("physio", kind="person"), ans(kind="event", linked_to="$physio", when=J(U("month", 0)))]),
  T("which of those are longer than 40 minutes", rows("physio_a", "physio_b"),
    ref=[ans(within="@prev", where="duration > 40")]),
  T("make them 60 minutes long", diff(upd("physio_a", duration=60), upd("physio_b", duration=60)),
    ref=[act("edit", rows="@3", args="duration: 60")]))

S("T31-206", "search-role doctor open-tasks delete undo",
  T("any open tasks about the doctor on the ward", rows("cpr_prep"),
    ref=[search("doctor", kind="person"), ans(kind="task", linked_to="$przemek", where="status = open")]),
  T("delete it, the course is off", diff(trash("cpr_prep")),
    ref=[act("delete", rows="$cpr_prep")]),
  T("undo that", diff(restore("cpr_prep")),
    ref=[act("undo")]))

S("T31-207", "search-role grandmother open-tasks reschedule",
  T("what's still open for my grandmother", rows("babcia_gift"),
    ref=[search("grandmother", kind="person"), ans(kind="task", linked_to="$babcia", where="status = open")]),
  T("push it to the 12th", diff(upd("babcia_gift", date="2026-11-12")),
    ref=[act("reschedule", rows="$babcia_gift", args=lines(to=D("2026-11-12")))]))

# --- counts and sums that pile up conditions ------------------------------------------------------------

S("T31-208", "values4 count tasks hour december nurses debts",
  T("how many open tasks take under an hour and are due before december", val(21),
    ref=[ans(op="count", kind="task", where="status = open and effort < 60", when=J({"to": D("2026-11-30")}))]),
  T("how many nurses at university hospital do i keep up with", val(3),
    ref=[ans(op="count", kind="person", where='met = "University Hospital" and role contains "nurse" and cadence is set')]),
  T("how many debts over 40 do i still owe", val(4),
    ref=[ans(op="count", kind="debt", where="direction = i_owe and status = open and amount > 40")]))

S("T31-209", "values4 count photos starred people year sum flat week ward",
  T("how many starred photos with people in them did i take this year", val(5),
    ref=[ans(op="count", kind="photo", where="starred = yes and person count >= 1", when=J(U("year", 0)))]),
  T("how many minutes of the open flat tasks are due this week", val(25),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$flat_l", where="status = open", when=J(U("week", 0)))]),
  T("and how many minutes of ward tasks are still open", val(175),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$ward_l", where="status = open")]))
