from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T06-076", "cancelled trash restore count march",
  T("anything cancelled this week or next", rows("open_mic"),
    ref=[ans(kind="event", when=W({"from": U("week", 0), "to": U("week", 1)}), where='status = "cancelled"')]),
  T("delete it then", diff(trash("open_mic")),
    ref=[act("delete", rows="$open_mic")]),
  T("is the Pub quiz with Olli in the trash", rows("pub_quiz"),
    ref=[ans(kind="event", name="Pub quiz with Olli", trashed=True)]),
  T("restore it, we're going after all", diff(restore("pub_quiz")),
    ref=[act("restore", rows="$pub_quiz")]),
  T("what else is in the event trash", rows("clara_coffee", "open_mic"),
    ref=[ans(kind="event", trashed=True)]),
  T("how many band rehearsals after the FOH night on the sixth, from 6pm, to the end of march", val(4),
    ref=[ans(op="count", kind="event", name="Band rehearsal",
             when=W({"from": D("2026-03-06", "18:00"), "to": U("month", 0, name=3)}))]),
  T("and how many events in total in that stretch", val(8),
    ref=[ans(op="count", kind="event", when=W({"from": D("2026-03-06", "18:00"), "to": U("month", 0, name=3)}))]))

S("T06-077", "people dates nickname log",
  T("who did i talk to ten days ago", rows("anke"),
    ref=[ans(kind="person", when=W(U("day", -10, anchor="today")))]),
  T("and everyone from feb first on, this month", rows("mira", "jonas_k", "jonas_w", "lena", "kalle", "ute", "marek", "felix",
                                                     "ines"),
    ref=[ans(kind="person", when=W({"from": D("2026-02-01"), "to": U("month", 0, name=2)}))]),
  T("any of those got a nickname", rows("kalle", "ute"),
    ref=[ans(within="@prev", where="nickname is set")]),
  T("log a visit with Mira Hoffmann, she came by for tea", diff(upd("mira", date=ANY)),
    ref=[act("log", kind="person", name="Mira Hoffmann", args=lines(kind="visit"))]),
  T("how many people did i last talk to between december and last month", val(11),
    ref=[ans(op="count", kind="person", when=W({"from": U("month", -1, name=12), "to": U("month", -1)}))]),
  T("who hasn't heard from me since the night of jan tenth, 23:30", rows("olli", "steffi", "emre", "yusuf", "clara", "dieter"),
    ref=[ans(kind="person", when=W({"to": D("2026-01-10", "23:30")}))]))

S("T06-078", "tasks january february spans list description",
  T("what did i have due in january", rows("kitty_01", "rent_01"),
    ref=[ans(kind="task", when=W(U("month", 0, name=1)))]),
  T("open stuff due from february first to the fourteenth", rows("kitty_02", "inv_jan", "rent_02", "bin_bags", "cleaning_rota",
                                                         "kuhn_heat", "call_sophie", "snake", "vat", "in_ears", "rider",
                                                         "setlists", "xlr", "bike_light"),
    ref=[ans(kind="task", when=W({"from": U("month", 0, name=2), "to": D("2026-02-14")}), where='status = "open"')]),
  T("how many open ones from this monday to the end of the month", val(25),
    ref=[ans(op="count", kind="task", when=W({"from": U("week", 0, weekday=1), "to": U("month", 0, name=2)}),
             where='status = "open"')]),
  T("which open tasks aren't on any list", rows("live_mix_import", "live_mix_vox", "mama_gift", "call_sophie", "dticket",
                                                "bike_light", "climb_shoes"),
    ref=[ans(kind="task", where='list count < 1 and status = "open"')]),
  T("Resole climbing shoes has no description, right?", rows("climb_shoes"),
    ref=[ans(kind="task", name="Resole climbing shoes", where="description is empty")]),
  T("put 'Rock+Rubber in Connewitz' on it", diff(upd("climb_shoes", description="Rock+Rubber in Connewitz")),
    ref=[act("edit", rows="$climb_shoes", args=lines(description="Rock+Rubber in Connewitz"))]))

