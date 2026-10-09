from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T15-026", "seven turns pusur vet reschedule people notes photos span",
  T("when's pusur's vet thing", rows("vet_1112", "vet_1215"),
    ref=[ans(kind="event", name="Pusur")]),
  T("the check, move it to tomorrow at 4", diff(upd("vet_1112", date="2026-11-10T16:00")),
    ref=[act("reschedule", rows="$vet_1112", args=lines(to=U("day", 1, time="16:00")))]),
  T("who's the vet again", rows("ane"),
    ref=[ans(kind="person", linked_to="$vet_1112")]),
  T("did i write anything down about his limp", rows("pusur_note"),
    ref=[ans(kind="note", name="limp")]),
  T("pusur pics since first nov 9am", rows("p_pusur_box", "p_pusur_window"),
    ref=[ans(kind="photo", linked_to="$pusur_al", when=W({"from": D("2026-11-01", "09:00")}))]),
  T("star the snow one", diff(upd("p_pusur_window", starred=True)),
    ref=[act("star", rows="$p_pusur_window")]),
  T("did i get the cat food yet", rows("cat_food"),
    ref=[ans(kind="task", name="cat food")]))

S("T15-027", "trashed person empty recovery restore prev log restore window ask create",
  T("is kristoffer in my contacts", rows("kristoffer"),
    ref=[ans(kind="person", name="Kristoffer"),
         ans(kind="person", name="Kristoffer", trashed=True)]),
  T("bring him back, he's moving back up north", diff(restore("kristoffer")),
    ref=[act("restore", rows="@prev")]),
  T("log a call, talked to him", diff(upd("kristoffer", date=ANY)),
    ref=[act("log", rows="$kristoffer", args=lines(kind="call"))]),
  T("restore lars moen too", ask(),
    ref=[bad(act("restore", kind="person", name="Lars Moen", trashed=True)),
         askc("lars moen was binned more than 30 days ago so he can't be restored. add him again as a new contact?")]),
  T("yes. former colleague, norwegian polar institute", diff(new("person", name="Lars Moen", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Lars Moen", role="former colleague, Norwegian Polar Institute"))]))

S("T15-028", "create person delete restore new",
  T("add a contact Nils Eriksen, second mate, r/v havella", diff(new("person", name="Nils Eriksen", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Nils Eriksen", role="second mate, R/V Havella"))]),
  T("hmm wrong guy, delete him", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("ugh no it was right, erik confirmed. bring him back", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T15-029", "group currency in balance min debts",
  T("which of my groups aren't in kroner", rows("kiel", "abisko"),
    ref=[find(kind="group", where='currency in ("EUR", "SEK")'), ans(rows="@prev")]),
  T("where do me and jan schröder stand", val((115, "EUR")),
    ref=[ans(op="balance", rows="$jan")]),
  T("smallest thing anyone owes me?", val((75, "NOK")),
    ref=[ans(op="min", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]))

S("T15-030", "bouldering open span cancel span duration people",
  T("what bouldering nights have i got from next monday on", rows("boulder_1117", "boulder_1215"),
    ref=[ans(kind="event", name="Bouldering night", when=W({"from": U("week", 1, weekday=1)}))]),
  T("cancel the first one, it's marte's defence party that night", diff(upd("boulder_1117", status="cancelled")),
    ref=[act("cancel", rows="$boulder_1117")]),
  T("what's on between next monday and friday lunchtime",
    rows("survival", "boulder_1117", "defence", "plan_1118", "car_service", "agm", "labmtg_1120", "drill"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=5, time="12:00"))))]),
  T("any of those an hour and a half long", rows("plan_1118"),
    ref=[ans(within="@prev", where="duration = 90")]),
  T("who's coming to it", rows("erik_n", "hallvard", "tor"),
    ref=[ans(kind="person", linked_to="$plan_1118")]))

S("T15-031", "debt date substitution",
  T("what debts are from the fifth", rows("d_silje"),
    ref=[ans(kind="debt", when=W(D("2026-11-05")))]),
  T("and the fourth", rows("d_hallvard"),
    ref=[ans(kind="debt", when=W(D("2026-11-04")))]))

S("T15-032", "trashed locker restore reveal restore window",
  T("did i delete the netflix login", rows("old_netflix"),
    ref=[ans(kind="locker item", name="Netflix", trashed=True)]),
  T("restore it, we're getting it back for the dark season", diff(restore("old_netflix")),
    ref=[act("restore", rows="$old_netflix")]),
  T("what's the password on it", diff(reveal=[("old_netflix", "fjord-films-2")]),
    ref=[act("reveal", rows="$old_netflix", args=lines(field="password"))]),
  T("bring back the old strava login as well", ask(),
    ref=[bad(act("restore", kind="locker item", name="Old Strava login", trashed=True)),
         askc("the strava login has been in the bin over 30 days, so it can't come back. make a new entry for it?")]))

S("T15-033", "single locker url",
  T("which locker entry is for https://uit.no", rows("uit_login"),
    ref=[find(kind="locker item", where='url = "https://uit.no"'), ans(rows="@prev")]))

S("T15-034", "notes person count span edit pin",
  T("notes that aren't linked to anyone",
    rows("woodstove", "fixation", "subsample", "kvaloya", "arctic_book", "wishlist", "waffles", "ice_edge", "lipid",
         "seminar_notes"),
    ref=[find(kind="note", where="person count < 1"), ans(rows="@prev")]),
  T("the ones from last month through last friday", rows("wishlist", "waffles", "ice_edge", "lipid", "seminar_notes"),
    ref=[ans(within="@prev", when=W(span(U("month", -1), U("week", -1, weekday=5))))]),
  T("pin the seminar outline", diff(upd("seminar_notes", pinned=True)),
    ref=[act("edit", rows="$seminar_notes", args=lines(pinned="yes"))]))

S("T15-035", "task span effort reschedule",
  T("what's due between the twelfth and next friday",
    rows("formalin", "station_log", "marte_ch", "report", "send_report", "firewood", "snow_shovel", "gloves", "tap",
         "rope", "cruise_plan", "suit", "freezer", "agenda", "crew_list", "ctd", "present", "nets", "jars", "claim",
         "batteries", "power_11"),
    ref=[ans(kind="task", when=W(span(D("2026-11-12"), U("week", 1, weekday=5))))]),
  T("which of those are two hours or more", rows("marte_ch", "report", "ctd", "jars"),
    ref=[ans(within="@prev", where="effort >= 120")]),
  T("label sample jars, move it to next thursday", diff(upd("jars", date="2026-11-19")),
    ref=[act("reschedule", kind="task", name="Label sample jars", args=lines(to=U("week", 1, weekday=4)))]),
  T("is the ctd calibration in progress", rows("ctd"),
    ref=[ans(kind="task", name="Calibrate CTD sensors")]))

S("T15-037", "photos album count add_to albums photo count",
  T("photos with no album assigned",
    rows("p_sauna", "p_abisko", "p_seminar", "p_receipt", "p_ctd", "p_kiel", "p_mum", "p_tyres", "p_marte", "p_fjord"),
    ref=[find(kind="photo", where="album count <= 0"), ans(rows="@prev")]),
  T("put the sauna one in climbing 2026", diff(link("climb_al", "p_sauna")),
    ref=[act("add_to", rows="$p_sauna", args=lines(to="$climb_al"))]),
  T("which albums aren't empty", rows("cruise_al", "aurora_al", "pusur_al", "climb_al", "cabin_al", "best_al"),
    ref=[ans(kind="album", where="photo count != 0")]))

S("T15-038", "ambiguous document star ask folder",
  T("star the cruise report", ask("report_09", "report_10"),
    ref=[act("star", kind="document", name="Cruise report"),
         askc("hv-2609 or the hv-2610 draft?", options="$report_09, $report_10")]),
  T("the 2610 draft", diff(upd("report_10", starred=True)),
    ref=[act("star", rows="$report_10")]),
  T("what's else in cruise reports", rows("report_09"),
    ref=[ans(kind="document", linked_to="$reports_f", exclude="$report_10")]))

S("T15-039", "ambiguous list edit multi",
  T("set the area on the cruise list to at sea", ask("prep_l", "gear_l"),
    ref=[act("edit", kind="list", name="Cruise", args=lines(area="at sea")),
         askc("cruise prep or cruise gear?", options="$prep_l, $gear_l")]),
  T("both of them", diff(upd("prep_l", area="at sea"), upd("gear_l", area="at sea")),
    ref=[act("edit", rows="$prep_l, $gear_l", args=lines(area="at sea"))]))

S("T15-040", "refused group delete never mind empty group delete undo",
  T("delete the abisko ski trip group, that was march", ask(),
    ref=[bad(act("delete", kind="group", name="Abisko ski trip")),
         askc("the abisko ski trip still has expenses in it, so it can't be deleted. rename it instead?")]),
  T("nah leave it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("who's in the whale safari one", rows("silje", "ingvild", "me"),
    ref=[ans(kind="person", linked_to="$whale")]),
  T("delete that group, the trip's cancelled",
    diff(gone("whale"), unlink("whale", "silje"), unlink("whale", "ingvild"), unlink("whale", "me")),
    ref=[act("delete", rows="$whale")]),
  T("undo, silje wants to rebook it",
    diff(),
    ref=[act("undo")]))

S("T15-041", "task status in description ne person count",
  T("what's open or in progress on cruise prep", rows("nets", "ctd", "formalin", "cruise_plan", "freezer", "crew_list", "med_new"),
    ref=[ans(kind="task", linked_to="$prep_l", where='status in ("open", "in_progress")')]),
  T("leave out the formalin one, the one that says 2 x 5 litres from chemtrade",
    rows("nets", "ctd", "cruise_plan", "freezer", "crew_list", "med_new"),
    ref=[ans(within="@prev", where='description != "2 x 5 litres from Chemtrade"')]),
  T("which of those have someone else on them", rows("nets", "ctd", "cruise_plan", "freezer", "crew_list"),
    ref=[ans(within="@prev", where="person count != 0")]),
  T("biggest one?", val(240),
    ref=[ans(op="max", field="effort", within="@prev")]))

S("T15-042", "list area contains task count",
  T("which lists are work ones", rows("prep_l", "gear_l", "lab_l"),
    ref=[find(kind="list", where='area contains "work"'), ans(rows="@prev")]),
  T("and which have five tasks or fewer", rows("climb_l", "gear_l", "shop_l"),
    ref=[ans(kind="list", where="task count <= 5")]))

S("T15-043", "locker notes contains star trashed find",
  T("which locker entry has my wall access card", rows("club_card"),
    ref=[ans(kind="locker item", where='notes contains "access card"')]),
  T("star it", diff(upd("club_card", starred=True)),
    ref=[act("star", rows="$club_card")]),
  T("what's in the locker trash", rows("old_netflix", "old_tinder"),
    ref=[find(kind="locker item", trashed=True), ans(rows="@prev")]))

S("T15-044", "person cadence set task count photo count",
  T("who have i set a keep-in-touch rhythm for but not starred",
    rows("dad", "anders", "berit", "erik_n", "marianne", "marte", "geir", "jan", "ingvild", "erik_j", "silje", "torstein",
         "bjorn"),
    ref=[ans(kind="person", where="cadence is set and starred = no")]),
  T("who's got exactly two tasks tied to them", rows("erik_n", "tor", "erik_j", "jan", "silje"),
    ref=[ans(kind="person", where="task count = 2")]),
  T("which of them turn up in photos", rows("erik_n", "tor", "erik_j", "jan", "silje"),
    ref=[ans(within="@prev", where="photo count != 0")]))

S("T15-045", "single debt status empty",
  T("any debts with no status on them", rows(),
    ref=[ans(kind="debt", where="status is empty")]))

S("T15-046", "document anchor dates span ambiguous payslip",
  T("anything i scanned yesterday at 17:45", rows("tyre_receipt"),
    ref=[ans(kind="document", when=W(U("day", -1, anchor="today", time="17:45")))]),
  T("and what did i add last week", rows("cabin_invoice", "report_10", "tyre_receipt"),
    ref=[ans(kind="document", when=W(U("week", -1, anchor="today")))]),
  T("docs from october up to friday noon", rows("kiel_dsa", "pay_oct", "cabin_invoice"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=10), U("week", -1, weekday=5, time="12:00"))))]),
  T("star the payslip from that", diff(upd("pay_oct", starred=True)),
    ref=[act("star", kind="document", name="Payslip"),
         act("star", rows="$pay_oct")]))

S("T15-047", "debt open span weekday",
  T("debts since last monday", rows("d_hallvard", "d_silje", "d_jonas_groceries", "d_torstein"),
    ref=[ans(kind="debt", when=W({"from": U("week", -1, weekday=1)}))]),
  T("only up to the fifth", rows("d_hallvard", "d_silje"),
    ref=[ans(kind="debt", when=W(span(U("week", -1, weekday=1), D("2026-11-05"))))]))

S("T15-048", "six turns planning meeting reschedule log multi linked_to all",
  T("when's the next cruise planning meeting", rows("plan_1111"),
    ref=[ans(kind="event", name="Cruise planning meeting", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("move it to thursday same time", diff(upd("plan_1111", date="2026-11-12T13:00")),
    ref=[act("reschedule", rows="$plan_1111", args=lines(to=U("week", 0, weekday=4, time="13:00")))]),
  T("who's in it", rows("erik_n", "hallvard"),
    ref=[ans(kind="person", linked_to="$plan_1111")]),
  T("log a call with both, told them about the move", diff(upd("erik_n", date=ANY), upd("hallvard", date=ANY)),
    ref=[act("log", rows="$erik_n, $hallvard", args=lines(kind="call"))]),
  T("what tasks are they both on", rows("cruise_plan"),
    ref=[ans(kind="task", linked_to="$erik_n, $hallvard")]),
  T("when's that due", rows("cruise_plan"),
    ref=[ans(rows="$cruise_plan")]))

S("T15-049", "photo delete undo albums",
  T("delete tor fixing the winch", diff(trash("p_winch"), unlink("cruise_al", "p_winch")),
    ref=[act("delete", rows="$p_winch")]),
  T("wait no, undo. tor wants a copy", diff(restore("p_winch"), link("cruise_al", "p_winch")),
    ref=[act("undo")]),
  T("what other pics of tor have i got", rows("p_crew"),
    ref=[ans(kind="photo", linked_to="$tor", exclude="$p_winch")]))

S("T15-050", "event trashed recovery restore undo date",
  T("when's yoga", rows("yoga"),
    ref=[ans(kind="event", name="Yoga"),
         ans(kind="event", name="Yoga", trashed=True)]),
  T("restore it, i'll go after all", diff(restore("yoga")),
    ref=[act("restore", rows="$yoga")]),
  T("undo that, the survival course is the same day", diff(trash("yoga")),
    ref=[act("undo")]),
  T("what's on that monday", rows("survival"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=1)))]))

X("T15-029",
  T("and my balance with jonas and torstein", ask("jonas", "torstein"),
    ref=[bad(ans(op="balance", rows="$jonas, $torstein")),
         askc("a balance is one person at a time. jonas or torstein first?", options="$jonas, $torstein")]),
  T("jonas first", val((610, "NOK"), (-700, "SEK")),
    ref=[ans(op="balance", rows="$jonas")]),
  T("now torstein", val((10, "NOK")),
    ref=[comp(op="balance", rows="$torstein"), ans(value="@prev")]))

X("T15-031",
  T("add a task: pick up the survival suit from bjørn", diff(new("task", name=has("survival suit"))),
    ref=[act("create", args=lines(kind="task", name="Pick up the survival suit from Bjørn"))]),
  T("undo that, he's dropping it off", diff(trash("+1")),
    ref=[act("undo")]))

X("T15-042",
  T("what's on the list for the svalbard trip", decline("not_found"),
    ref=[search("Svalbard"), dec("not_found")]))

X("T15-047",
  T("does kapteinen owe me anything", val((200, "NOK")),
    ref=[search("Kapteinen", kind="person"), ans(op="balance", rows="$erik_n")]))
