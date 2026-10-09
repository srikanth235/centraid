from gold import *

world("T08", "2026-04-06T17:50", "Deshawn Carter", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T08-A001", "ask-options event reschedule c3a",
  T("move the reunion call to tuesday", ask("rcall_0412", "rcall_0426", "rcall_0510"),
    ref=[act("reschedule", kind="event", name="Reunion planning call", args=lines(to=U("week", 0, weekday=2))),
         find(kind="event", name="Reunion planning call", when=J({"from": U("day", 0)})),
         askc("The one on 12 Apr, 26 Apr or 10 May?", options="$rcall_0412, $rcall_0426, $rcall_0510")]),
  T("the 26th", diff(upd("rcall_0426", date="2026-04-07T16:00")),
    ref=[act("reschedule", rows="$rcall_0426", args=lines(to=U("week", 0, weekday=2)))]))

S("T08-A002", "ask-options task complete c3a",
  T("tick off dues, i've sent it", ask("dues", "union_dues"),
    ref=[act("complete", kind="task", name="dues"),
         askc("Collect reunion dues or Pay union dues?", options="$dues, $union_dues")]),
  T("the union one", diff(upd("union_dues", status="completed", completed=ANY)),
    ref=[act("complete", rows="$union_dues")]))

S("T08-A005", "ask-options debt settle_debt c3a",
  T("settle the deposit", ask("d_dre", "d_monique"),
    ref=[act("settle_debt", kind="debt", name="deposit"),
         askc("Dre's reunion shirt deposit (he owes you 120) or Monique's half of the summer camp deposit (she owes you 210)?", options="$d_dre, $d_monique")]),
  T("dre's, he paid cash at the shop", diff(upd("d_dre", status="settled")),
    ref=[act("settle_debt", rows="$d_dre")]))

S("T08-A006", "ask-options locker_item star c3a",
  T("star the login", ask("servicetitan", "bank_login"),
    ref=[act("star", kind="locker item", name="login"),
         askc("The work dispatch app login or the credit union login?", options="$servicetitan, $bank_login")]),
  T("credit union, i use it daily", diff(upd("bank_login", starred=True)),
    ref=[act("star", rows="$bank_login")]),
  T("and star hattie", diff(upd("bigmama", starred=True)),
    ref=[act("star", kind="person", name="Hattie")]))

S("T08-A101", "ask-options task complete c3a",
  T("tick off the poster one", ask("tree", "poster"),
    ref=[act("complete", kind="task", name="poster"),
         askc("Print family tree poster or Buy poster board for science fair?", options="$tree, $poster")]))

S("T08-A007", "follow-up c3a",
  T("what's due this week", rows("restock", "bigmama_meds", "w2_upload", "field_trip", "recovery_tank", "dishwasher", "ts_apr", "call_bev", "filter_apr", "budget_email", "lunch", "cleats"),
    ref=[ans(kind="task", when=J(U("week", 0)), where="status = open")]),
  T("any under 20 minutes", rows("ts_apr", "lunch", "filter_apr"),
    ref=[ans(within="@prev", where="effort < 20")]),
  T("what about the others", rows("restock", "bigmama_meds", "w2_upload", "recovery_tank", "field_trip", "dishwasher", "call_bev", "budget_email", "cleats"),
    ref=[ans(within="@1", exclude="@2")]))

S("T08-A008", "follow-up c3a",
  T("what's on next week", rows("oil_change", "boost_0413", "science_fair", "handoff_0417", "prac_0414", "walkthrough", "prac_0416", "epa", "ptc"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the practices", rows("prac_0416", "prac_0414"),
    ref=[ans(within="@prev", name="practice")]),
  T("what else is on then", rows("oil_change", "epa", "boost_0413", "science_fair", "handoff_0417", "ptc", "walkthrough"),
    ref=[ans(kind="event", when=J(U("week", 1)), exclude="$prac_0414, $prac_0416")]))

S("T08-A009", "follow-up c3a",
  T("who still owes me money", rows("d_trey", "d_tanya2", "d_quanisha", "d_dre", "d_coach", "d_monique"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 100", rows("d_dre", "d_monique"),
    ref=[ans(within="@prev", where="amount > 100 USD")]),
  T("and the biggest one", rows("d_monique"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T08-A010", "follow-up c3a",
  T("show me the twins album", rows("p_band", "p_fair", "p_school", "p_td", "p_bday12", "p_bigmama"),
    ref=[ans(kind="photo", linked_to="$twins_album")]),
  T("which of those have a star", rows("p_bigmama", "p_td"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar both", diff(upd("p_bigmama", starred=False), upd("p_td", starred=False)),
    ref=[act("unstar", rows="@prev")]))
