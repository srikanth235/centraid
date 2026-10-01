from gold import *
import json

world("T13", "2026-09-03T22:10", "Amara Nwosu", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T13-001", "events tomorrow reschedule linked",
  T("what's on tmrw", rows("sem", "wei_xrd", "badminton_0904"),
    ref=[find(kind="event", when=W(U("day", 1))), ans(rows="@prev")]),
  T("push the wei one to 3", diff(upd("wei_xrd", date="2026-09-04T15:00")),
    ref=[act("reschedule", rows="$wei_xrd", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("who's running the sem training", rows("sandra"),
    ref=[ans(kind="person", linked_to="$sem")]))

S("T13-002", "single cancel event named",
  T("cancel gym induction, not going", diff(upd("gym", status="cancelled")),
    ref=[act("cancel", kind="event", name="Gym induction")]))

S("T13-003", "event weekday reschedule prev",
  T("journal club next wednesday on?", rows("jc_0909"),
    ref=[ans(kind="event", name="Journal club", when=W(U("week", 1, weekday=3)))]),
  T("push it back an hour", diff(upd("jc_0909", date="2026-09-09T17:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("hour", 1, anchor="row")))]))

S("T13-004", "ambiguous task ask complete reschedule linked",
  T("mark book xrd slot as done", ask("xrd_book", "xrd_book_lukas"),
    ref=[act("complete", kind="task", name="Book XRD slot"),
         askc("yours or the one for lukas?", options="$xrd_book, $xrd_book_lukas")]),
  T("mine", diff(upd("xrd_book", status="completed", completed=ANY)),
    ref=[act("complete", rows="$xrd_book")]),
  T("lukas's one can wait till next tuesday", diff(upd("xrd_book_lukas", date="2026-09-08")),
    ref=[act("reschedule", rows="$xrd_book_lukas", args=lines(to=U("week", 1, weekday=2)))]),
  T("who's on it", rows("lukas", "raj"),
    ref=[ans(kind="person", linked_to="$xrd_book_lukas")]))

S("T13-005", "overdue complete prev status enum",
  T("anything overdue", rows("ts_aug"),
    ref=[ans(kind="task", when=W({"to": U("day", -1)}), where='status = "open"')]),
  T("did that on monday actually, tick it", diff(upd("ts_aug", status="completed", completed=ANY)),
    ref=[act("complete", rows="@prev")]))

S("T13-006", "find role log prev linked",
  T("who's the xrd facility person again", rows("raj"),
    ref=[find(kind="person", where='role contains "XRD"'), ans(rows="@prev")]),
  T("log a message to him, asked about beam hours", diff(upd("raj", date=ANY)),
    ref=[act("log", rows="@prev", args=lines(kind="message"))]),
  T("and what tasks have i got with him", rows("xrd_book", "xrd_book_lukas"),
    ref=[ans(kind="task", linked_to="$raj")]))

S("T13-007", "log multi next event order",
  T("coffee with wei and tom bennett", diff(upd("wei", date=ANY), upd("tom_b", date=ANY)),
    ref=[act("log", rows="$wei, $tom_b", args=lines(kind="coffee"))]),
  T("when's my next xrd session", rows("xrd_0908"),
    ref=[ans(kind="event", name="XRD session", when=W({"from": U("day", 0)}), order="date asc", limit=1)]))

S("T13-008", "group members balance settle_up undo ledger five turns",
  T("who's in the house bills kitty", rows("kasia", "tom_h", "priya", "me"),
    ref=[ans(kind="person", linked_to="$house")]),
  T("what's my balance in it", val((107, "GBP")),
    ref=[ans(op="balance", kind="group", name="House bills kitty", linked_to="$me")]),
  T("and tom hargreaves", val((-17, "GBP")),
    ref=[ans(op="balance", kind="group", name="House bills kitty", linked_to="$tom_h")]),
  T("ok settle up with him", diff(settle=["Tom Hargreaves"]),
    ref=[act("settle_up", rows="$tom_h", args=lines(group="$house"))]),
  T("wait undo that, he hasn't paid yet", diff(),
    ref=[act("undo")]))

S("T13-009", "single compute sum grouped debts",
  T("totals pls, what i owe vs what i'm owed", vgroups({"i_owe": (112, "GBP"), "owes_me": (203.5, "GBP")}),
    ref=[comp(op="sum", field="amount", group="direction", kind="debt", where='status = "open"'),
         ans(value="@prev")]))

S("T13-010", "create note add_to new count",
  T("new note: Annealing run 15 - 160C, film went hazy",
    diff(new("note", name=has("Annealing run 15"), body=has("hazy"))),
    ref=[act("create", args=lines(kind="note", name="Annealing run 15", body="160C, film went hazy"))]),
  T("put it in lab notebook 2026", diff(link("lab26", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$lab26"))]),
  T("how many notes in there", val(5),
    ref=[ans(op="count", kind="note", linked_to="$lab26")]))

S("T13-011", "ambiguous notebook ask edit linked move note",
  T("can you rename the lab notebook to Old lab notebook", ask("lab25", "lab26"),
    ref=[act("edit", kind="notebook", name="Lab notebook", args=lines(name="Old lab notebook")),
         askc("the 2025 one or the 2026 one?", options="$lab25, $lab26")]),
  T("2025", diff(upd("lab25", name="Old lab notebook")),
    ref=[act("edit", rows="$lab25", args=lines(name="Old lab notebook"))]),
  T("what's in it", rows("first_films", "solgel_note"),
    ref=[ans(kind="note", linked_to="$lab25")]),
  T("move the sol-gel one into thesis ideas", diff(unlink("lab25", "solgel_note"), link("thesis_nb", "solgel_note")),
    ref=[act("add_to", rows="$solgel_note", args=lines(to="$thesis_nb"))]))

S("T13-012", "restore person named trashed recovery",
  T("bring kevin marsh back into contacts, need him for the deposit", diff(restore("kevin")),
    ref=[act("restore", kind="person", name="Kevin Marsh"), act("restore", rows="$kevin")]),
  T("what was his role", rows("kevin"),
    ref=[ans(rows="$kevin")]))

S("T13-013", "restore person where undo restore trashed",
  T("restore the letting agent i deleted", diff(restore("kevin")),
    ref=[act("restore", kind="person", where='role = "letting agent"', trashed=True)]),
  T("actually no, undo", diff(trash("kevin")),
    ref=[act("undo")]),
  T("who else is in the trash", rows("jess"),
    ref=[ans(kind="person", trashed=True, exclude="$kevin")]))

S("T13-014", "restore window person refused create",
  T("can you get jess taylor back", rows("jess"),
    ref=[act("restore", kind="person", name="Jess Taylor"), bad(act("restore", rows="$jess")),
         ans(rows="$jess")]),
  T("ugh fine. add her again, Jess Taylor, old flatmate",
    diff(new("person", name="Jess Taylor", role=has("flatmate"))),
    ref=[act("create", args=lines(kind="person", name="Jess Taylor", role="old flatmate"))]),
  T("hmm undo that, i'll add her properly later", diff(trash("+1")),
    ref=[act("undo")]))

S("T13-015", "folder linked_to all empty folder delete prev",
  T("which folder has the cas letter and the brp card scan", rows("visa_f"),
    ref=[ans(kind="folder", linked_to="$cas, $brp_scan")]),
  T("folders that never got a single doc", rows("coursework_f"),
    ref=[find(kind="folder", where="document count = 0"), ans(rows="@prev")]),
  T("delete it", diff(gone("coursework_f")),
    ref=[act("delete", rows="@prev")]))

S("T13-016", "add_to document multi count",
  T("stick the nigerian passport scan and boarding pass man-lis in visa and brp",
    diff(link("visa_f", "passport_scan"), link("visa_f", "boarding")),
    ref=[act("add_to", rows="$passport_scan, $boarding", args=lines(to="$visa_f"))]))

S("T13-017", "find photo add_to prev star prev",
  T("find the xrd machine photo", rows("p_xrd"),
    ref=[find(kind="photo", name="XRD machine"), ans(rows="@prev")]),
  T("add it to lab life", diff(link("lab_al", "p_xrd")),
    ref=[act("add_to", rows="@prev", args=lines(to="$lab_al"))]),
  T("and star it", diff(upd("p_xrd", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T13-018", "settle debt linked balance",
  T("tom bennett paid me back for kro", diff(upd("d_tom_b", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$tom_b")]),
  T("does he owe me anything else", val((-5, "GBP")),
    ref=[ans(op="balance", rows="$tom_b")]))

S("T13-019", "edit locker multi starred find",
  T("put originals in the blue folder as the notes on nigerian passport and nigerian driving licence",
    diff(upd("passport_l", notes=has("blue folder")), upd("licence", notes=has("blue folder"))),
    ref=[act("edit", rows="$passport_l, $licence", args=lines(notes="originals in the blue folder"))]),
  T("what's starred in the locker", rows("uni_login", "monzo", "gym_card"),
    ref=[find(kind="locker item", where="starred = yes"), ans(rows="@prev")]))

S("T13-020", "locker notes literal unstar prev",
  T("which of my memberships renew in january", rows("rsc", "iom3"),
    ref=[find(kind="locker item", where='notes = "renews January"'), ans(rows="@prev")]),
  T("is the gym one starred", rows("gym_card"),
    ref=[find(kind="locker item", name="gym"), ans(rows="@prev")]),
  T("unstar it, cancelling that membership", diff(upd("gym_card", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T13-021", "notebook linked edit where",
  T("which notebook is annealing run 14 in", rows("lab26"),
    ref=[ans(kind="notebook", linked_to="$anneal")]),
  T("rename that notebook Perovskite lab book", diff(upd("lab26", name="Perovskite lab book")),
    ref=[act("edit", kind="notebook", linked_to="$anneal", args=lines(name="Perovskite lab book"))]))

S("T13-022", "find doc unstar prev trashed document",
  T("is the tenancy agreement starred", rows("tenancy26"),
    ref=[find(kind="document", name="Tenancy agreement"), ans(rows="@prev")]),
  T("unstar it", diff(upd("tenancy26", starred=False)),
    ref=[act("unstar", rows="@prev")]),
  T("wasn't there a 2025 one too", rows("tenancy25"),
    ref=[find(kind="document", name="Tenancy agreement 2025"),
         ans(kind="document", name="Tenancy agreement 2025", trashed=True)]))

S("T13-023", "list area remove_from task named count",
  T("what lists have i got for research stuff", rows("thesis_l", "lab_l"),
    ref=[ans(kind="list", where='area = "research"')]),
  T("what's on the lab one",
    rows("xrd_analyse", "xrd_book", "xrd_book_lukas", "precursors", "glovebox", "furnace", "induct_task", "jc_slides"),
    ref=[ans(kind="task", linked_to="$lab_l")]),
  T("take calibrate the furnace off it, done ages ago", diff(unlink("lab_l", "furnace")),
    ref=[act("remove_from", rows="$furnace", args=lines(from_="$lab_l"))]),
  T("how many left on it", val(7),
    ref=[ans(op="count", kind="task", linked_to="$lab_l")]))

S("T13-024", "event duration empty within named month",
  T("which things in my diary are all day", rows("chichi_bday", "emrs", "aunty_visit", "wedding"),
    ref=[ans(kind="event", where="duration is empty")]),
  T("which of those are from october on", rows("aunty_visit", "wedding"),
    ref=[ans(within="@prev", when=W({"from": U("month", 0, name=10)}))]))

S("T13-025", "trashed photos restore window refused restore five turns",
  T("anything sitting in the photo trash?", rows("p_old_room", "p_screenshot", "p_duplicate", "p_blurry"),
    ref=[find(kind="photo", trashed=True), ans(rows="@prev")]),
  T("bring back old room in rusholme", rows("p_old_room"),
    ref=[bad(act("restore", rows="$p_old_room")), ans(rows="$p_old_room")]),
  T("fine, the blurry night bus one", diff(restore("p_blurry")),
    ref=[act("restore", kind="photo", name="Blurry night bus", trashed=True)]),
  T("and the duplicate of the committee photo", diff(restore("p_duplicate")),
    ref=[act("restore", kind="photo", name="Duplicate of the committee photo", trashed=True)]),
  T("what's left in there", rows("p_old_room", "p_screenshot"),
    ref=[ans(kind="photo", trashed=True)]))
