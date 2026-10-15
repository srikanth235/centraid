from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T04-026", "person edit repair decline",
  T("daniel osei's nickname should be Danny O not Dan", diff(upd("dan", nickname="Danny O")),
    ref=[act("edit", kind="person", name="Daniel Osei", args=lines(nickname="Danny O"))]),
  T("and save his bleep 4471", decline("out_of_scope"),
    ref=[bad(act("edit", rows="$dan", args=lines(bleep="4471"))),
         dec("out_of_scope")]))

S("T04-033", "documents folder count trashed restore multi window refusal unstar",
  T("any documents not filed in a folder", rows("payslip"),
    ref=[ans(kind="document", where="folder count = 0")]),
  T("what's in the docs trash", rows("old_cv", "old_tenancy", "gym_contract"),
    ref=[ans(kind="document", trashed=True)]),
  T("restore the cv and the puregym contract", diff(restore("old_cv"), restore("gym_contract")),
    ref=[act("restore", rows="$old_cv, $gym_contract")]),
  T("and the 2025 tenancy", ask(),
    ref=[find(kind="document", name="Tenancy", trashed=True),
         bad(act("restore", rows="$old_tenancy")),
         askc("that one's been in the bin since august, past the 30 days, so it can't come back. want me to add a fresh doc for it?")]),
  T("no leave it. unstar the oakwood hall contract while i'm here", diff(upd("venue_contract", starred=False)),
    ref=[act("unstar", kind="document", name="Oakwood Hall contract")]))

S("T04-034", "folders document count delete prev undo create add_to",
  T("any folder stuffed with over three documents", rows("wed_f", "work_f"),
    ref=[ans(kind="folder", where="document count > 3")]),
  T("any empty ones", rows("scans_f", "receipts_f"),
    ref=[ans(kind="folder", where="document count = 0")]),
  T("delete them", diff(gone("scans_f"), gone("receipts_f")),
    ref=[act("delete", rows="@prev")]),
  T("undo that", diff(),
    ref=[act("undo")]),
  T("fine. make a folder called Payslips and put payslip september in it",
    diff(new("folder", name="Payslips"), link("new", "payslip")),
    ref=[act("create", more=True, args=lines(kind="folder", name="Payslips")),
         act("add_to", kind="document", name="Payslip September", args=lines(to="$new"))]),
  T("what's in payslips now", rows("payslip"),
    ref=[ans(kind="document", linked_to="$c1")]))

S("T04-035", "folder create delete multi refused non-empty",
  T("new folder Istanbul receipts", diff(new("folder", name="Istanbul receipts")),
    ref=[act("create", args=lines(kind="folder", name="Istanbul receipts"))]),
  T("delete the scans and receipts folders, both empty", diff(gone("scans_f"), gone("receipts_f")),
    ref=[act("delete", rows="$scans_f, $receipts_f")]),
  T("and the house folder", rows("tenancy", "council_bill"),
    ref=[bad(act("delete", rows="$house_f")),
         ans(kind="document", linked_to="$house_f")]))

S("T04-036", "photos named month span delete prev knock-on undo",
  T("pics from march to may", rows("ring", "engagement", "mum_kitchen", "eid"),
    ref=[ans(kind="photo", when=W({"from": U("month", 0, name=3), "to": U("month", 0, name=5)}))]),
  T("which one's from april", rows("mum_kitchen"),
    ref=[ans(kind="photo", within="@prev", when=W(U("month", 0, name=4)))]),
  T("delete it, it's blurry", diff(trash("mum_kitchen"), unlink("fam_album", "mum_kitchen")),
    ref=[act("delete", rows="@prev")]),
  T("undo, she loves that one", diff(restore("mum_kitchen"), link("fam_album", "mum_kitchen")),
    ref=[act("undo")]),
  T("how many in the family album", val(7),
    ref=[ans(op="count", kind="photo", linked_to="$fam_album")]))

S("T04-037", "photos date span delete prev knock-on",
  T("photos from 1 to twelfth sept", rows("enlarger", "fabric", "invite_pic", "fb_shelves"),
    ref=[ans(kind="photo", when=W({"from": D("2026-09-01"), "to": D("2026-09-12")}))]),
  T("which of them has nobody in it", rows("invite_pic"),
    ref=[ans(kind="photo", within="@prev", where="person count = 0")]),
  T("delete it, zainab has the real one", diff(trash("invite_pic"), unlink("wed_album", "invite_pic")),
    ref=[act("delete", rows="@prev")]))

S("T04-038", "photo count star where album edit multi",
  T("who's in at least four photos", rows("zainab"),
    ref=[ans(kind="person", where="photo count >= 4")]),
  T("star the pic that's in no album and has nobody in it", diff(upd("car_pic", starred=True)),
    ref=[act("star", kind="photo", where="album count = 0 and person count = 0 and starred = no")]),
  T("rename the wedding prep and istanbul hen do albums both to Zainab 2026",
    diff(upd("wed_album", name="Zainab 2026"), upd("ist_album", name="Zainab 2026")),
    ref=[act("edit", rows="$wed_album, $ist_album", args=lines(name="Zainab 2026"))]))

S("T04-039", "photos september album count star where march",
  T("how many photos from september", val(18),
    ref=[ans(op="count", kind="photo", when=W(U("month", 0, name=9)))]),
  T("which of them aren't in any album", rows("house_dinner", "ward_cake", "leah_selfie"),
    ref=[ans(kind="photo", when=W(U("month", 0, name=9)), where="album count < 1")]),
  T("star the one with leah morgan in it", diff(upd("leah_selfie", starred=True)),
    ref=[act("star", kind="photo", linked_to="$leah")]),
  T("and what's from march", rows("ring", "engagement"),
    ref=[ans(kind="photo", when=W(U("month", 0, name=3)))]))

