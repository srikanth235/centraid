from gold import *
import json
def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T29-093-P", "r2 container-link-read owner-row groups-i-am-in count members person-groups para",
  T("number of groups i belong to", val(5),
    ref=[ans(op="count", kind="group", linked_to="$me")]),
  T("which are they", rows("riders", "flat", "diani", "berlin", "kisumu_fund"),
    ref=[ans(kind="group", linked_to="$me")]),
  T("diani weekend members?", rows("me", "brenda", "ian", "naomi", "amina"),
    ref=[ans(kind="person", linked_to="$diani")]),
  T("kip belongs to how many groups", val(1),
    ref=[ans(op="count", kind="group", linked_to="$kip")]))

S("T29-097-P", "r2 stray met-contains person-field university riders within-starred role-contains-inexact para",
  T("contacts i met at university, which", rows("brenda", "ian"),
    ref=[ans(kind="person", where='met contains "university"')]),
  T("riders too", rows("kip", "kevin_m", "mwende", "juma", "nyambura"),
    ref=[ans(kind="person", where='met contains "Riders"')]),
  T("starred among them?", rows("kip"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("groomer, who", rows("tabitha"),
    ref=[ans(kind="person", where='role contains "groomer"')]))

S("T29-101-P", "r2 date-window before-X through-X by-X closed-from-today events tasks past-before-month both-tenses para",
  T("before friday, what's still on", rows("print_drawings", "runda_site_0924", "yoga"),
    ref=[ans(kind="event", where="status != cancelled", when=J(span(U("day", 0), U("week", 0, weekday=4))))]),
  T("through friday, what's on", rows("print_drawings", "runda_site_0924", "yoga", "client_faith", "dinner_wambs"),
    ref=[ans(kind="event", where="status != cancelled", when=J(span(U("day", 0), U("week", 0, weekday=5))))]),
  T("before august, what did i have", rows("ride_0704", "ride_0711", "ride_0718", "ride_0725"),
    ref=[ans(kind="event", when=J({"to": U("month", 0, name=7)}))]),
  T("due by friday?",
    rows("karen_mockup", "mpesa_float", "chai_pay", "print_fee", "mama_meds", "karen_tiles", "inv_faith_sep"),
    ref=[ans(kind="task", where="status = open", when=J(span(U("day", 0), U("week", 0, weekday=5))))]))

S("T29-105-P", "r2 date-window named-month from-on both-tenses ordinal-future past-closed-today events para",
  T("november's events", rows("race", "diani_trip", "kitty_agm"),
    ref=[ans(kind="event", when=J(U("month", 0, name=11)))]),
  T("august rides, which did i do", rows("ride_0801", "ride_0808", "ride_0822", "ride_0829"),
    ref=[ans(kind="event", name="ride", where="status != cancelled", when=J(U("month", 0, name=8)))]),
  T("rides done from august on?",
    rows("ride_0801", "ride_0808", "ride_0822", "ride_0829", "ride_0905", "ride_0912", "ride_0919"),
    ref=[ans(kind="event", name="ride", where="status != cancelled",
             when=J(span(U("month", 0, name=8), U("day", 0))))]),
  T("ride on the 17th, is there one", rows("ride_1017"),
    ref=[ans(kind="event", name="ride", when=J(D("2026-10-17")))]))

S("T29-109-P", "r2 mixed kind-word-decides documents notes photos jersey para",
  T("documents about the jersey", rows("jersey_quote"),
    ref=[ans(kind="document", name="jersey")]),
  T("notes?", rows("club_kit"),
    ref=[ans(kind="note", name="jersey")]),
  T("photos too?", rows("p_ride_jersey"),
    ref=[ans(kind="photo", name="jersey")]),
  T("call with the club captain, log it", diff(upd("kip", date=ANY)),
    ref=[search("captain", kind="person"), act("log", rows="$kip", args="kind: call")]))
