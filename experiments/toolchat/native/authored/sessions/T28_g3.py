from gold import *
import json

world("T28", "2026-02-21T12:00", "Wiremu Tane", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


FROM_TODAY = {"from": U("day", 0)}

# recovery: a find with order and limit sent twice, then answered from its result
reunion_notes = find(kind="note", linked_to="$reunion_nb", order="date desc", limit=2)
S("T28-131", "recovery find order limit note repeat answer min effort sum typo",
  T("the last two notes in the reunion planning notebook", rows("hangi_plan", "guest_list"),
    ref=[reunion_notes, bad(reunion_notes), ans(within="@prev")]),
  T("i've got fifteen minutes before we head to the lake, what's the quickest thing still open on the mokopuna sport list", val(10),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$sport_l", where='status = "open"'),
         ans(value="@prev")]),
  T("total effort still open on the mrae list", val(255),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$marae_l", where='status = "open"'),
         ans(value="@prev")]))

# recovery twice: the hint, then the nudge, then an answer
kapa_three = find(kind="event", name="Kapa haka practice", when=FROM_TODAY, order="date asc", limit=3)
S("T28-132", "recovery twice find order limit event answer sum duration max min typo",
  T("next three kapa haka practices", rows("kapa_0225", "kapa_0304", "kapa_0311"),
    ref=[kapa_three, bad(kapa_three), bad(kapa_three), ans(within="@prev")]),
  T("how many minutes of kapa haka pratice do we have between now and the end of march, all of it added up", val(600),
    ref=[comp(op="sum", field="duration", kind="event", name="Kapa haka practice",
              when=span(U("day", 0), U("month", 0, name=3))),
         ans(value="@prev")]),
  T("what's the longest thing on my calendar in april, i want to keep that whole day clear", val(720),
    ref=[comp(op="max", field="duration", kind="event", when=U("month", 0, name=4)),
         ans(value="@prev")]),
  T("shortset thing left on the kapa haka list", val(20),
    ref=[comp(op="min", field="effort", kind="task", linked_to="$kapa_l", where='status = open'),
         ans(value="@prev")]))

S("T28-133", "limit then min within max owe me debt sum owed to me",
  T("shortest of the next four things on my calendar", val(30),
    ref=[find(kind="event", when=FROM_TODAY, order="date asc", limit=4),
         comp(op="min", field="duration", within="@prev"),
         ans(value="@prev")]),
  T("bgigest amount i owe anybody", val((300, "NZD")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"'),
         ans(value="@prev")]),
  T("how much do people owe me altogether, mere's power bill and rawiri's flights and the rest, i want to see the full pile", val((785, "NZD")),
    ref=[comp(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]))

S("T28-134", "ask options cross-kind reschedule never mind max debt limit min within",
  T("push ana's netball to monday", ask("netball", "netball_fees"),
    ref=[askc("the netball grading on the 28th or paying ana's netball fees?", options="$netball, $netball_fees")]),
  T("actually hold on, let me ask kiri whether monday even works for the netball before i move anything around", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the biggest amount open between me and anybody, either way, i want to see the big number", val((500, "NZD")),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"'),
         ans(value="@prev")]),
  T("of the three biggest things i owe the smallest", val((80, "NZD")),
    ref=[find(kind="debt", where='direction = "i_owe" and status = "open"', order="amount desc", limit=3),
         comp(op="min", field="amount", within="@prev"),
         ans(value="@prev")]))

S("T28-135", "sum lent since february max home task min next week limit two",
  T("how much have i lent out since the first of february, whānau and marae folk both", val((745, "NZD")),
    ref=[comp(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"',
              when={"from": D("2026-02-01")}),
         ans(value="@prev")]),
  T("longest task on the hoem list", val(90),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$home_l", where='status = "open"'),
         ans(value="@prev")]),
  T("of everything due next week what's the quickest one, i want to knock it out before the weekend is over", val(10),
    ref=[comp(op="min", field="effort", kind="task", when=U("week", 1), where='status = open'),
         ans(value="@prev")]),
  T("of the two open tasks due first which is the longre one", val(60),
    ref=[find(kind="task", where='status = "open"', order="date asc", limit=2),
         comp(op="max", field="effort", within="@prev"),
         ans(value="@prev")]))

