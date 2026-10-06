from gold import *
import json

world("T36", "2026-12-09T21:15", "Dev Mehra", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T36-091", "container-link-reads list collision within linked_to exclude",
  T("what's left for the scooter", rows("scooter_tyre", "scooter_puc_t", "scooter_helmet", "scooter_ins", "emi_jan"),
    ref=[ans(kind="task", linked_to="$scooter_list", where="status = open")]),
  T("which of those are for anju", rows("scooter_helmet"),
    ref=[ans(within="@prev", linked_to="$anjali")]),
  T("what else is open that's about her", rows("nc_bank"),
    ref=[ans(kind="task", linked_to="$anjali", where="status = open", exclude="$scooter_helmet")]),
  T("and what did i finish on the wedding list",
    rows("wrap_gifts_list", "wrap_return_decor", "wrap_pay_caterer", "thanks_cards_old"),
    ref=[ans(kind="task", linked_to="$wedding_list", where="status = completed")]))

S("T36-092", "container-link-reads owner-count person-link groups",
  T("how many groups am i in", val(6),
    ref=[ans(op="count", kind="group", linked_to="$me")]),
  T("which groups is baba in", rows("wedding", "joshi_fund"),
    ref=[ans(kind="group", linked_to="$baba")]))

S("T36-093", "container-link-reads person-appointments within when",
  T("what do i have coming up with papa", rows("dinner_mummy", "doc_papa", "lohri"),
    ref=[ans(kind="event", linked_to="$papa", when=J({"from": U("day", 0)}))]),
  T("which of those are in december", rows("dinner_mummy", "doc_papa"),
    ref=[ans(within="@prev", when=J(U("month", 0, name=12)))]),
  T("and which has mummy on it", rows("dinner_mummy"),
    ref=[ans(within="@prev", linked_to="$mummy")]))

S("T36-094", "container-link-reads notebook body-vs-about",
  T("show me my work notes", rows("work_sprint", "work_goals", "work_1on1", "work_oncall"),
    ref=[ans(kind="note", linked_to="$work_nb")]),
  T("which of those mention chinmay", rows("work_sprint"),
    ref=[ans(within="@prev", where='body contains "chinmay"')]),
  T("and which are about him", rows("work_1on1"),
    ref=[ans(within="@1", linked_to="$chinmay")]))

S("T36-095", "container-link-reads list substitution within",
  T("whats open on the flat list",
    rows("rent_jan", "maint_dec", "maint_jan", "name_change", "nc_aadhaar", "nc_pan", "nc_bank", "nc_passport",
         "buy_geyser", "curtains"),
    ref=[ans(kind="task", linked_to="$home_list", where="status = open")]),
  T("which of those are about naik uncle", rows("maint_dec"),
    ref=[ans(within="@prev", linked_to="$landlord")]),
  T("and anju", rows("nc_bank"),
    ref=[ans(within="@1", linked_to="$anjali")]))

S("T36-096", "stray-conditions people-no-status purpose-clause met-contains",
  T("who's still in the wedding group, need to chase them for the money",
    rows("me", "vikram", "rohan_m", "sneha", "kunal", "baba"),
    ref=[bad(ans(kind="person", linked_to="$wedding", where="status = open")),
         ans(kind="person", linked_to="$wedding")]),
  T("which of them are from delhi, for the diwali sweets", rows("vikram", "rohan_m"),
    ref=[ans(within="@prev", where='met contains "Delhi"')]))

S("T36-097", "stray-conditions by-name-star inert-clause role-noun-name",
  T("star the decorator's invoice, need it for the balance", diff(upd("decor_inv", starred=True)),
    ref=[act("star", rows="$decor_inv")]),
  T("and the photographer contract", diff(upd("photog_contract", starred=True)),
    ref=[act("star", rows="$photog_contract")]))

