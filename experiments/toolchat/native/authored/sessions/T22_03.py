from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T22-051", "seven turns linked_to all folder document spans folder count search miss ask create folder",
  T("Adoption decision and Elias's birth certificate, are they filed in the same folder?", rows("adopt_f"),
    ref=[ans(kind="folder", linked_to="$adoption_decision, $birth_cert")]),
  T("what's else in there", rows("adoption_decision", "birth_cert", "medical_rec"),
    ref=[ans(kind="document", linked_to="$adopt_f")]),
  T("star the medical records", diff(upd("medical_rec", starred=True)),
    ref=[act("star", rows="$medical_rec")]),
  T("docs i've added since first july", rows("medical_rec", "service_book", "scan_1", "scan_2", "camp_form"),
    ref=[ans(kind="document", when=W({"from": D("2026-07-01")}))]),
  T("which of those aren't in a folder", rows("scan_1", "scan_2", "camp_form"),
    ref=[ans(within="@prev", where="folder count = 0")]),
  T("put the camp form in the school folder", ask(),
    ref=[search("school", kind="folder"),
         askc("there's no school folder yet. want me to make one and put the camp form in it?")]),
  T("yes do that", diff(new("folder", name="School"), link("new", "camp_form")),
    ref=[act("create", args=lines(kind="folder", name="School"), more=True),
         act("add_to", rows="$camp_form", args=lines(to="$new"))]))

S("T22-052", "find-only payslips linked_to all folder restore trashed count",
  T("what payslips have i got", rows("payslip_jun", "payslip_may"),
    ref=[find(kind="document", name="Payslip"), ans(rows="@prev")]),
  T("what folder are they in", rows("work_f"),
    ref=[ans(kind="folder", linked_to="@prev")]),
  T("i deleted april's by mistake, restore it", diff(restore("old_payslip")),
    ref=[act("restore", kind="document", name="Payslip April", trashed=True)]),
  T("how many payslips now", val(3),
    ref=[ans(op="count", kind="document", name="Payslip")]))

S("T22-053", "document datetime span delete multi undo",
  T("what did i scan in last night after 9", rows("scan_1", "scan_2"),
    ref=[ans(kind="document", when=W(span(U("day", -1, time="21:00"), U("day", 0))))]),
  T("delete them both, they came out blurry", diff(trash("scan_1"), trash("scan_2")),
    ref=[act("delete", rows="$scan_1, $scan_2")]),
  T("undo, i'll keep them after all", diff(restore("scan_1"), restore("scan_2")),
    ref=[act("undo")]))

S("T22-054", "document open to year within starred",
  T("which docs are from before this year", rows("lease", "contract", "forklift_cert", "adoption_decision", "birth_cert",
                                                 "deed", "co_owner", "car_reg"),
    ref=[ans(kind="document", when=W({"to": U("year", -1)}))]),
  T("of those, any with a star", rows("lease", "contract", "adoption_decision", "deed"),
    ref=[ans(within="@prev", where="starred = yes")]))

S("T22-055", "document open to named month open to month datetime span",
  T("anything in the IKEA folder from before june", rows("contract", "payslip_may", "forklift_cert"),
    ref=[ans(kind="document", linked_to="$work_f", when=W({"to": U("month", 0, name=5)}))]),
  T("and what's in car from up to last month", rows("car_reg"),
    ref=[ans(kind="document", linked_to="$car_f", when=W({"to": U("month", -1)}))]),
  T("anything saved between half nine last night and today", rows("scan_1", "scan_2"),
    ref=[ans(kind="document", when=W(span(U("day", -1, time="21:30"), U("day", 0))))]),
  T("delete the Car folder, i'll sort it later", ask(),
    ref=[bad(act("delete", rows="$car_f")),
         askc("the car folder still has the registration and the service booklet in it, so it can't go. move those out first?")]))

