from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))

WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))

S("T01-129-P", "ask-options person star already-so para",
  T("clarke gets a star", ask("callum", "maureen"),
    ref=[act("star", kind="person", name="Clarke"),
         askc("Callum Clarke or Maureen Clarke?", options="$callum, $maureen")]),
  T("maureen's the one, she's been brilliant with the kids", diff(upd("maureen", starred=True)),
    ref=[act("star", rows="$maureen")]),
  T("term dates have changed, drop the star from them", diff(upd("term_dates", starred=False)),
    ref=[act("unstar", kind="document", name="Term dates 2025-26")]))

def J(d):
    return json.dumps(d, separators=(",", ":"))

def next_night():
    return find(kind="event", name="Night shift", when=J({"from": U("day", 0)}), order="date asc", limit=1)

def long_days():
    return find(kind="event", name="Long day", when=J({"from": U("day", 0)}))

def J(d):
    return json.dumps(d, separators=(",", ":"))
