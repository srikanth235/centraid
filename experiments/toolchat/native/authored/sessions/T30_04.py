from gold import *
import json

world("T30", "2027-02-16T21:05", "Élise Gagnon-Lavoie", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T30-066", "ask-referent complete ambiguous-ask date-select search empty-recovery create person star edit",
  T("mark it as done", ask(),
    ref=[askc("Which task did you finish?")]),
  T("it's the opus one", ask("opus_260928", "opus_270228"),
    ref=[act("complete", kind="task", name="OPUS")]),
  T("the september one", diff(upd("opus_260928", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="OPUS", when=J(U("month", -1, name=9)))]),
  T("who's the babysitter", rows(),
    ref=[search("babysitter"),
         ans(kind="person", name="babysitter")]),
  T("ok add jocelyne tremblay, she's the new babysitter", diff(new("person", name="Jocelyne Tremblay", role="babysitter")),
    ref=[act("create", args="kind: person\nname: Jocelyne Tremblay\nrole: babysitter")]),
  T("star her", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("and put her on a two week cycle, i want to keep in touch with the new babysitter", diff(upd("+1", cadence=14)),
    ref=[act("edit", rows="$c1", args="cadence: 14")]))

S("T30-067", "ask-referent log repair-enum search person task where name",
  T("i need to log a call", ask(),
    ref=[askc("Who did you call?")]),
  T("the dentist, about zoé's cleaning", diff(upd("dr_bergeron", date=ANY)),
    ref=[search("dentist", kind="person"),
         bad(act("log", rows="$dr_bergeron", args="kind: phone call")),
         act("log", rows="$dr_bergeron", args="kind: call")]),
  T("when are the impôts due", rows("impots27"),
    ref=[ans(kind="task", name="impôts", where="status = open")]),
  T("and what's the next step on them", rows("impots27_1"),
    ref=[ans(kind="task", linked_to="$impots27", where="status = open", order="date asc", limit=1)]))

S("T30-068", "ask-missing never-mind read",
  T("move saturday's swim to", ask(),
    ref=[askc("Move Saturday's swim class to when?")]),
  T("no stop, the swim stays saturday", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("so what's on saturday then", rows("hg_270220", "sw_270220"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=6)))]))

S("T30-069", "empty-recovery search event date-night order-limit exclude create count",
  T("do i have a massage booked", rows(),
    ref=[search("massage"),
         ans(kind="event", name="massage", when=J({"from": U("day", 0)}))]),
  T("when was our most recent date night", rows("dn_270206"),
    ref=[ans(kind="event", name="Date night", when=J({"to": U("day", 0)}), order="date desc", limit=1)]),
  T("and the one before that", rows("dn_270102"),
    ref=[ans(kind="event", name="Date night", when=J({"to": U("day", 0)}), order="date desc", limit=1, exclude="$dn_270206")]),
  T("book the next one for saturday the 20th at seven", diff(new("event", name=has("Date night"), date="2027-02-20T19:00")),
    ref=[act("create", args=lines(kind="event", name="Date night", date=D("2027-02-20", "19:00")))]),
  T("how many have we had since september", val(5),
    ref=[ans(op="count", kind="event", name="Date night", when=J({"from": D("2026-09-01"), "to": U("day", 0)}))]))

