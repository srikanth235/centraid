from gold import *
import json

world("T29", "2026-09-23T18:10", "Achieng Odhiambo", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


# ---- container-link reads: the container's name is also a word in rows outside it (T29-091 .. T29-095) ----

S("T29-091", "r2 container-link-read list theme-word collision kisumu within-person all-but-one complete album starred purpose-carried",
  T("what's left for the kisumu trip before november", rows("baba_gift", "mama_meds", "roof_quote"),
    ref=[ans(kind="task", linked_to="$kisumu_list", where="status = open",
             when=J(span(U("day", 0), U("month", 0, name=10))))]),
  T("which of those are for baba", rows("baba_gift"),
    ref=[ans(within="@prev", linked_to="$baba")]),
  T("tick off everything left on the kisumu list except the roof quote",
    diff(upd("baba_gift", status="completed", completed=ANY), upd("mama_meds", status="completed", completed=ANY)),
    ref=[find(kind="task", linked_to="$kisumu_list", where="status = open", exclude="$roof_quote"),
         act("complete", rows="@prev")]),
  T("and which of the kisumu december photos are starred", rows("p_kisumu_lake", "p_kisumu_family"),
    ref=[ans(kind="photo", linked_to="$kisumu_album", where="starred = yes")]))

S("T29-092", "r2 container-link-read notebook riders-notes collision body-contains within pin",
  T("what's in my riders notes", rows("club_rules", "club_routes", "club_kit", "kitty_rules"),
    ref=[ans(kind="note", linked_to="$club_nb")]),
  T("which of them mention the logo", rows("club_kit"),
    ref=[ans(within="@prev", where='body contains "logo"')]),
  T("pin that one and show me everything that's pinned now",
    rows("club_rules", "planning_checklist", "simba_food", "club_kit", also=diff(upd("club_kit", pinned=True))),
    ref=[act("edit", rows="$club_kit", args="pinned: yes", more=True),
         ans(kind="note", where="pinned = yes")]),
  T("star the club secretary", diff(upd("nyambura", starred=True)),
    ref=[find(kind="person", where='role = "club secretary"'), act("star", rows="@prev")]))

S("T29-093", "r2 container-link-read owner-row groups-i-am-in count members person-groups",
  T("how many groups am i in", val(5),
    ref=[ans(op="count", kind="group", linked_to="$me")]),
  T("which ones", rows("riders", "flat", "diani", "berlin", "kisumu_fund"),
    ref=[ans(kind="group", linked_to="$me")]),
  T("who's in diani weekend", rows("me", "brenda", "ian", "naomi", "amina"),
    ref=[ans(kind="person", linked_to="$diani")]),
  T("and how many groups is kip in", val(1),
    ref=[ans(op="count", kind="group", linked_to="$kip")]))

S("T29-094", "r2 container-link-read person-appointments through-link within-narrow substitution dennis moses",
  T("what's on this week",
    rows("karen_site_0922", "print_drawings", "runda_site_0924", "yoga", "client_faith", "dinner_wambs", "ride_0926",
         "coffee_kevin", "vet_vacc", "groom", "mama_call"),
    ref=[ans(kind="event", when=J(U("week", 0)))]),
  T("which of those are with dennis", rows("runda_site_0924"),
    ref=[ans(within="@prev", linked_to="$dennis")]),
  T("and moses?", rows("print_drawings"),
    ref=[ans(within="@1", linked_to="$moses")]),
  T("what's still coming up with dennis altogether", rows("runda_site_0924", "client_dennis", "runda_site_1001"),
    ref=[ans(kind="event", linked_to="$dennis", where="status != cancelled", when=J({"from": U("day", 0)}))]))

S("T29-095", "r2 container-link-read list riders theme-word collision within this-month sum-effort all-but-one read",
  T("what's left on the riders list",
    rows("kit_order", "kitty_report", "kitty_dues", "race_reg", "kitty_receipts", "agm_agenda", "bike_service"),
    ref=[ans(kind="task", linked_to="$club_list", where="status = open")]),
  T("which are due this month", rows("kit_order", "kitty_report", "kitty_dues", "bike_service"),
    ref=[ans(within="@prev", when=J(U("month", 0)))]),
  T("how long would those take altogether", val(120),
    ref=[ans(op="sum", field="effort", within="@prev")]),
  T("show me everything left on the riders list except the dues one",
    rows("kit_order", "kitty_report", "race_reg", "kitty_receipts", "agm_agenda", "bike_service"),
    ref=[ans(kind="task", linked_to="$club_list", where="status = open", exclude="$kitty_dues")]))

# ---- stray-or-operator conditions: an inert clause or a noun that is not a field value (T29-096 .. T29-100) ----

S("T29-096", "r2 stray-clause purpose-read reason-read inert faith kip invoices no-description-on-photos body-contains",
  T("which tasks are open for faith this week, because i need to brief the intern", rows("karen_tiles", "inv_faith_sep"),
    ref=[ans(kind="task", linked_to="$faith", where="status = open", when=J(U("week", 0)))]),
  T("photos of kip for the club newsletter", rows("p_ride_sunrise", "p_ride_group", "p_ride_ngong"),
    ref=[ans(kind="photo", linked_to="$kip")]),
  T("what invoices are there, i need them for gladys", rows("inv_karen_aug", "inv_karen_jul", "inv_runda_aug"),
    ref=[ans(kind="document", name="invoice")]),
  T("any notes that mention rain, i want to quote them for faith", rows("karen_site2", "diary_tough"),
    ref=[ans(kind="note", where='body contains "rain"')]))

S("T29-097", "r2 stray met-contains person-field university riders within-starred role-contains-inexact",
  T("which contacts did i meet at university", rows("brenda", "ian"),
    ref=[ans(kind="person", where='met contains "university"')]),
  T("and from the riders", rows("kip", "kevin_m", "mwende", "juma", "nyambura"),
    ref=[ans(kind="person", where='met contains "Riders"')]),
  T("which of them are starred", rows("kip"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("and who's the groomer", rows("tabitha"),
    ref=[ans(kind="person", where='role contains "groomer"')]))

S("T29-098", "r2 stray description-contains events ngong-race-course jersey within-from-today",
  T("which rides this year start at the ngong race course", rows("ride_0808", "ride_0919", "ride_1031"),
    ref=[ans(kind="event", name="ride", where='description contains "Ngong Race Course"', when=J(U("year", 0)))]),
  T("any of those coming up", rows("ride_1031"),
    ref=[ans(within="@prev", when=J({"from": U("day", 0)}))]),
  T("what's the meeting about the jersey order", rows("kitty_meeting"),
    ref=[ans(kind="event", where='description contains "jersey"')]),
  T("delete all the october rides except the first one",
    diff(trash("ride_1010"), trash("ride_1017"), trash("ride_1024"), trash("ride_1031")),
    ref=[find(kind="event", name="ride", when=J(U("month", 0, name=10))),
         act("delete", rows="$ride_1010, $ride_1017, $ride_1024, $ride_1031")]))

S("T29-099", "r2 stray purpose-clause reason-clause by-name-write star complete log inert write-then-read",
  T("star the runda survey so i can find it for the planning submission",
    diff(upd("runda_survey_doc", starred=True)),
    ref=[act("star", kind="document", name="runda survey")]),
  T("tick off the jersey chase, kip confirmed the order, what's left on the riders list",
    rows("kitty_report", "kitty_dues", "race_reg", "kitty_receipts", "agm_agenda", "bike_service",
         also=diff(upd("kit_order", status="completed", completed=ANY))),
    ref=[act("complete", kind="task", name="jersey chase", more=True),
         ans(kind="task", linked_to="$club_list", where="status = open")]),
  T("log a call with nyambura because we sorted the dues", diff(upd("nyambura", date=ANY)),
    ref=[act("log", kind="person", name="nyambura", args="kind: call")]),
  T("and log a call with the mechanic", diff(upd("collins", date=ANY)),
    ref=[find(kind="person", where='role = "mechanic"'), act("log", rows="@prev", args="kind: call")]))

S("T29-100", "r2 stray role-like-noun not-a-role kin-possessive printer brother balance exact-role",
  T("where's dad's insurance card", rows("baba_nhif"),
    ref=[ans(kind="document", name="insurance card")]),
  T("and mum's pilau recipe", rows("pilau"),
    ref=[ans(kind="note", name="pilau")]),
  T("how much do i owe the printer", val((-4500, "KES")),
    ref=[ans(op="balance", kind="person", where='role = "printer"')]),
  T("and how much does my brother owe me", val((-26333.34, "KES")),
    ref=[ans(op="balance", kind="person", where='role = "brother"')]))

# ---- date-window reads (T29-101 .. T29-105) ---------------------------------------------------------------

S("T29-101", "r2 date-window before-X through-X by-X closed-from-today events tasks past-before-month both-tenses",
  T("what's still on before friday", rows("print_drawings", "runda_site_0924", "yoga"),
    ref=[ans(kind="event", where="status != cancelled", when=J(span(U("day", 0), U("week", 0, weekday=4))))]),
  T("and what's on through friday", rows("print_drawings", "runda_site_0924", "yoga", "client_faith", "dinner_wambs"),
    ref=[ans(kind="event", where="status != cancelled", when=J(span(U("day", 0), U("week", 0, weekday=5))))]),
  T("what did i have before august", rows("ride_0704", "ride_0711", "ride_0718", "ride_0725"),
    ref=[ans(kind="event", when=J({"to": U("month", 0, name=7)}))]),
  T("and what's due by friday",
    rows("karen_mockup", "mpesa_float", "chai_pay", "print_fee", "mama_meds", "karen_tiles", "inv_faith_sep"),
    ref=[ans(kind="task", where="status = open", when=J(span(U("day", 0), U("week", 0, weekday=5))))]))

S("T29-102", "r2 date-window or-older from-on open-span debts named-month substitution count both-tenses",
  T("which debts did i take on in july or older", rows("d_lena", "d_otieno", "d_collins", "d_amina", "d_naomi"),
    ref=[ans(kind="debt", when=J({"to": U("month", 0, name=7)}))]),
  T("and which are still open from august on",
    rows("d_brenda", "d_kip", "d_wambui_wifi", "d_kevin_m", "d_wambui_tokens", "d_juma_chai", "d_moses"),
    ref=[ans(kind="debt", where="status = open", when=J({"from": U("month", 0, name=8)}))]),
  T("how many is that", val(7),
    ref=[ans(op="count", kind="debt", where="status = open", when=J({"from": U("month", 0, name=8)}))]),
  T("and which tasks are still open from august or older", rows(),
    ref=[ans(kind="task", where="status = open", when=J({"to": U("month", 0, name=8)}))]))

S("T29-103", "r2 date-window ordinal-past-reading count-have-done year-arithmetic last-year two-years-ago",
  T("did i ride on the 12th", rows("ride_0912"),
    ref=[ans(kind="event", name="ride", when=J(D("2026-09-12")))]),
  T("how many rides have i done this year", val(11),
    ref=[ans(op="count", kind="event", name="ride", where="status != cancelled",
             when=J(span(U("year", 0), U("day", 0))))]),
  T("photos from last year",
    rows("p_simba_pup", "p_kisumu_lake", "p_kisumu_family", "p_kisumu_mama", "p_kisumu_baba", "p_kisumu_market",
         "p_kisumu_roof"),
    ref=[ans(kind="photo", when=J(U("year", -1)))]),
  T("and from two years ago", rows(),
    ref=[ans(kind="photo", when=J(U("year", -2)))]))

S("T29-104", "r2 date-window duration-where not-when longer-than-hours both-tenses time-of-day-pick repair-unit",
  T("any events longer than two hours next week", rows("karen_site_0929", "ride_1003", "ian_bday"),
    ref=[bad(ans(kind="event", where="duration > 2 hours", when=J(U("week", 1)))),
         ans(kind="event", where="duration > 120", when=J(U("week", 1)))]),
  T("which events last week ran longer than two hours", rows("karen_site_0915", "ride_0919", "otieno_visit"),
    ref=[ans(kind="event", where="duration > 120", when=J(U("week", -1)))]),
  T("what's on friday", rows("client_faith", "dinner_wambs"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=5)))]),
  T("the evening one", rows("dinner_wambs"),
    ref=[ans(rows="$dinner_wambs")]))

