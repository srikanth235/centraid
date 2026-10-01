from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T03-076", "document star multi starred != oldest",
  T("star tiago's enrolment and his vaccination record", diff(upd("enrolment", starred=True), upd("vaccines", starred=True)),
    ref=[search("tiago", kind="document"), act("star", rows="$enrolment, $vaccines")]),
  T("anything in the car folder that isn't starred", rows("car_policy", "dua", "ipo_cert"),
    ref=[ans(kind="document", linked_to="$car_f", where="starred != yes")]),
  T("which of those is the least recent", rows("dua"),
    ref=[ans(within="@prev", order="date asc", limit=1)]))

S("T03-077", "document add_to star knock-on starred != span",
  T("move my cv into casa and star it", diff(link("casa_f", "cv"), upd("cv", starred=True)),
    ref=[act("add_to", kind="document", name="CV 2026", args=lines(to="$casa_f"), more=True),
         act("star", kind="document", name="CV 2026")]),
  T("what's not starred in casa", rows("edp_doc"),
    ref=[ans(kind="document", linked_to="$casa_f", where="starred != yes")]),
  T("docs from last month up to first oct midday", rows("curriculum", "timetable", "abstract_doc", "conf_reg", "bloods_doc"),
    ref=[ans(kind="document", when=W({"from": U("month", -1), "to": D("2026-10-01", "12:00")}))]))

S("T03-078", "folder docs move star knock-on document count",
  T("what's in the brazil trip folder", rows("tap_booking", "pousada"),
    ref=[ans(kind="document", linked_to="$brasil_f")]),
  T("move the pousada one to casa and star it, need it for the irs",
    diff(unlink("brasil_f", "pousada"), link("casa_f", "pousada"), upd("pousada", starred=True)),
    ref=[act("add_to", rows="$pousada", args=lines(to="$casa_f"), more=True), act("star", rows="$pousada")]),
  T("which folders have one doc or fewer", rows("brasil_f", "scans_f"),
    ref=[ans(kind="folder", where="document count <= 1")]),
  T("docs from last month up to last friday", rows("curriculum", "timetable", "abstract_doc", "conf_reg", "bloods_doc"),
    ref=[ans(kind="document", when=W({"from": U("month", -1), "to": U("week", -1, weekday=5)}))]))

S("T03-079", "folder document count",
  T("which folders have two docs or less", rows("casa_f", "brasil_f", "scans_f"),
    ref=[ans(kind="folder", where="document count <= 2")]))

S("T03-080", "document create undo restore new write read",
  T("save a doc called Visionarium permission slips in school",
    diff(new("document", name="Visionarium permission slips"), link("school_f", "new")),
    ref=[act("create", args=lines(kind="document", name="Visionarium permission slips", folder="$school_f"))]),
  T("can you undo that", diff(trash("+1")),
    ref=[act("undo")]),
  T("no wait bring it back, and show me what's in school",
    rows("timetable", "curriculum", "conf_reg", "abstract_doc", "+1", also=diff(restore("+1"))),
    ref=[act("restore", rows="$c1", more=True), ans(kind="document", linked_to="$school_f")]))

S("T03-081", "locker create undo restore new write read",
  T("save a locker item called Pavilion wifi",
    diff(new("locker item", name="Pavilion wifi", type="wifi")),
    ref=[act("create", args=lines(kind="locker item", name="Pavilion wifi", type="wifi"))]),
  T("undo, that's the club's not mine", diff(trash("+1")),
    ref=[act("undo")]),
  T("eh restore it, i'm there 3 nights a week. what wifi stuff have i got",
    rows("wifi", "+1", also=diff(restore("+1"))),
    ref=[find(kind="locker item", name="Pavilion wifi", trashed=True), act("restore", rows="@prev", more=True),
         ans(kind="locker item", where='type = "wifi"')]))

