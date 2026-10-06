from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# --- the person says "it", the model asks which, the answer pins the row down with three conditions ---------

S("T31-265", "ask-delete-which five-a-side tenth marcin next-after",
  T("get rid of it", ask(),
    ref=[askc("Delete which one?")]),
  T("the five-a-side game on the 10th that marcin lis is on", diff(trash("fas_1110")),
    ref=[act("delete", kind="event", name="five-a-side", when=J(D("2026-11-10")), linked_to="$marcin_l")]),
  T("when's the next hall game after that one", rows("fas_1117"),
    ref=[ans(kind="event", name="five-a-side hall", when=J({"from": D("2026-11-11")}), order="date asc", limit=1)]),
  T("push the hall game on the 17th that piotr is on back a day, same time", diff(upd("fas_1117", date="2026-11-18T20:00")),
    ref=[act("reschedule", kind="event", name="five-a-side hall", when=J(D("2026-11-17")), linked_to="$piotr", args=lines(to=D("2026-11-18", "20:00")))]))

S("T31-266", "ask-longer-which edit-duration mama babcia twenty-second long-calls",
  T("make it longer", ask(),
    ref=[askc("Which one, and by how much?")]),
  T("the call with mama on the 22nd that has babcia on, make it 45 minutes", diff(upd("mama_1122", duration=45)),
    ref=[act("edit", kind="event", name="call mama", when=J(D("2026-11-22")), where='description contains "Babcia"', args="duration: 45")]),
  T("which is the longest mama call now", rows("mama_1122"),
    ref=[ans(kind="event", name="call mama", order="duration desc", limit=1)]))

S("T31-267", "ask-reopen-which pay rent october landlord open-now",
  T("reopen it", ask(),
    ref=[askc("Which task should I reopen?")]),
  T("the pay rent from october that's about pan stanislaw", diff(upd("rent_oct", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="pay rent", when=J(U("month", -1, name=10)), linked_to="$landlord")]),
  T("which pay rent tasks are open now", rows("rent_nov", "rent_oct"),
    ref=[ans(kind="task", name="pay rent", where="status = open")]),
  T("tick off the pay rent from november that's about pan stanislaw", diff(upd("rent_nov", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="pay rent", when=J(U("month", 0)), linked_to="$landlord")]))

S("T31-268", "ask-star-who photo babcia roses august starred-count",
  T("star her", ask(),
    ref=[askc("Star who?")]),
  T("babcia's roses photo from august", diff(upd("p_ns_babcia", starred=True)),
    ref=[act("star", kind="photo", name="roses", linked_to="$babcia", when=J(U("month", -1, name=8)))]),
  T("how many of babcia's photos are starred now", val(2),
    ref=[ans(op="count", kind="photo", linked_to="$babcia", where="starred = yes")]),
  T("star the walk photo of babcia and mama from october", diff(upd("p_ns_walk", starred=True)),
    ref=[act("star", kind="photo", name="walk", linked_to="$babcia, $mama", when=J(U("month", -1, name=10)))]))

S("T31-269", "ask-unstar-which login starred url starred-left",
  T("unstar it", ask(),
    ref=[askc("Unstar which one?")]),
  T("the login i starred that has a url saved", diff(upd("pko_login", starred=False)),
    ref=[act("unstar", kind="locker item", where="type = login and starred = yes and url is set")]),
  T("so which locker entries still have a star", rows("pko_acct", "flat_wifi", "jetbrains"),
    ref=[ans(kind="locker item", where="starred = yes")]))

S("T31-270", "ask-settle-which flowers ewa small-owed",
  T("settle it", ask(),
    ref=[askc("Settle which debt?")]),
  T("the flowers one for ewa", diff(upd("d_ewa", status="settled")),
    ref=[act("settle_debt", kind="debt", name="flowers", linked_to="$ewa")]),
  T("how many debts do i still owe under 30", val(1),
    ref=[ans(op="count", kind="debt", where="direction = i_owe and status = open and amount < 30")]),
  T("settle the pizza one i owe darek from october", diff(upd("d_darek_pizza", status="settled")),
    ref=[act("settle_debt", kind="debt", name="pizza", linked_to="$darek", when=J(U("month", -1, name=10)))]))

