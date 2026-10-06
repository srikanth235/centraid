from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T20-051", "four turns event duration ambiguous dentist description empty edit",
  T("anything next week shorter than an hour", rows("keys_pickup", "brief_0602"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="duration < 60 minutes")]),
  T("move the dentist to 9:30 on the same day", diff(upd("dentist_jun", date="2026-06-09T09:30")),
    ref=[act("reschedule", kind="event", name="Dentist", args=lines(to=D("2026-06-09", "09:30"))),
         act("reschedule", rows="$dentist_jun", args=lines(to=D("2026-06-09", "09:30")))]),
  T("which of next week's events have no description", rows("keys_pickup", "electrician_visit", "plumber_visit", "ikea"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="description is empty")]),
  T("give the ikea run one: bookcase and bed slats", diff(upd("ikea", description="bookcase and bed slats")),
    ref=[act("edit", rows="$ikea", args=lines(description="bookcase and bed slats"))]),
  T("and june up to the fourth?", rows("keys_pickup", "fede_visit", "brief_0602", "electrician_visit", "planner_meet"),
    ref=[ans(kind="event", when=W(span(U("month", 0, name=6), D("2026-06-04"))))]))

S("T20-052", "event description empty reschedule anchor rel time",
  T("tomorrow's events with no description", rows("cellar_count", "photographer_call", "aperitivo"),
    ref=[ans(kind="event", when=W(U("day", 1)), where="description is empty")]),
  T("push the call with ettore an hour later", diff(upd("photographer_call", date="2026-05-29T13:00")),
    ref=[act("reschedule", rows="$photographer_call", args=lines(to={"unit": "hour", "rel": 1, "anchor": "row"}))]),
  T("what's on tomorrow at 1pm", rows("photographer_call"),
    ref=[ans(kind="event", when=W(U("day", 1, time="13:00")))]),
  T("delete it, ettore's emailing instead", diff(trash("photographer_call")),
    ref=[act("delete", rows="@prev")]))

S("T20-053", "event rel time duration under",
  T("anything the day after tomorrow at 10", rows("bike_service"),
    ref=[ans(kind="event", when=W(U("day", 2, time="10:00")))]),
  T("and what's on this week that's under 45 minutes", rows("supplier_call", "photographer_call"),
    ref=[ans(kind="event", when=W(U("week", 0)), where="duration < 45 minutes")]),
  T("move aperitivo with andrea to 8pm, cancel the call with ettore, add a task Email Ettore the shot list for tomorrow, then show me tomorrow",
    rows("cellar_count", "photographer_call", "aperitivo",
         also=diff(upd("aperitivo", date="2026-05-29T20:00"), upd("photographer_call", status="cancelled"),
                   new("task", name="Email Ettore the shot list", date="2026-05-29"))),
    ref=[act("reschedule", rows="$aperitivo", args=lines(to=U("day", 0, anchor="row", time="20:00")), more=True),
         act("cancel", rows="$photographer_call", more=True),
         act("create", args=lines(kind="task", name="Email Ettore the shot list", date=U("day", 1)), more=True),
         ans(kind="event", when=W(U("day", 1)))]))

S("T20-054", "four turns event span date time overlap refused ask create read",
  T("what's on between first june and the third at noon", rows("keys_pickup", "fede_visit", "brief_0602", "electrician_visit"),
    ref=[ans(kind="event", when=W(span(D("2026-06-01"), D("2026-06-03", "12:00"))))]),
  T("add Wine delivery at the new flat on the third at 10", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Wine delivery at the new flat", date=D("2026-06-03", "10:00")))),
         askc("the electrician is at the new flat 9 to 11 that day. put the delivery at 11 instead?")]),
  T("yeah 11", diff(new("event", name="Wine delivery at the new flat", date="2026-06-03T11:00")),
    ref=[act("create", args=lines(kind="event", name="Wine delivery at the new flat", date=D("2026-06-03", "11:00")))]),
  T("so what's the third look like", rows("electrician_visit", "+1"),
    ref=[ans(kind="event", when=W(D("2026-06-03")))]))

