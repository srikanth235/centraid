from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T23-051", "four turns unstar where role unstar named count",
  T("unstar the clinic manager, i see him every day", diff(upd("farrukh", starred=False)),
    ref=[act("unstar", kind="person", where='role = "clinic manager"')]),
  T("who's still starred", rows("rustam", "dilbar", "farida", "aziz", "zarina", "gulnora", "shahlo"),
    ref=[ans(kind="person", where="starred = yes")]),
  T("gulnora too", diff(upd("gulnora", starred=False)),
    ref=[act("unstar", rows="$gulnora")]),
  T("how many is that", val(6),
    ref=[ans(op="count", kind="person", where="starred = yes")]))

S("T23-052", "edit group where currency members add_to",
  T("the dollar group, rename it Istanbul implant course", diff(upd("istanbul", name="Istanbul implant course")),
    ref=[act("edit", kind="group", where='currency = "USD"', args=lines(name="Istanbul implant course"))]),
  T("who's in it", rows("bekzod", "islom", "me"),
    ref=[ans(kind="person", linked_to="$istanbul")]),
  T("add Shakhnoza Aliyeva, the clinic is sending her too", diff(link("istanbul", "shakhnoza")),
    ref=[act("add_to", kind="person", name="Shakhnoza Aliyeva", args=lines(to="$istanbul"))]))

S("T23-053", "four turns create group edit new nickname search add_to read",
  T("new group Chorsu runs", diff(new("group", name="Chorsu runs"), link("new", "me")),
    ref=[act("create", args=lines(kind="group", name="Chorsu runs"))]),
  T("hmm call it Chorsu bazaar fund", diff(upd("+1", name="Chorsu bazaar fund")),
    ref=[act("edit", rows="$c1", args=lines(name="Chorsu bazaar fund"))]),
  T("put oyijon in it", diff(link("+1", "dilbar")),
    ref=[act("add_to", kind="person", name="Oyijon", args=lines(to="$c1")), search("Oyijon", kind="person"),
         act("add_to", rows="$dilbar", args=lines(to="$c1"))]),
  T("who's in it now", rows("me", "dilbar"),
    ref=[ans(kind="person", linked_to="$c1")]))

S("T23-054", "find-only event delete prev",
  T("can you find the charvak trip", rows("charvak"),
    ref=[find(kind="event", name="Charvak"), ans(rows="@prev")]),
  T("it was called off, delete it", diff(trash("charvak")),
    ref=[act("delete", rows="@prev")]))

S("T23-055", "restore window refused ask restore event named read",
  T("restore Yoga class", ask(),
    ref=[bad(act("restore", kind="event", name="Yoga class", trashed=True)),
         askc("yoga class was binned on 18 may, past the 30-day window, so it can't come back. want me to add it again?")]),
  T("no, forget yoga. is Gym trial restorable", diff(restore("gym_trial")),
    ref=[act("restore", kind="event", name="Gym trial", trashed=True)]),
  T("when was it", rows("gym_trial"),
    ref=[ans(rows="$gym_trial")]))

S("T23-056", "four turns create task complete reopen reschedule new",
  T("add a task call the gas company, tomorrow", diff(new("task", name=has("gas"), date="2026-08-06")),
    ref=[act("create", args=lines(kind="task", name="Call the gas company", date=U("day", 1)))]),
  T("mark it done", diff(upd("+1", status="completed", completed=ANY)),
    ref=[act("complete", rows="$c1")]),
  T("wait, nobody picked up. reopen it", diff(upd("+1", status="open", completed=None)),
    ref=[act("reopen", rows="$c1")]),
  T("push it to friday", diff(upd("+1", date="2026-08-07")),
    ref=[act("reschedule", rows="$c1", args=lines(to=U("week", 0, weekday=5)))]))

S("T23-057", "task effort unit find-only delete prev",
  T("quick jobs under fifteen min open", rows("call_javlon", "gas", "elec_08", "gloves"),
    ref=[ans(kind="task", where='effort < 15 min and status = "open"')]),
  T("find Book Samarkand hotel", rows("hotel"),
    ref=[find(kind="task", name="Book Samarkand hotel"), ans(rows="@prev")]),
  T("delete it, rustam already booked one", diff(trash("hotel")),
    ref=[act("delete", rows="@prev")]))

