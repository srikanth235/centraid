from gold import *
import json

world("T27", "2026-12-03T04:50", "Sophie Dubois", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


FROM_TODAY = {"from": U("day", 0)}

# recovery: a find with order and limit sent twice, then answered from its result
recipe_notes = find(kind="note", linked_to="$recipes_nb", order="date desc", limit=2)
S("T27-131", "recovery find order limit note repeat answer min effort sum typo",
  T("the last two notes in my recipes notebook", rows("galette", "praline"),
    ref=[recipe_notes, bad(recipe_notes), ans(within="@prev")]),
  T("i've got fifteen minutes before the bakers arrive, what's the quickest thing still open on the baby list", val(10),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$baby_l", where='status = "open"'),
         ans(value="@prev")]),
  T("total effort still open on the oepning day list", val(300),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$open_l", where='status = "open"'),
         ans(value="@prev")]))

# recovery twice: the hint, then the nudge, then an answer
class_three = find(kind="event", name="Prenatal class", when=FROM_TODAY, order="date asc", limit=3)
S("T27-132", "recovery twice find order limit event answer sum duration max min typo",
  T("next three prenatal classes", rows("class_1208", "class_1215", "class_1222"),
    ref=[class_three, bad(class_three), bad(class_three), ans(within="@prev")]),
  T("how many minutes of prenatl class do i still have between now and the end of december, all of it added together", val(360),
    ref=[comp(op="sum", field="duration", kind="event", name="Prenatal class",
              when=span(U("day", 0), U("month", 0))),
         ans(value="@prev")]),
  T("what's the longest thing on my calendar in january, i want to protect that whole afternoon", val(240),
    ref=[comp(op="max", field="duration", kind="event", when=U("month", 1, name=1)),
         ans(value="@prev")]),
  T("quikest thing left on the suppliers list", val(10),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$sup_l", where='status = open'),
         ans(value="@prev")]))

S("T27-133", "limit then min within max debt i owe sum owed by me",
  T("shortest one among my next four events", val(30),
    ref=[find(kind="event", when=FROM_TODAY, order="date asc", limit=4),
         comp(op="min", field="duration", within="@prev"),
         ans(value="@prev")]),
  T("biggeset thing i owe anybody", val((1500, "EUR")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]),
  T("how much do i owe in total, all the small ones and antoine's mixer money, so i know what to keep aside", val((1930, "EUR")),
    ref=[comp(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]))

S("T27-134", "ask options cross-kind delete never mind max debt limit min within",
  T("delete the lease", ask("lease", "lease_points"),
    ref=[askc("the shop lease document or the lease points note?", options="$lease, $lease_points")]),
  T("actually no, hold on, karim might still want to see both before the opening so i'll leave them where they are", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the biggest thing anyone owes me right now, i want to know who to text first", val((45, "EUR")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]),
  T("of the three biggest things i owe the smallest", val((120, "EUR")),
    ref=[find(kind="debt", where='direction = "i_owe" and status = "open"', order="amount desc", limit=3),
         comp(op="min", field="amount", within="@prev"),
         ans(value="@prev")]))

S("T27-135", "sum lent since december max home task min next week limit three events",
  T("how much have i lent out since the first of december, mostly small stuff to the team", val((57, "EUR")),
    ref=[comp(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"',
              when={"from": D("2026-12-01")}),
         ans(value="@prev")]),
  T("longest tsak on the home list", val(60),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$home_l", where='status = "open"'),
         ans(value="@prev")]),
  T("of everything due next week what's the quickest one, i want to knock it out before the opening", val(15),
    ref=[comp(op="min", field="effort", kind="task", when=U("week", 1), where='status = open'),
         ans(value="@prev")]),
  T("the longest of my next three events, typing on the metro", val(60),
    ref=[find(kind="event", when=FROM_TODAY, order="date asc", limit=3),
         comp(op="max", field="duration", within="@prev"),
         ans(value="@prev")]))

S("T27-136", "ask options event reschedule never mind limit sum min december",
  T("push the oven thing to friday", ask("oven_install", "oven_check"),
    ref=[act("reschedule", kind="event", name="Oven", args=lines(to=U("week", 0, weekday=5))),
         askc("the oven installation from november or the oven inspection on the 8th?", options="$oven_install, $oven_check")]),
  T("scrap that, olivier said he'll come by on monday anyway so i'm not going to move anything around", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("add up the three smallest amounts anyone owes me", val((47, "EUR")),
    ref=[find(kind="debt", where='direction = "owes_me" and status = "open"', order="amount asc", limit=3),
         comp(op="sum", field="amount", within="@prev"),
         ans(value="@prev")]),
  T("what's the shortest thing on the calendar in december, cancelled ones don't count", val(30),
    ref=[comp(op="min", field="duration", kind="event", when=U("month", 0), where='status != "cancelled"'),
         ans(value="@prev")]))

S("T27-137", "unbounded locker refused delete group ask never mind unbounded calendar",
  T("wipe the whole lokcer, every login and card, i'll rebuild it from scratch", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete the flat group, we're not splitting stuff anymore", ask(),
    ref=[bad(act("delete", rows="$flat_g")),
         askc("it still has the groceries and the crib in it so the vault won't delete it. settle up with julien first?")]),
  T("no leave it, we still split the groceries and the crib until after the baby comes", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("delete everything on the calendar, every single event, i'm starting from scratch after the birth", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T27-138", "limit person last contacted unbounded albums min cadence max in progress",
  T("last two people i spoek to", rows("julien", "camille_r"),
    ref=[ans(kind="person", order="date desc", limit=2)]),
  T("delete all my albums and every photo in them, the phone is full and i'm done", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fewest days between check-ins i set for anyone, cadnce wise", val(7),
    ref=[ans(op="min", field="cadence", kind="person")]),
  T("biggest effort among my in progress stuff, i need to know if i can finish it before the baby comes", val(300),
    ref=[comp(op="max", field="effort", kind="task", where='status = "in_progress"'),
         ans(value="@prev")]))

S("T27-140", "limit pregnancy note unbounded everything sum test bakes max november",
  T("my latset note in the pregnancy notebook", rows("kicks"),
    ref=[ans(kind="note", linked_to="$preg_nb", order="date desc", limit=1)]),
  T("delte every event and task and note i have, the new year starts blank", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("how many minutes of tset bakes did nadia have in november, not counting the cancelled one", val(960),
    ref=[comp(op="sum", field="duration", kind="event", name="Test bake", when=U("month", 0, name=11), where='status != "cancelled"'),
         ans(value="@prev")]),
  T("and the longest single event that month, not counting cancelled ones", val(240),
    ref=[comp(op="max", field="duration", kind="event", when=U("month", 0, name=11), where='status != "cancelled"'),
         ans(value="@prev")]))
