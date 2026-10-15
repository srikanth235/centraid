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
