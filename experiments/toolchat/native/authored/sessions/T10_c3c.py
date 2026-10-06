from gold import *
import json

world("T10", "2026-06-19T14:20", "Bashir Haddad", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T10-C001", "c3c compound complete log person",
  T("tick off the leak call and log a call with hani, he's coming monday",
    diff(upd("leak", status="completed", completed=ANY), upd("hani", date=ANY)),
    ref=[act("complete", kind="task", name="Call Hani about the kitchen leak", more=True),
         act("log", kind="person", name="Hani", args=lines(kind="call"))]))

S("T10-C002", "c3c compound move document remove_from add_to",
  T("move the engineers association membership from pension to misc",
    diff(unlink("pension_f", "eng_cert"), link("misc_f", "eng_cert")),
    ref=[act("remove_from", kind="document", name="Engineers association membership", args=lines(from_="$pension_f"), more=True),
         act("add_to", rows="$eng_cert", args=lines(to="$misc_f"))]))

S("T10-C003", "c3c compound three writes cancel reschedule complete",
  T("cancel the ac technician, push the dentist to tuesday at 11 and tick off the gas cylinder",
    diff(upd("ac_service", status="cancelled"), upd("dentist", date="2026-06-23T11:00"),
         upd("gas", status="completed", completed=ANY)),
    ref=[act("cancel", kind="event", name="AC technician visit", more=True),
         act("reschedule", kind="event", name="Dentist appointment", args=lines(to=U("week", 1, weekday=2, time="11:00")), more=True),
         act("complete", kind="task", name="Order gas cylinder")]))

S("T10-C004", "c3c compound unstar star documents",
  T("unstar the fund ledger and star the tile quote, we're done with the books",
    diff(upd("fund_ledger", starred=False), upd("tile_quote", starred=True)),
    ref=[act("unstar", kind="document", name="Fund ledger", more=True),
         act("star", kind="document", name="Tile quote")]))

S("T10-C101", "c3c bulk delete per kind where starred keep",
  T('delete the documents and photos from last year, but keep the starred ones', diff(trash("car_reg"), trash("layla_chess"), unlink("grand_album", "layla_chess"), trash("aqaba_boat"), unlink("aqaba_album", "aqaba_boat"), trash("aqaba_fish"), unlink("aqaba_album", "aqaba_fish")),
    ref=[find(kind="document", when=W(U("year", -1)), where="starred = no"),
         act("delete", rows="@prev", more=True),
         find(kind="photo", when=W(U("year", -1)), where="starred = no"),
         act("delete", rows="@prev")]))

S("T10-C901", "c3c cell7 empty recovery misspelled search then span",
  T("when's the tournement", rows("tournament"),
    ref=[find(kind="event", name="tournement"), search("tournement", kind="event"), ans(rows="$tournament")]),
  T('tasks due from monday to the 28th at 5pm', rows("tiles", "gas", "pair_list", "lecture_q", "pair_print", "inspection", "clocks", "call_dana", "pairings", "pledges", "quotes", "fertilizer"),
    ref=[ans(kind="task", when=W(span(U("week", 1, weekday=1), D("2026-06-28", "17:00"))))]))

S("T10-C902", "c3c cell7 rejected complete on event ask",
  T('tick off the blood test', ask(),
    ref=[bad(act("complete", kind="event", name="Blood test")), askc("events can't be ticked off, only cancelled or deleted. cancel the blood test instead?")]))
