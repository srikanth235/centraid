from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T17-026", "five turns lessons span duration anchor reschedule substitution",
  T("what lessons have i got monday to thursday next week", rows("ivan_0202", "maria_0204", "maria_k_lesson"),
    ref=[ans(kind="event", name="lesson", when=W(span(U("week", 1, weekday=1), U("week", 1, weekday=4))))]),
  T("which of those isn't a full hour", rows("ivan_0202"),
    ref=[ans(kind="event", within="@prev", where="duration != 60")]),
  T("move ivan's half an hour earlier, he's got football after", diff(upd("ivan_0202", date="2026-02-02T16:30")),
    ref=[act("reschedule", rows="$ivan_0202", args=lines(to=U("minute", -30, anchor="row")))]),
  T("how's monday shaping up after that", rows("walkthrough", "ivan_0202", "vesi_reh"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=1)))]),
  T("and tuesday?", rows("ptm", "choir_0203"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=2)))]),
  T("put an extra lesson with maria on friday at 5", ask("maria_d", "maria_k"),
    ref=[find(kind="person", name="Maria"),
         askc("maria dimitrova or maria koleva?", options="$maria_d, $maria_k")]))

S("T17-027", "act ambiguous dentist ask options pick",
  T("move the dentist to 11", ask("dentist_v", "dentist_me"),
    ref=[act("reschedule", kind="event", name="dentist", args=lines(to=D("2026-02-10", "11:00"))),
         askc("which dentist, viktor's on the 4th or yours on the 10th?", options="$dentist_v, $dentist_me")]),
  T("mine, not viktor's", diff(upd("dentist_me", date="2026-02-10T11:00")),
    ref=[act("reschedule", rows="$dentist_me", args=lines(to=D("2026-02-10", "11:00")))]),
  T("and viktor's is at 3?", rows("dentist_v"),
    ref=[ans(rows="$dentist_v")]))

S("T17-028", "act ambiguous choir concert ask options edit description",
  T("change the choir concert description to Bulgaria Hall, main stage", ask("concert_dec", "concert_mar"),
    ref=[act("edit", kind="event", name="Choir concert", args=lines(description="Bulgaria Hall, main stage")),
         find(kind="event", name="Choir concert"),
         askc("there are two, december's and the one on march 14. which one?", options="$concert_dec, $concert_mar")]),
  T("the march one obviously", diff(upd("concert_mar", description="Bulgaria Hall, main stage")),
    ref=[act("edit", rows="$concert_mar", args=lines(description="Bulgaria Hall, main stage"))]))

S("T17-029", "ambiguous album ask options delete album",
  T("delete the recital album", ask("recital24", "recital25"),
    ref=[act("delete", kind="album", name="Recital"),
         askc("recital 2024 or recital 2025?", options="$recital24, $recital25")]),
  T("the 2024 one, those are all on the school site",
    diff(gone("recital24"), unlink("recital24", "r24_bow"), unlink("recital24", "r24_stage")),
    ref=[act("delete", rows="$recital24")]),
  T("what recital albums are left", rows("recital25"),
    ref=[ans(kind="album", name="Recital")]))

S("T17-030", "ambiguous album pick from conversation rename count album photo count",
  T("which album is boris's first recital in", rows("recital25"),
    ref=[ans(kind="album", linked_to="$r25_boris")]),
  T("rename the recital album to June recital 2025", diff(upd("recital25", name="June recital 2025")),
    ref=[act("edit", kind="album", name="Recital", args=lines(name="June recital 2025")),
         act("edit", rows="$recital25", args=lines(name="June recital 2025"))]),
  T("how many photos in it", val(4),
    ref=[ans(op="count", kind="photo", linked_to="$recital25")]),
  T("which albums have two photos or less", rows("recital24", "vienna_album"),
    ref=[ans(kind="album", where="photo count <= 2")]))

