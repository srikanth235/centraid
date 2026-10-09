from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
NOW = W({"from": U("day", 0)})
NEXT_WEEK = W(U("week", 1))
IOWE = 'direction = "i_owe" and status = "open"'
OWED = 'direction = "owes_me" and status = "open"'
BIG_OWE = find(kind="debt", where=IOWE, order="amount desc", limit=2)
NEXT_WEEKEND = W(span(U("week", 1, weekday=6), U("week", 1, weekday=7)))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T18-112-P", "ask options shower task friday then contrast invites monday para",
  T("shower task, friday instead", ask("invites", "print_games", "playlist"),
    ref=[act("reschedule", kind="task", name="shower", args=lines(to=U("week", 1, weekday=5))),
         askc("send the invites, print the games or make the playlist?", options="$invites, $print_games, $playlist")]),
  T("playlist one", diff(upd("playlist", date="2026-03-06")),
    ref=[act("reschedule", rows="$playlist", args=lines(to=U("week", 1, weekday=5)))]),
  T("chloe wants to check the wording first, so invites go to monday at 9",
    diff(upd("invites", date="2026-03-02T09:00")),
    ref=[act("reschedule", kind="task", name="Send shower invites", args=lines(to=U("week", 1, weekday=1, time="09:00")))]),
  T("resume 2023, binned?", rows("resume"),
    ref=[find(kind="document", trashed=True, name="Resume 2023"), ans(rows="@prev")]))

S("T18-120-P", "decline oos twice then not_found trashed event para",
  T("dog class saturday, rain forecast?", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("send rhys the new deck by email", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("band practice on thursday instead", decline("not_found"),
    ref=[act("reschedule", kind="event", name="Band practice", args=lines(to=U("week", 1, weekday=4))),
         dec("not_found")]))

S("T18-133-P", "min owed typo then max then ask playtest never mind para",
  T("lowest debt anyone has with me, chasing the little ones first beacuse they're quick", val((24, "AUD")),
    ref=[ans(op="min", field="amount", kind="debt", where=OWED)]),
  T("largest, probably ollie's microphone from january still",
    val((150, "AUD")),
    ref=[ans(op="max", field="amount", kind="debt", where=OWED)]),
  T("playtest night, friday instead", ask("playtest_feb", "playtest_mar"),
    ref=[act("reschedule", kind="event", name="Playtest night", args=lines(to=U("week", 1, weekday=5, time="18:00"))),
         find(kind="event", name="Playtest night"),
         askc("the one on the 20th of february or the one on the 6th of march?", options="$playtest_feb, $playtest_mar")]),
  T("scratch that, priya says the timing's locked in for now so both stay as they are, i'll revisit it on thursady",
    decline("never_mind"),
    ref=[dec("never_mind")]))

S("T18-140-P", "latest photos then unbounded typo then ask cancel vet never mind then sum tasks typo para",
  T("two newest photos of mine", rows("b_creek", "whiteboard", order=True),
    ref=[ans(kind="photo", order="date desc", limit=2)]),
  T("erase the enitre vault", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("vet check-up is off, cancel it", ask("vet_feb", "vet_apr"),
    ref=[act("cancel", kind="event", name="Biscuit's vet check-up"),
         find(kind="event", name="Biscuit's vet check-up"),
         askc("the one in february or the one on the 15th of april?", options="$vet_feb, $vet_apr")]),
  T("hang on, biscuit still needs both check-ups, so nothing gets cancelled",
    decline("never_mind"),
    ref=[dec("never_mind")]),
  T("total minutes of tasks falling due on the fifth", val(50),
    ref=[ans(op="sum", field="effort", kind="task", when=W(D("2026-03-05")), where='status = "open"')]))