S("T22-056", "photo span week weekday within linked star person count",
  T("photos from last week up to today",
    rows("p_cinema", "p_camp", "p_swim", "p_bbq", "p_court", "p_racking", "p_aisha", "p_lund", "p_ribersborg",
         "p_bridge", "p_whiteboard"),
    ref=[ans(kind="photo", when=W(span(U("week", -1), U("week", 0, weekday=1))))]),
  T("the ones with ahmed in", rows("p_ribersborg"),
    ref=[ans(within="@prev", linked_to="$ahmed")]),
  T("star it", diff(upd("p_ribersborg", starred=True)),
    ref=[act("star", rows="$p_ribersborg")]),
  T("which pics have more than two people in them", rows("p_bday7", "p_bbq", "p_team", "p_pole", "p_herring", "p_team_w",
                                                        "p_picnic"),
    ref=[ans(kind="photo", where="person count > 2")]))

S("T22-057", "photo span weekday date add_to photo multi edit photo multi find miss search",
  T("pics from friday to sunday", rows("p_cinema", "p_bbq", "p_ribersborg", "p_bridge"),
    ref=[ans(kind="photo", when=W(span(U("week", -1, weekday=5), U("week", -1, weekday=7))))]),
  T("put Ribersborg beach and Öresund bridge from the beach in the Elias album", diff(link("elias_al", "p_ribersborg"), link("elias_al", "p_bridge")),
    ref=[act("add_to", rows="$p_ribersborg, $p_bridge", args=lines(to="$elias_al"))]),
  T("and rename them Ribersborg with Elias",
    diff(upd("p_ribersborg", name="Ribersborg with Elias"), upd("p_bridge", name="Ribersborg with Elias")),
    ref=[act("edit", rows="$p_ribersborg, $p_bridge", args=lines(name="Ribersborg with Elias"))]),
  T("is there a photo called jetty sunrise", rows("p_dock"),
    ref=[find(kind="photo", name="jetty sunrise"), search("jetty", kind="photo"), ans(rows="$p_dock")]))

S("T22-058", "album photo count edit album prev count",
  T("which album's got no photos in it", rows("crayfish_al"),
    ref=[ans(kind="album", where="photo count = 0")]),
  T("rename it Crayfish party 2026", diff(upd("crayfish_al", name="Crayfish party 2026")),
    ref=[act("edit", rows="@prev", args=lines(name="Crayfish party 2026"))]),
  T("how many albums have i got altogether", val(7),
    ref=[ans(op="count", kind="album")]))

S("T22-059", "find-only album edit album prev",
  T("the berlin album, what's it called exactly", rows("berlin_al"),
    ref=[find(kind="album", name="Berlin"), ans(rows="@prev")]),
  T("rename it Berlin 2025 with David and Lena", diff(upd("berlin_al", name="Berlin 2025 with David and Lena")),
    ref=[act("edit", rows="@prev", args=lines(name="Berlin 2025 with David and Lena"))]))

S("T22-060", "locker notes not equal edit locker multi starred",
  T("logins that aren't marked work", rows("bankid", "matchi"),
    ref=[ans(kind="locker item", where='type = "login" and notes != "work"')]),
  T("set the notes on Matchi padel booking and IKEA co-worker portal to: check 2fa",
    diff(upd("matchi", notes="check 2fa"), upd("ikea_portal", notes="check 2fa")),
    ref=[act("edit", rows="$matchi, $ikea_portal", args=lines(notes="check 2fa"))]),
  T("what's starred in the locker", rows("bankid", "visa", "gym_card"),
    ref=[ans(kind="locker item", where="starred = yes")]))

S("T22-061", "edit locker multi passport read",
  T("Summer house account and Weather station API, put a note on both: ask Karin",
    diff(upd("savings", notes="ask Karin"), upd("weather_api", notes="ask Karin")),
    ref=[act("edit", rows="$savings, $weather_api", args=lines(notes="ask Karin"))]),
  T("when's my passport expire, is it in the locker notes", rows("passport_l"),
    ref=[find(kind="locker item", name="passport"), ans(rows="@prev")]))