S("T36-098", "stray-conditions role-noun-in-debt-name direction",
  T("what do i owe for the caterer", rows("d_vikram"),
    ref=[ans(kind="debt", name="caterer", where="direction = i_owe")]),
  T("and for the photographer", rows("d_rohan_m"),
    ref=[ans(kind="debt", name="photographer", where="direction = i_owe")]),
  T("and the dj", rows("d_kunal"),
    ref=[ans(kind="debt", name="dj", where="direction = i_owe")]))

S("T36-099", "stray-conditions met-contains body-contains notebook-name",
  T("who do i know in kothrud, for the guest list", rows("baba", "aai", "sneha", "priest"),
    ref=[ans(kind="person", where='met contains "Kothrud"')]),
  T("which notes mention the geyser, the plumber wants to know", rows("flat_shop"),
    ref=[ans(kind="note", where='body contains "geyser"')]),
  T("and any notebooks about the wedding", rows("wedding_nb"),
    ref=[bad(ans(kind="notebook", where='body contains "wedding"')),
         ans(kind="notebook", name="wedding")]))

S("T36-100", "stray-conditions photos inert-clause star",
  T("photos from the sangeet, the ones anju wants for the album", rows("p_sangeet", "p_bunty"),
    ref=[ans(kind="photo", name="sangeet")]),
  T("which of those has kunal in it", rows("p_sangeet"),
    ref=[ans(within="@prev", linked_to="$kunal")]),
  T("star it, for the wedding wall", diff(upd("p_sangeet", starred=True)),
    ref=[act("star", rows="$p_sangeet")]))

S("T36-101", "date-window-reads before closed time-of-day-pick past-tense",
  T("what do i have before sunday", rows("sprint_1210", "lunch_rohan_k", "badm_1212", "office_party"),
    ref=[ans(kind="event", when=J(span(U("day", 0), U("week", 0, weekday=6))))]),
  T("the evening one", rows("office_party"),
    ref=[ans(rows="$office_party")]),
  T("how many badminton games did we play before the 15th", val(8),
    ref=[ans(op="count", kind="event", name="badminton", where="status != cancelled",
             when=J({"to": D("2026-11-14")}))]))

S("T36-102", "date-window-reads named-month or-older both-tenses",
  T("what's on in january", rows("lohri"),
    ref=[ans(kind="event", when=J(U("month", 1, name=1)))]),
  T("how many calls with mummy did we actually have in october", val(2),
    ref=[ans(op="count", kind="event", name="call mummy", where="status != cancelled",
             when=J(U("month", 0, name=10)))]),
  T("photos from august or older", rows("p_flat_keys", "p_flat_empty", "p_flat_kitchen", "p_flat_balcony"),
    ref=[ans(kind="photo", when=J({"to": U("month", 0, name=8)}))]))

S("T36-103", "date-window-reads ordinal past-reading",
  T("what was on the 8th", rows("registration"),
    ref=[ans(kind="event", when=J(D("2026-12-08")))]),
  T("and what was on the 20th", rows("mehendi"),
    ref=[ans(kind="event", when=J(D("2026-11-20")))]),
  T("and what's on the 20th", rows("callm_1220"),
    ref=[ans(kind="event", when=J(D("2026-12-20")))]))

S("T36-104", "date-window-reads from-on past-perfect-count left",
  T("what do i have from the 28th on", rows("doc_papa", "fly_back", "ny_party", "lohri", "engagement"),
    ref=[ans(kind="event", when=J({"from": D("2026-12-28")}))]),
  T("how many badminton games have i played this month", val(1),
    ref=[ans(op="count", kind="event", name="badminton", where="status != cancelled",
             when=J(span(U("month", 0), U("day", 0))))]),
  T("and how many are left", val(3),
    ref=[ans(op="count", kind="event", name="badminton", where="status != cancelled",
             when=J(span(U("day", 0), U("month", 0))))]),
  T("how many events did we have from the 20th of november on", val(11),
    ref=[ans(op="count", kind="event", where="status != cancelled",
             when=J(span(D("2026-11-20"), U("day", 0))))]))

