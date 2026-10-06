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

OWE = 'direction = "i_owe" and status = "open"'

OWED = 'direction = "owes_me" and status = "open"'

S("T01-133-P", "ask never-mind then debts min max para",
  T("reflection note can go, wipe it", ask("refl_sepsis", "refl_falls"),
    ref=[act("delete", kind="note", name="Reflection"),
         askc("Sepsis patient or falls audit?", options="$refl_sepsis, $refl_falls")]),
  T("keep both, i've not finished and revalidation needs the reflective accounts", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("i want to clear the smallest debt first, what is it", val((8.5, "GBP")),
    ref=[comp(op="min", field="amount", kind="debt", where=OWE), ans(value="@prev")]),
  T("largest amount i owe one person, still mum's uniform money?", val((40, "GBP")),
    ref=[comp(op="max", field="amount", kind="debt", where=OWE), ans(value="@prev")]))

S("T01-139-P", "last april event, payslip ask never-mind, old debt min para",
  T("april's final booking", rows("hen_dinner"),
    ref=[ans(kind="event", when=J(U("month", 0, name=4)), order="date desc", limit=1)]),
  T("the payslip is to be wiped", ask("payslip_jan", "payslip_feb"),
    ref=[act("delete", kind="document", name="Payslip"),
         askc("January or February?", options="$payslip_jan, $payslip_feb")]),
  T("keep them, they might be needed for the mortgage thing", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("from before this month, lowest amount anyone owes me?", val((25, "GBP")),
    ref=[comp(op="min", field="amount", kind="debt", when=J({"to": U("month", -1)}), where=OWED),
         ans(value="@prev")]))

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T01-203-P", "owe direction balance settle group-me para",
  T("what's my position with kwame money-wise", val((-17, "GBP")),
    ref=[ans(op="balance", rows="$kwame")]),
  T("zainab?", val((6, "GBP")),
    ref=[ans(op="balance", rows="$zainab")]),
  T("taxi debt to kwame, settle it", diff(upd("d_kwame_taxi", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$kwame", where="direction = i_owe and status = open")]),
  T("house bills, where do i stand", val((13, "GBP")),
    ref=[search("Oluwaseun", kind="person"), ans(op="balance", kind="group", name="House Bills", linked_to="$me")]))
