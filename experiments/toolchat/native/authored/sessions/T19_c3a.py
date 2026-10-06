from gold import *

world("T19", "2026-04-14T20:40", "Fatima Al-Sayed", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T19-A003", "ask-options task complete c3a",
  T("tick off the cnss one", ask("reimburse", "cnss_claims"),
    ref=[act("complete", kind="task", name="cnss"),
         askc("File Baba's CNSS reimbursement or Send CNSS claims batch?", options="$reimburse, $cnss_claims")]),
  T("the claims batch, sent it before lunch", diff(upd("cnss_claims", status="completed", completed=ANY)),
    ref=[act("complete", rows="$cnss_claims")]),
  T("and the strips one's done, tick it off", diff(upd("strips", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="strips")]))

S("T19-A004", "ask-options document delete never_mind c3a",
  T("delete the scan", ask("scan_41", "scan_42"),
    ref=[act("delete", kind="document", name="scan"),
         askc("Scan 0041 or Scan 0042?", options="$scan_41, $scan_42")]),
  T("actually hold on, i don't know what they are. leave them", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T19-A005", "ask-options debt settle_debt c3a",
  T("mark the fuel one as paid", ask("d_samira", "d_driss"),
    ref=[act("settle_debt", kind="debt", name="Fuel for the school run"),
         find(kind="debt", name="Fuel for the school run", where="status = open"),
         askc("Samira's fuel for the school run (you owe 200) or Driss's (he owes you 200)?", options="$d_samira, $d_driss")]),
  T("driss's, he paid me back at the pharmacy", diff(upd("d_driss", status="settled")),
    ref=[act("settle_debt", rows="$d_driss")]))

S("T19-A101", "ask-options event reschedule c3a",
  T("can the dentist be monday instead", ask("dentist_adam", "dentist_me"),
    ref=[act("reschedule", kind="event", name="dentist", args=lines(to=U("week", 1, weekday=1))),
         askc("Adam's on 24 April or yours on 7 May?", options="$dentist_adam, $dentist_me")]))

S("T19-A007", "follow-up c3a",
  T("what's left on the pharmacy list", rows("invoices", "fridge_log", "count_sheets", "cnss_claims", "rent_05", "insurance_ph", "rota", "scooter", "expiry", "order_0416"),
    ref=[ans(kind="task", linked_to="$pharm_l", where="status = open")]),
  T("which of those take over 30 minutes", rows("cnss_claims", "scooter", "count_sheets", "rota", "expiry"),
    ref=[ans(within="@prev", where="effort > 30")]),
  T("which is the longest", rows("count_sheets"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]))

S("T19-A008", "follow-up c3a",
  T("anything on this week", rows("berrada_meet", "lina_vacc", "run_0414", "run_0416", "yoga", "podiatrist", "dinner_hajja", "ptm", "swim_0415", "plumber_pharm", "stock_count", "garde_0418"),
    ref=[ans(kind="event", when=J(U("week", 0)))]),
  T("just up to thursday", rows("berrada_meet", "lina_vacc", "run_0414", "run_0416", "yoga", "ptm", "swim_0415", "plumber_pharm"),
    ref=[ans(within="@prev", when=J({"to": U("week", 0, weekday=4)}))]),
  T("what about the others", rows("stock_count", "podiatrist", "dinner_hajja", "garde_0418"),
    ref=[ans(within="@1", exclude="@2")]))

S("T19-A009", "follow-up c3a",
  T("who do i owe", rows("d_youssef", "d_khalid", "d_aicha", "d_nadia", "d_samira"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("which of those are over 150", rows("d_youssef", "d_khalid", "d_samira"),
    ref=[ans(within="@prev", where="amount > 150 MAD")]),
  T("and the rest", rows("d_aicha", "d_nadia"),
    ref=[ans(within="@1", exclude="@2")]))

S("T19-A010", "follow-up c3a",
  T("show me the kids album", rows("drawing", "tooth", "corniche", "bike", "cake_2025", "eid_kids", "medal", "sandcastle"),
    ref=[ans(kind="photo", linked_to="$a_kids")]),
  T("now only the starred ones", rows("eid_kids"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it now", diff(upd("eid_kids", starred=False)),
    ref=[act("unstar", rows="@prev")]))
