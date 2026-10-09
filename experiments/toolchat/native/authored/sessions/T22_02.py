from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T22-026", "person span weekday within log event name",
  T("which contacts did i reach out to, last monday onwards",
    rows("birgitta", "lennart", "johan_n", "mikael", "olle", "erik_s", "mats"),
    ref=[ans(kind="person", when=W(span(U("week", -1, weekday=1), U("day", -1))))]),
  T("which of those am i meant to talk to every week", rows("birgitta", "lennart", "johan_n", "mikael", "erik_s"),
    ref=[ans(within="@prev", where="cadence = 7")]),
  T("called mamma now, log it", diff(upd("birgitta", date=ANY)),
    ref=[act("log", rows="$birgitta", args=lines(kind="call"))]),
  T("when's Pappa's knee check-up", rows("knee"),
    ref=[ans(kind="event", name="Pappa's knee check-up")]))

S("T22-027", "person span cadence log",
  T("anyone i last spoke to between june and last week that i'm only meant to see monthly-ish",
    rows("johan_b", "samira", "nour", "linnea", "maria"),
    ref=[ans(kind="person", when=W(span(U("month", -1), U("week", -1))), where="cadence > 14")]),
  T("messaged samira, log that", diff(upd("samira", date=ANY)),
    ref=[act("log", rows="$samira", args=lines(kind="message"))]))

S("T22-028", "person group count debt count",
  T("who's in more than one of my groups", rows("ahmed", "karin", "david", "lena", "me"),
    ref=[ans(kind="person", where="group count > 1")]),
  T("any padel people with no debts either way", rows("erik_l"),
    ref=[ans(kind="person", where='debt count < 1 and role contains "padel"')]),
  T("is he the organiser one?", rows("erik_l"),
    ref=[ans(rows="$erik_l")]))

S("T22-029", "person note count open note",
  T("which forklift drivers show up in my notes", rows("fatima", "dragan"),
    ref=[ans(kind="person", where='note count != 0 and role contains "forklift"')]),
  T("open the Late shift rota note", rows("late_rota"),
    ref=[find(kind="note", name="Late shift rota"), ans(rows="@prev")]))

S("T22-030", "person note count star multi group count exclude",
  T("padel lot i've written notes about", rows("erik_s", "hanna", "tobias", "mats"),
    ref=[ans(kind="person", where='note count != 0 and role contains "padel"')]),
  T("star hanna and mats", diff(upd("hanna", starred=True), upd("mats", starred=True)),
    ref=[act("star", rows="$hanna, $mats")]),
  T("who's in more than one group apart from ahmed", rows("karin", "david", "lena", "me"),
    ref=[ans(kind="person", where="group count > 1", exclude="$ahmed")]))

S("T22-031", "event anchor tomorrow within duration",
  T("what's on tomorrow", rows("safety_walk", "swim_1", "padel_0714", "samira_call"),
    ref=[ans(kind="event", when=W(U("day", 1, anchor="today")))]),
  T("which of those are half an hour or less", rows("samira_call"),
    ref=[ans(within="@prev", where="duration <= 30 minutes")]))

S("T22-033", "event person count week anchor tomorrow",
  T("anything next week with nobody else coming", rows("car_service", "drive_osterlen"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="person count = 0")]),
  T("and tomorrow, what's there", rows("safety_walk", "swim_1", "padel_0714", "samira_call"),
    ref=[ans(kind="event", when=W(U("day", 1, anchor="today")))]))

S("T22-034", "event span date weekday ambiguous dentist ask reschedule",
  T("what's on from the fifteenth through friday",
    rows("knee", "leads_0715", "micke_coffee", "jonas_talk", "linnea_1on1", "padel_doubles", "camp_pickup"),
    ref=[ans(kind="event", when=W(span(D("2026-07-15"), U("week", 0, weekday=5))))]),
  T("move the dentist to 4pm", ask("dentist_jun", "dentist_aug"),
    ref=[act("reschedule", kind="event", name="Dentist for Elias", args=lines(to=U("day", 0, anchor="row", time="16:00"))),
         find(kind="event", name="Dentist for Elias"),
         askc("there are two, 10 june and 19 august. which one?", options="$dentist_jun, $dentist_aug")]),
  T("august", diff(upd("dentist_aug", date="2026-08-19T16:00")),
    ref=[act("reschedule", rows="$dentist_aug", args=lines(to=U("day", 0, anchor="row", time="16:00")))]),
  T("anything else that day", rows(),
    ref=[ans(kind="event", when=W(D("2026-08-19")), exclude="$dentist_aug")]))

