from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
NOW = W({"from": U("day", 0)})
NEXT_WEEK = W(U("week", 1))
NEXT_WEEKEND = W(span(U("week", 1, weekday=6), U("week", 1, weekday=7)))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T18-011-P", "delete event named day read para",
  T("not going to pub trivia, get rid of it", diff(trash("trivia")),
    ref=[act("delete", kind="event", name="Pub trivia")]),
  T("the tenth, what's booked", rows("cake_tasting"),
    ref=[ans(kind="event", when=W(D("2026-03-10")))]))

S("T18-017-P", "create note notebook para",
  T("shower planning gets a note, gift pool: chloe's collecting 20 bucks each for the pram",
    diff(new("note", name=has("Gift pool"), body=has("pram")), link("shower_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Gift pool", body="Chloe's collecting 20 each for the pram",
                                  notebook="$shower_nb"))]))

S("T18-022-P", "edit document named rename para",
  T("rename the Invitation draft to 'Shower invitation v2'", diff(upd("invite_doc", name="Shower invitation v2")),
    ref=[act("edit", rows="$invite_doc", args=lines(name="Shower invitation v2"))]))

S("T18-027-P", "coop folder remove_from multi create folder add_to new para",
  T("co-op admin contents?", rows("agreement", "rev_split", "deck", "steam_contract", "grant"),
    ref=[ans(kind="document", linked_to="$coop_f")]),
  T("grant application and steam agreement shouldn't be there, take them out",
    diff(unlink("coop_f", "grant"), unlink("coop_f", "steam_contract")),
    ref=[act("remove_from", rows="$grant, $steam_contract", args=lines(from_="$coop_f"))]),
  T("new folder, Contracts", diff(new("folder", name="Contracts")),
    ref=[act("create", args=lines(kind="folder", name="Contracts"))]),
  T("steam one goes in there", diff(link("+1", "steam_contract")),
    ref=[act("add_to", rows="$steam_contract", args=lines(to="$c1"))]))

S("T18-032-P", "biscuit album february remove_from multi undo link para",
  T("feb photos in the biscuit album", rows("b_couch", "b_class", "b_bday", "b_vet", "b_creek"),
    ref=[ans(kind="photo", linked_to="$biscuit_al", when=W(U("month", 0, name=2)))]),
  T("vet one and training class one come out", diff(unlink("biscuit_al", "b_vet"), unlink("biscuit_al", "b_class")),
    ref=[act("remove_from", rows="$b_vet, $b_class", args=lines(from_="$biscuit_al"))]),
  T("scrap that, undo", diff(link("biscuit_al", "b_vet"), link("biscuit_al", "b_class")),
    ref=[act("undo")]))

S("T18-038-P", "photo person count one tag add para",
  T("photos tagged with a single person", rows("pax_rhys", "pax_ana", "m_map", "s_tess", "v4", "zoe_rumi", "b_vet"),
    ref=[ans(kind="photo", where="person count = 1")]),
  T("this year's among them, count", val(5),
    ref=[ans(op="count", within="@prev", kind="photo", when=W(U("year", 0)))]))

S("T18-043-P", "four turns logins delete multi undo restore delete named para",
  T("list all stored logins", rows("steamworks", "itch", "github", "mygov"),
    ref=[ans(kind="locker item", where='type = "login"')]),
  T("github and itch can go, delete them", diff(trash("github"), trash("itch")),
    ref=[act("delete", rows="$github, $itch")]),
  T("need github for the ci, undo that", diff(restore("github"), restore("itch")),
    ref=[act("undo")]),
  T("only itch", diff(trash("itch")),
    ref=[act("delete", rows="$itch")]))

