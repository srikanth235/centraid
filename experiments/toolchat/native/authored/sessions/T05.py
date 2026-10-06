from gold import *
import json

world("T05", "2026-01-20T06:40", "Priya Raman", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T05-002", "event find edit prev",
  T("when's amma's eye consultation", rows("cataract_1"),
    ref=[ans(kind="event", name="Amma cataract consultation")]),
  T("add to it: bring aadhaar and the 2024 reports", diff(upd("cataract_1", description="bring aadhaar and the 2024 reports")),
    ref=[act("edit", rows="@prev", args=lines(description="bring aadhaar and the 2024 reports"))]),
  T("and amma cataract surgery is on the thirteenth?", rows("cataract_2"),
    ref=[ans(kind="event", name="Amma cataract surgery")]))

S("T05-003", "ambiguous event temple meeting ask",
  T("move the temple committee meeting to 4pm", ask("tc_0124", "tc_0207"),
    ref=[act("reschedule", kind="event", name="Temple committee meeting", when=W({"from": U("day", 0)}),
             args=lines(to=U("day", 0, anchor="row", time="16:00"))),
         find(kind="event", name="Temple committee meeting", when=W({"from": U("day", 0)})),
         askc("this saturday's meeting or the one on 7 feb?", options="$tc_0124, $tc_0207")]),
  T("this sat", diff(upd("tc_0124", date="2026-01-24T16:00")),
    ref=[act("reschedule", rows="$tc_0124", args=lines(to=U("day", 0, anchor="row", time="16:00")))]))