S("T22-035", "event span date weekday within description",
  T("between the sixteenth and sunday, what's booked",
    rows("jonas_talk", "linnea_1on1", "padel_doubles", "camp_pickup", "anniversary", "kayak"),
    ref=[ans(kind="event", when=W(span(D("2026-07-16"), U("week", 0, weekday=7))))]),
  T("which of them have a description", rows("jonas_talk", "anniversary"),
    ref=[ans(within="@prev", where="description is set")]))

S("T22-036", "event span named month week count",
  T("padel matches from june up to last week that got called off", rows("padel_0623"),
    ref=[ans(kind="event", name="Padel league match", when=W(span(U("month", 0, name=6), U("week", -1))),
             where='status = "cancelled"')]),
  T("how many did i actually play in that stretch", val(5),
    ref=[ans(op="count", kind="event", name="Padel league match", when=W(span(U("month", 0, name=6), U("week", -1))),
             where='status != "cancelled"')]),
  T("and next tuesday's is on?", rows("padel_0721"),
    ref=[ans(kind="event", name="Padel league match", when=W(U("week", 1, weekday=2)))]))

S("T22-037", "event span named month open to date",
  T("parents network stuff from june up to this week", rows("picnic_jun"),
    ref=[ans(kind="event", name="Parents network picnic", when=W(span(U("month", 0, name=6), U("week", 0))))]),
  T("was elias's dentist before the first of july?", rows("dentist_jun"),
    ref=[ans(kind="event", name="Dentist for Elias", when=W({"to": D("2026-07-01")}))]))

S("T22-038", "event open to date linked ordinal reschedule people",
  T("everything with david before september", rows("picnic_jun", "picnic_aug", "kayak"),
    ref=[ans(kind="event", linked_to="$david", when=W({"to": D("2026-09-01")}))]),
  T("the second picnic, move it to 12", diff(upd("picnic_aug", date="2026-08-16T12:00")),
    ref=[act("reschedule", rows="$picnic_aug", args=lines(to=U("day", 0, anchor="row", time="12:00")))]),
  T("who's coming to that", rows("maria", "david", "lena"),
    ref=[ans(kind="person", linked_to="$picnic_aug")]))

S("T22-039", "task effort literal complete multi",
  T("open jobs that take under fifteen minutes",
    rows("smoke_alarm", "parking_fine", "sh_share", "court_1", "balls", "sunscreen", "charcoal", "el_07"),
    ref=[ans(kind="task", where='effort < 15 and status = "open"')]),
  T("Buy sunscreen and Buy charcoal are done",
    diff(upd("sunscreen", status="completed", completed=ANY), upd("charcoal", status="completed", completed=ANY)),
    ref=[act("complete", rows="$sunscreen, $charcoal")]))

S("T22-040", "refused unit effort repair complete list read",
  T("warehouse stuff that takes less than an hour", rows("sick_report", "vests"),
    ref=[bad(ans(kind="task", linked_to="$work_l", where="effort < 1 hour")),
         ans(kind="task", linked_to="$work_l", where="effort < 60")]),
  T("Order new safety vests, done", diff(upd("vests", status="completed", completed=ANY)),
    ref=[act("complete", rows="$vests")]),
  T("what's still open there", rows("inv_prep", "sick_report"),
    ref=[ans(kind="task", linked_to="$work_l", where='status = "open"')]))

S("T22-041", "task count linkcount subtasks",
  T("which tasks have subtasks but fewer than 3", rows("party"),
    ref=[ans(kind="task", where="task count < 3 and task count > 0")]),
  T("what's under it", rows("cake", "speech"),
    ref=[ans(kind="task", linked_to="$party")]))

