from gold import *
import json

world("T20", "2026-05-28T16:10", "Matteo Ricci", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T20-C001", "c3c compound edit add_to document referential",
  T("rename scan 0041 to Enel contract and put it in flat papers",
    diff(upd("scan_1", name="Enel contract"), link("casa_f", "scan_1")),
    ref=[act("edit", kind="document", name="Scan 0041", args=lines(name="Enel contract"), more=True),
         act("add_to", rows="$scan_1", args=lines(to="$casa_f"))]))

S("T20-C002", "c3c compound complete cancel",
  T("dry cleaning picked up, tick it off, and cancel the bike service",
    diff(upd("dry_clean", status="completed", completed=ANY), upd("bike_service", status="cancelled")),
    ref=[act("complete", kind="task", name="Pick up dry cleaning", more=True),
         act("cancel", kind="event", name="Bike service at the club")]))

S("T20-C003", "c3c compound reschedule reschedule tasks bare weekday",
  T("push the car tax to monday and the gas contract to wednesday",
    diff(upd("car_tax", date="2026-06-01"), upd("gas", date="2026-06-03")),
    ref=[act("reschedule", kind="task", name="Pay the car tax", args=lines(to=U("week", 1, weekday=1)), more=True),
         act("reschedule", kind="task", name="Set up gas contract", args=lines(to=U("week", 1, weekday=3)))]))

S("T20-C004", "c3c compound delete restore document photo",
  T("delete scan 0042 and bring back the blurry cellar shot",
    diff(trash("scan_2"), restore("blurry_1")),
    ref=[act("delete", kind="document", name="Scan 0042", more=True),
         act("restore", kind="photo", name="Blurry cellar shot", trashed=True)]))

S("T20-C101", "c3c bulk delete per kind last year find multi-kind",
  T('clear out everything from last year', diff(trash("chianti_2025"), trash("nebbiolo_2025"), trash("haccp"), trash("us_ring"), unlink("us_album", "us_ring"), trash("us_beach"), unlink("us_album", "us_beach")),
    ref=[find(kind="event,task,note,document,photo", when=W(U("year", -1))),
         act("delete", rows="$chianti_2025, $nebbiolo_2025", more=True),
         act("delete", rows="$haccp", more=True),
         act("delete", rows="$us_ring, $us_beach")]))

S("T20-C901", "c3c cell7 empty recovery no_link",
  T("what's on for the stag weekend group", rows("stag_weekend"),
    ref=[find(kind="event", linked_to="$stag"), ans(kind="event", name="stag weekend")]),
  T("what's due from the 29th at 9am to next friday", rows("chain", "sofia_quiz", "curtains", "chianti_1", "corkage", "invoice_fede", "rent_06", "nonna_gift", "list_whites", "enel", "boxes", "car_tax"),
    ref=[ans(kind="task", when=W(span(D("2026-05-29", "09:00"), U("week", 1, weekday=5))))]))

S("T20-C902", "c3c cell7 rejected restore past window ask",
  T('bring back the arno movers quote', ask(),
    ref=[bad(act("restore", kind="document", name="arno movers quote", trashed=True)), askc("the arno movers quote was deleted more than 30 days ago, so the vault can't bring it back. want to make a new document instead?")]))
