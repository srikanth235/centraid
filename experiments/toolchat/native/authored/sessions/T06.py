from gold import *
import json

world("T06", "2026-02-07T23:15", "Lukas Brandt", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T06-001", "event tomorrow edit linked people",
  T("what's on tmrw", rows("wg_feb"),
    ref=[ans(kind="event", when=W(U("day", 1)))]),
  T("add to the description: bring the heating letter", diff(upd("wg_feb", description="bring the heating letter")),
    ref=[act("edit", rows="$wg_feb", args=lines(description="bring the heating letter"))]),
  T("who's in it again", rows("mira", "jonas_k"),
    ref=[ans(kind="person", linked_to="$wg_feb")]))

S("T06-004", "search miss then fix, reveal named",
  T("what's the netflix password", decline("not_found"),
    ref=[search("netflix", kind="locker item"), dec("not_found")]),
  T("ok show me the wg wifi password", diff(reveal=[("wifi", "plagwitz-kasse-42")]),
    ref=[act("reveal", kind="locker item", name="WG wifi", args=lines(field="password"))]),
  T("and which locker stuff has a username on it", rows("thomann", "elster"),
    ref=[ans(kind="locker item", where="username is set")]))

S("T06-005", "settle debt new undo ledger",
  T("kalle owes me 18 for the pizza after rehearsal",
    diff(new("debt", name=has("pizza"), amount=18, direction="owes_me"), link("new", "kalle")),
    ref=[search("kalle", kind="person"),
         act("create", args=lines(kind="debt", name="Pizza after rehearsal", amount="18", direction="owes_me", person="$kalle"))]),
  T("he paid it, mark it settled", diff(upd("+1", status="settled")),
    ref=[act("settle_debt", rows="$c1")]),
  T("wait undo that, it was the strings money he paid", diff(),
    ref=[act("undo")]),
  T("fine, settle the guitar strings one instead", diff(upd("d_kalle_strings", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Guitar strings")]))

S("T06-006", "task effort unit where",
  T("anything that takes exactly half an hour", rows("snake", "cleaning_rota", "rates", "xlr", "climb_shoes"),
    ref=[ans(kind="task", where='effort = 30 minutes and status = "open"')]))

S("T06-007", "restore photo named trashed",
  T("the blurry soundcheck shot, is it gone for good?", rows("p_blurry"),
    ref=[ans(kind="photo", name="Blurry soundcheck shot", trashed=True)]),
  T("bring it back, ines wants it for the grain", diff(restore("p_blurry")),
    ref=[act("restore", kind="photo", name="Blurry soundcheck shot", trashed=True)]),
  T("and put it in the gigs album", diff(link("gig_album", "p_blurry")),
    ref=[act("add_to", rows="$p_blurry", args=lines(to="$gig_album"))]))

S("T06-008", "restore window refused decline",
  T("restore the old tour van pic", rows("p_old_van"),
    ref=[bad(act("restore", kind="photo", name="Old tour van", trashed=True)),
         ans(kind="photo", name="Old tour van", trashed=True)]),
  T("damn. what else is in the photo trash", rows("p_blurry", "p_screenshot"),
    ref=[ans(kind="photo", trashed=True, exclude="$p_old_van")]))

S("T06-009", "edit person multi cadence",
  T("i want to check in with mira hoffmann and jonas keller every three days, they're both struggling",
    diff(upd("mira", cadence=3), upd("jonas_k", cadence=3)),
    ref=[act("edit", rows="$mira, $jonas_k", args=lines(cadence="3"))]),
  T("who else is on short check ins, under a week", rows(),
    ref=[ans(kind="person", where="cadence < 7", exclude="$mira, $jonas_k")]))

S("T06-010", "create person edit new add_to group",
  T("add a contact: Milan Horak, sound guy, Klub Rybka",
    diff(new("person", name="Milan Horak", role=has("sound"))),
    ref=[act("create", args=lines(kind="person", name="Milan Horak", role="sound guy, Klub Rybka"))]),
  T("his nickname is Mili", diff(upd("+1", nickname="Mili")),
    ref=[act("edit", rows="$c1", args=lines(nickname="Mili"))]),
  T("and put him in the prague trip group", diff(link("prague", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$prague"))]),
  T("and who's in Prague gig trip at this point", rows("jonas_w", "lena", "kalle", "marek", "+1", "me"),
    ref=[ans(kind="person", linked_to="$prague")]))

S("T06-011", "remove_from person prev zero balance",
  T("is marek in the prague group? take him out, he's not coming with us", diff(unlink("prague", "marek")),
    ref=[find(kind="person", name="Marek", linked_to="$prague"),
         act("remove_from", rows="@prev", args=lines(from_="$prague"))]),
  T("who's left in it", rows("jonas_w", "lena", "kalle", "me"),
    ref=[ans(kind="person", linked_to="$prague")]),
  T("how much am i up or down in it", val((1400, "CZK")),
    ref=[ans(op="balance", kind="group", name="Prague gig trip", linked_to="$me")]))

S("T06-012", "compute max min debts",
  T("biggest thing i owe anyone right", val((90, "EUR")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]),
  T("and the smallest thing people owe me", val((9.5, "EUR")),
    ref=[comp(op="min", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]),
  T("what's the most anyone owes me", val((60, "EUR")),
    ref=[comp(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"'),
         ans(value="@prev")]))

S("T06-013", "folder empty result recovery",
  T("what's in my receipts folder", rows("receipts_doc"),
    ref=[find(kind="folder", name="Receipts"),
         ans(kind="document", name="Receipts")]),
  T("star that scan", diff(upd("receipts_doc", starred=True)),
    ref=[act("star", rows="$receipts_doc")]),
  T("docs sitting loose, no folder", rows("manual", "rental_offer", "van_contract"),
    ref=[ans(kind="document", where="folder count < 1")]))

S("T06-014", "event overlap refused create",
  T("put a call with pavla on tuesday at 7pm, about monitors", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Call with Pavla", date=U("week", 1, weekday=2, time="19:00")))),
         askc("tuesday 7pm clashes with band rehearsal. want it earlier, like 17:00?")]),
  T("ok 5 then", diff(new("event", name="Call with Pavla", date="2026-02-10T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Pavla", date=U("week", 1, weekday=2, time="17:00")))]),
  T("what's tuesday look like", rows("theatre_tech", "+1", "reh_0210"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=2)))]))

S("T06-015", "remove_from person named group",
  T("take yusuf out of the harz weekend group", diff(unlink("harz", "yusuf")),
    ref=[act("remove_from", kind="person", name="Yusuf Demir", args=lines(from_="$harz"))]),
  T("and delete the group, the trip's done", diff(gone("harz"), unlink("harz", "sophie"), unlink("harz", "hannah_b"),
                                                       unlink("harz", "me")),
    ref=[act("delete", rows="$harz")]))

S("T06-016", "delete group refused",
  T("delete the band fund group", ask(),
    ref=[bad(act("delete", rows="$band")),
         askc("it still has expenses in it, so the vault won't delete it. settle up with everyone first?")]))

S("T06-017", "star document where",
  T("star the doc i saved on thursday", diff(upd("rental_offer", starred=True)),
    ref=[act("star", kind="document", when=W(U("week", 0, weekday=4)))]),
  T("what's starred now", rows("theatre_contract", "ksk_letter", "rider_doc", "rental_offer"),
    ref=[ans(kind="document", where="starred = yes")]))

S("T06-018", "unstar document prev",
  T("anything starred in Tax 2025?", rows("ksk_letter"),
    ref=[ans(kind="document", linked_to="$tax_f", where="starred = yes")]),
  T("unstar that, it's sorted", diff(upd("ksk_letter", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T06-019", "star photo multi",
  T("pics in Harz weekend with sophie in them", rows("p_brocken", "p_hut", "p_sophie_sled"),
    ref=[ans(kind="photo", linked_to="$harz_album, $sophie")]),
  T("star the hut one and the sled one", diff(upd("p_hut", starred=True), upd("p_sophie_sled", starred=True)),
    ref=[act("star", rows="$p_hut, $p_sophie_sled")]))

S("T06-020", "delete album where",
  T("get rid of the empty album", diff(gone("prague_album")),
    ref=[act("delete", kind="album", where="photo count = 0")]))

S("T06-021", "star locker where",
  T("star my ssh key", diff(upd("nas_ssh", starred=True)),
    ref=[act("star", kind="locker item", where='type = "ssh_key"')]),
  T("what ids and passports have i got in there", rows("id_card", "passport", "licence"),
    ref=[ans(kind="locker item", where='type in ("identity", "passport", "driving_licence")')]))

S("T06-022", "edit folder where",
  T("rename the folder with nothing in it to Archive", diff(upd("old_f", name="Archive")),
    ref=[act("edit", kind="folder", where="document count = 0", args=lines(name="Archive"))]),
  T("and delete the invoices folder, i keep them in lexoffice", ask(),
    ref=[bad(act("delete", rows="$inv_f")),
         askc("the invoices folder still has 3 documents, so it can't be deleted. move or delete them first?")]))

S("T06-023", "edit list named",
  T("rename the gear list to Gear and repairs", diff(upd("gearlist", name="Gear and repairs")),
    ref=[act("edit", rows="$gearlist", args=lines(name="Gear and repairs"))]),
  T("which lists are work stuff", rows("adminlist", "festlist"),
    ref=[ans(kind="list", where='area = "work"')]))

S("T06-024", "edit task where",
  T("bump the Q4 thing to priority one... wait it is. make it 2", diff(upd("vat", priority=2)),
    ref=[act("edit", kind="task", where='description contains "Q4"', args=lines(priority="2"))]),
  T("what's still priority one", rows("rider", "inv_jan", "rent_02"),
    ref=[ans(kind="task", where='priority = 1 and status = "open"')]))

S("T06-025", "reschedule task named",
  T("move call herr kuhn about the heating to monday week", diff(upd("kuhn_heat", date="2026-02-16")),
    ref=[act("reschedule", kind="task", name="Call Herr Kuhn about the heating", args=lines(to=U("week", 2, weekday=1)))]),
  T("and what's on the flat list that's open", rows("kuhn_heat", "bin_bags", "fridge", "cleaning_rota", "kitty_02", "rent_02", "rent_03"),
    ref=[ans(kind="task", linked_to="$flatlist", where='status = "open"')]))
