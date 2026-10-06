from gold import *
import json

world("T09", "2026-05-13T08:05", "Hanae Okafor", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T09-001", "priority where edit multi reschedule",
  T("which tasks are priority three or lower", rows("ethics_hypo", "nda", "vows", "cpd", "passport_name"),
    ref=[ans(kind="task", where="priority >= 3")]),
  T("bump the ethics hypos and the nda up to 2", diff(upd("ethics_hypo", priority=2), upd("nda", priority=2)),
    ref=[act("edit", rows="$ethics_hypo, $nda", args=lines(priority=2))]),
  T("so what's left at 3 or below", rows("vows", "cpd", "passport_name"),
    ref=[ans(kind="task", where="priority >= 3")]),
  T("push the vows to aug eighth", diff(upd("vows", date="2026-08-08")),
    ref=[act("reschedule", rows="$vows", args=lines(to=D("2026-08-08")))]))

S("T09-002", "met contains",
  T("who do i know from u of t residence", rows("kemi", "siobhan"),
    ref=[ans(kind="person", where='met contains "U of T"')]),
  T("and from osgoode?", rows("dan", "priya_r"),
    ref=[ans(kind="person", where='met contains "Osgoode"')]))

S("T09-003", "delete person where trashed restore",
  T("delete crossbridge's property manager from my contacts, they got replaced", diff(trash("ravi")),
    ref=[act("delete", kind="person", where='role contains "property manager"')]),
  T("what's in the contacts trash", rows("greg", "bex", "ravi"),
    ref=[ans(kind="person", trashed=True)]),
  T("bring greg back, i need him for the deposit thing", diff(restore("greg")),
    ref=[act("restore", rows="$greg")]))

