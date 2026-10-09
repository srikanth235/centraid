from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# --- groups hold people and money, never notes, tasks or events: the runtime says so, the model reads by name ---

S("T31-216", "recovery-nolink ward gifts notes pinned-in-notebook",
  T("any notes for the ward gifts group", rows("n_ward_meet"),
    ref=[ans(kind="note", linked_to="$ward_gifts"), ans(kind="note", name="ward")]),
  T("which of the other ward notes are pinned", rows("n_handover"),
    ref=[ans(kind="note", linked_to="$ward_nb", where="pinned = yes")]))

S("T31-217", "recovery-nolink flat bills notes within-pinned unpin",
  T("any notes for the flat bills group", rows("n_flat_rules", "n_shakshuka"),
    ref=[ans(kind="note", linked_to="$flat_bills"), ans(kind="note", name="flat")]),
  T("which of those is pinned", rows("n_flat_rules"),
    ref=[ans(within="@prev", where="pinned = yes")]),
  T("unpin it", diff(upd("n_flat_rules", pinned=False)),
    ref=[act("edit", rows="$n_flat_rules", args="pinned: no")]))

S("T31-218", "recovery-nolink zakopane tasks push-day december-count",
  T("any tasks for the zakopane group", rows("zak_pack"),
    ref=[ans(kind="task", linked_to="$zakopane"), ans(kind="task", name="zakopane")]),
  T("push it back a day", diff(upd("zak_pack", date="2026-12-03")),
    ref=[act("reschedule", rows="$zak_pack", args=lines(to=U("day", 1, anchor="row")))]),
  T("how many tasks are due in december", val(8),
    ref=[ans(op="count", kind="task", when=J(U("month", 0, name=12)))]))

S("T31-219", "recovery-nolink football fund games month count-ahead",
  T("any five-a-side games for the football fund group this month", rows("fas_1103", "fas_1110", "fas_1117", "fas_1124"),
    ref=[ans(kind="event", linked_to="$fiveaside", when=J(U("month", 0))),
         ans(kind="event", name="five-a-side", when=J(U("month", 0)))]),
  T("how many of those are still ahead", val(3),
    ref=[ans(op="count", within="@prev", when=J({"from": U("day", 0)}))]))

# --- one name, two rows the verb would change: the runtime asks which --------------------------------

S("T31-220", "ambiguous-physio delete three pick knee restore",
  T("delete the physio", ask("physio_a", "physio_b", "physio_c"),
    ref=[act("delete", kind="event", name="physio")]),
  T("the knee one", diff(trash("physio_c")),
    ref=[act("delete", rows="$physio_c")]),
  T("bring the physio back", diff(restore("physio_c")),
    ref=[find(kind="event", name="physio", trashed=True), act("restore", rows="@1")]))

S("T31-221", "ambiguous-league cancel upcoming three pick twenty-second",
  T("cancel the league match", ask("league_1108", "league_1122", "league_1206"),
    ref=[act("cancel", kind="event", name="league match")]),
  T("the one on the 22nd", diff(upd("league_1122", status="cancelled")),
    ref=[act("cancel", kind="event", name="league match", when=J(D("2026-11-22")))]))
