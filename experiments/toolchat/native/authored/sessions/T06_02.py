from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T06-026", "person dates anchor span nickname",
  T("who did i see or talk to four days ago", rows("jonas_w", "kalle"),
    ref=[ans(kind="person", when=W(U("day", -4, anchor="today")))]),
  T("which of my contacts have a nickname saved", rows("kalle", "ute", "dieter", "tobi", "olli", "steffi", "bea"),
    ref=[ans(kind="person", where="nickname is set")]),
  T("and who've i not been in touch with since new year's lunch, like before 1pm on the first",
    rows("dieter", "steffi", "emre", "yusuf", "clara"),
    ref=[ans(kind="person", when=W({"to": D("2026-01-01", "13:00")}))]))

S("T06-027", "person span date to named month",
  T("who did i last talk to between jan twentieth and the end of january",
    rows("hannah_s", "sophie", "hannah_b", "anke", "tobi", "nele", "greta"),
    ref=[ans(kind="person", when=W({"from": D("2026-01-20"), "to": U("month", 0, name=1)}))]),
  T("any of them on a monthly check in", rows("anke", "nele"),
    ref=[ans(within="@prev", where="cadence = 30")]),
  T("log a call with anke", diff(upd("anke", date=ANY)),
    ref=[act("log", rows="$anke", args=lines(kind="call"))]))

S("T06-028", "person span named month to last week group count",
  T("everyone i contacted from january up to last week",
    rows("dieter", "olli", "hannah_s", "sophie", "hannah_b", "anke", "tobi", "nele", "greta", "ute"),
    ref=[ans(kind="person", when=W({"from": U("month", 0, name=1), "to": U("week", -1)}))]),
  T("who's in more than one group", rows("jonas_w", "lena", "kalle", "sophie", "me"),
    ref=[ans(kind="person", where="group count > 1")]))

S("T06-029", "events next two weeks duration description",
  T("what's coming up next week and the week after", rows(
      "mix_greta1", "theatre_tech", "reh_0210", "podcast", "premiere", "sc_0213", "gig_tonkeller", "bike", "climbing",
      "mix_greta2", "reh_0217", "crew_call1", "dentist", "radio", "mama_dinner"),
    ref=[ans(kind="event", when=W({"from": U("week", 1), "to": U("week", 2)}))]),
  T("which of those are short, under 45 min", rows("dentist"),
    ref=[ans(within="@prev", where="duration < 45 min")]),
  T("and which have notes in the description", rows("theatre_tech", "reh_0210", "podcast", "gig_tonkeller", "reh_0217", "radio", "mama_dinner"),
    ref=[ans(kind="event", when=W({"from": U("week", 1), "to": U("week", 2)}), where="description is set")]))

S("T06-030", "event count span date time to named month",
  T("how many things have i got from the tonkeller show on the thirteenth (from 6pm) until end of feb", val(17),
    ref=[ans(op="count", kind="event", when=W({"from": D("2026-02-13", "18:00"), "to": U("month", 0, name=2)}))]),
  T("how many of them are rehearsals", val(2),
    ref=[ans(op="count", kind="event", name="Band rehearsal",
             when=W({"from": D("2026-02-13", "18:00"), "to": U("month", 0, name=2)}))]))

S("T06-031", "tasks due weekday reschedule",
  T("what's due tuesday", rows("snake", "vat"),
    ref=[ans(kind="task", when=W(U("week", 1, weekday=2)))]),
  T("move Fix the stage snake to thursday", diff(upd("snake", date="2026-02-12")),
    ref=[act("reschedule", rows="$snake", args=lines(to=U("week", 1, weekday=4)))]),
  T("and tuesday after that change?", rows("vat"),
    ref=[ans(kind="task", when=W(U("week", 1, weekday=2)))]))

S("T06-032", "tasks named month span",
  T("tasks due in march", rows("stage_plot", "rent_03", "ksk"),
    ref=[ans(kind="task", when=W(U("month", 0, name=3)))]),
  T("and from march through to may first", rows("stage_plot", "rent_03", "ksk", "crew_shirts", "crew_rota"),
    ref=[ans(kind="task", when=W({"from": U("month", 0, name=3), "to": D("2026-05-01")}))]),
  T("which of those have no priority set", rows("stage_plot", "rent_03", "crew_shirts", "crew_rota"),
    ref=[ans(within="@prev", where="priority is empty")]))

