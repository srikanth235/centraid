from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T04-076", "tasks weekday span priority reschedule weekday time create date time edit new",
  T("what's due from next monday to the end of the month",
    rows("sashes", "audit", "audit_slides", "tesco", "rsvps", "favours", "mehndi_outfit", "speech_photos",
         "teaching_prep", "hp5", "loan_10"),
    ref=[ans(kind="task", when=W({"from": U("week", 1, weekday=1), "to": U("month", 0)}))]),
  T("which of them are priority three", rows("sashes", "favours"),
    ref=[ans(kind="task", within="@prev", where="priority = 3")]),
  T("push make audit slides to next monday 9am", diff(upd("audit_slides", date="2026-10-19T09:00")),
    ref=[act("reschedule", kind="task", name="Make audit slides", args=lines(to=U("week", 1, weekday=1, time="09:00")))]),
  T("add a task, hand in the rota swap form, due fri sixteenth at 5pm",
    diff(new("task", name=has("rota swap form"), date="2026-10-16T17:00")),
    ref=[act("create", args=lines(kind="task", name="Hand in the rota swap form", date=D("2026-10-16", "17:00")))]),
  T("make that priority two", diff(upd("+1", priority=2)),
    ref=[act("edit", rows="$new", args=lines(priority=2))]))

S("T04-077", "tasks trashed restore prev list count add_to where",
  T("what tasks did i throw out", rows("gym_sign", "return_parcel"),
    ref=[ans(kind="task", trashed=True)]),
  T("restore both", diff(restore("gym_sign"), restore("return_parcel")),
    ref=[act("restore", rows="@prev")]),
  T("which open ones with an effort estimate aren't on any list", rows("develop", "light_seal"),
    ref=[ans(kind="task", where='list count = 0 and status = "open" and effort is set')]),
  T("put the one for owen on the house list, the tank's in our bathroom", diff(link("houselist", "develop")),
    ref=[act("add_to", kind="task", linked_to="$owen", args=lines(to="$houselist"))]))

S("T04-078", "find trashed task restore prev reschedule",
  T("did i delete return the asos parcel", rows("return_parcel"),
    ref=[find(kind="task", name="Return the ASOS parcel", trashed=True), ans(rows="@prev")]),
  T("get it back", diff(restore("return_parcel")),
    ref=[act("restore", rows="@prev")]),
  T("return the asos parcel due this saturday", diff(upd("return_parcel", date="2026-10-17")),
    ref=[act("reschedule", rows="$return_parcel", args=lines(to=U("week", 0, weekday=6)))]))

S("T04-079", "task description status set add_to where multi",
  T("which tasks mention ellie", rows("rota_swap"),
    ref=[ans(kind="task", where='description contains "Ellie"')]),
  T("how many tasks have i got altogether, any status", val(60),
    ref=[ans(op="count", kind="task", where="status is set")]),
  T("put the task for nasreen on the wedding prep list, it's about guests", diff(link("wedlist", "call_nasreen")),
    ref=[act("add_to", kind="task", linked_to="$nasreen", args=lines(to="$wedlist"))]))

S("T04-080", "tasks priority span weekday month reschedule weekday time create date time",
  T("what's priority two from next monday through november", rows("cbd", "rent_nov", "loan_10", "car_ins"),
    ref=[ans(kind="task", when=W({"from": U("week", 1, weekday=1), "to": U("month", 0, name=11)}), where="priority = 2")]),
  T("push renew car insurance to next tuesday at 10", diff(upd("car_ins", date="2026-10-20T10:00")),
    ref=[act("reschedule", kind="task", name="Renew car insurance", args=lines(to=U("week", 1, weekday=2, time="10:00")))]),
  T("and add ring the dentist for the fifteenth at 8am", diff(new("task", name=has("dentist"), date="2026-10-15T08:00")),
    ref=[act("create", args=lines(kind="task", name="Ring the dentist", date=D("2026-10-15", "08:00")))]))

S("T04-081", "tasks weekday span create edit new",
  T("what's due from this saturday to the end of next week",
    rows("tins", "fb_rota", "call_nasreen", "sashes", "audit", "audit_slides", "tesco", "rsvps"),
    ref=[ans(kind="task", when=W({"from": U("week", 0, weekday=6), "to": U("week", 1)}))]),
  T("add buy a card for ammi and abbu's anniversary, due next fri", diff(new("task", name=has("card"), date="2026-10-23")),
    ref=[act("create", args=lines(kind="task", name="Buy anniversary card for Ammi and Abbu", date=U("week", 1, weekday=5)))]),
  T("give it a note, the one with the roses from paperchase", diff(upd("+1", description="the one with the roses from Paperchase")),
    ref=[act("edit", rows="$new", args=lines(description="the one with the roses from Paperchase"))]))