S("T03-082", "locker create delete restore new",
  T("add my padel club membership, member 4410",
    diff(new("locker item", name=has("padel"), type="membership")),
    ref=[act("create", args=lines(kind="locker item", name="Padel club membership", type="membership", notes="member 4410"))]),
  T("is the solinca gym membership in there", rows("solinca"),
    ref=[ans(kind="locker item", name="Solinca gym membership")]),
  T("delete the padel one, it was solinca i was thinking of", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("hm restore it, i do play padel on tuesdays. show me the memberships",
    rows("solinca", "+1", also=diff(restore("+1"))),
    ref=[act("restore", rows="$c1", more=True), ans(kind="locker item", where='type = "membership"')]))

S("T03-083", "locker starred unstar prev",
  T("what's starred in the locker", rows("inovar", "cgd_card"),
    ref=[ans(kind="locker item", where="starred = yes")]),
  T("unstar both, i don't bother with stars there", diff(upd("inovar", starred=False), upd("cgd_card", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T03-084", "locker logins narrow unstar prev",
  T("which logins have i got", rows("inovar", "moodle_login", "gmail"),
    ref=[ans(kind="locker item", where='type = "login"')]),
  T("which of those is starred", rows("inovar"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it", diff(upd("inovar", starred=False)),
    ref=[act("unstar", rows="@prev")]))

S("T03-085", "notebook delete multi note count",
  T("delete the old stuff and brazil notebooks, trip's done",
    diff(gone("old_nb"), gone("brasil_nb"), unlink("brasil_nb", "ssa_food"), unlink("brasil_nb", "brasil_pack"),
         unlink("brasil_nb", "brasil_costs")),
    ref=[act("delete", rows="$old_nb, $brasil_nb")]),
  T("which notebooks have fewer than four notes", rows("futsal_nb", "mae_nb", "recipes"),
    ref=[ans(kind="notebook", where="note count < 4")]))

S("T03-086", "folder notebook create delete new multi",
  T("make a folder and a notebook, both called Mãe IRS",
    diff(new("folder", name="Mãe IRS"), new("notebook", name="Mãe IRS")),
    ref=[act("create", more=True, args=lines(kind="folder", name="Mãe IRS")),
         act("create", args=lines(kind="notebook", name="Mãe IRS"))]),
  T("ugh delete both, i'll keep it all in mãe medical", diff(gone("+1"), gone("+2")),
    ref=[act("delete", rows="$c1, $c2")]))

S("T03-087", "repair refused folder delete ask",
  T("delete the school folder, everything's on the drive", ask(),
    ref=[bad(act("delete", kind="folder", name="School")),
         askc("the School folder still has documents in it, one of them in the trash. take them out first?")]),
  T("what's in school anyway", rows("timetable", "curriculum", "conf_reg", "abstract_doc"),
    ref=[ans(kind="document", linked_to="$school_f")]))

S("T03-088", "photo anchor time delete where undo span",
  T("the pic from yesterday at 11", rows("silver_tree"),
    ref=[ans(kind="photo", when=W(U("day", -1, anchor="today", time="11:00")))]),
  T("what else did i take yesterday", rows("silver_tree", "foz"),
    ref=[ans(kind="photo", when=W(U("day", -1)))]),
  T("delete both, they're on the school drive", diff(trash("silver_tree"), trash("foz")),
    ref=[act("delete", rows="@prev")]),
  T("wait undo, i want the sunset one", diff(restore("silver_tree"), restore("foz")),
    ref=[act("undo")]),
  T("starred pics from august up to the sixth", rows("capoeira"),
    ref=[ans(kind="photo", where="starred = yes", when=W({"from": U("month", 0, name=8), "to": D("2026-08-06")}))]))

S("T03-089", "photo span narrow delete where",
  T("pics from october up to monday",
    rows("douro", "receipt_pic", "vitor_pic", "whiteboard", "bibs_pic", "setup", "padroense_pic", "sunday_lunch"),
    ref=[ans(kind="photo", when=W({"from": U("month", 0, name=10), "to": U("week", 0, weekday=1)}))]),
  T("which of those aren't in an album", rows("douro", "receipt_pic", "whiteboard", "setup"),
    ref=[ans(within="@prev", where="album count = 0")]),
  T("delete the unsorted ones from last week", diff(trash("whiteboard"), trash("setup")),
    ref=[find(within="@prev", when=W(U("week", -1))), act("delete", rows="@prev")]))

S("T03-090", "photo span album count",
  T("pics from july up to second aug", rows("pelourinho", "farol", "jo_beach", "acaraje", "capoeira"),
    ref=[ans(kind="photo", when=W({"from": U("month", 0, name=7), "to": D("2026-08-02")}))]),
  T("which of them are in more than the one album", rows("capoeira"),
    ref=[ans(within="@prev", where="album count != 1")]))

S("T03-091", "photo album count",
  T("any photos not in exactly one album",
    rows("capoeira", "tiago_goal", "whiteboard", "setup", "receipt_pic", "douro", "silver_tree", "foz"),
    ref=[ans(kind="photo", where="album count != 1")]))

S("T03-092", "person when weekday time log undo ledger",
  T("who've i been in touch with since monday", rows("graca", "tiago", "pedro_a", "joana"),
    ref=[ans(kind="person", when=W({"from": U("week", 0, weekday=1)}))]),
  T("who did i see monday at 4", rows("graca"),
    ref=[ans(kind="person", when=W(U("week", 0, weekday=1, time="16:00")))]),
  T("log a call with graça duarte", diff(upd("graca", date=ANY)),
    ref=[act("log", rows="$graca", args=lines(kind="call"))]),
  T("undo that, it was a message", diff(),
    ref=[act("undo")]))

S("T03-093", "person month span cadence group count",
  T("who did i talk to in aug or sept", rows("filipa", "bruno", "teresa", "henrique", "nuno"),
    ref=[ans(kind="person", when=W({"from": U("month", 0, name=8), "to": U("month", 0, name=9)}))]),
  T("which of them am i meant to see monthly", rows("nuno", "filipa", "teresa"),
    ref=[ans(within="@prev", where="cadence = 30 days")]),
  T("and who that i've talked to since last monday is in a group",
    rows("joana", "vitor", "pedro_c", "ana_rita", "graca", "pedro_a"),
    ref=[ans(kind="person", where="group count != 0", when=W({"from": U("week", -1, weekday=1)}))]))

S("T03-094", "person span date time",
  T("who did i talk to from first oct to the sixth at 7pm", rows("miguel", "marta", "carla"),
    ref=[ans(kind="person", when=W({"from": D("2026-10-01"), "to": D("2026-10-06", "19:00")}))]))

S("T03-095", "find miss debt search linked empty amount unit",
  T("the uber debt with migas, did he pay", rows("d_cantina"),
    ref=[find(kind="debt", name="Uber"), search("migas", kind="person"), ans(kind="debt", linked_to="$miguel")]),
  T("does miguel antunes owe me anything", rows(),
    ref=[ans(kind="debt", linked_to="$miguel", where='status = "open"')]),
  T("which debts were exactly 15 euros", rows("d_cones"),
    ref=[ans(kind="debt", where="amount = 15 EUR")]),
  T("debts from first oct midnight to the seventh 23:59", rows("d_nuno", "d_cones", "d_pharmacy", "d_classico", "d_padel"),
    ref=[ans(kind="debt", when=W({"from": D("2026-10-01", "00:00"), "to": D("2026-10-07", "23:59")}))]))

S("T03-096", "find miss debt search span date time",
  T("what's the debt for the dinner with bruno", rows("d_classico"),
    ref=[find(kind="debt", name="Dinner"), search("bruno", kind="person"), ans(kind="debt", linked_to="$bruno")]),
  T("what debts came up between sept first 9am and thirtieth sept 6pm",
    rows("d_books", "d_capsules", "d_glasses", "d_cantina", "d_concert", "d_fee", "d_balls"),
    ref=[ans(kind="debt", when=W({"from": D("2026-09-01", "09:00"), "to": D("2026-09-30", "18:00")}))]),
  T("anything from twenty-seventh sept 9am on that i owe", rows("d_concert", "d_padel"),
    ref=[ans(kind="debt", where='direction = "i_owe"', when=W({"from": D("2026-09-27", "00:00")}))]))

S("T03-097", "debt span open ends",
  T("any debts from the first of oct at noon on", rows("d_nuno", "d_cones", "d_pharmacy", "d_classico", "d_padel"),
    ref=[ans(kind="debt", when=W({"from": D("2026-10-01", "12:00")}))]),
  T("and everything up to end of august", rows("d_deposit"),
    ref=[ans(kind="debt", when=W({"to": U("month", 0, name=8)}))]))

S("T03-098", "note span blank delete trash restore prev",
  T("notes from first october to last sunday", rows("bp_log", "anniv_ideas", "titr_plan", "lineup", "gift_ideas"),
    ref=[ans(kind="note", when=W({"from": D("2026-10-01"), "to": U("week", -1, weekday=7)}))]),
  T("any of them blank", rows(),
    ref=[ans(within="@prev", where="body is empty")]),
  T("delete the untitled note then, it's empty", diff(trash("untitled")),
    ref=[act("delete", kind="note", name="Untitled note")]),
  T("what's in the note delete apart from that", rows("old_lineup", "complaint"),
    ref=[ans(kind="note", trashed=True, exclude="$untitled")]),
  T("bring both back", diff(restore("old_lineup"), restore("complaint")),
    ref=[act("restore", rows="@prev")]))

S("T03-099", "note trash restore prev add_to prev",
  T("anything about potholes in the trash", rows("complaint"),
    ref=[ans(kind="note", trashed=True, where='body contains "potholes"')]),
  T("restore it", diff(restore("complaint")),
    ref=[act("restore", rows="@prev")]),
  T("which notes mention saramago", rows("books"),
    ref=[ans(kind="note", where='body contains "Saramago"')]),
  T("put that in lesson ideas, primo levi was a chemist", diff(link("lessons", "books")),
    ref=[act("add_to", rows="@prev", args=lines(to="$lessons"))]))

S("T03-100", "task week span effort biggest edit prev restore where status empty",
  T("what's due mon to fri next week",
    rows("mark_9b", "call_matos", "ref_form", "edp_oct", "worksheet", "mark_9c", "naoh", "titration"),
    ref=[ans(kind="task", when=W({"from": U("week", 1, weekday=1), "to": U("week", 1, weekday=5)}))]),
  T("which of those have a time estimate", rows("mark_9b", "worksheet", "mark_9c", "naoh", "titration"),
    ref=[ans(within="@prev", where="effort is set")]),
  T("which is the biggest", rows("mark_9b"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]),
  T("make it priority one", diff(upd("mark_9b", priority=1)),
    ref=[act("edit", rows="@prev", args=lines(priority=1))]),
  T("restore whatever i deleted off the home list", diff(restore("ink")),
    ref=[act("restore", kind="task", trashed=True, linked_to="$home")]),
  T("any tasks with no status at all", rows(),
    ref=[ans(kind="task", where="status is empty")]),
  T("from this monday to friday noon what was due",
    rows("luisa_budget", "boiler", "ines_receipts", "bibs_1015", "lab_10a", "first_aid", "trip_form"),
    ref=[ans(kind="task", when=W({"from": U("week", 0, weekday=1), "to": D("2026-10-16", "12:00")}))]))

S("T03-101", "single note body empty",
  T("any notes with nothing written in them", rows(),
    ref=[ans(kind="note", where="body is empty")]))
