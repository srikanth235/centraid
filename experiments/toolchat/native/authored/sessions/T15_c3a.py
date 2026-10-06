from gold import *

world("T15", "2026-11-09T10:15", "Ingrid Solberg", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T15-A001", "ask-options event reschedule never_mind c3a",
  T("move the planning meeting to 2", ask("plan_1111", "plan_1118"),
    ref=[act("reschedule", kind="event", name="Cruise planning meeting", args=lines(to=U("day", 0, anchor="row", time="14:00"))),
         find(kind="event", name="Cruise planning meeting", when=J({"from": U("day", 0)})),
         askc("The one on 11 Nov or the one on 18 Nov?", options="$plan_1111, $plan_1118")]),
  T("actually leave it, the captain moved it already", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T15-A004", "ask-options photo star c3a",
  T("star the aurora photo", ask("p_aurora2", "p_aurora3"),
    ref=[act("star", kind="photo", name="aurora"),
         askc("Green aurora from the ship or aurora at the cabin?", options="$p_aurora2, $p_aurora3")]),
  T("the ship one", diff(upd("p_aurora2", starred=True)),
    ref=[act("star", rows="$p_aurora2")]))

S("T15-A101", "ask-options note delete c3a",
  T("wipe the ice note", ask("ice_edge", "lyngen_ice"),
    ref=[act("delete", kind="note", name="ice"),
         askc("Ice edge observations or Lyngen ice lines?", options="$ice_edge, $lyngen_ice")]))

S("T15-A007", "follow-up c3a",
  T("what's due up to wednesday", rows("call_mum", "kiel_reply", "cat_food", "ctd_profiles"),
    ref=[ans(kind="task", when=J(span(U("day", 0), U("week", 0, weekday=3))), where="status = open")]),
  T("which of those take over 15 minutes", rows("ctd_profiles", "kiel_reply"),
    ref=[ans(within="@prev", where="effort > 15")]),
  T("and the longest of them", rows("ctd_profiles"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]))

S("T15-A008", "follow-up c3a",
  T("anything on next week", rows("drill", "jonas_bday", "car_service", "boulder_1117", "plan_1118", "labmtg_1120", "survival", "agm", "defence"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the ones from wednesday on", rows("labmtg_1120", "drill", "jonas_bday", "car_service", "plan_1118", "agm"),
    ref=[ans(within="@prev", when=J({"from": U("week", 1, weekday=3)}))]),
  T("and the earlier ones", rows("defence", "boulder_1117", "survival"),
    ref=[ans(within="@1", exclude="@2")]))

S("T15-A009", "follow-up c3a",
  T("what's owed to me", rows("d_jonas_vet", "d_linnea", "d_erik_j", "d_silje", "d_anders", "d_marianne"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 300", rows("d_jonas_vet", "d_erik_j", "d_anders"),
    ref=[ans(within="@prev", where="amount > 300 NOK")]),
  T("and the biggest one", rows("d_anders"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T15-A010", "follow-up c3a",
  T("what's in the cruise album", rows("p_crew", "p_net", "p_gull", "p_galley", "p_winch", "p_ice_edge", "p_copepod", "p_walrus"),
    ref=[ans(kind="photo", linked_to="$cruise_al")]),
  T("which of those have a star", rows("p_crew", "p_gull", "p_ice_edge", "p_copepod"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("and unstar all of them", diff(upd("p_crew", starred=False), upd("p_gull", starred=False), upd("p_ice_edge", starred=False), upd("p_copepod", starred=False)),
    ref=[act("unstar", rows="@prev")]))
