from gold import *
import json

world("T23", "2026-08-05T07:55", "Nadia Rahimi", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T23-001", "nickname is set unstar named starred read",
  T("who have i saved with a nickname", rows("rustam", "dilbar", "kamola", "bekzod"),
    ref=[ans(kind="person", where="nickname is set")]),
  T("unstar Gulnora Saidova, she doesn't need to be on top", diff(upd("gulnora", starred=False)),
    ref=[act("unstar", kind="person", name="Gulnora Saidova")]),
  T("who's still starred", rows("rustam", "dilbar", "farida", "aziz", "zarina", "farrukh", "shahlo"),
    ref=[ans(kind="person", where="starred = yes")]))

S("T23-002", "unstar where role literal starred read",
  T("unstar all my cousins, too many stars", diff(upd("aziz", starred=False), upd("zarina", starred=False)),
    ref=[act("unstar", kind="person", where='role = "cousin" and starred = yes'),
         act("unstar", rows="$zarina, $aziz")]),
  T("ok who's left with a star", rows("rustam", "dilbar", "farida", "gulnora", "farrukh", "shahlo"),
    ref=[ans(kind="person", where="starred = yes")]))

S("T23-003", "ambiguous fitting ask options reschedule",
  T("move the dress fitting to 4pm", ask("fitting_1", "fitting_2"),
    ref=[act("reschedule", kind="event", name="Dress fitting with Kamola", args=lines(to=D("2026-08-08", "16:00"))),
         askc("there are two fittings, this saturday the 8th and saturday the 22nd. which one?",
              options="$fitting_1, $fitting_2")]),
  T("the first one", diff(upd("fitting_1", date="2026-08-08T16:00")),
    ref=[act("reschedule", rows="$fitting_1", args=lines(to=D("2026-08-08", "16:00")))]))