S("T06-033", "task span weekday to named month priority",
  T("anything high priority due from monday through end of feb", rows("rider", "vat"),
    ref=[ans(kind="task", when=W({"from": U("week", 1, weekday=1), "to": U("month", 0, name=2)}), where="priority = 1")]),
  T("what about priority two or better", rows("snake", "rider", "kuhn_heat", "inv_jan", "vat", "rent_02", "inv_feb",
                                                   "ksk", "pa_quotes", "mama_gift"),
    ref=[ans(kind="task", where='priority < 3 and priority > 0 and status = "open"')]))

S("T06-034", "note span date time to date",
  T("what notes did i write between wednesday 9am and friday", rows("heating", "fest_budget", "rota_note"),
    ref=[ans(kind="note", when=W({"from": U("week", 0, weekday=3, time="09:00"), "to": U("week", 0, weekday=5)}))]),
  T("pin Heating problems", diff(upd("heating", pinned=True)),
    ref=[act("edit", rows="$heating", args=lines(pinned="yes"))]),
  T("which notes aren't pinned in the festival notebook", rows("fest_contacts", "fest_budget"),
    ref=[ans(kind="note", linked_to="$fest_nb", where="pinned != yes")]))

S("T06-035", "note span date time both",
  T("notes from the crew dinner night, like 10pm on the twenty-ninth till 6pm next day",
    rows("fest_power", "fest_contacts", "podcast_chain"),
    ref=[ans(kind="note", when=W({"from": D("2026-01-29", "22:00"), "to": D("2026-01-30", "18:00")}))]),
  T("move the podcast one to mixing notes... oh it's already there. ok take the router reset one out of the flat notebook",
    diff(unlink("flat_nb", "wifi_note")),
    ref=[act("remove_from", kind="note", name="Router reset steps", args=lines(from_="$flat_nb"))]))

S("T06-036", "note open end weekday notebook",
  T("band notebook notes older than last tuesday", rows("prague_plan", "lyrics_glas", "band_money"),
    ref=[ans(kind="note", linked_to="$band_nb", when=W({"to": U("week", -1, weekday=2)}))]),
  T("which notebooks have three or more notes", rows("mix_nb", "band_nb", "flat_nb", "fest_nb"),
    ref=[ans(kind="notebook", where="note count >= 3")]))

S("T06-037", "note open end named month",
  T("notes from last year", rows("tonkeller_room", "band_money", "wifi_note", "soljanka", "tour_2023"),
    ref=[ans(kind="note", when=W({"to": U("month", -1, name=12)}))]),
  T("delete the tour 2023 one", diff(trash("tour_2023")),
    ref=[act("delete", rows="$tour_2023")]),
  T("no put it back", diff(restore("tour_2023")),
    ref=[act("undo")]))

S("T06-038", "document span rel to named month",
  T("contracts i've added since last month", rows("theatre_contract", "fest_contract", "rybka_contract"),
    ref=[ans(kind="document", linked_to="$contracts_f", when=W({"from": U("month", -1), "to": U("month", 0, name=2)}))]),
  T("star Festival crew agreement", diff(upd("fest_contract", starred=True)),
    ref=[act("star", rows="$fest_contract")]))

S("T06-039", "document span weekday to date",
  T("docs added between the monday before last week and feb 2nd",
    rows("heating_letter", "fest_contract", "inv_2026_01", "receipts_doc", "inv_2026_02"),
    ref=[ans(kind="document", when=W({"from": U("week", -1, weekday=1), "to": D("2026-02-02")}))]),
  T("put the receipts scan in contracts", diff(unlink("tax_f", "receipts_doc"), link("contracts_f", "receipts_doc")),
    ref=[act("add_to", rows="$receipts_doc", args=lines(to="$contracts_f"))]),
  T("no, undo, wrong folder", diff(unlink("contracts_f", "receipts_doc"), link("tax_f", "receipts_doc")),
    ref=[act("undo")]))

S("T06-040", "photo anchor time",
  T("the photo i took last night at 11.40", rows("p_moon"),
    ref=[ans(kind="photo", when=W(U("day", -1, anchor="today", time="23:40")))]),
  T("nice, star that moon one", diff(upd("p_moon", starred=True)),
    ref=[act("star", rows="$p_moon")]),
  T("which pics are in more than one album", rows("p_desk", "p_stands_sale"),
    ref=[ans(kind="photo", where="album count > 1")]))

S("T06-041", "photo span date to rel",
  T("how many photos did i take from the harz trip on the twenty-fourth up to last week", val(12),
    ref=[ans(op="count", kind="photo", when=W({"from": D("2026-01-24"), "to": U("week", -1)}))]),
  T("and from the start of january til last week", val(26),
    ref=[ans(op="count", kind="photo", when=W({"from": U("month", 0, name=1), "to": U("week", -1)}))]))

