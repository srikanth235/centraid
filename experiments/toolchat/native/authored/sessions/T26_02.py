from gold import *


S("T26-026", "five turns photos last saturday edit named already star remove_from multi count",
  T("pics from last saturday", rows("p_lintel", "p_windows", "p_goal", "p_team"),
    ref=[ans(kind="photo", when=U("week", -1, weekday=6))]),
  T("rename Window openings to Window openings too narrow", diff(upd("p_windows", name="Window openings too narrow")),
    ref=[act("edit", kind="photo", name="Window openings", args=lines(name="Window openings too narrow"))]),
  T("star femi's goal", diff(already=["p_goal"]),
    ref=[act("star", rows="$p_goal"), ans(rows="$p_goal")]),
  T("take the goal pic and the team photo out of football",
    diff(unlink("football_al", "p_goal"), unlink("football_al", "p_team")),
    ref=[act("remove_from", rows="$p_goal, $p_team", args=lines(from_="$football_al"))]),
  T("how many left in there", val(1),
    ref=[ans(op="count", kind="photo", linked_to="$football_al")]))

S("T26-027", "single photo date time",
  T("which pic did i take on the twenty-first at 16:35", rows("p_goal"),
    ref=[ans(kind="photo", when=D("2026-11-21", "16:35"))]))

S("T26-028", "photo span weekday to datetime delete multi undo photo",
  T("what did i snap from last saturday through 6pm on sunday",
    rows("p_lintel", "p_windows", "p_goal", "p_team", "p_haircut", "p_sunday"),
    ref=[ans(kind="photo", when=span(U("week", -1, weekday=6), U("week", -1, weekday=7, time="18:00")))]),
  T("delete the sunday rice one and the barber one",
    diff(trash("p_sunday"), trash("p_haircut"), unlink("kids_al", "p_haircut")),
    ref=[act("delete", rows="$p_sunday, $p_haircut")]),
  T("undo, ngozi wants them", diff(restore("p_sunday"), restore("p_haircut"), link("kids_al", "p_haircut")),
    ref=[act("undo")]))

S("T26-029", "photo span weekday to named month starred within linked",
  T("starred pics from the fourteenth through the end of november", rows("p_cake", "p_anniv", "p_lintel", "p_goal"),
    ref=[ans(kind="photo", where="starred = yes",
             when=span(D("2026-11-14"), U("month", 0, name=11)))]),
  T("which of those has ngozi in it", rows("p_anniv"),
    ref=[ans(kind="photo", within="@prev", linked_to="$ngozi")]))

S("T26-030", "edit photo named add_to album",
  T("rename Gate motor wiring to Gate motor capacitor", diff(upd("p_gate", name="Gate motor capacitor")),
    ref=[act("edit", kind="photo", name="Gate motor wiring", args=lines(name="Gate motor capacitor"))]),
  T("and put it in house progress", diff(link("house_al", "p_gate")),
    ref=[act("add_to", rows="$p_gate", args=lines(to="$house_al"))]))

S("T26-031", "trashed photos restore named delete multi",
  T("any photos in the trash", rows("p_blurry", "p_dup_goal", "p_old_rig"),
    ref=[ans(kind="photo", trashed=True)]),
  T("restore the duplicate goal shot", diff(restore("p_dup_goal")),
    ref=[act("restore", kind="photo", name="Duplicate goal shot", trashed=True)]),
  T("nah delete it again, and Diesel receipt with it", diff(trash("p_dup_goal"), trash("p_receipt")),
    ref=[act("delete", rows="$p_dup_goal, $p_receipt")]))

S("T26-032", "album read remove_from photo multi",
  T("what's in the bonga crew album", rows("p_deck", "p_turbine", "p_heli", "p_crane", "p_muster", "p_fpso"),
    ref=[ans(kind="photo", linked_to="$rig_al")]),
  T("take the turbine panel and the muster drill out, they're work pics not crew",
    diff(unlink("rig_al", "p_turbine"), unlink("rig_al", "p_muster")),
    ref=[act("remove_from", rows="$p_turbine, $p_muster", args=lines(from_="$rig_al"))]))

S("T26-033", "album photo count delete album where",
  T("albums with fewer than four photos", rows("kemi13_al", "family_al", "football_al", "dubai_al"),
    ref=[ans(kind="album", where="photo count < 4")]),
  T("delete the empty one", diff(gone("dubai_al")),
    ref=[act("delete", kind="album", where="photo count = 0")]))

S("T26-034", "single delete album where",
  T("delete whichever album has no photos in it", diff(gone("dubai_al")),
    ref=[act("delete", kind="album", where="photo count = 0")]))

S("T26-035", "locker create delete new reveal",
  T("add a locker login for the Zenith token app, username ahmedbello",
    diff(new("locker item", name=has("Zenith"), type="login", username="ahmedbello")),
    ref=[act("create", args=lines(kind="locker item", name="Zenith token app", type="login", username="ahmedbello"))]),
  T("no delete that, i already have zenith saved", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("what's the password on the GTBank app", diff(reveal=[("gtbank", "Bonga-Spark-2026")]),
    ref=[act("reveal", kind="locker item", name="GTBank app", args=lines(field="password"))]))

S("T26-036", "locker create note delete new",
  T("save a locker note Prepaid meter number, notes meter 4500 2231 88",
    diff(new("locker item", name="Prepaid meter number", type="note")),
    ref=[act("create", args=lines(kind="locker item", name="Prepaid meter number", type="note",
                                  notes="meter 4500 2231 88"))]),
  T("hmm delete it, its on the PHED app", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]))

