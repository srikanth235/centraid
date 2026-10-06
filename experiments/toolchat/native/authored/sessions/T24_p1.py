from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
def J(d):
    return json.dumps(d, separators=(",", ":"))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
WEEKEND = {"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}

S("T24-004-P", "met literal within unstar person prev para",
  T("people i met at UTEP, who are they", rows("elena", "ray", "jessica"),
    ref=[ans(kind="person", where='met = "UTEP"')]),
  T("the coach?", rows("ray"),
    ref=[find(kind="person", within="@prev", where='role contains "coach"'), ans(rows="@prev")]),
  T("remove his star", diff(upd("ray", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T24-009-P", "event duration unit refused unit repair cancel named para",
  T("next week, which things go on past two hours", rows("lucia_bday", "ref_clinic", "fb_0925", "yard_0926"),
    ref=[bad(ans(kind="event", when=U("week", 1), where="duration > 2 hours")),
         ans(kind="event", when=U("week", 1), where="duration > 120 min")]),
  T("micheal says its moving, so the referee clinic is off, cancel it", diff(upd("ref_clinic", status="cancelled")),
    ref=[act("cancel", rows="$ref_clinic")]))

S("T24-016-P", "reopen task multi subtasks read para",
  T("Get quote from Sun City Sports and Send party invites aren't finished after all, reopen them",
    diff(upd("quote", status="open", completed=None), upd("invites", status="open", completed=None)),
    ref=[act("reopen", rows="$quote, $invites")]),
  T("list the steps beneath the jerseys task", rows("sizes", "quote", "jersey_money"),
    ref=[ans(kind="task", linked_to="$jerseys")]))

S("T24-023-P", "task spans landscaping party subtasks para",
  T("what on the landscaping list is due between today and the twenty-fifth", rows("mulch", "invoice_soto", "castillo_quote"),
    ref=[ans(kind="task", linked_to="$land_l", when=span(U("day", 0), D("2026-09-25")))]),
  T("lucia's party prep tasks, tomorrow through next thursday", rows("pinata"),
    ref=[ans(kind="task", linked_to="$party", when=span(U("day", 1), U("week", 1, weekday=4)))]))

S("T24-028-P", "delete photo where knock-on photo undo photo star para",
  T("landscaping jobs album, what photos are in it", rows("p_whit_before", "p_whit_after", "p_soto_front", "p_sprinkler"),
    ref=[ans(kind="photo", linked_to="$land_al")]),
  T("get rid of the photo taken on the twenty-ninth", diff(trash("p_soto_front"), unlink("land_al", "p_soto_front"),
                                        unlink("yards_al", "p_soto_front")),
    ref=[act("delete", kind="photo", linked_to="$land_al", when=D("2026-08-29"))]),
  T("hold on, rudy uses that one for his flyers, undo the delete", diff(restore("p_soto_front"), link("land_al", "p_soto_front"),
                                                            link("yards_al", "p_soto_front")),
    ref=[act("undo")]),
  T("give it a star", diff(upd("p_soto_front", starred=True)),
    ref=[find(kind="photo", name="Soto front yard"),
         act("star", rows="$p_soto_front")]))

S("T24-032-P", "create document folder remove_from document new add_to para",
  T("create a document called Scrimmage waiver and put it in the team folder", diff(new("document", name="Scrimmage waiver"), link("team_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Scrimmage waiver", folder="$team_f"))]),
  T("the office keeps those, so pull it out of team", diff(unlink("team_f", "+1")),
    ref=[act("remove_from", rows="$c1", args=lines(from_="$team_f"))]),
  T("school is where it goes", diff(link("school_f", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$school_f"))]),
  T("the office wants it loose, so undo that last filing", diff(unlink("school_f", "+1")),
    ref=[act("undo")]))

S("T24-036-P", "find-only trashed document restore document prev para",
  T("are there team docs in the trash", rows("old_roster"),
    ref=[find(kind="document", linked_to="$team_f", trashed=True), ans(rows="@prev")]),
  T("bring it back", diff(restore("old_roster")),
    ref=[act("restore", rows="@prev")]),
  T("ray already has last year's roster, undo that", diff(trash("old_roster")),
    ref=[act("undo")]))

S("T24-040-P", "find notebook linked_to edit notebook prev para",
  T("my soto quote note, what notebook holds it", rows("land_nb"),
    ref=[find(kind="note", name="Soto quote"), search("Soto", kind="note"), ans(kind="notebook", linked_to="$soto_note")]),
  T("that notebook's new name is Rudy's crew", diff(upd("land_nb", name="Rudy's crew")),
    ref=[act("edit", rows="@prev", args=lines(name="Rudy's crew"))]))

S("T24-045-P", "locker notes in within type star prev para",
  T("locker items with a personal or union tag", rows("venmo", "savings", "aft_card"),
    ref=[ans(kind="locker item", where='notes in ("personal", "union")')]),
  T("any of them a membership", rows("aft_card"),
    ref=[find(kind="locker item", within="@prev", where='type = "membership"'), ans(rows="@prev")]),
  T("give it a star", diff(upd("aft_card", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T24-049-P", "note anchor linked person pin prev para",
  T("the notes written a week ago today", rows("survey_qs"),
    ref=[find(kind="note", when=U("day", -7, anchor="today")), ans(rows="@prev")]),
  T("pin that note", diff(upd("survey_qs", pinned=True)),
    ref=[act("edit", rows="@prev", args=lines(pinned="yes"))]),
  T("people linked to that note", rows("kim"),
    ref=[ans(kind="person", linked_to="$survey_qs")]))

S("T24-053-P", "ambiguous volleyball resolved by earlier turn reschedule count para",
  T("date of sofia's next away game", rows("vb_0924"),
    ref=[find(kind="event", name="Sofia volleyball game", where='description contains "away"'), ans(rows="@prev")]),
  T("volleyball game, make it 6:30 instead", diff(upd("vb_0924", date="2026-09-24T18:30")),
    ref=[act("reschedule", kind="event", name="Sofia volleyball game", args=lines(to=D("2026-09-24", "18:30"))),
         act("reschedule", rows="$vb_0924", args=lines(to=D("2026-09-24", "18:30")))]),
  T("this month, number of games for her", val(2),
    ref=[ans(op="count", kind="event", name="Sofia volleyball game", when=U("month", 0))]))

S("T24-057-P", "empty result debt find miss recover settle_debt para",
  T("ray and the uber debt, what's the amount", val((40, "USD")),
    ref=[find(kind="debt", name="Uber"), search("uber", kind="debt"), find(kind="debt", linked_to="$ray"),
         ans(op="max", field="amount", within="@prev")]),
  T("he paid me back at practice, so that one's settled, mark it", diff(upd("d_ray", status="settled")),
    ref=[act("settle_debt", rows="$d_ray")]))

S("T24-062-P", "debt open span date span para",
  T("up to last week, which debts are there",
    rows("d_gilbert", "d_beto", "d_yvonne", "d_jessica", "d_lupe", "d_ray", "d_rudy", "d_hector", "d_patty", "d_kim"),
    ref=[ans(kind="debt", when={"to": U("week", -1)})]),
  T("between the first and the tenth, what's the count", val(3),
    ref=[ans(op="count", kind="debt", when=span(D("2026-09-01"), D("2026-09-10")))]))

S("T24-068-P", "four turns event person count status open span duration count para",
  T("events next week with under two people attached",
    rows("cond_0921", "film_session", "gym_0922", "cond_0923", "gym_0924", "vb_0924", "fb_0925", "ref_clinic"),
    ref=[ans(kind="event", when=U("week", 1), where="person count < 2")]),
  T("cancelled ones prior to this week", rows("gym_0910", "elena_dinner", "game_night"),
    ref=[ans(kind="event", when={"to": U("week", -1)}, where='status = "cancelled"')]),
  T("which ones ran past 180 min, up to yesterday",
    rows("staff_dev", "coach_clinic", "yard_0829", "yard_0905", "yard_0912"),
    ref=[ans(kind="event", when={"to": U("day", -1)}, where="duration > 180 min")]),
  T("number of those that were rudy's landscaping jobs", val(3),
    ref=[ans(op="count", kind="event", within="@prev", name="Landscaping job")]))

S("T24-072-P", "photo datetime add_to named para",
  T("photo from 7:10am on the twelfth, which is it", rows("p_whit_before"),
    ref=[ans(kind="photo", when=D("2026-09-12", "07:10"))]),
  T("put it into rudy's yards", diff(link("yards_al", "p_whit_before")),
    ref=[act("add_to", rows="$p_whit_before", args=lines(to="$yards_al"))]))

S("T24-078-P", "six turns booster role != find-only edit group prev met star para",
  T("booster group members", rows("david_r", "yvonne", "patty", "gilbert", "me"),
    ref=[ans(kind="person", linked_to="$booster_g")]),
  T("among them, who isn't a team parent", rows("david_r"),
    ref=[ans(kind="person", within="@prev", where='role != "team parent" and role is set')]),
  T("exact name of the booster group?", rows("booster_g"),
    ref=[find(kind="group", name="booster"), ans(rows="@prev")]),
  T("its new name is Booster club 2026-27", diff(upd("booster_g", name="Booster club 2026-27")),
    ref=[act("edit", rows="@prev", args=lines(name="Booster club 2026-27"))]),
  T("people i met at Coronado High", rows("linda", "david_r"),
    ref=[ans(kind="person", where='met = "Coronado High"')]),
  T("David Ruiz gets a star", diff(upd("david_r", starred=True)),
    ref=[act("star", rows="$david_r")]))

S("T24-085-P", "ambiguous water bill complete narrow effort literal read para",
  T("finished Pay water bill", diff(upd("water_09", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay water bill")]),
  T("on the home list, which open items need twenty min or less", rows("ac_filter", "car_reg"),
    ref=[ans(kind="task", linked_to="$home_l", where='effort <= 20 and status = "open"')]),
  T("Renew car registration, how high is its priority", rows("car_reg"),
    ref=[ans(kind="task", name="Renew car registration")]))

S("T24-091-P", "notebook note count album photo count count list task count para",
  T("which notebooks hold under five notes", rows("hist_nb", "union_nb", "land_nb", "recipes_nb", "ideas_nb"),
    ref=[ans(kind="notebook", where="note count < 5")]),
  T("exactly seven photos in an album, which albums", rows("team_al", "fam_al"),
    ref=[ans(kind="album", where="photo count = 7")]),
  T("Andre Lujan appears in how many photos", val(4),
    ref=[ans(op="count", kind="photo", linked_to="$andre")]),
  T("lists carrying six or more tasks?", rows("home_l", "team_l", "school_l", "land_l"),
    ref=[ans(kind="list", where="task count >= 6")]))

S("T24-098-P", "four turns roster role contains lujan focus star para",
  T("Update team roster, who's listed", rows("ray"),
    ref=[ans(kind="person", linked_to="$roster")]),
  T("center player?", rows("andre"),
    ref=[ans(kind="person", where='role contains "center"')]),
  T("lujan gets a star", diff(upd("andre", starred=True)),
    ref=[act("star", kind="person", name="Lujan")]),
  T("his mom too", diff(upd("veronica", starred=True)),
    ref=[act("star", rows="$veronica")]))

S("T24-A005-P", "ask-options debt settle_debt c3a para",
  T("gas one, mark as settled", ask("d_hector", "d_veronica"),
    ref=[act("settle_debt", kind="debt", name="gas"),
         askc("Hector's gas money (you owe 60) or Veronica's carpool gas (she owes you 55)?", options="$d_hector, $d_veronica")]),
  T("the veronica one, paid cash at practice", diff(upd("d_veronica", status="settled")),
    ref=[act("settle_debt", rows="$d_veronica")]))

S("T24-A009-P", "follow-up c3a para",
  T("who owes me money", rows("d_veronica", "d_patty", "d_gilbert", "d_marisol", "d_ray", "d_rudy"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("over 50 among them", rows("d_veronica", "d_patty", "d_rudy"),
    ref=[ans(within="@prev", where="amount > 50 USD")]),
  T("largest?", rows("d_rudy"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T24-B005-P", "c4b state-change cancel event restore trashed task para",
  T("checkup's been called off by dr anand's office", diff(upd("checkup", status="cancelled")),
    ref=[act("cancel", kind="event", name="Checkup")]),
  T("treadmill one, restore it", diff(restore("treadmill")),
    ref=[act("restore", kind="task", name="treadmill", trashed=True)]))

S("T24-C101-P", "c3c bulk delete per kind decline unbounded then bounded act last year para",
  T("wipe everything", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fine, limit it to everything dated last year", diff(trash("p_juarez_plaza"), unlink("juarez_al", "p_juarez_plaza"), trash("p_juarez_cathedral"), unlink("juarez_al", "p_juarez_cathedral"), trash("p_juarez_family"), unlink("juarez_al", "p_juarez_family")),
    ref=[find(kind="event,task,note,document,photo", when=W(U("year", -1))),
         act("delete", rows="$p_juarez_plaza, $p_juarez_cathedral, $p_juarez_family")]))

S("T24-103-P", "ask options person log balance settle para",
  T("garza, put a visit in the log", ask("rudy", "marisol"),
    ref=[act("log", kind="person", name="Garza", args=lines(kind="visit")),
         askc("rudy garza or marisol garza?", options="$rudy, $marisol")]),
  T("marisol's the one, i dropped off the party stuff", diff(upd("marisol", date=ANY)),
    ref=[act("log", rows="$marisol", args=lines(kind="visit"))]),
  T("where do we stand, her and me", val((45, "USD")),
    ref=[ans(op="balance", rows="$marisol")]),
  T("paid back by her, so mark it settled", diff(upd("d_marisol", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$marisol")]))

S("T24-108-P", "contrast reschedule event context balance para",
  T("date of mateo's dentist", rows("dentist_mateo"),
    ref=[ans(kind="event", name="Dentist Mateo")]),
  T("dentist slot moves to 6", diff(upd("dentist_mateo", date="2026-09-22T18:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("mateo's science fair, 7 instead", diff(upd("science_fair", date="2026-10-15T19:00")),
    ref=[act("reschedule", kind="event", name="Mateo's science fair", args=lines(to=U("day", 0, anchor="row", time="19:00")))]),
  T("ray and the lunch, does he owe me", val((40, "USD")),
    ref=[ans(op="balance", kind="person", name="Ray Dominguez")]))
