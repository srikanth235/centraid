from gold import *


def J(d):
    return json.dumps(d, separators=(",", ":"))


# --- container-link-reads: the container's name is also a word in rows outside it -------------------------------------------

S("T33-091", "container-link whats-left theme-word-is-list-name within effort complete",
  T("what's left on penang", rows("penang_trip", "pg_ringgit", "pg_gifts", "pg_pack"),
    ref=[ans(kind="task", linked_to="$penang_l", where="status = open")]),
  T("which of those are over half an hour", rows("pg_gifts", "pg_pack"),
    ref=[ans(within="@prev", where="effort > 30")]),
  T("and what's left on home next week", rows("h_bulbs", "permit_a", "h_return", "h_curtain"),
    ref=[ans(kind="task", linked_to="$home_l", where="status = open", when=J(U("week", 1)))]),
  T("tick off the hallway bulbs, got them yesterday", diff(upd("h_bulbs", status="completed", completed=ANY)),
    ref=[act("complete", rows="$h_bulbs")]))

S("T33-092", "container-link owner-row groups-im-in person-groups",
  T("how many groups am i in", val(6),
    ref=[ans(op="count", kind="group", linked_to="$me")]),
  T("and which of them is mei in", rows("penang", "household", "okaasan_gift"),
    ref=[ans(kind="group", linked_to="$mei")]))

S("T33-093", "container-link person-appointments within-person",
  T("what's on for kenji next week", rows("ped_a", "vaccine", "swim_1219", "sprouts_concert"),
    ref=[ans(kind="event", linked_to="$kenji", when=J(U("week", 1)))]),
  T("just the ones with dr ong", rows("ped_a", "vaccine"),
    ref=[ans(within="@prev", linked_to="$ong")]))

S("T33-094", "container-link folder notebook kenji-collision body-contains count",
  T("what's in kenji's folder", rows("d_birth", "d_booklet", "d_nursery", "d_passport_k"),
    ref=[ans(kind="document", linked_to="$kenji_f")]),
  T("and the notes in kenji notes that mention the booklet", rows("kn_vacc"),
    ref=[ans(kind="note", linked_to="$kenji_nb", where='body contains "booklet"')]),
  T("how many notes are in there altogether", val(5),
    ref=[ans(op="count", kind="note", linked_to="$kenji_nb")]))

S("T33-095", "container-link within-linked_to narrowing restate-where kenji-list",
  T("what tasks are due friday", rows("lift_quote", "k_concert", "k_teacher", "cc_bill", "w_review"),
    ref=[ans(kind="task", where="status = open", when=J(U("week", 1, weekday=5)))]),
  T("just the kenji ones", rows("k_concert", "k_teacher"),
    ref=[ans(within="@prev", linked_to="$kenji_l")]))

# --- stray-or-operator-conditions: the clause or the noun is not a condition ---------------------------------------------

S("T33-096", "stray-conditions inert-purpose-clause documents photos met-contains repair-field",
  T("which documents are in the condo folder, i need them for the agm",
    rows("d_sp25", "d_minutes_oct", "d_minutes_nov", "d_bylaws", "d_budget26", "d_budget27"),
    ref=[ans(kind="document", linked_to="$condo_f")]),
  T("photos of okaasan, for her birthday card", rows("p_o_castle", "p_o_okaasan", "p_o_family"),
    ref=[bad(ans(kind="photo", linked_to="$okaasan", where='description contains "birthday"')),
         ans(kind="photo", linked_to="$okaasan")]),
  T("who did i meet at little sprouts, for the christmas card list", rows("amanda", "priya_nair", "sarah", "jiahui"),
    ref=[ans(kind="person", where='met contains "Little Sprouts"')]))

S("T33-097", "stray-conditions by-name-writes inert-purpose-clause complete reschedule star unstar",
  T("tick off the credit card payment, did it on the app so it's not hanging over me",
    diff(upd("cc_bill", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="credit card")]),
  T("move the dentist check up to the 29th, i've got the handover that week",
    diff(upd("dentist_ev", date="2026-12-29T17:30")),
    ref=[act("reschedule", kind="event", name="dentist check up", args=lines(to=D("2026-12-29")))]),
  T("star the penang house wifi so mei finds it at the airport", diff(upd("penang_wifi", starred=ANY)),
    ref=[act("star", kind="locker item", name="penang house wifi")]),
  T("and unstar the home wifi, it's in the book now", diff(upd("home_wifi", starred=ANY)),
    ref=[act("unstar", kind="locker item", name="home wifi")]))

