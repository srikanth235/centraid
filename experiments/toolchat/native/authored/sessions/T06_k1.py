from gold import *

world("T06", "2026-02-07T23:15", "Lukas Brandt", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))


OPEN = 'status = "open"'

S("T06-K001", "referent software licence renew i3skill S1",
  T("show me the pro tools licence", rows("protools"),
    ref=[ans(kind="locker item", name="Pro Tools")]),
  T("when does it renew", rows("protools"),
    ref=[ans(rows="$protools")]))

S("T06-K002", "referent count narrows priority i3skill S1",
  T("how many tasks are open on the freelance admin list", val(7),
    ref=[ans(kind="task", op="count", linked_to="$adminlist", where=OPEN)]),
  T("how many are priority 1", val(2),
    ref=[ans(kind="task", op="count", linked_to="$adminlist", where=OPEN + " and priority = 1")]))

S("T06-K003", "referent event people it i3skill S1",
  T("when's the gig at klub rybka", rows("gig_prague"),
    ref=[ans(kind="event", name="Klub Rybka")]),
  T("who's going to it", rows("jonas_w", "lena", "kalle", "marek", "pavla"),
    ref=[ans(kind="person", linked_to="$gig_prague")]))

S("T06-K004", "referent created task bare weekday i3skill S1",
  T("add a task get a new snare head", diff(new("task", name=has("snare"))),
    ref=[act("create", args=lines(kind="task", name="Get a new snare head"))]),
  T("make it due friday", diff(upd("+1", date="2026-02-13")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 1, weekday=5)))]))

S("T06-K005", "referent person he log i3skill S1",
  T("when did i last talk to jonas wirth", rows("jonas_w"),
    ref=[ans(kind="person", name="Jonas Wirth")]),
  T("log a call with him", diff(upd("jonas_w", date=ANY)),
    ref=[act("log", rows="$jonas_w", args=lines(kind="call"))]))

S("T06-K006", "referent list then the noun i3skill S1",
  T("what's open on the gear list", rows("backup", "xlr", "sell_mixer", "in_ears"),
    ref=[ans(kind="task", linked_to="$gearlist", where=OPEN)]),
  T("done with the cables", diff(upd("xlr", status="completed", completed=ANY)),
    ref=[act("complete", rows="$xlr")]))

S("T06-K007", "referent debt he it paid i3skill S1",
  T("what's the beer crate thing", rows("d_kalle_beer"),
    ref=[ans(kind="debt", name="Beer crate")]),
  T("has he paid it", rows("d_kalle_beer"),
    ref=[ans(rows="$d_kalle_beer")]))

S("T06-K008", "perfect did we this month i3skill S2",
  T("how many rehearsals have we had this month", val(1),
    ref=[ans(kind="event", op="count", name="Band rehearsal", when=J({"from": U("month", 0), "to": U("day", 0)}))]))

S("T06-K009", "single day friday sunday saturday today i3skill S2",
  T("what's on friday", rows("sc_0213", "gig_tonkeller"),
    ref=[ans(kind="event", when=J(U("week", 1, weekday=5)))]),
  T("and sunday", rows("wg_feb"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=7)))]))

S("T06-K010", "still in february ahead i3skill S2",
  T("is the tax meeting still in february", rows("tax_meet"),
    ref=[ans(kind="event", name="Tax meeting", when=J(U("month", 0, name=2)))]))

S("T06-K011", "still in march ahead i3skill S2",
  T("is kalle's birthday still in march", rows("kalle_bday"),
    ref=[ans(kind="event", name="Kalle's birthday", when=J(U("month", 0, name=3)))]))

S("T06-K012", "duration hours minutes effort i3skill S2",
  T("which tasks take 2 hours or more", rows("live_mix", "vat"),
    ref=[ans(kind="task", where="effort >= 120")]),
  T("and the ones over 3 hours", rows("live_mix"),
    ref=[ans(kind="task", where="effort > 180")]))

S("T06-K013", "cadence days weeks i3skill S2",
  T("who do i talk to every ten days", rows("sophie"),
    ref=[ans(kind="person", where="cadence = 10 days")]),
  T("and every three weeks", rows("olli", "hannah_s"),
    ref=[ans(kind="person", where="cadence = 21 days")]))

S("T06-K014", "relation to event dates line i3skill S2",
  T("what's left on the freelance admin list before the tax meeting", rows("inv_jan", "inv_greta", "vat", "receipts"),
    ref=[ans(kind="task", linked_to="$adminlist", where=OPEN, when=J({"to": D("2026-02-24")}))]))

S("T06-K015", "read not write invoice sent i3skill S3",
  T("did i send the invoice to theater lindenau", rows("inv_jan", "inv_feb"),
    ref=[ans(kind="task", name="Send invoice to Theater Lindenau")]))

S("T06-K016", "read debt i owe ines i3skill S3",
  T("did i pay ines for the prints", rows("d_ines_prints"),
    ref=[ans(kind="debt", name="Gig photo prints")]))

S("T06-K017", "read debt two follow i3skill S3",
  T("has kalle paid me for the beer", rows("d_kalle_beer"),
    ref=[ans(kind="debt", name="Beer crate")]),
  T("and the strings", rows("d_kalle_strings"),
    ref=[ans(kind="debt", name="Guitar strings")]))

S("T06-K018", "read cancelled open mic i3skill S3",
  T("was the open mic cancelled", rows("open_mic"),
    ref=[ans(kind="event", name="Open mic")]))

S("T06-K019", "read then write vat i3skill S3",
  T("is the vat return done", rows("vat"),
    ref=[ans(kind="task", name="VAT return")]),
  T("filed it just now, tick it off", diff(upd("vat", status="completed", completed=ANY)),
    ref=[act("complete", rows="$vat")]))

S("T06-K020", "read starred of them logins i3skill S3",
  T("what logins have i got", rows("thomann", "elster"),
    ref=[ans(kind="locker item", where='type = "login"')]),
  T("which of them are starred", rows("elster"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T06-K021", "read trashed did i delete i3skill S3",
  T("did i delete the flyers task", rows("flyers"),
    ref=[ans(kind="task", name="flyers", trashed=True)]))

S("T06-K022", "no invention task description search i3skill S4",
  T("mark the q4 2025 one as done", diff(upd("vat", status="completed", completed=ANY)),
    ref=[search("Q4 2025", kind="task"), act("complete", rows="$vat")]))

S("T06-K023", "no invention note body search delete i3skill S4",
  T("delete the note about the cold radiator", diff(trash("heating")),
    ref=[search("radiator", kind="note"), act("delete", rows="$heating")]))

S("T06-K024", "no invention role dentist log i3skill S4",
  T("log a visit with the dentist", diff(upd("albrecht", date=ANY)),
    ref=[act("log", kind="person", where='role = "dentist"', args=lines(kind="visit"))]))

S("T06-K025", "no invention missing name ask i3skill S4",
  T("add an event for next week", ask(),
    ref=[askc("What should the event be called, and on which day and time?")]))

S("T06-K026", "no invention note body search read i3skill S4",
  T("which note mentions the 823 block", rows("theatre_rf"),
    ref=[search("823", kind="note"), ans(rows="$theatre_rf")]))
