from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-105", "flat jobs tomorrow find-complete undo name what-else",
  T("tick off all the open flat jobs due tomorrow",
    diff(upd("bin_rota", status="completed", completed=ANY), upd("shopping", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$flat_l", where="status = open", when=J(U("day", 1))),
         act("complete", rows="@1")]),
  T("no wait, undo that, i haven't done the milk run",
    diff(upd("bin_rota", status="open", completed=None), upd("shopping", status="open", completed=None)),
    ref=[act("undo")]),
  T("just the bins due tomorrow then", diff(upd("bin_rota", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="bins", when=J(U("day", 1)))]),
  T("what else is due tomorrow", rows("shopping", "pay_ola", "handover", "kit_wash"),
    ref=[ans(kind="task", when=J(U("day", 1)), where="status = open", exclude="$bin_rota")]))

S("T31-106", "star photos babcia mama find-star year unstar",
  T("star all the photos of babcia i haven't starred yet",
    diff(upd("p_ns_babcia", starred=True), upd("p_ns_walk", starred=True), upd("p_ns_all", starred=True)),
    ref=[find(kind="photo", linked_to="$babcia", where="starred = no"), act("star", rows="@1")]),
  T("and the same for mama", diff(upd("p_ns_mama", starred=True)),
    ref=[act("star", kind="photo", linked_to="$mama", where="starred = no")]),
  T("which photos from this year have i got starred",
    rows("p_tr_london", "p_ns_table", "p_fl_kuba", "p_ns_mama", "p_ns_babcia", "p_fb_team", "p_fb_keeper", "p_ns_all", "p_ns_walk"),
    ref=[ans(kind="photo", where="starred = yes", when=J(U("year", 0)))]),
  T("unstar the walk and the group lunch ones", diff(upd("p_ns_walk", starred=False), upd("p_ns_all", starred=False)),
    ref=[act("unstar", rows="$p_ns_walk, $p_ns_all")]))

S("T31-107", "hall december find-cancel after-first count within reschedule anchor",
  T("cancel all the hall games in december after the first",
    diff(upd("fas_1208", status="cancelled"), upd("fas_1215", status="cancelled")),
    ref=[find(kind="event", name="five-a-side hall", when=J(span(D("2026-12-02"), D("2026-12-31")))),
         act("cancel", rows="@1")]),
  T("how many hall games are still on", val(4),
    ref=[ans(op="count", kind="event", name="five-a-side hall", where="status != cancelled", when=J({"from": U("day", 0)}))]),
  T("which of those are in november", rows("fas_1110", "fas_1117", "fas_1124"),
    ref=[ans(within="@2", when=J(U("month", 0)))]),
  T("push the last one back a day, same time", diff(upd("fas_1124", date="2026-11-25T20:00")),
    ref=[act("reschedule", rows="$fas_1124", args=lines(to=U("day", 1, anchor="row")))]))

