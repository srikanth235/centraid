from gold import *

world("T07", "2026-03-12T12:30", "Maria Ines Quispe", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T07-A002", "ask-options event reschedule c3a",
  T("push the marco thing to friday", ask("marco_call", "marco_visit"),
    ref=[act("reschedule", kind="event", name="marco", args=lines(to=U("week", 0, weekday=5))),
         askc("The video call with Marco today or his visit to the plots on 17 Apr?", options="$marco_call, $marco_visit")]),
  T("the call, i'm in the field today", diff(upd("marco_call", date="2026-03-13T16:00")),
    ref=[act("reschedule", rows="$marco_call", args=lines(to=U("week", 0, weekday=5)))]))

S("T07-A003", "ask-options task complete c3a",
  T("tick off the trial one", ask("trial_data", "hugo_email"),
    ref=[act("complete", kind="task", name="trial"),
         askc("Enter trial data into the spreadsheet or Email Hugo the trial plan?", options="$trial_data, $hugo_email")]),
  T("the email, sent it this morning", diff(upd("hugo_email", status="completed", completed=ANY)),
    ref=[act("complete", rows="$hugo_email")]),
  T("and the tuition one's done, tick it off", diff(upd("vale_fees", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="tuition")]))

S("T07-A004", "ask-options photo delete never_mind c3a",
  T("delete the truck photo", ask("h_truck", "tyres"),
    ref=[act("delete", kind="photo", name="truck"),
         askc("Loading Raul's truck or the new truck tyres?", options="$h_truck, $tyres")]),
  T("actually keep both, i might want them for the loan form", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T07-A005", "ask-options debt settle_debt c3a",
  T("settle the share", ask("d_rosa", "d_carmen", "d_hugo"),
    ref=[act("settle_debt", kind="debt", name="share"),
         askc("Rosa's fertilizer share (she owes 120), Carmen's robe cleaning share (she owes 15) or Hugo's lab fee share (you owe 90)?", options="$d_rosa, $d_carmen, $d_hugo")]),
  T("carmen's, she paid at mass", diff(upd("d_carmen", status="settled")),
    ref=[act("settle_debt", rows="$d_carmen")]))

S("T07-A006", "ask-options note delete c3a",
  T("get rid of the seed order note", ask("seed_2025", "seed_2026"),
    ref=[act("delete", kind="note", name="Seed order"),
         find(kind="note", name="Seed order"),
         askc("The 2025 seed order or the 2026 one?", options="$seed_2025, $seed_2026")]),
  T("the 2025 one, that season's over", diff(trash("seed_2025")),
    ref=[act("delete", rows="$seed_2025")]),
  T("and star luis", diff(upd("luis", starred=True)),
    ref=[act("star", kind="person", name="Luis")]))

S("T07-A101", "ask-options person star c3a",
  T("can you star mamani", ask("rosa_m", "ana"),
    ref=[act("star", kind="person", name="Mamani"),
         askc("Rosa Mamani the coop treasurer or Ana Mamani the neighbour?", options="$rosa_m, $ana")]))

S("T07-A007", "follow-up c3a",
  T("what's open on the farm list", rows("scout_report", "trial_data", "storehouse", "irrigation", "fung_1", "ferti", "sacks"),
    ref=[ans(kind="task", linked_to="$farm_l", where="status = open")]),
  T("narrow that to the ones landing next week", rows("scout_report", "trial_data"),
    ref=[ans(within="@prev", when=J(U("week", 1)))]),
  T("what about the others", rows("storehouse", "irrigation", "fung_1", "ferti", "sacks"),
    ref=[ans(within="@1", exclude="@2")]))

S("T07-A008", "follow-up c3a",
  T("what am i owing", rows("d_hugo", "d_efrain", "d_wilber", "d_lucia", "d_sonia", "d_carla"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("which of those are over 50", rows("d_sonia", "d_carla", "d_efrain", "d_hugo"),
    ref=[ans(within="@prev", where="amount > 50 PEN")]),
  T("the biggest of those?", rows("d_sonia"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T07-A009", "follow-up c3a",
  T("what's in the coop folder", rows("expo_contract", "register", "statutes", "min_doc"),
    ref=[ans(kind="document", linked_to="$coop_f")]),
  T("any of them starred", rows("statutes"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it now", diff(upd("statutes", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T07-A010", "follow-up c3a",
  T("show me the harvest album", rows("h_huayro", "h_dig", "h_sacks", "h_truck", "e_ribbon", "h_vale", "h_pachamanca"),
    ref=[ans(kind="photo", linked_to="$harvest_al")]),
  T("just the starred ones", rows("h_huayro", "e_ribbon", "h_vale"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("the rest of them", rows("h_dig", "h_sacks", "h_truck", "h_pachamanca"),
    ref=[ans(within="@1", exclude="@2")]))
