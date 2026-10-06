from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T08-051", "balance two marcus ask log undo ledger",
  T("how much do i owe marcus", ask("marcus_b", "marcus_h"),
    ref=[bad(ans(op="balance", kind="person", name="Marcus")),
         askc("marcus bell from work or marcus hill from the boosters?", options="$marcus_b, $marcus_h")]),
  T("marcus bell", val((-19, "USD")),
    ref=[ans(op="balance", rows="$marcus_b")]),
  T("log a call with him, got off the phone", diff(upd("marcus_b", date=ANY)),
    ref=[act("log", rows="$marcus_b", args=lines(kind="call"))]),
  T("and log a message with marcus hill, texted him about the banner", diff(upd("marcus_h", date=ANY)),
    ref=[act("log", kind="person", name="Marcus Hill", args=lines(kind="message"))]))

S("T08-052", "trashed task restore reschedule prev anchor",
  T("did i delete the library books task", rows("library"),
    ref=[ans(kind="task", name="library books", trashed=True)]),
  T("yeah bring it back", diff(restore("library")),
    ref=[act("restore", rows="$library")]),
  T("when's the grievance paperwork due", rows("grievance"),
    ref=[ans(kind="task", name="grievance paperwork")]),
  T("bump it one day later, 9am", diff(upd("grievance", date="2026-04-14T09:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("day", 1, anchor="row", time="09:00")))]))

S("T08-053", "find miss other kind delete cancelled",
  T("when's the fish fry task due", rows("fish_fry"),
    ref=[find(kind="task", name="fish fry"), ans(rows="$fish_fry")]),
  T("oh right that got cancelled. delete it", diff(trash("fish_fry")),
    ref=[act("delete", rows="$fish_fry")]),
  T("what else got cancelled since march", rows("movie", "softball"),
    ref=[ans(kind="event", where='status = "cancelled"', when=W({"from": U("month", 0, name=3)}))]))

S("T08-054", "reunion list write+read subtasks",
  T("what's left on the reunion list", rows("hotel", "invites", "shirts", "menu", "slideshow"),
    ref=[ans(kind="task", linked_to="$reunion_l", where='status = "open"')]),
  T("mark Book hotel block in Macon done and tell me what's open",
    rows("shirts", "invites", "menu", "slideshow", also=diff(upd("hotel", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Book hotel block in Macon", more=True),
         ans(kind="task", linked_to="$reunion_l", where='status = "open"')]),
  T("who's on Order reunion T-shirts", rows("dre"),
    ref=[ans(kind="person", linked_to="$shirts")]),
  T("what are its subtasks", rows("sizes", "design"),
    ref=[ans(kind="task", linked_to="$shirts")]),
  T("move Get shirt design from Dre to the thirteenth", diff(upd("design", date="2026-04-13")),
    ref=[act("reschedule", kind="task", name="Get shirt design from Dre", args=lines(to=D("2026-04-13")))]),
  T("what's due on the reunion list from april to may fifteenth", rows("shirts", "invites", "menu"),
    ref=[ans(kind="task", linked_to="$reunion_l", when=W(span(U("month", 0, name=4), D("2026-05-15"))),
             where='status = "open"')]))

S("T08-055", "task span priority create edit new add_to named",
  T("any priority one tasks due between april and next week", rows("field_trip", "grievance", "taxes"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=4), U("week", 1))), where="priority = 1")]),
  T("add one: call the school about jalen's bus pass, due friday",
    diff(new("task", name=has("bus pass"), date=ANY)),
    ref=[act("create", args=lines(kind="task", name="Call the school about Jalen's bus pass", date=U("week", 0, weekday=5)))]),
  T("make that priority one", diff(upd("+1", priority=1)),
    ref=[act("edit", rows="$c1", args=lines(priority=1))]),
  T("also put Buy Jalen new cleats on the kids school list", diff(link("school_l", "cleats")),
    ref=[act("add_to", kind="task", name="Buy Jalen new cleats", args=lines(to="$school_l"))]))

S("T08-056", "remove_from task named add_to note where undo link",
  T("take Pay union dues off the union list", diff(unlink("union_l", "union_dues")),
    ref=[act("remove_from", kind="task", name="Pay union dues", args=lines(from_="$union_l"))]),
  T("the note about lemon pepper, move it to the reunion notebook",
    diff(link("reunion_nb", "wings"), unlink("recipes_nb", "wings")),
    ref=[act("add_to", kind="note", where='body contains "lemon pepper"', args=lines(to="$reunion_nb"))]),
  T("nah undo that move", diff(link("recipes_nb", "wings"), unlink("reunion_nb", "wings")),
    ref=[act("undo")]))

S("T08-057", "delete person where restore named delete",
  T("delete the dentist from my contacts, we switched offices", diff(trash("dr_shah")),
    ref=[act("delete", kind="person", where='role = "dentist"')]),
  T("are the dentist appointments on", rows("dentist_jalen", "dentist_jada"),
    ref=[ans(kind="event", name="Dentist appointment")]),
  T("ok actually put the dentist back", diff(restore("dr_shah")),
    ref=[act("restore", kind="person", where='role = "dentist"', trashed=True)]),
  T("and delete Gloria Nunez, new property manager", diff(trash("gloria")),
    ref=[act("delete", kind="person", name="Gloria Nunez")]),
  T("was she on any of my tasks", rows("dishwasher"),
    ref=[ans(kind="task", linked_to="$gloria")]))

S("T08-058", "delete person where ambiguous bulk",
  T("delete the carpool dads from my contacts", diff(trash("brandon"), trash("omar")),
    ref=[act("delete", kind="person", where='role = "carpool dad"'),
         act("delete", rows="$brandon, $omar")]),
  T("and whoever i have down as property manager", diff(trash("gloria")),
    ref=[act("delete", kind="person", where='role = "property manager"')]))

S("T08-059", "ambiguous dentist reschedule edit prev reschedule named",
  T("move the dentist appointment to 4", ask("dentist_jalen", "dentist_jada"),
    ref=[act("reschedule", kind="event", name="Dentist appointment", args=lines(to=U("day", 0, anchor="row", time="16:00"))),
         find(kind="event", name="Dentist appointment"),
         askc("jalen's on thursday or jada's on the 23rd?", options="$dentist_jalen, $dentist_jada")]),
  T("jalen's thursday", diff(upd("dentist_jalen", date="2026-04-09T16:00")),
    ref=[act("reschedule", rows="$dentist_jalen", args=lines(to=U("day", 0, anchor="row", time="16:00")))]),
  T("when's coffee with darnell", rows("coffee_darnell"),
    ref=[ans(kind="event", name="Coffee with Darnell")]),
  T("put on it: bring the march schedule printouts", diff(upd("coffee_darnell", description="bring the march schedule printouts")),
    ref=[act("edit", rows="@prev", args=lines(description="bring the march schedule printouts"))]),
  T("and push the Pavilion walkthrough in Macon to 1pm", diff(upd("walkthrough", date="2026-04-18T13:00")),
    ref=[act("reschedule", kind="event", name="Pavilion walkthrough in Macon", args=lines(to=U("day", 0, anchor="row", time="13:00")))]))

S("T08-060", "boosters group balance settle debt undo",
  T("who's in eagles boosters", rows("marcus_h", "quanisha", "coach_t", "tasha", "me"),
    ref=[ans(kind="person", linked_to="$boosters")]),
  T("where am i at in it money wise", val((93.8, "USD")),
    ref=[ans(op="balance", kind="group", name="Eagles boosters", linked_to="$me")]),
  T("settle up with quanisha dawson", diff(settle=[("Quanisha Dawson", "30.6")]),
    ref=[act("settle_up", rows="$quanisha", args=lines(group="$boosters"))]),
  T("she owes me the raffle cash too right", rows("d_quanisha"),
    ref=[ans(kind="debt", linked_to="$quanisha")]),
  T("mark that one paid", diff(upd("d_quanisha", status="settled")),
    ref=[act("settle_debt", rows="@prev")]),
  T("when's the next boosters meeting", rows("boost_0413"),
    ref=[ans(kind="event", name="Boosters meeting", when=W({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T08-061", "compute max group direction",
  T("biggest open debt each way, owed to me vs what i owe", vgroups({"owes_me": (210, "USD"), "i_owe": (300, "USD")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"), ans(value="@prev")]))

S("T08-062", "compute min group status",
  T("smallest debt, open vs settled", vgroups({"open": (12, "USD"), "settled": (40, "USD")}),
    ref=[comp(op="min", field="amount", kind="debt", group="status"), ans(value="@prev")]),
  T("who's the 12 bucks from", rows("coach_t"),
    ref=[find(kind="debt", where="amount = 12"), ans(kind="person", linked_to="@prev")]))

S("T08-064", "search nickname find-only",
  T("who's keisha again", rows("keisha"),
    ref=[search("Keisha", kind="person"), ans(rows="@prev")]),
  T("what's her balance in carter reunion 2026", val((85, "USD")),
    ref=[ans(op="balance", kind="group", name="Carter reunion 2026", linked_to="$keisha")]))

S("T08-066", "restore undo restore",
  T("get the old pay stub back out of the trash", diff(restore("paystub")),
    ref=[act("restore", kind="document", name="Old pay stub", trashed=True)]),
  T("never mind, undo it", diff(trash("paystub")),
    ref=[act("undo")]))

S("T08-067", "people cadence last friday log met balance settle debt",
  T("who on my every-two-weeks list haven't i talked to since before last friday",
    rows("bigmama", "dre", "keisha", "monique", "tasha"),
    ref=[ans(kind="person", where="cadence <= 14", when=W({"to": U("week", -1, weekday=5)}))]),
  T("log a call with big mama, hung up with her", diff(upd("bigmama", date=ANY)),
    ref=[act("log", rows="$bigmama", args=lines(kind="call"))]),
  T("which of them didn't i meet in macon", rows("monique", "tasha"),
    ref=[ans(kind="person", within="@prev", where='met != "Macon"')]),
  T("what's monique's balance", val((210, "USD")),
    ref=[ans(op="balance", rows="$monique")]),
  T("she sent the half of summer camp deposit, settle that", diff(upd("d_monique", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Half of summer camp deposit")]),
  T("anything else open with her", rows(),
    ref=[ans(kind="debt", linked_to="$monique", where='status = "open"')]),
  T("next kids to monique's is when", rows("handoff_0417"),
    ref=[ans(kind="event", name="Kids to Monique's", when=W({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T08-068", "event counts spans duration edit named",
  T("how many things in my diary from today to the end of may", val(40),
    ref=[ans(op="count", kind="event", when=W(span(U("day", 0), D("2026-05-31"))))]),
  T("how many of those have other people on them", val(33),
    ref=[ans(op="count", kind="event", when=W(span(U("day", 0), D("2026-05-31"))), where="person count != 0")]),
  T("which ones from next week thru may run longer than three hours", rows("epa", "car_wash", "lanier", "oncall_0424", "oncall_0508"),
    ref=[ans(kind="event", when=W(span(U("week", 1), U("month", 0, name=5))), where="duration > 180")]),
  T("put on the lake lanier fishing trip: meet at kevin's at 5", diff(upd("lanier", description="meet at kevin's at 5")),
    ref=[act("edit", kind="event", name="Lake Lanier fishing trip", args=lines(description="meet at kevin's at 5"))]),
  T("who's going on that", rows("trey", "kevin", "reggie"),
    ref=[ans(kind="person", linked_to="$lanier")]))

S("T08-069", "short event cancel prev create",
  T("anything this saturday that's 45 min or less", rows("haircut"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=6)), where="duration <= 45 minutes")]),
  T("cancel that, going to marcus's barber sunday instead", diff(upd("haircut", status="cancelled")),
    ref=[act("cancel", rows="@prev")]),
  T("add a Haircut sunday at 11", diff(new("event", name="Haircut", date="2026-04-12T11:00")),
    ref=[act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=7, time="11:00")))]),
  T("so what's sunday look like", rows("+1", "rcall_0412"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=7)))]))

S("T08-070", "boosters debt count event count reunion note count",
  T("which eagles boosters folks do i have no debts with at all", rows("marcus_h", "tasha", "me"),
    ref=[ans(kind="person", linked_to="$boosters", where="debt count <= 0")]),
  T("and which of them am i on exactly one event with", rows("tasha"),
    ref=[ans(kind="person", within="@prev", where="event count = 1")]),
  T("on the reunion committee who has exactly one note about them", rows("dre", "bev"),
    ref=[ans(kind="person", linked_to="$reunion_g", where="note count = 1")]))

S("T08-071", "group person count",
  T("any groups with more than three people", rows("boosters", "reunion_g", "carpool", "union_fund", "fishing"),
    ref=[ans(kind="group", where="person count > 3")]))

S("T08-072", "reunion effort task count priority",
  T("on the reunion list which tasks aren't an hour long", rows("invites", "menu", "slideshow"),
    ref=[ans(kind="task", linked_to="$reunion_l", where="effort != 60 minutes")]),
  T("anything on it with 2 subtasks", rows("shirts"),
    ref=[ans(kind="task", linked_to="$reunion_l", where="task count = 2")]),
  T("what's real low priority across everything, four or lower", rows("garage", "manifold", "proposal"),
    ref=[ans(kind="task", where="priority > 3")]))

S("T08-073", "in progress list count",
  T("which in progress tasks are on a list", rows("dues", "nate", "osha", "raffle"),
    ref=[ans(kind="task", where='status = "in_progress" and list count > 0')]),
  T("and the ones that aren't", rows("taxes"),
    ref=[ans(kind="task", where='status = "in_progress" and list count = 0')]))

S("T08-074", "notes spans notebook count",
  T("notes from march tenth at 9am up to last friday", rows("contract_q", "grievance_notes", "custody", "heat_pump", "jada_sizes",
                                                        "fishing_list", "carwash_plan", "shirt_notes", "prayer",
                                                        "gift_ideas", "franklin"),
    ref=[ans(kind="note", when=W(span(D("2026-03-10", "09:00"), U("week", -1, weekday=5))))]),
  T("which of those are filed in a notebook", rows("contract_q", "grievance_notes", "custody", "heat_pump", "jada_sizes",
                                                  "carwash_plan", "shirt_notes", "franklin"),
    ref=[ans(kind="note", within="@prev", where="notebook count != 0")]),
  T("anything newer, since the second at 6pm", rows("franklin"),
    ref=[ans(kind="note", when=W(span(D("2026-04-02", "18:00"), U("day", 0))))]))

S("T08-075", "documents date datetime add_to folder count",
  T("what docs did i save on april third", rows("trip_form"),
    ref=[ans(kind="document", when=W(D("2026-04-03")))]),
  T("and the one from thursday at 7pm", rows("invoice"),
    ref=[ans(kind="document", when=W(U("week", -1, weekday=4, time="19:00")))]),
  T("put that in the house folder", diff(link("house_f", "invoice")),
    ref=[act("add_to", rows="@prev", args=lines(to="$house_f"))]),
  T("docs from last tuesday to today that are in a folder", rows("trip_form", "invoice"),
    ref=[ans(kind="document", when=W(span(U("week", -1, weekday=2), U("day", 0))), where="folder count > 0")]),
  T("star them both", diff(upd("trip_form", starred=True), upd("invoice", starred=True)),
    ref=[act("star", rows="$trip_form, $invoice")]))
