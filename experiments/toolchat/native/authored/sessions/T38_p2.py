from gold import *

import json

def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T38-103-P", "container-link-reads person events through the person link week substitution count para",
  T("dana's remaining plans this week", rows("dsw_270511", "fl_270514"),
    ref=[ans(kind="event", linked_to="$dana", where="status != cancelled", when=J(U("week", 0)))]),
  T("next week's?", rows("dsw_270518", "fl_270521"),
    ref=[ans(kind="event", linked_to="$dana", where="status != cancelled", when=J(U("week", 1)))]),
  T("her swim class count this month", val(4),
    ref=[ans(op="count", kind="event", name="swim class", linked_to="$dana", when=J(U("month", 0)))]))

S("T38-107-P", "stray-conditions member-count purpose-clause met-contains within role-contains para",
  T("building fund headcount, i'm splitting the lift repair between them", val(13),
    ref=[ans(op="count", kind="person", linked_to="$building")]),
  T("graduation invites, so who did i meet at the university",
    rows("raji_anabtawi", "basma_al_najjar", "sufyan_nimri", "dania_nabulsi", "talal_daoud", "dunia_bishara", "usama_yaghmour",
         "enas_qasem", "waleed_masri", "fadwa_obeidat", "husam"),
    ref=[ans(kind="person", where='met contains "university"')]),
  T("classmates among them?", rows("raji_anabtawi", "dania_nabulsi", "usama_yaghmour", "fadwa_obeidat"),
    ref=[ans(within="@prev", where='role contains "classmate"')]))

S("T38-111-P", "date-window before-weekday closed-from-today future then past-tense open count cancelled calls para",
  T("my events before sunday", rows("ct_270513", "fl_270514"),
    ref=[bad(ans(kind="event", when=J({"from": U("day", 0), "to": {"weekday": 6}}))),
         ans(kind="event", when=J(span(U("day", 0), U("week", 0, weekday=6))))]),
  T("calls to teta cancelled before march, count", val(9),
    ref=[ans(op="count", kind="event", name="Call Teta", where="status = cancelled",
             when=J({"to": U("month", 0, name=2)}))]))

S("T38-115-P", "date-window time-of-day pick of a shown list no-when sunday last-saturday later-one para",
  T("sunday's events", rows("csm_270516", "eid_a27"),
    ref=[ans(kind="event", when=J(U("week", 0, weekday=7)))]),
  T("morning one among them?", rows("csm_270516"),
    ref=[ans(rows="$csm_270516")]),
  T("last saturday's events?", rows("yf_270508", "fdr_270508"),
    ref=[ans(kind="event", when=J(U("week", -1, weekday=6)))]),
  T("the later of the two?", rows("fdr_270508"),
    ref=[ans(rows="$fdr_270508")]))

S("T38-119-P", "mixed kind-word-decides notes documents same-topic school then latest within para",
  T("school notes?", rows("sch_1", "sch_2", "sch_3", "sch_4", "sch_5"),
    ref=[ans(kind="note", name="school")]),
  T("documents too?", rows("doc_014", "doc_044", "doc_074"),
    ref=[ans(kind="document", name="school")]),
  T("most recent of those?", rows("doc_074"),
    ref=[ans(within="@prev", order="date desc", limit=1)]))
