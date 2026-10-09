from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# --- the person is vague, the model asks, the answer opens a short thread -----------------------------------

S("T31-256", "ask-next-what night shifts one-after count-total",
  T("when's the next one", ask(),
    ref=[askc("The next what?")]),
  T("the next night shift", rows("shift_1109"),
    ref=[ans(kind="event", name="night shift", order="date asc", limit=1, when=J({"from": U("day", 0)}))]),
  T("and the one after it", rows("shift_1111"),
    ref=[ans(kind="event", name="night shift", order="date asc", limit=1, when=J({"from": U("day", 0)}), exclude="$shift_1109")]),
  T("how many night shifts are there in total", val(7),
    ref=[ans(op="count", kind="event", name="night shift")]),
  T("cancel the night shift on the 23rd that magda is on", diff(upd("shift_1123", status="cancelled")),
    ref=[act("cancel", kind="event", name="night shift", when=J(D("2026-11-23")), linked_to="$magda")]))

S("T31-257", "ask-which-task tick-off pit-docs short-about-someone longest",
  T("tick something off", ask(),
    ref=[askc("Which task should I tick off?")]),
  T("the pit documents one", diff(upd("pit_docs", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="pit documents", where="status = open")]),
  T("how many open tasks take under 20 minutes and are about someone", val(7),
    ref=[ans(op="count", kind="task", where="status = open and effort < 20 and person count >= 1")]),
  T("which task takes the longest", rows("london_gifts"),
    ref=[ans(kind="task", where="status = open", order="effort desc", limit=1)]),
  T("push the cpr module that's about przemek from the 18th to the 20th", diff(upd("cpr_prep", date="2026-11-20")),
    ref=[act("reschedule", kind="task", name="cpr e-learning", when=J(D("2026-11-18")), linked_to="$przemek", args=lines(to=D("2026-11-20")))]))

S("T31-258", "ask-move-dinner reschedule saturday-friday count-november latest",
  T("move the dinner", ask(),
    ref=[askc("Which dinner, and to when?")]),
  T("the flat dinner on saturday to friday at 8", diff(upd("flat_dinner", date="2026-11-06T20:00")),
    ref=[act("reschedule", kind="event", name="flat dinner", when=J(U("week", 0, weekday=6)),
             args=lines(to=U("week", 0, weekday=5, time="20:00")))]),
  T("how many dinners are there this month", val(2),
    ref=[ans(op="count", kind="event", name="dinner", when=J(U("month", 0)))]),
  T("which dinner is the latest", rows("stag_planning"),
    ref=[ans(kind="event", name="dinner", order="date desc", limit=1)]),
  T("delete the dinner on the 28th that adi is coming to", diff(trash("stag_planning")),
    ref=[act("delete", kind="event", name="dinner", when=J(D("2026-11-28")), linked_to="$adrian")]))

# --- things the assistant cannot do, then what it can ------------------------------------------------------------

