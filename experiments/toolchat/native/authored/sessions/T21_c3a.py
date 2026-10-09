from gold import *

world("T21", "2026-06-06T09:00", "Grace Mwangi", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T21-A003", "ask-options task complete c3a",
  T("tick off the timetable one", ask("mock_tt", "print_tt"),
    ref=[act("complete", kind="task", name="timetable"),
         askc("Prepare mock exam timetable or Print the timetable?", options="$mock_tt, $print_tt")]),
  T("the printing, done it at the office", diff(upd("print_tt", status="completed", completed=ANY)),
    ref=[act("complete", rows="$print_tt")]),
  T("and the subject one's done, tick it off", diff(upd("hod_slots", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="subject")]))

S("T21-A004", "ask-options document delete never_mind c3a",
  T("delete the scan", ask("scan_1", "scan_2"),
    ref=[act("delete", kind="document", name="scan"),
         askc("Scan 004 or Scan 005?", options="$scan_1, $scan_2")]),
  T("wait, i don't know what they are yet. leave them", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T21-A005", "ask-options debt settle_debt c3a",
  T("settle the deposit", ask("d_brian", "d_susan"),
    ref=[act("settle_debt", kind="debt", name="deposit"),
         askc("Brian's rent deposit in Eldoret (he owes you 15000) or Susan's choir robe deposit (you owe 500)?", options="$d_brian, $d_susan")]),
  T("brian's, he sent it by mpesa", diff(upd("d_brian", status="settled")),
    ref=[act("settle_debt", rows="$d_brian")]))

S("T21-A006", "ask-options event cancel never_mind c3a",
  T("cancel the bom thing", ask("bom_june", "bom_fin"),
    ref=[act("cancel", kind="event", name="bom"),
         askc("The BOM meeting on 10 June or the BOM finance committee on 24 June?", options="$bom_june, $bom_fin")]),
  T("no wait, don't. the chairman will be upset", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star james", diff(upd("james", starred=True)),
    ref=[act("star", kind="person", name="James")]))

S("T21-A007", "follow-up c3a",
  T("what's still open on the school list", rows("tsc", "gutter", "obs_g4", "appraisals", "term_report", "mock_tt", "ribbons", "arrears", "feeding"),
    ref=[ans(kind="task", linked_to="$school_l", where="status = open")]),
  T("keep just the stuff due next week", rows("term_report", "obs_g4", "arrears", "mock_tt"),
    ref=[ans(within="@prev", when=J(U("week", 1)))]),
  T("what about the others", rows("tsc", "appraisals", "gutter", "feeding", "ribbons"),
    ref=[ans(within="@1", exclude="@2")]))

S("T21-A008", "follow-up c3a",
  T("what have i got next week", rows("brief_0608", "lunch_mary", "kevin_visit", "dentist_shiru", "choir_0611", "bom_june", "clinic_june", "harambee_plan"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("anything before wednesday", rows("harambee_plan", "brief_0608", "clinic_june"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=2)}))]))

S("T21-A009", "follow-up c3a",
  T("which people owe me", rows("d_peter_o", "d_alice", "d_rose", "d_mary_a", "d_brian"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 1000", rows("d_peter_o", "d_alice", "d_brian"),
    ref=[ans(within="@prev", where="amount > 1000 KES")]),
  T("what about the others", rows("d_mary_a", "d_rose"),
    ref=[ans(within="@1", exclude="@2")]))

S("T21-A010", "follow-up c3a",
  T("what's in the school album", rows("prize_day2", "prize_day1", "book_fair_p", "new_tank", "staff_photo"),
    ref=[ans(kind="photo", linked_to="$school_album")]),
  T("now only the starred ones", rows("staff_photo"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it now", diff(upd("staff_photo", starred=False)),
    ref=[act("unstar", rows="@prev")]))
