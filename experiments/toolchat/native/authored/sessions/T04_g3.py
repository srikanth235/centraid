from gold import *
import json

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


LIVE = 'status = "open"'


def fb_shifts():
    return find(kind="event", name="Food bank shift", when=W({"from": U("day", 0)}))


S("T04-132", "recovery food bank shifts, work admin min max sum",
  T("next couple of food bank shifts, pete wants to know which wekend i'm free", rows("fb_1017", "fb_1024"),
    ref=[fb_shifts(), bad(fb_shifts()), ans(within="@prev", order="date asc", limit=2)]),
  T("what's the quickest thing on work admin i could do on a break between patients", val(60),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$worklist", where=LIVE), ans(value="@prev")]),
  T("and which one's the biggest, i'm guessing the sepsis audit is the worst of them", rows("als_prep"),
    ref=[ans(kind="task", linked_to="$worklist", where=LIVE, order="effort desc", limit=1)]),
  T("how many minutes is all that adding up to, i need to know if i can do it on nigts", val(300),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$worklist", where=LIVE), ans(value="@prev")]))

S("T04-135", "wedding prep sum max, darkroom limit, cadence min",
  T("roughly how many minutes of work is left on the wedding prep list, i want to plan my days off", val(225),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$wedlist", where=LIVE), ans(value="@prev")]),
  T("what's the biggest job on it", val(120),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$wedlist", where=LIVE), ans(value="@prev")]),
  T("when are my next two darkrom nights", rows("dark_1015", "dark_1029"),
    ref=[ans(kind="event", name="Darkroom night", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("what's the shortest catch up gap i've set for anyone, its zainab i think, evry three days", val(3),
    ref=[comp(op="min", field="cadence", kind="person"), ans(value="@prev")]))

S("T04-138", "shortest of next three, wipe everything, longest next week, food bank list sum",
  T("whats the shortest of my next three things on the calendr", val(60),
    ref=[find(kind="event", when=W({"from": U("day", 0)}), order="date asc", limit=3),
         comp(op="min", field="duration", within="@prev"), ans(value="@prev")]),
  T("i'm done with all of it so wipe every task, note, document and photo i've got, the lot", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("what's the longest single thing i've got on next week, i think it's the night shifts", val(750),
    ref=[comp(op="max", field="duration", kind="event", when=W(U("week", 1))), ans(value="@prev")]),
  T("how long will all the food bank jobs take altogether", val(150),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$fblist", where=LIVE), ans(value="@prev")]))

S("T04-140", "house jobs shortest of three, istanbul limit, food bank cancel never-mind, wipe photos",
  T("whic two things are due first on the istanbul list", rows("sashes", "airport_parking"),
    ref=[ans(kind="task", linked_to="$istlist", where=LIVE, order="date asc", limit=2)]),
  T("cancel the food bank shift", ask("fb_1017", "fb_1024", "fb_1031", "fb_1107", "fb_1114", "fb_1128"),
    ref=[act("cancel", kind="event", name="Food bank shift"),
         find(kind="event", name="Food bank shift", when=W({"from": U("day", 0)})),
         askc("Which Saturday, the 17th, 24th, 31st, 7th, 14th or 28th?", options="@prev")]),
  T("wait, pete just messaged that they're short on volunteers, so i'll keep them all", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("delete all the photos and albums, all of them, its all on the cloud alredy", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))


def wed_open():
    return find(kind="task", linked_to="$wedlist", where=LIVE)