S("T06-042", "photo open end date album",
  T("any pics from before this year", rows("p_mama"),
    ref=[ans(kind="photo", when=W({"to": U("year", -1)}))]),
  T("put that in wg life", diff(link("wg_album", "p_mama")),
    ref=[act("add_to", rows="$p_mama", args=lines(to="$wg_album"))]),
  T("hm no, undo", diff(unlink("wg_album", "p_mama")),
    ref=[act("undo")]))

S("T06-043", "debt span date time to weekday",
  T("debts from after lunch on jan twentieth up to monday", rows("d_lena_cables", "d_sophie_train", "d_mira_pizza",
                                                       "d_greta_dinner", "d_hannah_b"),
    ref=[ans(kind="debt", when=W({"from": D("2026-01-20", "12:00"), "to": U("week", 0, weekday=1)}))]),
  T("which of them are under 20", rows("d_greta_dinner", "d_mira_pizza", "d_hannah_b"),
    ref=[ans(within="@prev", where="amount < 20")]))

S("T06-044", "debt span rel rel sum",
  T("how much did i lend people last month and this month", val((117.8, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", when=W({"from": U("month", -1), "to": U("month", 0)}),
             where='direction = "owes_me"')]),
  T("and borrowed", val((107, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", when=W({"from": U("month", -1), "to": U("month", 0)}),
             where='direction = "i_owe"')]))

S("T06-045", "create person edit new cadence",
  T("new contact Jana Weiss, she's the new stage manager at theater lindenau",
    diff(new("person", name="Jana Weiss", role=has("stage manager"))),
    ref=[act("create", args=lines(kind="person", name="Jana Weiss", role="stage manager, Theater Lindenau"))]),
  T("set her cadence to every two weeks", diff(upd("+1", cadence=14)),
    ref=[act("edit", rows="$c1", args=lines(cadence="14"))]),
  T("who else is theatre", rows("felix"),
    ref=[ans(kind="person", where='role contains "Theater Lindenau"', exclude="$c1")]))

S("T06-046", "create event edit new",
  T("add a mastering call with greta next thursday 11 to 12",
    diff(new("event", name=has("mastering", "greta"), date="2026-02-12T11:00")),
    ref=[act("create", args=lines(kind="event", name="Mastering call with Greta", date=U("week", 1, weekday=4, time="11:00"),
                                  duration="60"))]),
  T("put 'episodes 10-12, loudness check' in its description", diff(upd("+1", description="episodes 10-12, loudness check")),
    ref=[act("edit", rows="$c1", args=lines(description="episodes 10-12, loudness check"))]),
  T("what's thursday now", rows("+1", "premiere"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=4)))]))

S("T06-047", "create task delete restore new",
  T("new task: buy a spare DI box, due friday", diff(new("task", name=has("DI box"), date="2026-02-13")),
    ref=[act("create", args=lines(kind="task", name="Buy a spare DI box", date=U("week", 1, weekday=5)))]),
  T("nah olli has one, delete it", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("ugh he sold it. bring it back", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]),
  T("and put it on the gear list", diff(link("gearlist", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$gearlist"))]))

S("T06-048", "knock-on debt settle plus tasks",
  T("paid ines for the prints and did the bin bags and the rota, tick all that",
    diff(upd("d_ines_prints", status="settled"), upd("bin_bags", status="completed", completed=ANY),
         upd("cleaning_rota", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", name="prints", more=True),
         act("complete", rows="$bin_bags, $cleaning_rota")]),
  T("so which debts am i on the hook for", rows("d_jonask_bvg", "d_lena_cables", "d_olli_mic", "d_greta_dinner"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T06-049", "debt count people ambiguous jonas",
  T("anyone with more than a single debt to me", rows("kalle"),
    ref=[ans(kind="person", where="debt count > 1")]),
  T("and what's jonas's balance", ask("jonas_k", "jonas_w"),
    ref=[bad(ans(op="balance", kind="person", name="Jonas")),
         askc("jonas keller or jonas wirth?", options="$jonas_k, $jonas_w")]),
  T("the flatmate", val((-2.9, "EUR")),
    ref=[ans(op="balance", rows="$jonas_k")]))

S("T06-050", "group person count delete empty",
  T("which groups have fewer than four people", rows("kitty", "mama60"),
    ref=[ans(kind="group", where="person count < 4")]),
  T("delete the harz one, we're done", diff(gone("harz"), unlink("harz", "sophie"), unlink("harz", "hannah_b"),
                                            unlink("harz", "yusuf"), unlink("harz", "me")),
    ref=[act("delete", rows="$harz")]))
