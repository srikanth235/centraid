from gold import *
import json
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
WEEKEND = {"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}
NEXT_WEEKEND = {"from": U("week", 1, weekday=6), "to": U("week", 1, weekday=7)}
def J(d):
    return json.dumps(d, separators=(",", ":"))
LIVE = 'status = "open"'
OWE = 'direction = "i_owe" and status = "open"'
LIVE_EV = 'status != "cancelled"'
def next_ivan():
    return find(kind="event", name="Ivan's lesson", when=W({"from": U("day", 0)}), order="date asc", limit=1)
def rehearsals():
    return find(kind="event", name="Choir rehearsal", when=W({"from": U("day", 0)}))


S("T17-125-P", "group balance repair ask pick negative positive para",
  T("bathroom works, how does mila stand", val((-300, "BGN")),
    ref=[ans(op="balance", kind="group", name="Bathroom works", linked_to="$mila")]),
  T("studio rent, vesi's position", val((150, "BGN")),
    ref=[search("vesi", kind="person"), ans(op="balance", kind="group", name="Studio rent", linked_to="$vesi")]),
  T("koleva, what does she owe me", ask("maria_k", "desi"),
    ref=[bad(ans(op="balance", kind="person", name="Koleva")),
         askc("maria koleva or desislava koleva?", options="$maria_k, $desi")]),
  T("student one", val((100, "BGN")),
    ref=[ans(op="balance", rows="$maria_k")]),
  T("give her a star", diff(upd("maria_k", starred=True)),
    ref=[act("star", rows="$maria_k")]))

S("T17-131-P", "recovery next ivan lesson then choir list min max sum para",
  T("ivan's next lesson date? preparing scales for him", rows("ivan_0202"),
    ref=[next_ivan(), bad(next_ivan()), ans(within="@prev")]),
  T("i've got ten minutes before my next student, so which choir list job takes the least time", val(15),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$choir_l", where=LIVE)]),
  T("longest, i bet the alto line for the rach", val(30),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$choir_l", where=LIVE)]),
  T("choir list in total time altogethr, to know before planning the weekend", val(65),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$choir_l", where=LIVE), ans(value="@prev")]))

S("T17-136-P", "ask delete choir concert never mind then recent contacts then longest this week para",
  T("get rid of the choir concert", ask("concert_dec", "concert_mar"),
    ref=[act("delete", kind="event", name="Choir concert"),
         find(kind="event", name="Choir concert"),
         askc("the december one or the one in march?", options="$concert_dec, $concert_mar")]),
  T("changed my mind, both stay, petar has to have the december one for the recording archive", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("last three people i talked to", rows("petar", "viktor", "vesi", order=True),
    ref=[ans(kind="person", order="date desc", limit=3)]),
  T("longest event this week not cancelled", val(120),
    ref=[ans(op="max", field="duration", kind="event", when=W(U("week", 0)), where=LIVE_EV)]))

S("T17-201-P", "both dentists reschedule prev read para",
  T("dentist appointment dates?", rows("dentist_v", "dentist_me"),
    ref=[find(kind="event", name="dentist", when=W({"from": U("day", 0)})), ans(rows="@prev")]),
  T("both a day later", diff(upd("dentist_v", date="2026-02-05T15:00"), upd("dentist_me", date="2026-02-11T09:00")),
    ref=[act("reschedule", rows="@1", args=lines(to=U("day", 1, anchor="row")))]),
  T("next basketball for viktor, when", rows("basket_feb"),
    ref=[ans(kind="event", name="Viktor's basketball game", when=W({"from": U("day", 0)}))]))
