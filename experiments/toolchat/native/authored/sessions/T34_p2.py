from gold import *

import json

world("T34", "2027-06-20T21:15", "Obinna Okafor", "train")

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T34-103-P", "date-window X-or-older ends-at-end year-arithmetic two-years-ago para",
  T("generator services dated 2024 and before?",
    rows("gen_230606", "gen_230905", "gen_231205", "gen_240305", "gen_240604", "gen_240903", "gen_241203"),
    ref=[ans(kind="event", name="Generator service", when=W({"to": D("2024-12-31")}))]),
  T("what about two years ago", rows("gen_250304", "gen_250603", "gen_250909", "gen_251209"),
    ref=[ans(kind="event", name="Generator service", when=W(U("year", -2)))]))

S("T34-107-P", "mixed note body-append open edit pin para",
  T("generator oil schedule note, append 'oil change due in august'",
    diff(upd("loose_6", body=has("Engr Segun comes in March", "oil change due in august"))),
    ref=[opn("$loose_6"),
         act("edit", rows="$loose_6",
             args=lines(body="change oil every 200 hours, filters every 400, Engr Segun comes in March, June, September and December. oil change due in august"))]),
  T("pin it too", diff(upd("loose_6", pinned=True)),
    ref=[act("edit", rows="$loose_6", args="pinned: yes")]))