S("T23-004", "single decline never_mind",
  T("delete the Old clinic menu note... no wait, forget it, i need the old prices", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T23-005", "group person count edit group where add_to read",
  T("which groups have at least three people", rows("plov", "gift_fund", "lunch_fund", "istanbul", "samarkand_g"),
    ref=[ans(kind="group", where="person count >= 3")]),
  T("the one that's me, rename it Umrah 2027", diff(upd("umrah", name="Umrah 2027")),
    ref=[act("edit", kind="group", where="person count <= 1", args=lines(name="Umrah 2027"))]),
  T("add rustam to it", diff(link("umrah", "rustam")),
    ref=[act("add_to", kind="person", name="Rustam", args=lines(to="$umrah"))]),
  T("who's in it now", rows("me", "rustam"),
    ref=[ans(kind="person", linked_to="$umrah")]))

S("T23-006", "create group edit new add_to",
  T("make a group for Laylo's party costs", diff(new("group", name=has("Laylo")), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Laylo's party costs"))]),
  T("call it Laylo turns 6 instead", diff(upd("+1", name="Laylo turns 6")),
    ref=[act("edit", rows="$c1", args=lines(name="Laylo turns 6"))]),
  T("add zarina to it, she's splitting the cake with me", diff(link("+1", "zarina")),
    ref=[act("add_to", kind="person", name="Zarina", args=lines(to="$c1"))]))

S("T23-007", "find-only event delete prev",
  T("find the dacha weekend", rows("dacha_weekend"),
    ref=[find(kind="event", name="Dacha weekend"), ans(rows="@prev")]),
  T("it's cancelled anyway, delete it", diff(trash("dacha_weekend")),
    ref=[act("delete", rows="@prev")]))

S("T23-008", "trashed event read restore named reschedule",
  T("is Gym trial in the trash", rows("gym_trial"),
    ref=[ans(kind="event", name="Gym trial", trashed=True)]),
  T("restore Gym trial, i want to go after all", diff(restore("gym_trial")),
    ref=[act("restore", kind="event", name="Gym trial", trashed=True)]),
  T("put it on next tuesday at 7am", diff(upd("gym_trial", date="2026-08-11T07:00")),
    ref=[act("reschedule", rows="$gym_trial", args=lines(to=U("week", 1, weekday=2, time="07:00")))]))

S("T23-009", "create task complete reopen new",
  T("task: buy batteries for the apex locator, today", diff(new("task", name=has("batteries"), date="2026-08-05")),
    ref=[act("create", args=lines(kind="task", name="Buy batteries for the apex locator", date=U("day", 0)))]),
  T("done, got them at lunch", diff(upd("+1", status="completed", completed=ANY)),
    ref=[act("complete", rows="$c1")]),
  T("ugh wrong size. reopen it", diff(upd("+1", status="open", completed=None)),
    ref=[act("reopen", rows="$c1")]))

S("T23-010", "task search delete prev",
  T("any task about the gym", rows("gym"),
    ref=[ans(kind="task", name="gym")]),
  T("delete that, not happening this year", diff(trash("gym")),
    ref=[act("delete", rows="@prev")]),
  T("shopping list, what's due from saturday 9am on", rows("rice", "lamb"),
    ref=[ans(kind="task", linked_to="$shop_l", when={"from": D("2026-08-08", "09:00")})]))

S("T23-011", "edit note multi pinned read",
  T("pin Toast draft and Gift ideas for Kamola", diff(upd("toast_draft", pinned=True), upd("gift_ideas", pinned=True)),
    ref=[act("edit", rows="$toast_draft, $gift_ideas", args=lines(pinned="yes"))]),
  T("what's pinned now", rows("aziz_plov", "insp_list", "meds", "toast_draft", "gift_ideas"),
    ref=[ans(kind="note", where="pinned = yes")]))

S("T23-012", "notebook notes delete multi count notebooks",
  T("notes in my journal notebook", rows("july_thoughts", "june_thoughts"),
    ref=[ans(kind="note", linked_to="$journal_nb")]),
  T("delete both, i'm going back to a paper diary", diff(trash("july_thoughts"), trash("june_thoughts")),
    ref=[act("delete", rows="@prev")]),
  T("how many notebooks are empty", val(2),
    ref=[ans(op="count", kind="notebook", where="note count = 0")]))

S("T23-013", "delete document named folder count count",
  T("delete Car insurance policy, the new one is coming", diff(trash("car_policy")),
    ref=[act("delete", kind="document", name="Car insurance policy")]),
  T("how many docs are actually filed in a folder", val(13),
    ref=[ans(op="count", kind="document", where="folder count != 0")]),
  T("is there an insurance folder somewhere", decline("not_found"),
    ref=[ans(kind="folder", name="Insurance"), search("insurance", kind="folder"), dec("not_found")]))

S("T23-014", "trashed document read restore where",
  T("did i delete something from clinic papers", rows("old_prices"),
    ref=[ans(kind="document", linked_to="$clinic_f", trashed=True)]),
  T("put back whatever's deleted in there", diff(restore("old_prices")),
    ref=[act("restore", kind="document", linked_to="$clinic_f", trashed=True)]))

S("T23-015", "find-only document remove_from prev",
  T("find Tax declaration 2025", rows("tax_2025"),
    ref=[find(kind="document", name="Tax declaration 2025"), ans(rows="@prev")]),
  T("take it out of the taxes folder, ravshan has the original", diff(unlink("tax_f", "tax_2025")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$tax_f"))]))

S("T23-016", "delete photo named remove_from photo named",
  T("delete Screenshot 0729", diff(trash("p_screenshot")),
    ref=[act("delete", kind="photo", name="Screenshot 0729")]),
  T("and take Kamola and Otabek out of the family album, it's a wedding one",
    diff(unlink("family_a", "p_couple")),
    ref=[act("remove_from", kind="photo", name="Kamola and Otabek", args=lines(from_="$family_a"))]))

S("T23-017", "create album edit new",
  T("new album Samarkand 2026", diff(new("album", name="Samarkand 2026")),
    ref=[act("create", args=lines(kind="album", name="Samarkand 2026"))]),
  T("call it Samarkand weekend", diff(upd("+1", name="Samarkand weekend")),
    ref=[act("edit", rows="$c1", args=lines(name="Samarkand weekend"))]))

S("T23-018", "delete locker named where empty",
  T("remove Laptop from the locker, i sold it", diff(trash("laptop")),
    ref=[act("delete", kind="locker item", name="Laptop")]),
  T("any other password type entries left", rows(),
    ref=[ans(kind="locker item", where='type = "password"')]))

S("T23-019", "locker trashed find restore multi",
  T("what's sitting in the locker trash", rows("old_email", "old_gym"),
    ref=[find(kind="locker item", trashed=True), ans(rows="@prev")]),
  T("restore both of them", diff(restore("old_email"), restore("old_gym")),
    ref=[act("restore", rows="$old_email, $old_gym")]))

S("T23-020", "single edit notebook where",
  T("rename the empty notebook to Implant course", diff(upd("courses_nb", name="Implant course")),
    ref=[act("edit", kind="notebook", where="note count = 0", args=lines(name="Implant course"))]))

S("T23-021", "edit folder named add_to multi",
  T("rename the Scans folder to Receipts", diff(upd("scans_f", name="Receipts")),
    ref=[act("edit", kind="folder", name="Scans", args=lines(name="Receipts"))]),
  T("which docs aren't in any folder", rows("course_invite", "car_policy", "scan_a", "scan_b"),
    ref=[ans(kind="document", where="folder count = 0")]),
  T("put the two scans in it", diff(link("scans_f", "scan_a"), link("scans_f", "scan_b")),
    ref=[act("add_to", rows="$scan_a, $scan_b", args=lines(to="$scans_f"))]))

S("T23-022", "person yesterday role within",
  T("who did i talk to yesterday", rows("gulnora", "rustam", "malika_y", "sardor_p", "kamola"),
    ref=[ans(kind="person", when=U("day", -1))]),
  T("the nurse among them?", rows("malika_y"),
    ref=[ans(kind="person", within="@prev", where='role = "nurse"')]))

S("T23-023", "empty result person search misspelling",
  T("last time i spoke with shahnoza?", rows("shakhnoza"),
    ref=[ans(kind="person", name="Shahnoza"), search("Shahnoza", kind="person"), ans(rows="$shakhnoza")]),
  T("mark a call with her", diff(upd("shakhnoza", date=ANY)),
    ref=[act("log", rows="$shakhnoza", args=lines(kind="call"))]))

S("T23-024", "compute max debt direction",
  T("biggest open debt each way", vgroups({"owes_me": (500000, "UZS"), "i_owe": (1500000, "UZS")}),
    ref=[comp(op="max", field="amount", kind="debt", where='status = "open"', group="direction"),
         ans(value="@prev")]),
  T("which ones are the 500k", rows("d_bekzod", "d_otabek"),
    ref=[ans(kind="debt", where="amount = 500000 and status = \"open\"")]),
  T("and everything that isn't 500k", rows("d_aziz", "d_zarina", "d_gulnora", "d_javlon", "d_shahlo", "d_sardor_p",
                                          "d_nigora", "d_kamola", "d_malika_t", "d_anvar"),
    ref=[ans(kind="debt", where="amount != 500000")]))

S("T23-025", "seven turns clinic morning tomorrow anchor time reschedule complete read",
  T("anything at 9 tomorrow", rows("oybek_pickup"),
    ref=[ans(kind="event", when=W(U("day", 1, anchor="today", time="09:00")))]),
  T("who's that with", rows("oybek"),
    ref=[ans(kind="person", linked_to="$oybek_pickup")]),
  T("push it a day, same 9am", diff(upd("oybek_pickup", date="2026-08-07T09:00")),
    ref=[act("reschedule", rows="$oybek_pickup", args=lines(to=U("day", 1, anchor="row", time="09:00")))]),
  T("what's left on friday after that", rows("xray_service", "oybek_pickup"),
    ref=[ans(kind="event", when=U("week", 0, weekday=5))]),
  T("tasks due tomorrow", rows("autoclave", "gasket", "pills", "call_javlon"),
    ref=[ans(kind="task", when=U("day", 1))]),
  T("Call Javlon about mum's ticket is done, called him last night", diff(upd("call_javlon", status="completed",
                                                                             completed=ANY)),
    ref=[act("complete", rows="$call_javlon")]),
  T("which of tomorrow's are open", rows("autoclave", "gasket", "pills"),
    ref=[ans(kind="task", when=U("day", 1), where='status != "completed"')]))
