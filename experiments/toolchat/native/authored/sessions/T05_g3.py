from gold import *
import json

world("T05", "2026-01-20T06:40", "Priya Raman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
LIVE = 'status = "open"'


def next_day_shift():
    return find(kind="event", name="ICU day shift", when=W({"from": U("day", 0)}), order="date asc", limit=1)


def home_open():
    return find(kind="task", linked_to="$homelist", where=LIVE)


S("T05-131", "recovery next day shift, surgery list min max sum",
  T("how long till my next day shift, need to tell the carpool", rows("day_0120"),
    ref=[next_day_shift(), bad(next_day_shift()), ans(within="@prev")]),
  T("what's the quickest thing left on amma's surgery list, i've got five mins before the bus", val(5),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$surgerylist", where=LIVE), ans(value="@prev")]),
  T("and which one's the longest, the one i should block time for on my off day", rows("insurance_claim"),
    ref=[ans(kind="task", linked_to="$surgerylist", where=LIVE, order="effort desc", limit=1)]),
  T("how many minuts is the whole surgery list, roughly, i'll have to squeeze it around the intrested relatives", val(110),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$surgerylist", where=LIVE), ans(value="@prev")]))

S("T05-132", "recovery twice home list, owed sum exclude max, icu min",
  T("what are the first three things due on home, need to do them before my shift", rows("water_can", "gas", "flowers_1"),
    ref=[home_open(), bad(home_open()), bad(home_open()),
         ans(within="@prev", order="date asc", limit=3)]),
  T("how much am i owed in totl, minus the visa fee advance since karthi's paying it tonight", val((2850, "INR")),
    ref=[comp(op="sum", field="amount", kind="debt", where=OWED, exclude="$d_karthik"), ans(value="@prev")]),
  T("and the most anyone owes me, is it still karthi's visa advance", val((3000, "INR")),
    ref=[comp(op="max", field="amount", kind="debt", where=OWED), ans(value="@prev")]),
  T("what's the smallest job on my ICU list that's got a time on it", val(15),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$iculist", where=LIVE), ans(value="@prev")]))

S("T05-133", "return ask never-mind, owed min max",
  T("tick off the return", ask("projector", "kavya_gift"),
    ref=[act("complete", kind="task", name="Return"),
         askc("Return the projector or Return Kavya's book?", options="$projector, $kavya_gift")]),
  T("actually leave it, i haven't given either back yet, vicky's still got the projector", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the smallest amount i owe anybody, i realy want to clear it this week", val((250, "INR")),
    ref=[comp(op="min", field="amount", kind="debt", where=OWE), ans(value="@prev")]),
  T("and the biggest one, i'm guessing that's still the scooty down payment i owe appa", val((15000, "INR")),
    ref=[comp(op="max", field="amount", kind="debt", where=OWE), ans(value="@prev")]))

S("T05-134", "top three owed sum, next week min max",
  T("add up the three biggest amounts i owe, i want to see if my salry covers it", val((17820, "INR")),
    ref=[find(kind="debt", where=OWE, order="amount desc", limit=3),
         comp(op="sum", field="amount", within="@prev"), ans(value="@prev")]),
  T("what's the shortest thing i've got next week, need a slot for a quick call", val(20),
    ref=[comp(op="min", field="duration", kind="event", when=W(U("week", 1))), ans(value="@prev")]),
  T("and the longest, i think it's a shift, exept maybe the cricket day", val(720),
    ref=[comp(op="max", field="duration", kind="event", when=W(U("week", 1))), ans(value="@prev")]))

S("T05-135", "temple list sum max, cricket limit, tightest cadence",
  T("how many minutes of temple commitee work is left, i want to see if i can do it in one go", val(105),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$templelist", where=LIVE), ans(value="@prev")]),
  T("what's the longest single job on it", val(90),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$templelist", where=LIVE), ans(value="@prev")]),
  T("when are the next two cricket nights, i keep mixing up the dates and it's alot of them", rows("cric_0125", "cric_0208"),
    ref=[ans(kind="event", name="Cricket night at Vicky's", when=W({"from": U("day", 0)}), order="date asc", limit=2)]),
  T("what's the shortest catch up gap i've set for anyone, i think its my parents, they're diffrent to the rest", val(1),
    ref=[comp(op="min", field="cadence", kind="person"), ans(value="@prev")]))

S("T05-137", "wipe contacts, next icu jobs max, wipe notes, old owed min",
  T("wipe all my contacts, half of them i've never even spoken to and i want a fresh start", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("of my next three tasks due on the ICU list, which one is the longest", rows("cne_hours"),
    ref=[find(kind="task", linked_to="$iculist", where=LIVE, order="date asc", limit=3),
         ans(within="@prev", order="effort desc", limit=1)]),
  T("delete every note i have, the lot", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("smallest amount owed to me that's older than this month, is it worth the hassle of chasing it", val((700, "INR")),
    ref=[comp(op="min", field="amount", kind="debt", when=W({"to": U("month", -1)}), where=OWED),
         ans(value="@prev")]))

S("T05-139", "last night shift limit, cataract ask never-mind, smallest owed",
  T("which is the last ICU night shift i've got this month", rows("night_0128"),
    ref=[ans(kind="event", name="ICU night shift", when=W(U("month", 0)), order="date desc", limit=1)]),
  T("cancel the cataract", ask("cataract_1", "cataract_2", "cataract_3"),
    ref=[act("cancel", kind="event", name="cataract"),
         find(kind="event", name="cataract", when=W({"from": U("day", 0)})),
         askc("The consultation, the surgery or the follow-up?", options="@prev")]),
  T("sorry, don't touch any of them, amma's just confirmed all three, forget i said anything", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the smallest amount anyone owes me, i can't be bothered chasing peanuts", val((450, "INR")),
    ref=[comp(op="min", field="amount", kind="debt", where=OWED), ans(value="@prev")]))

S("T05-140", "icu list limit, pay ask never-mind, wipe locker",
  T("whic two things on the ICU list are due first", rows("leave", "farhan_card"),
    ref=[ans(kind="task", linked_to="$iculist", where=LIVE, order="date asc", limit=2)]),
  T("tick off pay", ask("eb_jan", "selvi_pay", "tax", "lic_02"),
    ref=[act("complete", kind="task", name="Pay"),
         find(kind="task", name="Pay", where=LIVE),
         askc("EB bill, Selvi's salary, property tax or the LIC premium?", options="@prev")]),
  T("wait, i haven't paid any of them yet, the app's down, so leave it all as it is", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("i want to wipe evrything in the locker, every login, card and pin, i'm switching phones tomorrow", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))
