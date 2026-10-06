from gold import *

world("T06", "2026-02-07T23:15", "Lukas Brandt", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T06-A001", "ask-options locker_item star c3a",
  T("star the wifi", ask("wifi", "studio_wifi"),
    ref=[act("star", kind="locker item", name="wifi"),
         askc("The WG wifi or the Studio Plagwitz wifi?", options="$wifi, $studio_wifi")]),
  T("studio, i use it every day", diff(upd("studio_wifi", starred=True)),
    ref=[act("star", rows="$studio_wifi")]))

S("T06-A003", "ask-options event reschedule c3a",
  T("move the greta mixing session to thursday", ask("mix_greta1", "mix_greta2", "mix_greta3"),
    ref=[act("reschedule", kind="event", name="Mixing session with Greta", args=lines(to=U("week", 1, weekday=4))),
         find(kind="event", name="Mixing session with Greta", when=J({"from": U("day", 0)})),
         askc("The one on 9 Feb, 16 Feb or 2 Mar?", options="$mix_greta1, $mix_greta2, $mix_greta3")]),
  T("the 9th", diff(upd("mix_greta1", date="2026-02-12T10:00")),
    ref=[act("reschedule", rows="$mix_greta1", args=lines(to=U("week", 1, weekday=4)))]),
  T("and the setlists one's done, tick it off", diff(upd("setlists", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="setlists")]))

S("T06-A005", "ask-options debt settle_debt c3a",
  T("settle the tickets", ask("d_jonask_bvg", "d_sophie_train"),
    ref=[act("settle_debt", kind="debt", name="tickets"),
         askc("Jonas's tram tickets (you owe 8) or Sophie's Harz train tickets (she owes you 27.80)?", options="$d_jonask_bvg, $d_sophie_train")]),
  T("jonas, tram tickets", diff(upd("d_jonask_bvg", status="settled")),
    ref=[act("settle_debt", rows="$d_jonask_bvg")]))

S("T06-A006", "ask-options event cancel never_mind c3a",
  T("cancel the tonkeller soundcheck", ask("sc_0213", "sc_0306"),
    ref=[act("cancel", kind="event", name="Soundcheck Tonkeller"),
         find(kind="event", name="Soundcheck Tonkeller", when=J({"from": U("day", 0)})),
         askc("The one on 13 Feb or the one on 6 Mar?", options="$sc_0213, $sc_0306")]),
  T("no wait, leave it, i'll check with the sound guy first", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star karl", diff(upd("kalle", starred=True)),
    ref=[act("star", kind="person", name="Karl")]))

S("T06-A007", "follow-up c3a",
  T("what's on next week", rows("podcast", "sc_0213", "theatre_tech", "gig_tonkeller", "mix_greta1", "reh_0210", "bike", "premiere", "climbing"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the ones from thursday", rows("bike", "climbing", "sc_0213", "gig_tonkeller", "premiere"),
    ref=[ans(within="@prev", when=J({"from": U("week", 1, weekday=4)}))]),
  T("drop the first two", rows("bike", "gig_tonkeller", "climbing"),
    ref=[ans(within="@prev", exclude="$premiere, $sc_0213")]))

S("T06-A008", "follow-up c3a",
  T("what's due next week", rows("fridge", "vat", "call_sophie", "snake", "xlr", "kuhn_heat", "in_ears", "rider", "bike_light", "setlists", "live_mix_import"),
    ref=[ans(kind="task", when=J(U("week", 1)), where="status = open")]),
  T("which of those need more than 30 minutes", rows("vat", "fridge"),
    ref=[ans(within="@prev", where="effort > 30")]),
  T("any of those priority 1", rows("vat"),
    ref=[ans(within="@prev", where="priority = 1")]))

S("T06-A009", "follow-up c3a",
  T("which people owe me", rows("d_paul_session", "d_hannah_b", "d_mira_pizza", "d_kalle_beer", "d_kalle_strings", "d_sophie_train"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 25", rows("d_paul_session", "d_sophie_train"),
    ref=[ans(within="@prev", where="amount > 25 EUR")]),
  T("and the other ones", rows("d_hannah_b", "d_kalle_strings", "d_mira_pizza", "d_kalle_beer"),
    ref=[ans(within="@1", exclude="@2")]))

S("T06-A010", "follow-up c3a",
  T("what's in the contracts folder", rows("fest_contract", "theatre_contract", "rybka_contract"),
    ref=[ans(kind="document", linked_to="$contracts_f")]),
  T("any of those starred", rows("theatre_contract"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("and unstar it", diff(upd("theatre_contract", starred=False)),
    ref=[act("unstar", rows="@prev")]))