S("T29-105", "r2 date-window named-month from-on both-tenses ordinal-future past-closed-today events",
  T("what's on in november", rows("race", "diani_trip", "kitty_agm"),
    ref=[ans(kind="event", when=J(U("month", 0, name=11)))]),
  T("which rides did i do in august", rows("ride_0801", "ride_0808", "ride_0822", "ride_0829"),
    ref=[ans(kind="event", name="ride", where="status != cancelled", when=J(U("month", 0, name=8)))]),
  T("and which rides did i do from august on",
    rows("ride_0801", "ride_0808", "ride_0822", "ride_0829", "ride_0905", "ride_0912", "ride_0919"),
    ref=[ans(kind="event", name="ride", where="status != cancelled",
             when=J(span(U("month", 0, name=8), U("day", 0))))]),
  T("is there a ride on the 17th", rows("ride_1017"),
    ref=[ans(kind="event", name="ride", when=J(D("2026-10-17")))]))

# ---- mixed: one each (T29-106 .. T29-110) ----------------------------------------------------------------

S("T29-106", "r2 mixed rename quoted-span longer-sentence document read remove-from bring-it-back add-to",
  T("i think the club budget doc should be called 'Budget 2026 final', the old name doesn't sort well",
    diff(upd("club_budget", name="Budget 2026 final")),
    ref=[act("edit", rows="$club_budget", args=lines(name="Budget 2026 final"))]),
  T("and what's in the club folder now", rows("club_constitution", "club_budget", "jersey_quote"),
    ref=[ans(kind="document", linked_to="$club_f")]),
  T("take the jersey quote out of it", diff(unlink("club_f", "jersey_quote")),
    ref=[act("remove_from", kind="document", name="jersey quote", args=lines(from_="$club_f"))]),
  T("bring it back", diff(link("club_f", "jersey_quote")),
    ref=[act("add_to", rows="$jersey_quote", args=lines(to="$club_f"))]))

