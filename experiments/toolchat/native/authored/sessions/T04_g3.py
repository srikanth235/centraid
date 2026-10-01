from gold import *
import json

world("T04", "2026-10-14T19:40", "Aisha Rahman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
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

S("T04-133", "fitting ask never-mind, debts min max",
  T("cancel the fitting", ask("fitting_1", "fitting_2", "mehndi_fit"),
    ref=[act("cancel", kind="event", name="fitting"),
         find(kind="event", name="fitting", when=W({"from": U("day", 0)})),
         askc("The dress fitting on the 17th, the one on the 14th of november, or the mehndi outfit one?", options="@prev")]),
  T("actually don't bother, zainab's already texted to say she's rearranging them all anyway", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("smallest thing i owe anyone, wanna clear it tonigt", val((9, "GBP")),
    ref=[comp(op="min", field="amount", kind="debt", where=OWE), ans(value="@prev")]),
  T("and the biggest, that'll still be my dad's car deposit help i assume, right", val((500, "GBP")),
    ref=[comp(op="max", field="amount", kind="debt", where=OWE), ans(value="@prev")]))

S("T04-134", "top three owed sum, this week durations min max, biggest owed",
  T("add up the three biggest debts owed to me, if they all paid i could book the spa", val((259, "GBP")),
    ref=[find(kind="debt", where=OWED, order="amount desc", limit=3),
         comp(op="sum", field="amount", within="@prev"), ans(value="@prev")]),
  T("what's the shortest thing on this week, need a gap for a call", val(60),
    ref=[comp(op="min", field="duration", kind="event", when=W(U("week", 0))), ans(value="@prev")]),
  T("and the longest, somthing tells me its a long day", val(750),
    ref=[comp(op="max", field="duration", kind="event", when=W(U("week", 0))), ans(value="@prev")]),
  T("what's the most anyone owes me, is it still sana's istanbul flight", val((142, "GBP")),
    ref=[comp(op="max", field="amount", kind="debt", where=OWED), ans(value="@prev")]))

S("T04-135", "wedding prep sum max, darkroom limit, cadence min",
  T("roughly how many minutes of work is left on the wedding prep list, i want to plan my days off", val(225),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$wedlist", where=LIVE), ans(value="@prev")]),
  T("what's the biggest job on it", val(120),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$wedlist", where=LIVE), ans(value="@prev")]),
  T("when are my next two darkrom nights", rows("dark_1015", "dark_1029"),
    ref=[ans(kind="event", name="Darkroom night", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("what's the shortest catch up gap i've set for anyone, its zainab i think, evry three days", val(3),
    ref=[comp(op="min", field="cadence", kind="person"), ans(value="@prev")]))

S("T04-136", "contract ask never-mind, latest note, food bank hours",
  T("delete the contrct", ask("venue_contract", "contract"),
    ref=[act("delete", kind="document", name="contract"),
         askc("Oakwood Hall contract or FY2 employment contract?", options="$venue_contract, $contract")]),
  T("sorry no, i still need both of them for the tax stuff and the venue payment, leave it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("whats the latest note i've written, i think it was something about hampers", rows("fb_hampers"),
    ref=[ans(kind="note", order="date desc", limit=1)]),
  T("how many minutes of food bank shifts have i got left this month", val(540),
    ref=[comp(op="sum", field="duration", kind="event", name="Food bank shift",
              when=W({"from": U("day", 0), "to": U("month", 0)})), ans(value="@prev")]))

S("T04-137", "wipe notebooks, next work admin max, wipe calendar, old owed min",
  T("delete everyting in my notebooks, i've decided i'm going to start fresh", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("of the next three jobs due on work admin, which one needs the longest", rows("als_prep"),
    ref=[find(kind="task", linked_to="$worklist", where=LIVE, order="date asc", limit=3),
         ans(within="@prev", order="effort desc", limit=1)]),
  T("wipe my whole calendar", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("smallest amount anyone owes me from before this month, is it wourth chasing", val((12.8, "GBP")),
    ref=[comp(op="min", field="amount", kind="debt", when=W({"to": U("month", -1)}), where=OWED),
         ans(value="@prev")]))

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

S("T04-139", "last december, akhtar ask never-mind, owed sum",
  T("what's the very last thing on my calendar in december", rows("walima"),
    ref=[ans(kind="event", when=W(U("month", 0, name=12)), order="date desc", limit=1)]),
  T("log a call with akhtar", ask("nasreen", "bilal", "sana"),
    ref=[act("log", kind="person", name="Akhtar", args="kind: call"),
         askc("Nasreen, Bilal or Sana?", options="$nasreen, $bilal, $sana")]),
  T("hold on, it went to voicemail so leave it, i dont wnat to mess up the cadence", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how much am i owed in total, everyone counted apart from sana who's not paying till february", val((164.3, "GBP")),
    ref=[find(kind="debt", where=OWED),
         comp(op="sum", field="amount", within="@prev", exclude="$d_sana"), ans(value="@prev")]))

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


S("T04-141", "recovery twice wedding prep, total owed sum, food bank list min max",
  T("what are the next three wedding prep jobs due, mum's asking what's left", rows("rsvps", "favours", "seating"),
    ref=[wed_open(), bad(wed_open()), bad(wed_open()),
         ans(within="@prev", order="date asc", limit=3)]),
  T("how much do i owe in total, i need the number for my budget spredsheet", val((584, "GBP")),
    ref=[comp(op="sum", field="amount", kind="debt", where=OWE), ans(value="@prev")]),
  T("what's the shortest job on the food bank list", val(60),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$fblist", where=LIVE), ans(value="@prev")]),
  T("and the longest one on there, the one i'll have to give up a whole saturday morning for", val(90),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$fblist", where=LIVE), ans(value="@prev")]))
