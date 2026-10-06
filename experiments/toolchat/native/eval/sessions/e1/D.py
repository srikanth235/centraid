from gold import *
import json

world("D", "2026-12-20T19:40", "Marisol Reyes-Kapoor", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("D-E001", "event follow-up reschedule log",
  T("is the kids dentist still on for this month, the early morning one", rows("dentist_kids"),
    ref=[ans(kind="event", name="kids dentist", when=W(U("month", 0)))]),
  T("and lucia's recital, is it next week as well", rows("recital"),
    ref=[ans(kind="event", name="winter ballet recital", when=W(U("week", 1)))]),
  T("push the dentist back an hour", diff(upd("dentist_kids", date="2026-12-21T09:00")),
    ref=[act("reschedule", kind="event", name="kids dentist", args=lines(to=U("hour", 1, anchor="row")))]),
  T("log a call with paul russo, about the new time", diff(upd("dentist_d", date=ANY)),
    ref=[act("log", kind="person", name="paul russo", args="kind: call")]))

S("D-E002", "list open complete reschedule",
  T("christmas stuff still to do?", rows("pack_gdl", "gifts_kids", "tamales", "passports_d"),
    ref=[ans(kind="task", linked_to="$xmas_l", where="status = open")]),
  T("the tamales order is confirmed, doña lupe just texted me back", diff(upd("tamales", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="tamales")]),
  T("push the fsa money thing to the thirtieth, after the airport run", diff(upd("fsa", date="2026-12-30")),
    ref=[act("reschedule", kind="task", name="fsa", args=lines(to=D("2026-12-30")))]))

S("D-E003", "nickname balance multi-currency group-balance",
  T("where am i with gabi", val((396.58, "USD"), (308.33, "MXN")),
    ref=[search("Gabi", kind="person"), ans(op="balance", rows="$gabi")]),
  T("and mamá, do we owe her anything for the trip", val((-225.02, "MXN")),
    ref=[search("Mamá", kind="person"), ans(op="balance", rows="$mama")]),
  T("what's my position in the beach house, the one with the groceries", val((-122.8, "USD")),
    ref=[search("Marisol", kind="person"), ans(op="balance", kind="group", name="LBI Beach House 2026", linked_to="$me")]))

S("D-E004", "restore trashed task reads",
  T("bring back the email to ms ortiz i deleted", diff(restore("tk689")),
    ref=[act("restore", kind="task", name="email ortiz", trashed=True)]),
  T("what's still open for monday, including the email i brought back", rows("pack_gdl", "tamales", "passports_d", "recital_flowers", "oof", "tk742", "tk689"),
    ref=[ans(kind="task", when=W(U("week", 1, weekday=1)), where="status = open")]))

S("D-E005", "weekend span cancel log",
  T("anything on this weekend that isn't cancelled, even a small thing", rows("call_mama154"),
    ref=[ans(kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))), where="status != cancelled")]),
  T("and next weekend, same thing, skip anything cancelled", rows("call_mama155", "date_night"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=6), U("week", 1, weekday=7))), where="status != cancelled")]),
  T("cancel date night", diff(upd("date_night", status="cancelled")),
    ref=[act("cancel", kind="event", name="date night")]),
  T("dev says it's fine, log a call with him about date night", diff(upd("dev", date=ANY)),
    ref=[act("log", kind="person", name="dev kapoor", args="kind: call")]))

S("D-E006", "ambiguous-event ask nth reschedule",
  T("when's the school concert coming up, either of the two this winter", rows("ev223", "ev181"),
    ref=[ans(kind="event", name="school concert", when=W({"from": U("day", 0)}))]),
  T("push the second one back an hour", diff(upd("ev181", date="2027-01-07T15:00")),
    ref=[act("reschedule", rows="$ev181", args=lines(to=U("hour", 1, anchor="row")))]),
  T("and the other one?", rows("ev223"),
    ref=[ans(kind="event", name="school concert", when=W({"from": U("day", 0)}), exclude="$ev181")]))

