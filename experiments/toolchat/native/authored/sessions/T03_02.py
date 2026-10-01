from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T03-026", "ambiguity log ask pick edit role",
  T("log a coffee w pedro, had one", ask("pedro_a", "pedro_c"),
    ref=[act("log", kind="person", name="Pedro", args=lines(kind="coffee")),
         askc("pedro almeida or pedro costa?", options="$pedro_a, $pedro_c")]),
  T("almeida", diff(upd("pedro_a", date=ANY)),
    ref=[act("log", rows="$pedro_a", args=lines(kind="coffee"))]),
  T("and his role's physics teacher and deputy director",
    diff(upd("pedro_a", role="physics teacher, deputy director")),
    ref=[act("edit", rows="$pedro_a", args=lines(role="physics teacher, deputy director"))]))

S("T03-027", "person starred unstar nickname",
  T("who have i got starred", rows("joana", "tiago", "graca"),
    ref=[ans(kind="person", where="starred = yes")]),
  T("take the star off tiago silva, he's on speed dial", diff(upd("tiago", starred=False)),
    ref=[act("unstar", rows="$tiago")]),
  T("who's got a nickname saved",
    rows("joana", "graca", "ana_lopes", "vitor", "miguel", "ricardo", "henrique", "armando", "ze"),
    ref=[ans(kind="person", where="nickname is set")]))

S("T03-028", "person delete undo restore trashed",
  T("delete filipa gomes from my contacts", diff(trash("filipa")),
    ref=[act("delete", kind="person", name="Filipa Gomes")]),
  T("hm no undo, she's in the dinners group", diff(restore("filipa")),
    ref=[act("undo")]),
  T("and carlos vieira's back helping at futsal, bring him back", diff(restore("carlos")),
    ref=[find(kind="person", trashed=True), act("restore", kind="person", name="Carlos Vieira", trashed=True)]))

S("T03-029", "group balance settle_up remove_from",
  T("what's ricky's balance in friday dinners", val((-39.2, "EUR")),
    ref=[search("ricky", kind="person"),
         ans(op="balance", kind="group", name="Friday dinners", linked_to="$ricardo")]),
  T("settle him up, he moved to braga", diff(settle=[("Ricardo Barros", "12.80")]),
    ref=[act("settle_up", rows="$ricardo", args=lines(group="$jantares"))]),
  T("so am i square with ricardo barros", val((-20, "EUR")),
    ref=[ans(op="balance", rows="$ricardo")]))

S("T03-030", "group members remove_from delete",
  T("who's in magusto 2026", rows("joana", "graca", "marta", "me"),
    ref=[ans(kind="person", linked_to="$magusto_g")]),
  T("take marta out, she can't come up", diff(unlink("magusto_g", "marta")),
    ref=[act("remove_from", rows="$marta", args=lines(from_="$magusto_g"))]),
  T("delete the group, we'll do it at mãe's",
    diff(gone("magusto_g"), unlink("magusto_g", "joana"), unlink("magusto_g", "graca"), unlink("magusto_g", "me")),
    ref=[act("delete", rows="$magusto_g")]))

S("T03-031", "group currency edit count",
  T("which of my groups aren't in euros", rows("brasil"),
    ref=[ans(kind="group", where='currency != "EUR"')]),
  T("rename it Salvador 2026", diff(upd("brasil", name="Salvador 2026")),
    ref=[act("edit", rows="$brasil", args=lines(name="Salvador 2026"))]),
  T("how many ppl in brasil 2026", val(4),
    ref=[ans(op="count", kind="person", linked_to="$brasil")]))

S("T03-032", "event cancel delete restore trashed",
  T("cancel the car inspection on the thirtieth", diff(upd("ipo_ev", status="cancelled")),
    ref=[act("cancel", kind="event", name="Car inspection")]))

S("T03-033", "task edit already",
  T("mark 9b tests are gonna take four hrs not 3", diff(upd("mark_9b", effort=240)),
    ref=[act("edit", kind="task", name="Mark 9B tests", args=lines(effort=240))]))

S("T03-034", "task reopen reschedule subtasks",
  T("reopen order burettes, half came broken", diff(upd("burettes", status="open", completed=None)),
    ref=[act("reopen", kind="task", name="Order burettes")]),
  T("order burettes due next wed", diff(upd("burettes", date="2026-10-21")),
    ref=[act("reschedule", rows="$burettes", args=lines(to=U("week", 1, weekday=3)))]),
  T("what's not done under the titration practical", rows("burettes", "worksheet", "naoh"),
    ref=[ans(kind="task", linked_to="$titration", where='status != "completed"')]))

S("T03-035", "task trashed restore delete",
  T("any tasks i deleted", rows("gym", "ink", "old_bike", "flu_jab"),
    ref=[ans(kind="task", trashed=True)]),
  T("restore buy printer ink", diff(restore("ink")),
    ref=[act("restore", rows="$ink")]))

