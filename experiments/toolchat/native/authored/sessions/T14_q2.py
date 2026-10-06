from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T14-Q026", "will take duration edit minutes event i2pat",
  T("the accountant meeting will take 90 minutes", diff(upd("accountant", duration=90)),
    ref=[act("edit", rows="$accountant", args="duration: 90")]))

S("T14-Q027", "tab word debt kind i2pat",
  T("what's my tab with marcos tavares", rows("d_marcos_t"),
    ref=[ans(kind="debt", linked_to="$marcos_t")]))

S("T14-Q028", "numeric options in question not filter i2pat",
  T("how many baile torto parties are left, is it 2 or 3", val(2),
    ref=[ans(op="count", kind="event", name="Baile Torto", where="status != cancelled", when=J({"from": U("day", 0)}))]))

S("T14-Q029", "ordinal of series second row reschedule i2pat",
  T("what are the next three car pool handovers", rows("hand_1026", "hand_1102", "hand_1109"),
    ref=[ans(kind="event", name="Car pool handover", when=J({"from": U("day", 0)}), order="date asc", limit=3)]),
  T("push the 2nd one to 7", diff(upd("hand_1102", date="2026-11-02T07:00")),
    ref=[act("reschedule", rows="$hand_1102", args=lines(to=U("day", 0, anchor="row", time="07:00")))]))

S("T14-Q030", "settle phrase on read debt row i2pat",
  T("what does kleber owe me", rows("d_kleber"),
    ref=[ans(kind="debt", linked_to="$kleber", where="status = open")]),
  T("he's sent it, mark it paid", diff(upd("d_kleber", status="settled")),
    ref=[act("settle_debt", rows="$d_kleber")]))

S("T14-Q031", "lent me debt i_owe verbatim item i2pat",
  T("guga lent me 80 for rca cables",
    diff(new("debt", name=has("rca cables"), amount=80, direction="i_owe"), link("new", "guga")),
    ref=[act("create", args=lines(kind="debt", name="RCA cables", amount="80", direction="i_owe", person="$guga"))]))

S("T14-Q032", "add before in body insert position i2pat",
  T("what's in the rodizio rules note", rows("rodizio"),
    ref=[ans(kind="note", name="Rodízio rules")]),
  T("add oil check after the full tank", diff(upd("rodizio", body=has("tank full at handover, oil check, Juninho nights, Rafa Sundays"))),
    ref=[act("edit", rows="$rodizio", args="body: tank full at handover, oil check, Juninho nights, Rafa Sundays")]))

S("T14-Q033", "different time make it carried name plus person i2pat",
  T("coffee with bianca next thursday at 9", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Coffee with Bianca", date=U("week", 1, weekday=4, time="09:00")))),
         askc("that clashes with mom's physiotherapy at 9. another day or time?")]),
  T("different day, make it friday", diff(new("event", name=has("Coffee with Bianca"), date="2026-10-30T09:00")),
    ref=[act("create", args=lines(kind="event", name="Coffee with Bianca", date=U("week", 1, weekday=5, time="09:00")))]))

S("T14-Q034", "create name head phrase follow-up time keeps name i2pat",
  T("put a call with fernanda in for thursday at 2, about the mei papers", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Call with Fernanda", date=U("week", 1, weekday=4, time="14:00")))),
         askc("2 clashes with your accountant meeting, 2 to 3. another time?")]),
  T("make it 4", diff(new("event", name=has("Call with Fernanda"), date="2026-10-29T16:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Fernanda", date=U("week", 1, weekday=4, time="16:00")))]))

S("T14-Q035", "edit append quoted text verbatim separator i2pat",
  T("what's in the kleber warm-up note", rows("set_kleber"),
    ref=[ans(kind="note", name="Bar do Kleber warm-up")]),
  T('add "no sertanejo" to it', diff(upd("set_kleber", body=has("MPB and samba rock, nothing above 110 bpm", "no sertanejo"))),
    ref=[act("edit", rows="$set_kleber", args="body: MPB and samba rock, nothing above 110 bpm, no sertanejo")]))

S("T14-Q036", "multi-field edit unit conversion i2pat",
  T("the dashcam job takes 2 hours and the note should say bring the drill",
    diff(upd("dashcam", effort=120, description=has("drill"))),
    ref=[act("edit", rows="$dashcam", args="effort: 120\ndescription: bring the drill")]))

S("T14-Q037", "which have person search then link within i2pat",
  T("show me the mãe album", rows("mae_garden", "mae_vo", "mae_clinic", "family_lunch"),
    ref=[ans(kind="photo", linked_to="$mae_album")]),
  T("which have vó lurdes in them", rows("mae_vo"),
    ref=[search("lurdes", kind="person"), ans(within="@1", linked_to="$lurdes")]))

S("T14-Q038", "whos in X event and group membership i2pat",
  T("who's in baile torto", rows("me", "rafa_m", "nath", "guga", "marcos_o", "ana_paula"),
    ref=[ans(kind="person", linked_to="$baile")]))

S("T14-Q039", "pick row containing all words among carried i2pat",
  T("what's open on the mãe list", rows("mae_meds", "mae_exam", "mae_plan", "mae_split", "mae_rail", "plan_11"),
    ref=[ans(kind="task", linked_to="$mae_l", where="status = open")]),
  T("tick off mom's meds", diff(upd("mae_meds", status="completed", completed=ANY)),
    ref=[act("complete", rows="$mae_meds")]))

S("T14-Q040", "when do we leave flight event i2pat",
  T("when do we leave for buenos aires", rows("flight_bsas"),
    ref=[ans(kind="event", name="Flight to Buenos Aires")]))
