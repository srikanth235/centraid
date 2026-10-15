from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-244", "ambiguous-event cancel flat dinner pick saturday when-name write-then-read starred-trips",
  T("cancel the flat dinner", ask("flat_dinner", "flat_dinner2"),
    ref=[act("cancel", kind="event", name="flat dinner")]),
  T("the one on saturday", diff(upd("flat_dinner", status="cancelled")),
    ref=[act("cancel", kind="event", name="flat dinner", when=J(U("week", 0, weekday=6)))]),
  T("which flat dinners were in october", rows("flat_dinner2"),
    ref=[ans(kind="event", name="flat dinner", when=J(U("month", -1, name=10)))]),
  T("star the borough market photo and show me which photos in trips 2026 are starred",
    rows("p_tr_london", "p_tr_kasia", also=diff(upd("p_tr_kasia", starred=True))),
    ref=[act("star", kind="photo", name="borough market", more=True),
         ans(kind="photo", linked_to="$trips_a", where="starred = yes")]))

S("T31-248", "trash-events named charity concert restore date",
  T("is the charity match still in the event trash", rows("old_match"),
    ref=[ans(kind="event", name="charity match", trashed=True)]),
  T("and the concert at alchemia", rows("old_gig"),
    ref=[ans(kind="event", name="alchemia", trashed=True)]),
  T("bring that one back", diff(restore("old_gig")),
    ref=[find(kind="event", name="alchemia", trashed=True), act("restore", rows="@3")]),
  T("when was it again", rows("old_gig"),
    ref=[ans(kind="event", name="alchemia")]))

S("T31-249", "trash-locker allegro restore logins",
  T("is the old allegro login in the locker trash", rows("old_login"),
    ref=[ans(kind="locker item", name="allegro", trashed=True)]),
  T("put the allegro login back", diff(restore("old_login")),
    ref=[find(kind="locker item", name="allegro", trashed=True), act("restore", rows="@2")]),
  T("so what logins are saved", rows("uh_portal", "netflix_login", "old_login", "pko_login"),
    ref=[ans(kind="locker item", where="type = login")]))

S("T31-250", "where4-tasks short-open no-priority search-log barber search-star goalkeeper mama-december",
  T("which tasks are open, take 25 to 30 minutes and have no priority", rows("fix_shower", "photo_album", "phone_plan", "ward_secret"),
    ref=[ans(kind="task", where="status = open and effort >= 25 and effort <= 30 and priority is empty")]),
  T("log a call with the barber, i rang to rebook", diff(upd("barber", date=ANY)),
    ref=[search("barber", kind="person"), act("log", rows="@2", args="kind: call")]),
  T("star the goalkeeper", diff(upd("tomek_m", starred=True)),
    ref=[search("goalkeeper", kind="person"), act("star", rows="@4")]),
  T("which calls with mama are in december", rows("mama_1206"),
    ref=[ans(kind="event", name="call mama", when=J(U("month", 0, name=12)))]))

S("T31-251", "when-name reads physio-october league-december hall-december two-reschedules",
  T("any physio in october", rows("physio_c"),
    ref=[ans(kind="event", name="physio", when=J(U("month", -1, name=10)))]),
  T("which league matches are in december", rows("league_1206"),
    ref=[ans(kind="event", name="league match", when=J(U("month", 0, name=12)))]),
  T("which hall games are in december after the first", rows("fas_1208", "fas_1215"),
    ref=[ans(kind="event", name="five-a-side hall", when=J(span(D("2026-12-02"), D("2026-12-31"))))]),
  T("move the hall game on the 17th to the 18th and the one on the 24th to the 25th",
    diff(upd("fas_1117", date="2026-11-18T20:00"), upd("fas_1124", date="2026-11-25T20:00")),
    ref=[act("reschedule", kind="event", name="five-a-side hall", when=J(D("2026-11-17")), args=lines(to=D("2026-11-18", "20:00")), more=True),
         act("reschedule", kind="event", name="five-a-side hall", when=J(D("2026-11-24")), args=lines(to=D("2026-11-25", "20:00")))]))

S("T31-252", "ambiguous-event delete dentist pick may other restore",
  T("delete the dentist", ask("dentist_ev", "dentist_ev2"),
    ref=[act("delete", kind="event", name="dentist")]),
  T("the one from may", diff(trash("dentist_ev2")),
    ref=[act("delete", kind="event", name="dentist", when=J(U("month", -1, name=5)))]),
  T("when's the other dentist", rows("dentist_ev"),
    ref=[ans(kind="event", name="dentist", exclude="$dentist_ev2")]),
  T("and bring the may dentist back", diff(restore("dentist_ev2")),
    ref=[find(kind="event", name="dentist", trashed=True), act("restore", rows="@2")]))

S("T31-253", "ambiguous-event delete kasia call pick eighth left edit-duration",
  T("delete the call with kasia", ask("kasia_call", "kasia_call2"),
    ref=[act("delete", kind="event", name="call kasia")]),
  T("the one on the 8th", diff(trash("kasia_call")),
    ref=[act("delete", kind="event", name="call kasia", when=J(D("2026-11-08")))]),
  T("what calls with kasia have i got left", rows("kasia_call2"),
    ref=[ans(kind="event", name="call kasia")]),
  T("make it 60 minutes long", diff(upd("kasia_call2", duration=60)),
    ref=[act("edit", rows="$kasia_call2", args="duration: 60")]))

S("T31-255", "two-writes star-zus-this-year unstar-licence delete-pit write-then-read create-task saturday",
  T("star the zus statement from this year and unstar the nursing licence copy",
    diff(upd("d_zus", starred=True), upd("d_licence", starred=False)),
    ref=[act("star", kind="document", name="zus statement", when=J(U("year", 0)), more=True),
         act("unstar", kind="document", name="nursing licence")]),
  T("delete the pit-37 from 2024 and show me what's left in the taxes folder",
    rows("d_pit25", "d_zus", also=diff(trash("d_pit24"))),
    ref=[act("delete", kind="document", name="pit-37", when=J(U("year", -1)), more=True),
         ans(kind="document", linked_to="$taxes_f")]),
  T("create a task to book the barber for saturday and show me what else is due saturday",
    rows("pay_pizza", "pay_marta", also=diff(new("task", name=has("barber"), date="2026-11-07"))),
    ref=[act("create", kind="task", args=lines(name="Book the barber", date=U("week", 0, weekday=6)), more=True),
         ans(kind="task", when=J(U("week", 0, weekday=6)), exclude="$new")]))
