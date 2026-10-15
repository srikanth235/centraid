from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))



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
