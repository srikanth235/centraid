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

S("T25-135-P", "sum debts since october max home task min next week limit two para",
  T("summing what friends and coworkers both owe me, counting from the first of october", val((98.5, "CAD")),
    ref=[comp(op="sum", field="amount", kind="debt", where='direction = "owes_me" and status = "open"',
              when={"from": D("2026-10-01")}),
         ans(value="@prev")]),
  T("home list, largest effort", val(90),
    ref=[comp(op="max", field="effort", kind="task", linked_to="$home_l", where='status = "open"'),
         ans(value="@prev")]),
  T("i want to knock out the quickest first, so of everything due next week which is it", val(5),
    ref=[comp(op="min", field="effort", kind="task", when=U("week", 1), where='status = open'),
         ans(value="@prev")]),
  T("pick the two open tasks due first, then tell me which takes longer", val(15),
    ref=[find(kind="task", where='status = "open"', order="date asc", limit=2),
         comp(op="max", field="effort", within="@prev"),
         ans(value="@prev")]))
