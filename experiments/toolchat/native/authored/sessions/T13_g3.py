from gold import *
import json

world("T13", "2026-09-03T22:10", "Amara Nwosu", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


LIVE = 'status = "open"'

def next_group():
    return find(kind="event", name="Lab group meeting", when=W({"from": U("day", 0)}), order="date asc", limit=1)


def badminton():
    return find(kind="event", name="Badminton", when=W(span(U("day", 0), U("month", 0))))


S("T13-131", "recovery next lab group meeting then lab list min max sum",
  T("when's the next lab group meeting, i need to book the room", rows("group_0907"),
    ref=[next_group(), bad(next_group()), ans(within="@prev")]),
  T("what's the quikest thing left on the lab list", val(10),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$lab_l", where=LIVE)]),
  T("and the longest one, i bet it's the xrd data", val(120),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$lab_l", where=LIVE)]),
  T("how long is the whole lab list altogther, i wanna see if it fits in a weekend", val(230),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$lab_l", where=LIVE), ans(value="@prev")]))

S("T13-133", "ask star payslip never mind then personal list min max",
  T("star the payslip", ask("payslip_jul", "payslip_aug"),
    ref=[act("star", kind="document", name="Payslip"),
         askc("july or august?", options="$payslip_jul, $payslip_aug")]),
  T("actually no, leave them both, i can just search for it when the visa people ask", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what's the fastst thing on my personal list, i've got ten minutes on the bus", val(10),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$personal_l", where=LIVE)]),
  T("and the slowest one, probaly the brp renewal", val(120),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$personal_l", where=LIVE)]))

S("T13-136", "ask cancel flight never mind then latest notes limit then longest event",
  T("cancel the flight", ask("lisbon_out", "lisbon_back", "lagos_flight"),
    ref=[act("cancel", kind="event", name="Flight"),
         askc("lisbon out, lisbon back or the lagos one?", options="$lisbon_out, $lisbon_back, $lagos_flight")]),
  T("oh wait no, i haven't heard back from helen about the conference dates so leave all of them", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("last three notse i wrote", rows("conf_ideas", "glovebox_log", "xrd_notes", order=True),
    ref=[ans(kind="note", order="date desc", limit=3)]),
  T("how long is the longest thing in my diary this month that's actually still on", val(420),
    ref=[ans(op="max", field="duration", kind="event", when=W(U("month", 0)), where='status != "cancelled"')]))

S("T13-137", "unbounded locker then ask delete payslip never mind then unbounded photos",
  T("delete evrything in my locker, i'm switching to a new password manager", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete the payslip", ask("payslip_jul", "payslip_aug"),
    ref=[act("delete", kind="document", name="Payslip"),
         askc("july or august?", options="$payslip_jul, $payslip_aug")]),
  T("nah keep them", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("wipe all my photos, my phone storage is full", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T13-138", "latest photos limit then unbounded then task min",
  T("three latest phots i took", rows("p_ticket", "p_poster", "p_chichi_call", order=True),
    ref=[ans(kind="photo", order="date desc", limit=3)]),
  T("clear out all my debts, they're all sorted anyway and i don't want the list hanging over me", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("what's the quickest thing on the house list that isn't done, i've got five minutes before i leave", val(5),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$house_l", where='status = "open"')]),
  T("and what's the longest job on the thesis list, the review chapter i assume", val(300),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$thesis_l", where=LIVE)]))

S("T13-139", "biggest nigsoc jobs limit then newest document then sum due this month then next week shortest",
  T("my two biggest jobs on the nigsoc list by time", rows("flyer", "fees", order=True),
    ref=[find(kind="task", linked_to="$nigsoc_l", where=LIVE, order="effort desc", limit=2), ans(rows="@prev")]),
  T("what's the newest docment i've got", rows("boarding"),
    ref=[ans(kind="document", order="date desc", limit=1)]),
  T("how much time is there in everything due between now and the end of the month",
    val(1175),
    ref=[comp(op="sum", field="effort", kind="task", when=W(span(U("day", 0), U("month", 0))), where=LIVE),
         ans(value="@prev")]),
  T("shortest thing in my diary next week that isn't cancelled, i need a gap for a phone call", val(45),
    ref=[ans(op="min", field="duration", kind="event", when=W(U("week", 1)), where='status != "cancelled"')]))

S("T13-140", "last people contacted limit then unbounded diary then ask delete tom never mind then weekend sum",
  T("last three people i contcted", rows("wei", "priya", "tom_h", order=True),
    ref=[ans(kind="person", order="date desc", limit=3)]),
  T("wipe the whole calender, i'm going to rebuild it from scratch after the conference", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete tom", ask("tom_h", "tom_b"),
    ref=[act("delete", kind="person", name="Tom"),
         askc("tom hargreaves or tom bennett?", options="$tom_h, $tom_b")]),
  T("hmm no, i'd lose the debt history with him, leave both for now", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how much time is there in the jobs due this weekend", val(100),
    ref=[ans(op="sum", field="effort", kind="task", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))), where=LIVE)]))