S("T31-259", "decline-out-of-scope pay kuba settle-gas count-owed-over smallest-owed",
  T("pay kuba back for me", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok mark my gas share as paid then", diff(upd("d_kuba_gas", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$kuba", where="direction = i_owe")]),
  T("how many debts do i still owe over 30", val(4),
    ref=[ans(op="count", kind="debt", where="direction = i_owe and status = open and amount > 30")]),
  T("the smallest amount i owe", rows("d_ewa"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open", order="amount asc", limit=1)]),
  T("settle the cleaning supplies one i owe ola from october", diff(upd("d_ola_clean", status="settled")),
    ref=[act("settle_debt", kind="debt", name="cleaning supplies", linked_to="$ola", when=J(U("month", -1, name=10)))]))

S("T31-260", "decline-out-of-scope heating task tomorrow count-tomorrow",
  T("turn the heating down", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok add a task to check the thermostat tomorrow", diff(new("task", name=has("thermostat"), date="2026-11-06")),
    ref=[act("create", kind="task", args=lines(name="Check the thermostat", date=U("day", 1)))]),
  T("what else is due tomorrow", rows("bin_rota", "shopping", "kit_wash", "pay_ola", "handover"),
    ref=[ans(kind="task", when=J(U("day", 1)), exclude="$c1")]),
  T("total number of tasks due tomorrow", val(6),
    ref=[ans(op="count", kind="task", when=J(U("day", 1)))]))

S("T31-261", "decline-out-of-scope email barber cancel-haircut count-cancelled",
  T("email the barber to cancel", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok cancel the haircut then", diff(upd("barber_ev", status="cancelled")),
    ref=[act("cancel", kind="event", name="haircut")]),
  T("count the cancelled events now", val(3),
    ref=[ans(op="count", kind="event", where="status = cancelled")]),
  T("which of the cancelled ones is the most recent", rows("barber_ev"),
    ref=[ans(kind="event", where="status = cancelled", order="date desc", limit=1)]),
  T("delete the haircut that i cancelled, i'll find another barber", diff(trash("barber_ev")),
    ref=[act("delete", kind="event", name="haircut", where="status = cancelled")]))

# --- repairs: what the runtime says is what the next call writes -----------------------------------------------

S("T31-262", "repair-task-field-due pit reschedule count-day",
  T("make the pit task due the 25th", diff(upd("pit", date="2026-11-25")),
    ref=[bad(act("edit", kind="task", name="pit-37", args="due: 2026-11-25")),
         act("reschedule", kind="task", name="pit-37", args=lines(to=D("2026-11-25")))]),
  T("how many tasks are due on the 25th", val(2),
    ref=[ans(op="count", kind="task", when=J(D("2026-11-25")))]),
  T("which of the open ones take over half an hour", rows("pit"),
    ref=[ans(kind="task", when=J(D("2026-11-25")), where="status = open and effort > 30")]),
  T("and the one that's left", rows("nfz"),
    ref=[ans(kind="task", when=J(D("2026-11-25")), exclude="$pit")]),
  T("tick off the nfz one that's due on the 25th, i updated the details", diff(upd("nfz", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="nfz details", when=J(D("2026-11-25")))]))

S("T31-263", "repair-clock-format create lunch kuba tomorrow count-day",
  T("put lunch with kuba tomorrow at 1", diff(new("event", name=has("kuba"), date="2026-11-06T13:00")),
    ref=[bad(act("create", kind="event", args=lines(name="Lunch with Kuba", date=U("day", 1, time="1")))),
         act("create", kind="event", args=lines(name="Lunch with Kuba", date=U("day", 1, time="13:00")))]),
  T("anything else in tomorrow's diary", rows("coffee_ola"),
    ref=[ans(kind="event", when=J(U("day", 1)), exclude="$c1")]),
  T("how many events are there tomorrow", val(2),
    ref=[ans(op="count", kind="event", when=J(U("day", 1)))]),
  T("push the lunch to half past one", diff(upd("+1", date="2026-11-06T13:30")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("day", 1, time="13:30")))]),
  T("cancel the lunch with kuba tomorrow, he's ill", diff(upd("+1", status="cancelled")),
    ref=[act("cancel", kind="event", name="lunch kuba", when=J(U("day", 1)))]))

S("T31-264", "repair-status-value done tasks count-completed recent",
  T("which tasks are done", rows("london_flights", "london_leave", "rent_oct", "rent_sep", "net_pay", "elec_pay", "bin_rota_prev", "shopping_prev",
                                 "timesheet", "kit_wash_prev", "league_fee", "call_kasia_prev", "physio_book_old", "dentist_book"),
    ref=[bad(ans(kind="task", where="status = done")),
         ans(kind="task", where="status = completed")]),
  T("how many of those did i finish this month", val(2),
    ref=[ans(op="count", kind="task", where="status = completed", when=J(U("month", 0)))]),
  T("which one did i finish last", rows("net_pay"),
    ref=[ans(within="@prev", order="completed desc", limit=1)]),
  T("and the one before it", rows("call_kasia_prev"),
    ref=[ans(kind="task", where="status = completed", order="completed desc", limit=1, exclude="$net_pay")]),
  T("reopen the internet payment i finished this month", diff(upd("net_pay", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="pay internet", when=J(U("month", 0)), where="status = completed")]))
