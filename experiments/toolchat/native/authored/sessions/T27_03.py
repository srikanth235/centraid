from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T27-051", "five turns person date met in camille ambiguous resolved log balance",
  T("who did i talk to on first december", rows("nadia", "hugo"),
    ref=[ans(kind="person", when=W(D("2026-12-01")))]),
  T("and on the twenty-fourth of november", rows("camille_p", "margaux", "olivier"),
    ref=[ans(kind="person", when=W(D("2026-11-24")))]),
  T("which of those did i meet in lyon or at the prenatal class", rows("camille_p", "margaux"),
    ref=[ans(within="@prev", where='met in ("Lyon", "prenatal class")')]),
  T("log a coffee with camille, saw her at the market", diff(upd("camille_p", date=ANY)),
    ref=[act("log", kind="person", name="Camille", args=lines(kind="coffee")),
         act("log", rows="$camille_p", args=lines(kind="coffee"))]),
  T("does she owe me anything", val((10, "EUR")),
    ref=[comp(op="balance", rows="$camille_p"), ans(value="@prev")]))

S("T27-052", "five turns person named month span cadence log",
  T("who did i last talk to back in october", rows("claire", "karim"),
    ref=[ans(kind="person", when=W(U("month", 0, name=10)))]),
  T("claire's meant to be every month isn't she", rows("claire"),
    ref=[ans(kind="person", name="Claire Moreau", where="cadence = 30")]),
  T("note it, i rang her", diff(upd("claire", date=ANY)),
    ref=[act("log", rows="$claire", args=lines(kind="call"))]),
  T("who else from october up to tenth november", rows("karim", "odette", "matthieu"),
    ref=[ans(kind="person", when=W(span(U("month", 0, name=10), D("2026-11-10"))))]),
  T("any of them with a check-in rhythm", rows("odette"),
    ref=[ans(within="@prev", where="cadence is set")]),
  T("when was the cake tasting with karim", decline("not_found"),
    ref=[find(kind="event", name="Cake tasting"), dec("not_found")]))

S("T27-053", "person span weekday datetime role empty open edit",
  T("who have i been in touch with from last friday up to tuesday lunchtime",
    rows("antoine", "ines", "lea", "aurelie", "helene", "thomas_g", "nadia", "hugo"),
    ref=[ans(kind="person", when=W(span(U("week", -1, weekday=5), U("week", 0, weekday=2, time="12:00"))))]),
  T("any of them with no role on file", rows("aurelie"),
    ref=[ans(within="@prev", where="role is empty")]),
  T("what have i got on aurélie", rows("aurelie"),
    ref=[opn("$aurelie"), ans(rows="$aurelie")]),
  T("put her down as neighbour", diff(upd("aurelie", role="neighbour")),
    ref=[act("edit", rows="$aurelie", args=lines(role="neighbour"))]))

S("T27-054", "person span this week thomas ambiguous resolved star document",
  T("who've i spoken to since monday, up to 6pm yesterday", rows("thomas_g", "nadia", "hugo", "camille_r"),
    ref=[ans(kind="person", when=W(span(U("week", 0, weekday=1), U("day", -1, time="18:00"))))]),
  T("star thomas, he's been great with the deliveries", diff(upd("thomas_g", starred=True)),
    ref=[act("star", kind="person", name="Thomas"),
         act("star", rows="$thomas_g")]),
  T("and star his flour contract doc too", diff(upd("flour_contract", starred=True)),
    ref=[act("star", kind="document", name="Flour contract"), search("contract", kind="document"),
         act("star", rows="$flour_contract")]))

