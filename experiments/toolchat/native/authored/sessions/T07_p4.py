from gold import *
import json

world("T07", "2026-03-12T12:30", "Maria Ines Quispe", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# 201 "both" after a two-row result (a task and an event that share a word)
S("T07-201", "both task event reschedule bare weekday prev",
  T("any seed stuff tomorrow", rows("seed_delivery", "seed_pay"),
    ref=[ans(kind="task,event", name="seed", when=W(U("day", 1)))]),
  T("push both to monday", diff(upd("seed_delivery", date="2026-03-16T09:00"), upd("seed_pay", date="2026-03-16")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]),
  T("so how's monday shaping up after that", rows("scout_0316", "seed_delivery", "mechanic"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=1)))]))

# 202 ordinals after a listing, and a number picked from an ask
S("T07-202", "ordinal last rename ask pick cadence rosa",
  T("what's in the choir notebook", rows("seating", "repertoire", "raffle_notes"),
    ref=[ans(kind="note", linked_to="$choir_nb")]),
  T("rename the last one Raffle prize list", diff(upd("raffle_notes", name="Raffle prize list")),
    ref=[act("edit", rows="$raffle_notes", args=lines(name="Raffle prize list"))]),
  T("make rosa monthly", ask("rosa_m", "rosa_c"),
    ref=[act("edit", kind="person", name="Rosa", args=lines(cadence=30)),
         askc("1 rosa mamani from the coop or 2 rosa condori from the choir?", options="$rosa_m, $rosa_c")]),
  T("2 is fine", diff(upd("rosa_c", cadence=30)),
    ref=[act("edit", rows="$rosa_c", args=lines(cadence=30))]))

# 203 which way the money goes
S("T07-203", "debts owe direction my side settle both signs",
  T("my side first, what do i owe", rows("d_wilber", "d_carla", "d_efrain", "d_sonia", "d_lucia", "d_hugo"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("and what do they owe me", rows("d_rosa", "d_luis", "d_jaime", "d_carmen", "d_teodoro"),
    ref=[ans(kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("settle mine with lucia, paid her at rehearsal", diff(upd("d_lucia", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$lucia", where='direction = "i_owe"')]),
  T("luis paid the tractor money, clear that one too", diff(upd("d_luis", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$luis")]))

# 204 everything but one
S("T07-204", "except exclude tasks reschedule delete dues",
  T("what tasks are due tomorrow", rows("fung_1", "agenda", "seed_pay"),
    ref=[ans(kind="task", when=W(U("day", 1)))]),
  T("push all of them to monday except the fungicide", diff(upd("agenda", date="2026-03-16"), upd("seed_pay", date="2026-03-16")),
    ref=[find(kind="task", within="@prev", exclude="$fung_1"),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]),
  T("clear out the old coop dues tasks, everything but this month's",
    diff(trash("dues_10"), trash("dues_11"), trash("dues_12"), trash("dues_01"), trash("dues_02")),
    ref=[find(kind="task", name="Pay coop dues"),
         find(kind="task", within="@prev", exclude="$dues_03"),
         act("delete", rows="@prev")]))

# 205 bare weekdays, "at N", a relative range
S("T07-205", "bare weekday at N dentist range create",
  T("move the dentist to monday", diff(upd("dentist", date="2026-03-16T16:00")),
    ref=[act("reschedule", kind="event", name="Dentist appointment", args=lines(to=U("week", 1, weekday=1)))]),
  T("make it 5", diff(upd("dentist", date="2026-03-16T17:00")),
    ref=[act("reschedule", rows="$dentist", args=lines(to=U("day", 0, anchor="row", time="17:00")))]),
  T("what did i have monday to wednesday this week", rows("scout_0309", "carla_call", "reh_0311"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3))))]),
  T("set up a call with carla friday at 5", diff(new("event", name=has("carla"), date="2026-03-13T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Carla", date=U("week", 0, weekday=5, time="17:00")))]))

# 206 two writes in one message
S("T07-206", "two writes settle complete log visit complete",
  T("paid sonia the 350 and ticked off the seed payment", diff(upd("d_sonia", status="settled"), upd("seed_pay", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", linked_to="$sonia", more=True),
         act("complete", kind="task", name="Pay Sonia for the seed potatoes")]),
  T("log a visit with juana and tick off the pills", diff(upd("juana", date=ANY), upd("mama_pills", status="completed", completed=ANY)),
    ref=[act("log", rows="$juana", args=lines(kind="visit"), more=True),
         act("complete", kind="task", name="pills")]),
  T("how much do i still owe all told", val((295, "PEN")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))
