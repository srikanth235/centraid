from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-155", "mama calls after-15th one-after day shifts count",
  T("mama's next call once the 15th passes", rows("mama_1122"),
    ref=[ans(kind="event", name="call mama", when=J({"from": D("2026-11-16")}), order="date asc", limit=1)]),
  T("and the one after that", rows("mama_1129"),
    ref=[ans(kind="event", name="call mama", when=J({"from": D("2026-11-16")}), order="date asc", limit=1, exclude="$mama_1122")]),
  T("what about the next day shift after the 6th", rows("shift_1116"),
    ref=[ans(kind="event", name="day shift", when=J({"from": D("2026-11-07")}), order="date asc", limit=1)]),
  T("and the one after that", rows("shift_1118"),
    ref=[ans(kind="event", name="day shift", when=J({"from": D("2026-11-07")}), order="date asc", limit=1, exclude="$shift_1116")]),
  T("how many day shifts are left this month", val(3),
    ref=[ans(op="count", kind="event", name="day shift", when=J(span(U("day", 0), D("2026-11-30"))))]))

S("T31-156", "night shift last before-20th one-before five-a-side",
  T("when's the last night shift before the 20th", rows("night_swap"),
    ref=[ans(kind="event", name="night shift", when=J({"to": D("2026-11-19")}), order="date desc", limit=1)]),
  T("and the one before that", rows("shift_1111"),
    ref=[ans(kind="event", name="night shift", when=J({"to": D("2026-11-19")}), order="date desc", limit=1, exclude="$night_swap")]),
  T("when was the last five-a-side before the 3rd", rows("fas_1027"),
    ref=[ans(kind="event", name="five-a-side", when=J({"to": D("2026-11-02")}), order="date desc", limit=1)]),
  T("and the one before that", rows("fas_1020"),
    ref=[ans(kind="event", name="five-a-side", when=J({"to": D("2026-11-02")}), order="date desc", limit=1, exclude="$fas_1027")]))

S("T31-157", "find-act selectors reopen delete-finished star-all log-all add-to-notebook reschedule-family",
  T("reopen the done tasks about pan stanislaw", diff(upd("rent_oct", status="open", completed=None)),
    ref=[find(kind="task", linked_to="$landlord", where="status = completed"), act("reopen", rows="@1")]),
  T("delete the finished flat tasks from before november",
    diff(trash("rent_sep"), trash("elec_pay"), trash("shopping_prev"), trash("bin_rota_prev")),
    ref=[find(kind="task", linked_to="$flat_l", where="status = completed", when=J({"to": D("2026-10-31")})),
         act("delete", rows="@2")]),
  T("star all the people i know from tuesday football that aren't starred yet",
    diff(upd("tomek_m", starred=True), upd("piotr", starred=True), upd("darek", starred=True),
         upd("bartek", starred=True), upd("michal", starred=True)),
    ref=[find(kind="person", where='met = "Tuesday football" and starred = no'), act("star", rows="@3")]),
  T("log a coffee with all the flatmates", diff(upd("kuba", date=ANY), upd("ola", date=ANY)),
    ref=[find(kind="person", where='role contains "flatmate"'), act("log", rows="@4", args="kind: coffee")]),
  T("add the football notes from before this year to the ideas notebook",
    diff(link("ideas_nb", "n_tactics"), link("ideas_nb", "n_kit"), unlink("football_nb", "n_tactics"), unlink("football_nb", "n_kit")),
    ref=[find(kind="note", linked_to="$football_nb", when=J({"to": D("2025-12-31")})),
         act("add_to", rows="@6", args=lines(to="$ideas_nb"))]),
  T("push the open family tasks under half an hour due before the 15th to monday", diff(upd("train_ticket", date="2026-11-09")),
    ref=[find(kind="task", linked_to="$family_l", where="status = open and effort < 30", when=J({"to": D("2026-11-14")})),
         act("reschedule", rows="@7", args=lines(to=U("week", 1, weekday=1)))]))

S("T31-158", "two-writes star-unstar complete-reopen pin-unpin log-call-visit",
  T("star the zus statement and unstar the nursing licence copy",
    diff(upd("d_zus", starred=True), upd("d_licence", starred=False)),
    ref=[act("star", kind="document", name="zus statement", more=True),
         act("unstar", kind="document", name="nursing licence")]),
  T("complete the gas bill and reopen the flights task",
    diff(upd("gas_pay", status="completed", completed=ANY), upd("london_flights", status="open", completed=None)),
    ref=[act("complete", kind="task", name="gas bill", more=True),
         act("reopen", kind="task", name="book flights")]),
  T("pin the budget note and unpin the flat rules one",
    diff(upd("n_budget", pinned=True), upd("n_flat_rules", pinned=False)),
    ref=[act("edit", kind="note", name="monthly budget", args="pinned: yes", more=True),
         act("edit", kind="note", name="flat rules", args="pinned: no")]),
  T("log a call with babcia and a visit with tata", diff(upd("babcia", date=ANY), upd("tata", date=ANY)),
    ref=[act("log", kind="person", name="babcia", args="kind: call", more=True),
         act("log", kind="person", name="tata", args="kind: visit")]))

S("T31-159", "write-then-read pin count star create-note",
  T("pin the budget note and show me which notes are pinned",
    rows("n_flat_rules", "n_budget", "n_handover", also=diff(upd("n_budget", pinned=True))),
    ref=[act("edit", kind="note", name="monthly budget", args="pinned: yes", more=True),
         ans(kind="note", where="pinned = yes")]),
  T("reopen the flights task and tell me how many tasks are open",
    val(44, also=diff(upd("london_flights", status="open", completed=None))),
    ref=[act("reopen", kind="task", name="book flights", more=True),
         ans(op="count", kind="task", where="status = open")]),
  T("star the roses photo and tell me how many photos are starred",
    val(6, also=diff(upd("p_ns_babcia", starred=True))),
    ref=[act("star", kind="photo", name="roses", more=True),
         ans(op="count", kind="photo", where="starred = yes")]),
  T("create a note called gas meter 4521 and tell me which other notes i wrote today",
    rows(also=diff(new("note", name=has("Gas meter")))),
    ref=[act("create", kind="note", args=lines(name="Gas meter 4521"), more=True),
         ans(kind="note", when=J(U("day", 0)), exclude="$new")]))

S("T31-160", "repair-effort-unit hours empty then hour-and-a-half",
  T("show open tasks that run past 2 hours", rows(),
    ref=[bad(ans(kind="task", where="status = open and effort > 2 hours")),
         ans(kind="task", where="status = open and effort > 120")]),
  T("and more than an hour and a half", rows("london_gifts"),
    ref=[ans(kind="task", where="status = open and effort > 90")]))

S("T31-161", "repair-edit-date-event haircut reschedule",
  T("put the haircut on the 21st instead", diff(upd("barber_ev", date="2026-11-21T10:00")),
    ref=[bad(act("edit", kind="event", name="haircut", args="date: 2026-11-21")),
         act("reschedule", kind="event", name="haircut", args=lines(to=D("2026-11-21")))]))
