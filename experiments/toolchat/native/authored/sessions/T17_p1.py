from gold import *
import json
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
WEEKEND = {"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}
NEXT_WEEKEND = {"from": U("week", 1, weekday=6), "to": U("week", 1, weekday=7)}
def J(d):
    return json.dumps(d, separators=(",", ":"))
LIVE = 'status = "open"'
LIVE_EV = 'status != "cancelled"'
def next_ivan():
    return find(kind="event", name="Ivan's lesson", when=W({"from": U("day", 0)}), order="date asc", limit=1)
def rehearsals():
    return find(kind="event", name="Choir rehearsal", when=W({"from": U("day", 0)}))


S("T17-001-P", "trashed people find-only restore multi restore window ask para",
  T("recently deleted contacts?", rows("emil", "rositsa", "ognyan"),
    ref=[find(kind="person", trashed=True), ans(rows="@prev")]),
  T("emil's returning for lessons, so restore him and rositsa", diff(restore("emil"), restore("rositsa")),
    ref=[act("restore", rows="$emil, $rositsa")]),
  T("same for ognyan", ask(),
    ref=[find(kind="person", name="Ognyan", trashed=True),
         bad(act("restore", rows="$ognyan")),
         askc("ognyan's been in the bin since november, past the 30 days, so he can't be restored. add him again as a new contact?")]))

S("T17-011-P", "events next week cancel multi para",
  T("next week, anything lined up", rows("walkthrough", "vesi_reh", "ivan_0202", "ptm", "choir_0203", "dentist_v", "maria_0204",
                               "sectional", "vesi_exam", "maria_k_lesson", "tiles_delivery", "kalina_lesson",
                               "basket_feb", "handover_0208"),
    ref=[ans(kind="event", when=W(U("week", 1)))]),
  T("i'll be wrecked after the exam, so cancel kalina's lesson and the alto sectional",
    diff(upd("sectional", status="cancelled"), upd("kalina_lesson", status="cancelled")),
    ref=[act("cancel", rows="$sectional, $kalina_lesson")]))

S("T17-016-P", "single reopen task where para",
  T("reopen the finished item on my shopping list, wrong cartridge came with the ink",
    diff(upd("ink", status="open", completed=None)),
    ref=[act("reopen", kind="task", linked_to="$shopping_l", where='status = "completed"')]))

S("T17-022-P", "create document ask without options para",
  T("i need a doc for Viktor's summer schedule, create it", diff(new("document", name="Viktor's summer schedule")),
    ref=[act("create", args=lines(kind="document", name="Viktor's summer schedule"))]),
  T("set a reminder on it too", ask(),
    ref=[askc("sure, when should i remind you, and should it be a task?")]))

S("T17-028-P", "act ambiguous choir concert ask options edit description para",
  T("for the choir concert, put Bulgaria Hall, main stage as its description", ask("concert_dec", "concert_mar"),
    ref=[act("edit", kind="event", name="Choir concert", args=lines(description="Bulgaria Hall, main stage")),
         find(kind="event", name="Choir concert"),
         askc("there are two, december's and the one on march 14. which one?", options="$concert_dec, $concert_mar")]),
  T("obviously march", diff(upd("concert_mar", description="Bulgaria Hall, main stage")),
    ref=[act("edit", rows="$concert_mar", args=lines(description="Bulgaria Hall, main stage"))]))

S("T17-033-P", "trashed events find-only restore window refused ask restore para",
  T("calendar items in the trash", rows("coffee_desi", "choir_party"),
    ref=[find(kind="event", trashed=True), ans(rows="@prev")]),
  T("christmas party one, restore it", ask(),
    ref=[bad(act("restore", rows="$choir_party")),
         askc("it was binned on dec 22, over 30 days ago, so it can't come back. add it again as a new event?")]),
  T("no. coffee with desi is the one to restore", diff(restore("coffee_desi")),
    ref=[act("restore", kind="event", name="Coffee with Desi", trashed=True)]))

S("T17-039-P", "starred photo album unstar prev read empty para",
  T("bathroom album's starred photos", rows("bath_before"),
    ref=[ans(kind="photo", linked_to="$reno_album", where="starred = yes")]),
  T("it's depressing, take its star off", diff(upd("bath_before", starred=False)),
    ref=[act("unstar", rows="@prev")]),
  T("still anything starred in there", rows(),
    ref=[ans(kind="photo", linked_to="$reno_album", where="starred = yes")]))

S("T17-045-P", "single reveal locker where wifi para",
  T("a parent's asking, read out the wifi password", diff(reveal=[("wifi", "steinway-b-211")]),
    ref=[act("reveal", kind="locker item", where='type = "wifi"', args=lines(field="password"))]))

S("T17-050-P", "list area empty edit list named para",
  T("lists lacking an area", rows("choir_l", "shopping_l"),
    ref=[ans(kind="list", where="area is empty")]),
  T("choir list's area becomes music", diff(upd("choir_l", area="music")),
    ref=[act("edit", rows="$choir_l", args=lines(area="music"))]),
  T("errands list contents?", decline("not_found"),
    ref=[find(kind="list", name="Errands"), search("errands", kind="list"), dec("not_found")]))

S("T17-058-P", "four turns notes person count open edit para",
  T("notes linked to someone", rows("maria_notes", "ivan_notes", "niki_notes", "kalina_notes", "vienna_plan",
                                          "seating", "mitko_calls", "stefan_call", "viktor_school", "vesi_tempi",
                                          "gift_ideas", "banitsa"),
    ref=[ans(kind="note", where="person count > 0")]),
  T("more than one person on them", rows("seating", "viktor_school", "gift_ideas"),
    ref=[ans(kind="note", within="@prev", where="person count > 1")]),
  T("pull up gift ideas", rows("gift_ideas"),
    ref=[opn("$gift_ideas"), ans(rows="$gift_ideas")]),
  T("throw in a line for it, viktor: new headphones", diff(upd("gift_ideas", body=has("headphones"))),
    ref=[act("edit", rows="$gift_ideas",
             args=lines(body="Mama a warm scarf, Mila opera tickets, Viktor new headphones"))]))

S("T17-063-P", "four turns photo spans count within person count star para",
  T("number of photos taken between the christmas concert, dec twentieth 6pm, and the end of january", val(19),
    ref=[ans(op="count", kind="photo", when=W(span(D("2025-12-20", "18:00"), U("month", 0, name=1))))]),
  T("last week until yesterday 8pm, list those photos",
    rows("bath_tiles", "choir_warmup", "receipt_tiles", "bath_measure", "niki_hands", "v_basket", "mama_mila",
         "piano_keys", "whiteboard", "vesi_duo"),
    ref=[ans(kind="photo", when=W(span(U("week", -1), U("day", -1, time="20:00"))))]),
  T("those with someone in them", rows("choir_warmup", "bath_measure", "niki_hands", "v_basket", "mama_mila", "vesi_duo"),
    ref=[ans(kind="photo", within="@prev", where="person count > 0")]),
  T("give the vesi and me after rehearsal photo a star", diff(upd("vesi_duo", starred=True)),
    ref=[act("star", rows="$vesi_duo")]))

S("T17-068-P", "four turns locker url contains notes empty edit create para",
  T("locker entries whose url has google", rows("gmail"),
    ref=[ans(kind="locker item", where='url contains "google"')]),
  T("non-login ones lacking notes", rows("visa", "id_card", "wifi", "school_pc", "licence"),
    ref=[ans(kind="locker item", where='type != "login" and notes is empty')]),
  T("driving licence gets a note: renew in 2031", diff(upd("licence", notes="renew in 2031")),
    ref=[act("edit", rows="$licence", args=lines(notes="renew in 2031"))]),
  T("plus a wifi entry called Studio wifi", diff(new("locker item", name="Studio wifi")),
    ref=[act("create", args=lines(kind="locker item", name="Studio wifi", type="wifi"))]))

S("T17-074-P", "five turns person spans photo count nickname star undo para",
  T("contacts spoken to from the twentieth at noon until monday", rows("kalina", "plamen", "niki", "mila", "ivan_t", "stefan"),
    ref=[ans(kind="person", when=W(span(D("2026-01-20", "12:00"), U("week", 0, weekday=1))))]),
  T("go back two weeks, up to last friday", rows("desi", "maria_k", "krasi", "yordanka", "kalina", "plamen", "niki"),
    ref=[ans(kind="person", when=W(span(U("week", -2), U("week", -1, weekday=5))))]),
  T("of them, those sharing at most one photo with me", rows("maria_k", "krasi", "yordanka", "kalina", "plamen", "niki"),
    ref=[ans(kind="person", within="@prev", where="photo count <= 1")]),
  T("krasi saved the pipes, so he gets a star", diff(upd("krasi", starred=True)),
    ref=[search("krasi", kind="person"), act("star", rows="$krasi")]),
  T("actually, reverse that, undo", diff(upd("krasi", starred=False)),
    ref=[act("undo")]))

S("T17-080-P", "single photos week to time para",
  T("this week's photos until 1pm today", rows("piano_keys", "whiteboard", "vesi_duo", "lunch_p"),
    ref=[ans(kind="photo", when=W(span(U("week", 0), U("day", 0, time="13:00"))))]))

S("T17-091-P", "six turns photos span trashed restore window ask delete photo undo album count para",
  T("nov twenty-second 9am to end of november, photos", rows("plovdiv_old", "plovdiv_theatre", "plovdiv_mama"),
    ref=[ans(kind="photo", when=W(span(D("2025-11-22", "09:00"), U("month", -1, name=11))))]),
  T("deleted photos from that weekend?", rows("blurry_3"),
    ref=[find(kind="photo", trashed=True, when=W(span(D("2025-11-22"), D("2025-11-23")))), ans(rows="@prev")]),
  T("bring it back", ask(),
    ref=[bad(act("restore", rows="$blurry_3")),
         askc("it went in the bin on dec 1, more than 30 days ago, so it can't be restored. anything else?")]),
  T("fine, i've got better ones so get rid of the roman theatre one", diff(trash("plovdiv_theatre"), unlink("plovdiv_album", "plovdiv_theatre")),
    ref=[act("delete", rows="$plovdiv_theatre")]),
  T("mila likes that one, undo", diff(restore("plovdiv_theatre"), link("plovdiv_album", "plovdiv_theatre")),
    ref=[act("undo")]),
  T("albums holding at most three photos", rows("recital24", "plovdiv_album", "vienna_album"),
    ref=[ans(kind="album", where="photo count <= 3")]))

S("T17-A003-P", "ask-options task complete c3a para",
  T("choosing the piece is done", ask("piece_kalina", "piece_boris"),
    ref=[act("complete", kind="task", name="piece"),
         askc("Choose a piece for Kalina or Choose a piece for Boris?", options="$piece_kalina, $piece_boris")]),
  T("we settled on the clementi, kalina's one", diff(upd("piece_kalina", status="completed", completed=ANY)),
    ref=[act("complete", rows="$piece_kalina")]),
  T("prepare one is finished, complete it", diff(upd("programme", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="prepare")]))

S("T17-A008-P", "follow-up c3a para",
  T("this week, anything lined up", rows("tiling_start", "maria_0128", "niki_lesson", "vesi_reh_jan", "ivan_0126", "choir_0127", "coffee_mila", "handover_0201", "sofia_run", "lunch_petar"),
    ref=[ans(kind="event", when=J(U("week", 0)))]),
  T("just lessons", rows("maria_0128", "niki_lesson", "ivan_0126"),
    ref=[ans(within="@prev", name="lesson")]),
  T("what other things are there", rows("tiling_start", "vesi_reh_jan", "choir_0127", "coffee_mila", "handover_0201", "sofia_run", "lunch_petar"),
    ref=[ans(within="@1", exclude="@2")]))

S("T17-B005-P", "c4b state-change cancel event restore trashed task para",
  T("piano tuner called it off", diff(upd("tuner", status="cancelled")),
    ref=[act("cancel", kind="event", name="Piano tuner")]),
  T("i need the hallway lamp one, restore it", diff(restore("hall_lamp")),
    ref=[act("restore", kind="task", name="hallway lamp", trashed=True)]))

S("T17-C101-P", "c3c bulk delete per kind name scoped last year para",
  T("last year's choir rehearsals and electricity bills, delete the lot", diff(trash("choir_1202"), trash("choir_1209"), trash("choir_1216"), trash("choir_1223"), trash("choir_1230"), trash("elec_10"), trash("elec_11"), trash("elec_12")),
    ref=[find(kind="event", name="choir rehearsal", when=W(U("year", -1))),
         act("delete", rows="@prev", more=True),
         find(kind="task", name="electricity bill", when=W(U("year", -1))),
         act("delete", rows="@prev")]))

S("T17-109-P", "locker star ask pick already para",
  T("dsk gets a star", diff(upd("dsk", starred=True)),
    ref=[act("star", kind="locker item", name="DSK")]),
  T("give the dsk visa card a star as well", diff(already=["visa"]),
    ref=[act("star", kind="locker item", name="DSK Visa card"), ans(rows="$visa")]))

S("T17-115-P", "ask person star never_mind wifi read star para",
  T("ivan gets a star", ask("ivan_t", "ivan_d"),
    ref=[act("star", kind="person", name="Ivan"),
         askc("ivan todorov or ivan dimov?", options="$ivan_t, $ivan_d")]),
  T("never mind", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("students' wifi code?", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("give it a star", diff(upd("wifi", starred=True)),
    ref=[act("star", rows="$wifi")]))

S("T17-120-P", "decline fabricated_secret reveal unstar para",
  T("imslp needs a strong password, you pick one", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("then what is it at the moment", diff(reveal=[("imslp", "scores4free")]),
    ref=[act("reveal", rows="$imslp", args=lines(field="password"))]),
  T("take gmail's star off", diff(upd("gmail", starred=False)),
    ref=[act("unstar", kind="locker item", name="Gmail")]))
