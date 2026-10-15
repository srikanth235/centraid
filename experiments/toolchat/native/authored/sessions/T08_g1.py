from gold import *
import json

world("T08", "2026-04-06T17:50", "Deshawn Carter", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T08-103", "star ask document insurance card unstar locker contrast",
  T("star the insurance card", diff(upd("dental_card", starred=True)),
    ref=[act("star", kind="document", name="insurance card")]),
  T("and unstar my union card", diff(upd("union_card", starred=False)),
    ref=[act("unstar", kind="locker item", name="union card")]))

S("T08-104", "star ask contract never mind wifi bare read",
  T("star the contract", ask("union_contract", "pavilion_contract"),
    ref=[act("star", kind="document", name="contract"),
         askc("the union contract or the pavilion rental one?", options="$union_contract, $pavilion_contract")]),
  T("forget it", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("wifi pw", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("make sure that one's starred", diff(already=["wifi"]),
    ref=[act("star", rows="$wifi"), ans(kind="locker item", rows="$wifi")]))

S("T08-105", "star document already fabricated pin",
  T("star the union contract", diff(upd("union_contract", starred=True)),
    ref=[act("star", kind="document", name="Union contract")]),
  T("and the epa 608 certificate", diff(already=["epa_cert"]),
    ref=[act("star", kind="document", name="EPA 608 certificate"), ans(rows="$epa_cert")]),
  T("what's the pin on my visa, i blanked", decline("not_found"),
    ref=[search("visa"), dec("not_found")]))

S("T08-110", "cancel event ask on-call reschedule bare weekday at N decline",
  T("cancel my on-call shift, i swapped with luis and he's covering one of them", ask("oncall_0410", "oncall_0424", "oncall_0508"),
    ref=[act("cancel", kind="event", name="On-call shift"),
         find(kind="event", name="On-call shift"),
         askc("which shift, the 10th, the 24th or may 8th?", options="$oncall_0410, $oncall_0424, $oncall_0508")]),
  T("the 24th", diff(upd("oncall_0424", status="cancelled")),
    ref=[act("cancel", rows="$oncall_0424")]),
  T("and push the tax appointment to thursday at 1", diff(upd("tax_appt", date="2026-04-09T13:00")),
    ref=[act("reschedule", kind="event", name="Tax appointment", args=lines(to=U("week", 0, weekday=4, time="13:00")))]),
  T("call the dentist and confirm jalen's slot", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T08-112", "reveal ask card number star locker",
  T("show me the card number", ask("visa", "gas_card"),
    ref=[act("reveal", kind="locker item", where='type = "card"', args=lines(field="card_number")),
         askc("the credit union visa or the company fuel card?", options="$visa, $gas_card")]),
  T("the visa", diff(reveal=[("visa", "4111 2233 4455 6677")]),
    ref=[act("reveal", rows="$visa", args=lines(field="card_number"))]),
  T("star the fuel card", diff(upd("gas_card", starred=True)),
    ref=[act("star", kind="locker item", name="fuel card")]))

S("T08-113", "reveal cvv contrast fabricated sealed egress",
  T("what's the cvv on the fuel card", diff(reveal=[("gas_card", "044")]),
    ref=[act("reveal", kind="locker item", name="fuel card", args=lines(field="cvv"))]),
  T("make up a new pin for it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("email the visa number to tanya so she can pay", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T08-114", "reveal ask login school wifi read then reveal",
  T("what's the password on my login", ask("servicetitan", "portal", "bank_login"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("which one, the dispatch app, the school portal or the credit union?", options="$servicetitan, $portal, $bank_login")]),
  T("the school one", diff(reveal=[("portal", "JJtwins2013")]),
    ref=[act("reveal", rows="$portal", args=lines(field="password"))]),
  T("wifi password", rows("wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("show me the wifi password", diff(reveal=[("wifi", "EaglesNest2026!")]),
    ref=[act("reveal", rows="$wifi", args=lines(field="password"))]))

S("T08-115", "reveal contrast star undo scratch that",
  T("show me the school parent portal password", diff(reveal=[("portal", "JJtwins2013")]),
    ref=[act("reveal", kind="locker item", name="School parent portal", args=lines(field="password"))]),
  T("star it", diff(upd("portal", starred=True)),
    ref=[act("star", rows="$portal")]),
  T("scratch that", diff(upd("portal", starred=False)),
    ref=[act("undo")]))

S("T08-117", "log contrast next event reschedule prev anchor",
  T("log a call with tanya brooks", diff(upd("tanya", date=ANY)),
    ref=[act("log", kind="person", name="Tanya Brooks", args=lines(kind="call"))]),
  T("push the next union chapter meeting to 8pm", diff(upd("union_0408", date="2026-04-08T20:00")),
    ref=[act("reschedule", kind="event", name="Union chapter meeting", when=W({"from": U("day", 0)}),
             order="date asc", limit=1, args=lines(to=U("day", 0, anchor="row", time="20:00")))]))
