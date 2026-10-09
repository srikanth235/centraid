from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
NEXT_WEEKEND = span(U("week", 1, weekday=6), U("week", 1, weekday=7))
X("T28-129",
  T("can you look up cheap flights to brisbane for march", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok add a task, check flight prices for brisbane, due monday",
    diff(new("task", name=has("brisbane"), date="2026-02-23")),
    ref=[act("create", args=lines(kind="task", name="Check flight prices for Brisbane", date=U("week", 1, weekday=1)))]))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
FROM_TODAY = {"from": U("day", 0)}
reunion_notes = find(kind="note", linked_to="$reunion_nb", order="date desc", limit=2)
kapa_three = find(kind="event", name="Kapa haka practice", when=FROM_TODAY, order="date asc", limit=3)

S("T28-128-P", "unbounded destruction not found trashed para",
  T("i want a fresh start, so wipe all my events", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fine, only the tyre change, remove it", decline("not_found"),
    ref=[act("delete", kind="event", name="Tyre change"), dec("not_found")]))

S("T28-133-P", "limit then min within max owe me debt sum owed to me para",
  T("among my next four calendar items, the shortest", val(30),
    ref=[find(kind="event", when=FROM_TODAY, order="date asc", limit=4),
         comp(op="min", field="duration", within="@prev"),
         ans(value="@prev")]),
  T("largest amount i owe to anyone", val((300, "NZD")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]),
  T("i want the full pile, so what do people owe me altogether, mere's power bill and rawiri's flights and the rest", val((785, "NZD")),
    ref=[comp(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]))

S("T28-137-P", "unbounded documents refused delete group ask never mind unbounded tasks para",
  T("i'll scan what matters again, so wipe every folder and document", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("we're done with the kapa haka koha group, get rid of it", ask(),
    ref=[bad(act("delete", rows="$kapa_g")),
         askc("it still has the uniform dry cleaning in it so the vault won't delete it. settle up with hine first?")]),
  T("leave it, the dry cleaning still needs settling between us until after regionals", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("after the reunion we're starting the year fresh, so wipe every task on every list", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))
