from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T14-051", "single person to named month",
  T("who haven't i been in touch with since the end of september", rows("lurdes", "regina", "fernanda"),
    ref=[find(kind="person", when=W({"to": U("month", 0, name=9)})), ans(rows="@prev")]))

S("T14-052", "person datetime span log settle_up",
  T("who did i talk to between tuesday 6pm and thursday", rows("patricia", "rafa_m", "nath", "mae", "thiago"),
    ref=[find(kind="person", when=W(span(U("week", 0, weekday=2, time="18:00"), U("week", 0, weekday=4)))), ans(rows="@prev")]),
  T("which of them are my mother, sister or cousin", rows("patricia", "mae", "thiago"),
    ref=[ans(within="@prev", where='role in ("sister", "mother", "cousin")')]),
  T("called patrícia again, log it", diff(upd("patricia", date=ANY)),
    ref=[act("log", rows="$patricia", args=lines(kind="call"))]),
  T("and settle up with patrícia ferreira in mãe's medical bills", diff(settle=[("Patrícia Ferreira", "50.00")]),
    ref=[act("settle_up", rows="$patricia", args=lines(group="$mae_g"))]))

S("T14-053", "person month to date nickname log",
  T("who'd i been in touch with from last month up to oct fifth", rows("regina", "lurdes", "diego", "jorge"),
    ref=[find(kind="person", when=W(span(U("month", -1), D("2026-10-05")))), ans(rows="@prev")]),
  T("seu jorge came round about the leak, log a visit", diff(upd("jorge", date=ANY)),
    ref=[act("log", kind="person", where='nickname = "Seu Jorge"', args=lines(kind="visit"))]),
  T("when's the landlord visit to check it properly", rows("landlord"),
    ref=[ans(kind="event", linked_to="$jorge")]))

S("T14-054", "find-only gigs span cancel log undo ledger",
  T("what dj sets have i got from next monday till nov eighth", rows("kleber_1030", "cv_1107"),
    ref=[find(kind="event", name="DJ set", when=W(span(U("week", 1, weekday=1), D("2026-11-08")))), ans(rows="@prev")]),
  T("cancel the dj set at casa vermelha on the seventh, priscila double booked", diff(upd("cv_1107", status="cancelled")),
    ref=[act("cancel", rows="$cv_1107")]),
  T("log a message with priscila andrade, i told her it's fine", diff(upd("priscila", date=ANY)),
    ref=[act("log", rows="$priscila", args=lines(kind="message"))]),
  T("undo that", diff(),
    ref=[act("undo")]))

S("T14-055", "five turns mom span reschedule anchor",
  T("what's on with mãe from next monday to the end of november",
    rows("blood_work", "physio_1029", "lunch_mae", "cardio_nov", "pickup_mae", "physio_1105", "vo_80"),
    ref=[search("mãe", kind="person"),
         ans(kind="event", linked_to="$mae", when=W(span(U("week", 1, weekday=1), U("month", 0, name=11))))]),
  T("move mom's blood work to 8", diff(upd("blood_work", date="2026-10-27T08:00")),
    ref=[act("reschedule", rows="$blood_work", args=lines(to=U("day", 0, anchor="row", time="08:00")))]),
  T("does it say she has to fast", rows("blood_work"),
    ref=[ans(rows="$blood_work")]),
  T("who's going to vó lurdes' 80th birthday", rows("lurdes", "mae", "patricia", "diego", "thiago"),
    ref=[ans(kind="person", linked_to="$vo_80")]),
  T("and order cake for vó lurdes, done?", rows("cake_vo"),
    ref=[ans(kind="task", name="Order cake for Vó Lurdes")]))

S("T14-057", "task from date casa reschedule",
  T("what's on the casa list from november first on", rows("rent_nov", "shelf"),
    ref=[ans(kind="task", linked_to="$casa_l", when=W({"from": D("2026-11-01")}))]),
  T("rent's priority one right", rows("rent_nov"),
    ref=[ans(rows="$rent_nov")]),
  T("push put up the record shelf to the twenty-second", diff(upd("shelf", date="2026-11-22")),
    ref=[act("reschedule", rows="$shelf", args=lines(to=D("2026-11-22")))]))

S("T14-058", "overdue write+read reschedule empty",
  T("what's overdue", rows("rating", "gas"),
    ref=[ans(kind="task", when=W({"to": U("day", -1)}), where='status = "open"')]),
  T("gas is done, what does that leave", rows("rating", also=diff(upd("gas", status="completed", completed=ANY))),
    ref=[act("complete", rows="$gas", more=True),
         ans(kind="task", when=W({"to": U("day", -1)}), where='status = "open"')]),
  T("move check uber rating dispute to monday", diff(upd("rating", date="2026-10-26")),
    ref=[act("reschedule", rows="$rating", args=lines(to=U("week", 1, weekday=1)))]),
  T("anything overdue now", rows(),
    ref=[ans(kind="task", when=W({"to": U("day", -1)}), where='status = "open"')]))

