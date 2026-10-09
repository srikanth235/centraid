from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

NOW = W({"from": U("day", 0)})

S("T04-127-P", "repair effort unit count then ask guest list note document para",
  T("number of tasks taking over an hour", val(8),
    ref=[bad(ans(op="count", kind="task", where="effort > 1 hour")),
         ans(op="count", kind="task", where="effort > 60")]),
  T("guest list can go, wipe it", ask("guest_list", "guest_sheet"),
    ref=[search("guest list"),
         askc("the guest list note or the guest list spreadsheet?", options="$guest_list, $guest_sheet")]),
  T("the spreadsheet one, since the note has the aunties on it", diff(trash("guest_sheet")),
    ref=[act("delete", rows="$guest_sheet")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OWE = 'direction = "i_owe" and status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

LIVE = 'status = "open"'

def fb_shifts():
    return find(kind="event", name="Food bank shift", when=W({"from": U("day", 0)}))

def wed_open():
    return find(kind="task", linked_to="$wedlist", where=LIVE)

S("T04-133-P", "fitting ask never-mind, debts min max para",
  T("fitting needs cancelling", ask("fitting_1", "fitting_2", "mehndi_fit"),
    ref=[act("cancel", kind="event", name="fitting"),
         find(kind="event", name="fitting", when=W({"from": U("day", 0)})),
         askc("The dress fitting on the 17th, the one on the 14th of november, or the mehndi outfit one?", options="@prev")]),
  T("forget it, zainab has already messaged saying she's rearranging them all anyway", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("i want to pay off my smallest debt tonight, which is it", val((9, "GBP")),
    ref=[comp(op="min", field="amount", kind="debt", where=OWE), ans(value="@prev")]),
  T("biggest one i owe then, presumably my dad's car deposit help still", val((500, "GBP")),
    ref=[comp(op="max", field="amount", kind="debt", where=OWE), ans(value="@prev")]))

S("T04-138-P", "shortest of next three, wipe everything, longest next week, food bank list sum para",
  T("shortest among the next three calendar items", val(60),
    ref=[find(kind="event", when=W({"from": U("day", 0)}), order="date asc", limit=3),
         comp(op="min", field="duration", within="@prev"), ans(value="@prev")]),
  T("wipe the lot, every task, note, document and photo, i'm done with it all", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("next week's longest single item, probably the night shifts", val(750),
    ref=[comp(op="max", field="duration", kind="event", when=W(U("week", 1))), ans(value="@prev")]),
  T("total time needed for the food bank jobs", val(150),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$fblist", where=LIVE), ans(value="@prev")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T04-202-P", "ordinal date-pick ask-option third cancel reschedule para",
  T("remaining food bank shifts in this month", rows("fb_1017", "fb_1024", "fb_1031"),
    ref=[ans(kind="event", name="food bank shift", when=W({"from": U("day", 0), "to": U("month", 0)}))]),
  T("i'm away on the twenty-fourth, so cancel that one", diff(upd("fb_1024", status="cancelled")),
    ref=[act("cancel", rows="$fb_1024")]),
  T("darkroom night should start an hour later", ask("dark_1015", "dark_1029", "dark_1112"),
    ref=[find(kind="event", name="darkroom night", when=W({"from": U("day", 0)})),
         askc("The 15th, the 29th or 12 November?", options="@prev")]),
  T("number 3 works", diff(upd("dark_1112", date="2026-11-12T19:30")),
    ref=[act("reschedule", rows="$dark_1112", args=lines(to=U("hour", 1, anchor="row")))]))
