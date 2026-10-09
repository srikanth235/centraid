from gold import *
import json

world("T17", "2026-01-30T13:35", "Elena Petrova", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


LIVE = 'status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
OWE = 'direction = "i_owe" and status = "open"'
LIVE_EV = 'status != "cancelled"'


def next_ivan():
    return find(kind="event", name="Ivan's lesson", when=W({"from": U("day", 0)}), order="date asc", limit=1)


def rehearsals():
    return find(kind="event", name="Choir rehearsal", when=W({"from": U("day", 0)}))


S("T17-131", "recovery next ivan lesson then choir list min max sum",
  T("when's ivan's next lesson, i want to prepare the scales for him", rows("ivan_0202"),
    ref=[next_ivan(), bad(next_ivan()), ans(within="@prev")]),
  T("what's the shortest job on the choir list, i've got ten minutes before the next student", val(15),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$choir_l", where=LIVE)]),
  T("and the longest one, the alto line for the rach i bet", val(30),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$choir_l", where=LIVE)]),
  T("how much time is the whole choir list altogethr, i'd like to know before i plan the weekend", val(65),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$choir_l", where=LIVE), ans(value="@prev")]))

S("T17-132", "recovery twice rehearsals then renovation sum then owed min max",
  T("next three choir rehearsals, i need to tell petar which ones i'll miss", rows("choir_0203", "choir_0210", "choir_0217", order=True),
    ref=[rehearsals(), bad(rehearsals()), bad(rehearsals()),
         ans(within="@prev", order="date asc", limit=3)]),
  T("how long is everything on the renovation list all added up, i want to know how much to clear before the demolition", val(230),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$reno_l", where=LIVE)]),
  T("what's the smallest amount any student owes me right now", val((50, "BGN")),
    ref=[ans(op="min", field="amount", kind="debt", where=OWED)]),
  T("and the biggest, i'm guessing it's daniela's for boris's decembr lessons", val((160, "BGN")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]))

S("T17-133", "ask reschedule veselina rehearsal never mind then viktor list min max",
  T("push the rehearsal with veselina to 7", ask("vesi_reh", "vesi_reh_jan"),
    ref=[act("reschedule", kind="event", name="Rehearsal with Veselina",
             args=lines(to=U("day", 0, anchor="row", time="19:00"))),
         find(kind="event", name="Rehearsal with Veselina"),
         askc("the one on the 2nd or the one on the 29th?", options="$vesi_reh, $vesi_reh_jan")]),
  T("hmm never mind, i'll ask her first what time actually works for her before i move anything", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the quickest thing on the viktor list, i need something small before i pick him up", val(5),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$viktor_l", where=LIVE)]),
  T("and the longest one, i bet it's his pasport", val(20),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$viktor_l", where=LIVE)]))

S("T17-134", "shopping min max teaching sum then biggest owed limit",
  T("smallest job on the shopping list, i'm standing in the queue at the pharmacy", val(10),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$shopping_l", where=LIVE)]),
  T("longest?", val(60),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$shopping_l", where=LIVE)]),
  T("total time on the teaching list, i wanna see if it fits into the weekned", val(385),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$teaching_l", where=LIVE)]),
  T("who are my three biggest debtors", rows("d_daniela", "d_niki", "d_maria_k", order=True),
    ref=[ans(kind="debt", where=OWED, order="amount desc", limit=3)]))

S("T17-135", "borrowed this month sum max min then two latest notes",
  T("how much did i borrow this month, i'm going through the renovation costs again", val((1945, "BGN")),
    ref=[ans(op="sum", field="amount", kind="debt", when=W(U("month", 0)), where=OWE)]),
  T("and the biggest of those, that's mitko's installment isn't it", rows("d_mitko"),
    ref=[ans(kind="debt", when=W(U("month", 0)), where=OWE, order="amount desc", limit=1)]),
  T("smallest one?", val((25, "BGN")),
    ref=[ans(op="min", field="amount", kind="debt", when=W(U("month", 0)), where=OWE)]),
  T("my two newest notez", rows("vesi_tempi", "mitko_calls", order=True),
    ref=[ans(kind="note", order="date desc", limit=2)]))

S("T17-136", "ask delete choir concert never mind then recent contacts then longest this week",
  T("delete the choir concert", ask("concert_dec", "concert_mar"),
    ref=[act("delete", kind="event", name="Choir concert"),
         find(kind="event", name="Choir concert"),
         askc("the december one or the one in march?", options="$concert_dec, $concert_mar")]),
  T("no wait, leave both, petar wants the december one for the concert recording archive", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("who did i speak to last, three people", rows("petar", "viktor", "vesi", order=True),
    ref=[ans(kind="person", order="date desc", limit=3)]),
  T("what's the longest thing in my diary this week that's still on", val(120),
    ref=[ans(op="max", field="duration", kind="event", when=W(U("week", 0)), where=LIVE_EV)]))

S("T17-137", "unbounded notes then ask delete scan never mind then unbounded photos",
  T("wipe all my notes, the lesson ones too, i want to start over from scratch evrything goes", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete the scan", ask("scan_71", "scan_72"),
    ref=[act("delete", kind="document", name="Scan"),
         askc("scan 0071 or scan 0072?", options="$scan_71, $scan_72")]),
  T("nah keep them all, i think my accountant might need them for the tax return in the spring", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("clear out all my photos, the phone storage is full", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T17-138", "latest photos limit then unbounded diary then renovation min max",
  T("three latest phtos i took", rows("lunch_p", "vesi_duo", "whiteboard", order=True),
    ref=[ans(kind="photo", order="date desc", limit=3)]),
  T("delete every event in my diary, all of it, i'm taking a break from everything after the recitl", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("what's the shortest job on the renovation list, i've got five minutes between two studnts", val(15),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$reno_l", where=LIVE)]),
  T("and the biggest one, the bathroom itself i suppose", val(120),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$reno_l", where=LIVE)]))

S("T17-139", "biggest i owe limit then next dentist then sum this week then shortest event next week",
  T("the two biggest things i owe", rows("d_mitko", "d_mila", order=True),
    ref=[ans(kind="debt", where=OWE, order="amount desc", limit=2)]),
  T("when's my next dentist appointmnt", rows("dentist_v"),
    ref=[ans(kind="event", name="dentist", when=W({"from": U("day", 0)}), order="date asc", limit=1)]),
  T("how much work is sat on my plate this week, all the tasks added up", val(190),
    ref=[ans(op="sum", field="effort", kind="task", when=W(U("week", 0)), where=LIVE)]),
  T("shortest thing in my diary next week that isn't cancelled, i need a gap for a phone call", val(15),
    ref=[ans(op="min", field="duration", kind="event", when=W(U("week", 1)), where=LIVE_EV)]))

S("T17-140", "newest documents limit then unbounded calendar then ask add ivan never mind then viktor sum",
  T("two newest docuemnts", rows("scan_72", "scan_71", order=True),
    ref=[ans(kind="document", order="date desc", limit=2)]),
  T("get rid of everything on my calendar, i'll put it back after the recitl", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("add ivan to the studio rent", ask("ivan_t", "ivan_d"),
    ref=[act("add_to", kind="person", name="Ivan", args=lines(to="$studio")),
         askc("ivan todorov the student or ivan dimov the building manager?", options="$ivan_t, $ivan_d")]),
  T("actually no, that's not right, ivan the building manager is not in the studio rent so leave it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how much time is the viktor list altogether", val(35),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$viktor_l", where=LIVE)]))
