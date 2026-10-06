from gold import *
import json

world("T10", "2026-06-19T14:20", "Bashir Haddad", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T10-001", "events tomorrow reschedule linked task reschedule",
  T("what have i got tomorrow", rows("ac_service", "call_layla_0620"),
    ref=[find(kind="event", when=W(U("day", 1))), ans(rows="@prev")]),
  T("the ac guy, can he come at 12 instead", diff(upd("ac_service", date="2026-06-20T12:00")),
    ref=[act("reschedule", rows="$ac_service", args=lines(to=U("day", 1, time="12:00")))]),
  T("who's on the video call with layla", rows("layla", "lina"),
    ref=[ans(kind="person", linked_to="$call_layla_0620")]),
  T("move service the air conditioner to monday then, he'll do it after", diff(upd("ac", date="2026-06-22")),
    ref=[act("reschedule", kind="task", name="Service the air conditioner", args=lines(to=U("week", 1, weekday=1)))]))

S("T10-002", "reschedule task named list read",
  T("push renew passport to the end of september", diff(upd("passport", date="2026-09-30")),
    ref=[act("reschedule", kind="task", name="Renew passport", args=lines(to=D("2026-09-30")))]))

S("T10-003", "event weekday reschedule prev linked",
  T("what's on wednesday", rows("dentist"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=3)))]),
  T("shift it to 11am", diff(upd("dentist", date="2026-06-24T11:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("day", 0, anchor="row", time="11:00")))]),
  T("who's the dentist appointment with again", rows("issa"),
    ref=[ans(kind="person", linked_to="$dentist")]))

S("T10-004", "single cancelled this month",
  T("what got cancelled this month", rows("reunion", "walid_coffee"),
    ref=[find(kind="event", when=W(U("month", 0)), where='status = "cancelled"'), ans(rows="@prev")]))

S("T10-006", "trashed event empty recovery restore date",
  T("didn't i have lunch with jamal in the diary", rows("jamal_lunch"),
    ref=[ans(kind="event", name="Lunch with Jamal"),
         ans(kind="event", name="Lunch with Jamal", trashed=True)]),
  T("put it back, he rang again", diff(restore("jamal_lunch")),
    ref=[act("restore", rows="$jamal_lunch")]),
  T("what's the rest of that thursday", rows("abu_fadi_coffee"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=4)), exclude="$jamal_lunch")]))

S("T10-007", "effort unit within overdue",
  T("anything quick open, under thirty mins", rows("receipts", "leak", "sat_task", "pills", "call_dana", "gas", "pair_print"),
    ref=[find(kind="task", where='effort < 30 minutes and status = "open"'), ans(rows="@prev")]),
  T("which of those are overdue", rows("receipts"),
    ref=[ans(within="@prev", when=W({"to": U("day", -1)}))]))

S("T10-008", "group members remove multi balance",
  T("who's in the chess club kitty", rows("sami_k", "tariq", "walid", "faris", "mounir", "me"),
    ref=[ans(kind="person", linked_to="$chess")]),
  T("where am i in it", val((-18, "JOD")),
    ref=[ans(op="balance", kind="group", name="Chess club kitty", linked_to="$me")]),
  T("take walid and mounir out, they never chip in", diff(unlink("chess", "walid"), unlink("chess", "mounir")),
    ref=[act("remove_from", rows="$walid, $mounir", args=lines(from_="$chess"))]))

