from gold import *
import json


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T38-048", "recovery empty-search answer-empty person",
  T("when did i last call the vet about the cat's ear", rows(),
    ref=[search("vet", kind="person"), ans(kind="person", name="vet")]))

S("T38-049", "recovery empty-search answer-empty event",
  T("when is dana's next piano lesson this month", rows(),
    ref=[search("piano"), ans(kind="event", name="piano lesson")]))

S("T38-050", "write-then-read complete series home-list",
  T("complete fix the kitchen light and show me what's left on the home list",
    rows(also=diff(upd("t_106", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="Fix the kitchen light", more=True),
         ans(kind="task", linked_to="$home_l", where="status = open")]))

S("T38-051", "search log relation exclude friday-lunch attendees",
  T("log a call with yazan, he says he'll be at friday lunch", diff(upd("yazan", date=ANY)),
    ref=[search("Yazan", kind="person"), act("log", rows="$yazan", args="kind: call")]),
  T("who else is coming to this friday's lunch besides him", rows("baba", "mama", "dana"),
    ref=[find(kind="event", name="Friday lunch", when=J(U("week", 0, weekday=5))),
         ans(kind="person", linked_to="@prev", exclude="$yazan")]))

S("T38-052", "already-so star then answer unstar",
  T("star hind smadi, the swim coach", diff(already=["hind_smadi"]),
    ref=[act("star", kind="person", name="Hind Smadi"), ans(rows="$hind_smadi")]),
  T("ok take the star off her then", diff(upd("hind_smadi", starred=False)),
    ref=[act("unstar", rows="$hind_smadi")]),
  T("actually delete hind smadi, she's left the school", diff(trash("hind_smadi")),
    ref=[act("delete", rows="$hind_smadi")]))

S("T38-053", "search create debt link settle_debt",
  T("dana owes me 12 dinars for the school photos",
    diff(new("debt", name="school photos", amount=12, direction="owes_me"), link("new", "dana")),
    ref=[search("Dana", kind="person"),
         act("create", args=lines(kind="debt", name="school photos", amount=12, direction="owes_me", person="$dana"))]),
  T("she paid me back just now, settle it", diff(upd("+1", status="settled")),
    ref=[act("settle_debt", rows="$new")]))

S("T38-054", "compute group status repair priority count",
  T("how many tasks do i have by status",
    vgroups({"cancelled": 4, "completed": 767, "in_progress": 5, "open": 39}),
    ref=[comp(op="count", kind="task", group="status"), ans(value="@prev")]),
  T("and how many are priority one and still open", val(2),
    ref=[bad(ans(op="count", kind="task", where="priority == 1 and status = open")),
         ans(op="count", kind="task", where="priority = 1 and status = open")]))

S("T38-055", "diary date within name",
  T("what's still in the diary on the 16th", rows("csm_270516", "eid_a27"),
    ref=[ans(kind="event", where="status != cancelled", when=J(D("2027-05-16")))]),
  T("which of those is at teta's", rows("eid_a27"),
    ref=[ans(within="@prev", name="Teta")]),
  T("delete this sunday's staff meeting, it's off", diff(trash("csm_270516")),
    ref=[act("delete", kind="event", name="Clinic staff meeting", when=J(U("week", 0, weekday=7)))]),
  T("wait no, bring it back", diff(restore("csm_270516")),
    ref=[find(kind="event", name="Clinic staff meeting", trashed=True, when=J(U("week", 0, weekday=7))),
         act("restore", rows="$csm_270516")]))

S("T38-056", "decline unbounded then bounded delete find cancelled",
  T("delete all my tasks", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok just get rid of all the cancelled ones", diff(trash("t_052"), trash("t_008"), trash("t_030"), trash("t_024")),
    ref=[find(kind="task", where="status = cancelled"), act("delete", rows="@prev")]))

S("T38-057", "trashed person delete not-found restore",
  T("delete zahra haddad from my contacts", decline("not_found"),
    ref=[act("delete", kind="person", name="Zahra Haddad")]),
  T("oh she's in the bin already, bring her back", diff(restore("zahra_haddad")),
    ref=[find(kind="person", name="Zahra Haddad", trashed=True), act("restore", rows="$zahra_haddad")]))

S("T38-058", "ask no-options create task list weekday",
  T("add a task for the clinic", ask(),
    ref=[askc("What should the task be called?")]),
  T("order gloves, by friday", diff(new("task", name="Order gloves", date="2027-05-14"), link("clinic_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Order gloves", date=U("week", 0, weekday=5), list="$clinic_l"))]),
  T("and a group for the night shift staff, in dinars",
    diff(new("group", name=has("night"), currency="JOD"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Clinic Night Shift", currency="JOD"))]))

S("T38-059", "decline fabricated then locker edit sealed",
  T("make up a new alarm code for the clinic", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("no wait, just set it to 4455 then the star key", diff(upd("alarm", notes="sealed")),
    ref=[act("edit", rows="$alarm", args="notes: 4455 then the star key")]))

S("T38-060", "album rename count person-count photo linked star both",
  T("rename the dubai expo photos album to dubai 2026", diff(upd("dubai_a", name="Dubai 2026")),
    ref=[act("edit", kind="album", name="Dubai Expo Photos", args="name: Dubai 2026")]),
  T("how many of its photos have somebody tagged in them", val(6),
    ref=[ans(op="count", kind="photo", linked_to="$dubai_a", where="person count >= 1")]),
  T("star the one of layla qasem", diff(upd("ph_dubai_a_15", starred=True)),
    ref=[act("star", kind="photo", linked_to="$dubai_a, $layla_q")]),
  T("and both of baba's too", diff(upd("ph_dubai_a_01", starred=True), upd("ph_dubai_a_04", starred=True)),
    ref=[find(kind="photo", linked_to="$dubai_a, $baba"), act("star", rows="@prev")]))

S("T38-061", "clinic-week relation within two-writes meeting people pool",
  T("what's still on next week that baba is in", rows("fl_270521", "csm_270523"),
    ref=[ans(kind="event", linked_to="$baba", where="status != cancelled", when=J(U("week", 1)))]),
  T("which of those are meetings", rows("csm_270523"),
    ref=[ans(within="@prev", name="meeting")]),
  T("move it to monday and push the supplies order to tuesday",
    diff(upd("csm_270523", date="2027-05-17T08:00"), upd("sup_270517", date="2027-05-18T09:00")),
    ref=[act("reschedule", rows="$csm_270523", args=lines(to=U("week", 1, weekday=1)), more=True),
         act("reschedule", kind="task", name="Order clinic supplies", where="status = open",
             when=J(U("week", 1, weekday=1)), args=lines(to=U("week", 1, weekday=2)))]),
  T("who's coming to the staff meeting", rows("baba", "rasha", "ahmad"),
    ref=[ans(kind="person", linked_to="$csm_270523")]),
  T("and which of them are in the clinic supplies pool", rows("rasha", "ahmad"),
    ref=[ans(kind="person", within="@prev", linked_to="$clinic_supplies")]))

S("T38-062", "family money balance narrowed debts find-only settle-both",
  T("where am i with khalto rima", val((26.167, "JOD"), (-130, "EUR")),
    ref=[ans(op="balance", kind="person", rows="$khalto_rima")]),
  T("just the family fund", val((-82.5, "JOD")),
    ref=[ans(op="balance", kind="group", name="Al-Sayed Family Fund", linked_to="$khalto_rima")]),
  T("which debts are open between us", rows("debt_14", "debt_45"),
    ref=[find(kind="debt", linked_to="$khalto_rima", where="status = open"), ans(rows="@prev")]),
  T("settle both of them, we're even", diff(upd("debt_14", status="settled"), upd("debt_45", status="settled")),
    ref=[act("settle_debt", rows="@prev")]),
  T("so what's my balance with her now", val((18.667, "JOD"), (-130, "EUR")),
    ref=[ans(op="balance", kind="person", rows="$khalto_rima")]))

S("T38-063", "friday-lunch next exclude reschedule day-read cancel-and-move",
  T("when's the next friday lunch that hasn't been cancelled", rows("fl_270514"),
    ref=[ans(kind="event", name="Friday lunch", where="status != cancelled", when=J({"from": U("day", 0)}),
             order="date asc", limit=1)]),
  T("and who's coming", rows("baba", "mama", "yazan", "dana"),
    ref=[ans(kind="person", linked_to="@prev")]),
  T("what about the one after that", rows("fl_270521"),
    ref=[ans(kind="event", name="Friday lunch", when=J({"from": U("day", 0)}), order="date asc", limit=1,
             exclude="$fl_270514")]),
  T("move that one to saturday and tell me who's still coming",
    rows("baba", "mama", "yazan", "dana", also=diff(upd("fl_270521", date="2027-05-22T13:30"))),
    ref=[act("reschedule", kind="event", name="Friday lunch", when=J(U("week", 1, weekday=5)),
             args=lines(to=U("week", 1, weekday=6)), more=True),
         ans(kind="person", linked_to="$fl_270521")]),
  T("what's still on that saturday", rows("fl_270521", "yf_270522"),
    ref=[ans(kind="event", where="status != cancelled", when=J(U("week", 1, weekday=6)))]),
  T("cancel the football that day and push the lunch an hour later",
    diff(upd("yf_270522", status="cancelled"), upd("fl_270521", date="2027-05-22T14:30")),
    ref=[act("cancel", kind="event", name="Yazan's football", when=J(U("week", 1, weekday=6)), more=True),
         act("reschedule", rows="$fl_270521", args=lines(to=U("hour", 1, anchor="row")))]))

S("T38-064", "folders documents create add_to year find-only folder-delete-ask rename",
  T("create a folder called umrah 2028", diff(new("folder", name="Umrah 2028")),
    ref=[act("create", args=lines(kind="folder", name="Umrah 2028"))]),
  T("put the passport renewal from 2026 in it", diff(unlink("travelf", "doc_082"), link("+1", "doc_082")),
    ref=[act("add_to", kind="document", name="Passport renewal", when=J(U("year", -1)), args="to: $c1")]),
  T("and the 2025 one too, then show me what's in the new folder",
    rows("doc_082", "doc_052", also=diff(unlink("travelf", "doc_052"), link("+1", "doc_052"))),
    ref=[act("add_to", kind="document", name="Passport renewal", when=J(U("year", -2)), args="to: $c1", more=True),
         ans(kind="document", linked_to="$c1")]),
  T("what's still in the travel folder", rows("doc_021", "doc_022", "doc_051", "doc_081"),
    ref=[find(kind="document", linked_to="$travelf"), ans(rows="@prev")]),
  T("delete the travel folder", ask("doc_021", "doc_022", "doc_051", "doc_081"),
    ref=[act("delete", rows="$travelf")]),
  T("no, just rename it to old trips", diff(upd("travelf", name="Old Trips")),
    ref=[act("edit", rows="$travelf", args="name: Old Trips")]))

S("T38-065", "evening cleanup two-writes undo electrician log star-read undo",
  T("complete fix the kitchen light and push buy fertiliser to friday",
    diff(upd("t_106", status="completed", completed=ANY), upd("t_018", date="2027-05-14")),
    ref=[act("complete", kind="task", name="Fix the kitchen light", more=True),
         act("reschedule", kind="task", name="Buy fertiliser", where="status = open",
             args=lines(to=U("week", 0, weekday=5)))]),
  T("no undo that, the electrician is coming tomorrow",
    diff(upd("t_106", status="open", completed=None), upd("t_018", date="2027-05-19")),
    ref=[act("undo")]),
  T("just the fertiliser one then, friday", diff(upd("t_018", date="2027-05-14")),
    ref=[act("reschedule", kind="task", name="Buy fertiliser", where="status = open",
             args=lines(to=U("week", 0, weekday=5)))]),
  T("who's the electrician again", rows("leen_zureiqat", "qasim_bataineh"),
    ref=[ans(kind="person", where='role = "electrician"')]),
  T("log a call with leen", diff(upd("leen_zureiqat", date=ANY)),
    ref=[act("log", kind="person", name="Leen", args="kind: call")]),
  T("star her and show me who i've starred from the services crowd",
    rows("mais_hammouri", "leen_zureiqat", also=diff(upd("leen_zureiqat", starred=True))),
    ref=[act("star", rows="$leen_zureiqat", more=True), ans(kind="person", where='met = "services" and starred = yes')]),
  T("undo", diff(upd("leen_zureiqat", starred=False)),
    ref=[act("undo")]))

S("T38-066", "notebook create k3-broken-off ambiguous-note pick two-writes notebook-rename-delete",
  T("move the gift ideas note into... actually just start a new notebook called eid planning",
    diff(new("notebook", name="Eid Planning")),
    ref=[act("create", args=lines(kind="notebook", name="Eid Planning"))]),
  T("put the gift ideas note in it", ask("loose_4", "fam_3"),
    ref=[act("add_to", kind="note", name="Gift ideas", args="to: $c1")]),
  T("the one for mama", diff(link("+1", "loose_4")),
    ref=[act("add_to", rows="$loose_4", args="to: $c1")]),
  T("rename that notebook to eid 2027 plans and delete the garden one",
    diff(upd("+1", name="Eid 2027 Plans"), gone("garden_nb"), unlink("garden_nb", "gar_1"),
         unlink("garden_nb", "gar_2"), unlink("garden_nb", "gar_3")),
    ref=[act("edit", rows="$c1", args="name: Eid 2027 Plans", more=True),
         act("delete", kind="notebook", name="Garden Notebook")]))

S("T38-067", "documents restore-find year remove_from rename delete-year create-folder",
  T("i deleted the internet contract from 2024 by mistake, bring it back", diff(restore("doc_003")),
    ref=[find(kind="document", name="Internet contract", trashed=True, when=J(U("year", -3))),
         act("restore", rows="$doc_003")]),
  T("take it out of the rent folder", diff(unlink("rentf", "doc_003")),
    ref=[act("remove_from", rows="$doc_003", args="from: $rentf")]),
  T("call it old internet contract", diff(upd("doc_003", name="Old internet contract")),
    ref=[act("edit", rows="$doc_003", args="name: Old internet contract")]),
  T("delete the zakat calculation from 2024", diff(trash("doc_030")),
    ref=[act("delete", kind="document", name="Zakat calculation", when=J(U("year", -3)))]),
  T("add a document called clinic invoice may 2027 to the tax folder",
    diff(new("document", name="Clinic invoice May 2027"), link("taxf", "new")),
    ref=[act("create", args=lines(kind="document", name="Clinic invoice May 2027", folder="$taxf"))]))

S("T38-068", "photo delete undo remove_from rename restore-find album-create",
  T("delete the mansaf table 1 photo",
    diff(trash("ph_fridays_01"), unlink("fridays", "ph_fridays_01"), unlink("clinic_a", "ph_fridays_01")),
    ref=[act("delete", kind="photo", name="Mansaf table 1")]),
  T("undo that, it's the first friday one",
    diff(restore("ph_fridays_01"), link("fridays", "ph_fridays_01"), link("clinic_a", "ph_fridays_01")),
    ref=[act("undo")]),
  T("take it out of the clinic moments album", diff(unlink("clinic_a", "ph_fridays_01")),
    ref=[act("remove_from", kind="photo", name="Mansaf table 1", args="from: $clinic_a")]),
  T("and call it first friday mansaf", diff(upd("ph_fridays_01", name="First friday mansaf")),
    ref=[act("edit", kind="photo", name="Mansaf table 1", args="name: First friday mansaf")]),
  T("bring back the cat on the wall photo i deleted", diff(restore("ph_loose_242")),
    ref=[find(kind="photo", name="A cat on the wall", trashed=True), act("restore", rows="$ph_loose_242")]),
  T("make an album called eid 2027 photos", diff(new("album", name="Eid 2027 Photos")),
    ref=[act("create", args=lines(kind="album", name="Eid 2027 Photos"))]))

S("T38-069", "locker create unstar-where delete",
  T("save a new login for the car insurance portal",
    diff(new("locker item", name="Car insurance portal", type="login")),
    ref=[act("create", args=lines(kind="locker item", name="Car insurance portal", type="login"))]),
  T("unstar the family account, it's not the main one anymore", diff(upd("joint_acct", starred=False)),
    ref=[act("unstar", kind="locker item", name="Family account", where="starred = yes")]),
  T("and delete the national id entry", diff(trash("national_id")),
    ref=[act("delete", kind="locker item", name="National ID")]))

S("T38-070", "ambiguous task series ask pick month, ambiguous event cancel ask",
  T("tick off pay clinic electricity", ask("elec_270610", "elec_260410"),
    ref=[act("complete", kind="task", name="Pay clinic electricity")]),
  T("the june one", diff(upd("elec_270610", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay clinic electricity", when=J(U("month", 0, name=6)))]),
  T("cancel the call with teta", ask("ct_270513", "ct_270520", "ct_270527"),
    ref=[act("cancel", kind="event", name="Call Teta")]))

S("T38-071", "recovery empty-search not-found write read",
  T("log a call with my cardiologist", decline("not_found"),
    ref=[search("cardiologist", kind="person"), act("log", kind="person", name="cardiologist", args="kind: call")]),
  T("star the driver we used for the airport", decline("not_found"),
    ref=[search("driver", kind="person"), act("star", kind="person", name="driver")]),
  T("what's the guitar tutor's number", rows(),
    ref=[search("guitar"), ans(kind="person", name="guitar tutor")]))

S("T38-072", "count events description year k4",
  T("how many of the clinic staff meetings in 2026 had the supplies note", val(4),
    ref=[ans(op="count", kind="event", name="Clinic staff meeting", where='description contains "supplies"',
             when=J(U("year", -1)))]))

S("T38-073", "tasks list open before-date k3 old-overdue",
  T("what's still open on the finance list that was due before the end of the month",
    rows("t_087", "t_140", "elec_260410", "net_270515", "t_117", "sal_270528"),
    ref=[ans(kind="task", linked_to="$finance_l", where="status = open", when=J({"to": D("2027-05-31")}))]))

S("T38-074", "ambiguous document star ask year pick",
  T("star the fire safety certificate", ask("doc_005", "doc_035", "doc_065", "doc_095"),
    ref=[act("star", kind="document", name="Fire safety certificate")]),
  T("the 2026 one", diff(upd("doc_065", starred=True)),
    ref=[act("star", kind="document", name="Fire safety certificate", where="starred = no", when=J(U("year", -1)))]))

S("T38-075", "recovery empty-search answer-empty babysitter",
  T("what's the babysitter's number", rows(),
    ref=[search("babysitter", kind="person"), ans(kind="person", name="babysitter")]))