S("T17-031", "empty result group recovery balance nickname members",
  T("what's mila's position in the renovation group", val((-300, "BGN")),
    ref=[find(kind="group", name="Renovation"),
         ans(op="balance", kind="group", name="Bathroom works", linked_to="$mila")]),
  T("and mama's?", val((0, "BGN")),
    ref=[search("mama", kind="person"),
         ans(op="balance", kind="group", name="Bathroom works", linked_to="$radka")]),
  T("who's actually in that group", rows("mila", "radka", "me"),
    ref=[ans(kind="person", linked_to="$bathroom_g")]))

S("T17-032", "empty result group find miss search delete group trash event",
  T("who's in the bansko trip group", rows("mila", "viktor", "me"),
    ref=[find(kind="group", name="Bansko trip"),
         search("bansko", kind="group"),
         ans(kind="person", linked_to="$bansko")]),
  T("trip's off, delete the group", diff(gone("bansko"), unlink("bansko", "mila"), unlink("bansko", "viktor"),
                                         unlink("bansko", "me")),
    ref=[act("delete", rows="$bansko")]),
  T("delete the calendar entry for it too", diff(trash("bansko_ev")),
    ref=[act("delete", kind="event", name="Bansko ski weekend")]))

S("T17-033", "trashed events find-only restore window refused ask restore",
  T("what's in the trash from my calendar", rows("coffee_desi", "choir_party"),
    ref=[find(kind="event", trashed=True), ans(rows="@prev")]),
  T("bring back the christmas party one", ask(),
    ref=[bad(act("restore", rows="$choir_party")),
         askc("it was binned on dec 22, over 30 days ago, so it can't come back. add it again as a new event?")]),
  T("nah. restore the coffee with desi", diff(restore("coffee_desi")),
    ref=[act("restore", kind="event", name="Coffee with Desi", trashed=True)]))

