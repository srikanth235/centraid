from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# --- repairs: the runtime names what it wants, the next call fixes it --------------------------------

S("T31-210", "repair-create-field task charger admin-list due open-short",
  T("add a task to buy a new charger", diff(new("task", name=has("charger"))),
    ref=[bad(act("create", kind="task", args="title: Buy a new charger")),
         act("create", kind="task", args=lines(name="Buy a new charger"))]),
  T("put it on the admin list", diff(link("admin_l", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$admin_l"))]),
  T("make it due the 14th", diff(upd("+1", date="2026-11-14")),
    ref=[act("reschedule", rows="$c1", args=lines(to=D("2026-11-14")))]),
  T("which open tasks take under 10 minutes", rows("pay_ola", "bin_rota", "pay_pizza", "pay_marta", "physio_book", "pay_kuba", "match_balls"),
    ref=[ans(kind="task", where="status = open and effort < 10")]))

S("T31-211", "repair-settle-up-group kasia balance james open-trip",
  T("settle up with kasia", diff(upd("kasia", balance=ANY)),
    ref=[bad(act("settle_up", rows="$kasia")),
         act("settle_up", rows="$kasia", args=lines(group="$london"))]),
  T("where do i stand in the london group now", val((0, "GBP")),
    ref=[search("Tomasz", kind="person"),
         ans(op="balance", kind="group", name="London Christmas", linked_to="$me")]),
  T("and where does james stand", val((-16, "GBP")),
    ref=[ans(op="balance", kind="group", name="London Christmas", linked_to="$james")]),
  T("which of the trip tasks are still open", rows("london_gifts", "london_pounds", "london_pack"),
    ref=[ans(kind="task", linked_to="$london_trip", where="status = open")]))

S("T31-212", "repair-clock-format call kasia twenty-second league-push count",
  T("move the call with kasia on the 22nd to 9 in the morning", diff(upd("kasia_call2", date="2026-11-22T09:00")),
    ref=[bad(act("reschedule", kind="event", name="call kasia", when=J(D("2026-11-22")), args=lines(to=D("2026-11-22", "9")))),
         act("reschedule", kind="event", name="call kasia", when=J(D("2026-11-22")), args=lines(to=D("2026-11-22", "09:00")))]),
  T("what's on the 22nd now", rows("kasia_call2", "league_1122", "mama_1122"),
    ref=[ans(kind="event", when=J(D("2026-11-22")))]),
  T("and push the league one back an hour", diff(upd("league_1122", date="2026-11-22T12:00")),
    ref=[act("reschedule", rows="$league_1122", args=lines(to=U("hour", 1, anchor="row")))]),
  T("how many events have i got on the 22nd", val(3),
    ref=[ans(op="count", kind="event", when=J(D("2026-11-22")))]))

S("T31-213", "repair-cadence-days edit kasia two-week-list within star",
  T("make kasia every 2 weeks", diff(upd("kasia", cadence=14)),
    ref=[bad(act("edit", kind="person", name="kasia", args="cadence: 2 weeks")),
         act("edit", kind="person", name="kasia", args="cadence: 14")]),
  T("anyone else i ring every two weeks", rows("babcia", "adrian", "marcin_b"),
    ref=[ans(kind="person", where="cadence = 14", exclude="$kasia")]),
  T("which of those aren't starred", rows("babcia", "marcin_b"),
    ref=[ans(within="@prev", where="starred = no")]),
  T("star them", diff(upd("babcia", starred=True), upd("marcin_b", starred=True)),
    ref=[act("star", rows="@2")]))

S("T31-214", "repair-log-kind whatsapp mama month-calls push count",
  T("i whatsapped mama about sunday, log it", diff(upd("mama", date=ANY)),
    ref=[bad(act("log", kind="person", name="mama", args="kind: whatsapp")),
         act("log", kind="person", name="mama", args="kind: message")]),
  T("what else have i got with her this month", rows("mama_1101", "mama_1108", "babcia_name_day", "mama_1115", "mama_1122", "mama_1129"),
    ref=[ans(kind="event", linked_to="$mama", when=J(U("month", 0)))]),
  T("push the one on the 29th to the 30th, same time", diff(upd("mama_1129", date="2026-11-30T18:30")),
    ref=[act("reschedule", kind="event", name="call mama", when=J(D("2026-11-29")), args=lines(to=D("2026-11-30", "18:30")))]),
  T("how many calls with mama are left this month", val(4),
    ref=[ans(op="count", kind="event", name="call mama", when=J(span(U("day", 0), D("2026-11-30"))))]))

S("T31-215", "repair-event-field-duration physio dentist longest",
  T("how many minutes are the physio sessions together", val(135),
    ref=[bad(ans(op="sum", field="effort", kind="event", name="physio")),
         ans(op="sum", field="duration", kind="event", name="physio")]),
  T("and the dentist check-ups", val(90),
    ref=[ans(op="sum", field="duration", kind="event", name="dentist")]),
  T("how long is the longest event this month", val(600),
    ref=[ans(op="max", field="duration", kind="event", when=J(U("month", 0)))]))