S("T20-055", "event span month date name months cancel",
  T("events from june up to the tenth",
    rows("keys_pickup", "fede_visit", "brief_0602", "electrician_visit", "planner_meet", "plumber_visit", "nonna_bday",
         "ride_0607", "ikea", "dentist_jun", "brief_0609", "tasting_fra_2"),
    ref=[ans(kind="event", when=W(span(U("month", 0, name=6), D("2026-06-10"))))]),
  T("dentist appointments between may and june", rows("dentist_may", "dentist_jun"),
    ref=[ans(kind="event", name="Dentist", when=W(span(U("month", 0, name=5), U("month", 0, name=6))))]),
  T("cancel the june one, i'll rebook after the move", diff(upd("dentist_jun", status="cancelled")),
    ref=[act("cancel", rows="$dentist_jun")]))

S("T20-056", "five turns tastings months edit tasks span priority complete",
  T("any tastings with francesca between may and june", rows("tasting_fra_1", "tasting_fra_2"),
    ref=[ans(kind="event", name="Francesca", when=W(span(U("month", 0, name=5), U("month", 0, name=6))))]),
  T("the second one, add bring the roero whites to its description",
    diff(upd("tasting_fra_2", description=has("Roero"))),
    ref=[act("edit", rows="$tasting_fra_2", args=lines(description="new vintages, bring the Roero whites"))]),
  T("what tasks are due from monday 9am to the end of next week",
    rows("corkage", "curtains", "enel", "sofia_quiz", "boxes", "list_whites", "invoice_fede", "nonna_gift", "rent_06"),
    ref=[ans(kind="task", when=W(span(U("week", 1, weekday=1, time="09:00"), U("week", 1))))]),
  T("the priority one ones", rows("invoice_fede"),
    ref=[ans(kind="task", within="@prev", where="priority = 1")]),
  T("pay fede's invoice is done, sent it at lunch", diff(upd("invoice_fede", status="completed", completed=ANY)),
    ref=[act("complete", rows="$invoice_fede")]))