S("T17-034", "restore window event refused ask create past event",
  T("restore christmas choir party", ask(),
    ref=[bad(act("restore", kind="event", name="Christmas choir party", trashed=True)),
         askc("that one's been in the bin since december 22, too long to restore. should i add it again?")]),
  T("no, forget it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T17-035", "refused delete folder ask read decline",
  T("delete the renovation folder, it's all in my email", ask(),
    ref=[bad(act("delete", rows="$reno_f")),
         askc("the renovation folder still has documents in it, so it can't be deleted. move or bin them first?")]),
  T("what's in it", rows("contract", "quote_bath", "tiles_invoice", "floor_plan"),
    ref=[ans(kind="document", linked_to="$reno_f")]),
  T("ok leave it then", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T17-036", "refused delete folder multi delete empty folder read",
  T("delete the scans folder and the taxes one", diff(gone("scans_f")),
    ref=[bad(act("delete", rows="$scans_f, $tax_f")),
         act("delete", rows="$scans_f")]),
  T("why's taxes still there", rows("tax_2024", "income_2025"),
    ref=[ans(kind="document", linked_to="$tax_f")]))

S("T17-037", "folder of doc linked_to prev exclude star",
  T("which folder is the custody agreement in", rows("viktor_f"),
    ref=[ans(kind="folder", linked_to="$custody")]),
  T("what else is in there", rows("custody", "report_card", "trip_consent"),
    ref=[ans(kind="document", linked_to="@prev")]),
  T("star the report card", diff(upd("report_card", starred=True)),
    ref=[act("star", rows="$report_card")]))

S("T17-038", "find folder linked_to prev linked_to all empty",
  T("what's in my choir folder", rows("rach_score", "vienna_list"),
    ref=[find(kind="folder", name="Choir"), ans(kind="document", linked_to="@prev")]),
  T("anything that's in both choir and students?", rows(),
    ref=[ans(kind="document", linked_to="$choir_f, $students_f")]))

S("T17-039", "starred photo album unstar prev read empty",
  T("starred pics in the bathroom album", rows("bath_before"),
    ref=[ans(kind="photo", linked_to="$reno_album", where="starred = yes")]),
  T("unstar it, it's depressing", diff(upd("bath_before", starred=False)),
    ref=[act("unstar", rows="@prev")]),
  T("any starred ones left in there", rows(),
    ref=[ans(kind="photo", linked_to="$reno_album", where="starred = yes")]))

S("T17-040", "photo album count unstar prev",
  T("which starred photos are in two or more albums", rows("r25_group"),
    ref=[ans(kind="photo", where="starred = yes and album count >= 2")]),
  T("unstar that one", diff(upd("r25_group", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T17-041", "remove_from photo prev multi album count",
  T("which pics in the choir album are also in some other album", rows("r25_group", "plovdiv_old"),
    ref=[ans(kind="photo", linked_to="$choir_album", where="album count >= 2")]),
  T("take those out of choir", diff(unlink("choir_album", "r25_group"), unlink("choir_album", "plovdiv_old")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$choir_album"))]),
  T("what's left in it", rows("choir_xmas", "choir_warmup", "choir_altos"),
    ref=[ans(kind="photo", linked_to="$choir_album")]))

S("T17-042", "photo of person remove_from prev album empty",
  T("photos with mitko in them", rows("bath_measure"),
    ref=[search("mitko", kind="person"), ans(kind="photo", linked_to="$mitko")]),
  T("pull it from the bathroom album, he doesn't want to be in it", diff(unlink("reno_album", "bath_measure")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$reno_album"))]),
  T("is it in any album", rows(),
    ref=[ans(kind="album", linked_to="$bath_measure")]))

S("T17-043", "create locker login delete new",
  T("save a login for the music school portal, username e.petrova",
    diff(new("locker item", name=has("Music", "school", "portal"))),
    ref=[act("create", args=lines(kind="locker item", name="Music school portal", type="login", username="e.petrova"))]),
  T("hm it's the same as the school pc one, delete the new entry", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T17-044", "create locker membership delete new undo",
  T("add my Pulse Fitness membership to the locker", diff(new("locker item", name=has("Pulse", "Fitness"))),
    ref=[act("create", args=lines(kind="locker item", name="Pulse Fitness", type="membership"))]),
  T("wait i cancelled that gym last week, remove it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("undo that, it actually runs till march", diff(restore("+1")),
    ref=[act("undo")]))

S("T17-045", "single reveal locker where wifi",
  T("read me the wifi password, a parent's asking", diff(reveal=[("wifi", "steinway-b-211")]),
    ref=[act("reveal", kind="locker item", where='type = "wifi"', args=lines(field="password"))]))

S("T17-046", "single reveal locker where note content",
  T("what's the studio alarm code again, i'm standing at the door", diff(reveal=[("alarm", "7-3-9-1")]),
    ref=[act("reveal", kind="locker item", where='type = "note"', args=lines(field="content"))]))

S("T17-047", "notebook read delete notebook named",
  T("what's in diary 2019", rows("diary_june"),
    ref=[ans(kind="note", linked_to="$diary_nb")]),
  T("delete that notebook, keep the note", diff(gone("diary_nb"), unlink("diary_nb", "diary_june")),
    ref=[act("delete", rows="$diary_nb")]))

S("T17-048", "single delete notebook named",
  T("delete the teaching ideas notebook", diff(gone("ideas_nb"), unlink("ideas_nb", "ideas_games")),
    ref=[act("delete", rows="$ideas_nb")]))

S("T17-049", "edit list named area empty",
  T("rename the Shopping list to Errands", diff(upd("shopping_l", name="Errands")),
    ref=[act("edit", rows="$shopping_l", args=lines(name="Errands"))]),
  T("and give it the area home", diff(upd("shopping_l", area="home")),
    ref=[act("edit", rows="$shopping_l", args=lines(area="home"))]),
  T("which lists have no area", rows("choir_l"),
    ref=[ans(kind="list", where="area is empty")]))

S("T17-050", "list area empty edit list named",
  T("which of my lists don't have an area", rows("choir_l", "shopping_l"),
    ref=[ans(kind="list", where="area is empty")]),
  T("set the choir list's area to music", diff(upd("choir_l", area="music")),
    ref=[act("edit", rows="$choir_l", args=lines(area="music"))]),
  T("and what's on my errands list", decline("not_found"),
    ref=[find(kind="list", name="Errands"), search("errands", kind="list"), dec("not_found")]))
