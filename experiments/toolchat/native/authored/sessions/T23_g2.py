from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))
NEXT_WEEKEND = span(U("week", 1, weekday=6), U("week", 1, weekday=7))
FROM_NOW = {"from": U("day", 0)}

S("T23-116", "ask balance malika never_mind balance negative plumber",
  T("how much does malika owe me", ask("malika_t", "malika_y"),
    ref=[search("malika", kind="person"),
         askc("malika tosheva the cousin or malika yusupova the nurse?", options="$malika_t, $malika_y")]),
  T("never mind, i'll check later", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("what do i owe the plumber", val((-400000, "UZS")),
    ref=[ans(op="balance", kind="person", where='role = "plumber"')]),
  T("star him, he's saved us twice", diff(upd("sardor_p", starred=True)),
    ref=[act("star", kind="person", where='role = "plumber"')]))

S("T23-117", "ask complete electricity never_mind contrast cancel by date",
  T("tick off pay electricity", ask("elec_06", "elec_07", "elec_08"),
    ref=[act("complete", kind="task", name="Pay electricity"),
         askc("june's, july's or august's?", options="$elec_06, $elec_07, $elec_08")]),
  T("don't bother, i'll pay on click first", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("cancel the dress fitting on the 22nd", diff(upd("fitting_2", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dress fitting with Kamola", when=W(D("2026-08-22")))]))

S("T23-118", "balance group positive weekend read",
  T("where do i stand in sunday plov", val((390000, "UZS")),
    ref=[find(kind="person", linked_to="$plov"),
         ans(op="balance", kind="group", name="Sunday plov", linked_to="$me")]),
  T("and the gift fund", val((2500000, "UZS")),
    ref=[ans(op="balance", kind="group", name="Kamola wedding gift", linked_to="$me")]),
  T("what's on this weekend", rows("swim_0808", "coffee_shahlo", "fitting_1", "plov_0809", "javlon_call_2"),
    ref=[ans(kind="event", when=W(WEEKEND))]),
  T("rename the gift fund group to Kamola gift", diff(upd("gift_fund", name="Kamola gift")),
    ref=[act("edit", kind="group", name="Kamola wedding gift", args=lines(name="Kamola gift"))]))

S("T23-119", "balance positive two star already-so",
  T("how much does farida owe me", val((500000, "UZS")),
    ref=[ans(op="balance", kind="person", name="Farida Nazarova")]),
  T("and shahlo", val((300000, "UZS")),
    ref=[ans(op="balance", kind="person", name="Shahlo Nurmatova")]),
  T("star farida too", diff(already=["farida"]),
    ref=[act("star", kind="person", name="Farida Nazarova"), ans(rows="$farida")]))

S("T23-120", "balance negative receptionist positive unstar",
  T("what do i owe the receptionist", val((-95000, "UZS")),
    ref=[ans(op="balance", kind="person", where='role = "receptionist"')]),
  T("and otabek", val((500000, "UZS")),
    ref=[ans(op="balance", kind="person", name="Otabek Ergashev")]),
  T("unstar shahlo, i see her enough", diff(upd("shahlo", starred=False)),
    ref=[act("unstar", kind="person", name="Shahlo Nurmatova")]),
  T("log a call with the receptionist, she rang about the rota", diff(upd("gulnora", date=ANY)),
    ref=[act("log", kind="person", where='role = "receptionist"', args=lines(kind="call"))]))

S("T23-121", "reschedule at_n bare weekday unbounded",
  T("push the supplier meeting to 3", diff(upd("supplier", date="2026-08-06T15:00")),
    ref=[act("reschedule", kind="event", name="Supplier meeting", args=lines(to=U("day", 0, anchor="row", time="15:00")))]),
  T("move the car service to friday at 5", diff(upd("car_service", date="2026-08-07T17:00")),
    ref=[act("reschedule", kind="event", name="Car service", args=lines(to=U("week", 0, weekday=5, time="17:00")))]),
  T("push monday's staff meeting to 9", diff(upd("staff_0810", date="2026-08-10T09:00")),
    ref=[act("reschedule", kind="event", name="Staff meeting", when=W(U("week", 1, weekday=1)),
             args=lines(to=U("day", 0, anchor="row", time="09:00")))]),
  T("delete all my tasks, fresh start for the new term", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T23-122", "create overlap refused then create unbounded",
  T("book lunch with malika thursday at 1", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Lunch with Malika", date=U("week", 0, weekday=4, time="13:00")))),
         askc("thursday at 1 you've got the supplier meeting till 2. another time?")]),
  T("friday at 1", diff(new("event", name=has("Malika"), date="2026-08-07T13:00")),
    ref=[act("create", args=lines(kind="event", name="Lunch with Malika", date=U("week", 0, weekday=5, time="13:00")))]),
  T("wipe all my events", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T23-123", "effort repair reschedule out_of_scope",
  T("which tasks take more than two hours", rows("insp_prep"),
    ref=[bad(ans(kind="task", where="effort > 2 hours")),
         ans(kind="task", where="effort > 120")]),
  T("push it to monday", diff(upd("insp_prep", date="2026-08-10")),
    ref=[act("reschedule", rows="$insp_prep", args=lines(to=U("week", 1, weekday=1)))]),
  T("send a telegram to farrukh that i'm running late", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T23-124", "search miss not_found restore refused not_found out_of_scope",
  T("when's my massage", decline("not_found"),
    ref=[search("massage"), dec("not_found")]),
  T("bring back the treadmill task", decline("not_found"),
    ref=[bad(act("restore", kind="task", name="Sell old treadmill", trashed=True)), dec("not_found")]),
  T("check if navruz hall has parking on their website", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T23-125", "multi star unstar locker starred read star",
  T("star the uzbek passport and unstar click app",
    diff(upd("passport", starred=True), upd("click", starred=False)),
    ref=[act("star", kind="locker item", name="Uzbek passport", more=True),
         act("unstar", kind="locker item", name="Click app")]),
  T("what do i have starred in the locker", rows("visa_card", "passport"),
    ref=[ans(kind="locker item", where="starred = yes")]),
  T("star the clinic crm too", diff(upd("crm", starred=True)),
    ref=[act("star", kind="locker item", name="Clinic CRM")]))

S("T23-126", "contrast star scan contract nurse",
  T("star scan 0713", diff(upd("scan_b", starred=True)),
    ref=[act("star", kind="document", name="Scan 0713")]),
  T("and the waste disposal contract", diff(upd("waste_doc", starred=True)),
    ref=[act("star", kind="document", name="Waste disposal contract")]),
  T("star the nurse", diff(upd("malika_y", starred=True)),
    ref=[act("star", kind="person", where='role = "nurse"')]))

S("T23-127", "contrast add_to log complete by name",
  T("add sardor nazarov to the samarkand weekend group", diff(link("samarkand_g", "sardor_c")),
    ref=[act("add_to", kind="person", name="Sardor Nazarov", args=lines(to="$samarkand_g"))]),
  T("log a message with kamola, told her the fabric is ready", diff(upd("kamola", date=ANY)),
    ref=[act("log", kind="person", name="Kamola Yusupova", args=lines(kind="message"))]),
  T("tick off the august electricity bill", diff(upd("elec_08", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay electricity", where='status = "open"')]))

S("T23-128", "next weekend read reschedule at_n two",
  T("what's on next weekend", rows("swim_0815", "laylo_bday", "gift_shop", "plov_0816"),
    ref=[ans(kind="event", when=W(NEXT_WEEKEND))]),
  T("push laylo's party to 5", diff(upd("laylo_bday", date="2026-08-15T17:00")),
    ref=[act("reschedule", kind="event", name="Laylo's party", args=lines(to=U("day", 0, anchor="row", time="17:00")))]),
  T("and gift shopping to 2", diff(upd("gift_shop", date="2026-08-16T14:00")),
    ref=[act("reschedule", kind="event", name="Gift shopping", args=lines(to=U("day", 0, anchor="row", time="14:00")))]))

S("T23-129", "multi write complete reschedule count log",
  T("mark pay gas bill done and push the air conditioner filters to saturday, gulnora's covering the clinic all day",
    diff(upd("gas", status="completed", completed=ANY), upd("aircon", date="2026-08-08")),
    ref=[act("complete", kind="task", name="Pay gas bill", more=True),
         act("reschedule", kind="task", name="Clean the air conditioner filters", args=lines(to=U("week", 0, weekday=6)))]),
  T("home list, how many still to do", val(3),
    ref=[ans(op="count", kind="task", linked_to="$home_l", where='status = "open"')]),
  T("log a coffee with shahlo, caught up on the weekend plans", diff(upd("shahlo", date=ANY)),
    ref=[act("log", kind="person", name="Shahlo Nurmatova", args=lines(kind="coffee"))]))

S("T23-130", "contrast cancel this saturday star already-so log nickname",
  T("cancel the dress fitting this saturday", diff(upd("fitting_1", status="cancelled")),
    ref=[act("cancel", kind="event", name="Dress fitting with Kamola", when=W(U("week", 0, weekday=6)))]),
  T("star rustam", diff(already=["rustam"]),
    ref=[act("star", kind="person", name="Rustam Rahimov"), ans(rows="$rustam")]),
  T("log a call with rus, he's at the dacha", diff(upd("rustam", date=ANY)),
    ref=[search("rus", kind="person"), act("log", rows="$rustam", args=lines(kind="call"))]))