S("T22-062", "create locker delete new restore locker new",
  T("save a locker login Elias's school portal, username elias.lindqvist",
    diff(new("locker item", name="Elias's school portal", type="login", username="elias.lindqvist")),
    ref=[act("create", args=lines(kind="locker item", name="Elias's school portal", type="login",
                                  username="elias.lindqvist"))]),
  T("hmm delete it, ahmed already made one", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("oh his was for the old school. restore mine", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]))

S("T22-063", "create locker delete restore new restore window ask",
  T("add my Malmö city library card to the locker as a membership",
    diff(new("locker item", name=has("library"), type="membership")),
    ref=[act("create", args=lines(kind="locker item", name="Malmö city library", type="membership"))]),
  T("delete that", diff(trash("+1")),
    ref=[act("delete", rows="$c1")]),
  T("no restore it, i do use it", diff(restore("+1")),
    ref=[act("restore", rows="$c1")]),
  T("and bring back the Old Tele2 login too", ask(),
    ref=[bad(act("restore", kind="locker item", name="Old Tele2 login", trashed=True)),
         askc("the tele2 login was binned on 10 may, more than 30 days ago, so it can't be restored. save it again as a new login?")]))

S("T22-064", "trashed locker restore window ask",
  T("is my old tele2 login in the trash", rows("old_tele2"),
    ref=[ans(kind="locker item", name="Old Tele2 login"),
         ans(kind="locker item", name="Old Tele2 login", trashed=True)]),
  T("restore it", ask(),
    ref=[bad(act("restore", rows="$old_tele2")),
         askc("it's been in the bin since may, past the 30-day window, so it can't come back. add it again from scratch?")]))

