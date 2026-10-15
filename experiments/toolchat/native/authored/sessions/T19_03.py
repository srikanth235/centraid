from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T19-051", "five turns documents spans folder star trashed",
  T("docs added since first march", rows("cnss_feb", "prescription", "labs", "report_card", "cnss_mar", "invoice_apr",
                                     "fees_invoice", "scan_41", "scan_42", "bus_tickets"),
    ref=[ans(kind="document", when=W(span(D("2026-03-01"), U("day", 0))))]),
  T("only the pharmacy papers ones", rows("cnss_feb", "cnss_mar", "invoice_apr"),
    ref=[ans(kind="document", within="@prev", linked_to="$f_pharm")]),
  T("star the april invoice", diff(upd("invoice_apr", starred=True)),
    ref=[act("star", rows="$invoice_apr")]),
  T("and what's in there from before first march 2026 9am", rows("licence_doc", "lease"),
    ref=[ans(kind="document", linked_to="$f_pharm", when=W({"to": D("2026-03-01", "09:00")}))]),
  T("is the old lease draft in the trash", rows("lease_draft"),
    ref=[ans(kind="document", name="Old lease draft"), ans(rows="$lease_draft")]))

S("T19-052", "documents spans weekday named month open star",
  T("what docs came in from march twelfth up to last friday", rows("labs", "report_card", "cnss_mar", "bus_tickets",
                                                              "invoice_apr"),
    ref=[find(kind="document", when=W(span(D("2026-03-12"), U("week", -1, weekday=5)))), ans(rows="@prev")]),
  T("kids school ones since march", rows("report_card", "fees_invoice"),
    ref=[ans(kind="document", linked_to="$f_kids", when=W({"from": U("month", 0, name=3)}))]),
  T("and anything in kids school from before thirty-first dec 2025 6pm", rows("vacc_card"),
    ref=[ans(kind="document", linked_to="$f_kids", when=W({"to": D("2025-12-31", "18:00")}))]),
  T("star it, the nurse always asks for it", diff(upd("vacc_card", starred=True)),
    ref=[act("star", rows="$vacc_card")]))

S("T19-053", "documents spans date rel",
  T("baba's medical papers from first march till today", rows("prescription", "labs"),
    ref=[ans(kind="document", linked_to="$f_baba", when=W(span(D("2026-03-01"), U("day", 0))))]),
  T("all documents since february", rows("cnss_feb", "prescription", "labs", "report_card", "cnss_mar", "invoice_apr",
                                         "fees_invoice", "scan_41", "scan_42", "bus_tickets"),
    ref=[ans(kind="document", when=W({"from": U("month", 0, name=2)}))]),
  T("narrow it to first april up to this monday", rows("cnss_mar", "bus_tickets", "invoice_apr", "scan_42", "fees_invoice"),
    ref=[ans(kind="document", when=W(span(D("2026-04-01"), U("week", 0, weekday=1))))]))

S("T19-054", "four turns photos spans person count add_to named",
  T("photos from last month up to fifth april", rows("eid_kids", "eid_table", "eid_baba", "eid_selfie", "medal", "team",
                                                 "rx_photo", "dent", "garden", "sandcastle", "corniche", "sunset"),
    ref=[ans(kind="photo", when=W(span(U("month", -1), D("2026-04-05"))))]),
  T("pics from last week through this monday", rows("whiteboard", "tooth", "rain", "anniv_p", "receipt", "shelf_before",
                                                     "shelf_after", "drawing", "baba_walk", "meter", "menu"),
    ref=[ans(kind="photo", when=W(span(U("week", -1), U("week", 0, weekday=1))))]),
  T("which of those have people in them", rows("tooth", "anniv_p", "baba_walk", "meter"),
    ref=[ans(kind="photo", within="@prev", where="person count != 0")]),
  T("put lina's drawing in the family album too", diff(link("a_family", "drawing")),
    ref=[act("add_to", rows="$drawing", args=lines(to="$a_family"))]))

S("T19-055", "photos album spans person count",
  T("kids album pics from two weeks ago up to the fifth", rows("sandcastle", "corniche"),
    ref=[ans(kind="photo", linked_to="$a_kids", when=W(span(U("week", -2), D("2026-04-05"))))]),
  T("and from last month to last sunday", rows("eid_kids", "medal", "sandcastle", "corniche", "tooth", "drawing"),
    ref=[ans(kind="photo", linked_to="$a_kids", when=W(span(U("month", -1), U("week", -1, weekday=7))))]),
  T("in the kids album which ones aren't one person", rows("eid_kids", "drawing"),
    ref=[ans(kind="photo", linked_to="$a_kids", where="person count != 1")]))

S("T19-057", "album linked_to all photos read",
  T("albums with baba's walk in the park and the anniversary dinner photo", rows("a_family"),
    ref=[find(kind="album", linked_to="$baba_walk, $anniv_p"), ans(rows="@prev")]),
  T("what else is in there", rows("eid_table", "eid_baba", "anniv_p", "garden", "baba_walk", "snow"),
    ref=[ans(kind="photo", linked_to="$a_family")]))