S("T23-058", "edit note multi unpin notebook count",
  T("unpin Aziz's plov and Oyijon medicines", diff(upd("aziz_plov", pinned=False), upd("meds", pinned=False)),
    ref=[act("edit", rows="$aziz_plov, $meds", args=lines(pinned="no"))]),
  T("which pinned notes are in a notebook", rows("insp_list"),
    ref=[ans(kind="note", where="pinned = yes and notebook count >= 1")]))

S("T23-059", "four turns notebook note count notes delete multi undo delete",
  T("which notebooks actually have notes in them", rows("clinic_nb", "journal_nb", "kids_nb", "recipes_nb",
                                                        "wedding_nb"),
    ref=[ans(kind="notebook", where="note count != 0")]),
  T("what's in recipes", rows("aziz_plov", "somsa", "lagman", "chuchvara"),
    ref=[ans(kind="note", linked_to="$recipes_nb")]),
  T("delete Somsa dough and Chuchvara, i never make them", diff(trash("somsa"), trash("chuchvara")),
    ref=[act("delete", rows="$somsa, $chuchvara")]),
  T("undo, rustam wants the somsa one", diff(restore("somsa"), restore("chuchvara")),
    ref=[act("undo")]))

S("T23-060", "document bin find-only restore window refused restore where",
  T("which docs are in the trash", rows("old_prices", "old_lease"),
    ref=[find(kind="document", trashed=True), ans(rows="@prev")]),
  T("bring back the old flat lease", ask(),
    ref=[bad(act("restore", rows="$old_lease")),
         askc("the old flat lease was binned on 1 april, past the 30 days, so it can't be restored. anything else?")]),
  T("ok then restore whatever's deleted from clinic papers", diff(restore("old_prices")),
    ref=[act("restore", kind="document", linked_to="$clinic_f", trashed=True)]),
  T("and my Old shopping list note, restore that as well", ask(),
    ref=[act("restore", kind="note", name="Old shopping list"),
         bad(act("restore", rows="$old_shopping")),
         askc("that note was binned on 5 may, too long ago to restore. want me to start a new shopping list note?")]))

S("T23-061", "find-only document remove_from prev",
  T("find Laylo medical card", rows("laylo_card"),
    ref=[find(kind="document", name="Laylo medical card"), ans(rows="@prev")]),
  T("that's not school stuff, take it out of kids school", diff(unlink("school_f", "laylo_card")),
    ref=[act("remove_from", rows="@prev", args=lines(from_="$school_f"))]))

S("T23-062", "photo person count album remove_from named",
  T("family album photos with two or more people", rows("p_couple", "p_melons"),
    ref=[ans(kind="photo", linked_to="$family_a", where="person count >= 2")]),
  T("take Kids with melons out of family, it's in kids already", diff(unlink("family_a", "p_melons")),
    ref=[act("remove_from", kind="photo", name="Kids with melons", args=lines(from_="$family_a"))]))

S("T23-063", "create album edit new add_to photo",
  T("make an album Laylo sixth birthday", diff(new("album", name="Laylo 6th birthday")),
    ref=[act("create", args=lines(kind="album", name="Laylo 6th birthday"))]),
  T("rename it Laylo turns 6", diff(upd("+1", name="Laylo turns 6")),
    ref=[act("edit", rows="$c1", args=lines(name="Laylo turns 6"))]),
  T("put Brave Laylo and Laylo in the park in it, then show me what's in there",
    rows("p_brave", "p_park", also=diff(link("+1", "p_brave"), link("+1", "p_park"))),
    ref=[find(kind="photo", name="Brave Laylo"), find(kind="photo", name="Laylo in the park"),
         act("add_to", rows="$p_brave, $p_park", args=lines(to="$c1"), more=True),
         ans(kind="photo", linked_to="$c1")]))

S("T23-064", "delete locker named search miss decline",
  T("delete Javlon's USDT wallet from the locker, he closed it", diff(trash("usdt")),
    ref=[act("delete", kind="locker item", name="Javlon's USDT wallet")]),
  T("search my stuff for bukhara", decline("not_found"),
    ref=[search("Bukhara"), dec("not_found")]))

S("T23-065", "locker bin restore multi undo restore",
  T("anything deleted in the locker?", rows("old_email", "old_gym"),
    ref=[find(kind="locker item", trashed=True), ans(rows="@prev")]),
  T("restore Old clinic email and Old gym card", diff(restore("old_email"), restore("old_gym")),
    ref=[act("restore", rows="$old_email, $old_gym")]),
  T("undo that, i don't need them after all", diff(trash("old_email"), trash("old_gym")),
    ref=[act("undo")]))

