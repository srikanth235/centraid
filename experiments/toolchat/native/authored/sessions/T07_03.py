from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T07-051", "holy week concert rehearsal ambiguous ask choir list",
  T("when's the holy thursday concert", rows("concert"),
    ref=[ans(kind="event", name="Holy Thursday concert")]),
  T("who's singing", rows("lucia", "rosa_c", "jaime", "carmen", "alfredo"),
    ref=[ans(kind="person", linked_to="$concert")]),
  T("move choir rehearsal to 6pm", ask(),
    ref=[act("reschedule", kind="event", name="Choir rehearsal", args=lines(to=U("day", 0, anchor="row", time="18:00"))),
         askc("which rehearsal, next wednesday's or a later one?")]),
  T("the one the day before the concert", diff(upd("reh_0401", date="2026-04-01T18:00")),
    ref=[act("reschedule", kind="event", name="Choir rehearsal", when=W(D("2026-04-01")),
             args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("move learn the alto line to the monday before", diff(upd("alto_line", date="2026-03-30")),
    ref=[act("reschedule", kind="task", name="alto line", args=lines(to=D("2026-03-30")))]),
  T("and photocopy the holy week scores is done", diff(upd("scores", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Photocopy the Holy Week scores")]),
  T("what's left on the choir list", rows("robes", "alto_line"),
    ref=[ans(kind="task", linked_to="$choir_l", where='status = "open"')]))

S("T07-052", "blight scouting cancel note body count",
  T("when's my next blight scouting", rows("scout_0316"),
    ref=[ans(kind="event", name="blight scouting", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("cancel it, efrain is doing lot 3 alone that week", diff(upd("scout_0316", status="cancelled")),
    ref=[act("cancel", rows="$scout_0316")]),
  T("what's in the blight log", rows("blight_log"),
    ref=[ans(kind="note", name="Blight log")]),
  T("add: ninth mar new lesions on lot 5 peruanita",
    diff(upd("blight_log", body="first lesions 16 Feb on the Canchan rows, sprayed 18 Feb and 2 Mar; 9 Mar new lesions on lot 5 Peruanita")),
    ref=[act("edit", rows="$blight_log",
             args=lines(body="first lesions 16 Feb on the Canchan rows, sprayed 18 Feb and 2 Mar; 9 Mar new lesions on lot 5 Peruanita"))]),
  T("which scouting rounds are cancelled", rows("scout_0316"),
    ref=[ans(kind="event", name="blight scouting", where='status = "cancelled"')]),
  T("how many are on after that", val(4),
    ref=[ans(op="count", kind="event", name="blight scouting", when=W({"from": U("day", 0)}), where='status != "cancelled"')]))

S("T07-053", "agrobanco ambiguous narrow note subtasks",
  T("move the meeting with agrobanco to 9", diff(upd("agro_0319", date="2026-03-19T09:00")),
    ref=[act("reschedule", kind="event", name="Meeting with Agrobanco", args=lines(to=U("day", 0, anchor="row", time="09:00"))),
         act("reschedule", kind="event", name="Meeting with Agrobanco", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="09:00")))]),
  T("and what did patricia say last time, the loan conditions", rows("loan_notes"),
    ref=[ans(kind="note", name="loan conditions")]),
  T("gather documents for the agrobanco loan, which bits are done", rows("agro_ruc"),
    ref=[ans(kind="task", linked_to="$agro_docs", where='status = "completed"')]),
  T("mark get bank statements done too", diff(upd("agro_bank", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Get bank statements")]),
  T("so what's left under it", rows("agro_title"),
    ref=[ans(kind="task", linked_to="$agro_docs", where='status = "open"')]))

S("T07-054", "log ambiguous rosa undo ledger",
  T("log a call with rosa", ask("rosa_m", "rosa_c"),
    ref=[act("log", kind="person", name="Rosa", args=lines(kind="call")),
         askc("rosa mamani or rosa condori?", options="$rosa_m, $rosa_c")]),
  T("mamani", diff(upd("rosa_m", date=ANY)),
    ref=[act("log", rows="$rosa_m", args=lines(kind="call"))]),
  T("when did i last see her in person", rows("rosa_m"),
    ref=[ans(rows="$rosa_m")]))

S("T07-055", "single reveal password named",
  T("what's the password for the coop laptop", diff(reveal=[("laptop_pw", "Canchan#2026")]),
    ref=[act("reveal", kind="locker item", name="coop laptop", args=lines(field="password"))]))

S("T07-056", "photo bin restore undo past window",
  T("what's in the photo trash", rows("blurry", "dup_stand", "bus_ticket"),
    ref=[ans(kind="photo", trashed=True)]),
  T("restore the duplicate of the stand photo", diff(restore("dup_stand")),
    ref=[act("restore", kind="photo", name="Duplicate of the stand photo", trashed=True)]),
  T("undo that, it really is a dupe", diff(trash("dup_stand")),
    ref=[act("undo")]),
  T("and the bus ticket screenshot, can that come back", rows("bus_ticket"),
    ref=[find(kind="photo", name="bus ticket", trashed=True), bad(act("restore", rows="@prev")), ans(rows="$bus_ticket")]))

S("T07-057", "coop dues fungicide ambiguous narrow",
  T("pay coop dues is done for march", diff(upd("dues_03", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay coop dues")]),
  T("how many dues payments since october", val(5),
    ref=[ans(op="count", kind="task", name="Pay coop dues", where='status = "completed"',
             when=W({"from": U("month", -1, name=10)}))]),
  T("buy fungicide, done this morning", diff(upd("fung_1", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Buy fungicide")]),
  T("anything else on the farm list due this week", rows("irrigation"),
    ref=[ans(kind="task", linked_to="$farm_l", when=W(U("week", 0)), where='status = "open"')]),
  T("push that to monday", diff(upd("irrigation", date="2026-03-16")),
    ref=[act("reschedule", rows="$irrigation", args=lines(to=U("week", 1, weekday=1)))]))

S("T07-058", "folder edit prev document add_to",
  T("which folders are empty", rows("tax_f"),
    ref=[find(kind="folder", where="document count = 0"), ans(rows="@prev")]),
  T("rename it Tax 2026", diff(upd("tax_f", name="Tax 2026")),
    ref=[act("edit", rows="@prev", args=lines(name="Tax 2026"))]),
  T("put the seed receipt in there", diff(link("tax_f", "seed_receipt")),
    ref=[act("add_to", kind="document", name="seed receipt", args=lines(to="$tax_f"))]))

S("T07-059", "note ambiguous seed order pin move undo link",
  T("pin the seed order note", ask("seed_2025", "seed_2026"),
    ref=[act("edit", kind="note", name="Seed order", args=lines(pinned="yes")),
         find(kind="note", name="Seed order"),
         askc("the one from last september or this month's?", options="$seed_2025, $seed_2026")]),
  T("the old one from september", diff(upd("seed_2025", pinned=True)),
    ref=[act("edit", rows="$seed_2025", args=lines(pinned="yes"))]),
  T("move it into field notes as well", diff(unlink("coop_nb", "seed_2025"), link("field_nb", "seed_2025")),
    ref=[act("add_to", rows="$seed_2025", args=lines(to="$field_nb"))]),
  T("hmm no undo that last bit", diff(link("coop_nb", "seed_2025"), unlink("field_nb", "seed_2025")),
    ref=[act("undo")]))

S("T07-061", "julio birthday reschedule edit present",
  T("julio's birthday dinner, what time is it", rows("julio_bday"),
    ref=[ans(kind="event", name="Julio's birthday dinner")]),
  T("make it 8", diff(upd("julio_bday", date="2026-03-21T20:00")),
    ref=[act("reschedule", rows="$julio_bday", args=lines(to=U("day", 0, anchor="row", time="20:00")))]),
  T("and add that carla's coming from arequipa", diff(upd("julio_bday", description="Pachapapa, San Blas; Carla coming from Arequipa")),
    ref=[act("edit", rows="$julio_bday", args=lines(description="Pachapapa, San Blas; Carla coming from Arequipa"))]),
  T("did i get his present yet", rows("julio_gift"),
    ref=[ans(kind="task", linked_to="$julio")]),
  T("what ideas did i have", rows("julio_gifts"),
    ref=[ans(kind="note", linked_to="$julio")]))

S("T07-062", "home tasks complete reopen priority",
  T("refill the gas cylinder is done", diff(upd("gas", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Refill the gas cylinder")]),
  T("and the roof, how's that one going", rows("roof"),
    ref=[ans(kind="task", name="roof")]),
  T("mark it done, gabriel fixed it tuesday", diff(upd("roof", status="completed", completed=ANY)),
    ref=[act("complete", rows="$roof")]),
  T("ugh reopen it, it leaked again last night", diff(upd("roof", status="open", completed=None)),
    ref=[act("reopen", rows="$roof")]),
  T("bump it to priority one", diff(upd("roof", priority=1)),
    ref=[act("edit", rows="$roof", args=lines(priority=1))]),
  T("what's priority one now", rows("rent_mar", "sunat", "vale_fees", "roof"),
    ref=[ans(kind="task", where='priority = 1 and status = "open"')]))

S("T07-063", "single delete person named",
  T("delete camila soto from my contacts", diff(trash("camila")),
    ref=[act("delete", kind="person", name="Camila Soto")]))

S("T07-064", "note date span create undo edit",
  T("notes since first march 9pm up to today",
    rows("seed_2026", "soil_notes", "loan_notes", "julio_gifts", "vale_courses", "prices", "mar_agenda", "hugo_qs"),
    ref=[ans(kind="note", when=W(span(D("2026-03-01", "21:00"), U("day", 0))))]),
  T("new note in field notes, Lot 5 spores: late blight spores on the leaf undersides",
    diff(new("note", name="Lot 5 spores", body=has("undersides")), link("field_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Lot 5 spores", body="late blight spores on the leaf undersides",
                                  notebook="$field_nb"))]),
  T("undo, i'll put it in the blight log", diff(trash("+1")),
    ref=[act("undo")]),
  T("ok add it to the blight log",
    diff(upd("blight_log", body="first lesions 16 Feb on the Canchan rows, sprayed 18 Feb and 2 Mar; late blight spores on the leaf undersides, lot 5")),
    ref=[find(kind="note", name="Blight log"), opn("$blight_log"),
         act("edit", rows="$blight_log",
             args=lines(body="first lesions 16 Feb on the Canchan rows, sprayed 18 Feb and 2 Mar; late blight spores on the leaf undersides, lot 5"))]))

S("T07-065", "debt span within sum settle multi",
  T("show debts that start in last month and run until last sunday",
    rows("d_rosa", "d_jaime", "d_carmen", "d_wilber", "d_nilda", "d_teodoro", "d_lucia", "d_hugo"),
    ref=[ans(kind="debt", when=W(span(U("month", -1), U("week", -1, weekday=7))))]),
  T("the open ones i owe", rows("d_wilber", "d_lucia", "d_hugo"),
    ref=[ans(kind="debt", within="@prev", where='direction = "i_owe" and status = "open"')]),
  T("settle lucia's and wilber's", diff(upd("d_lucia", status="settled"), upd("d_wilber", status="settled")),
    ref=[act("settle_debt", more=True, kind="debt", linked_to="$lucia", where='status = "open"'),
         act("settle_debt", kind="debt", linked_to="$wilber", where='status = "open"')]),
  T("how's my total left to pay", val((580, "PEN")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T07-067", "misspelled search recover log tasks reschedule",
  T("when did i last see efrain cahuana", rows("efrain"),
    ref=[ans(kind="person", name="Cahuana"), search("cahuana", kind="person"), ans(rows="$efrain")]),
  T("log a visit, he dropped by", diff(upd("efrain", date=ANY)),
    ref=[act("log", rows="$efrain", args=lines(kind="visit"))]),
  T("what tasks is he on", rows("irrigation", "scout_report"),
    ref=[ans(kind="task", linked_to="$efrain")]),
  T("the scouting report, push it by three days", diff(upd("scout_report", date="2026-03-19")),
    ref=[act("reschedule", rows="$scout_report", args=lines(to=U("day", 3, anchor="row")))]),
  T("who haven't i heard from since before february", rows("fortunata", "ana", "raul"),
    ref=[ans(kind="person", when=W({"to": U("month", -2)}))]))

S("T07-068", "reveal where api key star where",
  T("read me the code i saved as a secure note, the padlock one", diff(reveal=[("padlock", "2718")]),
    ref=[act("reveal", kind="locker item", where='type = "note"', args=lines(field="content"))]),
  T("and star the ssh key while you're there", diff(upd("station_ssh", starred=True)),
    ref=[act("star", kind="locker item", where='type = "ssh_key"')]))

S("T07-069", "valeria budget note laptop group settle",
  T("what's in valeria's budget note", rows("vale_budget"),
    ref=[ans(kind="note", linked_to="$valeria", name="budget")]),
  T("change food to 550", diff(upd("vale_budget", body="room 650, food 550, bus 120, books 80")),
    ref=[act("edit", rows="$vale_budget", args=lines(body="room 650, food 550, bus 120, books 80"))]),
  T("look for a laptop for valeria, give it the thirty-first as a due date", diff(upd("vale_laptop", date="2026-03-31")),
    ref=[act("reschedule", kind="task", name="Look for a laptop for Valeria", args=lines(to=D("2026-03-31")))]),
  T("and priority two", diff(upd("vale_laptop", priority=2)),
    ref=[act("edit", rows="$vale_laptop", args=lines(priority=2))]),
  T("where's julio at in the lima costs group", val((-170, "PEN")),
    ref=[ans(op="balance", kind="group", name="Valeria's Lima costs", linked_to="$julio")]),
  T("settle up with him there", diff(settle=[("Julio Huaman", "170")]),
    ref=[act("settle_up", rows="$julio", args=lines(group="$family_g"))]),
  T("wait undo that, he said he'd pay it into my account instead", diff(),
    ref=[act("undo")]))

S("T07-070", "notes linked_to all rename",
  T("notes linked to both sonia and the coop notebook", rows("seed_2025"),
    ref=[ans(kind="note", linked_to="$sonia, $coop_nb")]),
  T("rename it Seed order 2025", diff(upd("seed_2025", name="Seed order 2025")),
    ref=[act("edit", rows="$seed_2025", args=lines(name="Seed order 2025"))]),
  T("and call the other seed order note Seed order 2026", diff(upd("seed_2026", name="Seed order 2026")),
    ref=[act("edit", kind="note", name="Seed order", exclude="$seed_2025", args=lines(name="Seed order 2026"))]),
  T("how many notes in field notes", val(6),
    ref=[ans(op="count", kind="note", linked_to="$field_nb")]))

S("T07-071", "mass cancel already palm sunday",
  T("is there mass with the choir this sunday", rows("mass_0315"),
    ref=[ans(kind="event", name="Sunday mass", when=W(U("week", 0)))]),
  T("cancel it, padre alfredo is away", diff(upd("mass_0315", status="cancelled")),
    ref=[act("cancel", rows="$mass_0315")]),
  T("did that go through? cancel it", diff(already=["mass_0315"]),
    ref=[act("cancel", rows="$mass_0315"), ans(rows="$mass_0315")]),
  T("when's the palm sunday procession", rows("palm"),
    ref=[ans(kind="event", name="Palm Sunday procession")]),
  T("who's on it", rows("alfredo"),
    ref=[ans(kind="person", linked_to="$palm")]))

S("T07-072", "farm effort not equal reschedule",
  T("farm list tasks that aren't thirty min jobs", rows("scout_report", "trial_data", "irrigation", "storehouse"),
    ref=[ans(kind="task", linked_to="$farm_l", where="effort != 30 and effort != 0")]),
  T("move trial data entry to next friday", diff(upd("trial_data", date="2026-03-20")),
    ref=[act("reschedule", kind="task", name="trial data", args=lines(to=U("week", 1, weekday=5)))]))

S("T07-073", "expo tasks multi reschedule overlap repair edit",
  T("when is expo papa lima", rows("expo"),
    ref=[ans(kind="event", name="Expo Papa Lima")]),
  T("anything open for the expo", rows("expo_samples"),
    ref=[ans(kind="task", name="Expo", where='status = "open"')]),
  T("that and printing the coop banner, put both on next thursday", diff(upd("expo_samples", date="2026-03-19"), upd("expo_banner", date="2026-03-19")),
    ref=[act("reschedule", rows="$expo_samples, $expo_banner", args=lines(to=U("week", 1, weekday=4)))]),
  T("who's coming with me to the expo", rows("marco", "teodoro"),
    ref=[ans(kind="person", linked_to="$expo")]),
  T("book a stand meeting with marco friday twenty-seventh at 3pm", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Stand meeting with Marco", date=D("2026-03-27", "15:00")))),
         askc("friday the 27th is inside the expo itself on your calendar. put it in the expo's notes instead?")]),
  T("yes, make the expo description stand 14, pavilion B, meet marco fri 27 at 3pm", diff(upd("expo", description="stand 14, pavilion B; meet Marco Fri 27 at 3pm")),
    ref=[act("edit", rows="$expo", args=lines(description="stand 14, pavilion B; meet Marco Fri 27 at 3pm"))]))

S("T07-074", "starred people edit multi unstar",
  T("who have i starred", rows("julio", "valeria", "teodoro", "hugo"),
    ref=[ans(kind="person", where="starred = yes")]),
  T("set rosa condori and jaime to every two weeks", diff(upd("rosa_c", cadence=14), upd("jaime", cadence=14)),
    ref=[act("edit", rows="$rosa_c, $jaime", args=lines(cadence=14))]),
  T("unstar hugo", diff(upd("hugo", starred=False)),
    ref=[act("unstar", rows="$hugo")]),
  T("delete the coop assembly", ask(),
    ref=[act("delete", kind="event", name="Coop assembly"),
         askc("which assembly do you mean, a past one or saturday's or april's?")]))

S("T07-075", "events from datetime count add_to undo link",
  T("how many things are booked from friday 6pm on", val(40),
    ref=[ans(op="count", kind="event", when=W({"from": U("week", 0, weekday=5, time="18:00")}))]),
  T("add the hugo email task to the coop list", diff(link("coop_l", "hugo_email")),
    ref=[act("add_to", kind="task", name="Email Hugo", args=lines(to="$coop_l"))]),
  T("no undo, it's farm stuff", diff(unlink("coop_l", "hugo_email")),
    ref=[act("undo")]))