S("T03-036", "task add_to remove_from list",
  T("put sort brazil photos on the home list", diff(link("home", "brasil_photos")),
    ref=[act("add_to", kind="task", name="Sort Brazil photos", args=lines(to="$home"))]))

S("T03-037", "note open edit trashed restore",
  T("add 'flu jab?' to the questions for the cardiologist",
    diff(upd("cardio_q", body="swollen ankles; can she stop the statin; is she ok to drive; flu jab?")),
    ref=[opn("$cardio_q"),
         act("edit", rows="$cardio_q", args=lines(body="swollen ankles; can she stop the statin; is she ok to drive; flu jab?"))]),
  T("is the old futsal lineup note in the trash", rows("old_lineup"),
    ref=[ans(kind="note", name="Old futsal lineup", trashed=True)]),
  T("restore old futsal lineup, need carlos's kid's position", diff(restore("old_lineup")),
    ref=[act("restore", rows="$old_lineup")]))

S("T03-038", "note add_to remove_from",
  T("file tiago's sizes under futsal", diff(link("futsal_nb", "sizes")),
    ref=[act("add_to", kind="note", name="Tiago's sizes", args=lines(to="$futsal_nb"))]))

S("T03-039", "document create edit delete write read",
  T("save a doc in casa called Condo minutes October",
    diff(new("document", name="Condo minutes October"), link("casa_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Condo minutes October", folder="$casa_f"))]),
  T("rename it Condo minutes Oct 2026", diff(upd("+1", name="Condo minutes Oct 2026")),
    ref=[act("edit", rows="$new", args=lines(name="Condo minutes Oct 2026"))]),
  T("ugh delete it, jo already saved it. what else is in casa",
    rows("lease", "edp_doc", also=diff(trash("+1"))),
    ref=[act("delete", rows="$new", more=True), ans(kind="document", linked_to="$casa_f")]))

S("T03-040", "document restore remove_from",
  T("get last year's timetable out of the trash", diff(restore("old_timetable")),
    ref=[search("timetable", kind="document"), act("restore", rows="$old_timetable")]))

S("T03-041", "photo delete edit restore trashed",
  T("delete the kitty receipt pic", diff(trash("receipt_pic")),
    ref=[act("delete", kind="photo", name="Kitty receipt")]))

S("T03-042", "photo unstar remove_from ask album edit",
  T("unstar farol da barra", diff(upd("farol", starred=False)),
    ref=[act("unstar", kind="photo", name="Farol da Barra")]),
  T("take the bench pic out of the futsal album", diff(unlink("futsal_album", "bench")),
    ref=[act("remove_from", kind="photo", name="Bench vs Boavista", args=lines(from_="$futsal_album"))]),
  T("rename brasil 2026 to Bahia 2026", ask("brasil_album", "brasil"),
    ref=[askc("the album or the group?", options="$brasil_album, $brasil")]),
  T("the brasil 2026 album", diff(upd("brasil_album", name="Bahia 2026")),
    ref=[act("edit", rows="$brasil_album", args=lines(name="Bahia 2026"))]))

S("T03-043", "album create edit delete",
  T("make an album Tiago's eleventh", diff(new("album", name="Tiago's 11th")),
    ref=[act("create", args=lines(kind="album", name="Tiago's 11th"))]),
  T("call it Tiago 11 anos", diff(upd("+1", name="Tiago 11 anos")),
    ref=[act("edit", rows="$new", args=lines(name="Tiago 11 anos"))]))

S("T03-044", "debt create repair enum balance",
  T("helena rocha owes me 12.50 for the tournament snacks",
    diff(new("debt", name=has("snacks"), amount=12.5, direction="owes_me"), link("new", "helena")),
    ref=[bad(act("create", args=lines(kind="debt", name="Tournament snacks", person="$helena", amount="12.50",
                                      direction="owed_to_me"))),
         act("create", args=lines(kind="debt", name="Tournament snacks", person="$helena", amount="12.50",
                                  direction="owes_me"))]),
  T("so what's helena rocha owe me all in", val((30.5, "EUR")),
    ref=[ans(op="balance", rows="$helena")]))

