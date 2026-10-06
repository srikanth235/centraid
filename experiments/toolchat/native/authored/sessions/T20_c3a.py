from gold import *

world("T20", "2026-05-28T16:10", "Matteo Ricci", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T20-A001", "ask-options event reschedule c3a",
  T("push the call to monday", ask("photographer_call", "supplier_call"),
    ref=[act("reschedule", kind="event", name="call", args=lines(to=U("week", 1, weekday=1))),
         askc("The call with Ettore tomorrow or the call with the Montalcino supplier today?", options="$photographer_call, $supplier_call")]),
  T("ettore's, the supplier one's happening at five", diff(upd("photographer_call", date="2026-06-01T12:00")),
    ref=[act("reschedule", rows="$photographer_call", args=lines(to=U("week", 1, weekday=1)))]))

S("T20-A003", "ask-options task complete c3a",
  T("tick off the packing job", ask("pack", "pack_wine"),
    ref=[act("complete", kind="task", name="pack"),
         askc("Pack the kitchen or Pack the wine collection?", options="$pack, $pack_wine")]),
  T("the wine one, finally done", diff(upd("pack_wine", status="completed", completed=ANY)),
    ref=[act("complete", rows="$pack_wine")]),
  T("and the transfer one's done, tick it off", diff(upd("utilities", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="transfer")]))

S("T20-A006", "ask-options event cancel never_mind c3a",
  T("cancel the tasting", ask("menu_tasting", "tasting_fra_2"),
    ref=[act("cancel", kind="event", name="tasting"),
         askc("The wedding menu tasting on 11 June or the Barbaresco tasting with Francesca on 10 June?", options="$menu_tasting, $tasting_fra_2")]),
  T("no wait, don't cancel anything, i'll ask francesca first", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star roberto", diff(upd("papa", starred=True)),
    ref=[act("star", kind="person", name="Roberto")]))

S("T20-A007", "follow-up c3a",
  T("anything left on the move list", rows("deposit_back", "address", "boxes", "pack", "cleaners", "utilities", "pack_wine"),
    ref=[ans(kind="task", linked_to="$move_l", where="status = open")]),
  T("which of those take over 20 minutes", rows("address", "utilities", "boxes", "pack", "pack_wine"),
    ref=[ans(within="@prev", where="effort > 20")]),
  T("and the rest", rows("cleaners", "deposit_back"),
    ref=[ans(within="@1", exclude="@2")]))

S("T20-A008", "follow-up c3a",
  T("what's on next week", rows("fede_visit", "ikea", "planner_meet", "ride_0607", "plumber_visit", "electrician_visit", "nonna_bday", "brief_0602", "keys_pickup"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the ones before thursday", rows("brief_0602", "electrician_visit", "fede_visit", "keys_pickup"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=3)}))]),
  T("drop the first two", rows("brief_0602", "electrician_visit"),
    ref=[ans(within="@prev", exclude="$keys_pickup, $fede_visit")]))

S("T20-A009", "follow-up c3a",
  T("who owes me", rows("d_giulia", "d_luca", "d_stefano", "d_davide", "d_sofia"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 40", rows("d_giulia", "d_davide"),
    ref=[ans(within="@prev", where="amount > 40 EUR")]),
  T("which is the biggest", rows("d_giulia"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T20-A010", "follow-up c3a",
  T("what's in the rides album", rows("sunrise_ride", "impruneta_p", "fiesole_top", "group_ride", "flat_tyre"),
    ref=[ans(kind="photo", linked_to="$rides_album")]),
  T("which of those are starred", rows("sunrise_ride", "fiesole_top"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar both", diff(upd("sunrise_ride", starred=False), upd("fiesole_top", starred=False)),
    ref=[act("unstar", rows="@prev")]))