S("T23-066", "notebook empty read edit where",
  T("any empty notebook?", rows("courses_nb"),
    ref=[ans(kind="notebook", where="note count = 0")]),
  T("rename the empty one Implant course 2026", diff(upd("courses_nb", name="Implant course 2026")),
    ref=[act("edit", kind="notebook", where="note count = 0", args=lines(name="Implant course 2026"))]))

S("T23-067", "folder refused delete ask edit folder named read",
  T("delete the Home folder", ask(),
    ref=[bad(act("delete", kind="folder", name="Home")),
         askc("the home folder still has the flat certificate and the gas contract in it. move them out first, or keep the folder?")]),
  T("keep it, rename it Flat papers", diff(upd("home_f", name="Flat papers")),
    ref=[act("edit", kind="folder", name="Home", args=lines(name="Flat papers"))]),
  T("what's in it again", rows("flat_cert", "gas_contract"),
    ref=[ans(kind="document", linked_to="$home_f")]))

S("T23-068", "five turns lunch fund debt count balance settle_up settle_debt",
  T("who's in the clinic lunch fund", rows("malika_y", "gulnora", "shakhnoza", "bekzod", "farrukh", "me"),
    ref=[ans(kind="person", linked_to="$lunch_fund")]),
  T("anyone in there i've got no debts with", rows("shakhnoza", "farrukh", "malika_y", "me"),
    ref=[ans(kind="person", linked_to="$lunch_fund", where="debt count <= 0")]),
  T("where am i with gulnora", val((-95000, "UZS")),
    ref=[ans(op="balance", rows="$gulnora")]),
  T("settle up with her in the lunch fund", diff(settle=["Gulnora Saidova"]),
    ref=[act("settle_up", rows="$gulnora", args=lines(group="$lunch_fund"))]),
  T("and settle the Lunch cover debt too", diff(upd("d_gulnora", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Lunch cover")]))

S("T23-069", "four turns debt status in max within person count",
  T("open debts where i'm the one who owes", rows("d_kamola", "d_javlon", "d_gulnora", "d_zarina", "d_sardor_p"),
    ref=[ans(kind="debt", where='status in ("open") and direction = "i_owe"')]),
  T("biggest of those", val((1500000, "UZS")),
    ref=[ans(op="max", field="amount", rows="@prev")]),
  T("who's that to", rows("d_javlon"),
    ref=[ans(kind="debt", where='status in ("open") and direction = "i_owe" and amount = 1500000')]),
  T("how many debts in total have a person attached", val(13),
    ref=[ans(op="count", kind="debt", where="person count >= 1")]))

S("T23-070", "four turns locker notes contains reveal decline sealed read",
  T("clinic stuff in the locker", rows("backup", "crm", "assoc", "imaging", "sms_api"),
    ref=[ans(kind="locker item", where='notes contains "clinic"')]),
  T("show me the crm password", diff(reveal=[("crm", "Molar-2026!")]),
    ref=[act("reveal", rows="$crm", args=lines(field="password"))]),
  T("text it to bekzod", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("fine. what's the web address for it", rows("crm"),
    ref=[opn("$crm"), ans(rows="$crm")]))

S("T23-071", "five turns event anchor time cancel ambiguous lesson reschedule",
  T("what's at 1pm tomorrow", rows("supplier"),
    ref=[ans(kind="event", when=W(U("day", 1, anchor="today", time="13:00")))]),
  T("who's in it", rows("farrukh"),
    ref=[ans(kind="person", linked_to="$supplier")]),
  T("cancel it, the supplier postponed", diff(upd("supplier", status="cancelled")),
    ref=[act("cancel", rows="$supplier")]),
  T("what's left tomorrow", rows("oybek_pickup", "supplier", "tutor_1"),
    ref=[ans(kind="event", when=U("day", 1))]),
  T("move Samir english lesson to 5", diff(upd("tutor_1", date="2026-08-06T17:00")),
    ref=[act("reschedule", kind="event", name="Samir english lesson", args=lines(to=D("2026-08-06", "17:00"))),
         act("reschedule", rows="$tutor_1", args=lines(to=D("2026-08-06", "17:00")))]),
  T("random q, how many plov sundays were there before twelfth july 2pm", val(6),
    ref=[ans(op="count", kind="event", name="Sunday plov", when={"to": D("2026-07-12", "14:00")})]))

S("T23-072", "six turns event spans date named person count duration tomorrow",
  T("what's on between the twentieth and end of september that isn't me and one other person",
    rows("ortho_samir", "plov_0823", "staff_0824", "study_club", "plov_0830", "staff_0831", "school_start",
         "parents_school", "samarkand_trip", "congress", "wedding"),
    ref=[ans(kind="event", when=span(D("2026-08-20"), U("month", 0, name=9)), where="person count != 1")]),
  T("which of those run over three hours", rows("school_start", "samarkand_trip", "congress", "wedding"),
    ref=[ans(kind="event", within="@prev", where="duration > 180")]),
  T("who's on the samarkand one", rows("rustam", "dilbar"),
    ref=[ans(kind="person", linked_to="$samarkand_trip")]),
  T("add Laylo Rahimova and Samir Rahimov to the samarkand group too, then who's in the group",
    rows("rustam", "dilbar", "laylo", "samir", "me", also=diff(link("samarkand_g", "laylo"), link("samarkand_g", "samir"))),
    ref=[find(kind="person", name="Laylo Rahimova"), find(kind="person", name="Samir Rahimov"),
         act("add_to", rows="$laylo, $samir", args=lines(to="$samarkand_g"), more=True),
         ans(kind="person", linked_to="$samarkand_g")]),
  T("and from july first up to this monday, the long ones", rows("plov_0705", "fotiha", "plov_0712", "plov_0719",
                                                            "hygiene_training", "plov_0726", "charvak", "anniversary",
                                                            "plov_0802"),
    ref=[ans(kind="event", when=span(U("month", 0, name=7), U("week", 0, weekday=1)), where="duration > 120")]),
  T("how many of those got cancelled", val(2),
    ref=[ans(op="count", kind="event", within="@prev", where='status = "cancelled"')]))

S("T23-073", "single note named month span",
  T("notes from the start of july up to the twenty-fifth", rows("istanbul_hotels", "guests", "lagman", "gift_ideas",
                                                        "bek_notes"),
    ref=[ans(kind="note", when=span(U("month", 0, name=7), D("2026-07-25")))]))

S("T23-074", "person group count debt count find-only",
  T("people in two or more groups", rows("sardor_c", "zarina", "bekzod", "malika_t", "aziz", "rustam", "me"),
    ref=[ans(kind="person", where="group count >= 2")]),
  T("which of them have at most one debt with me", rows("sardor_c", "zarina", "bekzod", "malika_t", "aziz", "rustam",
                                                         "me"),
    ref=[ans(kind="person", within="@prev", where="debt count <= 1")]),
  T("find Malika Tosheva", rows("malika_t"),
    ref=[find(kind="person", name="Malika Tosheva"), ans(rows="@prev")]),
  T("what's she owe me", rows("d_malika_t"),
    ref=[ans(kind="debt", linked_to="$malika_t")]))

S("T23-075", "seven turns wedding prep ambiguous gift write read ask decline",
  T("when's kamola's wedding", rows("wedding"),
    ref=[ans(kind="event", name="Kamola's wedding")]),
  T("what's to do for it", rows("gift", "dress", "collect", "toast"),
    ref=[ans(kind="task", linked_to="$wedding_l", where='status = "open"')]),
  T("Buy gift for Kamola, bump it to priority one", diff(upd("gift", priority=1)),
    ref=[act("edit", kind="task", name="Buy gift for Kamola", args=lines(priority=1)),
         act("edit", rows="$gift", args=lines(priority=1))]),
  T("Write a toast for the wedding is done, and what's left on the list",
    rows("gift", "dress", "collect", also=diff(upd("toast", status="completed", completed=ANY))),
    ref=[act("complete", rows="$toast", more=True),
         ans(kind="task", linked_to="$wedding_l", where='status = "open"')]),
  T("whatsapp that list to zarina", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("ok tell me who's on the gift one", rows("kamola"),
    ref=[ans(kind="person", linked_to="$gift")]),
  T("and which dress fitting do i go to", ask("fitting_1", "fitting_2"),
    ref=[find(kind="event", name="Dress fitting with Kamola"),
         askc("there are two, this saturday the 8th at 3 and saturday the 22nd at 3. both are with kamola; want both?",
              options="$fitting_1, $fitting_2")]))