S("T29-107", "r2 mixed note-body-append add-to-the-note short-body open-first jot-down create-note",
  T("what's in my chapati note", rows("chapati"),
    ref=[ans(kind="note", name="chapati")]),
  T("add 'a pinch of salt' to it", diff(upd("chapati", body=has("flour", "fold", "salt"))),
    ref=[act("edit", rows="$chapati", args=lines(body="flour, warm water, oil, rest an hour, fold three times, a pinch of salt"))]),
  T("and jot 'ask salma about the washer' on the kitchen tap note",
    diff(upd("tap_notes", body=has("drips", "cartridge", "washer"))),
    ref=[opn("$tap_notes"),
         act("edit", rows="$tap_notes",
             args=lines(body="drips at the base, washer or cartridge, ask Salma before calling a plumber, ask Salma about the washer"))]),
  T("jot down that peter wants the roof truss revised before the pour",
    diff(new("note", name=has("roof", "truss"), body=has("peter", "revised"))),
    ref=[act("create", args=lines(kind="note", name="Roof truss", body="peter wants the roof truss revised before the pour"))]))

S("T29-108", "r2 mixed settle-up amount person group partial",
  T("i paid brenda 5000 towards the villa, settle that in the diani group",
    diff(upd("brenda", balance=ANY), settle=[("Brenda", "5000")]),
    ref=[act("settle_up", rows="$brenda", args=lines(group="$diani", amount="5000"))]))

