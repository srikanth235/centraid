from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T04-Q026", "will take duration edit minutes i2pat",
  T("the audit slides will take 2 hours", diff(upd("audit_slides", effort=120)),
    ref=[act("edit", rows="$audit_slides", args="effort: 120")]))

S("T04-Q027", "name matches nothing pick listed by id i2pat",
  T("what's open on the food bank list", rows("tins", "tesco", "hampers", "fb_rota"),
    ref=[ans(kind="task", linked_to="$fblist", where="status = open")]),
  T("tick off the van pickup", diff(upd("tesco", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tesco")]))

S("T04-Q028", "numeric options in question not filter i2pat",
  T("how many food bank shifts are left, is it 6 or 7", val(6),
    ref=[ans(op="count", kind="event", name="food bank shift", where="status != cancelled", when=J({"from": U("day", 0)}))]))

S("T04-Q029", "ordinal of series second row i2pat",
  T("list my darkroom nights from now on", rows("dark_1015", "dark_1029", "dark_1112"),
    ref=[ans(kind="event", name="darkroom night", when=J({"from": U("day", 0)}))]),
  T("cancel the 2nd one", diff(upd("dark_1029", status="cancelled")),
    ref=[act("cancel", rows="$dark_1029")]))

S("T04-Q030", "skip cancel event by day i2pat",
  T("skip friday's long day, i'm swapping it", diff(upd("ld_1016", status="cancelled")),
    ref=[act("cancel", kind="event", name="Long day", when=J(U("week", 0, weekday=5)))]))

S("T04-Q031", "lent me debt i_owe verbatim item i2pat",
  T("ravi lent me 25 for darkroom paper",
    diff(new("debt", name=has("darkroom paper"), amount=25, direction="i_owe"), link("new", "ravi")),
    ref=[act("create", args=lines(kind="debt", name="Darkroom paper", amount="25", direction="i_owe", person="$ravi"))]))

S("T04-Q032", "add after in body insert position i2pat",
  T("what's in the hamper ideas note", rows("fb_hampers"),
    ref=[ans(kind="note", name="hamper ideas")]),
  T("add lentils after the rice", diff(upd("fb_hampers", body=has("rice, lentils, a card from the kids' club"))),
    ref=[act("edit", rows="$fb_hampers", args="body: tea, biscuits, tinned fish, rice, lentils, a card from the kids' club")]))

S("T04-Q033", "append text keeps existing i2pat",
  T("show me the istanbul packing note", rows("ist_packing"),
    ref=[ans(kind="note", name="Istanbul packing")]),
  T("add sun cream to it", diff(upd("ist_packing", body=has("scarf for the mosques, comfy trainers, adaptor, sashes", "sun cream"))),
    ref=[act("edit", rows="$ist_packing", args="body: scarf for the mosques, comfy trainers, adaptor, sashes, sun cream")]))

S("T04-Q034", "create name head phrase follow-up time keeps name i2pat",
  T("put a haircut in for thursday at 12, my fringe is a mess", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=4, time="12:00")))),
         askc("12 clashes with the rota meeting, 12 to 1. another time?")]),
  T("half 1 then", diff(new("event", name=has("Haircut"), date="2026-10-15T13:30")),
    ref=[act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=4, time="13:30")))]))

S("T04-Q035", "edit append quoted text verbatim separator i2pat",
  T("what's in the oakwood hall notes", rows("venue_notes"),
    ref=[ans(kind="note", name="Oakwood Hall notes")]),
  T('add "no confetti inside" to it', diff(upd("venue_notes", body=has("stage by the bay window, no open flames, last music 11pm", "no confetti inside"))),
    ref=[act("edit", rows="$venue_notes", args="body: stage by the bay window, no open flames, last music 11pm, no confetti inside")]))

S("T04-Q036", "the name list resolve open includes in-progress i2pat",
  T("anything left on the work admin list", rows("audit", "reflections", "cbd", "rota_swap", "als_prep", "gmc_fee", "teaching_prep"),
    ref=[ans(kind="task", linked_to="$worklist", where="status = open")]))

S("T04-Q037", "which have person search then link within i2pat",
  T("show me the family album", rows("ring", "engagement", "mum_kitchen", "dad_garden", "eid", "imran_grad", "cousins"),
    ref=[ans(kind="photo", linked_to="$fam_album")]),
  T("which have zainab in them", rows("ring", "engagement"),
    ref=[search("zainab", kind="person"), ans(within="@1", linked_to="$zainab")]))

S("T04-Q038", "whos in X event and group membership i2pat",
  T("who's in darkroom", rows("me", "owen", "ravi"),
    ref=[ans(kind="person", linked_to="$darkroom")]))