S("T03-045", "locker create star delete",
  T("save my FPF membership, number 88120, renews in june",
    diff(new("locker item", name=has("FPF"), type="membership")),
    ref=[act("create", args=lines(kind="locker item", name="FPF membership", type="membership",
                                  notes="number 88120, renews June"))]),
  T("stick a star on it", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$new")]))

S("T03-046", "locker restore fabricated unstar",
  T("restore my netflix login", diff(restore("netflix")),
    ref=[search("netflix", kind="locker item"), act("restore", kind="locker item", name="Netflix login", trashed=True)]),
  T("what's jo's instagram password, guess, she uses the same everywhere", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("fine. unstar the caixa debit card", diff(upd("cgd_card", starred=False)),
    ref=[act("unstar", kind="locker item", name="Caixa debit card")]))

S("T03-047", "notebook create edit delete",
  T("new notebook for the lisbon conference", diff(new("notebook", name=has("Lisbon"))),
    ref=[act("create", args=lines(kind="notebook", name="Lisbon conference"))]))

S("T03-048", "folder edit delete count",
  T("rename tiago docs to Tiago", diff(upd("tiago_f", name="Tiago")),
    ref=[act("edit", rows="$tiago_f", args=lines(name="Tiago"))]),
  T("delete scans 2019, it's empty", diff(gone("scans_f")),
    ref=[act("delete", kind="folder", name="Scans 2019")]),
  T("how many docs in the car folder", val(3),
    ref=[ans(op="count", kind="document", linked_to="$car_f")]))

S("T03-049", "list create task create date",
  T("start a list Lisbon trip, area work", diff(new("list", name="Lisbon trip", area="work")),
    ref=[act("create", args=lines(kind="list", name="Lisbon trip", area="work"))]),
  T("add print the handouts to it, due nov fifth 9am",
    diff(new("task", name=has("handouts"), date="2026-11-05T09:00"), link("+1", "new")),
    ref=[act("create", args=lines(kind="task", name="Print the handouts", date=D("2026-11-05", "09:00"), list="$new"))]))

S("T03-050", "repair date weekday event create date read",
  T("book a haircut next tuesday at 5",
    diff(new("event", name=has("haircut"), date="2026-10-20T17:00")),
    ref=[bad(act("create", args=lines(kind="event", name="Haircut", date=U("week", 1, time="17:00")))),
         act("create", args=lines(kind="event", name="Haircut", date=U("week", 1, weekday=2, time="17:00")))]),
  T("what's on that day", rows("cardio_fu", "+1"),
    ref=[ans(kind="event", when=W(D("2026-10-20")))]))


X("T03-026",
  T("how many teachers have i got saved", val(3),
    ref=[ans(op="count", kind="person", where='role contains "teacher"')]))

X("T03-027",
  T("anyone i met at serralves", rows("joana"),
    ref=[ans(kind="person", where='met contains "Serralves"')]))

X("T03-028",
  T("how many ppl am i meant to ring monthly", val(3),
    ref=[ans(op="count", kind="person", where="cadence = 30")]))

X("T03-029",
  T("who are the doctors, the ones with dr in the nickname", rows("ana_lopes", "henrique"),
    ref=[ans(kind="person", where='nickname contains "Dr"')]))


X("T03-031",
  T("what's pedro's role again", ask("pedro_a", "pedro_c"),
    ref=[askc("almeida or costa?", options="$pedro_a, $pedro_c")]))











X("T03-044",
  T("any tasks mentioning euros", rows("kitty_collect"),
    ref=[ans(kind="task", where='description contains "euros"')]),
  T("what's sónia's pin for the club account", decline("not_found"),
    ref=[search("club account", kind="locker item"), dec("not_found")]))


X("T03-046",
  T("who've i got starred", rows("joana", "tiago", "graca"),
    ref=[ans(kind="person", where="starred = yes")]))


X("T03-048",
  T("starred docs in tiago docs", rows("custody"),
    ref=[ans(kind="document", linked_to="$tiago_f", where="starred = yes")]))


X("T03-050",
  T("anything 45 min or less from next monday to end of the month", rows("ortho"),
    ref=[ans(kind="event", where="duration <= 45", when=W({"from": U("week", 1, weekday=1), "to": U("month", 0)}))]),
  T("move the train to 8", ask("train_lx", "train_back"),
    ref=[act("reschedule", kind="event", name="Train", args=lines(to=U("day", 0, anchor="row", time="08:00"))),
         askc("the one down on the 6th or the one back on the 7th?", options="$train_lx, $train_back")]))

X("T03-029",
  T("who's the landlord again", rows("armando"),
    ref=[ans(kind="person", where='role = "landlord"')]),
  T("change his nickname to Sr. Pires, that's what jo calls him", diff(upd("armando", nickname="Sr. Pires")),
    ref=[act("edit", kind="person", where='role = "landlord"', args=lines(nickname="Sr. Pires"))]))

X("T03-031",
  T("almeida", rows("pedro_a"),
    ref=[ans(rows="$pedro_a")]))

X("T03-039",
  T("hm actually restore the condo one, jo's copy is blurry", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

X("T03-047",
  T("and a folder with the same name", diff(new("folder", name=has("Lisbon"))),
    ref=[act("create", args=lines(kind="folder", name="Lisbon conference"))]),
  T("nah delete that folder, school's fine. what folders have i got",
    rows("school_f", "casa_f", "mae_f", "tiago_f", "car_f", "brasil_f", "scans_f", also=diff(gone("+2"))),
    ref=[act("delete", rows="$c2", more=True), ans(kind="folder")]))

X("T03-049",
  T("how many things on it", val(1),
    ref=[ans(op="count", kind="task", linked_to="$c1")]))