S("T31-108", "london subtasks find-complete due-by compute minutes reopen reschedule",
  T("tick off all the london trip subtasks due by the 14th of december",
    diff(upd("london_gifts", status="completed", completed=ANY), upd("london_pounds", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$london_trip", where="status = open", when=J({"to": D("2026-12-14")})),
         act("complete", rows="@1")]),
  T("how many minutes of the trip is left", val(45),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$london_trip", where="status = open"), ans(value="@prev")]),
  T("reopen the flights one about james, i need to rebook", diff(upd("london_flights", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="book flights", linked_to="$james")]),
  T("bump it to monday next week", diff(upd("london_flights", date="2026-11-09")),
    ref=[act("reschedule", rows="$london_flights", args=lines(to=U("week", 1, weekday=1)))]))

S("T31-109", "football list find-delete-finished restore count compute two-completes",
  T("delete all the finished tasks on the football list", diff(trash("kit_wash_prev"), trash("league_fee")),
    ref=[find(kind="task", linked_to="$football_l", where="status = completed"), act("delete", rows="@1")]),
  T("bring the league registration one back", diff(restore("league_fee")),
    ref=[find(kind="task", name="league registration", trashed=True), act("restore", rows="@2")]),
  T("how many football tasks are still open", val(5),
    ref=[comp(op="count", kind="task", linked_to="$football_l", where="status = open"), ans(value="@prev")]),
  T("tick off the pizza one and the match balls",
    diff(upd("pay_pizza", status="completed", completed=ANY), upd("match_balls", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pay_pizza", more=True), act("complete", rows="$match_balls")]))

S("T31-110", "recovery-nolink london group events rename",
  T("what has the london christmas group got coming up", rows("london_flight", "london_back"),
    ref=[ans(kind="event", linked_to="$london", when=J({"from": U("day", 0)})),
         ans(kind="event", name="london", when=J({"from": U("day", 0)}))]),
  T("rename the first one to outbound flight", diff(upd("london_flight", name="Outbound flight")),
    ref=[act("edit", rows="$london_flight", args="name: Outbound flight")]))

S("T31-111", "short open tasks within find-complete-within find-reschedule-within undo",
  T("which open tasks due before the 12th take 10 minutes or less",
    rows("pay_ola", "bin_rota", "pay_pizza", "pay_marta", "physio_book", "uniforms", "pay_kuba", "match_balls"),
    ref=[ans(kind="task", where="status = open and effort <= 10", when=J({"to": D("2026-11-11")}))]),
  T("tick off all of those that are about someone, they're all paid",
    diff(upd("pay_ola", status="completed", completed=ANY), upd("pay_pizza", status="completed", completed=ANY),
         upd("pay_marta", status="completed", completed=ANY), upd("physio_book", status="completed", completed=ANY),
         upd("pay_kuba", status="completed", completed=ANY)),
    ref=[find(kind="task", within="@1", where="person count >= 1"), act("complete", rows="@2")]),
  T("everything that's left can go to monday", diff(upd("bin_rota", date="2026-11-09"), upd("match_balls", date="2026-11-09")),
    ref=[find(kind="task", within="@1", where="status = open"),
         act("reschedule", rows="@3", args=lines(to=U("week", 1, weekday=1)))]),
  T("undo that", diff(upd("bin_rota", date="2026-11-06"), upd("match_balls", date="2026-11-10")),
    ref=[act("undo")]))

S("T31-112", "nurses find-star where find-edit-cadence log coffee",
  T("star all the nurses i know from the hospital",
    diff(upd("marcin_b", starred=True), upd("ewa", starred=True), upd("magda", starred=True), upd("anna_w", starred=True)),
    ref=[find(kind="person", where='role contains "nurse" and met contains "hospital"'), act("star", rows="@1")]),
  T("set all the starred nurses to every 14 days",
    diff(upd("ewa", cadence=14), upd("magda", cadence=14), upd("anna_w", cadence=14)),
    ref=[find(kind="person", where='role contains "nurse" and starred = yes'), act("edit", rows="@2", args="cadence: 14")]),
  T("log a coffee with magda, we just had one at the machine", diff(upd("magda", date=ANY)),
    ref=[act("log", rows="$magda", args="kind: coffee")]))

S("T31-113", "admin tasks find-edit-priority linked where read reschedule name",
  T("set all the open admin tasks over 40 minutes to priority 3",
    diff(upd("pit", priority=3), upd("pit_docs", priority=3), upd("bike_fix", priority=3), upd("renew_id", priority=3)),
    ref=[find(kind="task", linked_to="$admin_l", where="status = open and effort > 40"),
         act("edit", rows="@1", args="priority: 3")]),
  T("which tasks are priority 3 now", rows("pit_docs", "bike_fix", "pit", "renew_id"),
    ref=[ans(kind="task", where="priority = 3 and status = open")]),
  T("push the pit one to the 25th", diff(upd("pit", date="2026-11-25")),
    ref=[act("reschedule", rows="$pit", args=lines(to=D("2026-11-25")))]),
  T("and what's the effort on the id card one", rows("renew_id"),
    ref=[ans(kind="task", name="id card")]))

S("T31-114", "reopen pay rent october name where when read complete undo",
  T("reopen the pay rent from october", diff(upd("rent_oct", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="pay rent", where="status = completed", when=J(U("month", -1, name=10)))]),
  T("and which pay rent tasks are open now", rows("rent_oct", "rent_nov"),
    ref=[ans(kind="task", name="pay rent", where="status = open")]),
  T("tick off the november rent, paid it today", diff(upd("rent_nov", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="pay rent", when=J(U("month", 0)))]),
  T("undo that", diff(upd("rent_nov", status="open", completed=None)),
    ref=[act("undo")]))

S("T31-115", "mama calls edit-duration find-edit-all where when reschedule",
  T("make the december mama calls with babcia 45 minutes long", diff(upd("mama_1206", duration=45)),
    ref=[act("edit", kind="event", name="call mama", where='description contains "Babcia"', when=J(U("month", 0, name=12)),
             args="duration: 45")]),
  T("and all the november ones too", diff(upd("mama_1108", duration=45), upd("mama_1122", duration=45)),
    ref=[find(kind="event", name="call mama", where='description contains "Babcia"', when=J(U("month", 0))),
         act("edit", rows="@1", args="duration: 45")]),
  T("move the one on the 8th to 7pm", diff(upd("mama_1108", date="2026-11-08T19:00")),
    ref=[act("reschedule", kind="event", name="call mama", when=J(D("2026-11-08")), args=lines(to=D("2026-11-08", "19:00")))]))

S("T31-116", "recovery-nolink london group documents add-to to-file",
  T("which documents are filed under the london christmas group", rows("d_flights"),
    ref=[find(kind="document", linked_to="$london"), ans(kind="document", name="london")]),
  T("put it in the to file folder", diff(link("empty_f", "d_flights")),
    ref=[act("add_to", rows="$d_flights", args=lines(to="$empty_f"))]),
  T("and the id card scan too", diff(link("empty_f", "d_dowod")),
    ref=[act("add_to", kind="document", name="id card", args=lines(to="$empty_f"))]))