S("T06-079", "notes spans trashed restore",
  T("notes i wrote from 11pm on the lindenau gig night till the twenty-first", rows("vocal_chain", "gift_note", "curry", "harz_note"),
    ref=[ans(kind="note", when=W({"from": D("2026-01-17", "23:00"), "to": D("2026-01-21")}))]),
  T("which of those aren't pinned", rows("gift_note", "curry", "harz_note"),
    ref=[ans(within="@prev", where="pinned != yes")]),
  T("delete Harz weekend packing, trip's over", diff(trash("harz_note")),
    ref=[act("delete", kind="note", name="Harz weekend packing")]),
  T("and notes from monday noon to wednesday noon", rows("theatre_rf", "setlist_note", "heating"),
    ref=[ans(kind="note", when=W({"from": U("week", 0, weekday=1, time="12:00"), "to": U("week", 0, weekday=3, time="12:00")}))]),
  T("is the Draft mail to Kuhn in the trash?", rows("draft_mail"),
    ref=[ans(kind="note", name="Draft mail to Kuhn", trashed=True)]),
  T("get it back, he finally answered and i wanna reuse it", diff(restore("draft_mail")),
    ref=[act("restore", rows="$draft_mail")]))

S("T06-080", "notes open end move undo link",
  T("mixing notes from before last friday", rows("vocal_chain", "kick_eq", "tonkeller_room", "podcast_chain"),
    ref=[ans(kind="note", linked_to="$mix_nb", when=W({"to": U("week", -1, weekday=5)}))]),
  T("and Recipes from january or earlier", rows("soljanka", "curry"),
    ref=[ans(kind="note", linked_to="$recipe_nb", when=W({"to": U("month", 0, name=1)}))]),
  T("move soljanka into Flat, it's the wg dinner one", diff(unlink("recipe_nb", "soljanka"), link("flat_nb", "soljanka")),
    ref=[act("add_to", rows="$soljanka", args=lines(to="$flat_nb"))]),
  T("undo, i'll keep it in recipes", diff(link("recipe_nb", "soljanka"), unlink("flat_nb", "soljanka")),
    ref=[act("undo")]),
  T("so how many notes are in Recipes", val(2),
    ref=[ans(op="count", kind="note", linked_to="$recipe_nb")]))