S("T04-082", "person edit where nickname in since named month star",
  T("set kev's catch up to every 90 days", diff(upd("kev", cadence=90)),
    ref=[act("edit", kind="person", where='nickname = "Kev"', args=lines(cadence=90))]),
  T("who've i got down as ammi or abbu", rows("mum", "dad"),
    ref=[ans(kind="person", where='nickname in ("Ammi", "Abbu")')]),
  T("which of them have i spoken to since october started", rows("mum", "dad"),
    ref=[ans(kind="person", within="@prev", when=W({"from": U("month", 0, name=10)}))]),
  T("star tariq rahman", diff(upd("dad", starred=True)),
    ref=[act("star", rows="$dad")]))

S("T04-083", "person edit where nickname in task count",
  T("give my dentist the nickname Dr S", diff(upd("sharma", nickname="Dr S")),
    ref=[act("edit", kind="person", where='role = "dentist"', args=lines(nickname="Dr S"))]),
  T("who have i got saved as ammi, abbu or kev", rows("mum", "dad", "kev"),
    ref=[ans(kind="person", where='nickname in ("Ammi", "Abbu", "Kev")')]),
  T("and who from amu has no tasks with me", rows("priya", "james", "dan", "grace"),
    ref=[ans(kind="person", where='role contains "AMU" and task count < 1')]))

S("T04-084", "person time point named month span group count edit prev",
  T("who was i messaging last night at half 9", rows("zainab"),
    ref=[ans(kind="person", when=W(U("day", -1, time="21:30")))]),
  T("who did i talk to from september up to the fifth of october",
    rows("dad", "imran", "fatima_k", "sana", "hughes", "leah", "owen"),
    ref=[ans(kind="person", when=W({"from": U("month", 0, name=9), "to": D("2026-10-05")}))]),
  T("which of those aren't in any group", rows("dad", "fatima_k", "hughes"),
    ref=[ans(kind="person", within="@prev", where="group count < 1")]),
  T("put all three on a three week catch up", diff(upd("dad", cadence=21), upd("fatima_k", cadence=21), upd("hughes", cadence=21)),
    ref=[act("edit", rows="@prev", args=lines(cadence=21))]))

S("T04-085", "person time point month open span named month date span",
  T("who was i texting at 8 this morning", rows("chloe"),
    ref=[ans(kind="person", when=W(U("day", 0, time="08:00")))]),
  T("who have i spoken to since the start of october",
    rows("mum", "dad", "zainab", "fatima_h", "sana", "chloe", "tom", "priya", "ellie", "pete"),
    ref=[ans(kind="person", when=W({"from": U("month", 0, name=10)}))]),
  T("and between the start of september and the twentieth", rows("fatima_k", "leah"),
    ref=[ans(kind="person", when=W({"from": U("month", 0, name=9), "to": D("2026-09-20")}))]))

