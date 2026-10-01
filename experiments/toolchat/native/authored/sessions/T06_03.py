from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T06-051", "week planning rehearsal ambiguous edit event task reschedule effort sum",
  T("when's the next band rehearsal", rows("reh_0210"),
    ref=[ans(kind="event", name="Band rehearsal", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("push band rehearsal back half an hour", diff(upd("reh_0210", date="2026-02-10T19:30")),
    ref=[act("reschedule", kind="event", name="Band rehearsal", args=lines(to=U("day", 0, anchor="row", time="19:30"))),
         act("reschedule", rows="$reh_0210", args=lines(to=U("day", 0, anchor="row", time="19:30")))]),
  T("and put 'bring the new in-ears' in its description", diff(upd("reh_0210", description="bring the new in-ears")),
    ref=[act("edit", rows="$reh_0210", args=lines(description="bring the new in-ears"))]),
  T("what tasks are due that day", rows("snake", "vat"),
    ref=[ans(kind="task", when=W(U("week", 1, weekday=2)))]),
  T("move fix the stage snake to wednesday", diff(upd("snake", date="2026-02-11")),
    ref=[act("reschedule", kind="task", name="Fix the stage snake", args=lines(to=U("week", 1, weekday=3)))]),
  T("how many minutes of stuff is on wednesday", val(35),
    ref=[ans(op="sum", field="effort", kind="task", when=W(U("week", 1, weekday=3)), where='status = "open"')]),
  T("who's got more than one task hanging on them", rows("felix", "steffi", "tobi", "nele", "sophie", "lena"),
    ref=[ans(kind="person", where="task count > 1")]))

S("T06-052", "kitty balance settle up tasks top up",
  T("what's my balance in the WG Kasse", val((25.56, "EUR")),
    ref=[search("Lukas", kind="person"), ans(op="balance", kind="group", name="WG Kasse", linked_to="$me")]),
  T("and mira's", val((-35.83, "EUR")),
    ref=[ans(op="balance", kind="group", name="WG Kasse", linked_to="$mira")]),
  T("settle up with her in there", diff(settle=[("Mira Hoffmann", "20.46")]),
    ref=[act("settle_up", rows="$mira", args=lines(group="$kitty"))]),
  T("top up wg kasse for feb is done too", diff(upd("kitty_02", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Top up WG Kasse", where='status = "open"')]),
  T("anything else open on the Flat list", rows("kuhn_heat", "bin_bags", "fridge", "cleaning_rota", "rent_02", "rent_03"),
    ref=[ans(kind="task", linked_to="$flatlist", where='status = "open"')]))

S("T06-053", "debt create settle new knock-on list add_to new",
  T("lena owes me 24 for the train to dresden",
    diff(new("debt", name=has("train"), amount=24, direction="owes_me"), link("new", "lena")),
    ref=[act("create", args=lines(kind="debt", name="Train to Dresden", amount="24", direction="owes_me", person="$lena"))]),
  T("add a task to chase lena for the train money, on the Band list",
    diff(new("task", name=has("lena")), link("bandlist", "new")),
    ref=[act("create", more=True, args=lines(kind="task", name="Chase Lena for the train money")),
         act("add_to", rows="$new", args=lines(to="$bandlist"))]),
  T("she paid, settle the train one", diff(upd("+1", status="settled")),
    ref=[act("settle_debt", rows="$c1")]),
  T("and what's she owe me", val((1000, "CZK"), (-55, "EUR")),
    ref=[ans(op="balance", rows="$lena")]),
  T("which debts do i have with an amount over 30 open", rows("d_paul_session", "d_olli_mic", "d_lena_cables", "d_ines_prints"),
    ref=[ans(kind="debt", where='amount is set and amount > 30 and status = "open"')]))

S("T06-054", "photos album star multi restore trashed",
  T("show me the photos in Gear for sale", rows("p_mixer_sale", "p_di_sale", "p_stands_sale"),
    ref=[ans(kind="photo", linked_to="$sale_album")]),
  T("star the mixer and the DI ones", diff(upd("p_mixer_sale", starred=True), upd("p_di_sale", starred=True)),
    ref=[act("star", rows="$p_mixer_sale, $p_di_sale")]),
  T("is the parking ticket screenshot in the trash", rows("p_screenshot"),
    ref=[ans(kind="photo", name="Parking ticket screenshot", trashed=True)]),
  T("restore it, i need it for the appeal", diff(restore("p_screenshot")),
    ref=[act("restore", kind="photo", name="Parking ticket screenshot", trashed=True)]),
  T("what's left in the photo trash", rows("p_blurry", "p_old_van"),
    ref=[ans(kind="photo", trashed=True)]))

S("T06-055", "delete album where undo photo undo",
  T("which albums are empty", rows("prague_album"),
    ref=[ans(kind="album", where="photo count = 0")]),
  T("delete it, we'll make one after the gig", diff(gone("prague_album")),
    ref=[act("delete", kind="album", where="photo count = 0")]),
  T("delete the cold radiator pic too", diff(trash("p_radiator"), unlink("wg_album", "p_radiator")),
    ref=[act("delete", kind="photo", name="Cold radiator")]),
  T("oh wait kuhn needs it, undo", diff(restore("p_radiator"), link("wg_album", "p_radiator")),
    ref=[act("undo")]),
  T("how many are in WG life", val(5),
    ref=[ans(op="count", kind="photo", linked_to="$wg_album")]))

S("T06-056", "locker star where reveal named type in",
  T("what logins and cards have i got saved", rows("thomann", "elster", "gls", "visa"),
    ref=[ans(kind="locker item", where='type in ("login", "card")')]),
  T("show me the ELSTER login password", diff(reveal=[("elster", "Umsatz-Q4!")]),
    ref=[act("reveal", kind="locker item", name="ELSTER login", args=lines(field="password"))]),
  T("star my passport entry", diff(upd("passport", starred=True)),
    ref=[act("star", kind="locker item", where='type = "passport"')]),
  T("send the gls card number to mira for the kitty", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T06-057", "folder edit where empty result documents",
  T("anything in Old projects", rows(),
    ref=[ans(kind="document", linked_to="$old_f")]),
  T("rename the empty folder to Tour 2026", diff(upd("old_f", name="Tour 2026")),
    ref=[act("edit", kind="folder", where="document count = 0", args=lines(name="Tour 2026"))]),
  T("move the van rental contract into it", diff(link("old_f", "van_contract")),
    ref=[act("add_to", kind="document", name="Van rental contract", args=lines(to="$old_f"))]),
  T("what docs have no folder", rows("manual", "rental_offer"),
    ref=[ans(kind="document", where="folder count < 1")]))

S("T06-058", "edit person multi cadence where",
  T("put tobi and nele on a weekly check in till the festival",
    diff(upd("tobi", cadence=7), upd("nele", cadence=7)),
    ref=[search("tobi", kind="person"), act("edit", rows="$tobi, $nele", args=lines(cadence="7"))]),
  T("who's on a check in of less than ten days",
    rows("mira", "jonas_k", "jonas_w", "lena", "ute", "tobi", "nele"),
    ref=[ans(kind="person", where="cadence < 10")]),
  T("which festival crew people have more than one task on them", rows("tobi", "nele"),
    ref=[ans(kind="person", linked_to="$crew", where="task count > 1")]))

S("T06-059", "remove_from person named prev crew",
  T("olli's not doing the festival after all, take him out of Festival crew 2026", diff(unlink("crew", "olli")),
    ref=[search("olli", kind="person"), act("remove_from", rows="$olli", args=lines(from_="$crew"))]),
  T("and emre, is he in there", rows("emre"),
    ref=[find(kind="person", name="Emre", linked_to="$crew"), ans(rows="@prev")]),
  T("take him out too", ask(),
    ref=[bad(act("remove_from", rows="@prev", args=lines(from_="$crew"))),
         askc("emre still has an unsettled balance in the crew group, so he can't be removed. settle up with him first?")]),
  T("yeah settle up with him", diff(settle=[("Emre Yilmaz")]),
    ref=[act("settle_up", rows="$emre", args=lines(group="$crew"))]),
  T("now take him out", ask(),
    ref=[bad(act("remove_from", rows="$emre", args=lines(from_="$crew"))),
         askc("he's still got a balance with tobi and nele in there, so the vault won't remove him. leave him in?")]))

S("T06-060", "notes remove_from named pinned",
  T("take mira's lentil curry out of Recipes, it's hers not mine", diff(unlink("recipe_nb", "curry")),
    ref=[act("remove_from", kind="note", name="Mira's lentil curry", args=lines(from_="$recipe_nb"))]),
  T("which of my notes aren't pinned and aren't in any notebook", rows("ideas", "gift_note", "gear_list", "harz_note", "curry"),
    ref=[ans(kind="note", where="pinned != yes and notebook count < 1")]),
  T("pin gear to sell", diff(upd("gear_list", pinned=True)),
    ref=[act("edit", kind="note", name="Gear to sell", args=lines(pinned="yes"))]))

S("T06-061", "single turn tasks no list",
  T("which tasks aren't on any list", rows("live_mix_import", "live_mix_vox", "mama_gift", "call_sophie", "book_dentist",
                                           "dticket", "bike_light", "climb_shoes"),
    ref=[ans(kind="task", where="list count < 1")]))

S("T06-062", "single turn search miss",
  T("find the soundcheck at conne island", rows("sc_0213", "sc_0306", "sc_lindenau"),
    ref=[search("conne island", kind="event"),
         ans(kind="event", name="Soundcheck")]))

S("T06-063", "single turn documents star where",
  T("star the one in Invoices from this month", diff(upd("inv_2026_02", starred=True)),
    ref=[act("star", kind="document", linked_to="$inv_f", when=W(U("month", 0)))]))

S("T06-064", "list edit named area",
  T("rename the Prague trip list to Prague gig", diff(upd("praguelist", name="Prague gig")),
    ref=[act("edit", rows="$praguelist", args=lines(name="Prague gig"))]),
  T("and set its area to band", diff(upd("praguelist", area="band")),
    ref=[act("edit", rows="$praguelist", args=lines(area="band"))]),
  T("which lists are band", rows("bandlist", "praguelist"),
    ref=[ans(kind="list", where='area = "band"')]))

S("T06-065", "restore task new add_to new",
  T("remind me to book the rehearsal room for may, due end of march",
    diff(new("task", name=has("rehearsal room"), date="2026-03-31")),
    ref=[bad(act("create", args=lines(kind="task", name="Book rehearsal room for May", date=U("month", 0, name=3)))),
         act("create", args=lines(kind="task", name="Book rehearsal room for May", date=D("2026-03-31")))]),
  T("delete that, kalle said he'd do it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("nope kalle bailed. restore it", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]),
  T("put it on the Band list", diff(link("bandlist", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$bandlist"))]),
  T("what's on Band now that's open", rows("setlists", "snake", "reh_room", "epk", "+1"),
    ref=[ans(kind="task", linked_to="$bandlist", where='status = "open"')]))

S("T06-066", "undo after ledger log",
  T("had a call with mama tonight, log it", diff(upd("ute", date=ANY)),
    ref=[search("mama", kind="person"), act("log", rows="$ute", args=lines(kind="call"))]),
  T("hm undo that, it was papa actually", diff(),
    ref=[act("undo")]),
  T("ok log a call with papa", diff(upd("dieter", date=ANY)),
    ref=[search("papa", kind="person"), act("log", rows="$dieter", args=lines(kind="call"))]),
  T("everyone i've got a check-in rhythm for, longest since contact first", rows("dieter", "jonas_k", "mira", "sophie", "emre", "yusuf", "hannah_b", "hannah_s", "olli", "felix", "anke", "tobi",
                                         "nele", "greta", "jonas_w", "lena", "kalle", "ute", "ines"),
    ref=[ans(kind="person", where="cadence is set", order="date asc")]))

S("T06-067", "ambiguous task invoice ask",
  T("mark send invoice to theater lindenau done", ask("inv_jan", "inv_feb"),
    ref=[act("complete", kind="task", name="Send invoice to Theater Lindenau"),
         find(kind="task", name="Send invoice to Theater Lindenau"),
         askc("the january one (was due 2 feb) or the february one?", options="$inv_jan, $inv_feb")]),
  T("jan", diff(upd("inv_jan", status="completed", completed=ANY)),
    ref=[act("complete", rows="$inv_jan")]),
  T("which admin tasks have no description", rows("inv_feb", "inv_greta", "rates", "ksk", "receipts"),
    ref=[ans(kind="task", linked_to="$adminlist", where='description is empty and status = "open"')]))

S("T06-068", "linked_to all tasks notes",
  T("anything linked to both mira and jonas keller", rows("cleaning_rota"),
    ref=[ans(kind="task", linked_to="$mira, $jonas_k")]),
  T("did that already, tick it off", diff(upd("cleaning_rota", status="completed", completed=ANY)),
    ref=[act("complete", rows="$cleaning_rota")]),
  T("and notes with tobi and nele both on them", rows("fest_contacts"),
    ref=[ans(kind="note", linked_to="$tobi, $nele")]),
  T("tasks with both on them?", rows("crew_rota"),
    ref=[ans(kind="task", linked_to="$tobi, $nele")]))

S("T06-069", "debt count people balance",
  T("which people have debts with me at all", rows("mira", "jonas_k", "lena", "kalle", "olli", "sophie", "yusuf", "ines",
                                                  "paul", "hannah_b", "tobi", "greta"),
    ref=[ans(kind="person", where="debt count != 0")]),
  T("and the ones in the band fund", rows("lena", "kalle", "paul"),
    ref=[ans(kind="person", linked_to="$band", where="debt count != 0")]),
  T("what's my balance with paul", val((60, "EUR")),
    ref=[ans(op="balance", rows="$paul")]))

S("T06-070", "harz group remove named delete refused",
  T("who's in the Harz weekend group", rows("sophie", "hannah_b", "yusuf", "me"),
    ref=[ans(kind="person", linked_to="$harz")]),
  T("remove hannah bauer from it", diff(unlink("harz", "hannah_b")),
    ref=[act("remove_from", kind="person", name="Hannah Bauer", args=lines(from_="$harz"))]),
  T("and delete the Mama's 60th present group while i'm at it", ask(),
    ref=[bad(act("delete", rows="$mama60")),
         askc("mama's 60th present still has the spa voucher expense in it, so it can't be deleted. settle up with sophie first?")]),
  T("nah leave it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T06-071", "event duration where find only",
  T("anything in march that's under two hours", rows("sc_0306", "crew_call2"),
    ref=[bad(ans(kind="event", when=W(U("month", 0, name=3)), where="duration < 2 hours")),
         ans(kind="event", when=W(U("month", 0, name=3)), where="duration < 120 min")]),
  T("show me kaeltewelle live coming up", rows("gig_tonkeller", "gig_prague"),
    ref=[find(kind="event", name="Kaeltewelle live", when=W({"from": U("day", 0)})), ans(rows="@prev")]),
  T("add 'set 21:45, 50 min' to the prague one", diff(upd("gig_prague", description="set 21:45, 50 min")),
    ref=[act("edit", rows="$gig_prague", args=lines(description="set 21:45, 50 min"))]),
  T("which future events have no description", rows("mix_greta1", "premiere", "sc_0213", "bike", "climbing", "mix_greta2",
                                                      "crew_call1", "dentist", "studio_feb", "van_pickup", "drive_prague", "drive_back",
                                                      "van_return", "mix_greta3", "crew_call2", "sc_0306", "foh_blau",
                                                      "kalle_bday", "gear_swap", "site_visit", "load_in", "festival"),
    ref=[ans(kind="event", when=W({"from": U("day", 0)}), where="description is empty")]))

S("T06-072", "task priority effort unit",
  T("urgent stuff, priority one", rows("rider", "inv_jan", "vat", "rent_02"),
    ref=[ans(kind="task", where='priority < 2 and priority > 0 and status = "open"')]),
  T("anything quick, exactly fifteen min", rows("setlists", "inv_greta", "bike_light"),
    ref=[ans(kind="task", where="effort = 15 minutes")]),
  T("tick Print setlists for Tonkeller, printed them", diff(upd("setlists", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Print setlists for Tonkeller")]),
  T("and Buy a new bike light", diff(upd("bike_light", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Buy a new bike light")]))

S("T06-073", "event create edit new overlap",
  T("book a listening session with paul thursday the twenty-sixth at 6pm", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Listening session with Paul", date=D("2026-02-26", "18:00")))),
         askc("thursday the 26th at 6 you're picking up the van at rico's. want it at 19:00 instead?")]),
  T("19:00 ok", diff(new("event", name="Listening session with Paul", date="2026-02-26T19:00")),
    ref=[act("create", args=lines(kind="event", name="Listening session with Paul", date=D("2026-02-26", "19:00")))]),
  T("put 'bring the live multitrack' as the description", diff(upd("+1", description="bring the live multitrack")),
    ref=[act("edit", rows="$c1", args=lines(description="bring the live multitrack"))]),
  T("and add paul to the band fund group", diff(already=["paul"]),
    ref=[act("add_to", rows="$paul", args=lines(to="$band")), ans(rows="$paul")]))

S("T06-074", "notebooks count create note",
  T("how many notes in Mixing notes", val(5),
    ref=[ans(op="count", kind="note", linked_to="$mix_nb")]),
  T("new note there: Tonkeller feb thirteenth - cut 250 on the mains, vocals up 2",
    diff(new("note", name=has("Tonkeller"), body=has("250")), link("mix_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Tonkeller feb 13", body="cut 250 on the mains, vocals up 2",
                                  notebook="$mix_nb"))]),
  T("pin that to the top", diff(upd("+1", pinned=True)),
    ref=[act("edit", rows="$c1", args=lines(pinned="yes"))]),
  T("which notebooks have at least five notes", rows("mix_nb"),
    ref=[ans(kind="notebook", where="note count >= 5")]))

S("T06-075", "group count people linked all",
  T("who's in both the band fund and the prague trip", rows("jonas_w", "lena", "kalle", "me"),
    ref=[ans(kind="person", linked_to="$band, $prague")]),
  T("anyone in three or more groups", rows("me"),
    ref=[ans(kind="person", where="group count > 2")]),
  T("and people in more than one group, not counting me", rows("jonas_w", "lena", "kalle", "sophie"),
    ref=[find(kind="person", where="group count > 1"), ans(within="@prev", where='role is set')]))