S("T05-004", "person create edit new add_to",
  T("add a contact, Aishwarya Menon, new ICU nurse from the float pool",
    diff(new("person", name="Aishwarya Menon", role=has("ICU"))),
    ref=[act("create", args=lines(kind="person", name="Aishwarya Menon", role="ICU nurse, float pool"))]),
  T("she goes by Aishu", diff(upd("+1", nickname="Aishu")),
    ref=[act("edit", rows="$new", args=lines(nickname="Aishu"))]),
  T("and she's joining the carpool", diff(link("carpool", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$carpool"))]),
  T("who's in the carpool", rows("divya_s", "jaya", "ramesh_d", "me", "+1"),
    ref=[ans(kind="person", linked_to="$carpool")]))

S("T05-005", "debt balance min max compute",
  T("who owes me money right", rows("d_divya_k", "d_arjun", "d_suresh", "d_karthik", "d_vignesh"),
    ref=[ans(kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("smallest one?", val((450, "INR")),
    ref=[ans(op="min", field="amount", within="@prev")]),
  T("and the biggest", val((3000, "INR")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("karthi paid back the visa money", diff(upd("d_karthik", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Visa fee advance")]))

S("T05-006", "debt settle prev",
  T("what do i owe revathi subramanian for", rows("d_revathi"),
    ref=[ans(kind="debt", linked_to="$revathi", where='direction = "i_owe"')]),
  T("paid her by gpay, mark it", diff(upd("d_revathi", status="settled")),
    ref=[act("settle_debt", rows="@prev")]))

S("T05-007", "locker star named reveal",
  T("star the TNNMC portal login", diff(upd("tnnmc_login", starred=True)),
    ref=[act("star", kind="locker item", name="TNNMC portal login")]),
  T("need the password, renewal's due", diff(reveal=[("tnnmc_login", "nurse@2021")]),
    ref=[act("reveal", rows="$tnnmc_login", args=lines(field="password"))]))

S("T05-008", "locker unstar multi",
  T("which locker things are starred", rows("his", "hdfc_card", "upi_pin", "sbi_acct"),
    ref=[ans(kind="locker item", where="starred = yes")]),
  T("unstar the card and the upi pin, too many stars", diff(upd("hdfc_card", starred=False), upd("upi_pin", starred=False)),
    ref=[act("unstar", rows="$hdfc_card, $upi_pin")]))

S("T05-009", "document star named trashed restore window",
  T("star the kauvery offer letter", diff(upd("offer", starred=True)),
    ref=[act("star", kind="document", name="Kauvery offer letter")]),
  T("is my november payslip in the trash?", rows("payslip_nov"),
    ref=[ans(kind="document", name="Payslip November", trashed=True)]),
  T("pull that one out of the trash", diff(restore("payslip_nov")),
    ref=[act("restore", rows="$payslip_nov")]),
  T("and the old PG rental agreement too", decline("not_found"),
    ref=[bad(act("restore", kind="document", name="PG rental agreement 2024", trashed=True)),
         dec("not_found")]))

S("T05-010", "document unstar where folder",
  T("what's starred in my nursing folder", rows("reg_cert", "roster_doc"),
    ref=[ans(kind="document", linked_to="$work_f", where="starred = yes")]),
  T("unstar both", diff(upd("reg_cert", starred=False), upd("roster_doc", starred=False)),
    ref=[act("unstar", rows="@prev")]),
  T("and whatever's starred in medical", diff(upd("amma_scan", starred=False)),
    ref=[act("unstar", kind="document", linked_to="$med_f", where="starred = yes")]))

S("T05-011", "photo delete multi undo",
  T("delete the blurry kolam shot and the pharmacy receipt pic",
    diff(trash("blurry_kolam"), trash("receipt_pic"), unlink("pongal_al", "blurry_kolam")),
    ref=[act("delete", rows="$blurry_kolam, $receipt_pic")]),
  T("wait undo, the receipt is for the insurance claim", diff(restore("blurry_kolam"), restore("receipt_pic"),
                                                              link("pongal_al", "blurry_kolam")),
    ref=[act("undo")]))

S("T05-012", "photo star prev",
  T("pics of suri", rows("gang_selfie", "suri_dance"),
    ref=[search("suri", kind="person"), ans(kind="photo", linked_to="$suresh")]),
  T("which one's him dancing", rows("suri_dance"),
    ref=[find(within="@prev", name="dancing"), ans(rows="@prev")]),
  T("star that", diff(upd("suri_dance", starred=True)),
    ref=[act("star", rows="@prev")]))

S("T05-013", "album delete named knock-on",
  T("delete the memes album, its embarrassing", diff(gone("memes_al"), unlink("memes_al", "meme_1"), unlink("memes_al", "meme_2")),
    ref=[act("delete", kind="album", name="Memes")]),
  T("how many photos have no album", val(9),
    ref=[ans(op="count", kind="photo", where="album count <= 0")]))

S("T05-014", "folder edit named",
  T("could you rename the nursing folder to Kauvery ICU", diff(upd("work_f", name="Kauvery ICU")),
    ref=[act("edit", kind="folder", name="Nursing", args=lines(name="Kauvery ICU"))]))

S("T05-015", "list create add_to prev",
  T("make a list called Dubai trip, travel", diff(new("list", name="Dubai trip", area="travel")),
    ref=[act("create", args=lines(kind="list", name="Dubai trip", area="travel"))]),
  T("what tasks do i have that mention dubai", rows("dubai_visa"),
    ref=[search("dubai", kind="task"), ans(rows="$dubai_visa")]),
  T("put it on the new list", diff(link("+1", "dubai_visa")),
    ref=[act("add_to", rows="@prev", args=lines(to="$c1"))]))

S("T05-016", "task edit named priority",
  T("make renew passport priority one, it expires in june", diff(upd("passport", priority=1)),
    ref=[act("edit", kind="task", name="Renew passport", args=lines(priority=1))]),
  T("what else is priority one and open", rows("reports", "leave", "selvi_pay", "bls_cert", "insurance_claim"),
    ref=[ans(kind="task", where='priority = 1 and status = "open"', exclude="$passport")]))

S("T05-018", "note restore multi",
  T("what's in the notes trash", rows("adai", "old_roster", "old_shopping", "hindi_words"),
    ref=[ans(kind="note", trashed=True)]),
  T("restore the adai one and hindi phrases", diff(restore("adai"), restore("hindi_words")),
    ref=[act("restore", rows="$adai, $hindi_words")]),
  T("the diwali list too", ask(),
    ref=[find(kind="note", name="Diwali", trashed=True),
         bad(act("restore", rows="$old_shopping")),
         askc("the diwali shopping list was binned more than 30 days ago so it can't come back. want me to make a fresh note with the same items?")]))

S("T05-019", "note add_to multi notebook",
  T("put the carpool timings and wifi reset notes in the journal notebook",
    diff(link("journal_nb", "carpool_n"), link("journal_nb", "wifi_n")),
    ref=[act("add_to", rows="$carpool_n, $wifi_n", args=lines(to="$journal_nb"))]),
  T("how many notes in journal", val(5),
    ref=[ans(op="count", kind="note", linked_to="$journal_nb")]))

S("T05-020", "person remove_from where group",
  T("jayanthi pillai and sowmya raghavan are chipping in for farhan, add both to the farewell gift group",
    diff(link("farewell_g", "jaya"), link("farewell_g", "sowmya")),
    ref=[act("add_to", rows="$jaya, $sowmya", args=lines(to="$farewell_g"))]),
  T("divya s too", diff(link("farewell_g", "divya_s")),
    ref=[act("add_to", rows="$divya_s", args=lines(to="$farewell_g"))]),
  T("take the charge nurse out, she's doing her own gift", diff(unlink("farewell_g", "sowmya")),
    ref=[act("remove_from", kind="person", where='role contains "charge nurse"', args=lines(from_="$farewell_g"))]),
  T("who's left in it", rows("divya_s", "jaya", "me"),
    ref=[ans(kind="person", linked_to="$farewell_g")]))

S("T05-021", "empty notebook recovery",
  T("what's in my tamil class notebook", ask("hindi_nb"),
    ref=[find(kind="notebook", name="Tamil class"),
         askc("there's no tamil notebook, only Hindi class. that one?", options="$hindi_nb")]),
  T("ya the hindi one, i mix them up", rows(),
    ref=[ans(kind="note", linked_to="$hindi_nb")]))

S("T05-022", "search hit event linked_to all",
  T("what am i doing with divya s and jaya together", rows("night_0109", "night_0110", "night_0123", "night_0124",
                                                         "night_0127", "night_0128", "night_0206", "night_0207", "farewell"),
    ref=[ans(kind="event", linked_to="$divya_s, $jaya")]),
  T("and just after today", rows("night_0123", "night_0124", "night_0127", "night_0128", "night_0206", "night_0207",
                                  "farewell"),
    ref=[ans(within="@prev", when=W({"from": U("day", 0)}))]))

S("T05-023", "answer value count",
  T("how many cricket nights have we had since november", val(3),
    ref=[ans(op="count", kind="event", name="Cricket night at Vicky's",
             when=W({"from": U("month", -1, name=11), "to": U("day", 0)}))]))

S("T05-024", "event create",
  T("book a haircut on saturday 3pm", diff(new("event", name=has("haircut"), date="2026-01-24T15:00")),
    ref=[act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=6, time="15:00")))]),
  T("make it 90 mins, she does the oil massage too", diff(upd("+1", duration=90)),
    ref=[act("edit", rows="$new", args=lines(duration=90))]))

S("T05-025", "event create overlap refusal",
  T("put call with harish on friday 8pm", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Call with Harish", date=U("week", 0, weekday=5, time="20:00")))),
         askc("you're on the ICU night shift from 7.30 friday. want it earlier, say 6pm, or another day?")]),
  T("6 then", diff(new("event", name=has("Harish"), date="2026-01-23T18:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Harish", date=U("week", 0, weekday=5, time="18:00")))]))
