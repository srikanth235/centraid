from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# --- one write named by what it is and when it was, then something to check it -------------------------

S("T31-222", "star-photo name-when march starred-count trips",
  T("star the borough market photo from march", diff(upd("p_tr_kasia", starred=True)),
    ref=[act("star", kind="photo", name="borough market", when=J(U("month", -1, name=3)))]),
  T("how many starred photos are in trips 2026 now", val(2),
    ref=[ans(op="count", kind="photo", linked_to="$trips_a", where="starred = yes")]))

S("T31-223", "delete-event name-when kasia call restore",
  T("delete the call with kasia on the 22nd", diff(trash("kasia_call2")),
    ref=[act("delete", kind="event", name="call kasia", when=J(D("2026-11-22")))]),
  T("bring the call with kasia back", diff(restore("kasia_call2")),
    ref=[find(kind="event", name="call kasia", trashed=True), act("restore", rows="@1")]))

S("T31-224", "delete-event dentist may undo",
  T("delete the dentist visit from may", diff(trash("dentist_ev2")),
    ref=[act("delete", kind="event", name="dentist", when=J(U("month", -1, name=5)))]),
  T("undo that", diff(restore("dentist_ev2")),
    ref=[act("undo")]))

S("T31-225", "add-to-folder document name-last-year work folder contents",
  T("move the pit-37 from last year into the work folder", diff(link("work_f", "d_pit24"), unlink("taxes_f", "d_pit24")),
    ref=[act("add_to", kind="document", name="pit-37", when=J(U("year", -1)), args=lines(to="$work_f"))]),
  T("what's in the work folder now", rows("d_contract", "d_rota", "d_cpr", "d_licence", "d_pit24"),
    ref=[ans(kind="document", linked_to="$work_f")]))

S("T31-226", "unstar-photo name-when september album-starred",
  T("unstar the penalty save photo from september", diff(upd("p_fb_keeper", starred=False)),
    ref=[act("unstar", kind="photo", name="penalty", when=J(U("month", -1, name=9)))]),
  T("which photos in the football album are starred now", rows("p_fb_team"),
    ref=[ans(kind="photo", linked_to="$football_a", where="starred = yes")]))

S("T31-227", "create-note add-to-notebook ideas contents",
  T("new note: pack list, passport and charger. put it in the ideas notebook",
    diff(new("note", name=has("Pack list"), body=has("passport")), link("ideas_nb", "new")),
    ref=[act("create", kind="note", args=lines(name="Pack list", body="passport and charger"), more=True),
         act("add_to", rows="$new", args=lines(to="$ideas_nb"))]),
  T("what notes have i got in there", rows("+1"),
    ref=[ans(kind="note", linked_to="$ideas_nb")]))

S("T31-228", "remove-from-album team photo starred-left add-back",
  T("take the team photo out of the football album", diff(unlink("football_a", "p_fb_team")),
    ref=[act("remove_from", kind="photo", name="team photo", args=lines(from_="$football_a"))]),
  T("which photos are left in the football album that i've starred", rows("p_fb_keeper"),
    ref=[ans(kind="photo", linked_to="$football_a", where="starred = yes")]),
  T("put the team photo back in the football album", diff(link("football_a", "p_fb_team")),
    ref=[act("add_to", kind="photo", name="team photo", args=lines(to="$football_a"))]))

S("T31-229", "star-photos name-when linked-when nowy-sacz starred-count",
  T("star the roses photo from august", diff(upd("p_ns_babcia", starred=True)),
    ref=[act("star", kind="photo", name="roses", when=J(U("month", -1, name=8)))]),
  T("and the one of tata from july", diff(upd("p_ns_tata", starred=True)),
    ref=[act("star", kind="photo", linked_to="$tata", when=J(U("month", -1, name=7)))]),
  T("how many starred photos are in the nowy sacz album now", val(3),
    ref=[ans(op="count", kind="photo", linked_to="$family_a", where="starred = yes")]))

# --- a selector with its own conditions, then the way back ----------------------------------------------

S("T31-230", "find-act3 delete open football short restore",
  T("delete the open football tasks that take under 10 minutes", diff(trash("pay_pizza"), trash("match_balls")),
    ref=[find(kind="task", linked_to="$football_l", where="status = open and effort < 10"), act("delete", rows="@1")]),
  T("bring the pizza one back", diff(restore("pay_pizza")),
    ref=[find(kind="task", name="pizza", trashed=True), act("restore", rows="@2")]))

S("T31-231", "find-act3 add-to-list ward short undo",
  T("add the open ward tasks that take under 20 minutes to the admin list",
    diff(link("admin_l", "handover"), link("admin_l", "uniforms"), unlink("ward_l", "handover"), unlink("ward_l", "uniforms")),
    ref=[find(kind="task", linked_to="$ward_l", where="status = open and effort < 20"), act("add_to", rows="@1", args=lines(to="$admin_l"))]),
  T("undo that", diff(link("ward_l", "handover"), link("ward_l", "uniforms"), unlink("admin_l", "handover"), unlink("admin_l", "uniforms")),
    ref=[act("undo")]))

# --- counts and sums that need three conditions -----------------------------------------------------------

S("T31-232", "values3 count tasks hour sum owed-to-me documents flat starred",
  T("open tasks over an hour, how many", val(2),
    ref=[ans(op="count", kind="task", where="status = open and effort > 60")]),
  T("what's the total of the debts people still owe me", val((200, "PLN")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open")]),
  T("how many documents have i starred in the flat folder", val(1),
    ref=[ans(op="count", kind="document", linked_to="$flat_f", where="starred = yes")]))

S("T31-233", "values3 count five-a-side starred notes pinned year",
  T("how many people from tuesday football have i starred", val(1),
    ref=[ans(op="count", kind="person", where='met = "Tuesday football" and starred = yes')]),
  T("how many notes from this year are pinned", val(1),
    ref=[ans(op="count", kind="note", where="pinned = yes", when=J(U("year", 0)))]))
