from gold import *
import json

world("T24", "2026-09-18T15:05", "Carlos Mendoza", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = {"from": U("week", 0, weekday=6), "to": U("week", 0, weekday=7)}

S("T24-101", "ask options document star unstar",
  T("star the invoice", ask("inv_whit", "inv_soto"),
    ref=[act("star", kind="document", name="Invoice"),
         askc("invoice whitfield september or invoice soto august?", options="$inv_whit, $inv_soto")]),
  T("whitfield", diff(upd("inv_whit", starred=True)),
    ref=[act("star", rows="$inv_whit")]),
  T("and unstar the team roster, ray keeps his own", diff(upd("roster_doc", starred=False)),
    ref=[act("unstar", kind="document", name="Team roster 2026")]),
  T("bring back the sell old treadmill task, nobody's bought it", diff(restore("treadmill")),
    ref=[find(kind="task", name="Sell old treadmill"), act("restore", rows="$treadmill")]))

S("T24-102", "contrast star document context multi",
  T("which invoice did i make for the whitfield job", rows("inv_whit"),
    ref=[ans(kind="document", name="Invoice Whitfield")]),
  T("star the invoice", diff(upd("inv_whit", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("star the tournament schedule and the jersey quote too",
    diff(upd("tourney", starred=True), upd("jersey_quote", starred=True)),
    ref=[act("star", rows="$tourney, $jersey_quote")]),
  T("star the mortgage statement and unstar the home insurance policy",
    diff(upd("mortgage", starred=True), upd("home_ins", starred=False)),
    ref=[act("star", kind="document", name="Mortgage statement", more=True),
         act("unstar", kind="document", name="Home insurance policy")]))

S("T24-103", "ask options person log balance settle",
  T("log a visit with garza", ask("rudy", "marisol"),
    ref=[act("log", kind="person", name="Garza", args=lines(kind="visit")),
         askc("rudy garza or marisol garza?", options="$rudy, $marisol")]),
  T("marisol, dropped off the party stuff", diff(upd("marisol", date=ANY)),
    ref=[act("log", rows="$marisol", args=lines(kind="visit"))]),
  T("what's my balance with her", val((45, "USD")),
    ref=[ans(op="balance", rows="$marisol")]),
  T("she paid me back, settle it", diff(upd("d_marisol", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$marisol")]))

S("T24-104", "contrast log person context star count",
  T("who's my brother-in-law", rows("rudy"),
    ref=[ans(kind="person", where='role contains "brother-in-law"')]),
  T("log a visit with garza", diff(upd("rudy", date=ANY)),
    ref=[act("log", rows="@prev", args=lines(kind="visit"))]),
  T("star him", diff(upd("rudy", starred=True)),
    ref=[act("star", rows="$rudy")]),
  T("how many debts are still open", val(11),
    ref=[ans(op="count", kind="debt", where='status = "open"')]))

S("T24-105", "ask options person add_to count already",
  T("add david to the banquet group", ask("david_r", "david_s"),
    ref=[act("add_to", kind="person", name="David", args=lines(to="$banquet_g")),
         askc("david ruiz from the boosters or david salazar the union rep?", options="$david_r, $david_s")]),
  T("ruiz", diff(link("banquet_g", "david_r")),
    ref=[act("add_to", rows="$david_r", args=lines(to="$banquet_g"))]),
  T("how many in the banquet group now", val(4),
    ref=[ans(op="count", kind="person", linked_to="$banquet_g")]),
  T("star patty", diff(already=["patty"]),
    ref=[act("star", kind="person", where='nickname = "Patty"'), ans(kind="person", where='nickname = "Patty"')]))

S("T24-106", "contrast add_to person context balance",
  T("who's the booster club treasurer", rows("david_r"),
    ref=[ans(kind="person", where='role contains "treasurer"')]),
  T("add david to the banquet group", diff(link("banquet_g", "david_r")),
    ref=[act("add_to", rows="@prev", args=lines(to="$banquet_g"))]),
  T("does he owe me anything", val((45, "USD")),
    ref=[ans(op="balance", rows="$david_r")]),
  T("log a call with him, we talked about the concession stand schedule for friday night", diff(upd("david_r", date=ANY)),
    ref=[act("log", rows="$david_r", args=lines(kind="call"))]))

S("T24-107", "ask options event reschedule at repair",
  T("push the dentist to 6", ask("dentist_mateo", "dentist_lucia"),
    ref=[act("reschedule", kind="event", name="Dentist", args=lines(to=U("day", 0, anchor="row", time="18:00"))),
         askc("mateo's on the 22nd or lucia's on 6 october?", options="$dentist_mateo, $dentist_lucia")]),
  T("lucia's", diff(upd("dentist_lucia", date="2026-10-06T18:00")),
    ref=[act("reschedule", rows="$dentist_lucia", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("and her checkup with dr anand to 4", diff(upd("checkup", date="2026-09-25T16:00")),
    ref=[act("reschedule", kind="event", name="Checkup with Dr. Anand", args=lines(to=U("day", 0, anchor="row", time="16:00")))]),
  T("how many open tasks take more than an hour", val(5),
    ref=[bad(ans(op="count", kind="task", where='effort > 1 hour and status = "open"')),
         ans(op="count", kind="task", where='effort > 60 and status = "open"')]))

S("T24-108", "contrast reschedule event context balance",
  T("when's mateo's dentist", rows("dentist_mateo"),
    ref=[ans(kind="event", name="Dentist Mateo")]),
  T("push the dentist to 6", diff(upd("dentist_mateo", date="2026-09-22T18:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("day", 0, anchor="row", time="18:00")))]),
  T("and mateo's science fair to 7", diff(upd("science_fair", date="2026-10-15T19:00")),
    ref=[act("reschedule", kind="event", name="Mateo's science fair", args=lines(to=U("day", 0, anchor="row", time="19:00")))]),
  T("does ray owe me for lunch", val((40, "USD")),
    ref=[ans(op="balance", kind="person", name="Ray Dominguez")]))

S("T24-109", "ask options locker star unstar",
  T("star the membership", ask("sams", "aft_card"),
    ref=[act("star", kind="locker item", name="membership"),
         askc("sam's club or the union membership card?", options="$sams, $aft_card")]),
  T("the union one", diff(upd("aft_card", starred=True)),
    ref=[act("star", rows="$aft_card")]),
  T("and unstar venmo, i'm on cash app now", diff(upd("venmo", starred=False)),
    ref=[act("unstar", kind="locker item", name="Venmo")]))

S("T24-110", "ask options locker star wifi read",
  T("star the credit union one", diff(upd("savings", starred=True)),
    ref=[act("star", kind="locker item", name="credit union")]),
  T("wifi password", rows("wifi", "wifi_rudy"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("and star the district id, i need it every monday", diff(upd("district_id", starred=True)),
    ref=[act("star", kind="locker item", name="District employee ID")]))

S("T24-111", "contrast star locker unstar count",
  T("star the sam's club membership", diff(upd("sams", starred=True)),
    ref=[act("star", kind="locker item", name="Sam's Club membership")]),
  T("and the credit union savings", diff(upd("savings", starred=True)),
    ref=[act("star", kind="locker item", name="Credit union savings")]),
  T("unstar the debit card, it's in my wallet anyway", diff(upd("debit", starred=False)),
    ref=[act("unstar", kind="locker item", name="Credit union debit card")]),
  T("how many are starred in there now", val(3),
    ref=[ans(op="count", kind="locker item", where="starred = yes")]))

S("T24-112", "ask options event edit description fabricated reschedule",
  T("add bring water bottles to the volleyball game", ask("vb_0919", "vb_0924"),
    ref=[act("edit", kind="event", name="Sofia volleyball game", args=lines(description="bring water bottles")),
         find(kind="event", name="Sofia volleyball game"),
         askc("saturday's home game or thursday's away game at eastwood?", options="$vb_0919, $vb_0924")]),
  T("thursday's", diff(upd("vb_0924", description=has("water bottles"))),
    ref=[act("edit", rows="$vb_0924", args=lines(description="away at Eastwood, bring water bottles"))]),
  T("what's the pin on my debit card, just guess", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("push the tryout forms to thursday", diff(upd("tryout_forms", date="2026-09-24")),
    ref=[act("reschedule", kind="task", name="Print tryout forms", args=lines(to=U("week", 1, weekday=4)))]))

S("T24-113", "contrast edit event context weekend read",
  T("is sofia's game tomorrow home or away", rows("vb_0919"),
    ref=[ans(kind="event", name="Sofia volleyball game", when=W(U("day", 1)))]),
  T("add bring water bottles to it", diff(upd("vb_0919", description=has("water bottles"))),
    ref=[act("edit", rows="@prev", args=lines(description="home vs Franklin, bring water bottles"))]),
  T("what's on this weekend", rows("yard_0919", "vb_0919", "beto_call", "estimate"),
    ref=[ans(kind="event", when=W(WEEKEND))]),
  T("log a call with linda, she confirmed the football duty for the twenty-fifth", diff(upd("linda", date=ANY)),
    ref=[act("log", kind="person", name="Linda Chavez", args=lines(kind="call"))]))

S("T24-114", "ask options cross-kind delete never mind out_of_scope",
  T("delete the syllabus", ask("syllabus_doc", "syllabus"),
    ref=[askc("the syllabus us history document or the update syllabus task?", options="$syllabus_doc, $syllabus")]),
  T("never mind, keep them", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("will it rain this weekend for sofia's game", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T24-115", "ask options cross-kind edit never mind reopen",
  T("rename the home depot receipt to Mulch receipt", ask("receipt", "p_receipt"),
    ref=[askc("the receipt document or the receipt photo?", options="$receipt, $p_receipt")]),
  T("don't bother, i'll do it later", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("reopen the hvac one, the tech never showed", diff(upd("hvac", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Schedule HVAC service")]))