S("T14-059", "task to date reschedule multi",
  T("what's open due by sunday", rows("rating", "gas", "setlist12", "usb", "otavio_receipt", "tyre_pay"),
    ref=[ans(kind="task", when=W({"to": U("week", 0, weekday=7)}), where='status = "open"')]),
  T("move back up usb sticks and send otávio his receipts to monday",
    diff(upd("usb", date="2026-10-26"), upd("otavio_receipt", date="2026-10-26")),
    ref=[act("reschedule", rows="$usb, $otavio_receipt", args=lines(to=U("week", 1, weekday=1)))]),
  T("what's monday look like for tasks", rows("mae_meds", "diego_call", "phone_mount", "usb", "otavio_receipt"),
    ref=[ans(kind="task", when=W(U("week", 1, weekday=1)))]))

S("T14-061", "notes month to weekday",
  T("notes from this month up to wednesday",
    rows("set_kleber", "idea_collab", "pharm_1", "set_cv", "idea_sample", "gift_ideas", "airport_tips", "vo_party",
         "idea_edit", "pharm_2", "set12", "lease_note", "car_km"),
    ref=[ans(kind="note", when=W(span(U("month", 0), U("week", 0, weekday=3))))]),
  T("what's the collab with guga one say", rows("idea_collab"),
    ref=[ans(kind="note", name="Collab with Guga")]))