S("T04-042", "locker username in trashed restore multi reveal count",
  T("which logins use arahman or arahman92", rows("horus"),
    ref=[ans(kind="locker item", where='username in ("arahman", "arahman92")')]),
  T("anything in the locker that i've binned", rows("santander", "netflix"),
    ref=[ans(kind="locker item", trashed=True)]),
  T("restore both", diff(restore("santander"), restore("netflix")),
    ref=[act("restore", rows="@prev")]),
  T("show me the old netflix login password", diff(reveal=[("netflix", "bingewatch92")]),
    ref=[act("reveal", rows="$netflix", args=lines(field="password"))]),
  T("how many logins have i got", val(4),
    ref=[ans(op="count", kind="locker item", where='type = "login"')]))

S("T04-043", "locker empty result not_found create star unstar new",
  T("what's my disney plus login", decline("not_found"),
    ref=[ans(kind="locker item", name="Disney plus"), dec("not_found")]),
  T("pull every login saved in my locker", rows("nhsmail", "horus"),
    ref=[ans(kind="locker item", where='type = "login"')]),
  T("save disney plus as a login, username aisha.r92@gmail.com",
    diff(new("locker item", name="Disney plus", type="login")),
    ref=[act("create", args=lines(kind="locker item", name="Disney plus", type="login", username="aisha.r92@gmail.com"))]),
  T("star it", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$new")]),
  T("hmm unstar the disney one, i barely watch it", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))

S("T04-044", "locker empty result create star unstar new",
  T("what's the darkroom door code", decline("not_found"),
    ref=[ans(kind="locker item", name="Darkroom door code"), dec("not_found")]),
  T("save it as a note then, its 1966# on the keypad", diff(new("locker item", name="Darkroom door code", type="note")),
    ref=[act("create", args=lines(kind="locker item", name="Darkroom door code", type="note", notes="1966# on the keypad"))]),
  T("star it for now, then unstar it once i know it", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$new")]),
  T("ok i know it now, unstar the door code", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))

S("T04-045", "notes since date create add_to new delete restore new",
  T("notes since the first of october",
    rows("mehndi_songs", "budget", "journal", "gift_ideas", "fb_hampers", "ist_packing"),
    ref=[ans(kind="note", when=W({"from": D("2026-10-01")}))]),
  T("new note ALS algorithm, shockable rhythms VF and pVT, two mins CPR between shocks",
    diff(new("note", name=has("ALS"), body=has("CPR"))),
    ref=[act("create", args=lines(kind="note", name="ALS algorithm", body="shockable rhythms VF and pVT, 2 mins CPR between shocks"))]),
  T("put it in medicine", diff(link("med_nb", "+1")),
    ref=[act("add_to", rows="$new", args=lines(to="$med_nb"))]),
  T("delete it, the course hands out a card", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("hm no bring it back, the card's tiny", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T04-046", "notes count to last month body is set trashed restore window",
  T("how many notes did i write up to the end of last month", val(17),
    ref=[ans(op="count", kind="note", when=W({"to": U("month", -1)}))]),
  T("which of the film photography ones actually have anything written in them",
    rows("portra", "hp5_dev", "whitby_notes", "cameras"),
    ref=[ans(kind="note", linked_to="$film_nb", where="body is set")]),
  T("what's in the notes trash", rows("old_revision", "old_nights"),
    ref=[ans(kind="note", trashed=True)]),
  T("restore the night shift snacks one", ask(),
    ref=[bad(act("restore", rows="$old_nights")),
         askc("night shift snacks went in the bin in august, past the 30 day window, so it can't be restored. want it as a new note?")]))

S("T04-047", "note create add_to new before date time",
  T("new note locum rates, AMU 45 an hour and ED 55 at weekends",
    diff(new("note", name=has("Locum"), body=has("45"))),
    ref=[act("create", args=lines(kind="note", name="Locum rates", body="AMU 45 an hour and ED 55 at weekends"))]),
  T("file it under medicine", diff(link("med_nb", "+1")),
    ref=[act("add_to", rows="$new", args=lines(to="$med_nb"))]),
  T("any notes from before tenth aug at midday", rows("portra", "cameras"),
    ref=[ans(kind="note", when=W({"to": D("2026-08-10", "12:00")}))]))

S("T04-048", "notebook notes create delete restore new",
  T("what's in the food bank notebook", rows("fb_rules", "fb_hampers"),
    ref=[ans(kind="note", linked_to="$fb_nb")]),
  T("add one there, ask pete about borrowing the church van for hampers",
    diff(new("note", name=has("van"), body=has("Pete")), link("fb_nb", "new")),
    ref=[act("create", args=lines(kind="note", name="Church van", body="ask Pete about borrowing the church van for hampers",
                                  notebook="$fb_nb"))]),
  T("delete that, pete said no", diff(trash("+1")),
    ref=[act("delete", rows="$new")]),
  T("ugh he changed his mind, restore it", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T04-050", "notes august span notebook note count",
  T("which notes did i write from first aug to the end of august", rows("sepsis", "dka", "guest_list"),
    ref=[ans(kind="note", when=W({"from": D("2026-08-01"), "to": U("month", 0, name=8)}))]),
  T("which notebooks have two notes or fewer", rows("fb_nb", "old_nb"),
    ref=[ans(kind="notebook", where="note count <= 2")]))