S("T22-042", "task list count add_to task count empty",
  T("tasks with a priority that aren't on a list", rows("scanners", "party", "agency", "passport", "guest_room"),
    ref=[ans(kind="task", where="priority is set and list count != 1")]),
  T("put the scanners one on the warehouse list", diff(link("work_l", "scanners")),
    ref=[act("add_to", rows="$scanners", args=lines(to="$work_l"))]),
  T("does Shift schedule for August have less than 3 subtasks", rows(),
    ref=[ans(kind="task", name="Shift schedule for August", where="task count < 3")]))

S("T22-045", "note notebook count notebook note count",
  T("pinned notes that live in a notebook", rows("late_rota", "lineup", "elias_story"),
    ref=[ans(kind="note", where="pinned = yes and notebook count > 0")]),
  T("any notebooks with nothing in them", rows("journal_nb"),
    ref=[ans(kind="notebook", where="note count = 0")]))

S("T22-046", "notebook note count edit notebook named add_to note",
  T("which notebooks have exactly two notes", rows("padel_nb", "sh_nb"),
    ref=[ans(kind="notebook", where="note count = 2")]),
  T("rename Padel tactics to Padel league notes", diff(upd("padel_nb", name="Padel league notes")),
    ref=[act("edit", rows="$padel_nb", args=lines(name="Padel league notes"))]),
  T("and move the Padel scores note in there", diff(link("padel_nb", "padel_scores")),
    ref=[act("add_to", rows="$padel_scores", args=lines(to="$padel_nb"))]))

S("T22-047", "edit notebook named add_to note knock-on",
  T("rename the Old journal notebook to Elias questions", diff(upd("journal_nb", name="Elias questions")),
    ref=[act("edit", rows="$journal_nb", args=lines(name="Elias questions"))]),
  T("put Notes from Jonas in there", diff(link("journal_nb", "jonas_notes"), unlink("adoption_nb", "jonas_notes")),
    ref=[act("add_to", rows="$jonas_notes", args=lines(to="$journal_nb"))]))

S("T22-048", "note weekday already pin",
  T("what notes did i write last thursday", rows("racking_note", "lineup"),
    ref=[ans(kind="note", when=W(U("week", -1, weekday=4)))]),
  T("pin the lineup one", diff(already=["lineup"]),
    ref=[act("edit", rows="$lineup", args=lines(pinned="yes")), ans(rows="$lineup")]),
  T("and the other one", diff(upd("racking_note", pinned=True)),
    ref=[act("edit", kind="note", within="@1", where="pinned = no", args=lines(pinned="yes"))]))

S("T22-049", "note day time edit",
  T("the note i wrote last night at ten past ten, what was it", rows("inv_plan"),
    ref=[ans(kind="note", when=W(U("day", -1, time="22:10")))]),
  T("change it, bulk should go before lunch", diff(upd("inv_plan", body=has("before lunch"))),
    ref=[act("edit", rows="$inv_plan", args=lines(body="start with aisles 1 to 20, bulk area before lunch"))]))

S("T22-050", "five turns note spans within delete read",
  T("notes from last monday till the end of july",
    rows("late_rota", "racking_note", "inv_plan", "appraisal_notes", "serve", "lineup", "gift_ideas", "speech_draft",
         "camp_info", "padel_scores"),
    ref=[ans(kind="note", when=W(span(U("week", -1, weekday=1), U("month", 0, name=7))))]),
  T("the ones with a person on them",
    rows("late_rota", "racking_note", "appraisal_notes", "serve", "lineup", "gift_ideas", "speech_draft", "padel_scores"),
    ref=[ans(within="@prev", where="person count > 0")]),
  T("since friday?", rows("inv_plan", "gift_ideas", "speech_draft", "camp_info"),
    ref=[ans(kind="note", when=W({"from": U("week", -1, weekday=5)}))]),
  T("delete Football camp info, camp's sorted", diff(trash("camp_info")),
    ref=[act("delete", rows="$camp_info")]),
  T("what's in the speech draft again", rows("speech_draft"),
    ref=[ans(rows="$speech_draft")]))
