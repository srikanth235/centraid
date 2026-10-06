from gold import *
import json

world("T06", "2026-02-07T23:15", "Lukas Brandt", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


OPEN = 'status = "open"'
IOWE = 'direction = "i_owe" and status = "open"'

S("T06-B001", "c3b superlative event duration next week shortest count",
  T("which event next week runs the longest", rows("theatre_tech"),
    ref=[ans(kind="event", when=W(U("week", 1)), order="duration desc", limit=1)]),
  T("and the shortest", rows("bike"),
    ref=[ans(kind="event", when=W(U("week", 1)), order="duration asc", limit=1)]),
  T("how many events is that next week", val(9),
    ref=[ans(op="count", kind="event", when=W(U("week", 1)))]))

S("T06-B002", "c3b superlative debt biggest sum smallest",
  T("which debt of mine is the biggest", rows("d_olli_mic"),
    ref=[ans(kind="debt", where=IOWE, order="amount desc", limit=1)]),
  T("what's the total i owe people", val((197, "EUR")),
    ref=[ans(op="sum", field="amount", kind="debt", where=IOWE)]),
  T("and the smallest one", rows("d_jonask_bvg"),
    ref=[ans(kind="debt", where=IOWE, order="amount asc", limit=1)]))

S("T06-B003", "c3b superlative task effort overdue oldest count",
  T("what's the biggest open job on my list", rows("vat"),
    ref=[ans(kind="task", where=OPEN, order="effort desc", limit=1)]),
  T("and which one has been overdue the longest", rows("kitty_02"),
    ref=[ans(kind="task", where=OPEN, order="date asc", limit=1)]),
  T("give me a headcount of everything still open on my list", val(35),
    ref=[ans(op="count", kind="task", where=OPEN)]))

S("T06-B004", "c4b state-change complete complete create contrast",
  T("topped up the wg kasse", diff(upd("kitty_02", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="WG Kasse")]),
  T("bin bags done", diff(upd("bin_bags", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="bin bags")]),
  T("add a task: order a new mic stand", diff(new("task", name=has("mic", "stand"))),
    ref=[act("create", args=lines(kind="task", name="Order a new mic stand"))]))

S("T06-B005", "c4b state-change cancel event restore trashed event",
  T("dr albrecht's sick so the dentist is cancelled", diff(upd("dentist", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dentist check-up")]),
  T("bring back the pub quiz with olli", diff(restore("pub_quiz")),
    ref=[act("restore", kind="event", name="Pub quiz", trashed=True)]))

S("T06-B006", "c4b state-change settle_debt log nickname",
  T("kalle paid me for the beer crate", diff(upd("d_kalle_beer", status="settled")),
    ref=[act("settle_debt", kind="debt", name="beer crate")]),
  T("called mama back", diff(upd("ute", date=ANY)),
    ref=[search("mama", kind="person"), act("log", rows="$ute", args=lines(kind="call"))]))