S("T10-009", "compute max min debts",
  T("what's the most anyone owes me right", val((120, "JOD")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("and the least", val((8, "JOD")),
    ref=[ans(op="min", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]))

S("T10-010", "edit event multi description",
  T("when are the blood test at al-borg lab and the dentist appointment", rows("blood_test", "dentist"),
    ref=[ans(rows="$blood_test, $dentist")]),
  T("put bring the insurance card on both",
    diff(upd("blood_test", description="bring the insurance card"), upd("dentist", description="bring the insurance card")),
    ref=[act("edit", rows="$blood_test, $dentist", args=lines(description="bring the insurance card"))]),
  T("same on next month's cardiology", diff(upd("cardio_jul", description="bring the insurance card")),
    ref=[act("edit", kind="event", name="Cardiology check-up", when=W(U("month", 1)),
             args=lines(description="bring the insurance card"))]))

S("T10-011", "ambiguous person log ask",
  T("log a call with sami", ask("sami_h", "sami_k"),
    ref=[act("log", kind="person", name="Sami", args=lines(kind="call")),
         askc("sami haddad your grandson or sami khoury from chess?", options="$sami_h, $sami_k")]),
  T("my grandson", diff(upd("sami_h", date=ANY)),
    ref=[act("log", rows="$sami_h", args=lines(kind="call"))]))

S("T10-012", "create person delete new open tasks",
  T("add a contact Munther Qasem, tile supplier, al-nour", diff(new("person", name="Munther Qasem", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Munther Qasem", role="tile supplier, Al-Nour"))]),
  T("hmm ziad already has him. delete that contact", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("when's the ablution area renovation due", rows("ablution"),
    ref=[ans(kind="task", name="Ablution area renovation")]),
  T("what's open under it", rows("tiles", "plumber", "taps"),
    ref=[ans(kind="task", linked_to="$ablution", where='status = "open"')]))

S("T10-013", "note create add_to new count",
  T("note: Sicilian dragon - watch the h-file, Faris always castles long",
    diff(new("note", name=has("Sicilian"), body=has("h-file"))),
    ref=[act("create", args=lines(kind="note", name="Sicilian dragon", body="watch the h-file, Faris always castles long"))]),
  T("put it in chess openings", diff(link("chess_nb", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$chess_nb"))]),
  T("how many notes in there", val(5),
    ref=[ans(op="count", kind="note", linked_to="$chess_nb")]))

S("T10-014", "balance person settle debt",
  T("do i owe nabil or does he owe me", val((-44, "JOD")),
    ref=[ans(op="balance", rows="$nabil")]),
  T("settle the chalet one, gave him cash at lunch", diff(upd("d_nabil", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Chalet share")]))

S("T10-015", "log where nickname debt linked",
  T("had coffee with abu fadi this morning", diff(upd("abu_fadi", date=ANY)),
    ref=[act("log", kind="person", where='nickname = "Abu Fadi"', args=lines(kind="coffee"))]),
  T("does he owe me for the coffee beans from kuwait", rows("d_abu_fadi"),
    ref=[ans(kind="debt", linked_to="$abu_fadi")]))

S("T10-016", "locker edit where starred",
  T("new router. rename the wifi entry to Home wifi 5G", diff(upd("wifi", name="Home wifi 5G")),
    ref=[act("edit", kind="locker item", where='type = "wifi"', args=lines(name="Home wifi 5G"))]),
  T("what's starred in the locker", rows("gmail", "visa_card", "jea"),
    ref=[find(kind="locker item", where="starred = yes"), ans(rows="@prev")]))

S("T10-017", "star document multi starred",
  T("star the pension statement june and pension statement may",
    diff(upd("pension_june", starred=True), upd("pension_may", starred=True)),
    ref=[act("star", rows="$pension_june, $pension_may")]),
  T("which docs are starred", rows("pension_letter", "deed_house", "fund_ledger", "pension_june", "pension_may"),
    ref=[find(kind="document", where="starred = yes"), ans(rows="@prev")]))

S("T10-018", "add_to document where count",
  T("can you stick whatever doc isn't in a folder into Pension", diff(link("pension_f", "chess_rating")),
    ref=[act("add_to", kind="document", where="folder count = 0", args=lines(to="$pension_f"))]),
  T("how many in pension", val(5),
    ref=[ans(op="count", kind="document", linked_to="$pension_f")]))

S("T10-019", "task month-name span open complete log",
  T("tasks due from the start of june till today", rows("sat_task", "receipts", "elec_06", "leak"),
    ref=[ans(kind="task", when=W(span(U("month", 0, name=6), U("day", 0))))]),
  T("which are still open", rows("sat_task", "receipts", "leak"),
    ref=[ans(within="@prev", where='status = "open"')]),
  T("did the leak one, hani came", diff(upd("leak", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Call Hani about the kitchen leak")]),
  T("log a visit from him", diff(upd("hani", date=ANY)),
    ref=[act("log", rows="$hani", args=lines(kind="visit"))]))

S("T10-020", "reschedule task multi date read",
  T("push the tile quotes and the chess clocks to next saturday",
    diff(upd("quotes", date="2026-06-27"), upd("clocks", date="2026-06-27")),
    ref=[act("reschedule", rows="$quotes, $clocks", args=lines(to=U("week", 1, weekday=6)))]),
  T("what's due that day", rows("inspection", "pledges", "quotes", "clocks"),
    ref=[ans(kind="task", when=W(D("2026-06-27")))]))

S("T10-021", "five turns grandson call photo star tasks",
  T("when's my next call with yousef", rows("call_yousef_0628"),
    ref=[ans(kind="event", name="Video call with Yousef", when=W({"from": U("day", 0)}))]),
  T("make it 6", diff(upd("call_yousef_0628", date="2026-06-28T18:00")),
    ref=[act("reschedule", rows="$call_yousef_0628", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("pics of him?", rows("adha_call", "yousef_bike", "yousef_grad"),
    ref=[ans(kind="photo", linked_to="$yousef")]),
  T("star the graduation one", diff(upd("yousef_grad", starred=True)),
    ref=[act("star", rows="$yousef_grad")]),
  T("what have i promised him", rows("yousef_chess", "bike"),
    ref=[ans(kind="task", linked_to="$yousef")]))

S("T10-022", "trashed photos restore multi",
  T("what pics have i deleted", rows("trash_selfie", "trash_menu", "trash_old"),
    ref=[find(kind="photo", trashed=True), ans(rows="@prev")]),
  T("bring back the selfie and the menu", diff(restore("trash_selfie"), restore("trash_menu")),
    ref=[act("restore", rows="$trash_selfie, $trash_menu")]))

S("T10-023", "photo starred unstar multi",
  T("which photos have i starred",
    rows("fitr_table", "adha_family", "yousef_bike", "chess_trophy", "aqaba_sea", "jasmine_p", "umm_rami", "wedding_old"),
    ref=[find(kind="photo", where="starred = yes"), ans(rows="@prev")]),
  T("unstar the red sea and the jasmine ones", diff(upd("aqaba_sea", starred=False), upd("jasmine_p", starred=False)),
    ref=[act("unstar", rows="$aqaba_sea, $jasmine_p")]))

S("T10-024", "ambiguous album delete multi count",
  T("delete the eid album", ask("fitr_album", "adha_album"),
    ref=[act("delete", kind="album", name="Eid"),
         askc("eid al-fitr or eid al-adha?", options="$fitr_album, $adha_album")]),
  T("neither, keep those. delete phone dump and blurry shots",
    diff(gone("dump_album"), gone("blurry_album"), unlink("dump_album", "dump_receipt"), unlink("dump_album", "dump_meter"),
         unlink("blurry_album", "blur_1"), unlink("blurry_album", "blur_2")),
    ref=[act("delete", rows="$dump_album, $blurry_album")]),
  T("how many albums left", val(5),
    ref=[ans(op="count", kind="album")]))

S("T10-025", "task read add_to prev",
  T("when's print photos for omar due", rows("print_omar"),
    ref=[ans(kind="task", name="Print photos for Omar")]),
  T("stick it on my home list", diff(link("home_l", "print_omar")),
    ref=[act("add_to", rows="@prev", args=lines(to="$home_l"))]))