S("T18-048-P", "edit list where area rename read para",
  T("pets list is now called Biscuit stuff", diff(upd("dog_l", name="Biscuit stuff")),
    ref=[act("edit", kind="list", where='area = "pets"', args=lines(name="Biscuit stuff"))]),
  T("biscuit stuff, open tasks", rows("dog_food", "flea", "pet_ins_t", "nails"),
    ref=[ans(kind="task", linked_to="$dog_l", where='status = "open"')]),
  T("co-op sprint review at 4pm instead", ask(),
    ref=[act("reschedule", kind="event", name="Co-op sprint review", args=lines(to=U("hour", 1, anchor="row"))),
         askc("it's every friday, which one do you mean?")]))

S("T18-055-P", "five turns event empty search miss decline description contains within reschedule weekday para",
  T("what day is yoga", decline("not_found"),
    ref=[ans(kind="event", name="Yoga"), search("yoga"), dec("not_found")]),
  T("northcote vet bookings?", rows("vet_feb", "vet_apr", "vax"),
    ref=[ans(kind="event", where='description contains "Northcote"')]),
  T("upcoming only", rows("vax", "vet_apr"),
    ref=[ans(within="@prev", kind="event", when=W({"from": U("day", 0)}))]),
  T("vaccination on thursday, keep the time", diff(upd("vax", date="2026-03-05T16:00")),
    ref=[act("reschedule", rows="$vax", args=lines(to=U("week", 1, weekday=4, time="16:00")))]),
  T("thursday's lineup", rows("pitch", "vax", "dnd_0305"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=4)))]))

S("T18-060-P", "event duration refused 1 hour repair within para",
  T("next week, events not lasting an hour",
    rows("climb_mar", "shower_call", "vax", "dnd_0305", "sprint_0306", "playtest_mar", "mum_lunch"),
    ref=[bad(ans(kind="event", when=W(U("week", 1)), where="duration != 1 hour")),
         ans(kind="event", when=W(U("week", 1)), where="duration != 60 minutes")]),
  T("shorter than 45 only", rows("shower_call", "vax", "sprint_0306"),
    ref=[ans(within="@prev", kind="event", where="duration < 45")]))

S("T18-065-P", "task spans datetime weekday date named month priority para",
  T("tomorrow 9am to friday, what's due", rows("ci", "dog_food", "bins", "inv_draft", "cart", "invites", "inv_ok", "slice", "trailer", "flea", "backstory", "snacks", "tutorial"),
    ref=[ans(kind="task", when=W(span(U("day", 1, time="09:00"), U("week", 1, weekday=5))))]),
  T("friday 6pm until the tenth?", rows("tutorial", "tap", "phone_plan", "balloons", "zoe_book"),
    ref=[ans(kind="task", when=W(span(U("week", 1, weekday=5, time="18:00"), D("2026-03-10"))))]),
  T("priority one tasks due by end of march", rows("invites", "slice", "trailer", "tax"),
    ref=[find(kind="task", when=W({"to": U("month", 0, name=3)}), where="priority = 1"), ans(rows="@prev")]))

S("T18-070-P", "note span weekday datetime open compute count loose para",
  T("notes from monday through wednesday noon", rows("climb_log", "pitch_notes", "tax_q"),
    ref=[ans(kind="note", when=W(span(U("week", 0, weekday=1), U("week", 0, weekday=3, time="12:00"))))]),
  T("pull up Questions for Kieran", rows("tax_q"),
    ref=[opn("$tax_q"), ans(rows="$tax_q")]),
  T("count of notes sitting outside every notebook", val(6),
    ref=[comp(op="count", kind="note", where="notebook count = 0"), ans(value="@prev")]))

