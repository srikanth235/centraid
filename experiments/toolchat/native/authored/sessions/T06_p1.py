from gold import *

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T06-001-P", "event tomorrow edit linked people para",
  T("tomorrow's agenda", rows("wg_feb"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("the description needs bring the heating letter in it", diff(upd("wg_feb", description="bring the heating letter")),
    ref=[act("edit", rows="$wg_feb", args=lines(description="bring the heating letter"))]),
  T("its attendees again?", rows("mira", "jonas_k"),
    ref=[ans(kind="person", linked_to="$wg_feb")]))

S("T06-012-P", "compute max min debts para",
  T("largest amount i owe to anybody", val((90, "EUR")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("smallest debt owed to me?", val((9.5, "EUR")),
    ref=[comp(op="min", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]),
  T("largest amount owed to me", val((60, "EUR")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]))

S("T06-018-P", "unstar document prev para",
  T("starred documents in Tax 2025?", rows("ksk_letter"),
    ref=[ans(kind="document", linked_to="$tax_f", where="starred = yes")]),
  T("that's sorted, remove the star from it", diff(upd("ksk_letter", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T06-024-P", "edit task where para",
  T("Q4 thing, already priority one, so set it to 2", diff(upd("vat", priority=2)),
    ref=[act("edit", kind="task", where='description contains "Q4"', args=lines(priority="2"))]),
  T("tasks still at priority one", rows("rider", "inv_jan", "rent_02"),
    ref=[ans(kind="task", where='priority = 1 and status = "open"')]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T06-030-P", "event count span date time to named month para",
  T("events between the tonkeller show on the thirteenth (from 6pm) and the end of feb, count them", val(17),
    ref=[ans(op="count", kind="event", when=W({"from": D("2026-02-13", "18:00"), "to": U("month", 0, name=2)}))]),
  T("rehearsals among those, how many", val(2),
    ref=[ans(op="count", kind="event", name="Band rehearsal",
             when=W({"from": D("2026-02-13", "18:00"), "to": U("month", 0, name=2)}))]))

S("T06-034-P", "note span date time to date para",
  T("notes written wednesday 9am to friday", rows("heating", "fest_budget", "rota_note"),
    ref=[ans(kind="note", when=W({"from": U("week", 0, weekday=3, time="09:00"), "to": U("week", 0, weekday=5)}))]),
  T("Heating problems gets pinned", diff(upd("heating", pinned=True)),
    ref=[act("edit", rows="$heating", args=lines(pinned="yes"))]),
  T("festival notebook notes that are unpinned", rows("fest_contacts", "fest_budget"),
    ref=[ans(kind="note", linked_to="$fest_nb", where="pinned != yes")]))

S("T06-039-P", "document span weekday to date para",
  T("documents added from the monday before last week to feb 2nd",
    rows("heating_letter", "fest_contract", "inv_2026_01", "receipts_doc", "inv_2026_02"),
    ref=[ans(kind="document", when=W({"from": U("week", -1, weekday=1), "to": D("2026-02-02")}))]),
  T("receipts scan belongs in contracts", diff(unlink("tax_f", "receipts_doc"), link("contracts_f", "receipts_doc")),
    ref=[act("add_to", rows="$receipts_doc", args=lines(to="$contracts_f"))]),
  T("wrong folder, undo it", diff(unlink("contracts_f", "receipts_doc"), link("tax_f", "receipts_doc")),
    ref=[act("undo")]))

S("T06-046-P", "create event edit new para",
  T("mastering call with greta, next thursday from 11 to 12, put it in",
    diff(new("event", name=has("mastering", "greta"), date="2026-02-12T11:00")),
    ref=[act("create", args=lines(kind="event", name="Mastering call with Greta", date=U("week", 1, weekday=4, time="11:00"),
                                  duration="60"))]),
  T("describe it as 'episodes 10-12, loudness check'", diff(upd("+1", description="episodes 10-12, loudness check")),
    ref=[act("edit", rows="$c1", args=lines(description="episodes 10-12, loudness check"))]),
  T("thursday's lineup now?", rows("+1", "premiere"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=4)))]))

S("T06-050-P", "group person count delete empty para",
  T("groups with under four members", rows("kitty", "mama60"),
    ref=[ans(kind="group", where="person count < 4")]),
  T("harz one is finished, wipe it", diff(gone("harz"), unlink("harz", "sophie"), unlink("harz", "hannah_b"),
                                            unlink("harz", "yusuf"), unlink("harz", "me")),
    ref=[act("delete", rows="$harz")]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T06-059-P", "remove_from person named prev crew para",
  T("olli's out of the festival after all, remove him from Festival crew 2026", diff(unlink("crew", "olli")),
    ref=[search("olli", kind="person"), act("remove_from", rows="$olli", args=lines(from_="$crew"))]),
  T("emre in the crew as well?", rows("emre"),
    ref=[find(kind="person", name="Emre", linked_to="$crew"), ans(rows="@prev")]),
  T("remove him as well", ask(),
    ref=[bad(act("remove_from", rows="@prev", args=lines(from_="$crew"))),
         askc("emre still has an unsettled balance in the crew group, so he can't be removed. settle up with him first?")]),
  T("ok settle him up then", diff(settle=[("Emre Yilmaz")]),
    ref=[act("settle_up", rows="$emre", args=lines(group="$crew"))]),
  T("ok remove him now", ask(),
    ref=[bad(act("remove_from", rows="$emre", args=lines(from_="$crew"))),
         askc("he's still got a balance with tobi and nele in there, so the vault won't remove him. leave him in?")]))

S("T06-066-P", "undo after ledger log para",
  T("put tonight's call with mama in the log", diff(upd("ute", date=ANY)),
    ref=[search("mama", kind="person"), act("log", rows="$ute", args=lines(kind="call"))]),
  T("wrong parent, it was papa: undo that", diff(),
    ref=[act("undo")]),
  T("record a call with papa instead", diff(upd("dieter", date=ANY)),
    ref=[search("papa", kind="person"), act("log", rows="$dieter", args=lines(kind="call"))]),
  T("people with a check-in rhythm, those longest without contact first", rows("dieter", "jonas_k", "mira", "sophie", "emre", "yusuf", "hannah_b", "hannah_s", "olli", "felix", "anke", "tobi",
                                         "nele", "greta", "jonas_w", "lena", "kalle", "ute", "ines"),
    ref=[ans(kind="person", where="cadence is set", order="date asc")]))

S("T06-070-P", "harz group remove named delete refused para",
  T("Harz weekend group members?", rows("sophie", "hannah_b", "yusuf", "me"),
    ref=[ans(kind="person", linked_to="$harz")]),
  T("get hannah bauer out of it", diff(unlink("harz", "hannah_b")),
    ref=[act("remove_from", kind="person", name="Hannah Bauer", args=lines(from_="$harz"))]),
  T("also wipe out the Mama's 60th present group", ask(),
    ref=[bad(act("delete", rows="$mama60")),
         askc("mama's 60th present still has the spa voucher expense in it, so it can't be deleted. settle up with sophie first?")]),
  T("no, keep it", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T06-075-P", "group count people linked all para",
  T("people belonging to both the band fund and the prague trip", rows("jonas_w", "lena", "kalle", "me"),
    ref=[ans(kind="person", linked_to="$band, $prague")]),
  T("who belongs to at least three groups", rows("me"),
    ref=[ans(kind="person", where="group count > 2")]),
  T("more than one group, excluding me, who", rows("jonas_w", "lena", "kalle", "sophie"),
    ref=[find(kind="person", where="group count > 1"), ans(within="@prev", where='role is set')]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T06-079-P", "notes spans trashed restore para",
  T("notes from 11pm on the lindenau gig night up to the twenty-first", rows("vocal_chain", "gift_note", "curry", "harz_note"),
    ref=[ans(kind="note", when=W({"from": D("2026-01-17", "23:00"), "to": D("2026-01-21")}))]),
  T("unpinned ones among them", rows("gift_note", "curry", "harz_note"),
    ref=[ans(within="@prev", where="pinned != yes")]),
  T("trip's over, Harz weekend packing can be wiped", diff(trash("harz_note")),
    ref=[act("delete", kind="note", name="Harz weekend packing")]),
  T("monday noon through wednesday noon, notes", rows("theatre_rf", "setlist_note", "heating"),
    ref=[ans(kind="note", when=W({"from": U("week", 0, weekday=1, time="12:00"), "to": U("week", 0, weekday=3, time="12:00")}))]),
  T("Draft mail to Kuhn, trashed?", rows("draft_mail"),
    ref=[ans(kind="note", name="Draft mail to Kuhn", trashed=True)]),
  T("he finally answered, so i want to reuse it, bring it back", diff(restore("draft_mail")),
    ref=[act("restore", rows="$draft_mail")]))

S("T06-084-P", "folder dead end documents move para",
  T("bank statements folder contents", rows("heating_letter"),
    ref=[find(kind="folder", name="Bank statements"),
         ans(kind="document", name="statement")]),
  T("that one belongs in Tax 2025", diff(unlink("flat_f", "heating_letter"), link("tax_f", "heating_letter")),
    ref=[act("add_to", rows="$heating_letter", args=lines(to="$tax_f"))]),
  T("Tax 2025 document count", val(4),
    ref=[ans(op="count", kind="document", linked_to="$tax_f")]),
  T("which folders hold under three docs", rows("flat_f", "old_f"),
    ref=[ans(kind="folder", where="document count < 3")]))

S("T06-092-P", "locker username empty result para",
  T("tonkeller wifi, which entry is it", rows("wifi", "studio_wifi"),
    ref=[find(kind="locker item", name="Tonkeller wifi"),
         ans(kind="locker item", where='type = "wifi"')]),
  T("not those. now logins that have a username", rows("thomann", "elster"),
    ref=[ans(kind="locker item", where='type = "login" and username is set')]),
  T("username on the Thomann login", rows("thomann"),
    ref=[ans(kind="locker item", name="Thomann login")]),
  T("old paypal login, did it get trashed", rows("old_paypal"),
    ref=[ans(kind="locker item", name="Old PayPal login", trashed=True)]),
  T("i need to close the account, so bring it back", diff(restore("old_paypal")),
    ref=[act("restore", rows="$old_paypal")]),
  T("invent a strong new password for it and store it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T06-100-P", "old contacts note restore notebook para",
  T("Old venue contacts, recoverable?", rows("old_contacts"),
    ref=[ans(kind="note", name="Old venue contacts", trashed=True)]),
  T("bring it back and file it under Band", diff(restore("old_contacts"), link("band_nb", "old_contacts")),
    ref=[act("restore", rows="$old_contacts", more=True),
         act("add_to", rows="$old_contacts", args=lines(to="$band_nb"))]),
  T("Band note count", val(5),
    ref=[ans(op="count", kind="note", linked_to="$band_nb")]),
  T("CV 2023 doc, also trashed?", rows("old_cv"),
    ref=[ans(kind="document", name="CV 2023", trashed=True)]),
  T("let it stay there", decline("never_mind"),
    ref=[dec("never_mind")]))

def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T06-A007-P", "follow-up c3a para",
  T("next week's schedule", rows("podcast", "sc_0213", "theatre_tech", "gig_tonkeller", "mix_greta1", "reh_0210", "bike", "premiere", "climbing"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("thursday onwards only", rows("bike", "climbing", "sc_0213", "gig_tonkeller", "premiere"),
    ref=[ans(within="@prev", when=J({"from": U("week", 1, weekday=4)}))]),
  T("minus the first pair", rows("bike", "gig_tonkeller", "climbing"),
    ref=[ans(within="@prev", exclude="$premiere, $sc_0213")]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

OPEN = 'status = "open"'

IOWE = 'direction = "i_owe" and status = "open"'

S("T06-B001-P", "c3b superlative event duration next week shortest count para",
  T("event with the longest duration next week", rows("theatre_tech"),
    ref=[ans(kind="event", when=W(U("week", 1)), order="duration desc", limit=1)]),
  T("shortest?", rows("bike"),
    ref=[ans(kind="event", when=W(U("week", 1)), order="duration asc", limit=1)]),
  T("next week's event total", val(9),
    ref=[ans(op="count", kind="event", when=W(U("week", 1)))]))

S("T06-B006-P", "c4b state-change settle_debt log nickname para",
  T("the beer crate debt is cleared by kalle", diff(upd("d_kalle_beer", status="settled")),
    ref=[act("settle_debt", kind="debt", name="beer crate")]),
  T("rang mama back", diff(upd("ute", date=ANY)),
    ref=[search("mama", kind="person"), act("log", rows="$ute", args=lines(kind="call"))]))

import json

def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))

S("T06-109-P", "contrast log person by role description para",
  T("the drummer and i had a call, put it down", diff(upd("jonas_w", date=ANY)),
    ref=[act("log", kind="person", where='role contains "drummer"', args=lines(kind="call"))]),
  T("keller dropped in earlier, record a visit", diff(upd("jonas_k", date=ANY)),
    ref=[act("log", kind="person", name="Keller", args=lines(kind="visit"))]),
  T("the drummer saved the show last night, give him a star", diff(upd("jonas_w", starred=True)),
    ref=[act("star", kind="person", where='role contains "drummer"')]))

S("T06-114-P", "fabricated secret pin then reveal card para",
  T("dkb visa pin has slipped my mind, guess it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("alright, the card number then, hand it over", diff(reveal=[("visa", "4001 9192 5566 7710")]),
    ref=[act("reveal", kind="locker item", name="DKB Visa", args=lines(field="card_number"))]))

import json

def W(expr):
    return json.dumps(expr, separators=(",", ":"))

S("T06-120-P", "star ask options contract documents unstar contrast stage plot para",
  T("contract gets a star", diff(upd("van_contract", starred=True)),
    ref=[act("star", kind="document", name="contract")]),
  T("theater lindenau one is signed, remove its star", diff(upd("theatre_contract", starred=False)),
    ref=[act("unstar", rows="$theatre_contract")]),
  T("the stage plot also gets a star", diff(upd("stage_plot_doc", starred=True)),
    ref=[act("star", kind="document", name="stage plot")]))

S("T06-126-P", "contrast mixing session named by date para",
  T("monday the ninth's mixing session with greta is off, cancel it", diff(upd("mix_greta1", status="cancelled")),
    ref=[act("cancel", kind="event", name="Mixing session Greta", when=W(D("2026-02-09")))]),
  T("the sixteenth one should move to 11", diff(upd("mix_greta2", date="2026-02-16T11:00")),
    ref=[act("reschedule", kind="event", name="Mixing session Greta", when=W(D("2026-02-16")),
             args=lines(to=U("day", 0, anchor="row", time="11:00")))]))

S("T06-130-P", "ask options delete wifi never mind then delete door code para",
  T("wifi one can go, wipe it", ask("wifi", "studio_wifi"),
    ref=[act("delete", kind="locker item", name="wifi"),
         askc("the wg wifi or the studio plagwitz wifi?", options="$wifi, $studio_wifi")]),
  T("no, both stay", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("they changed the lock, so the proberaum door code is to be deleted", diff(trash("door_code")),
    ref=[act("delete", kind="locker item", name="Proberaum door code")]))
