from gold import *

world("T26", "2026-11-24T05:30", "Ahmed Bello", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T26-A001", "ask-options person star c3a",
  T("star kunle", ask("kunle_b", "kunle_a"),
    ref=[act("star", kind="person", name="Kunle"),
         askc("Kunle Bello your cousin or Kunle Adeyemi the HSE officer?", options="$kunle_b, $kunle_a")]),
  T("my cousin, the ajo coordinator", diff(upd("kunle_b", starred=True)),
    ref=[act("star", rows="$kunle_b")]))

S("T26-A002", "ask-options event reschedule c3a",
  T("move the dentist to monday", ask("dentist_femi", "dentist_kemi"),
    ref=[act("reschedule", kind="event", name="dentist", args=lines(to=U("week", 1, weekday=1))),
         askc("Femi's on Thursday the 26th or Kemi's on 3 Dec?", options="$dentist_femi, $dentist_kemi")]),
  T("kemi's, femi's is the wrong one", diff(upd("dentist_kemi", date="2026-11-30T09:00")),
    ref=[act("reschedule", rows="$dentist_kemi", args=lines(to=U("week", 1, weekday=1)))]))

S("T26-A003", "ask-options task complete c3a",
  T("tick off the school fees", ask("fees_tobi", "fees_kemi"),
    ref=[act("complete", kind="task", name="school fees"),
         askc("Pay Tobi's school fees or Pay Kemi's school fees?", options="$fees_tobi, $fees_kemi")]),
  T("tobi's, transferred this morning", diff(upd("fees_tobi", status="completed", completed=ANY)),
    ref=[act("complete", rows="$fees_tobi")]),
  T("and the replace one's done, tick it off", diff(upd("inverter", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="replace")]))

S("T26-A004", "ask-options document delete never_mind c3a",
  T("delete the payslip", ask("payslip_oct", "payslip_sep"),
    ref=[act("delete", kind="document", name="payslip"),
         askc("The October payslip or the September one?", options="$payslip_oct, $payslip_sep")]),
  T("wait no, the bank wants three months of them", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T26-A006", "ask-options note delete never_mind c3a",
  T("delete the ajo note", ask("ajo_rota", "ajo_oct", "ajo_rules"),
    ref=[act("delete", kind="note", name="ajo"),
         askc("Ajo payout rota, October ajo minutes or Ajo rules?", options="$ajo_rota, $ajo_oct, $ajo_rules")]),
  T("no no leave them all, kunle will ask for them", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star bayo", diff(upd("bayo", starred=True)),
    ref=[act("star", kind="person", name="Bayo")]))

S("T26-A007", "follow-up c3a",
  T("what's open on the house build list", rows("tiles", "drawings", "wiring", "roofing", "instalment"),
    ref=[ans(kind="task", linked_to="$house_l", where="status = open")]),
  T("pick out the ones that land this week", rows("roofing"),
    ref=[ans(within="@prev", when=J(U("week", 0)))]),
  T("what about the others", rows("tiles", "drawings", "wiring", "instalment"),
    ref=[ans(within="@1", exclude="@2")]))

S("T26-A008", "follow-up c3a",
  T("what have i got next week", rows("mama70", "medical", "site_1205", "vaccination", "plaster", "roof_meet", "football_1205", "parents_day", "dentist_kemi"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the ones before thursday", rows("roof_meet", "medical", "vaccination", "plaster"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=3)}))]),
  T("and thursday on", rows("mama70", "parents_day", "dentist_kemi", "site_1205", "football_1205"),
    ref=[ans(within="@1", exclude="@2")]))

S("T26-A009", "follow-up c3a",
  T("who owes me", rows("d_chidi", "d_ibrahim", "d_tunde", "d_segun", "d_bayo", "d_garba", "d_funmi"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 50000", rows("d_bayo", "d_ibrahim", "d_funmi"),
    ref=[ans(within="@prev", where="amount > 50000 NGN")]),
  T("and the biggest one", rows("d_bayo"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T26-A010", "follow-up c3a",
  T("what's in the rig album", rows("p_crane", "p_heli", "p_muster", "p_deck", "p_fpso", "p_turbine"),
    ref=[ans(kind="photo", linked_to="$rig_al")]),
  T("now only the starred ones", rows("p_fpso"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it", diff(upd("p_fpso", starred=False)),
    ref=[act("unstar", rows="@prev")]))
