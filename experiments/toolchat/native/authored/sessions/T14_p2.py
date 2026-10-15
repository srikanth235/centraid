from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
LIVE = 'status = "open"'
LIVE_EV = 'status != "cancelled"'
def next_kleber():
    return find(kind="event", name="DJ set at Bar do Kleber", when=W({"from": U("day", 0)}), order="date asc", limit=1)
def rehearsals():
    return find(kind="event", name="Collective rehearsal", when=W({"from": U("day", 0)}))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
NEXT_WEEKEND = span(U("week", 1, weekday=6), U("week", 1, weekday=7))
def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T14-129-P", "out of scope create undo never mind para",
  T("ideal bpm to warm up a set?", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("task due tomorrow: listen to the sample pack",
    diff(new("task", name=has("sample"), date="2026-10-25")),
    ref=[act("create", args=lines(kind="task", name="Listen to the sample pack", date=U("day", 1)))]),
  T("forget that one, undo it", diff(trash("+1")),
    ref=[act("undo")]))

S("T14-140-P", "newest docs limit then unbounded tasks then ask log marcos never mind then carro sum para",
  T("newest two docments", rows("fuel_rcpt", "rider", order=True),
    ref=[ans(kind="document", order="date desc", limit=2)]),
  T("delete all tasks, new start once the baile tonigt is over", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("i called marcos, log it", ask("marcos_o", "marcos_t"),
    ref=[act("log", kind="person", name="Marcos", args=lines(kind="call")),
         askc("marcos oliveira the dj or marcos tavares the mechanic?", options="$marcos_o, $marcos_t")]),
  T("wait, i'll find out which marcos first, nothing gets logged yet", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("carro list total time?", val(225),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$carro_l", where=LIVE)]))
