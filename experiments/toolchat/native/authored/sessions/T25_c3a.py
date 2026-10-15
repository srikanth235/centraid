from gold import *

world("T25", "2026-10-11T18:45", "Yuki Tanaka", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T25-A001", "ask-options person star c3a",
  T("star sarah", ask("sarah_n", "sarah_c"),
    ref=[act("star", kind="person", name="Sarah"),
         askc("Sarah Nguyen the product manager or Sarah Cohen from book club?", options="$sarah_n, $sarah_c")]),
  T("cohen, the book club one", diff(upd("sarah_c", starred=True)),
    ref=[act("star", rows="$sarah_c")]))

S("T25-A002", "ask-options event reschedule c3a",
  T("push the dentist to next friday", ask("dentist_mika", "dentist_me"),
    ref=[act("reschedule", kind="event", name="dentist", args=lines(to=U("week", 1, weekday=5))),
         askc("Mika's on 21 Oct or yours on 4 Nov?", options="$dentist_mika, $dentist_me")]),
  T("my one", diff(upd("dentist_me", date="2026-10-16T08:30")),
    ref=[act("reschedule", rows="$dentist_me", args=lines(to=U("week", 1, weekday=5)))]))

S("T25-A003", "ask-options task complete never_mind c3a",
  T("tick off the parenting plan one", ask("plan", "sign_plan"),
    ref=[act("complete", kind="task", name="parenting plan"),
         askc("Update parenting plan or Sign final parenting plan?", options="$plan, $sign_plan")]),
  T("wait, i haven't signed anything yet, leave both", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and the holiday one's done, tick it off", diff(upd("holiday_sched", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="holiday")]))

S("T25-A006", "ask-options document star c3a",
  T("star the lumen doc", ask("t4", "contract"),
    ref=[act("star", kind="document", name="lumen"),
         askc("The T4 from Lumen or the Lumen employment contract?", options="$t4, $contract")]),
  T("the contract", diff(upd("contract", starred=True)),
    ref=[act("star", rows="$contract")]),
  T("and star kenji", diff(upd("kenji", starred=True)),
    ref=[act("star", kind="person", name="Kenji")]))

S("T25-A007", "follow-up c3a",
  T("what's open on the work list", rows("research_plan", "deck", "onboarding", "icons", "expense_1", "participants", "ds_docs"),
    ref=[ans(kind="task", linked_to="$work_l", where="status = open")]),
  T("which of those are priority 1", rows("onboarding"),
    ref=[ans(within="@prev", where="priority = 1")]),
  T("and everything else", rows("research_plan", "deck", "icons", "expense_1", "participants", "ds_docs"),
    ref=[ans(within="@1", exclude="@2")]))

S("T25-A008", "follow-up c3a",
  T("anything on next week", rows("mom_flight", "piano_1014", "handoff_1016", "hike_tremblant", "thanksgiving", "portfolio_rev", "therapy_1013", "book_10", "lawyer_call", "pediatrician", "one_on_one", "coffee_marc"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("only up to wednesday", rows("one_on_one", "pediatrician", "therapy_1013", "coffee_marc", "piano_1014", "thanksgiving"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=3)}))]),
  T("and thursday on", rows("book_10", "portfolio_rev", "mom_flight", "lawyer_call", "handoff_1016", "hike_tremblant"),
    ref=[ans(within="@1", exclude="@2")]))

S("T25-A010", "follow-up c3a",
  T("what's in the mika album", rows("apples", "tooth", "recital", "first_day", "grandma", "la_ronde"),
    ref=[ans(kind="photo", linked_to="$mika_album")]),
  T("are some of them starred", rows("first_day", "grandma"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar both of them", diff(upd("first_day", starred=False), upd("grandma", starred=False)),
    ref=[act("unstar", rows="@prev")]))
