from gold import *
import json

world("T14", "2026-10-24T19:30", "Tomás Ferreira", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T14-001", "five turns baile tonight complete",
  T("what's on tonight", rows("baile_12"),
    ref=[ans(kind="event", when=W(U("day", 0)))]),
  T("who's on the lineup", rows("nath", "guga", "marcos_o", "rafa_m", "ana_paula"),
    ref=[ans(kind="person", linked_to="$baile_12")]),
  T("did i finish setlist for baile #12 yet", rows("setlist12"),
    ref=[ans(kind="task", name="Finish setlist for Baile #12")]),
  T("yep its done, tick it", diff(upd("setlist12", status="completed", completed=ANY)),
    ref=[act("complete", rows="$setlist12")]),
  T("back up usb sticks too, did that at lunch", diff(upd("usb", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Back up USB sticks")]))

S("T14-002", "single reschedule event named",
  T("move the oil change at marcos to thursday 10:30 and show me thursday",
    rows("physio_1029", "oil", "accountant", "fut_1029", also=diff(upd("oil", date="2026-10-29T10:30"))),
    ref=[act("reschedule", rows="$oil", args=lines(to=U("week", 1, weekday=4, time="10:30")), more=True),
         ans(kind="event", when=W(U("week", 1, weekday=4)))]))

S("T14-003", "ambiguous person log ask",
  T("log a call with rafael", ask("rafa_s", "rafa_m"),
    ref=[act("log", kind="person", name="Rafael", args=lines(kind="call")),
         askc("rafael souza from the car pool or rafael mendes the sound guy?", options="$rafa_s, $rafa_m")]),
  T("car pool", diff(upd("rafa_s", date=ANY)),
    ref=[act("log", rows="$rafa_s", args=lines(kind="call"))]),
  T("how's the tab between me and him", val((115, "BRL")),
    ref=[ans(op="balance", rows="$rafa_s")]))

S("T14-004", "restore person where trashed events",
  T("put the wedding planner back in my contacts, she sent a gig lead", diff(restore("renata")),
    ref=[act("restore", kind="person", where='role contains "wedding"', trashed=True)]),
  T("what's her role say exactly", rows("renata"),
    ref=[ans(rows="$renata")]))

S("T14-005", "refused group delete ask empty group delete",
  T("delete the car pool rodízio group", ask(),
    ref=[bad(act("delete", rows="$carpool")),
         askc("it still has expenses in it, so the vault won't delete it. settle everyone up first?")]),
  T("nah leave it. kill futebol de quinta instead, nobody pays in there",
    diff(gone("futebol"), unlink("futebol", "thiago"), unlink("futebol", "wesley"), unlink("futebol", "me")),
    ref=[act("delete", rows="$futebol")]),
  T("how many groups have i got", val(5),
    ref=[ans(op="count", kind="group")]))

S("T14-006", "compute min debts group direction",
  T("smallest open debt each way, what i owe vs what's owed to me",
    vgroups({"owes_me": (40, "BRL"), "i_owe": (35, "BRL")}),
    ref=[comp(op="min", field="amount", kind="debt", where='status = "open"', group="direction"), ans(value="@prev")]),
  T("who's the 35 with", rows("d_wesley"),
    ref=[ans(kind="debt", where='status = "open" and direction = "i_owe" and amount = 35 BRL')]))

S("T14-008", "role contains cadence literal",
  T("who's in the car pool again, by role", rows("rafa_s", "junior"),
    ref=[find(kind="person", where='role contains "car pool"'), ans(rows="@prev")]),
  T("who am i supposed to touch base with weekly", rows("patricia", "rafa_s", "junior", "nath", "guga"),
    ref=[find(kind="person", where="cadence = 7"), ans(rows="@prev")]))

S("T14-009", "find miss search recovery misspelled name",
  T("when did i last see jonathan from the car wash", rows("jhonatan"),
    ref=[ans(kind="person", name="Jonathan"),
         search("jonathan car wash", kind="person"),
         ans(rows="$jhonatan")]))

S("T14-010", "log person new create",
  T("new contact Vitor Hugo, vinyl seller, galeria do rock",
    diff(new("person", name="Vitor Hugo", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Vitor Hugo", role="vinyl seller, Galeria do Rock"))]),
  T("and log a visit, i was at his stall today", diff(upd("+1", date=ANY)),
    ref=[act("log", rows="$c1", args=lines(kind="visit"))]))

S("T14-011", "settle_up named balance",
  T("where's juninho at in the car pool, up or down", val((510, "BRL")),
    ref=[search("juninho", kind="person"),
         ans(op="balance", kind="group", name="Car pool rodízio", linked_to="$junior")]),
  T("settle up with edson lima júnior for the car pool", diff(settle=[("Edson Lima Júnior", "240.00")]),
    ref=[act("settle_up", rows="$junior", args=lines(group="$carpool"))]))

S("T14-012", "event create reschedule new overlap",
  T("book a b2b rehearsal with guga next friday at 3pm", diff(new("event", name=has("rehearsal"), date="2026-10-30T15:00")),
    ref=[act("create", args=lines(kind="event", name="B2B rehearsal with Guga", date=U("week", 1, weekday=5, time="15:00")))]),
  T("push it an hour later", diff(upd("+1", date="2026-10-30T16:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("hour", 1, anchor="row")))]),
  T("what's the rest of that friday look like", rows("kleber_1030"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=5)), exclude="$c1")]))

S("T14-013", "cancel event where",
  T("cancel whatever i have with otávio on tuesday, he moved his flight",
    diff(upd("airport_otavio", status="cancelled")),
    ref=[act("cancel", kind="event", linked_to="$otavio", when=W(U("week", 1, weekday=2)))]),
  T("anything else with him coming up", rows(),
    ref=[ans(kind="event", linked_to="$otavio", when=W({"from": U("day", 0)}), where='status != "cancelled"')]))

S("T14-014", "reschedule task multi",
  T("push fix headphone cable and install dashcam to next saturday",
    diff(upd("headphones", date="2026-10-31"), upd("dashcam", date="2026-10-31")),
    ref=[act("reschedule", rows="$headphones, $dashcam", args=lines(to=U("week", 1, weekday=6)))]),
  T("what else is due that day", rows("leak", "mae_split"),
    ref=[ans(kind="task", when=W(D("2026-10-31")), exclude="$headphones, $dashcam")]))

S("T14-015", "complete task new",
  T("remind me to pay jhonatan for the wash, 60 reais, due today",
    diff(new("task", name=has("Jhonatan"), date="2026-10-24")),
    ref=[act("create", args=lines(kind="task", name="Pay Jhonatan for the car wash", date=U("day", 0)))]),
  T("paid him by pix, mark it done", diff(upd("+1", status="completed", completed=ANY)),
    ref=[act("complete", rows="$c1")]))

S("T14-016", "remove_from task where list",
  T("clear the done stuff off the dj list", diff(unlink("dj_l", "inv_kleber_oct"), unlink("dj_l", "vinyl")),
    ref=[find(kind="task", linked_to="$dj_l", where='status = "completed"'),
         act("remove_from", rows="@prev", args=lines(from_="$dj_l"))]),
  T("what's left on it", rows("setlist12", "usb", "mix", "inv_kleber_nov", "headphones", "controller", "bsas_setlist", "flyer_art"),
    ref=[ans(kind="task", linked_to="$dj_l")]))

S("T14-017", "edit note named ambiguous note",
  T("add 'extension cord for the booth' to the pharmacy list note", ask("pharm_1", "pharm_2"),
    ref=[act("edit", kind="note", name="Pharmacy list", args=lines(body="extension cord for the booth")),
         find(kind="note", name="Pharmacy list"),
         askc("there are two pharmacy list notes, the one in mom's health or the loose one?", options="$pharm_1, $pharm_2")]),
  T("hm no, that doesn't go there anyway. put it on the setlist baile #twelve note body instead",
    diff(upd("set12", body=has("extension cord"))),
    ref=[opn("$set12"),
         act("edit", kind="note", name="Setlist Baile #12",
             args=lines(body="open with baile funk edits, 128 into amapiano, close with Tim Maia. extension cord for the booth"))]))

S("T14-018", "remove_from note prev",
  T("what notes are in old stuff", rows("old_contacts"),
    ref=[ans(kind="note", linked_to="$old_nb")]),
  T("pull it out of there", diff(unlink("old_nb", "old_contacts")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$old_nb"))]),
  T("and rename the notebook to Archive", diff(upd("old_nb", name="Archive")),
    ref=[act("edit", rows="$old_nb", args=lines(name="Archive"))]))

S("T14-019", "edit document prev star",
  T("what's unfiled in documents", rows("rider"),
    ref=[find(kind="document", where="folder count = 0"), ans(rows="@prev")]),
  T("rename it Technical rider 2026", diff(upd("rider", name="Technical rider 2026")),
    ref=[act("edit", rows="@prev", args=lines(name="Technical rider 2026"))]),
  T("and file it under gig contracts", diff(link("contracts_f", "rider")),
    ref=[act("add_to", rows="$rider", args=lines(to="$contracts_f"))]))

S("T14-020", "unstar document new create star",
  T("new doc Baile #12 settlement, put it in gig contracts and star it",
    diff(new("document", name="Baile #12 settlement", starred=True), link("contracts_f", "new")),
    ref=[act("create", more=True, args=lines(kind="document", name="Baile #12 settlement", folder="$contracts_f")),
         act("star", rows="$new")]),
  T("unstar it, ana paula will redo the numbers tomorrow", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))

S("T14-021", "remove_from document named folder",
  T("can you take the tyre invoice out of car pool receipts, it's mine not the pool's",
    diff(unlink("car_pool_f", "tyre_rcpt")),
    ref=[act("remove_from", kind="document", name="Tyre invoice", args=lines(from_="$car_pool_f"))]),
  T("what's left in there", rows("fuel_rcpt"),
    ref=[ans(kind="document", linked_to="$car_pool_f")]))

S("T14-022", "star photo multi",
  T("star nath and guga in the booth and the collective group photo",
    diff(upd("b11_booth", starred=True), upd("b11_team", starred=True)),
    ref=[act("star", rows="$b11_booth, $b11_team")]),
  T("how many starred pics", val(7),
    ref=[ans(op="count", kind="photo", where="starred = yes")]))

S("T14-023", "add_to photo multi album",
  T("put vinyl haul and casa vermelha lights in gigs 2026",
    diff(link("gigs_album", "vinyl_haul"), link("gigs_album", "cv_lights")),
    ref=[search("vinyl haul", kind="photo"),
         act("add_to", rows="$vinyl_haul, $cv_lights", args=lines(to="$gigs_album"))]),
  T("how's the count on that album", val(6),
    ref=[ans(op="count", kind="photo", linked_to="$gigs_album")]))
