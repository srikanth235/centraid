from gold import *

import json

world("T35", "2026-11-12T19:20", "Freya Lindqvist", "train")

def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T35-108-P", "mixed settle_up amount person group para",
  T("bjorn handed me 1000 for the kitty, settle that up", diff(upd("bjorn", balance=ANY), settle=[("Bjorn Nilsen", "1000.00")]),
    ref=[act("settle_up", rows="$bjorn", args=lines(group="$seilklubb", amount="1000"))]))