S("T20-058", "four turns task span subtasks count linked complete",
  T("tasks due from tomorrow 8am to sunday", rows("chianti_1", "chain", "car_tax"),
    ref=[ans(kind="task", when=W(span(U("day", 1, time="08:00"), U("week", 0))))]),
  T("which task has exactly 3 subtasks", rows("utilities"),
    ref=[ans(kind="task", where="task count = 3")]),
  T("list them", rows("enel", "gas", "internet"),
    ref=[ans(kind="task", linked_to="$utilities")]),
  T("call enel about the meter is done", diff(upd("enel", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Call Enel about the meter")]))

S("T20-059", "priority effort ne order limit",
  T("priority one tasks that aren't a 60 minute job", rows("pack_wine", "wine_list", "invoice_fede", "ais_study", "guest_list"),
    ref=[ans(kind="task", where="priority = 1 and effort != 60")]),
  T("which of those takes longest", rows("ais_study"),
    ref=[ans(kind="task", within="@prev", order="effort desc", limit=1)]),
  T("what's due from first july 9am onwards", rows("wine_pairing", "passport", "suit", "tax_730"),
    ref=[ans(kind="task", when=W({"from": D("2026-07-01", "09:00")}))]))

S("T20-060", "four turns list task count create list edit new add_to",
  T("which of my lists actually have tasks on them", rows("move_l", "cantina_l", "bike_l", "wedding_l", "errands_l"),
    ref=[ans(kind="list", where="task count != 0")]),
  T("make a new list Wedding wines", diff(new("list", name="Wedding wines")),
    ref=[act("create", args=lines(kind="list", name="Wedding wines"))]),
  T("set its area to family", diff(upd("+1", area="family")),
    ref=[act("edit", rows="$c1", args=lines(area="family"))]),
  T("put choose the wedding wines on it", diff(link("+1", "wine_pairing"), unlink("wedding_l", "wine_pairing")),
    ref=[act("add_to", rows="$wine_pairing", args=lines(to="$c1"))]),
  T("hm undo, keep it with the wedding stuff", diff(unlink("+1", "wine_pairing"), link("wedding_l", "wine_pairing")),
    ref=[act("undo")]))

S("T20-061", "create list edit new rename",
  T("new list: Housewarming, area home", diff(new("list", name="Housewarming", area="home")),
    ref=[act("create", args=lines(kind="list", name="Housewarming", area="home"))]),
  T("call it Housewarming party instead", diff(upd("+1", name="Housewarming party")),
    ref=[act("edit", rows="$c1", args=lines(name="Housewarming party"))]),
  T("add a task to it: Buy prosecco for the housewarming",
    diff(new("task", name="Buy prosecco for the housewarming"), link("+1", "new")),
    ref=[act("create", args=lines(kind="task", name="Buy prosecco for the housewarming", list="$c1"))]),
  T("which lists have something on them", rows("move_l", "cantina_l", "bike_l", "wedding_l", "errands_l", "+1"),
    ref=[ans(kind="list", where="task count != 0")]))

S("T20-062", "subtasks count two linked",
  T("which task has two subtasks", rows("wine_list"),
    ref=[ans(kind="task", where="task count = 2")]),
  T("what are they", rows("list_whites", "list_print"),
    ref=[ans(kind="task", linked_to="@prev")]))

S("T20-063", "four turns debt span date weekday open balance settle",
  T("debts from first may to twentieth may", rows("d_andrea", "d_davide", "d_chiara"),
    ref=[ans(kind="debt", when=W(span(D("2026-05-01"), D("2026-05-20"))))]),
  T("and since monday", rows("d_giulia", "d_sofia", "d_gianni"),
    ref=[ans(kind="debt", when=W({"from": U("week", 0, weekday=1)}))]),
  T("how much do i owe gianni barbieri", val((-150, "EUR")),
    ref=[comp(op="balance", rows="$gianni"), ans(value="@prev")]),
  T("settle it, paid him cash this morning", diff(upd("d_gianni", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$gianni")]))

S("T20-064", "debt rel time months direction",
  T("what did sofia borrow yesterday afternoon", rows("d_sofia"),
    ref=[ans(kind="debt", linked_to="$sofia", when=W(U("day", -1, time="15:00")))]),
  T("and anything from two days ago in the morning", rows("d_giulia"),
    ref=[ans(kind="debt", when=W(U("day", -2, time="09:00")))]),
  T("what did i borrow april through may", rows("d_fede", "d_marco_l", "d_andrea", "d_chiara", "d_gianni"),
    ref=[ans(kind="debt", where='direction = "i_owe"', when=W(span(U("month", 0, name=4), U("month", 0, name=5))))]))

S("T20-065", "debts direction set from weekday",
  T("every debt i've got, settled ones too",
    rows("d_giulia", "d_andrea", "d_stefano", "d_luca", "d_sofia", "d_davide", "d_fede", "d_chiara", "d_gianni",
         "d_marco_l", "d_elena", "d_stefano_2"),
    ref=[ans(kind="debt", where="direction is set")]),
  T("which are from last saturday on", rows("d_luca", "d_giulia", "d_sofia", "d_gianni"),
    ref=[ans(kind="debt", within="@prev", when=W({"from": U("week", -1, weekday=6)}))]))

S("T20-066", "ambiguous person marco ask star",
  T("star marco", diff(upd("marco_l", starred=True)),
    ref=[act("star", kind="person", name="Marco")]),
  T("what's his balance with me", val((-30, "EUR")),
    ref=[ans(op="balance", rows="$marco_l")]),
  T("who from the club have i seen between last week and sunday", rows("marco_l", "stefano"),
    ref=[ans(kind="person", where='role contains "club"', when=W(span(U("week", -1), U("week", -1, weekday=7))))]))

S("T20-067", "ambiguous lorenzo ask log",
  T("log a call with lorenzo", ask("lorenzo_g", "lorenzo_r"),
    ref=[act("log", kind="person", name="Lorenzo", args=lines(kind="call")),
         askc("Lorenzo Gallo or Lorenzo Ricci?", options="$lorenzo_g, $lorenzo_r")]),
  T("my cousin", diff(upd("lorenzo_r", date=ANY)),
    ref=[act("log", rows="$lorenzo_r", args=lines(kind="call"))]),
  T("when's the stag weekend again, he asked", rows("stag_weekend"),
    ref=[ans(kind="event", name="Stag weekend")]),
  T("who've i talked to from last saturday up to tuesday",
    rows("mamma", "papa", "marco_e", "marco_l", "stefano", "andrea", "carla", "lorenzo_g", "mauro"),
    ref=[ans(kind="person", when=W(span(U("week", -1, weekday=6), U("week", 0, weekday=2))))]))

S("T20-068", "refused delete group ask delete empty group undo",
  T("delete the vinitaly trip group, that's all done", ask(),
    ref=[bad(act("delete", rows="$vinitaly")),
         askc("vinitaly trip still has the hotel and train expenses in it, so it can't be deleted. settle up with federico and sofia first?")]),
  T("no leave it. delete nonna's birthday gift then, chiara's handling it",
    diff(gone("gift_pool"), unlink("gift_pool", "chiara"), unlink("gift_pool", "me")),
    ref=[act("delete", rows="$gift_pool")]),
  T("what groups are left", rows("casa", "club", "staff", "vinitaly", "stag"),
    ref=[ans(kind="group")]))

S("T20-069", "refused delete folder ask remove_from",
  T("get rid of the bills folder", ask(),
    ref=[bad(act("delete", kind="folder", name="Bills")),
         askc("bills still has the enel bill and the TARI in it, so it can't go. move them out first?")]),
  T("what's in the archive folder", rows(),
    ref=[ans(kind="document", linked_to="$archive_f")]),
  T("ok delete archive instead, it's empty", diff(gone("archive_f")),
    ref=[act("delete", rows="$archive_f")]))

S("T20-070", "restore window person refused ask create",
  T("restore silvia monti, she's coming to the wedding", ask(),
    ref=[bad(act("restore", kind="person", name="Silvia Monti", trashed=True)),
         askc("silvia's been in the bin since march, past the 30-day window, so she can't come back. add her as a new contact?")]),
  T("yes, old flatmate", diff(new("person", name="Silvia Monti", role=has("flatmate"))),
    ref=[act("create", args=lines(kind="person", name="Silvia Monti", role="old flatmate"))]),
  T("star her", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))

S("T20-071", "trashed people restore undo",
  T("who's in the trash from my contacts", rows("pietro", "riccardo", "silvia"),
    ref=[find(kind="person", trashed=True), ans(rows="@prev")]),
  T("bring back riccardo leone, need him for the final inspection", diff(restore("riccardo")),
    ref=[act("restore", rows="$riccardo")]),
  T("actually no, undo", diff(trash("riccardo")),
    ref=[act("undo")]))

S("T20-072", "single balance person",
  T("do i owe andrea costa anything", val((-240, "EUR")),
    ref=[ans(op="balance", rows="$andrea")]))

S("T20-073", "search nickname compute max",
  T("how much does tommy owe me", val((0, "EUR")),
    ref=[search("tommy", kind="person"), ans(op="balance", rows="$tommaso")]),
  T("what's the biggest debt anyone owes me", val((85, "EUR")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]),
  T("what's on with fede next week", rows("fede_visit"),
    ref=[find(kind="person", name="Fede"), search("fede", kind="person"),
         ans(kind="event", linked_to="$federico", when=W(U("week", 1)))]))

S("T20-075", "six turns wedding list guests planner",
  T("what's on the wedding list", rows("guest_list", "wine_pairing", "suit", "invites", "invites_print", "honeymoon", "rings_task"),
    ref=[ans(kind="task", linked_to="$wedding_l")]),
  T("who's on finalise guest list", rows("giulia", "matilde"),
    ref=[ans(kind="person", linked_to="$guest_list")]),
  T("when am i meeting matilde next", rows("planner_meet"),
    ref=[ans(kind="event", name="Matilde")]),
  T("push it to next friday, keep the time", diff(upd("planner_meet", date="2026-06-05T17:00")),
    ref=[act("reschedule", rows="$planner_meet", args=lines(to=U("week", 1, weekday=5, time="17:00")))]),
  T("put a note on it: bring the venue quotes", diff(upd("planner_meet", description=has("venue quotes"))),
    ref=[bad(act("edit", rows="$planner_meet", args=lines(notes="bring the venue quotes"))),
         act("edit", rows="$planner_meet", args=lines(description="venue shortlist, bring the venue quotes"))]),
  T("what's the guest numbers note say", rows("guest_n"),
    ref=[ans(kind="note", name="Guest numbers")]))
