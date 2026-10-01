from gold import *
import json

world("T06", "2026-02-07T23:15", "Lukas Brandt", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T06-101", "star ask options invoice documents unstar",
  T("star the invoice", ask("inv_2025_12", "inv_2026_01", "inv_2026_02"),
    ref=[act("star", kind="document", name="Invoice"),
         askc("december, january or february? there are three invoices", options="$inv_2025_12, $inv_2026_01, $inv_2026_02")]),
  T("the greta one", diff(upd("inv_2026_01", starred=True)),
    ref=[act("star", rows="$inv_2026_01")]),
  T("and unstar the ksk letter, that's filed", diff(upd("ksk_letter", starred=False)),
    ref=[bad(act("unstar", kind="task", name="KSK")),
         act("unstar", kind="document", name="KSK contribution letter")]))

S("T06-102", "ask options soundcheck reschedule never mind",
  T("move the tonkeller soundcheck to 3", ask("sc_0213", "sc_0306"),
    ref=[act("reschedule", kind="event", name="Soundcheck Tonkeller", args=lines(to=U("day", 0, anchor="row", time="15:00"))),
         find(kind="event", name="Soundcheck Tonkeller"),
         askc("the one on the 13th before your show or the one on 6 march?", options="$sc_0213, $sc_0306")]),
  T("nah forget it, i'll sort it tomorrow", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("star the heating bill though", diff(upd("heating_letter", starred=True)),
    ref=[act("star", kind="document", name="heating bill"),
         search("heating bill", kind="document"),
         act("star", rows="$heating_letter")]))

S("T06-106", "contrast reschedule soundcheck named date gig",
  T("push the tonkeller soundcheck on the thirteenth to 3", diff(upd("sc_0213", date="2026-02-13T15:00")),
    ref=[act("reschedule", kind="event", name="Soundcheck Tonkeller", when=W(D("2026-02-13")),
             args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("and the show itself, 8 is too late, make it half seven", diff(upd("gig_tonkeller", date="2026-02-13T19:30")),
    ref=[act("reschedule", kind="event", name="Kaeltewelle live at Tonkeller",
             args=lines(to=U("day", 0, anchor="row", time="19:30")))]),
  T("put 'bring the di boxes' in the gig description too", diff(upd("gig_tonkeller", description="bring the di boxes")),
    ref=[act("edit", rows="$gig_tonkeller", args=lines(description="bring the di boxes"))]))

S("T06-108", "ask options jonas log then already star",
  T("log a call with jonas", ask("jonas_k", "jonas_w"),
    ref=[act("log", kind="person", name="Jonas", args=lines(kind="call")),
         askc("jonas keller the flatmate or jonas wirth the drummer?", options="$jonas_k, $jonas_w")]),
  T("wirth", diff(upd("jonas_w", date=ANY)),
    ref=[act("log", rows="$jonas_w", args=lines(kind="call"))]),
  T("star lena too, she's basically my producer", diff(already=["lena"]),
    ref=[act("star", kind="person", name="Lena Vogt"), ans(rows="$lena")]))

S("T06-109", "contrast log person by role description",
  T("log a call with the drummer", diff(upd("jonas_w", date=ANY)),
    ref=[act("log", kind="person", where='role contains "drummer"', args=lines(kind="call"))]),
  T("and a visit with keller, he stopped by earlier", diff(upd("jonas_k", date=ANY)),
    ref=[act("log", kind="person", name="Keller", args=lines(kind="visit"))]),
  T("star the drummer, he saved the show last night", diff(upd("jonas_w", starred=True)),
    ref=[act("star", kind="person", where='role contains "drummer"')]))

S("T06-110", "balance negative olli ines positive paul",
  T("what do i owe olli", val((-90, "EUR")),
    ref=[search("olli", kind="person"), ans(op="balance", rows="$olli")]),
  T("and ines", val((-45, "EUR")),
    ref=[ans(op="balance", rows="$ines")]),
  T("paul?", val((60, "EUR")),
    ref=[ans(op="balance", rows="$paul")]),
  T("and nele", val((11.5, "EUR")),
    ref=[ans(op="balance", rows="$nele")]))

S("T06-111", "balance sophie hannah bauer star person",
  T("how do i stand with sophie", val((-42.2, "EUR")),
    ref=[ans(op="balance", rows="$sophie")]),
  T("and hannah bauer", val((9.5, "EUR")),
    ref=[ans(op="balance", rows="$hannah_b")]),
  T("star her, she keeps paying me back", diff(upd("hannah_b", starred=True)),
    ref=[act("star", rows="$hannah_b")]),
  T("what about tobias", val((-21.5, "EUR")),
    ref=[ans(op="balance", rows="$tobi")]))

S("T06-112", "weekend read then cancel next weekend",
  T("what have i got this weekend", rows("wg_feb"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("cancel the climbing next weekend, hannah's got a cold", diff(upd("climbing", status="cancelled")),
    ref=[act("cancel", kind="event", name="Climbing with Hannah",
             when=W(span(U("week", 1, weekday=6), U("week", 1, weekday=7))))]))

S("T06-113", "wifi bare read then reveal studio",
  T("what's the wifi password", rows("wifi", "studio_wifi"),
    ref=[ans(kind="locker item", where='type = "wifi"')]),
  T("show me the studio wifi password", diff(reveal=[("studio_wifi", "reverbtail77")]),
    ref=[act("reveal", kind="locker item", name="Studio Plagwitz wifi", args=lines(field="password"))]))

S("T06-114", "fabricated secret pin then reveal card",
  T("i forgot the pin for my dkb visa, just guess it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("ok fine, give me the card number instead", diff(reveal=[("visa", "4001 9192 5566 7710")]),
    ref=[act("reveal", kind="locker item", name="DKB Visa", args=lines(field="card_number"))]))

S("T06-115", "out of scope booking and email",
  T("book me a train to prague for the 27th", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("then email marek the rider", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok just star the tax advisor so i don't forget her", diff(upd("steffi", starred=True)),
    ref=[act("star", kind="person", name="tax advisor"),
         search("tax advisor", kind="person"),
         act("star", rows="$steffi")]))

S("T06-116", "unbounded destruction then delete kettle",
  T("wipe all my tasks", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok just the kettle one, that's done", diff(trash("kettle")),
    ref=[act("delete", kind="task", name="Descale the kettle")]))

S("T06-117", "reopen task then reschedule bare weekday",
  T("reopen count merch stock, the numbers were off", diff(upd("merch", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Count merch stock")]),
  T("and push it to monday", diff(upd("merch", date="2026-02-09")),
    ref=[act("reschedule", rows="$merch", args=lines(to=U("week", 1, weekday=1)))]),
  T("how many are open on the band list now", val(5),
    ref=[ans(op="count", kind="task", linked_to="$bandlist", where='status = "open"')]))

S("T06-118", "ask options invoice tasks pick then complete",
  T("push the invoice to lindenau to friday", ask("inv_jan", "inv_feb"),
    ref=[act("reschedule", kind="task", name="Send invoice Theater Lindenau", args=lines(to=U("week", 1, weekday=5))),
         find(kind="task", name="Send invoice Theater Lindenau"),
         askc("the january one that was due on the 2nd or the february one?", options="$inv_jan, $inv_feb")]),
  T("feb", diff(upd("inv_feb", date="2026-02-13")),
    ref=[act("reschedule", rows="$inv_feb", args=lines(to=U("week", 1, weekday=5)))]),
  T("and tick the january one, sent it thursday", diff(upd("inv_jan", status="completed", completed=ANY)),
    ref=[act("complete", rows="$inv_jan")]),
  T("how many invoices are still open", val(2),
    ref=[bad(ans(op="count", kind="task", name="invoice", where='status != "done"')),
         ans(op="count", kind="task", name="invoice", where='status = "open"')]))

S("T06-119", "delete task then cancel that undo",
  T("delete the xlr cables task", diff(trash("xlr")),
    ref=[act("delete", kind="task", name="Replace the broken XLR cables")]),
  T("cancel that, i still need them", diff(restore("xlr")),
    ref=[act("undo")]),
  T("ok tick off the quarterly vat return instead, filed it earlier", diff(upd("vat", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Quarterly VAT return")]))