S("T18-082-P", "seven turns pitch prep open span people note edit already folder ask para",
  T("before the Publisher pitch with Hollow Pine, what's due", rows("ci", "cart", "trailer"),
    ref=[ans(kind="task", linked_to="$dev_l", when=W({"to": D("2026-03-05", "11:00")}), where='status = "open"')]),
  T("pitch attendees?", rows("rhys", "priya", "mei"),
    ref=[ans(kind="person", linked_to="$pitch")]),
  T("bring up Pitch notes for Rhys", rows("pitch_notes"),
    ref=[ans(kind="note", name="Pitch notes for Rhys")]),
  T("append: ask about the switch port timeline", diff(upd("pitch_notes", body=has("switch"))),
    ref=[act("edit", rows="$pitch_notes",
             args=lines(body="lead with the trailer, ask about console ports. ask about the switch port timeline"))]),
  T("Hollow Pine pitch deck gets a star", diff(already=["deck"]),
    ref=[act("star", rows="$deck"), ans(rows="$deck")]),
  T("which folder holds it", rows("coop_f"),
    ref=[ans(kind="folder", linked_to="$deck")]),
  T("schedule a pitch retro with the team afterwards", ask(),
    ref=[askc("sure, what day and time for the retro?")]))

S("T18-092-P", "document named month span open to date delete named trashed recovery para",
  T("docs spanning last december to january", rows("receipts", "grant", "char_sheet"),
    ref=[ans(kind="document", when=W(span(U("month", -1, name=12), U("month", 0, name=1))))]),
  T("documents dated before june 2025", rows("abn", "microchip", "lease", "bond", "condition", "vax_card"),
    ref=[find(kind="document", when=W({"to": D("2025-05-31")})), ans(rows="@prev")]),
  T("bond's back, so the Condition report can go, delete it", diff(trash("condition")),
    ref=[act("delete", kind="document", name="Condition report")]),
  T("Resume 2023, do i still have it", rows("resume"),
    ref=[ans(kind="document", name="Resume 2023"), ans(rows="$resume")]))

S("T18-097-P", "photo delete undo photo albums trashed find-only para",
  T("Biscuit at training class photo, get rid of it", diff(trash("b_class"), unlink("biscuit_al", "b_class")),
    ref=[act("delete", kind="photo", name="Biscuit at training class")]),
  T("put it back, undo", diff(restore("b_class"), link("biscuit_al", "b_class")),
    ref=[act("undo")]),
  T("photo trash contents?", rows("blurry", "tram_copy"),
    ref=[find(kind="photo", trashed=True), ans(rows="@prev")]))

S("T18-A003-P", "ask-options event reschedule c3a para",
  T("shower at 2 instead", ask("shower_ev", "shower_call"),
    ref=[act("reschedule", kind="event", name="shower", args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         askc("Tess's baby shower on the 21st or the planning call with Chloe on the 3rd?", options="$shower_ev, $shower_call")]),
  T("the 21st, the real shower", diff(upd("shower_ev", date="2026-03-21T14:00")),
    ref=[act("reschedule", rows="$shower_ev", args=lines(to=U("day", 0, anchor="row", time="14:00")))]),
  T("finish one is finished, complete it", diff(upd("slice", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="finish")]))

S("T18-B004-P", "c4b state-change complete complete create contrast para",
  T("biscuit's flea treatment is done", diff(upd("flea", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="flea treatment")]),
  T("balloon arch done", diff(upd("balloons", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="balloon arch")]),
  T("new task, ring the cake lady about the topper", diff(new("task", name=has("topper"))),
    ref=[act("create", args=lines(kind="task", name="Ring the cake lady about the topper"))]))

S("T18-C002-P", "c3c compound add_to star photo para",
  T("tess and mum baking pic goes into shower ideas, and gets a star",
    diff(link("shower_al", "baking"), upd("baking", starred=True)),
    ref=[act("add_to", kind="photo", name="Tess and Mum baking", args=lines(to="$shower_al"), more=True),
         act("star", rows="$baking")]))

S("T18-102-P", "ask options star agreement documents already para",
  T("agreement gets a star", diff(upd("steam_contract", starred=True)),
    ref=[act("star", kind="document", name="agreement")]),
  T("lease too", diff(already=["lease"]),
    ref=[act("star", rows="$lease"), ans(rows="$lease")]))