S("T14-062", "documents named month starred edit",
  T("docs from september", rows("ins_policy", "rx", "das_sep", "echo_doc", "contract_cv"),
    ref=[find(kind="document", when=W(U("month", 0, name=9))), ans(rows="@prev")]),
  T("which of them are starred", rows("echo_doc"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("rename casa vermelha contract to Casa Vermelha contract 2026", diff(upd("contract_cv", name="Casa Vermelha contract 2026")),
    ref=[act("edit", rows="$contract_cv", args=lines(name="Casa Vermelha contract 2026"))]))

S("T14-063", "document anchor week edit prev add_to",
  T("any docs from last week", rows("rider"),
    ref=[find(kind="document", when=W(U("week", -1, anchor="today"))), ans(rows="@prev")]),
  T("call it Technical rider v2", diff(upd("rider", name="Technical rider v2")),
    ref=[act("edit", rows="@prev", args=lines(name="Technical rider v2"))]),
  T("and put it in gig contracts", diff(link("contracts_f", "rider")),
    ref=[act("add_to", rows="$rider", args=lines(to="$contracts_f"))]),
  T("what's in gig contracts", rows("contract_cv", "contract_bsas", "contract_kleber", "rider"),
    ref=[ans(kind="document", linked_to="$contracts_f")]))

S("T14-064", "document august span folder remove undo link",
  T("documents from august up to sept twentieth", rows("blood_doc", "das_aug", "ins_policy", "rx", "das_sep"),
    ref=[find(kind="document", when=W(span(U("month", 0, name=8), D("2026-09-20")))), ans(rows="@prev")]),
  T("which folder's das august receipt in", rows("mei_f"),
    ref=[ans(kind="folder", linked_to="$das_aug")]),
  T("take das august receipt out of mei taxes", diff(unlink("mei_f", "das_aug")),
    ref=[act("remove_from", rows="$das_aug", args=lines(from_="$mei_f"))]),
  T("hm undo, it belongs there", diff(link("mei_f", "das_aug")),
    ref=[act("undo")]),
  T("how many docs in mei taxes", val(3),
    ref=[ans(op="count", kind="document", linked_to="$mei_f")]))

S("T14-065", "document month to today within trashed",
  T("any documents from september till today",
    rows("ins_policy", "rx", "das_sep", "echo_doc", "contract_cv", "tyre_rcpt", "contract_bsas", "rider", "fuel_rcpt"),
    ref=[ans(kind="document", when=W(span(U("month", 0, name=9), U("day", 0))))]),
  T("which aren't in a folder", rows("rider"),
    ref=[ans(within="@prev", where="folder count = 0")]),
  T("what's in the doc trash", rows("old_contract", "old_lease"),
    ref=[find(kind="document", trashed=True), ans(rows="@prev")]))

S("T14-066", "photo datetime span star multi add_to undo",
  T("photos from the baile #11 night, 10pm on sept nineteenth to 5am",
    rows("b11_sound", "b11_crowd", "b11_booth", "b11_team"),
    ref=[ans(kind="photo", when=W(span(D("2026-09-19", "22:00"), D("2026-09-20", "05:00"))))]),
  T("star rafael fixing the sub and nath and guga in the booth",
    diff(upd("b11_sound", starred=True), upd("b11_booth", starred=True)),
    ref=[act("star", rows="$b11_sound, $b11_booth")]),
  T("add those two to gigs 2026", diff(link("gigs_album", "b11_sound"), link("gigs_album", "b11_booth")),
    ref=[act("add_to", rows="$b11_sound, $b11_booth", args=lines(to="$gigs_album"))]),
  T("undo that last bit", diff(unlink("gigs_album", "b11_sound"), unlink("gigs_album", "b11_booth")),
    ref=[act("undo")]))

S("T14-067", "photo datetime to month trashed restore album",
  T("pics from 10pm on the sixteenth through the end of october",
    rows("p_kleber_1016", "car_odo", "movie_night", "vinyl_haul", "rain_car", "football", "haircut_p"),
    ref=[ans(kind="photo", when=W(span(D("2026-10-16", "22:00"), U("month", 0, name=10))))]),
  T("any deleted ones in that stretch", rows("blurry_booth"),
    ref=[ans(kind="photo", trashed=True, when=W(span(D("2026-10-16", "22:00"), U("month", 0, name=10))))]),
  T("restore it", diff(restore("blurry_booth")),
    ref=[act("restore", rows="$blurry_booth")]),
  T("is it back in gigs 2026", rows("b11_crowd", "p_kleber_1002", "cv_selfie", "p_kleber_1016"),
    ref=[ans(kind="photo", linked_to="$gigs_album")]))

S("T14-068", "photo to august trashed restore window",
  T("old photos, anything up to august", rows("family_lunch"),
    ref=[ans(kind="photo", when=W({"to": U("month", 0, name=8)}))]),
  T("and in the trash?", rows("felipe_p", "old_car"),
    ref=[ans(kind="photo", when=W({"to": U("month", 0, name=8)}), trashed=True)]),
  T("restore felipe and me at the old studio", diff(restore("felipe_p")),
    ref=[act("restore", rows="$felipe_p")]),
  T("and the old gol", ask(),
    ref=[find(kind="photo", name="Gol", trashed=True),
         bad(act("restore", rows="$old_car")),
         askc("the old gol pic has been in the bin past the 30-day window, so it can't come back. anything else?")]))

S("T14-069", "debt last friday within settle prev undo ledger",
  T("what debts came up last friday", rows("d_rafa_s", "d_kleber"),
    ref=[ans(kind="debt", when=W(U("week", -1, weekday=5)))]),
  T("which is kleber's", rows("d_kleber"),
    ref=[ans(within="@prev", linked_to="$kleber")]),
  T("he paid it, settle it", diff(upd("d_kleber", status="settled")),
    ref=[act("settle_debt", rows="@prev")]),
  T("undo that, the pix bounced", diff(),
    ref=[act("undo")]))

S("T14-070", "debt from month within sum",
  T("debts since the start of this month",
    rows("d_thiago", "d_kleber_old", "d_junior", "d_bianca", "d_rafa_s", "d_kleber", "d_nath", "d_guga", "d_wesley"),
    ref=[find(kind="debt", when=W({"from": U("month", 0)})), ans(rows="@prev")]),
  T("the ones i owe", rows("d_junior", "d_nath", "d_wesley"),
    ref=[ans(within="@prev", where='direction = "i_owe"')]),
  T("total?", val((495, "BRL")),
    ref=[ans(op="sum", field="amount", within="@prev")]))

S("T14-071", "debt weekday to month compute min settle",
  T("debts from last monday to the end of october", rows("d_rafa_s", "d_kleber", "d_nath", "d_guga", "d_wesley"),
    ref=[find(kind="debt", when=W(span(U("week", -1, weekday=1), U("month", 0, name=10)))), ans(rows="@prev")]),
  T("smallest of those each way", vgroups({"owes_me": (85, "BRL"), "i_owe": (35, "BRL")}),
    ref=[comp(op="min", field="amount", within="@prev", group="direction"), ans(value="@prev")]),
  T("and the biggest i'm owed", val((600, "BRL")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("settle the uber to the gig one, paid nath back", diff(upd("d_nath", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Uber to the gig")]),
  T("so how much am i on the hook for", val((865, "BRL")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T14-073", "create event reschedule new linked",
  T("put a studio session with nath on monday at 2pm", diff(new("event", name=has("Studio"), date="2026-10-26T14:00")),
    ref=[act("create", args=lines(kind="event", name="Studio session with Nath", date=U("week", 1, weekday=1, time="14:00")))]),
  T("make it 4 instead", diff(upd("+1", date="2026-10-26T16:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("day", 0, anchor="row", time="16:00")))]),
  T("what else is on monday", rows("hand_1026"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=1)), exclude="$c1")]),
  T("what do i owe nath", val((-40, "BRL")),
    ref=[search("nath", kind="person"), ans(op="balance", rows="$nath")]))

S("T14-074", "single create complete new",
  T("add renew spotify premium and tick it off, did it",
    diff(new("task", name=has("Spotify"), status="completed", completed=ANY)),
    ref=[act("create", more=True, args=lines(kind="task", name="Renew Spotify premium")),
         act("complete", rows="$new")]))

S("T14-075", "document create star unstar new",
  T("add a doc Niceto tech sheet into gig contracts, star it",
    diff(new("document", name="Niceto tech sheet", starred=True), link("contracts_f", "new")),
    ref=[act("create", more=True, args=lines(kind="document", name="Niceto tech sheet", folder="$contracts_f")),
         act("star", rows="$new")]),
  T("unstar that, guga has the final one", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))
