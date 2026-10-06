from gold import *

world("T13", "2026-09-03T22:10", "Amara Nwosu", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T13-A001", "ask-options event reschedule c3a",
  T("push journal club to next friday", ask("jc_0909", "jc_0930"),
    ref=[act("reschedule", kind="event", name="Journal club", args=lines(to=U("week", 1, weekday=5))),
         find(kind="event", name="Journal club", when=J({"from": U("day", 0)})),
         askc("The one on 9 Sept or the one on 30 Sept?", options="$jc_0909, $jc_0930")]),
  T("the 9th one, i'm presenting", diff(upd("jc_0909", date="2026-09-11T16:00")),
    ref=[act("reschedule", rows="$jc_0909", args=lines(to=U("week", 1, weekday=5)))]))

S("T13-A002", "ask-options task complete c3a",
  T("tick off the poster one", ask("poster_pdf", "poster_print"),
    ref=[act("complete", kind="task", name="poster"),
         askc("Submit poster PDF to E-MRS or Print the poster?", options="$poster_pdf, $poster_print")]),
  T("the pdf, submitted it an hour ago", diff(upd("poster_pdf", status="completed", completed=ANY)),
    ref=[act("complete", rows="$poster_pdf")]))

S("T13-A005", "ask-options locker_item star never_mind c3a",
  T("star the student membership", ask("rsc", "iom3"),
    ref=[act("star", kind="locker item", name="student membership"),
         askc("The RSC student membership or the IOM3 one?", options="$rsc, $iom3")]),
  T("ah leave it, they both run out in december", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T13-A101", "ask-options person star c3a",
  T("star ngozi for me", ask("aunty_ngozi", "ngozi_e"),
    ref=[act("star", kind="person", name="Ngozi"),
         askc("Ngozi Okonkwo your aunt in London or Ngozi Eze the NigSoc treasurer?", options="$aunty_ngozi, $ngozi_e")]))

S("T13-A006", "follow-up c3a",
  T("what's due this week", rows("loo_roll", "bins", "ts_aug", "xrd_book", "send_mum", "reply_aunty", "xrd_analyse", "rota", "garri", "abstract"),
    ref=[ans(kind="task", when=J(U("week", 0)), where="status = open")]),
  T("which of those take over 20 minutes", rows("xrd_analyse", "garri", "abstract"),
    ref=[ans(within="@prev", where="effort > 20")]),
  T("which is the longest", rows("xrd_analyse"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]))

S("T13-A007", "follow-up c3a",
  T("who owes me", rows("d_kasia", "d_chinedu", "d_tom_b", "d_nkechi", "d_tom_h", "d_tunde", "d_fatima"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 20", rows("d_nkechi", "d_kasia", "d_tunde", "d_chinedu"),
    ref=[ans(within="@prev", where="amount > 20 GBP")]),
  T("and everything else", rows("d_tom_h", "d_tom_b", "d_fatima"),
    ref=[ans(within="@1", exclude="@2")]))

S("T13-A008", "follow-up c3a",
  T("show me next week", rows("mumcall_0913", "gym", "walk", "badminton_0911", "helen_0909", "jc_0909", "committee", "landlord", "group_0907", "xrd_0908"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the ones on wednesday", rows("helen_0909", "jc_0909"),
    ref=[ans(within="@prev", when=J(U("week", 1, weekday=3)))]),
  T("what about the other days", rows("mumcall_0913", "gym", "walk", "badminton_0911", "landlord", "group_0907", "committee", "xrd_0908"),
    ref=[ans(within="@1", exclude="@2")]))

S("T13-A009", "follow-up c3a",
  T("what's left on the lab list", rows("glovebox", "xrd_book_lukas", "precursors", "jc_slides", "xrd_book", "xrd_analyse"),
    ref=[ans(kind="task", linked_to="$lab_l", where="status = open")]),
  T("which of those are priority 1", rows("precursors"),
    ref=[ans(within="@prev", where="priority = 1")]))
