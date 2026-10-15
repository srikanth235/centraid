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
