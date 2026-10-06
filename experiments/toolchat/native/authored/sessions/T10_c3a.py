from gold import *

world("T10", "2026-06-19T14:20", "Bashir Haddad", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T10-A002", "ask-options task complete c3a",
  T("tick off the tiles one", ask("tiles", "quotes"),
    ref=[act("complete", kind="task", name="tiles"),
         askc("Choose tiles or Get three quotes for the tiles?", options="$tiles, $quotes")]),
  T("the quotes, got all three", diff(upd("quotes", status="completed", completed=ANY)),
    ref=[act("complete", rows="$quotes")]))

S("T10-A003", "ask-options event reschedule never_mind c3a",
  T("push the aqaba drive to 8", ask("aqaba_drive", "aqaba_back"),
    ref=[act("reschedule", kind="event", name="aqaba", args=lines(to=U("day", 0, anchor="row", time="08:00"))),
         askc("Drive to Aqaba on 9 July or the drive back on 12 July?", options="$aqaba_drive, $aqaba_back")]),
  T("actually leave the trip as it is, abu fadi is driving with me", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and the inspection one's done, tick it off", diff(upd("inspection", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="inspection")]))

S("T10-A004", "ask-options photo delete never_mind c3a",
  T("delete the blurry photo", ask("blur_1", "blur_2"),
    ref=[act("delete", kind="photo", name="blurry"),
         askc("The blurry mosque ceiling or the blurry chess clock?", options="$blur_1, $blur_2")]),
  T("hold on, let me look at them first, leave them", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T10-A101", "ask-options person star c3a",
  T("star khaled", ask("khaled_o", "khaled_s"),
    ref=[act("star", kind="person", name="Khaled"),
         askc("Khaled Omari the former colleague or Khaled Sweidan the pharmacist?", options="$khaled_o, $khaled_s")]))

S("T10-A006", "follow-up c3a",
  T("show me next week", rows("huda_visit", "dentist", "call_yousef_0628", "nabil_lunch_0626", "tournament", "physio_0622", "chess_0623", "site_visit", "blood_test", "abu_fadi_coffee", "lecture"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the ones before wednesday", rows("huda_visit", "lecture", "physio_0622", "site_visit", "blood_test", "chess_0623"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=2)}))]),
  T("drop the first two", rows("site_visit", "lecture", "blood_test", "chess_0623"),
    ref=[ans(within="@prev", exclude="$physio_0622, $huda_visit")]))

S("T10-A007", "follow-up c3a",
  T("what's due next week", rows("fertilizer", "call_dana", "pair_print", "clocks", "inspection", "quotes", "pair_list", "pairings", "pledges", "lecture_q", "tiles", "gas"),
    ref=[ans(kind="task", when=J(U("week", 1)), where="status = open")]),
  T("which of those are priority 1 or 2", rows("pledges", "quotes", "pairings"),
    ref=[ans(within="@prev", where="priority <= 2 and priority > 0")]),
  T("and the ones over an hour", rows("quotes", "pairings"),
    ref=[ans(within="@prev", where="effort > 60")]))

S("T10-A008", "follow-up c3a",
  T("what's left on the home list", rows("prop_tax", "elec_07", "water_q2", "ac", "gas", "leak", "license_26"),
    ref=[ans(kind="task", linked_to="$home_l", where="status = open")]),
  T("just the ones due this week", rows("leak", "ac"),
    ref=[ans(within="@prev", when=J(U("week", 0)))]),
  T("and the others", rows("prop_tax", "elec_07", "water_q2", "gas", "license_26"),
    ref=[ans(within="@1", exclude="@2")]))

S("T10-A009", "follow-up c3a",
  T("what's in the pension folder", rows("pension_june", "pension_may", "eng_cert", "pension_letter"),
    ref=[ans(kind="document", linked_to="$pension_f")]),
  T("which of those are starred", rows("pension_letter"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it", diff(upd("pension_letter", starred=False)),
    ref=[act("unstar", rows="@prev")]))