S("T04-086", "find ambiguous event fitting describe create undo create",
  T("move the dress fitting with zainab to 3pm", ask("fitting_1", "fitting_2"),
    ref=[find(kind="event", name="Dress fitting with Zainab"),
         act("reschedule", kind="event", within="@prev", args=lines(to=U("day", 0, anchor="row", time="15:00"))),
         askc("saturday's fitting or the one on 14 nov?", options="$fitting_1, $fitting_2")]),
  T("dress fitting with zainab, saturdays", diff(upd("fitting_1", date="2026-10-17T15:00")),
    ref=[act("reschedule", rows="$fitting_1", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("who's coming to it", rows("zainab"),
    ref=[ans(kind="person", linked_to="$fitting_1")]),
  T("put bring the dupatta in the description", diff(upd("fitting_1", description="bring the dupatta")),
    ref=[act("edit", rows="$fitting_1", args=lines(description="bring the dupatta"))]),
  T("remind me to charge the camera friday at 9pm", diff(new("task", name=has("camera"), date="2026-10-16T21:00")),
    ref=[act("create", args=lines(kind="task", name="Charge the camera", date=U("week", 0, weekday=5, time="21:00")))]),
  T("undo that, i'll remember", diff(trash("+1")),
    ref=[act("undo")]),
  T("what else is due friday", rows("wul_1", "rota_swap"),
    ref=[ans(kind="task", when=W(U("week", 0, weekday=5)))]))

S("T04-087", "events tonight span description in edit where duration",
  T("anything on from 6 tonight to the end of tomorrow", rows("leah_dinner", "rota_meet", "dark_1015"),
    ref=[ans(kind="event", when=W({"from": U("day", 0, time="18:00"), "to": U("day", 1)}))]),
  T("which things are at bundobust or the photo co-op", rows("dark_0903", "dark_0917", "leah_dinner", "dark_1015", "dark_1029", "dark_1112"),
    ref=[ans(kind="event", where='description in ("Bundobust", "Leeds Photo Co-op")')]),
  T("add to the leah one: table booked under aisha", diff(upd("leah_dinner", description="Bundobust, table booked under Aisha")),
    ref=[act("edit", kind="event", linked_to="$leah", when=W(U("day", 0)),
             args=lines(description="Bundobust, table booked under Aisha"))]),
  T("what else this week isn't an hour long",
    rows("ld_1012", "ld_1013", "dark_1015", "ld_1016", "fb_1017", "fitting_1", "lunch_1018"),
    ref=[ans(kind="event", when=W(U("week", 0)), where="duration != 60 minutes", exclude="$leah_dinner")]))

S("T04-088", "events count date time span description in edit where",
  T("how many things from 7pm tomorrow to the end of next week", val(14),
    ref=[ans(op="count", kind="event", when=W({"from": U("day", 1, time="19:00"), "to": U("week", 1)}))]),
  T("anything at bundobust or on jet2 ls893", rows("leah_dinner", "flight_out"),
    ref=[ans(kind="event", where='description in ("Bundobust", "Jet2 LS893")')]),
  T("add my seat to the jet2 one, 14C", diff(upd("flight_out", description="Jet2 LS893, seat 14C")),
    ref=[act("edit", kind="event", where='description contains "Jet2"', args=lines(description="Jet2 LS893, seat 14C"))]))

S("T04-089", "events duration span overlap refused",
  T("what's on from today to thirty-first oct that's not an hour and has a place saved",
    rows("leah_dinner", "dark_1015", "fb_1017", "fb_1024", "dark_1029", "fb_1031"),
    ref=[ans(kind="event", when=W({"from": U("day", 0), "to": D("2026-10-31")}),
             where="duration != 60 minutes and description is set")]),
  T("book coffee with priya fri sixteenth at 9am", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Coffee with Priya", date=D("2026-10-16", "09:00")))),
         askc("you're on a long day on the 16th, 8 till half 8. want another day?")]))

S("T04-090", "task create undo create read",
  T("add a task renew my railcard, due the thirty-first", diff(new("task", name=has("railcard"), date="2026-10-31")),
    ref=[act("create", args=lines(kind="task", name="Renew my railcard", date=D("2026-10-31")))]),
  T("undo that, already did it online", diff(trash("+1")),
    ref=[act("undo")]),
  T("so what's actually due on the thirty-first", rows("speech_photos", "mehndi_outfit"),
    ref=[ans(kind="task", when=W(D("2026-10-31")))]))

S("T04-091", "task add_to list undo link",
  T("put buy turkish lira on the house list, chloe's got a travel card", diff(unlink("istlist", "lira"), link("houselist", "lira")),
    ref=[act("add_to", kind="task", name="Buy Turkish lira", args=lines(to="$houselist"))]),
  T("undo", diff(unlink("houselist", "lira"), link("istlist", "lira")),
    ref=[act("undo")]))

S("T04-092", "documents trashed restore multi undo restore unstar",
  T("what's in the documents trash", rows("old_cv", "old_tenancy", "gym_contract"),
    ref=[ans(kind="document", trashed=True)]),
  T("restore cv 2024 and the puregym contract", diff(restore("old_cv"), restore("gym_contract")),
    ref=[act("restore", rows="$old_cv, $gym_contract")]),
  T("hmm undo that, i don't need either", diff(trash("old_cv"), trash("gym_contract")),
    ref=[act("undo")]),
  T("and unstar the jet2 booking confirmation, flights are sorted", diff(upd("flights_doc", starred=False)),
    ref=[act("unstar", kind="document", name="Jet2 booking confirmation")]))

S("T04-093", "search miss not_found single",
  T("when's physio", decline("not_found"),
    ref=[search("physio"), dec("not_found")]))

S("T04-094", "note empty result search miss single",
  T("got any notes on asthma", decline("not_found"),
    ref=[ans(kind="note", name="Asthma"), search("asthma"), dec("not_found")]))

S("T04-095", "task empty result search recover single",
  T("is defrost the fridge on my list", rows("freezer"),
    ref=[find(kind="task", name="Defrost the fridge"), search("defrost", kind="task"), ans(rows="$freezer")]))

S("T04-096", "compute min single",
  T("what's the least i owe any one person", val((9, "GBP")),
    ref=[comp(op="min", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]))

S("T04-097", "wedding fund balance compute max balance settle_up undo ledger list",
  T("who's in the wedding fund", rows("zainab", "imran", "fatima_h", "hamza", "me"),
    ref=[ans(kind="person", linked_to="$wedding")]),
  T("where am i at in it", val((1255, "GBP")),
    ref=[ans(op="balance", kind="group", name="Wedding fund", linked_to="$me")]),
  T("what's the most i owe any one person", val((500, "GBP")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]),
  T("and my balance with imran rahman", val((275, "GBP")),
    ref=[comp(op="balance", rows="$imran"), ans(value="@prev")]),
  T("settle up with him in the wedding fund", diff(settle=["Imran Rahman"]),
    ref=[act("settle_up", rows="$imran", args=lines(group="$wedding"))]),
  T("undo that", diff(),
    ref=[act("undo")]),
  T("ok what's to do on the wedding prep list",
    rows("rsvps", "favours", "seating", "caterer_nums", "playlist"),
    ref=[ans(kind="task", linked_to="$wedlist", where='status = "open"')]))

S("T04-098", "locker membership delete trashed restore multi empty result reveal",
  T("which locker items are memberships", rows("puregym", "bma"),
    ref=[ans(kind="locker item", where='type = "membership"')]),
  T("delete the puregym one, finally cancelled", diff(trash("puregym")),
    ref=[act("delete", rows="$puregym")]),
  T("what's in the locker trash", rows("santander", "netflix", "puregym"),
    ref=[ans(kind="locker item", trashed=True)]),
  T("restore the old santander login and old netflix login, leave the gym", diff(restore("santander"), restore("netflix")),
    ref=[act("restore", rows="$santander, $netflix")]),
  T("what's the mum's wifi password", rows("wifi"),
    ref=[ans(kind="locker item", name="Mum's wifi"), ans(kind="locker item", where='type = "wifi"')]),
  T("show me house wifi", diff(reveal=[("wifi", "headingley-hotpot-9")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]))

S("T04-099", "person empty result trashed restore event linked trashed reschedule undo",
  T("who's craig", rows("craig"),
    ref=[ans(kind="person", name="Craig"), ans(kind="person", name="Craig", trashed=True)]),
  T("restore him, going back to the gym", diff(restore("craig")),
    ref=[act("restore", rows="$craig")]),
  T("was there a gym thing with him", rows("gym"),
    ref=[ans(kind="event", linked_to="$craig", trashed=True)]),
  T("restore that too", diff(restore("gym")),
    ref=[act("restore", rows="$gym")]),
  T("push it to next tuesday same time", diff(upd("gym", date="2026-10-20T10:00")),
    ref=[act("reschedule", rows="$gym", args=lines(to=U("week", 1, weekday=2, time="10:00")))]),
  T("undo, monday's fine", diff(upd("gym", date="2026-10-19T10:00")),
    ref=[act("undo")]))

S("T04-100", "notebook note count delete album edit multi album count add_to undo link",
  T("notebooks that max out at 3 notes", rows("fb_nb", "ist_nb", "old_nb"),
    ref=[ans(kind="notebook", where="note count <= 3")]),
  T("delete revision, it's empty", diff(gone("old_nb")),
    ref=[act("delete", rows="$old_nb")]),
  T("rename the darkroom prints and food bank albums both to Leeds 2026",
    diff(upd("dark_album", name="Leeds 2026"), upd("fb_album", name="Leeds 2026")),
    ref=[act("edit", rows="$dark_album, $fb_album", args=lines(name="Leeds 2026"))]),
  T("any pics that haven't been put in an album", rows("house_dinner", "ward_cake", "sunrise", "leah_selfie", "car_pic"),
    ref=[ans(kind="photo", where="album count < 1")]),
  T("put sunrise after nights in family", diff(link("fam_album", "sunrise")),
    ref=[act("add_to", rows="$sunrise", args=lines(to="$fam_album"))]),
  T("undo", diff(unlink("fam_album", "sunrise")),
    ref=[act("undo")]))