S("T28-136", "ask cross-kind delete never mind limit sum min march",
  T("delete the blood test", ask("blood", "blood_results"),
    ref=[askc("the blood test appointment or the blood test results document?", options="$blood, $blood_results")]),
  T("no leave both, the results are what i take to the gp on tuesday and i haven't printed anything yet", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("add up the three smallest amounts i owe", val((90, "NZD")),
    ref=[find(kind="debt", where='direction = "i_owe" and status = "open"', order="amount asc", limit=3),
         comp(op="sum", field="amount", within="@prev"),
         ans(value="@prev")]),
  T("smallest event in march, cancelled ones don't count", val(30),
    ref=[comp(op="min", field="duration", kind="event", when=U("month", 0, name=3), where='status != "cancelled"'),
         ans(value="@prev")]))

S("T28-137", "unbounded documents refused delete group ask never mind unbounded tasks",
  T("clear out every folder and docuemnts, the lot, i'll scan what matters again", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete the kapa haka koha group, we're done with it", ask(),
    ref=[bad(act("delete", rows="$kapa_g")),
         askc("it still has the uniform dry cleaning in it so the vault won't delete it. settle up with hine first?")]),
  T("no leave it, we still owe each other for the dry cleaning until after regionals", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("delete every task on every list, we're starting the year fresh after the reunion", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T28-138", "limit person last contacted unbounded locker min cadence max in progress",
  T("last three people i tlaked to", rows("aroha", "mere", "ria"),
    ref=[ans(kind="person", order="date desc", limit=3)]),
  T("throw out every login and card in my locker, all of them, i'm changing everything after the reunion", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fewest days between check-ins i set for anyone, cadnce wise", val(7),
    ref=[ans(op="min", field="cadence", kind="person")]),
  T("biggest effort among my in progress stuff, i need to know if i can finish it before the reunion", val(240),
    ref=[comp(op="max", field="effort", kind="task", where='status = "in_progress"'),
         ans(value="@prev")]))

S("T28-139", "limit touch limit photos ask cross-kind delete never mind",
  T("when's the next touch session", rows("touch_0223"),
    ref=[ans(kind="event", name="Touch", when=FROM_TODAY, order="date asc", limit=1)]),
  T("the four latest photos", rows("p_aroha", "p_waka", "p_lunch", "p_ria"),
    ref=[ans(kind="photo", order="date desc", limit=4)]),
  T("delete the roof one", ask("roof_quotes", "roof_note", "roof_quote", "p_roof"),
    ref=[askc("the roof quotes task, the wharekai roof note, the roof quote document or the leaky roof photo?",
              options="$roof_quotes, $roof_note, $roof_quote, $p_roof")]),
  T("nvm, leave all of it, the roofer comes on monday and i still need every bit of it for the committee", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T28-140", "limit marae note unbounded everything sum touch max february",
  T("my lateset note in the marae committee notebook", rows("roof_note"),
    ref=[ans(kind="note", linked_to="$marae_nb", order="date desc", limit=1)]),
  T("wpie every document, note and photo i own, i'm starting from scratch after the reunion", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("how many minutes of tuch for nikau and ro this month, added together", val(240),
    ref=[comp(op="sum", field="duration", kind="event", name="Touch for Nikau and Ro", when=U("month", 0)),
         ans(value="@prev")]),
  T("and the longest single event that month, not counting cancelled ones", val(360),
    ref=[comp(op="max", field="duration", kind="event", when=U("month", 0), where='status != "cancelled"'),
         ans(value="@prev")]))