S("D-E007", "ambiguous-task ask narrow complete",
  T("tick off schedule dentist", ask("tk366", "tk458"),
    ref=[act("complete", kind="task", name="schedule dentist"),
         find(kind="task", name="schedule dentist", where="status = open"),
         askc("Which one, the one due today or the one from May?", options="@1")]),
  T("the one due today", diff(upd("tk366", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tk366")]),
  T("anything else due today that i should knock out tonight", rows("tk366"),
    ref=[ans(kind="task", when=W(U("day", 0)))]))

S("D-E008", "role-lookup log pronoun decline star",
  T("when did i last talk to my father", rows("papa"),
    ref=[ans(kind="person", where='role = "father"')]),
  T("just spoke to him, put it down as a call", rows("papa", also=diff(upd("papa", date=ANY))),
    ref=[act("log", rows="$papa", args="kind: call", more=True), ans(rows="$papa")]),
  T("tell sunita i said hi", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("star my father-in-law, rajesh, so he's near the top", diff(upd("rajesh", starred=True)),
    ref=[act("star", kind="person", name="rajesh")]))

S("D-E009", "create task edit effort move-list",
  T("add pick up the tamales on the twenty-fourth to the christmas list", diff(new("task", name=has("tamales"), date="2026-12-24"), link("xmas_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Pick up the tamales", date=D("2026-12-24"), list="$xmas_l"))]),
  T("make it an hour", diff(upd("+1", effort=60)),
    ref=[act("edit", rows="$c1", args="effort: 60")]),
  T("actually move it to the home list, christmas is getting crowded", diff(unlink("xmas_l", "+1"), link("home_l", "+1")),
    ref=[act("add_to", rows="$c1", args="to: $home_l")]))

S("D-E010", "note read edit body pinned",
  T("what's in the nochebuena menu note, the one for christmas eve", rows("xmas_menu"),
    ref=[find(kind="document", name="nochebuena menu"), ans(kind="note", name="nochebuena menu")]),
  T("change it to bacalao, romeritos, ponche and flan", diff(upd("xmas_menu", body=has("flan"))),
    ref=[act("edit", rows="$xmas_menu", args="body: bacalao, romeritos, ponche and flan")]),
  T("is that one pinned", rows("xmas_menu"),
    ref=[ans(kind="note", name="nochebuena menu", where="pinned = yes")]))

S("D-E011", "notebook count find delete restore",
  T("how many recipes do i have saved", val(25),
    ref=[find(kind="notebook", name="recipes"), ans(op="count", kind="note", linked_to="$recipes_d")]),
  T("which ones are flan", rows("nn19", "nn20", "nn21", "nn22"),
    ref=[ans(kind="note", where='body contains "flan"')]),
  T("delete the oldest one", diff(trash("nn21")),
    ref=[find(kind="note", name="flan", linked_to="$recipes_d", order="date asc", limit=1), act("delete", rows="$nn21")]),
  T("actually put it back, that was the one with grandma's note", diff(restore("nn21")),
    ref=[act("restore", rows="$nn21")]))

S("D-E012", "group members balance settle-up",
  T("who's on the ski weekend", rows("me", "dev", "liz", "pp20"),
    ref=[ans(kind="person", linked_to="$ski")]),
  T("so am i ahead or behind there after the gas", val((-210.2, "USD")),
    ref=[search("Marisol", kind="person"), ans(op="balance", kind="group", name="Vermont Ski Weekend", linked_to="$me")]),
  T("settle up with liz there, she sent me the money earlier today", diff(upd("liz", balance=ANY)),
    ref=[act("settle_up", rows="$liz", args="group: $ski")]))

S("D-E013", "debt sum compute max settle",
  T("add up everything i owe people, so we can clear it by the end of december", val((1217.93, "USD")),
    ref=[comp(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open"), ans(value="@prev")]),
  T("and what's owed to me", val((1225.83, "USD")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open")]),
  T("who owes me the most", rows("gabi_flight"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open", order="amount desc", limit=1)]),
  T("mark the hamilton tickets one as paid", diff(upd("liz_tix", status="settled")),
    ref=[act("settle_debt", kind="debt", name="hamilton tickets")]))

S("D-E014", "trashed-task find restore reschedule",
  T("any open task i deleted by accident", rows("tk689", "tk728"),
    ref=[ans(kind="task", where="status = open", trashed=True)]),
  T("bring back the ortiz email", diff(restore("tk689")),
    ref=[act("restore", rows="$tk689")]),
  T("push it to tuesday, after the kids are in bed", diff(upd("tk689", date="2026-12-22")),
    ref=[act("reschedule", rows="$tk689", args=lines(to=U("week", 1, weekday=2)))]))

S("D-E015", "restore-refused trashed-document decline",
  T("can you get my old car loan doc back from the trash", decline("out_of_scope", "not_found"),
    ref=[bad(act("restore", kind="document", name="old car loan", trashed=True)), dec("out_of_scope")]),
  T("is it still in the trash though", rows("trashed_doc"),
    ref=[ans(kind="document", name="old car loan", trashed=True)]))

S("D-E016", "wifi ask reveal egress",
  T("show me the wifi password, my sister-in-law is at the door", ask("wifi_lk", "guest_wifi_d", "mom_wifi"),
    ref=[find(kind="locker item", name="wifi"), askc("Which wifi: Home, Guest, or Mamá's in Guadalajara?", options="@1")]),
  T("the home one", diff(reveal=[("wifi_lk", "Churro&Chai2026")]),
    ref=[act("reveal", rows="$wifi_lk", args="field: password")]),
  T("text it to the babysitter", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("D-E017", "wifi read locker-type",
  T("where's the wifi password saved, there should be a few of them", rows("wifi_lk", "guest_wifi_d", "mom_wifi"),
    ref=[ans(kind="locker item", name="wifi", where="type = wifi")]),
  T("what logins are in there", rows("bank_d", "ezpass", "school_portal", "netflix_d"),
    ref=[ans(kind="locker item", where="type = login")]),
  T("invent a netflix password for me", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("D-E018", "passport ambiguous ask",
  T("when does my passport expire, the airline form asks for it", ask("passport_m", "passport_d"),
    ref=[find(kind="locker item", name="passport"), askc("Yours or Dev's?", options="@1")]),
  T("mine", rows("passport_m"),
    ref=[ans(rows="$passport_m")]),
  T("and dev's", rows("passport_d"),
    ref=[ans(rows="$passport_d")]))

S("D-E019", "list open complete reschedule count",
  T("what's left on the kitchen reno", rows("cabinets", "permit", "appliances", "backsplash", "reno_budget"),
    ref=[ans(kind="task", linked_to="$reno_l", where='status in ("open", "in_progress")')]),
  T("budget's done, vinnie signed off", diff(upd("reno_budget", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="renovation budget")]),
  T("backsplash tile is due the twelfth, samples come then", diff(upd("backsplash", date="2027-01-12")),
    ref=[act("reschedule", kind="task", name="backsplash", args=lines(to=D("2027-01-12")))]),
  T("how many open ones now", val(4),
    ref=[ans(op="count", kind="task", linked_to="$reno_l", where='status in ("open", "in_progress")')]))

S("D-E020", "priority effort filters within",
  T("what's still open at priority 1, what can't slip", rows("mort35", "pack_gdl", "passports_d", "q4report"),
    ref=[ans(kind="task", where="priority = 1 and status = open")]),
  T("and the long ones, over an hour", rows("pack_gdl", "q4report"),
    ref=[ans(within="@prev", where="effort > 60")]),
  T("any of them with no time estimate, the ones i can't plan around", rows("mort35", "passports_d"),
    ref=[ans(kind="task", where="priority = 1 and status = open and effort is empty")]))

S("D-E021", "create person star log",
  T("new contact tomás herrera, plumber", diff(new("person", name="Tomás Herrera", role="plumber")),
    ref=[act("create", args=lines(kind="person", name="Tomás Herrera", role="plumber"))]),
  T("star him and set his cadence to every seven days, he'll be calling all week", diff(upd("+1", starred=True, cadence=7)),
    ref=[act("star", rows="$c1", more=True), act("edit", rows="$c1", args="cadence: 7")]),
  T("he just called back, put it down as a call with him", diff(upd("+1", date=ANY)),
    ref=[act("log", rows="$c1", args="kind: call")]))

S("D-E022", "folder docs star move",
  T("what's in the insurance folder, the home policy for the contractor especially", rows("dc43", "dc44", "dc45", "dc46", "dc47", "dc48", "dc49"),
    ref=[ans(kind="document", linked_to="$insurance_f")]),
  T("star the 2026 homeowners policy", diff(upd("dc47", starred=True)),
    ref=[act("star", kind="document", name="homeowners policy 2026")]),
  T("move it to the house folder", diff(unlink("insurance_f", "dc47"), link("house_f", "dc47")),
    ref=[find(kind="folder", name="house"), act("add_to", rows="$dc47", args="to: $house_f")]))

S("D-E023", "notebook create add delete log",
  T("make a new notebook called holiday", diff(new("notebook", name="Holiday")),
    ref=[act("create", args=lines(kind="notebook", name="Holiday"))]),
  T("put the nochebuena menu in it", diff(link("+1", "xmas_menu")),
    ref=[act("add_to", kind="note", name="nochebuena menu", args="to: $c1")]),
  T("actually just delete that notebook", diff(gone("+1"), unlink("+1", "xmas_menu")),
    ref=[act("delete", rows="$c1")]),
  T("i called mamá about the menu, log it as a call", diff(upd("mama", date=ANY)),
    ref=[search("Mamá", kind="person"), act("log", rows="$mama", args="kind: call")]))

S("D-E024", "photos album add",
  T("add img_4001 and img_4002 to the kids album", diff(link("al_kids", "ph311"), link("al_kids", "ph312")),
    ref=[find(kind="album", name="kids"), act("add_to", rows="$ph311, $ph312", args="to: $al_kids")]),
  T("how many photos in there now", val(2),
    ref=[ans(op="count", kind="photo", linked_to="$al_kids")]))

S("D-E025", "event create overlap repair",
  T("put yoga on tuesday at 6, the evening class i usually go to", rows("flight_gdl", "ev360", "soccer_prac120"),
    ref=[bad(act("create", args=lines(kind="event", name="Yoga", date=U("week", 1, weekday=2, time="18:00")))),
         ans(kind="event", when=W(U("week", 1, weekday=2)))]),
  T("ok make it 7 then", diff(new("event", name="Yoga", date="2026-12-22T19:00")),
    ref=[act("create", args=lines(kind="event", name="Yoga", date=U("week", 1, weekday=2, time="19:00")))]),
  T("and what's on wednesday", rows("ballet120", "posada"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=3)))]))

S("D-E026", "events on dates chain",
  T("anything on the twenty-fifth", rows("ev96"),
    ref=[ans(kind="event", when=W(D("2026-12-25")))]),
  T("and the twenty-sixth, is that just the call with mamá", rows("call_mama155"),
    ref=[ans(kind="event", when=W(D("2026-12-26")))]),
  T("new years eve?", rows("nye"),
    ref=[ans(kind="event", when=W(D("2026-12-31")))]))

S("D-E027", "cancelled already-so read",
  T("cancel the spa day, the one we rebooked twice", diff(already=["cancelled_spa"]),
    ref=[act("cancel", kind="event", name="spa day"), ans(rows="$cancelled_spa")]),
  T("when was that supposed to be", rows("cancelled_spa"),
    ref=[ans(rows="$cancelled_spa")]),
  T("book it again friday at 10", diff(new("event", name="Spa day", date="2026-12-25T10:00")),
    ref=[act("create", args=lines(kind="event", name="Spa day", date=U("week", 1, weekday=5, time="10:00")))]))

S("D-E028", "repair effort-unit open filter min",
  T("any open tasks that take over an hour, only the ones to start early", rows("pack_gdl", "gifts_kids", "q4report", "tk339", "tk192"),
    ref=[bad(find(kind="task", where="status = open and effort > 1 hour")),
         ans(kind="task", where="status = open and effort > 60")]),
  T("which one takes the longest", rows("q4report"),
    ref=[ans(within="@prev", order="effort desc", limit=1)]))

S("D-E029", "repair cadence-unit people",
  T("who's on a cadence longer than a fortnight", rows("tio"),
    ref=[bad(find(kind="person", where="cadence > 2 weeks")),
         ans(kind="person", where="cadence > 14 days")]),
  T("and the weekly ones, the ones i should be calling", rows("mama", "papa", "gabi"),
    ref=[ans(kind="person", where="cadence <= 7 days")]),
  T("when did i last call tío neto", rows("tio"),
    ref=[find(kind="person", name="tío neto"), search("Tío Neto", kind="person"), ans(rows="$tio")]))

S("D-E030", "repair reveal-missing card star",
  T("show me the amex card number", rows("amex_d"),
    ref=[bad(act("reveal", kind="locker item", name="amex", args="field: card_number")),
         ans(kind="locker item", name="amex", where="type = card")]),
  T("what's in the costco membership one, the membership number i guess", rows("costco_d"),
    ref=[ans(kind="locker item", name="costco", where="type = membership")]),
  T("star the hsa account, we use it every time the kids go to the doctor", diff(upd("hsa", starred=True)),
    ref=[act("star", kind="locker item", name="hsa")]))

S("D-E031", "repair balance-two-people ask nickname",
  T("how much does kavya owe me, the pta one or the cousin", ask("kavya", "kavya2"),
    ref=[bad(ans(op="balance", kind="person", name="kavya")),
         askc("Kavya Kapoor or Kavya Menon?", options="$kavya, $kavya2")]),
  T("menon", val((12.88, "USD")),
    ref=[ans(op="balance", rows="$kavya2")]),
  T("and what about the other kavya, dev's cousin", val((0, "USD")),
    ref=[ans(op="balance", rows="$kavya")]))

S("D-E032", "repair delete-folder docs decline",
  T("delete the school folder", rows("dc63", "dc64", "dc65", "dc66", "dc67"),
    ref=[bad(act("delete", rows="$school_f")), ans(kind="document", linked_to="$school_f")]),
  T("ok leave it then", decline("never_mind"),
    ref=[dec("never_mind")]))

S("D-E033", "repair remove-member balance",
  T("take kavya menon off the winter fair group", val((311.81, "USD")),
    ref=[bad(act("remove_from", rows="$kavya2", args="from: $pta")),
         ans(op="balance", kind="group", name="PTA Winter Fair", linked_to="$kavya2")]),
  T("that's what she's owed? ok never mind", decline("never_mind"),
    ref=[dec("never_mind")]))

S("D-E034", "repair where-name task",
  T("any open task about tile", rows("backsplash"),
    ref=[bad(find(kind="task", where='name contains "tile"')), ans(kind="task", name="tile", where="status = open")]),
  T("push it to the thirtieth, the showroom is closed until after christmas", diff(upd("backsplash", date="2026-12-30")),
    ref=[act("reschedule", rows="$backsplash", args=lines(to=D("2026-12-30")))]),
  T("how many open on the reno list now", val(5),
    ref=[ans(op="count", kind="task", linked_to="$reno_l", where='status in ("open", "in_progress")')]))

S("D-E035", "repair task-cancel edit-status",
  T("cancel paying rosa, dev did it already", diff(upd("nanny_pay", status="cancelled")),
    ref=[bad(act("cancel", kind="task", name="pay rosa")),
         act("edit", kind="task", name="pay rosa", args="status: cancelled")]),
  T("when's rosa's next shift, before we leave for the airport", decline("not_found"),
    ref=[find(kind="event", name="rosa"), search("Rosa"), dec("not_found")]))

S("D-E036", "repair field-lacks person decline",
  T("lucia's birthday is march 3rd", decline("out_of_scope"),
    ref=[search("Lucia", kind="person"), bad(act("edit", rows="$lucia", args="birthday: 2027-03-03")), dec("out_of_scope")]),
  T("ok what's her role in there", rows("lucia"),
    ref=[ans(rows="$lucia")]),
  T("star her, she should be up at the top with the family", diff(upd("lucia", starred=True)),
    ref=[act("star", rows="$lucia")]))

S("D-E037", "repair cancelled-reschedule create",
  T("move the spa day to thursday", ask("cancelled_spa"),
    ref=[bad(act("reschedule", kind="event", name="spa day", args=lines(to=U("week", 1, weekday=4)))),
         askc("The spa day was cancelled, make a new one for thursday?", options="$cancelled_spa")]),
  T("yeah thursday at 11", diff(new("event", name="Spa day", date="2026-12-24T11:00")),
    ref=[act("create", args=lines(kind="event", name="Spa day", date=U("week", 1, weekday=4, time="11:00")))]),
  T("actually cancel that, dev needs me thursday morning", diff(upd("+1", status="cancelled")),
    ref=[act("cancel", rows="$c1")]))

S("D-E038", "repair time-format create reschedule",
  T("haircut thursday at 9", diff(new("event", name="Haircut", date="2026-12-24T09:00")),
    ref=[bad(act("create", args='kind: event\nname: Haircut\ndate: {"unit":"week","rel":1,"weekday":4,"time":"9"}')),
         act("create", args=lines(kind="event", name="Haircut", date=U("week", 1, weekday=4, time="09:00")))]),
  T("push that haircut back an hour, there's a line at the bakery first", diff(upd("+1", date="2026-12-24T10:00")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("hour", 1, anchor="row")))]))
