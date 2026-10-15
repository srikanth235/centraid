from gold import *
import json
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
FROM_TODAY = {"from": U("day", 0)}
work_notes = find(kind="note", linked_to="$work_nb", order="date desc", limit=2)
piano_three = find(kind="event", name="Piano lesson", when=FROM_TODAY, order="date asc", limit=3)

S("T25-123-P", "decline fabricated password then create locker star new para",
  T("the new streaming account needs a password, make one up and save it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("alright, only create a login named Disney", diff(new("locker item", name="Disney", type="login")),
    ref=[act("create", args=lines(kind="locker item", name="Disney", type="login"))]),
  T("give it a star for easy finding", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]))
