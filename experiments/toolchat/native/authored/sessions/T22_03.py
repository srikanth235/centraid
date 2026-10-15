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
