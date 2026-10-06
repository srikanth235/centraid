from gold import *

world("T01", "2026-03-12T18:20", "Oluwaseun Adebayo-Clarke", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T01-A001", "ask-options task complete c3a",
  T("tick off the insurance one", ask("car_ins", "travel_ins"),
    ref=[act("complete", kind="task", name="insurance"),
         askc("Renew car insurance or Sort Lisbon travel insurance?", options="$car_ins, $travel_ins")]),
  T("car, i rang them this morning", diff(upd("car_ins", status="completed", completed=ANY)),
    ref=[act("complete", rows="$car_ins")]))

S("T01-A002", "ask-options event reschedule never_mind c3a",
  T("can you move the visit to monday", ask("plumber_visit", "worktop_visit"),
    ref=[act("reschedule", kind="event", name="visit", args=lines(to=U("week", 1, weekday=1))),
         askc("The plumber quote visit on the 13th or the worktop template visit on the 14th?", options="$plumber_visit, $worktop_visit")]),
  T("actually leave it, i'll sort it with them", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T01-A004", "ask-options debt settle_debt c3a",
  T("mark the share as paid", ask("d_gemma_tickets", "d_kunle"),
    ref=[act("settle_debt", kind="debt", name="share"),
         askc("Gemma's Beyonce ticket share (35) or Kunle's cake share (60)?", options="$d_gemma_tickets, $d_kunle")]),
  T("gemma's, she sent it just now", diff(upd("d_gemma_tickets", status="settled")),
    ref=[act("settle_debt", rows="$d_gemma_tickets")]))

S("T01-A005", "ask-options note delete never_mind c3a",
  T("delete the diary entry", ask("diary_rough", "diary_good"),
    ref=[act("delete", kind="note", name="diary entry"),
         askc("The rough night one or the good day one?", options="$diary_rough, $diary_good")]),
  T("no wait, keep them both", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T01-A101", "ask-options task complete c3a",
  T("tick off the card one", ask("card_mum", "thank_you"),
    ref=[act("complete", kind="task", name="card"),
         askc("Get Mothering Sunday card for Mum or Thank-you card for Sophie?", options="$card_mum, $thank_you")]))

S("T01-A006", "follow-up c3a",
  T("what have i got this week", rows("training_0311", "worktop_visit", "match_0315", "ld_0309", "mothering", "ld_0310", "swim_0314", "fiveaside_0310", "plumber_visit"),
    ref=[ans(kind="event", when=J(U("week", 0)))]),
  T("which of those are before friday", rows("ld_0309", "training_0311", "fiveaside_0310", "ld_0310"),
    ref=[ans(within="@prev", when=J({"to": U("week", 0, weekday=4)}))]),
  T("what about the others", rows("worktop_visit", "mothering", "swim_0314", "plumber_visit", "match_0315"),
    ref=[ans(within="@1", exclude="@2")]))

S("T01-A007", "follow-up c3a",
  T("what's owed to me", rows("d_kunle", "d_priya_lunch", "d_gemma_tickets", "d_jess_w", "d_callum"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 30", rows("d_kunle", "d_gemma_tickets", "d_callum"),
    ref=[ans(within="@prev", where="amount > 30 GBP")]),
  T("the rest then", rows("d_priya_lunch", "d_jess_w"),
    ref=[ans(within="@1", exclude="@2")]))

S("T01-A008", "follow-up c3a",
  T("what's in the school folder", rows("farm_letter", "tobi_report", "term_dates", "ada_report"),
    ref=[ans(kind="document", linked_to="$school_f")]),
  T("any of them starred", rows("term_dates"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T01-A009", "follow-up c3a",
  T("show me the kids album", rows("p_bday_cake", "p_goal", "p_snow", "p_park", "p_school_gate", "p_nativity", "p_tooth", "p_swim_gala", "p_book_day", "p_team"),
    ref=[ans(kind="photo", linked_to="$kids_album")]),
  T("which have a star", rows("p_nativity", "p_goal"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("what about the rest", rows("p_bday_cake", "p_snow", "p_park", "p_school_gate", "p_swim_gala", "p_book_day", "p_tooth", "p_team"),
    ref=[ans(within="@1", exclude="@2")]))
