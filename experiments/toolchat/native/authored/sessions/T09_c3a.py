from gold import *

world("T09", "2026-05-13T08:05", "Hanae Okafor", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T09-A001", "ask-options person star c3a",
  T("mark jordan as a favourite", ask("jordan_l", "jordan_p"),
    ref=[act("star", kind="person", name="Jordan"),
         askc("Jordan Lee the groomsman or Jordan Park from bar prep?", options="$jordan_l, $jordan_p")]),
  T("the groomsman, he's carrying the rings", diff(upd("jordan_l", starred=True)),
    ref=[act("star", rows="$jordan_l")]))

S("T09-A002", "ask-options task complete never_mind c3a",
  T("tick off the factum", ask("factum", "f_cite"),
    ref=[act("complete", kind="task", name="factum"),
         askc("Draft factum for Brightline or Cite-check the factum?", options="$factum, $f_cite")]),
  T("ugh no, not yet. leave them both", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T09-A003", "ask-options event reschedule c3a",
  T("can we do the tasting next friday instead", ask("cake", "menu"),
    ref=[act("reschedule", kind="event", name="tasting", args=lines(to=U("week", 1, weekday=5))),
         askc("The cake tasting on the 23rd or the menu tasting at Petrov Kitchen on 6 June?", options="$cake, $menu")]),
  T("the menu one", diff(upd("menu", date="2026-05-22T17:00")),
    ref=[act("reschedule", rows="$menu", args=lines(to=U("week", 1, weekday=5)))]),
  T("and the finalize one's done, tick it off", diff(upd("guest_list", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="finalize")]))

S("T09-A004", "ask-options event cancel never_mind c3a",
  T("cancel the dress fitting", ask("fitting_1", "fitting_2"),
    ref=[act("cancel", kind="event", name="Dress fitting"),
         find(kind="event", name="Dress fitting", when=J({"from": U("day", 0)})),
         askc("The one on 16 May or the one on 20 June?", options="$fitting_1, $fitting_2")]),
  T("hang on, leave them, i'll call the shop first", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T09-A005", "ask-options debt settle_debt c3a",
  T("mark the share as settled", ask("d_ada", "d_priya_s"),
    ref=[act("settle_debt", kind="debt", name="share"),
         askc("Ada's dress alterations share (she owes you 85) or Priya Sandhu's AGM room share (you owe 22.50)?", options="$d_ada, $d_priya_s")]),
  T("ada's, she etransferred last night", diff(upd("d_ada", status="settled")),
    ref=[act("settle_debt", rows="$d_ada")]))

S("T09-A101", "ask-options task complete c3a",
  T("mark the prep as done", ask("ethics_hypo", "disc_outline"),
    ref=[act("complete", kind="task", name="prep"),
         askc("Prep ethics hypo set or Prep discovery outline?", options="$ethics_hypo, $disc_outline")]))

S("T09-A006", "follow-up c3a",
  T("what's left on the wedding list", rows("invites", "marriage_lic", "thanks_new", "bm_gifts", "vows", "florist_dep", "headcount", "playlist", "guest_list", "first_dance"),
    ref=[ans(kind="task", linked_to="$wed_list", where="status = open")]),
  T("which of those are priority 1", rows("guest_list"),
    ref=[ans(within="@prev", where="priority = 1")]),
  T("and which have no priority at all", rows("playlist", "thanks_new", "bm_gifts", "first_dance"),
    ref=[ans(within="@1", where="priority is empty")]))

S("T09-A007", "follow-up c3a",
  T("show me this week", rows("fitting_1", "yoga", "checkin_0514", "northvale", "spin_0516", "movie", "cb_0514", "team_lunch", "bp_0512", "siobhan_coffee"),
    ref=[ans(kind="event", when=J(U("week", 0)))]),
  T("now only thursday's", rows("checkin_0514", "cb_0514"),
    ref=[ans(within="@prev", when=J(U("week", 0, weekday=4)))]),
  T("and friday?", rows("movie", "team_lunch"),
    ref=[ans(within="@1", when=J(U("week", 0, weekday=5)))]))

S("T09-A008", "follow-up c3a",
  T("who still owes me money", rows("d_ada", "d_priya_r", "d_mom", "d_jordan_l", "d_ada2", "d_kemi", "d_aiden"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("those but not the veil deposit", rows("d_ada", "d_kemi", "d_jordan_l", "d_aiden", "d_priya_r", "d_ada2"),
    ref=[ans(within="@prev", exclude="$d_mom")]),
  T("the biggest of those?", rows("d_ada"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T09-A009", "follow-up c3a",
  T("what's in the wedding folder", rows("photo_contract", "invite_proof", "petrov_quote", "guest_sheet", "arbor_contract"),
    ref=[ans(kind="document", linked_to="$wed_f")]),
  T("which of those are starred", rows("arbor_contract"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it", diff(upd("arbor_contract", starred=False)),
    ref=[act("unstar", rows="@prev")]))