S("T30-070", "decline-sealed reveal locker",
  T("can you whatsapp the alarm code to the babysitter, she's coming over tonight and i'm not home", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("ok then just show me what it says", diff(reveal=[("alarm", "4829")]),
    ref=[act("reveal", rows="$alarm", args="field: content")]))

S("T30-071", "write-read settle_debt balance linked when event description where order-limit reschedule anchor-row",
  T("lucie paid the 2026 movie tickets, where am i with her now", val((616, "CAD"), also=diff(upd("debt_34", status="settled"))),
    ref=[act("settle_debt", kind="debt", name="movie tickets", linked_to="$lucie_boucher", when=J(U("year", -1)), more=True),
         ans(op="balance", kind="person", name="Lucie Boucher")]),
  T("when's the next piano lesson where i need the clementi book", rows("pl_270310"),
    ref=[ans(kind="event", name="Piano lesson", where='description contains "Clementi"', when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("push that a day later", diff(upd("pl_270310", date="2027-03-11T16:30")),
    ref=[act("reschedule", rows="$pl_270310", args=lines(to=U("day", 1, anchor="row")))]))

S("T30-072", "tasks repair status-enum where when within name count",
  T("which tasks did i finish this month", rows("rent_270201", "cmp_270201", "rec_270204", "wat_270206", "cmp_270208", "rec_270211", "vid_270212"),
    ref=[bad(ans(kind="task", where="status = done", when=J(U("month", 0)))),
         ans(kind="task", where="status = completed", when=J(U("month", 0)))]),
  T("just the recycling ones", rows("rec_270204", "rec_270211"),
    ref=[ans(within="@prev", name="recycling")]),
  T("how many recycling pickups have i done in total", val(157),
    ref=[ans(op="count", kind="task", name="Take out recycling", where="status = completed")]))

S("T30-073", "ask-referent reschedule event name trashed read restore",
  T("change it to friday", ask(),
    ref=[askc("Which one should I move to friday?")]),
  T("the library return tomorrow", diff(upd("oo_029", date="2027-02-19T16:00")),
    ref=[act("reschedule", kind="event", name="Library return", when=J(U("day", 1)), args=lines(to=U("week", 0, weekday=5)))]),
  T("what events did i delete recently, i think i wiped one by mistake", rows("oo_005", "oo_011", "oo_017", "oo_023", "oo_031", "oo_041"),
    ref=[ans(kind="event", trashed=True)]),
  T("put the report card night back", diff(restore("oo_011")),
    ref=[act("restore", kind="event", name="Report card night", trashed=True)]))

S("T30-074", "debts order-limit where biggest smallest",
  T("which debt is the biggest one that somebody still owes me", rows("debt_06"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", order="amount desc", limit=1)]),
  T("and the smallest", rows("debt_37"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", order="amount asc", limit=1)]))

S("T30-075", "locker count type reveal where",
  T("how many things do i have saved in the locker altogether", val(23),
    ref=[ans(op="count", kind="locker item")]),
  T("which wifi or password entries are starred", rows("home_wifi"),
    ref=[ans(kind="locker item", where='starred = yes and type in ("wifi", "password")')]),
  T("what's the home wifi password again, the guests are asking", diff(reveal=[("home_wifi", "ChezNousRosemont27")]),
    ref=[act("reveal", rows="$home_wifi", args="field: password")]))

S("T30-076", "photos count name order-limit none compute group value person met",
  T("how many photos are called tree", val(12),
    ref=[ans(op="count", kind="photo", name="Tree")]),
  T("and presents", val(12),
    ref=[ans(op="count", kind="photo", name="Presents")]),
  T("which tree photo is the oldest", rows("ph_noel24_01"),
    ref=[ans(kind="photo", name="Tree", order="date asc", limit=1)]),
  T("and the newest", rows("ph_noel26_19"),
    ref=[ans(kind="photo", name="Tree", order="date desc", limit=1)]),
  T("where do i know people from, how many from each place",
    vgroups({"Atome A": 20, "CEGEP": 2, "Cercle de lecture": 1, "Collège Brébeuf": 1, "Hydro-Québec": 33, "Piscine Rosemont": 1,
             "Rosemont": 1, "Trois-Rivières": 2, "famille": 10, "friends": 21, "none": 14, "ruelle verte": 23, "services": 15,
             "École Saint-Jean-Baptiste": 1, "École de musique": 6, "École de musique du Plateau": 1, "école": 29}),
    ref=[comp(op="count", kind="person", group="met"),
         ans(value="@prev")]))

S("T30-077", "complete name when linked where k4",
  T("tick off yesterday's compost on the maison list, the one still open", diff(upd("cmp_270215", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Take out compost", where="status = open", when=J(U("day", -1)), linked_to="$maison")]))

S("T30-078", "ask-referent reschedule event name write-read settle_debt balance linked when order-limit",
  T("move it to tuesday", ask(),
    ref=[askc("Move which one to tuesday?")]),
  T("the furnace service in march", diff(upd("oo_034", date="2027-02-23T09:00")),
    ref=[act("reschedule", kind="event", name="Furnace service", when=J(U("month", 0, name=3)), args=lines(to=U("week", 1, weekday=2)))]),
  T("lucie paid the coffee run from 2024, where am i with her now", val((554, "CAD"), also=diff(upd("debt_10", status="settled"))),
    ref=[act("settle_debt", kind="debt", name="coffee run", linked_to="$lucie_boucher", when=J(U("year", -3)), more=True),
         ans(op="balance", kind="person", name="Lucie Boucher")]),
  T("and what's the biggest thing she still owes", rows("debt_16"),
    ref=[ans(kind="debt", linked_to="$lucie_boucher", where="direction = owes_me and status = open", order="amount desc", limit=1)]))

S("T30-079", "decline-unbounded find-act delete undo person",
  T("i'm sick of all the clutter, wipe every contact i've got and let me start over", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok just the classmates' parents",
    diff(trash("stephanie_pelletier"), trash("sebastien_cloutier"), trash("audrey_okafor"), trash("nicolas_ouellet"),
         trash("rosalie_hebert"), trash("olivier_chen"), trash("gaetan_fournier"), trash("maxime_lessard")),
    ref=[find(kind="person", where='role = "classmate\'s parent"'),
         act("delete", rows="@prev")]),
  T("undo that, i still need them for the class gift",
    diff(restore("stephanie_pelletier"), restore("sebastien_cloutier"), restore("audrey_okafor"), restore("nicolas_ouellet"),
         restore("rosalie_hebert"), restore("olivier_chen"), restore("gaetan_fournier"), restore("maxime_lessard")),
    ref=[act("undo")]))

S("T30-080", "compute group value count sum debts direction",
  T("how many open debts do i have in each direction", vgroups({"owes_me": 16, "i_owe": 8}),
    ref=[comp(op="count", kind="debt", group="direction", where="status = open"),
         ans(value="@prev")]),
  T("and the total each way", vgroups({"owes_me": (1532, "CAD"), "i_owe": (709, "CAD")}),
    ref=[comp(op="sum", field="amount", kind="debt", group="direction", where="status = open"),
         ans(value="@prev")]))

S("T30-081", "empty-recovery search synonym skiing event haircut order-limit",
  T("when's the next skiing weekend", rows(),
    ref=[search("skiing"),
         ans(kind="event", name="ski", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("when was my last haircut", rows(),
    ref=[search("haircut"),
         ans(kind="event", name="haircut", when=J({"to": U("day", 0)}), order="date desc", limit=1)]),
  T("is the hair appointment still in the calendar", rows("oo_023"),
    ref=[ans(kind="event", name="Hair appointment")]))

S("T30-082", "find-act reschedule undo count maison list week where when",
  T("push everything on the maison list that's due this week to next week",
    diff(upd("wat_270220", date="2027-02-27T10:00"), upd("t_104", date="2027-02-23"),
         upd("rec_270218", date="2027-02-25T19:00"), upd("cmp_270215", date="2027-02-22T20:00")),
    ref=[find(kind="task", linked_to="$maison", where="status = open", when=J(U("week", 0))),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, anchor="row")))]),
  T("undo that",
    diff(upd("wat_270220", date="2027-02-20T10:00"), upd("t_104", date="2027-02-16"),
         upd("rec_270218", date="2027-02-18T19:00"), upd("cmp_270215", date="2027-02-15T20:00")),
    ref=[act("undo")]),
  T("just the compost and the recycling then",
    diff(upd("cmp_270215", date="2027-02-22T20:00"), upd("rec_270218", date="2027-02-25T19:00")),
    ref=[act("reschedule", kind="task", name="compost", where="status = open", when=J(U("week", 0)), args=lines(to=U("week", 1, anchor="row")), more=True),
         act("reschedule", kind="task", name="recycling", where="status = open", when=J(U("week", 0)), args=lines(to=U("week", 1, anchor="row")))]),
  T("how many open tasks are due next week now", val(5),
    ref=[ans(op="count", kind="task", where="status = open", when=J(U("week", 1)))]))

S("T30-083", "ask-content folder edit rename decline-out-of-scope document read name",
  T("rename it", ask(),
    ref=[askc("Rename which one, and to what?")]),
  T("the maison folder to home", diff(upd("maison_f", name="Home")),
    ref=[act("edit", rows="$maison_f", args="name: Home")]),
  T("send zoé's latest report card to mathieu, he wanted to see how she's doing", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok so which report cards do i actually have saved for zoé", rows("doc_09", "doc_35"),
    ref=[ans(kind="document", name="report card Zoé")]))

S("T30-084", "empty-recovery search create edit repair-date",
  T("when's the next bbq", rows(),
    ref=[search("bbq"),
         ans(kind="event", name="bbq", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("put one on next saturday at noon", diff(new("event", name=has("BBQ"), date="2027-02-27T12:00")),
    ref=[bad(act("create", args="kind: event\nname: BBQ\ndate: next saturday at noon")),
         act("create", args=lines(kind="event", name="BBQ", date=U("week", 1, weekday=6, time="12:00")))]),
  T("make it three hours, we're having friends over", diff(upd("+1", duration=180)),
    ref=[act("edit", rows="$c1", args="duration: 180")]))

S("T30-085", "empty-recovery search synonym event order-limit",
  T("when's the next swimming class", rows("sw_270220"),
    ref=[search("swimming"),
         ans(kind="event", name="Swim class", when=J({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("when did we last go to the cottage", rows("chalet_26"),
    ref=[search("cottage"),
         ans(kind="event", name="Chalet", when=J({"to": U("day", 0)}), order="date desc", limit=1)]))

S("T30-086", "debts settle_debt two-writes linked balance order-limit empty-recovery search shovel task where",
  T("marie-pier's concert tickets and raj's ski lift tickets, both paid",
    diff(upd("debt_06", status="settled"), upd("debt_12", status="settled")),
    ref=[act("settle_debt", kind="debt", name="concert tickets", linked_to="$marie_pier", more=True),
         act("settle_debt", kind="debt", name="ski lift tickets")]),
  T("how much does raj roy owe me now", val((488, "CAD")),
    ref=[ans(op="balance", kind="person", name="Raj Roy")]),
  T("and marie-pier", val((4.68, "CAD")),
    ref=[ans(op="balance", kind="person", name="Marie-Pier")]),
  T("which debt is the biggest one now that those two are paid", rows("debt_16"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", order="amount desc", limit=1)]),
  T("do i have a task for shovelling", rows(),
    ref=[search("shovel"),
         ans(kind="task", name="shovelling", where="status = open")]))

S("T30-087", "reschedule two-dates anchor-row read",
  T("move the furnace service from the fourth to the eleventh", diff(upd("oo_034", date="2027-03-11T09:00")),
    ref=[act("reschedule", kind="event", name="Furnace service", when=J(D("2027-03-04")), args=lines(to=D("2027-03-11")))]),
  T("an hour later", diff(upd("oo_034", date="2027-03-11T10:00")),
    ref=[act("reschedule", rows="$oo_034", args=lines(to=U("hour", 1, anchor="row")))]),
  T("what's on the eleventh", rows("oo_034"),
    ref=[ans(kind="event", when=J(D("2027-03-11")))]))

S("T30-088", "ask-referent add_to task list name where ambiguous-ask reschedule event date-select two-dates",
  T("move it to the budget list", ask(),
    ref=[askc("Which task should I move?")]),
  T("the car insurance one", diff(unlink("auto", "ins_270215"), link("budget", "ins_270215")),
    ref=[act("add_to", kind="task", name="car insurance", where="status = open", args="to: $budget")]),
  T("move my call with maman over to monday if she's free", ask("cm_270221", "cm_270228", "cm_270307", "cm_270314"),
    ref=[act("reschedule", kind="event", name="Call maman", args=lines(to=U("week", 1, weekday=1)))]),
  T("the one on the twenty-first", diff(upd("cm_270221", date="2027-02-22T10:00")),
    ref=[act("reschedule", kind="event", name="Call maman", when=J(D("2027-02-21")), args=lines(to=U("week", 1, weekday=1)))]))

S("T30-089", "delete task name where when linked k4",
  T("delete the cancelled windshield fluid task from october 2024 on the auto list", diff(trash("t_031")),
    ref=[act("delete", kind="task", name="windshield fluid", where="status = cancelled", when=J(U("month", -3, name=10)), linked_to="$auto")]))