S("T33-098", "stray-conditions noun-looks-like-direction noun-looks-like-role repair-field",
  T("any open tasks about the refund", rows("pay_david"),
    ref=[bad(ans(kind="task", name="refund", where="direction = owes_me and status = open")),
         ans(kind="task", name="refund", where="status = open")]),
  T("which debts are for the teacher gift", rows("d_sarah"),
    ref=[ans(kind="debt", name="teacher gift")]),
  T("and who's the helper", rows("rina"),
    ref=[ans(kind="person", where='role = "helper"')]))

S("T33-099", "stray-conditions description-contains photo-name notebook-via-note",
  T("which swim classes this month say to bring the blue towel", rows("swim_1212"),
    ref=[ans(kind="event", name="toddler swim", where='description contains "blue towel"', when=J(U("month", 0)))]),
  T("any photos with fireworks in them", rows("p_c_ndp"),
    ref=[ans(kind="photo", name="fireworks")]),
  T("which notebook has the note about the roof", rows("condo_nb"),
    ref=[find(kind="note", where='body contains "roof"'),
         ans(kind="notebook", linked_to="@prev")]))

S("T33-100", "stray-conditions count sum inert-purpose-clause",
  T("how many open tasks are left on the money list, i want to clear them before we fly", val(6),
    ref=[ans(op="count", kind="task", linked_to="$money_l", where="status = open")]),
  T("and what's the total i still owe, so i know what to put aside", val((779, "SGD")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]))

# --- date-window-reads: spans and counts with a date phrase ------------------------------------------------------------------

S("T33-101", "date-window before-closed-window past-before named-month kenji-events future-month-empty",
  T("what's kenji got on before christmas",
    rows("swim_1212", "ped_a", "vaccine", "swim_1219", "sprouts_concert", "flight_pg"),
    ref=[ans(kind="event", linked_to="$kenji", when=J(span(U("day", 0), D("2026-12-24"))))]),
  T("and what did he have on before november",
    rows("ped_b", "swim_1003", "play_1007", "swim_1010", "play_1014", "play_1021", "swim_makeup", "swim_1024", "play_1028", "swim_1031"),
    ref=[ans(kind="event", linked_to="$kenji", where="status != cancelled", when=J({"to": U("month", 0, name=10)}))]),
  T("and in november",
    rows("play_1104", "swim_1107", "swim_1114", "play_1118", "swim_1121", "play_1125", "swim_1128"),
    ref=[ans(kind="event", linked_to="$kenji", where="status != cancelled", when=J(U("month", 0, name=11)))]),
  T("and what's he got in january", rows(),
    ref=[ans(kind="event", linked_to="$kenji", where="status != cancelled", when=J(U("month", 1, name=1)))]))

S("T33-102", "date-window ordinal-past-vs-upcoming named-month-future past-perfect-count",
  T("did we have anything on the 5th", rows("swim_1205"),
    ref=[ans(kind="event", when=J(D("2026-12-05")))]),
  T("and what have we got on the 5th", rows("cm_0105"),
    ref=[ans(kind="event", when=J(D("2027-01-05")))]),
  T("what about the whole of january", rows("cm_0105", "agm"),
    ref=[ans(kind="event", when=J(U("month", 1, name=1)))]),
  T("how many committee meetings have we had since august, not counting the cancelled one", val(3),
    ref=[ans(op="count", kind="event", name="committee meeting", where="status != cancelled",
             when=J({"from": U("month", 0, name=8)}))]))