S("T27-055", "seven turns person month span cadence debts sum settle undo ledger",
  T("who did i catch up with between november first and the twentieth that i'm meant to keep up with",
    rows("odette", "sandrine", "sarah", "chloe"),
    ref=[ans(kind="person", when=W(span(U("month", 0, name=11), D("2026-11-20"))), where="cadence is set")]),
  T("out of them, who's got a debt with me", rows("sarah", "chloe"),
    ref=[ans(within="@prev", where="debt count > 0")]),
  T("chloé's open ones", rows("d_chloe", "d_chloe2"),
    ref=[ans(kind="debt", linked_to="$chloe", where='status = "open"')]),
  T("how much is that together", val((70, "EUR")),
    ref=[comp(op="sum", field="amount", rows="@prev"), ans(value="@prev")]),
  T("settle Concert tickets, she paid me back", diff(upd("d_chloe", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Concert tickets")]),
  T("wait no undo, it was the flowers she paid", diff(),
    ref=[act("undo")]),
  T("then settle Flowers for Mamie", diff(upd("d_chloe2", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Flowers for Mamie")]))

S("T27-056", "person month cadence weekly log nickname search undo ledger",
  T("anyone i talked to in november that i'm supposed to call weekly", rows("helene", "lea"),
    ref=[ans(kind="person", when=W(U("month", -1, name=11)), where="cadence = 7")]),
  T("log a call with maman", diff(upd("helene", date=ANY)),
    ref=[search("maman", kind="person"), act("log", rows="$helene", args=lines(kind="call"))]),
  T("and a message to léa dubois", diff(upd("lea", date=ANY)),
    ref=[act("log", rows="$lea", args=lines(kind="message"))]),
  T("undo the léa one, it didn't send", diff(),
    ref=[act("undo")]))

S("T27-057", "five turns met in photo count thomas ambiguous ask log",
  T("who do i know from paris or annecy", rows("helene", "bernard", "lea", "antoine", "chloe", "maxime"),
    ref=[ans(kind="person", where='met in ("Paris", "Annecy")')]),
  T("which of them turn up in exactly two photos", rows("lea"),
    ref=[ans(within="@prev", where="photo count = 2")]),
  T("what are they", rows("p_xmas", "p_lea"),
    ref=[ans(kind="photo", linked_to="$lea")]),
  T("log a call with thomas", ask("thomas_m", "thomas_g"),
    ref=[act("log", kind="person", name="Thomas", args=lines(kind="call")),
         askc("thomas moreau or thomas girard?", options="$thomas_m, $thomas_g")]),
  T("the miller", diff(upd("thomas_g", date=ANY)),
    ref=[act("log", rows="$thomas_g", args=lines(kind="call"))]))

S("T27-058", "prenatal photo count linked_to all star photo",
  T("who from the prenatal group is only in one photo", rows("camille_p", "margaux", "sarah", "yasmine"),
    ref=[ans(kind="person", linked_to="$prenatal_g", where="photo count = 1")]),
  T("is that the same photo for all of them", rows("p_class"),
    ref=[ans(kind="photo", linked_to="@prev")]),
  T("star it", diff(upd("p_class", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T27-059", "prenatal event count add_to event refused ask never mind",
  T("who in the prenatal group isn't down for any events", rows("sarah", "yasmine", "me"),
    ref=[ans(kind="person", linked_to="$prenatal_g", where="event count <= 0")]),
  T("put sarah on the birth preparation workshop", ask(),
    ref=[bad(act("add_to", rows="$sarah", args=lines(to="$workshop"))),
         askc("people only go into groups here, i can't add her to the workshop itself. add her to the workshop description instead?")]),
  T("no worries i'll tell her", decline("never_mind"),
    ref=[dec("never_mind")]))


S("T27-060", "five turns event count cadence log create task reschedule new",
  T("people i'm supposed to keep up with who are on at most one event", rows("bernard", "sarah"),
    ref=[ans(kind="person", where="event count <= 1 and cadence is set")]),
  T("log a call with bernard, papa rang last night", diff(upd("bernard", date=ANY)),
    ref=[act("log", rows="$bernard", args=lines(kind="call"))]),
  T("add a task Call Papa back for sunday", diff(new("task", name="Call Papa back", date="2026-12-06")),
    ref=[act("create", args=lines(kind="task", name="Call Papa back", date=U("week", 0, weekday=7)))]),
  T("what's due sunday now", rows("call_mamie", "website", "+1"),
    ref=[ans(kind="task", when=W(U("week", 0, weekday=7)))]),
  T("move the papa one to saturday", diff(upd("+1", date="2026-12-05")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 0, weekday=6)))]))

S("T27-061", "single event status empty",
  T("are there events with no status at all", rows(),
    ref=[ans(kind="event", where="status is empty")]))

S("T27-062", "five turns status empty next week person count complete event bad ask never mind",
  T("anything next week missing a status", rows(),
    ref=[ans(kind="event", when=W(U("week", 1)), where="status is empty")]),
  T("ok what's on next week",
    rows("bake_1207", "oven_check", "class_1208", "hygiene", "midwife_dec", "soft_open", "flour_2", "partners_1211",
         "opening", "workshop"),
    ref=[ans(kind="event", when=W(U("week", 1)))]),
  T("which of those have five or more people on them", rows("soft_open", "opening"),
    ref=[ans(within="@prev", where="person count >= 5")]),
  T("mark the hygiene inspection done once it's passed", ask(),
    ref=[bad(act("complete", kind="event", name="Hygiene inspection")),
         askc("events can't be marked done, only cancelled or deleted. want a task to follow up instead?")]),
  T("nah leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T27-063", "event open start datetime person count duration empty lease",
  T("what did i have before sixteenth october 9am with at least two people",
    rows("class_1006", "class_1013", "morpho", "lease_sign"),
    ref=[ans(kind="event", when=W({"to": D("2026-10-16", "09:00")}), where="person count >= 2")]),
  T("any events with no duration set", rows(),
    ref=[ans(kind="event", where="duration is empty")]),
  T("when did i sign the shop lease", rows("lease_sign"),
    ref=[ans(kind="event", name="Sign the shop lease")]),
  T("who was there", rows("karim", "camille_r"),
    ref=[ans(kind="person", linked_to="$lease_sign")]))

S("T27-064", "event open start datetime search doc star",
  T("anything before tenth october at noon", rows("class_1006", "morpho"),
    ref=[ans(kind="event", when=W({"to": D("2026-10-10", "12:00")}))]),
  T("is there a report for the morphology scan", rows("morpho_rep"),
    ref=[find(kind="document", name="Morphology report"), search("morphology", kind="document"), ans(rows="$morpho_rep")]),
  T("star it", diff(upd("morpho_rep", starred=True)),
    ref=[act("star", rows="$morpho_rep")]),
  T("set up a follow-up with dr blanc", ask(),
    ref=[askc("sure, which day and time for the follow-up?")]))

S("T27-065", "five turns prenatal class month open end count delete undo delete",
  T("prenatal classes up to the end of october", rows("class_1006", "class_1013", "class_1020", "class_1027"),
    ref=[ans(kind="event", name="Prenatal class", when=W({"to": U("month", 0, name=10)}))]),
  T("how many left from today", val(8),
    ref=[ans(op="count", kind="event", name="Prenatal class", when=W({"from": U("day", 0)}))]),
  T("the one on tenth november got called off right", rows("class_1110"),
    ref=[ans(kind="event", name="Prenatal class", when=W(D("2026-11-10")), where='status = "cancelled"')]),
  T("delete it then", diff(trash("class_1110")),
    ref=[act("delete", rows="@prev")]),
  T("hmm undo, i want the record", diff(restore("class_1110")),
    ref=[act("undo")]))

S("T27-066", "five turns events through october claire visit count restore window ask",
  T("everything i had through october",
    rows("class_1006", "class_1013", "class_1020", "class_1027", "morpho", "lease_sign", "claire_visit", "partners_1030"),
    ref=[ans(kind="event", when=W({"to": U("month", 0, name=10)}))]),
  T("claire visiting, who came to that", rows("claire", "julien"),
    ref=[ans(kind="person", linked_to="$claire_visit")]),
  T("how many events is julien on in total", val(10),
    ref=[ans(op="count", kind="event", linked_to="$julien")]),
  T("restore the Old flat handover, i need the date for the deposit", ask(),
    ref=[bad(act("restore", kind="event", name="Old flat handover", trashed=True)),
         askc("the old flat handover was binned on 1 october, too long ago to restore. it was on 30 september at 10, want it added back?")]),
  T("no that's all i needed", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T27-067", "event span date weekday reschedule anchor olivier note",
  T("from monday to next wednesday, give me the calendar", rows("bake_1207", "oven_check", "class_1208", "hygiene"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=3))))]),
  T("move the oven inspection to 11", diff(upd("oven_check", date="2026-12-08T11:00")),
    ref=[act("reschedule", rows="$oven_check", args=lines(to=U("day", 0, anchor="row", time="11:00")))]),
  T("anything else with olivier", rows("oven_install"),
    ref=[ans(kind="event", linked_to="$olivier", exclude="$oven_check")]),
  T("what's in my oven manual note", rows("oven_manual"),
    ref=[find(kind="note", name="Oven manual"), search("oven", kind="note"), ans(rows="$oven_manual")]))

S("T27-068", "event span tomorrow saturday partners ambiguous resolved cancel",
  T("tomorrow through saturday, what've i got", rows("flour_1", "butter_del", "partners_1204", "photoshoot"),
    ref=[ans(kind="event", when=W(span(U("day", 1), U("week", 0, weekday=6))))]),
  T("cancel the partners meeting, camille's got the flu", diff(upd("partners_1204", status="cancelled")),
    ref=[act("cancel", kind="event", name="Partners meeting"),
         act("cancel", rows="$partners_1204")]),
  T("who needs telling", rows("camille_r", "antoine"),
    ref=[ans(kind="person", linked_to="$partners_1204")]))

S("T27-069", "five turns event span datetime midwife reschedule overlap bad ask create",
  T("what's between next thursday 9am and next saturday noon",
    rows("midwife_dec", "soft_open", "flour_2", "partners_1211", "opening"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=4, time="09:00"), U("week", 1, weekday=6, time="12:00"))))]),
  T("the midwife appointment, where is it", rows("midwife_dec"),
    ref=[ans(rows="$midwife_dec")]),
  T("push it to 11:30", diff(upd("midwife_dec", date="2026-12-10T11:30")),
    ref=[act("reschedule", rows="$midwife_dec", args=lines(to=U("day", 0, anchor="row", time="11:30")))]),
  T("add Scan debrief with Julien on the seventeenth at 10", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Scan debrief with Julien", date=D("2026-12-17", "10:00")))),
         askc("the third trimester scan runs 9:30 to 10:30 that morning. put the debrief at 10:30?")]),
  T("yes 10:30", diff(new("event", name="Scan debrief with Julien", date="2026-12-17T10:30")),
    ref=[act("create", args=lines(kind="event", name="Scan debrief with Julien", date=D("2026-12-17", "10:30")))]))