S("T31-271", "decline-out-of-scope text barber reschedule-haircut twenty-first",
  T("text the barber to move my haircut", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok move the haircut on the 14th to the 21st at 11", diff(upd("barber_ev", date="2026-11-21T11:00")),
    ref=[act("reschedule", kind="event", name="haircut", when=J(D("2026-11-14")), args=lines(to=D("2026-11-21", "11:00")))]),
  T("what have i got on the 21st now", rows("wedding_adi", "barber_ev"),
    ref=[ans(kind="event", when=J(D("2026-11-21")))]))

S("T31-272", "decline-out-of-scope send note add-to-notebook before-2026 contents",
  T("send the flat rules note to ola", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok move the flat rules note from before 2026 into the ideas notebook", diff(link("ideas_nb", "n_flat_rules")),
    ref=[act("add_to", kind="note", name="flat rules", when=J({"to": D("2025-12-31")}), args=lines(to="$ideas_nb"))]),
  T("which notes are in the ideas notebook now", rows("n_flat_rules"),
    ref=[ans(kind="note", linked_to="$ideas_nb")]))

# --- the name fits two live rows, the runtime asks, the pick follows ------------------------------------------------

S("T31-273", "ambiguous-event delete flat dinner pick october restore",
  T("delete the flat dinner", ask("flat_dinner", "flat_dinner2"),
    ref=[act("delete", kind="event", name="flat dinner")]),
  T("the october one", diff(trash("flat_dinner2")),
    ref=[act("delete", kind="event", name="flat dinner", when=J(U("month", -1, name=10)))]),
  T("bring the flat dinner back", diff(restore("flat_dinner2")),
    ref=[find(kind="event", name="flat dinner", trashed=True), act("restore", rows="@1")]))

S("T31-274", "ambiguous-event reschedule physio upcoming pick twenty-sixth count-left",
  T("move the physio to the 30th", ask("physio_a", "physio_b"),
    ref=[act("reschedule", kind="event", name="physio", args=lines(to=D("2026-11-30", "16:30")))]),
  T("the one on the 26th", diff(upd("physio_b", date="2026-11-30T16:30")),
    ref=[act("reschedule", kind="event", name="physio", when=J(D("2026-11-26")), args=lines(to=D("2026-11-30", "16:30")))]),
  T("how many physio sessions are left", val(2),
    ref=[ans(op="count", kind="event", name="physio", when=J({"from": U("day", 0)}))]))

# --- groups hold people and money; the model reads the rows by name --------------------------------------------------

S("T31-275", "recovery-nolink ward gifts documents star starred-work",
  T("any documents for the ward gifts group", rows("d_rota"),
    ref=[ans(kind="document", linked_to="$ward_gifts"), ans(kind="document", name="ward")]),
  T("star it", diff(upd("d_rota", starred=True)),
    ref=[act("star", rows="$d_rota")]),
  T("which documents are starred in the work folder now", rows("d_contract", "d_licence", "d_rota"),
    ref=[ans(kind="document", linked_to="$work_f", where="starred = yes")]))

S("T31-276", "recovery-nolink stag photos who-in-it star",
  T("any photos for adi's stag do group", rows("p_adi_stag"),
    ref=[ans(kind="photo", linked_to="$stag"), ans(kind="photo", name="adi")]),
  T("who's in it", rows("adrian"),
    ref=[ans(kind="person", linked_to="$p_adi_stag")]),
  T("star it", diff(upd("p_adi_stag", starred=True)),
    ref=[act("star", rows="$p_adi_stag")]))