S("T29-109", "r2 mixed kind-word-decides documents notes photos jersey",
  T("any jersey documents", rows("jersey_quote"),
    ref=[ans(kind="document", name="jersey")]),
  T("and notes", rows("club_kit"),
    ref=[ans(kind="note", name="jersey")]),
  T("photos?", rows("p_ride_jersey"),
    ref=[ans(kind="photo", name="jersey")]),
  T("log a call with the club captain", diff(upd("kip", date=ANY)),
    ref=[search("captain", kind="person"), act("log", rows="$kip", args="kind: call")]))

S("T29-110", "r2 mixed write date weekday-and-clock-one-phrase reschedule create-event make-it-clock ask no-wait-correction",
  T("put a site walk in friday", ask(),
    ref=[askc("What time on friday?")]),
  T("make it 9", diff(new("event", name=has("site", "walk"), date="2026-09-25T09:00")),
    ref=[act("create", args=lines(kind="event", name="Site walk", date=U("week", 0, weekday=5, time="09:00")))]),
  T("move the structural call to next tuesday at 1:30, no wait, 2:30", diff(upd("structural", date="2026-09-29T14:30")),
    ref=[act("reschedule", kind="event", name="structural call", args=lines(to=U("week", 1, weekday=2, time="14:30")))]))
