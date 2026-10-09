from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T02-122-P", "ask options sophie debt settle then contrast tom balance para",
  T("sophie's debt needs settling", ask("sophie_t", "sophie_d"),
    ref=[askc("sophie tran or sophie delacroix?", options="$sophie_t, $sophie_d")]),
  T("tran's, for the taxi", diff(upd("d_sophie_taxi", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$sophie_t")]),
  T("the tomo logo kill fee came in from tom", diff(upd("d_tomo", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Tomo logo kill fee")]),
  T("tom's balance with me now?", val((0, "CAD")),
    ref=[ans(op="balance", kind="person", name="Tom Nguyen")]))

S("T02-128-P", "decline unbounded twice then bounded delete cv para",
  T("clear everything out of my calendar, fresh start", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fine, then every document gets wiped", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("just the cv then", diff(trash("cv")),
    ref=[act("delete", kind="document", name="CV 2027")]),
  T("document count now?", val(17),
    ref=[ans(op="count", kind="document")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OWE = 'direction = "i_owe" and status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

LIVE = 'status = "open"'

def next_dimsum():
    return find(kind="event", name="Dim sum", when=W({"from": U("day", 0)}), order="date asc", limit=1)

def pottery_left():
    return find(kind="event", name="Pottery class", when=W({"from": U("day", 0)}))

S("T02-133-P", "recovery next dim sum, week min max sum durations para",
  T("mom keeps asking, when's the next dim sum", rows("dimsum_jun"),
    ref=[next_dimsum(), bad(next_dimsum()), ans(within="@prev")]),
  T("i need a gap for a call, so what's my briefest event this week", val(45),
    ref=[comp(op="min", field="duration", kind="event", when=W(U("week", 0))), ans(value="@prev")]),
  T("longest event then, the evening-swallower", val(180),
    ref=[comp(op="max", field="duration", kind="event", when=W(U("week", 0))), ans(value="@prev")]),
  T("how many minutes is this week booked for so far, i need to see whether a client call fits", val(825),
    ref=[comp(op="sum", field="duration", kind="event", when=W(U("week", 0))), ans(value="@prev")]))

S("T02-138-P", "contract ask never-mind, latest note, next week sum para",
  T("contract can go, wipe it", ask("gl_contract", "mf_contract"),
    ref=[act("delete", kind="document", name="contract"),
         askc("Greenleaf mural contract or Maple & Fern contract?", options="$gl_contract, $mf_contract")]),
  T("keep both, they need to be handy for the tax return", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("most recent note, probably the quick idea i wrote at midnight", rows("idea_crow"),
    ref=[ans(kind="note", order="date desc", limit=1)]),
  T("next week's booked minutes so far", val(1170),
    ref=[comp(op="sum", field="duration", kind="event", when=W(U("week", 1))), ans(value="@prev")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T02-201-P", "both all-three followup reschedule unstar para",
  T("unsent invoices?", rows("inv_mf", "inv_tide_cover", "inv_gl_final"),
    ref=[ans(kind="task", name="invoice", where="status = open")]),
  T("all three move to friday next week", diff(upd("inv_mf", date="2027-06-18"), upd("inv_tide_cover", date="2027-06-18"),
                                          upd("inv_gl_final", date="2027-06-18")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=5)))]),
  T("docs with stars", rows("portfolio_pdf", "gl_contract", "itinerary"),
    ref=[ans(kind="document", where="starred = yes")]),
  T("remove every star from them", diff(upd("portfolio_pdf", starred=False), upd("gl_contract", starred=False),
                            upd("itinerary", starred=False)),
    ref=[act("unstar", rows="@prev")]))