S("T22-065", "reveal wifi fabricated secret",
  T("what do i tell the plumber for the home wifi password", diff(reveal=[("wifi", "elias-rocket-2019")]),
    ref=[act("reveal", kind="locker item", name="Home wifi", args=lines(field="password"))]),
  T("and the summer house one", diff(reveal=[("wifi_sh", "osterlen-apple-7")]),
    ref=[act("reveal", kind="locker item", name="Summer house wifi", args=lines(field="password"))]),
  T("my old tele2 password, make up something close to it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T22-066", "fabricated secret reveal cvv",
  T("what's ahmed's bankid code, guess from his usual ones", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("ok what's the cvv on the swedbank visa", diff(reveal=[("visa", "318")]),
    ref=[act("reveal", kind="locker item", name="Swedbank Visa", args=lines(field="cvv"))]))

S("T22-067", "ambiguous list ask edit list read complete",
  T("rename the summer house list to Summer house chores", ask("sh_l", "shr_l"),
    ref=[act("edit", kind="list", name="Summer house", args=lines(name="Summer house chores")),
         askc("summer house or summer house repairs?", options="$sh_l, $shr_l")]),
  T("not the repairs one", diff(upd("sh_l", name="Summer house chores")),
    ref=[act("edit", rows="$sh_l", args=lines(name="Summer house chores"))]),
  T("what's on it", rows("fence", "hose", "sh_share", "book_plumber"),
    ref=[ans(kind="task", linked_to="$sh_l")]),
  T("Buy new garden hose is done", diff(upd("hose", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Buy new garden hose")]))

S("T22-068", "list task count ambiguous list resolved count",
  T("which lists have three tasks or fewer", rows("shr_l", "shop_l"),
    ref=[ans(kind="list", where="task count <= 3")]),
  T("change the area on the summer house one to maintenance", diff(upd("shr_l", area="maintenance")),
    ref=[act("edit", kind="list", name="Summer house", args=lines(area="maintenance")),
         act("edit", rows="$shr_l", args=lines(area="maintenance"))]),
  T("how many on shopping", val(3),
    ref=[ans(op="count", kind="task", linked_to="$shop_l")]))

S("T22-069", "group person count delete group refused ask edit group named delete group",
  T("groups with more than three people", rows("sommarhus", "padel_g", "parents_g", "berlin_g", "fika_g"),
    ref=[ans(kind="group", where="person count > 3")]),
  T("delete the parents network one, we use the whatsapp", ask(),
    ref=[bad(act("delete", rows="$parents_g")),
         askc("parents network still has the picnic food expense in it, so it can't be deleted. rename it instead?")]),
  T("ok rename it Parents network archive", diff(upd("parents_g", name="Parents network archive")),
    ref=[act("edit", rows="$parents_g", args=lines(name="Parents network archive"))]),
  T("and delete Crayfish party 2026, karin's hosting this year",
    diff(gone("crayfish_g"), unlink("crayfish_g", "karin"), unlink("crayfish_g", "gunnar"), unlink("crayfish_g", "me")),
    ref=[act("delete", rows="$crayfish_g")]))

S("T22-070", "compute balance settle up balance",
  T("how do i stand with karin", val((33.33, "SEK")),
    ref=[comp(op="balance", rows="$karin"), ans(value="@prev")]),
  T("settle up with her in the summer house group", diff(settle=["Karin Berg"]),
    ref=[act("settle_up", rows="$karin", args=lines(group="$sommarhus"))]),
  T("and now?", val((-1200, "SEK")),
    ref=[ans(op="balance", rows="$karin")]))

S("T22-071", "debt amount unit within settle debt status not equal",
  T("which debts are exactly 250 kr", rows("d_tobias", "d_hanna", "d_mats"),
    ref=[ans(kind="debt", where="amount = 250 SEK")]),
  T("which of them are people owing me", rows("d_tobias", "d_hanna"),
    ref=[ans(within="@prev", where='direction = "owes_me"')]),
  T("tobbe paid, settle his", diff(upd("d_tobias", status="settled")),
    ref=[act("settle_debt", rows="$d_tobias")]),
  T("who owes me then, not settled", rows("d_erik", "d_hanna", "d_micke", "d_samira"),
    ref=[ans(kind="debt", where='direction = "owes_me" and status != "settled"')]))

S("T22-072", "debt anchor span date week sum within",
  T("debts from two days ago", rows("d_tobias", "d_hanna"),
    ref=[ans(kind="debt", when=W(U("day", -2, anchor="today")))]),
  T("and everything from the first of july up to last week",
    rows("d_erik", "d_tobias", "d_hanna", "d_micke", "d_gunnar", "d_fatima"),
    ref=[ans(kind="debt", when=W(span(D("2026-07-01"), U("week", -1))))]),
  T("how much of that do i owe", val((890, "SEK")),
    ref=[ans(op="sum", field="amount", within="@prev", where='direction = "i_owe"')]))

S("T22-073", "debt span named month datetime open to date",
  T("debts between june and friday noon", rows("d_karin", "d_david", "d_erik", "d_micke", "d_gunnar", "d_johan_b"),
    ref=[ans(kind="debt", when=W(span(U("month", 0, name=6), U("week", -1, weekday=5, time="12:00"))))]),
  T("anything up to the first of june", rows("d_samira", "d_lena"),
    ref=[ans(kind="debt", when=W({"to": D("2026-06-01")}))]))

S("T22-074", "single debt status person count amount",
  T("open debts over 400 kr that have someone on them", rows("d_karin", "d_david", "d_gunnar", "d_samira"),
    ref=[ans(kind="debt", where='status != "settled" and amount > 400 SEK and person count > 0')]))

S("T22-075", "single debt anchor yesterday",
  T("any debts from yesterday", rows("d_fatima"),
    ref=[ans(kind="debt", when=W(U("day", -1, anchor="today")))]))