S("T36-105", "date-window-reads duration year-arithmetic",
  T("which events run longer than 4 hours", rows("sangeet", "wedding_day", "goa", "dubai_trip", "ny_party"),
    ref=[bad(ans(kind="event", where="duration > 4 hours")), ans(kind="event", where="duration > 240")]),
  T("which of those are still coming up", rows("ny_party"),
    ref=[ans(within="@prev", when=J({"from": U("day", 0)}))]),
  T("what events do i have next year", rows("lohri", "engagement"),
    ref=[ans(kind="event", when=J(U("year", 1)))]),
  T("any documents from two years ago", rows("offer_letter"),
    ref=[ans(kind="document", when=J(U("year", -2)))]))

S("T36-106", "mixed rename quoted-span",
  T("rename the scooter details note to \"Activa papers\", it has the rc and insurance numbers",
    diff(upd("scooter_notes", name="Activa papers")),
    ref=[act("edit", rows="$scooter_notes", args="name: Activa papers")]),
  T("and rename \"Society NOC\" to \"NOC from the society\", i keep mixing it up",
    diff(upd("society_noc", name="NOC from the society")),
    ref=[act("edit", rows="$society_noc", args="name: NOC from the society")]))

S("T36-107", "mixed body-append note",
  T("add a ladder to the things to buy note", diff(upd("flat_shop", body=has("ladder", "geyser", "curtains"))),
    ref=[opn("$flat_shop"),
         act("edit", rows="$flat_shop", args=lines(body="geyser, curtains, an ironing board, a second pressure cooker, a ladder"))]),
  T("and curtain rods too", diff(upd("flat_shop", body=has("rods", "ladder", "geyser"))),
    ref=[act("edit", rows="$flat_shop",
             args=lines(body="geyser, curtains, an ironing board, a second pressure cooker, a ladder, curtain rods"))]))

S("T36-108", "mixed settle_up amount person",
  T("settle 4000 with kunal, that's towards the dj",
    diff(upd("kunal", balance=ANY), settle=[("Kunal", "4000.00")]),
    ref=[opn("$kunal"), act("settle_up", rows="$kunal", args="group: $wedding\namount: 4000")]),
  T("ok and settle the rest too", diff(upd("kunal", balance=ANY), settle=[("Kunal", "5000.00")]),
    ref=[act("settle_up", rows="$kunal", args="group: $wedding")]))

S("T36-109", "mixed kind-word documents notes photos",
  T("show me the wedding documents", rows("marriage_cert_d", "caterer_inv", "decor_inv", "photog_contract", "venue_receipt"),
    ref=[ans(kind="document", linked_to="$wedding_f")]),
  T("and the wedding notes",
    rows("w_budget", "w_guests", "w_rituals", "w_vendors", "w_vows", "w_settle", "w_after"),
    ref=[ans(kind="note", linked_to="$wedding_nb")]),
  T("and the photos", rows("p_haldi", "p_mehendi", "p_sangeet", "p_phere", "p_family", "p_varmala", "p_reception",
                           "p_friends", "p_decor"),
    ref=[ans(kind="photo", linked_to="$wedding_album")]),
  T("was anything deleted from the wedding documents", rows("old_quote"),
    ref=[ans(kind="document", linked_to="$wedding_f", trashed=True)]))

S("T36-110", "mixed weekday-clock reschedule",
  T("push baba's doctor visit to next friday at 3", diff(upd("doc_baba", date="2026-12-18T15:00")),
    ref=[act("reschedule", rows="$doc_baba", args=lines(to=U("week", 1, weekday=5, time="15:00")))]),
  T("and move the dentist up to next tuesday at 10", diff(upd("dentist_ev", date="2026-12-15T10:00")),
    ref=[act("reschedule", rows="$dentist_ev", args=lines(to=U("week", 1, weekday=2, time="10:00")))]))
