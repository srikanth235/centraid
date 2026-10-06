from gold import *

world("T07", "2026-03-12T12:30", "Maria Ines Quispe", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


OPEN = 'status = "open"'

S("T07-K001", "referent membership renew i3skill S1",
  T("what's the colegio de ingenieros membership", rows("cip"),
    ref=[ans(kind="locker item", name="Colegio de Ingenieros")]),
  T("when does it renew", rows("cip"),
    ref=[ans(rows="$cip")]))

S("T07-K002", "referent count narrows priority i3skill S1",
  T("how many tasks are open on the coop list", val(9),
    ref=[ans(kind="task", op="count", linked_to="$coop_l", where=OPEN)]),
  T("how many are priority 2", val(2),
    ref=[ans(kind="task", op="count", linked_to="$coop_l", where=OPEN + " and priority = 2")]))

S("T07-K003", "referent next event people it i3skill S1",
  T("when's the next agrobanco meeting", rows("agro_0319"),
    ref=[ans(kind="event", name="Agrobanco", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("who's coming to it", rows("patricia", "teodoro"),
    ref=[ans(kind="person", linked_to="$agro_0319")]))

S("T07-K004", "referent created task add to list i3skill S1",
  T("add a task call hugo about the clones", diff(new("task", name=has("hugo", "clones"))),
    ref=[act("create", args=lines(kind="task", name="Call Hugo about the clones"))]),
  T("put it on the farm list", diff(link("farm_l", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$farm_l"))]))

S("T07-K005", "referent person her log i3skill S1",
  T("when did i last talk to rosa condori", rows("rosa_c"),
    ref=[ans(kind="person", name="Rosa Condori")]),
  T("log a coffee with her", diff(upd("rosa_c", date=ANY)),
    ref=[act("log", rows="$rosa_c", args=lines(kind="coffee"))]))

S("T07-K006", "referent list then the noun i3skill S1",
  T("what's open on the home list", rows("gas", "roof", "water_bill", "mama_pills"),
    ref=[ans(kind="task", linked_to="$home_l", where=OPEN)]),
  T("tick off the pills", diff(upd("mama_pills", status="completed", completed=ANY)),
    ref=[act("complete", rows="$mama_pills")]))

S("T07-K007", "referent event how long it i3skill S1",
  T("when do i take mama juana to the clinic", rows("clinic"),
    ref=[ans(kind="event", name="clinic")]),
  T("how long will it take", rows("clinic"),
    ref=[ans(rows="$clinic")]))

S("T07-K008", "perfect called this month i3skill S2",
  T("how many times have i called valeria this month", val(2),
    ref=[ans(kind="event", op="count", name="Call with Valeria", when=J({"from": U("month", 0), "to": U("day", 0)}))]))

S("T07-K009", "single day saturday sunday i3skill S2",
  T("what's on saturday", rows("asm_0314"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=6)))]),
  T("and sunday", rows("mass_0315", "vcall_0315"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=7)))]))

S("T07-K010", "still in march this year i3skill S2",
  T("is the expo still in march", rows("expo"),
    ref=[ans(kind="event", name="Expo", when=J(U("month", 0, name=3)))]))

S("T07-K011", "still in april ahead i3skill S2",
  T("is valeria's airport pickup still in april", rows("airport"),
    ref=[ans(kind="event", name="airport", when=J(U("month", 0, name=4)))]))

S("T07-K012", "duration hours effort i3skill S2",
  T("which tasks take over 2 hours", rows("trial_data", "storehouse"),
    ref=[ans(kind="task", where="effort > 120")]))

S("T07-K013", "cadence fortnightly monthly i3skill S2",
  T("who's on a fortnightly cadence", rows("luis", "carla", "rosa_m", "marco"),
    ref=[ans(kind="person", where="cadence = 14 days")]),
  T("and monthly", rows("wilber", "nilda", "ana"),
    ref=[ans(kind="person", where="cadence = 30 days")]))

S("T07-K014", "relation to event dates line i3skill S2",
  T("what's left on the home list before julio's birthday dinner", rows("gas", "mama_pills", "water_bill"),
    ref=[ans(kind="task", linked_to="$home_l", where=OPEN, when=J({"to": D("2026-03-21")}))]))

S("T07-K015", "read not write water bill i3skill S3",
  T("did i pay the water bill", rows("water_bill"),
    ref=[ans(kind="task", name="Pay the water bill")]))

S("T07-K016", "read debt i owe efrain i3skill S3",
  T("did i pay efrain for the scouting", rows("d_efrain"),
    ref=[ans(kind="debt", name="scouting")]))

S("T07-K017", "read cancelled seed fair i3skill S3",
  T("did the seed fair get cancelled", rows("pisac_fair"),
    ref=[ans(kind="event", name="Seed fair")]))

S("T07-K018", "read then write agenda i3skill S3",
  T("is the assembly agenda drafted", rows("agenda"),
    ref=[ans(kind="task", name="Draft the assembly agenda")]),
  T("it's written, tick it off", diff(upd("agenda", status="completed", completed=ANY)),
    ref=[act("complete", rows="$agenda")]))

S("T07-K019", "read starred of them cards i3skill S3",
  T("what cards do i have", rows("bcp_card", "visa"),
    ref=[ans(kind="locker item", where='type = "card"')]),
  T("which of them are starred", rows("bcp_card"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T07-K020", "read trashed did i delete i3skill S3",
  T("did i delete the llama manure task", rows("manure"),
    ref=[ans(kind="task", name="llama manure", trashed=True)]))

S("T07-K021", "read debt two follow i3skill S3",
  T("has teodoro paid for the assembly lunch", rows("d_teodoro"),
    ref=[ans(kind="debt", name="Assembly lunch")]),
  T("and rosa for the fertilizer", rows("d_rosa"),
    ref=[ans(kind="debt", name="Fertilizer share")]))

S("T07-K022", "no invention task description search i3skill S4",
  T("mark the one with patricia's checklist as done", diff(upd("agro_docs", status="completed", completed=ANY)),
    ref=[search("checklist", kind="task"), act("complete", rows="$agro_docs")]))

S("T07-K023", "no invention note body search delete i3skill S4",
  T("delete the note about the sheep", diff(trash("raffle_notes")),
    ref=[search("sheep", kind="note"), act("delete", rows="$raffle_notes")]))

S("T07-K024", "no invention role mechanic log i3skill S4",
  T("log a call with the mechanic", diff(upd("gabriel", date=ANY)),
    ref=[act("log", kind="person", where='role contains "mechanic"', args=lines(kind="call"))]))

S("T07-K025", "no invention missing name ask i3skill S4",
  T("put a task on the farm list", ask(),
    ref=[askc("What should the task say?")]))

S("T07-K026", "no invention note body search read i3skill S4",
  T("which note mentions low phosphorus", rows("soil_notes"),
    ref=[search("phosphorus", kind="note"), ans(rows="$soil_notes")]))

S("T07-K027", "referent changed row that i3skill S1",
  T("tick off the water bill", diff(upd("water_bill", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="water bill")]),
  T("what was the due date on that", rows("water_bill"),
    ref=[ans(rows="$water_bill")]))

S("T07-K028", "perfect had this week i3skill S2",
  T("how many choir rehearsals have i had this week", val(1),
    ref=[ans(kind="event", op="count", name="Choir rehearsal", when=J({"from": U("week", 0), "to": U("day", 0)}))]))

S("T07-K029", "read starred named row i3skill S3",
  T("is the cip membership starred", rows("cip"),
    ref=[ans(kind="locker item", name="Colegio de Ingenieros")]))