S("T27-070", "five turns task span today sunday complete multi insurer ambiguous reschedule",
  T("tasks due between today and sunday",
    rows("butter_conf", "vitamins", "glass", "insurer_1", "bags", "choc", "boiler", "rent_12", "website", "call_mamie"),
    ref=[ans(kind="task", when=W(span(U("day", 0), U("week", 0, weekday=7))))]),
  T("tick off the glass recycling and the vitamins", diff(upd("glass", status="completed", completed=ANY),
                                                         upd("vitamins", status="completed", completed=ANY)),
    ref=[act("complete", rows="$glass, $vitamins")]),
  T("call the insurer, done that too", diff(upd("insurer_1", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Call the insurer"),
         act("complete", rows="$insurer_1")]),
  T("push order paper bags and boxes to monday", diff(upd("bags", date="2026-12-07")),
    ref=[act("reschedule", rows="$bags", args=lines(to=U("week", 1, weekday=1)))]),
  T("what's open for today", rows("butter_conf"),
    ref=[ans(kind="task", when=W(U("day", 0)), where='status = "open"')]))

S("T27-071", "task list span shop rent ambiguous resolved priority set",
  T("what's on bakery admin from tomorrow to next tuesday", rows("insurer_1", "rent_12", "website", "hygiene_prep"),
    ref=[ans(kind="task", linked_to="$admin_l", when=W(span(U("day", 1), U("week", 1, weekday=2))))]),
  T("pay the shop rent, paid it last night", diff(upd("rent_12", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay the shop rent"),
         act("complete", rows="$rent_12")]),
  T("which admin tasks have a priority on them", rows("insurer_1", "vat", "hygiene_prep", "website"),
    ref=[ans(kind="task", linked_to="$admin_l", where="priority is set")]))

S("T27-072", "task open end from next week priority set empty person",
  T("baby list stuff due from next week on", rows("crib", "hosp_bag", "leave", "creche"),
    ref=[ans(kind="task", linked_to="$baby_l", when=W({"from": U("week", 1)}))]),
  T("which of those have a priority", rows("leave", "creche"),
    ref=[ans(within="@prev", where="priority is set")]),
  T("anyone attached to register for the crèche", rows(),
    ref=[ans(kind="person", linked_to="$creche")]))

S("T27-073", "task open end next month reschedule",
  T("anything due from january onwards", rows("hosp_bag", "passport"),
    ref=[ans(kind="task", when=W({"from": U("month", 1)}))]),
  T("move renew my passport to first february", diff(upd("passport", date="2027-02-01")),
    ref=[act("reschedule", rows="$passport", args=lines(to=D("2027-02-01")))]),
  T("and tick off order flour, did it on the portal", diff(upd("flour_b", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Order flour"),
         act("complete", kind="task", name="Order flour", where='status = "open"')]))

S("T27-074", "effort refused unit repair open reschedule undo field",
  T("what tasks would run past two hours of work", rows("bake_night", "crib", "nursery"),
    ref=[bad(ans(kind="task", where="effort > 2 hours")),
         ans(kind="task", where="effort > 120 minutes")]),
  T("which of those are open", rows("bake_night", "crib"),
    ref=[ans(within="@prev", where='status = "open"')]),
  T("move assemble the crib to the thirteenth, julien's off that sunday", diff(upd("crib", date="2026-12-13")),
    ref=[act("reschedule", rows="$crib", args=lines(to=D("2026-12-13")))]),
  T("undo, he's working after all", diff(upd("crib", date="2026-12-20")),
    ref=[act("undo")]))

S("T27-075", "effort unit list flyers people add_to task person refused ask",
  T("anything on the opening day list that's over an hour of work", rows("menu_boards", "flyers"),
    ref=[ans(kind="task", linked_to="$open_l", where="effort > 60 minutes")]),
  T("hand out flyers on rue d'austerlitz, who's doing that", rows("hugo", "ines"),
    ref=[ans(kind="person", linked_to="$flyers")]),
  T("add nadia to it", ask(),
    ref=[bad(act("add_to", rows="$nadia", args=lines(to="$flyers"))),
         askc("people can't be attached to tasks from here. want me to put nadia in the task description instead?")]))