S("T33-103", "date-window or-older from-on both-tenses repair-where-date",
  T("which documents are from 2025 or older",
    rows("d_sp25", "d_birth", "d_contract", "d_insure_h", "d_bylaws", "d_tax24", "d_booklet", "d_passport_k", "d_permit"),
    ref=[ans(kind="document", when=J({"to": U("year", -1)}))]),
  T("what's on from the 20th on",
    rows("tree_lighting", "work_review", "dentist_ev", "flight_pg", "pa_birthday", "flight_back", "cm_0105", "agm", "cm_0202", "japan_flight"),
    ref=[ans(kind="event", when=J({"from": D("2026-12-20")}))]),
  T("which playgroups did we have from november on", rows("play_1104", "play_1118", "play_1125", "play_1202", "play_1209"),
    ref=[bad(ans(kind="event", name="playgroup", where="status != cancelled and date >= 2026-11-01")),
         ans(kind="event", name="playgroup", where="status != cancelled",
             when=J(span(U("month", 0, name=11), U("day", 0))))]))

S("T33-104", "date-window year-arithmetic longer-than-hours both-tenses repair-unit",
  T("any photos from two years ago", rows("p_k_born"),
    ref=[ans(kind="photo", when=J(U("year", -2)))]),
  T("which events next week are longer than two hours", rows("work_party", "babysit_ma"),
    ref=[bad(ans(kind="event", where="duration > 2 hours", when=J(U("week", 1)))),
         ans(kind="event", where="duration > 120", when=J(U("week", 1)))]),
  T("and last week", rows("work_offsite"),
    ref=[ans(kind="event", where="duration > 120", when=J(U("week", -1)))]))

S("T33-105", "date-window time-of-day-narrowing pick-no-when",
  T("what's on next week",
    rows("aircon_a", "lunch_david", "cm_budget", "permit_visit", "ped_a", "vaccine", "work_party", "swim_1219",
         "sprouts_concert", "babysit_ma", "tree_lighting"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("which ones start in the evening", rows("cm_budget", "work_party", "babysit_ma", "tree_lighting"),
    ref=[ans(rows="$cm_budget, $work_party, $babysit_ma, $tree_lighting")]))

# --- mixed ---------------------------------------------------------------------------------------------------------------------

S("T33-106", "mixed rename quoted-span document note",
  T('rename the home insurance policy to "Home insurance 2026" so it sorts with the others',
    diff(upd("d_insure_h", name="Home insurance 2026")),
    ref=[act("edit", kind="document", name="home insurance policy", args="name: Home insurance 2026")]),
  T('call the monthly budget note "Budget 2027" instead, the old name is confusing',
    diff(upd("budget", name="Budget 2027")),
    ref=[act("edit", kind="note", name="monthly budget", args="name: Budget 2027")]))

S("T33-107", "mixed note-body-append open-then-edit",
  T("add laksa at the market to the penang food list note",
    diff(upd("penang_ideas", body=has("laksa at the market", "kek seng", "kway teow"))),
    ref=[opn("$penang_ideas"),
         act("edit", rows="$penang_ideas",
             args="body: char kway teow at Lorong Selamat, cendol on Penang Road, Ma's nasi kandar, ABC at Kek Seng, laksa at the market")]))

S("T33-108", "mixed settle_up amount person group",
  T("kim sent me 40 for the hotpot, settle that in the dinner club",
    diff(upd("kim", balance=ANY), settle=[("Kim", "40.00")]),
    ref=[act("settle_up", rows="$kim", args="group: $dinner\namount: 40")]))

S("T33-109", "mixed kind-word-decides photos documents tasks same-topic",
  T("any nursery photos", rows("p_form"),
    ref=[ans(kind="photo", name="nursery")]),
  T("and the documents", rows("d_nursery"),
    ref=[ans(kind="document", name="nursery")]),
  T("and tasks", rows("k_preschool"),
    ref=[ans(kind="task", name="nursery")]))

S("T33-110", "mixed weekday-and-clock-date reschedule create",
  T("move the dentist check up to thursday at 4", diff(upd("dentist_ev", date="2026-12-17T16:00")),
    ref=[act("reschedule", kind="event", name="dentist check up", args=lines(to=U("week", 1, weekday=4, time="16:00")))]),
  T("and put lunch with kim in for friday at 12:30", diff(new("event", name=has("kim"), date="2026-12-18T12:30")),
    ref=[act("create", args=lines(kind="event", name="Lunch with Kim", date=U("week", 1, weekday=5, time="12:30")))]))
