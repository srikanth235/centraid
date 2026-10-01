from gold import *
import json

world("T24", "2026-09-18T15:05", "Carlos Mendoza", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


FROM_TODAY = {"from": U("day", 0)}
WEEKEND = {"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}

# recovery: a find with order and limit, sent twice, answered from its result
notes_two = find(kind="note", linked_to="$coach_nb", order="date desc", limit=2)
S("T24-131", "recovery find order limit note repeat answer min effort sum typo",
  T("last two things i wrote in the coaching notebook", rows("ft_note", "drills"),
    ref=[notes_two, bad(notes_two), ans(within="@prev")]),
  T("i've got twenty minutes before practice, what's the quickest open task on the home list", val(5),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$home_l", where='status = "open"'),
         ans(value="@prev")]),
  T("total effort still open on the basketbal list", val(225),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$team_l", where='status = open'),
         ans(value="@prev")]))

# recovery twice: the hint, then the nudge, then an answer
gym_three = find(kind="event", name="Open gym", when=FROM_TODAY, order="date asc", limit=3)
S("T24-132", "recovery twice find order limit event answer sum duration min typo",
  T("next three open gym sessions", rows("gym_0922", "gym_0924", "gym_0929"),
    ref=[gym_three, bad(gym_three), bad(gym_three), ans(within="@prev")]),
  T("how many minutes of varsity conditioning did we put in this weeek, both mornings added up", val(120),
    ref=[comp(op="sum", field="duration", kind="event", name="Varsity conditioning", when=U("week", 0)),
         ans(value="@prev")]),
  T("what's the longest event i've got in october, the whole day type of thing", val(480),
    ref=[comp(op="max", field="duration", kind="event", when=U("month", 0, name=10)),
         ans(value="@prev")]),
  T("shortest apointment this month", val(30),
    ref=[comp(op="min", field="duration", kind="event", when=U("month", 0)),
         ans(value="@prev")]))

S("T24-133", "limit then min within max effort sum due next week",
  T("what's the shortest of my next three events", val(30),
    ref=[find(kind="event", when=FROM_TODAY, order="date asc", limit=3),
         comp(op="min", field="duration", within="@prev"),
         ans(value="@prev")]),
  T("the biggest effrt on my teaching list", val(90),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$school_l", where='status = "open"'),
         ans(value="@prev")]),
  T("how many minutes of open tasks are due next week, i want to see if i can fit them in", val(540),
    ref=[comp(op="sum", field="effort", kind="task", when=U("week", 1), where='status = open'),
         ans(value="@prev")]))

S("T24-134", "ask options cross-kind cancel never mind max debt limit min within",
  T("cancel the football duty", ask("fb_0911", "fb_0925"),
    ref=[act("cancel", kind="event", name="Football game duty"),
         find(kind="event", name="Football game duty"),
         askc("the one on the 11th or the one on the 25th?", options="$fb_0911, $fb_0925")]),
  T("actually don't bother, i'll just ask linda which night she needs me before i touch anything", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the most anyone owes me right now, i want to know who to chase first", val((320, "USD")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]),
  T("the smallest of my three biggets open debts", val((75, "USD")),
    ref=[find(kind="debt", where='status = "open"', order="amount desc", limit=3),
         comp(op="min", field="amount", within="@prev"),
         ans(value="@prev")]))

S("T24-135", "sum debts since september max task min limit three",
  T("how much have my friends and the team parents run up with me since the first of september", val((535, "USD")),
    ref=[comp(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"',
              when={"from": D("2026-09-01")}),
         ans(value="@prev")]),
  T("longest task on my landscapng list", val(90),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$land_l", where='status = "open"'),
         ans(value="@prev")]),
  T("of everything due next week what's the quickest one, i want to knock it out first", val(5),
    ref=[comp(op="min", field="effort", kind="task", when=U("week", 1), where='status = open'),
         ans(value="@prev")]),
  T("of the two open tasks due first which is the longr one", val(15),
    ref=[find(kind="task", where='status = "open"', order="date asc", limit=2),
         comp(op="max", field="effort", within="@prev"),
         ans(value="@prev")]))

S("T24-136", "ask options event reschedule never mind limit sum min",
  T("push the booster meeting to 7", ask("booster_0915", "booster_1013"),
    ref=[act("reschedule", kind="event", name="Booster club meeting", args=lines(to=U("day", 0, anchor="row", time="19:00"))),
         find(kind="event", name="Booster club meeting"),
         askc("the one on the 15th or the one on october 13th?", options="$booster_0915, $booster_1013")]),
  T("no wait, leave both of them where they are, i'll check with david before i change anything", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("my two biggest open debts added up", val((470, "USD")),
    ref=[find(kind="debt", where='status = "open"', order="amount desc", limit=2),
         comp(op="sum", field="amount", within="@prev"),
         ans(value="@prev")]),
  T("smallest amount i owe anyone at the moment, not counting what's settled", val((18, "USD")),
    ref=[comp(op="min", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]))

S("T24-137", "unbounded locker ask options never mind unbounded calendar",
  T("wipe out all my locker items, i'm sick of remembering passwrods for everything", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete the invoice, it's paid", ask("inv_whit", "inv_soto"),
    ref=[act("delete", kind="document", name="Invoice"),
         askc("invoice whitfield september or invoice soto august?", options="$inv_whit, $inv_soto")]),
  T("on second thought leave the invoices alone, i still need them for taxes at the end of the yaer", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("clear out the whole calendar and start over for fall, all of it", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T24-138", "limit person last contacted unbounded tasks min cadence max effort in progress",
  T("who were the last thre people i talked to", rows("elena", "sofia", "ray"),
    ref=[ans(kind="person", order="date desc", limit=3)]),
  T("get rid of every task, i'm starting fresh next month after the season", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("smallest cadance i keep with anyone", val(7),
    ref=[ans(op="min", field="cadence", kind="person")]),
  T("what's the biggest effort task that's already in progress, i need to know if i can finish it before the weekend", val(180),
    ref=[comp(op="max", field="effort", kind="task", where='status = "in_progress"'),
         ans(value="@prev")]))

S("T24-139", "limit dentist limit photos ask never mind",
  T("my next dentist appointment", rows("dentist_mateo"),
    ref=[ans(kind="event", name="Dentist", when=FROM_TODAY, order="date asc", limit=1)]),
  T("the five newset photos", rows("p_team_huddle", "p_andre", "p_jersey", "p_union", "p_whiteboard"),
    ref=[ans(kind="photo", order="date desc", limit=5)]),
  T("delete the soto estimate", ask("estimate", "soto_note"),
    ref=[askc("the estimate at the soto house on the 20th or the soto estimate note?", options="$estimate, $soto_note")]),
  T("nah forget it, i'll wait to see what javier says on sunday before i delete anything", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T24-140", "limit task next week unbounded debts sum saturday max weekend typo",
  T("the biggest task due next week", val(90),
    ref=[ans(op="max", field="effort", kind="task", when=U("week", 1), where='status = "open"')]),
  T("delete all my dets they're bugging me, wipe every single one", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("add up my saterday, minutes", val(330),
    ref=[comp(op="sum", field="duration", kind="event", when=U("week", 0, weekday=6)),
         ans(value="@prev")]),
  T("and the longest thing this weekend", val(240),
    ref=[comp(op="max", field="duration", kind="event", when=W(WEEKEND)),
         ans(value="@prev")]))