S("T06-081", "documents last year unstar prev since monday",
  T("docs from last year", rows("inv_2025_12", "tax_return", "rider_doc", "stage_plot_doc", "epk_doc", "manual"),
    ref=[ans(kind="document", when=W({"from": U("year", -1), "to": U("month", -1, name=12)}))]),
  T("which of those are starred", rows("rider_doc"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it, the new rider isn't done", diff(upd("rider_doc", starred=False)),
    ref=[act("unstar", rows="@prev")]),
  T("what came in since monday", rows("inv_2026_02", "rental_offer"),
    ref=[ans(kind="document", when=W({"from": U("week", 0, weekday=1), "to": U("day", 0)}))]),
  T("put the PA rental offer in Contracts", diff(link("contracts_f", "rental_offer")),
    ref=[act("add_to", rows="$rental_offer", args=lines(to="$contracts_f"))]))

S("T06-082", "photos anchor spans album count star",
  T("what did i snap last sunday morning at 9.40", rows("p_cat"),
    ref=[ans(kind="photo", when=W(U("day", -6, anchor="today", time="09:40")))]),
  T("photos from feb first up to this week", rows("p_cat", "p_climb", "p_rf", "p_radiator", "p_ines", "p_bike", "p_moon"),
    ref=[ans(kind="photo", when=W({"from": D("2026-02-01"), "to": U("week", 0)}))]),
  T("how many from february so far", val(7),
    ref=[ans(op="count", kind="photo", when=W({"from": U("month", 0, name=2), "to": U("day", 0)}))]),
  T("pics from before jan second", rows("p_mama", "p_brunch", "p_kitchen"),
    ref=[ans(kind="photo", when=W({"to": D("2026-01-02")}))]),
  T("which photos sit in 2 albums", rows("p_desk", "p_stands_sale"),
    ref=[ans(kind="photo", where="album count > 1")]),
  T("star them both", diff(upd("p_desk", starred=True), upd("p_stands_sale", starred=True)),
    ref=[act("star", rows="$p_desk, $p_stands_sale")]))

S("T06-083", "debts spans amount knock-on settle",
  T("how many debts from dec first up to last sunday", val(10),
    ref=[ans(op="count", kind="debt", when=W({"from": D("2025-12-01", "00:00"), "to": U("week", -1, weekday=7)}))]),
  T("list the ones from december and january", rows("d_olli_mic", "d_yusuf_parts", "d_tobi_van", "d_kalle_beer",
                                                    "d_ines_prints", "d_lena_cables", "d_sophie_train", "d_mira_pizza",
                                                    "d_greta_dinner"),
    ref=[ans(kind="debt", when=W({"from": U("month", -2), "to": U("month", -1)}))]),
  T("which of those are under 15 euros", rows("d_yusuf_parts", "d_mira_pizza"),
    ref=[ans(within="@prev", where="amount < 15")]),
  T("show all the open ones with an amount on them", rows("d_mira_pizza", "d_jonask_bvg", "d_lena_cables", "d_kalle_beer",
                                                          "d_kalle_strings", "d_olli_mic", "d_sophie_train", "d_ines_prints",
                                                          "d_paul_session", "d_hannah_b", "d_greta_dinner"),
    ref=[ans(kind="debt", where='amount is set and status = "open"')]),
  T("paid olli the mic money, and i did the xlr cables and the in-ear tips",
    diff(upd("d_olli_mic", status="settled"), upd("xlr", status="completed", completed=ANY),
         upd("in_ears", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="Borrowed mic money", more=True),
         act("complete", rows="$xlr, $in_ears")]))

S("T06-084", "folder dead end documents move",
  T("open the bank statements folder", rows("heating_letter"),
    ref=[find(kind="folder", name="Bank statements"),
         ans(kind="document", name="statement")]),
  T("move that one to Tax 2025", diff(unlink("flat_f", "heating_letter"), link("tax_f", "heating_letter")),
    ref=[act("add_to", rows="$heating_letter", args=lines(to="$tax_f"))]),
  T("how many docs in Tax 2025", val(4),
    ref=[ans(op="count", kind="document", linked_to="$tax_f")]),
  T("folders with fewer than three docs", rows("flat_f", "old_f"),
    ref=[ans(kind="folder", where="document count < 3")]))

S("T06-085", "remove_from prev olli crew group count",
  T("is Oliver Krause in the festival crew group", rows("olli"),
    ref=[find(kind="person", name="Oliver Krause", linked_to="$crew"), ans(rows="@prev")]),
  T("take him out", diff(unlink("crew", "olli")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$crew"))]),
  T("show me the groups with a headcount below five", rows("kitty", "crew", "harz", "mama60"),
    ref=[ans(kind="group", where="person count < 5")]),
  T("who's left in the crew", rows("tobi", "nele", "emre", "me"),
    ref=[ans(kind="person", linked_to="$crew")]))

S("T06-086", "ambiguous soundcheck resolve by date",
  T("when's Soundcheck Tonkeller", rows("sc_0213", "sc_0306"),
    ref=[ans(kind="event", name="Soundcheck Tonkeller")]),
  T("move the first one to 15:30", diff(upd("sc_0213", date="2026-02-13T15:30")),
    ref=[act("reschedule", kind="event", name="Soundcheck Tonkeller", args=lines(to=U("day", 0, anchor="row", time="15:30"))),
         act("reschedule", rows="$sc_0213", args=lines(to=U("day", 0, anchor="row", time="15:30")))]),
  T("and tell anke in the description: load in via the back door", diff(upd("sc_0213", description="load in via the back door")),
    ref=[act("edit", rows="$sc_0213", args=lines(description="load in via the back door"))]),
  T("which gigs have something in the description", rows("gig_tonkeller"),
    ref=[ans(kind="event", name="Kaeltewelle live", where="description is set")]))

S("T06-087", "ambiguous wg meeting cancel",
  T("cancel the WG meeting, jonas is away", diff(upd("wg_feb", status="cancelled")),
    ref=[act("cancel", kind="event", name="WG meeting"),
         act("cancel", rows="$wg_feb")]),
  T("and add a task to reschedule it, due wednesday", diff(new("task", name=has("WG meeting"), date="2026-02-11")),
    ref=[act("create", args=lines(kind="task", name="Reschedule the WG meeting", date=U("week", 1, weekday=3)))]),
  T("put it on the Flat list and tell me what's open there", rows("kuhn_heat", "bin_bags", "fridge", "cleaning_rota",
                                                                  "kitty_02", "rent_02", "rent_03", "+1",
                                                                  also=diff(link("flatlist", "+1"))),
    ref=[act("add_to", rows="$c1", args=lines(to="$flatlist"), more=True),
         ans(kind="task", linked_to="$flatlist", where='status = "open"')]))

S("T06-088", "ambiguous mixing session ask",
  T("move Mixing session with Greta to the afternoon, 14:00", ask("mix_greta1", "mix_greta2", "mix_greta3"),
    ref=[act("reschedule", kind="event", name="Mixing session with Greta", args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         find(kind="event", name="Mixing session with Greta"),
         askc("which one, monday the 9th, the 16th or 2 march?", options="$mix_greta1, $mix_greta2, $mix_greta3")]),
  T("the sixteenth", diff(upd("mix_greta2", date="2026-02-16T14:00")),
    ref=[act("reschedule", rows="$mix_greta2", args=lines(to=U("day", 0, anchor="row", time="14:00")))]),
  T("what's greta's number of tasks with me", val(1),
    ref=[ans(op="count", kind="task", linked_to="$greta")]),
  T("and Podcast recording at Studio Plagwitz, when's that", rows("podcast"),
    ref=[ans(kind="event", name="Podcast recording at Studio Plagwitz")]))

S("T06-089", "ambiguous pay rent complete write read",
  T("paid rent today, tick Pay rent", ask("rent_02", "rent_03"),
    ref=[act("complete", kind="task", name="Pay rent"),
         find(kind="task", name="Pay rent"),
         askc("february's (due the 3rd) or march's?", options="$rent_02, $rent_03")]),
  T("feb. and what's open on Flat after that", rows("kuhn_heat", "bin_bags", "fridge", "cleaning_rota", "kitty_02", "rent_03",
                                                         also=diff(upd("rent_02", status="completed", completed=ANY))),
    ref=[act("complete", rows="$rent_02", more=True),
         ans(kind="task", linked_to="$flatlist", where='status = "open"')]))

S("T06-090", "edit task where linked rico",
  T("make the van insurance thing priority one, the task with rico on it", diff(upd("van_ins", priority=1)),
    ref=[act("edit", kind="task", linked_to="$rico", args=lines(priority="1"))]),
  T("what else is on the Prague trip list", rows("rider", "czk", "hostel"),
    ref=[ans(kind="task", linked_to="$praguelist", exclude="$van_ins")]),
  T("what's the weather gonna be in prague on the twenty-seventh", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T06-091", "hannah ambiguous log ask",
  T("log a coffee with hannah this afternoon", ask("hannah_s", "hannah_b"),
    ref=[act("log", kind="person", name="Hannah", args=lines(kind="coffee")),
         askc("hannah seidel from the studio or hannah bauer?", options="$hannah_s, $hannah_b")]),
  T("bauer", diff(upd("hannah_b", date=ANY)),
    ref=[act("log", rows="$hannah_b", args=lines(kind="coffee"))]),
  T("does she owe me for the day pass", rows("d_hannah_b"),
    ref=[ans(kind="debt", linked_to="$hannah_b", where='status = "open"')]),
  T("she paid, settle it", diff(upd("d_hannah_b", status="settled")),
    ref=[act("settle_debt", rows="$d_hannah_b")]),
  T("people i've got debts with who aren't in any of my groups", rows("ines", "greta"),
    ref=[ans(kind="person", where="debt count != 0 and group count < 1")]))

S("T06-092", "locker username empty result",
  T("what's the tonkeller wifi", rows("wifi", "studio_wifi"),
    ref=[find(kind="locker item", name="Tonkeller wifi"),
         ans(kind="locker item", where='type = "wifi"')]),
  T("none of those. ok which logins do i have with a username", rows("thomann", "elster"),
    ref=[ans(kind="locker item", where='type = "login" and username is set')]),
  T("Thomann login username?", rows("thomann"),
    ref=[ans(kind="locker item", name="Thomann login")]),
  T("is my old paypal login in the trash", rows("old_paypal"),
    ref=[ans(kind="locker item", name="Old PayPal login", trashed=True)]),
  T("restore it, need to close the account", diff(restore("old_paypal")),
    ref=[act("restore", rows="$old_paypal")]),
  T("make up a new strong password for it and save it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T06-093", "premiere dead end search",
  T("when's the theatre premiere", rows("premiere"),
    ref=[ans(kind="event", name="Theatre premiere"),
         ans(rows="$premiere")]),
  T("and Tech run Theater Lindenau?", rows("theatre_tech"),
    ref=[ans(kind="event", name="Tech run Theater Lindenau")]),
  T("what do i owe felix, task wise", rows("inv_jan", "inv_feb"),
    ref=[ans(kind="task", linked_to="$felix", where='status = "open"')]))

S("T06-094", "trashed tasks find only restore undo",
  T("tasks i've deleted?", rows("library", "gym", "flyers"),
    ref=[find(kind="task", trashed=True), ans(rows="@prev")]),
  T("bring back Print flyers for Tonkeller", diff(restore("flyers")),
    ref=[act("restore", rows="$flyers")]),
  T("no wait, undo, lena did them", diff(trash("flyers")),
    ref=[act("undo")]),
  T("and Return library books, bring that back", diff(restore("library")),
    ref=[act("restore", kind="task", name="Return library books", trashed=True)]),
  T("move it to monday", diff(upd("library", date="2026-02-09")),
    ref=[act("reschedule", rows="$library", args=lines(to=U("week", 1, weekday=1)))]))

S("T06-095", "festival crew call ambiguous delete ask",
  T("delete Festival crew call", ask("crew_call1", "crew_call2"),
    ref=[act("delete", kind="event", name="Festival crew call"),
         find(kind="event", name="Festival crew call"),
         askc("the one on the 18th or on 4 march?", options="$crew_call1, $crew_call2")]),
  T("march one, tobi said we skip it", diff(trash("crew_call2")),
    ref=[act("delete", rows="$crew_call2")]),
  T("who's coming to the other one", rows("tobi", "nele", "emre", "olli"),
    ref=[ans(kind="person", linked_to="$crew_call1")]))

S("T06-096", "studio day ambiguous edit",
  T("add 'paul brings the fretless' to Studio day Plagwitz", diff(upd("studio_feb", description="paul brings the fretless")),
    ref=[act("edit", kind="event", name="Studio day Plagwitz", args=lines(description="paul brings the fretless")),
         act("edit", kind="event", name="Studio day Plagwitz", when=W({"from": U("day", 0)}),
             args=lines(description="paul brings the fretless"))]),
  T("how many studio days did i have in january", val(1),
    ref=[ans(op="count", kind="event", name="Studio day Plagwitz", when=W(U("month", 0, name=1)))]))

S("T06-097", "single turn frank restore",
  T("bring frank otto back into my contacts, he wants the mixer after all", diff(restore("frank")),
    ref=[act("restore", kind="person", name="Frank Otto", trashed=True)]))

S("T06-098", "single turn delete everything",
  T("delete every single note i've got, blank slate", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T06-099", "single turn event no date ask",
  T("put the bandcamp release on the calendar", ask(),
    ref=[askc("sure, what day and time is the release?")]))

S("T06-100", "old contacts note restore notebook",
  T("is Old venue contacts restorable", rows("old_contacts"),
    ref=[ans(kind="note", name="Old venue contacts", trashed=True)]),
  T("restore it and put it in Band", diff(restore("old_contacts"), link("band_nb", "old_contacts")),
    ref=[act("restore", rows="$old_contacts", more=True),
         act("add_to", rows="$old_contacts", args=lines(to="$band_nb"))]),
  T("how many notes in Band", val(5),
    ref=[ans(op="count", kind="note", linked_to="$band_nb")]),
  T("and the CV 2023 doc, is that in the trash too", rows("old_cv"),
    ref=[ans(kind="document", name="CV 2023", trashed=True)]),
  T("leave it there", decline("never_mind"),
    ref=[dec("never_mind")]))


X("T06-023",
  T("which list was the Studio one", rows("gearlist"),
    ref=[find(kind="list", name="Studio"),
         ans(kind="list", where='area = "studio"')]),
  T("what's open on it", rows("in_ears", "xlr", "sell_mixer"),
    ref=[ans(kind="task", linked_to="$gearlist", where='status = "open"')]))

X("T06-036",
  T("any notes about the monitor mix", rows("prague_plan"),
    ref=[search("monitor mix", kind="note"),
         ans(kind="note", where='body contains "monitors"')]))

X("T06-093",
  T("when do i see dr albrecht", rows("dentist"),
    ref=[ans(kind="event", name="Albrecht"),
         ans(kind="event", linked_to="$albrecht")]))

X("T06-090",
  T("and when's get koruna due, maybe i called it crowns", rows("czk"),
    ref=[ans(kind="task", name="Get koruna"),
         search("crowns", kind="task"),
         ans(rows="$czk")]))

X("T06-054",
  T("any pics from the prague gig yet", rows(),
    ref=[ans(kind="photo", linked_to="$prague_album")]))

X("T06-045",
  T("and add her to the group", ask(),
    ref=[askc("which group, Festival crew 2026 or one of the others?")]))

X("T06-028",
  T("move band rehearsal", ask(),
    ref=[askc("which rehearsal, and to when?")]))

X("T06-085",
  T("and add the new lighting guy to it", ask(),
    ref=[askc("what's the lighting guy's name? he's not in your contacts yet")]))

X("T06-052",
  T("and kalle, where's he at with me", val((-600, "CZK"), (78, "EUR")),
    ref=[search("kalle", kind="person"), comp(op="balance", rows="$kalle"), ans(value="@prev")]))

X("T06-091",
  T("ok then a note called Fresh start: sort the notebooks on sunday",
    diff(new("note", name="Fresh start", body=has("notebooks"))),
    ref=[act("create", args=lines(kind="note", name="Fresh start", body="sort the notebooks on sunday"))]),
  T("meh, undo that", diff(trash("+1")),
    ref=[act("undo")]))

X("T06-097",
  T("open his card, what did he want again", rows("frank"),
    ref=[opn("$frank"), ans(rows="$frank")]))

S("T06-103", "single group currency is set",
  T("which of my groups actually have a currency set on them",
    rows("kitty", "band", "crew", "prague", "harz", "mama60"),
    ref=[ans(kind="group", where="currency is set")]))

S("T06-104", "single note span date named-month",
  T("notes from feb first to end of february",
    rows("fest_budget", "heating", "rota_note", "setlist_note", "theatre_rf"),
    ref=[ans(kind="note", when=W({"from": D("2026-02-01"), "to": U("month", 0, name=2)}))]))

S("T06-105", "single note span open before time",
  T("notes from before 9am on dec fifteenth",
    rows("band_money", "soljanka", "tonkeller_room", "tour_2023"),
    ref=[ans(kind="note", when=W({"to": D("2025-12-15", "09:00")}))]))

S("T06-107", "create event named verbatim delete existing",
  T("kill the radio interview on radio blau, put a photo shoot with nils on friday at 3 instead",
    diff(trash("radio"), new("event", name=has("photo", "shoot", "nils"), date="2026-02-13T15:00")),
    ref=[act("delete", more=True, kind="event", name="Radio interview on Radio Blau"),
         act("create", args=lines(kind="event", name="Photo shoot with Nils", date=U("week", 1, weekday=5, time="15:00")))]))