S("T26-037", "locker type in star prev multi",
  T("wifi and password type stuff in the locker", rows("wifi", "wifi_site", "atm_pin"),
    ref=[ans(kind="locker item", where='type in ("wifi", "password")')]),
  T("star all of them", diff(upd("wifi", starred=True), upd("wifi_site", starred=True), upd("atm_pin", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T26-038", "locker type in star prev",
  T("anything in the locker that's a membership or a document", rows("gym_card", "ogsp"),
    ref=[ans(kind="locker item", where='type in ("membership", "document")')]),
  T("star both", diff(upd("gym_card", starred=True), upd("ogsp", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T26-039", "create folder edit new",
  T("make a folder called Mama's 70th", diff(new("folder", name="Mama's 70th")),
    ref=[act("create", args=lines(kind="folder", name="Mama's 70th"))]),
  T("rename it Mama 70th paperwork", diff(upd("+1", name="Mama 70th paperwork")),
    ref=[act("edit", rows="$c1", args=lines(name="Mama 70th paperwork"))]))

S("T26-040", "create folder edit new unfiled docs",
  T("new folder Car papers", diff(new("folder", name="Car papers")),
    ref=[act("create", args=lines(kind="folder", name="Car papers"))]),
  T("call it Car and generator instead", diff(upd("+1", name="Car and generator")),
    ref=[act("edit", rows="$c1", args=lines(name="Car and generator"))]),
  T("which documents are missing a folder", rows("scan_a", "scan_b", "receipt_cement", "medical_form"),
    ref=[ans(kind="document", where="folder count = 0")]),
  T("put the scan in the new folder", ask("scan_a", "scan_b"),
    ref=[act("add_to", kind="document", name="Scan", args=lines(to="$c1")),
         askc("Scan 1121 or Scan 1122?", options="$scan_a, $scan_b")]))

S("T26-041", "document folder count starred unstar",
  T("which filed docs are starred", rows("survey", "contract", "passport_scan"),
    ref=[ans(kind="document", where="folder count > 0 and starred = yes")]),
  T("unstar the passport scan", diff(upd("passport_scan", starred=False)),
    ref=[act("unstar", rows="$passport_scan")]))

S("T26-042", "single count document folder count",
  T("count of docs that live in a folder", val(14),
    ref=[ans(op="count", kind="document", where="folder count > 0")]))

S("T26-043", "trashed documents restore multi",
  T("what documents are in the trash right now", rows("old_payslip", "old_quote", "old_lease"),
    ref=[ans(kind="document", trashed=True)]),
  T("restore the august payslip and the old roofing quote", diff(restore("old_payslip"), restore("old_quote")),
    ref=[act("restore", rows="$old_payslip, $old_quote")]),
  T("hmm undo that, they were deleted for a reason", diff(trash("old_payslip"), trash("old_quote")),
    ref=[act("undo")]))

S("T26-044", "restore document multi named count",
  T("restore Payslip August and Old roofing quote", diff(restore("old_payslip"), restore("old_quote")),
    ref=[find(kind="document", trashed=True), act("restore", rows="$old_payslip, $old_quote")]),
  T("how many payslips have i got", val(3),
    ref=[ans(op="count", kind="document", name="Payslip")]))

S("T26-046", "decline unbounded delete task where",
  T("delete all my tasks, i want a fresh start", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("ok the done one in shopping", diff(trash("school_bags")),
    ref=[act("delete", kind="task", linked_to="$shop_l", where='status = "completed"')]))

S("T26-047", "create person starred unstar new",
  T("add Emmanuel Obi and star him, he's the pastor praying at mama's party",
    diff(new("person", name="Emmanuel Obi", starred=True, role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Emmanuel Obi", role="pastor"), more=True),
         act("star", rows="$new")]),
  T("actually unstar him", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))

S("T26-048", "create person star unstar new",
  T("save Hauwa Garba, she's the caterer for mama's 70th", diff(new("person", name="Hauwa Garba", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Hauwa Garba", role="caterer"))]),
  T("star her", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("hmm no unstar, stars are for family", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]))

S("T26-049", "starred people unstar multi",
  T("who have i starred", rows("ngozi", "mama", "chidi", "olumide"),
    ref=[ans(kind="person", where="starred = yes")]),
  T("unstar chidi and olumide", diff(upd("chidi", starred=False), upd("olumide", starred=False)),
    ref=[act("unstar", rows="$chidi, $olumide")]))

S("T26-050", "starred cadence unstar multi description",
  T("starred people that have a cadence", rows("mama", "chidi", "olumide"),
    ref=[ans(kind="person", where="starred = yes and cadence is set")]),
  T("unstar the builder and chidi", diff(upd("olumide", starred=False), upd("chidi", starred=False)),
    ref=[act("unstar", rows="$olumide, $chidi")]))