S("T19-065", "event overlap refused ask create undo create",
  T("lunch with nadia saturday at 2", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Lunch with Nadia",
                                      date=U("week", 0, weekday=6, time="14:00"), duration=60))),
         askc("the stock count runs 1 to 5 that saturday. earlier?")]),
  T("11:30 then, for an hour", diff(new("event", name="Lunch with Nadia", date="2026-04-18T11:30")),
    ref=[act("create", args=lines(kind="event", name="Lunch with Nadia",
                                  date=U("week", 0, weekday=6, time="11:30"), duration=60))]),
  T("undo that, she's off that day", diff(trash("+1")),
    ref=[act("undo")]))

S("T19-066", "refused delete folder ask delete docs folder",
  T("delete the car folder, we sold the car", ask(),
    ref=[bad(act("delete", rows="$f_car")),
         askc("car still has the insurance and registration papers in it, so it can't go. move them somewhere first?")]),
  T("move both into home papers and then delete it",
    diff(unlink("f_car", "car_ins_doc"), unlink("f_car", "carte_grise"), link("f_home", "car_ins_doc"),
         link("f_home", "carte_grise"), gone("f_car")),
    ref=[find(kind="document", linked_to="$f_car"),
         act("remove_from", rows="@prev", args=lines(from_="$f_car"), more=True),
         act("add_to", rows="@prev", args=lines(to="$f_home"), more=True),
         act("delete", rows="$f_car")]),
  T("what folders are left", rows("f_pharm", "f_baba", "f_kids", "f_home", "f_tax"),
    ref=[ans(kind="folder")]))

S("T19-069", "restore window note ask create note",
  T("can you get back the old school rota 2025 note", ask(),
    ref=[bad(act("restore", kind="note", name="Old school rota 2025", trashed=True)),
         askc("that one was binned in january, too long ago to restore. want me to make a new one?")]),
  T("yes, School rota 2025, put with Driss and Meriem",
    diff(new("note", name="School rota 2025", body=has("Driss"))),
    ref=[act("create", args=lines(kind="note", name="School rota 2025", body="with Driss and Meriem"))]))

S("T19-070", "add_to photo named undo link",
  T("put lina's cake last year in the family album", diff(link("a_family", "cake_2025")),
    ref=[act("add_to", rows="$cake_2025", args=lines(to="$a_family"))]),
  T("undo, it's fine where it was", diff(unlink("a_family", "cake_2025")),
    ref=[act("undo")]))

S("T19-071", "trashed people restore window undo restore",
  T("who did i delete from contacts", rows("tarik", "sanae", "jamal"),
    ref=[find(kind="person", trashed=True), ans(rows="@prev")]),
  T("bring back tarik and jamal", diff(restore("tarik")),
    ref=[bad(act("restore", rows="$tarik, $jamal")),
         act("restore", rows="$tarik")]),
  T("undo that, tarik left the wholesaler", diff(trash("tarik")),
    ref=[act("undo")]))

S("T19-072", "find miss search person log undo ledger",
  T("mouhssine, when was the last time we spoke", rows("mouhcine"),
    ref=[find(kind="person", name="Mouhssine"), search("mouhssine", kind="person"), ans(rows="$mouhcine")]),
  T("log a call with him", diff(upd("mouhcine", date=ANY)),
    ref=[act("log", rows="$mouhcine", args=lines(kind="call"))]),
  T("undo that, he didn't pick up", diff(),
    ref=[act("undo")]))

S("T19-073", "four turns dentist ambiguous ask reschedule",
  T("move the dentist to 6:30", ask("dentist_adam", "dentist_me"),
    ref=[act("reschedule", kind="event", name="Dentist", args=lines(to={"unit": "minute", "rel": 30, "anchor": "row"})),
         askc("adam's on the 24th or yours on 7 may?", options="$dentist_adam, $dentist_me")]),
  T("adam's", diff(upd("dentist_adam", date="2026-04-24T18:30")),
    ref=[act("reschedule", rows="$dentist_adam", args=lines(to=D("2026-04-24", "18:30")))]),
  T("and mine to the eighth, same time", diff(upd("dentist_me", date="2026-05-08T18:30")),
    ref=[act("reschedule", rows="$dentist_me", args=lines(to=D("2026-05-08", "18:30")))]),
  T("what's on the eighth", rows("dentist_me"),
    ref=[ans(kind="event", when=W(D("2026-05-08")))]))

S("T19-074", "five turns pharmacy tomorrow ambiguous person log note edit",
  T("what's left for me on the pharmacy list tomorrow", rows("cnss_claims"),
    ref=[ans(kind="task", linked_to="$pharm_l", when=W(U("day", 1)))]),
  T("and what's in the diary tomorrow", rows("berrada_meet", "lina_vacc", "swim_0415"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("log a call with youssef, he rang about the samples", diff(upd("youssef_b", date=ANY)),
    ref=[act("log", kind="person", name="Youssef", args=lines(kind="call")),
         act("log", rows="$youssef_b", args=lines(kind="call"))]),
  T("what's in the wholesaler prices note", rows("prices"),
    ref=[ans(kind="note", name="Wholesaler prices")]),
  T("strips went up to 170 a box, fix it", diff(upd("prices", body=has("170"))),
    ref=[act("edit", rows="$prices", args=lines(body="strips 170 a box, lancets 40, pen needles 90"))]),
  T("and tick the weekly wholesaler order, sent it at lunch", diff(upd("order_0416", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Weekly wholesaler order")]))

S("T19-075", "single decline out_of_scope dosage",
  T("what's the max metformin dose for a 70 year old", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))
