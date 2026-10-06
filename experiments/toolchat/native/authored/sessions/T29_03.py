from gold import *
import json

world("T29", "2026-09-23T18:10", "Achieng Odhiambo", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T29-045", "debt where-three order-limit settle-write-read over-five-k",
  T("what do i owe that's over 5000", rows("d_brenda", "d_lena", "d_otieno"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open and amount > 5000")]),
  T("oldest of those?", rows("d_lena"),
    ref=[ans(within="@prev", order="date asc", limit=1)]),
  T("settle it and tell me what's left over 5k",
    rows("d_brenda", "d_otieno", also=diff(upd("d_lena", status="settled"))),
    ref=[act("settle_debt", rows="$d_lena", more=True),
         ans(kind="debt", where="direction = i_owe and status = open and amount > 5000")]))

S("T29-046", "where-four person-count narrow-when two-writes complete",
  T("what's still open that takes 30 minutes or more, has no priority and isn't about anyone",
    rows("dog_food", "flat_fix", "kitty_report", "tax_docs", "insurance", "bike_service"),
    ref=[ans(kind="task", where="status = open and effort >= 30 minutes and priority is empty and person count = 0")]),
  T("which of those are due before october", rows("dog_food", "flat_fix", "kitty_report", "bike_service"),
    ref=[ans(within="@prev", when=J({"to": D("2026-09-30")}))]),
  T("tick off the dog food and the kitty spreadsheet",
    diff(upd("dog_food", status="completed", completed=ANY), upd("kitty_report", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="dog food", more=True),
         act("complete", kind="task", name="kitty spreadsheet")]))

S("T29-047", "site-visits name-where-when person-count next reschedule-same-time",
  T("september site visits with more than one person on them that weren't cancelled",
    rows("karen_site_0908", "karen_site_0915", "karen_site_0922", "karen_site_0929"),
    ref=[ans(kind="event", name="site visit", where="status != cancelled and person count >= 2",
             when=J(U("month", 0, name=9)))]),
  T("which of those is the next one", rows("karen_site_0929"),
    ref=[ans(within="@prev", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("thursday, same time", diff(upd("karen_site_0929", date="2026-10-01T09:00")),
    ref=[act("reschedule", rows="$karen_site_0929", args=lines(to=U("week", 1, weekday=4)))]))

S("T29-048", "repair-unit where-three narrow-month bulk-edit-priority undo",
  T("open tasks with no priority that take an hour or more",
    rows("karen_roof", "karen_boq", "karen_tiles", "tax_docs", "bike_service"),
    ref=[bad(ans(kind="task", where="status = open and effort >= 1 hour and priority is empty")),
         ans(kind="task", where="status = open and effort >= 60 minutes and priority is empty")]),
  T("which of them are due this month", rows("karen_roof", "karen_tiles", "bike_service"),
    ref=[ans(within="@prev", when=J(U("month", 0)))]),
  T("make those top priority",
    diff(upd("karen_roof", priority=1), upd("karen_tiles", priority=1), upd("bike_service", priority=1)),
    ref=[act("edit", rows="@prev", args="priority: 1")]),
  T("undo that",
    diff(upd("karen_roof", priority=None), upd("karen_tiles", priority=None), upd("bike_service", priority=None)),
    ref=[act("undo")]))

S("T29-049", "name-order-limit exclude delete-write-read month",
  T("my latest diary entry", rows("diary_good"),
    ref=[ans(kind="note", name="diary entry", order="date desc", limit=1)]),
  T("and the one before it", rows("diary_tough"),
    ref=[ans(kind="note", name="diary entry", order="date desc", limit=1, exclude="$diary_good")]),
  T("delete both and show me what notes are left from september",
    rows("tap_notes", "gift_ideas", "karen_site2", "runda_site1", "planning_checklist", "karen_site3",
         also=diff(trash("diary_good"), trash("diary_tough"))),
    ref=[act("delete", rows="$diary_good, $diary_tough", more=True),
         ans(kind="note", when=J(U("month", 0, name=9)))]))

S("T29-050", "ask-missing create-group members-new two-calls",
  T("make a group", ask(),
    ref=[askc("What should the group be called, and which currency?")]),
  T("weekend riders, in shillings, with kip and juma",
    diff(new("group", name="Weekend Riders", currency="KES"), link("new", "me"), link("new", "kip"), link("new", "juma")),
    ref=[act("create", args=lines(kind="group", name="Weekend Riders", currency="KES"), more=True),
         act("add_to", rows="$kip, $juma", args="to: $new")]),
  T("who's in it", rows("me", "kip", "juma"),
    ref=[ans(kind="person", linked_to="$c1")]))

S("T29-051", "create-album add-to-two-photos",
  T("start an album for the courtyard sketches", diff(new("album", name=has("sketch"))),
    ref=[act("create", args=lines(kind="album", name="Courtyard Sketches"))]),
  T("put the courtyard sketch and the printed drawing set in it",
    diff(link("+1", "p_sketch"), link("+1", "p_drawing_set")),
    ref=[act("add_to", kind="photo", name="courtyard sketch", args="to: $c1", more=True),
         act("add_to", kind="photo", name="printed drawing set", args="to: $c1")]))

S("T29-052", "reschedule two-dates name-when same-time still-on",
  T("move the ear follow-up from the 8th to the 9th, same time", diff(upd("vet_followup", date="2026-10-09T10:00")),
    ref=[act("reschedule", kind="event", name="follow-up", when=J(D("2026-10-08")), args=lines(to=D("2026-10-09")))]))

S("T29-053", "role-search mechanic two-writes reschedule time-window",
  T("when's the mechanic doing my car", rows("mot"),
    ref=[search("mechanic"), ans(kind="event", linked_to="$collins")]),
  T("push it to friday, same time, and move the insurance renewal up to monday",
    diff(upd("mot", date="2026-09-25T08:00"), upd("insurance", date="2026-09-28")),
    ref=[act("reschedule", rows="$mot", args=lines(to=U("week", 0, weekday=5)), more=True),
         act("reschedule", kind="task", name="insurance", args=lines(to=U("week", 1, weekday=1)))]),
  T("what's on friday morning", rows("mot", "client_faith"),
    ref=[ans(kind="event", when=J(span(U("week", 0, weekday=5, time="06:00"), U("week", 0, weekday=5, time="12:00"))))]))

S("T29-054", "repair-unit container-subtasks narrow where when exclude write-read role-search log",
  T("what's open under the karen house",
    rows("karen_dwgs", "karen_roof", "karen_boq", "karen_tiles", "inv_faith_sep", "karen_mockup"),
    ref=[ans(kind="task", linked_to="$karen", where="status = open")]),
  T("anything an hour or longer", rows("karen_dwgs", "karen_roof", "karen_boq", "karen_tiles"),
    ref=[bad(ans(within="@prev", where="effort >= 1 hour")),
         ans(within="@prev", where="effort >= 60 minutes")]),
  T("and are due by the 30th", rows("karen_roof", "karen_tiles"),
    ref=[ans(within="@prev", when=J({"to": D("2026-09-30")}))]),
  T("all but the tiles one", rows("karen_roof"),
    ref=[ans(within="@prev", exclude="$karen_tiles")]),
  T("push it to monday week and show me what else is due that day",
    rows("rent_oct", also=diff(upd("karen_roof", date="2026-10-05"))),
    ref=[act("reschedule", rows="$karen_roof", args=lines(to=U("week", 2, weekday=1)), more=True),
         ans(kind="task", where="status = open", when=J(U("week", 2, weekday=1)), exclude="$karen_roof")]),
  T("log a call with the engineer", diff(upd("peter", date=ANY)),
    ref=[search("engineer"), act("log", rows="$peter", args="kind: call")]))

S("T29-055", "name-when-order next reschedule-hour-anchor count-span role-search note-linked pin",
  T("when's the next vet appointment for simba", rows("vet_vacc"),
    ref=[ans(kind="event", name="vet simba", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("move it back an hour", diff(upd("vet_vacc", date="2026-09-26T16:00")),
    ref=[act("reschedule", rows="$vet_vacc", args=lines(to=U("hour", 1, anchor="row")))]),
  T("how many vet visits has he had this year so far", val(1),
    ref=[ans(op="count", kind="event", name="vet simba", when=J(span(U("year", 0), U("day", 0))))]),
  T("what did the vet say last time", rows("simba_vet"),
    ref=[search("vet", kind="person"), ans(kind="note", linked_to="$wafula")]),
  T("pin it", diff(upd("simba_vet", pinned=True)),
    ref=[act("edit", rows="$simba_vet", args="pinned: yes")]))

S("T29-056", "where-role log star when-name cancel count-four",
  T("which club people haven't i starred", rows("kevin_m", "mwende", "juma", "nyambura"),
    ref=[ans(kind="person", where='role contains "club" and starred = no')]),
  T("log a message to nyambura about the dues", diff(upd("nyambura", date=ANY)),
    ref=[act("log", rows="$nyambura", args="kind: message")]),
  T("star her too", diff(upd("nyambura", starred=True)),
    ref=[act("star", rows="$nyambura")]),
  T("what's the club got on in october", rows("ride_1003", "ride_1010", "ride_1017", "ride_1024", "ride_1031"),
    ref=[ans(kind="event", name="club", when=J(U("month", 0, name=10)))]),
  T("cancel the ride on the 10th", diff(upd("ride_1010", status="cancelled")),
    ref=[act("cancel", kind="event", name="club ride", when=J(D("2026-10-10")))]),
  T("so how many rides are still going ahead in october", val(4),
    ref=[ans(op="count", kind="event", name="club ride", where="status != cancelled", when=J(U("month", 0, name=10)))]))

S("T29-057", "log-nickname ambiguous-person role-narrow name-where complete",
  T("log a visit with auntie atieno", diff(upd("aunt_atieno", date=ANY)),
    ref=[act("log", kind="person", name="auntie atieno", args="kind: visit")]),
  T("and a call with otieno", ask("otieno", "kevin_o"),
    ref=[act("log", kind="person", name="otieno", args="kind: call")]),
  T("my brother", diff(upd("otieno", date=ANY)),
    ref=[act("log", kind="person", name="otieno", where='role = "brother"', args="kind: call")]),
  T("which of mama's tasks are still open", rows("mama_meds"),
    ref=[ans(kind="task", name="mama", where="status = open")]),
  T("tick it off, sent it", diff(upd("mama_meds", status="completed", completed=ANY)),
    ref=[act("complete", rows="$mama_meds")]))

S("T29-058", "compute-max value order-limit decline-text repair-create-field count-open",
  T("most anyone owes me?", val((5000, "KES")),
    ref=[comp(op="max", field="amount", kind="debt", where="direction = owes_me and status = open"),
         ans(value="@1")]),
  T("and who is that", rows("d_naomi"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", order="amount desc", limit=1)]),
  T("text her about it", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("remind me to chase her for it on friday", diff(new("task", name=has("chase"), date="2026-09-25")),
    ref=[bad(act("create", args="kind: task\nname: Chase Naomi for the bus fare\ndue: friday")),
         act("create", args=lines(kind="task", name="Chase Naomi for the bus fare", date=U("week", 0, weekday=5)))]),
  T("how many open debts total", val(10),
    ref=[ans(op="count", kind="debt", where="status = open")]))

S("T29-059", "name-event cancel when-where unstar where-role-empty",
  T("when's ian's birthday thing", rows("ian_bday"),
    ref=[ans(kind="event", name="ian birthday")]),
  T("cancel it, he's postponed", diff(upd("ian_bday", status="cancelled")),
    ref=[act("cancel", rows="$ian_bday")]),
  T("what's still on that saturday", rows("ride_1003"),
    ref=[ans(kind="event", where="status != cancelled", when=J(D("2026-10-03")))]),
  T("unstar brenda", diff(upd("brenda", starred=False)),
    ref=[act("unstar", kind="person", name="brenda")]),
  T("who are my starred friends now", rows(),
    ref=[ans(kind="person", where='role contains "friend" and starred = yes')]))