S("T09-004", "delete person prev cancel",
  T("who's my dentist again", rows("lisa"),
    ref=[ans(kind="person", where='role = "dentist"')]),
  T("switching clinics, delete her", diff(trash("lisa")),
    ref=[act("delete", rows="@prev")]),
  T("and cancel the cleaning on the twenty-sixth", diff(upd("dentist", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dentist cleaning")]))

S("T09-005", "create person add_to remove_from new",
  T("add leila mensah to contacts and put her in the wedding party group",
    diff(new("person", name="Leila Mensah"), link("wparty", "new")),
    ref=[act("create", more=True, args=lines(kind="person", name="Leila Mensah")),
         act("add_to", rows="$new", args=lines(to="$wparty"))]),
  T("wait no she's a guest, take her out of the group", diff(unlink("wparty", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$wparty"))]))

S("T09-006", "log named other priya",
  T("log a coffee with Priya Raman", diff(upd("priya_r", date=ANY)),
    ref=[act("log", kind="person", name="Priya Raman", args=lines(kind="coffee"))]),
  T("when did i last speak to the condo board priya", rows("priya_s"),
    ref=[ans(kind="person", name="Priya Sandhu")]))

S("T09-007", "create event edit new",
  T("book drinks with ethan fri at 6", diff(new("event", name=has("Ethan"), date="2026-05-15T18:00")),
    ref=[act("create", args=lines(kind="event", name="Drinks with Ethan", date=U("week", 0, weekday=5, time="18:00")))]),
  T("put queen and beaver in the description", diff(upd("+1", description="Queen and Beaver")),
    ref=[act("edit", rows="$c1", args=lines(description="Queen and Beaver"))]),
  T("what else is on friday", rows("team_lunch", "movie"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=5)), exclude="$c1")]))

S("T09-008", "reschedule event where",
  T("push tomorrow's short meeting to 4:30", diff(upd("checkin_0514", date="2026-05-14T16:30")),
    ref=[act("reschedule", kind="event", when=W(U("day", 1)), where="duration < 60",
             args=lines(to=U("day", 1, time="16:30")))]),
  T("who's that with", rows("margaret"),
    ref=[ans(kind="person", linked_to="$checkin_0514")]))

S("T09-010", "create task reschedule new",
  T("remind me to renew the condo insurance by june first", diff(new("task", name=has("insurance"), date="2026-06-01")),
    ref=[act("create", args=lines(kind="task", name="Renew condo insurance", date=D("2026-06-01")))]),
  T("make that may twenty-ninth", diff(upd("+1", date="2026-05-29")),
    ref=[act("reschedule", rows="$c1", args=lines(to=D("2026-05-29")))]))

S("T09-011", "add_to task where search",
  T("the obaachan task that's due this week, put it on the home list", diff(link("home_list", "call_nana")),
    ref=[search("obaachan", kind="person"),
         act("add_to", kind="task", linked_to="$nana", when=W(U("week", 0)), args=lines(to="$home_list"))]),
  T("what's open on home this month", rows("smoke", "library", "call_nana"),
    ref=[ans(kind="task", linked_to="$home_list", when=W(U("month", 0)), where='status = "open"')]))

S("T09-013", "notebook count add_to note prev already",
  T("which notes aren't in any notebook", rows("lisbon_ideas", "gift_nana", "budget", "books", "run_log"),
    ref=[ans(kind="note", where="notebook count < 1")]),
  T("put the budget one in wedding", diff(link("wed_nb", "budget")),
    ref=[find(within="@prev", name="budget"), act("add_to", rows="@prev", args=lines(to="$wed_nb"))]),
  T("and pin vow ideas", diff(already=["vow_ideas"]),
    ref=[act("edit", kind="note", name="Vow ideas", args=lines(pinned="yes")), ans(rows="$vow_ideas")]))

S("T09-014", "create note remove_from new",
  T("new note in condo board: ask ravi about the parking garage sealant",
    diff(new("note", name=has("sealant")), link("condo_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Parking garage sealant", body="ask Ravi about the parking garage sealant",
                                  notebook="$condo_nb"))]),
  T("that's not board business, take it out of that notebook", diff(unlink("condo_nb", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$condo_nb"))]))

S("T09-015", "create document star new",
  T("save a doc called Vendor contact sheet in the wedding folder",
    diff(new("document", name="Vendor contact sheet"), link("wed_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Vendor contact sheet", folder="$wed_f"))]),
  T("star that doc too", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))

S("T09-016", "add_to document named empty answer",
  T("move the LSO licence certificate into work", diff(link("work_f", "lso_card")),
    ref=[act("add_to", kind="document", name="LSO licence certificate", args=lines(to="$work_f"))]),
  T("anything starred in there", rows(),
    ref=[ans(kind="document", linked_to="$work_f", where="starred = yes")]))

S("T09-017", "trashed photo restore prev",
  T("did i delete the blurry toast pic", rows("blurry_toast"),
    ref=[ans(kind="photo", name="Blurry toast photo", trashed=True)]),
  T("put it back", diff(restore("blurry_toast")),
    ref=[act("restore", rows="@prev")]))

S("T09-018", "unstar photo prev",
  T("starred pics with dan in them", rows("proposal", "eng_shoot2", "blossom_dan"),
    ref=[ans(kind="photo", linked_to="$dan", where="starred = yes")]),
  T("unstar those, i only want the ring starred",
    diff(upd("proposal", starred=False), upd("eng_shoot2", starred=False), upd("blossom_dan", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T09-019", "edit locker named star multi",
  T("garage code changed, make the note say P2 visitor door 5820#", diff(upd("garage", notes=ANY)),
    ref=[act("edit", kind="locker item", name="Garage door code", args=lines(notes="P2 visitor door 5820#"))]),
  T("star it and the home wifi", diff(upd("garage", starred=True), upd("wifi", starred=True)),
    ref=[act("star", rows="$garage, $wifi")]))

S("T09-020", "repair locker notes create reveal new",
  T("save the arbor room wifi, network ArborGuest pw gardenparty22",
    diff(new("locker item", name=has("Arbor"))),
    ref=[bad(act("create", args=lines(kind="locker item", name="Arbor Room wifi", type="wifi",
                                      notes="network ArborGuest, password gardenparty22"))),
         act("create", args=lines(kind="locker item", name="Arbor Room wifi", type="note",
                                  notes="network ArborGuest, password gardenparty22"))]),
  T("what's the pw on that again", diff(reveal=[("+1", "gardenparty22")]),
    ref=[act("reveal", rows="$c1", kind="locker item", args=lines(field="notes"))]))

S("T09-021", "edit folder notebook multi",
  T("rename the condo folder and the condo board notebook both to Mercer board",
    diff(upd("condo_f", name="Mercer board"), upd("condo_nb", name="Mercer board")),
    ref=[act("edit", rows="$condo_f, $condo_nb", args=lines(name="Mercer board"))]))

S("T09-022", "create list edit new",
  T("make a list called Bachelorette, area wedding", diff(new("list", name="Bachelorette", area="wedding")),
    ref=[act("create", args=lines(kind="list", name="Bachelorette", area="wedding"))]),
  T("file it under travel", diff(upd("+1", area="travel")),
    ref=[act("edit", rows="$c1", args=lines(area="travel"))]))

S("T09-023", "find miss linked reschedule edit",
  T("when's my appointment with dr moreau", rows("dentist"),
    ref=[find(kind="event", name="Dr Moreau"), ans(kind="event", linked_to="$lisa")]),
  T("shift it to 8:30 same day", diff(upd("dentist", date="2026-05-26T08:30")),
    ref=[act("reschedule", rows="$dentist", args=lines(to=U("day", 0, anchor="row", time="08:30")))]),
  T("and put bring night guard in the description", diff(upd("dentist", description="bring night guard")),
    ref=[act("edit", rows="$dentist", args=lines(description="bring night guard"))]))

S("T09-024", "ambiguous photo ask pick",
  T("star the dress fitting pic", diff(upd("fitting_ada", starred=True)),
    ref=[act("star", kind="photo", name="dress fitting")]))

S("T09-025", "linked_to all photo album star",
  T("pics with both dan and ada in them", rows("eng_party", "xmas"),
    ref=[find(kind="person", where='nickname in ("Dan", "Ada")'), ans(kind="photo", linked_to="$dan, $ada")]),
  T("which album is the toast one in", rows("eng_album"),
    ref=[ans(kind="album", linked_to="$eng_party")]),
  T("give the toast pic a star", diff(upd("eng_party", starred=True)),
    ref=[act("star", rows="$eng_party")]))
