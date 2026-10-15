from gold import *
import json

world("T34", "2027-06-20T21:15", "Obinna Okafor", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T34-058", "bulk-cap ask yes empty-after-delete year",
  T("wipe all the pay nepa tasks on the house list that are done from 2023", ask(),
    ref=[act("delete", kind="task", name="Pay NEPA", linked_to="$house", where="status = completed", when=W(U("year", -4)))]),
  T("yes go ahead",
    diff(trash("nepa_230609"), trash("nepa_230623"), trash("nepa_230707"), trash("nepa_230721"), trash("nepa_230804"),
         trash("nepa_230818"), trash("nepa_230901"), trash("nepa_230915"), trash("nepa_230929"), trash("nepa_231013"),
         trash("nepa_231027"), trash("nepa_231110"), trash("nepa_231124"), trash("nepa_231208"), trash("nepa_231222")),
    ref=[act("delete", kind="task", name="Pay NEPA", linked_to="$house", where="status = completed", when=W(U("year", -4)))]),
  T("any pay nepa tasks left from 2023", rows(),
    ref=[ans(kind="task", name="Pay NEPA", when=W(U("year", -4)))]))

S("T34-059", "write-then-read star locker ambiguous-reveal wifi pick",
  T("star the passport and show me which locker items are starred now",
    rows("gtb_login", "gtb_acct", "home_wifi", "gate_code", "sage", "passport_o",
         also=diff(upd("passport_o", starred=True))),
    ref=[act("star", kind="locker item", name="Passport", more=True),
         ans(kind="locker item", where="starred = yes")]),
  T("show me the wifi password", ask("home_wifi", "shop_wifi"),
    ref=[act("reveal", kind="locker item", name="wifi", args="field: password")]),
  T("the shop wifi", diff(reveal=[("shop_wifi", "OshodiCement25")]),
    ref=[act("reveal", rows="$shop_wifi", args="field: password")]))

S("T34-060", "find-only cancelled last-one find-then-reschedule next same-time",
  T("when did we last call off a cement delivery this year", rows("sd_270524"),
    ref=[find(kind="event", name="cement delivery", where="status = cancelled", when=W(U("year", 0)),
              order="date desc", limit=1),
         ans(rows="@prev")]),
  T("bring the next stocktake forward to monday, same time", diff(upd("st_270625", date="2027-06-21T16:00")),
    ref=[find(kind="event", name="stocktake", where="status != cancelled", when=W({"from": U("day", 0)}),
              order="date asc", limit=1),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]))

S("T34-062", "edit person-role find-then-edit document event-duration repair task-effort open",
  T("change the cement chidi's role to business partner", diff(upd("chidi_a", role="business partner")),
    ref=[act("edit", kind="person", name="Chidi", where='role contains "cement"', args="role: business partner")]),
  T("and the 2024 company tax return should say final at the end",
    diff(upd("doc_13", name="Company tax return 2024 final")),
    ref=[find(kind="document", name="Company tax return", when=W(U("year", -3))),
         act("edit", rows="@prev", args="name: Company tax return 2024 final")]),
  T("make the stocktake on the 30th three hours", diff(upd("st_270730", duration=180)),
    ref=[bad(act("edit", kind="event", name="Stocktake", when=W(D("2027-07-30")), args="duration: 3 hours")),
         act("edit", kind="event", name="Stocktake", when=W(D("2027-07-30")), args="duration: 180")]),
  T("clean the water tank needs two hours", diff(upd("t_008", effort=120)),
    ref=[act("edit", kind="task", name="Clean the water tank", where="status = open", args="effort: 120")]),
  T("anything open that takes more than an hour now", rows("t_008", "t_043", "t_084"),
    ref=[ans(kind="task", where="status = open and effort > 60 minutes")]))

S("T34-063", "delete find-then-delete event-where document-year decline-unbounded count-trash",
  T("delete the cancelled haircut at the barber from 2023", diff(trash("oo_042")),
    ref=[find(kind="event", name="Haircut at the barber", where="status = cancelled", when=W(U("year", -4))),
         act("delete", rows="@prev")]),
  T("and the bank statement summary from 2024", diff(trash("doc_27")),
    ref=[bad(find(kind="document", name="Bank statement summary", where="date = 2024")),
         find(kind="document", name="Bank statement summary", when=W(U("year", -3))),
         act("delete", rows="@prev")]),
  T("wipe the pay generator man tasks on the house list from 2023 too, the finished ones",
    diff(trash("genman_230603"), trash("genman_230703"), trash("genman_230803"), trash("genman_230903"),
         trash("genman_231003"), trash("genman_231103"), trash("genman_231203")),
    ref=[find(kind="task", name="Pay generator man", linked_to="$house", where="status = completed", when=W(U("year", -4))),
         act("delete", rows="@prev")]),
  T("how many tasks in the trash now", val(15),
    ref=[ans(op="count", kind="task", trashed="true")]),
  T("delete all my notes", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("just the diary entry from before june", diff(trash("loose_1")),
    ref=[find(kind="note", name="diary entry", when=W({"to": D("2027-05-31")})),
         act("delete", rows="@prev")]))

S("T34-064", "subtasks repair within find-only log two-writes count",
  T("what's left on the church hall dedication before september", rows("church_hall_1", "church_hall_2", "church_hall_3"),
    ref=[bad(find(kind="task", linked_to="$church_hall", where="status = pending", when=W({"to": D("2027-08-31")}))),
         ans(kind="task", linked_to="$church_hall", where="status = open", when=W({"to": D("2027-08-31")}))]),
  T("earliest due date of those", rows("church_hall_3"),
    ref=[ans(within="@prev", order="date asc", limit=1)]),
  T("push the pledges to the 3rd of july", diff(upd("church_hall_3", date="2027-07-03")),
    ref=[act("reschedule", kind="task", name="Collect the pledges", where="status = open", args=lines(to=D("2027-07-03")))]),
  T("who's it about", rows("deacon"),
    ref=[find(kind="person", linked_to="$church_hall_3"), ans(rows="@prev")]),
  T("log a visit with him, we met after service", diff(upd("deacon", date=ANY)),
    ref=[act("log", rows="$deacon", args="kind: visit")]),
  T("tick off the plaque and the programme, both done",
    diff(upd("church_hall_1", status="completed", completed=ANY), upd("church_hall_2", status="completed", completed=ANY)),
    ref=[act("complete", rows="$church_hall_1", more=True), act("complete", rows="$church_hall_2")]),
  T("how many left on the church list", val(3),
    ref=[comp(op="count", kind="task", linked_to="$church_l", where="status = open"), ans(value="@prev")]))
