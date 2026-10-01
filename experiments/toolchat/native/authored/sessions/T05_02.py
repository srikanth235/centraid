from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T05-026", "person where nickname empty cadence edit prev",
  T("who in the cricket gang has no nickname saved", rows("arjun", "divya_k", "me"),
    ref=[ans(kind="person", linked_to="$cricket_g", where="nickname is empty")]),
  T("which of them are on a fortnightly catch up", rows("arjun", "divya_k"),
    ref=[ans(within="@prev", where="cadence = 14")]),
  T("ok arjun, set him to weekly", diff(upd("arjun", cadence=7)),
    ref=[find(within="@prev", name="Arjun"), act("edit", rows="@prev", args=lines(cadence=7))]),
  T("and give him the nickname Appu", diff(upd("arjun", nickname="Appu")),
    ref=[act("edit", rows="$arjun", args=lines(nickname="Appu"))]),
  T("who's not on weekly", rows("divya_k", "vignesh", "sowmya", "revathi", "kavya", "ramesh_mama", "meena", "anand",
                                    "amma", "appa", "karthik"),
    ref=[ans(kind="person", where="cadence != 7 days")]))

S("T05-027", "people links counts",
  T("who's in no group at all", rows("amma", "paati", "ramesh_mama", "meena", "sowmya", "farhan", "rajan",
                                     "nirmala", "balu", "kavya", "nandini", "rao_doc", "dentist", "muthu", "selvi"),
    ref=[ans(kind="person", where="group count <= 0")]),
  T("of those, who has no tasks either", rows("ramesh_mama", "meena", "rajan",
                                               "balu", "nandini", "rao_doc", "dentist", "muthu"),
    ref=[ans(within="@prev", where="task count <= 0")]),
  T("and who of them do i have exactly one debt with", rows("ramesh_mama"),
    ref=[ans(within="@prev", where="debt count = 1")]))

S("T05-028", "groups person count balance compute",
  T("which groups aren't three people", rows("cricket_g", "carpool", "dubai_g", "farewell_g"),
    ref=[ans(kind="group", where="person count != 3")]),
  T("who's in the carpool one", rows("divya_s", "jaya", "ramesh_d", "me"),
    ref=[ans(kind="person", linked_to="$carpool")]),
  T("where do i stand in it", val((740, "INR")),
    ref=[comp(op="balance", kind="group", name="Night shift carpool", linked_to="$me"), ans(value="@prev")]))

S("T05-029", "event short no description",
  T("anything under an hour this week", rows("appraisal"),
    ref=[ans(kind="event", when=W(U("week", 0)), where="duration < 60")]),
  T("and next week", rows("dentist_ev", "duty_swap", "bank"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="duration < 60")]))

S("T05-030", "events no description edit prev",
  T("which of my events next week have no description", rows("dentist_ev", "duty_swap", "accounts", "electrician",
                                                              "bank", "nets", "cne", "farewell"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="description is empty")]),
  T("the electrician one, say he's fixing the geyser", diff(upd("electrician", description="fixing the geyser")),
    ref=[act("edit", rows="$electrician", args=lines(description="fixing the geyser"))]))

S("T05-031", "task where priority description",
  T("what's on the home list with a priority set", rows("eb_jan", "selvi_pay", "tax"),
    ref=[ans(kind="task", linked_to="$homelist", where='priority != 0 and status = "open"')]),
  T("which tasks are cash or at the bank", rows("gas", "fridge", "selvi_pay", "banner"),
    ref=[ans(kind="task", where='description in ("cash", "at the bank")')]),
  T("sum of effort on those", val(40),
    ref=[ans(op="sum", field="effort", within="@prev")]))

S("T05-032", "task list count where",
  T("which open tasks aren't on any list", rows("inverter", "passport", "dubai_visa", "kavya_gift", "phone", "recipe",
                                                "vol_call", "vol_print", "lic_02"),
    ref=[ans(kind="task", where='list count != 1 and status = "open"')]),
  T("put inverter and phone ones on home", diff(link("homelist", "inverter"), link("homelist", "phone")),
    ref=[act("add_to", rows="$inverter, $phone", args=lines(to="$homelist"))]))

S("T05-033", "notes pinned unpin",
  T("which notes have i pinned", rows("abg", "noradr", "poosam_plan", "goals"),
    ref=[ans(kind="note", where="pinned = yes")]),
  T("unpin the noradrenaline one, i know it by heart", diff(upd("noradr", pinned=False)),
    ref=[act("edit", rows="$noradr", args=lines(pinned="no"))]),
  T("pinned ones in ICU?", rows("abg"),
    ref=[ans(kind="note", linked_to="$icu_nb", where="pinned = yes")]))

S("T05-034", "documents no folder",
  T("which documents aren't filed in a folder", rows("aadhaar", "pan"),
    ref=[ans(kind="document", where="folder count != 1")]),
  T("put both in medical for", diff(link("med_f", "aadhaar"), link("med_f", "pan")),
    ref=[act("add_to", rows="@prev", args=lines(to="$med_f"))]),
  T("hmm no, undo", diff(unlink("med_f", "aadhaar"), unlink("med_f", "pan")),
    ref=[act("undo")]))

S("T05-035", "debt amount where",
  T("any open debts that aren't 500 rupees", rows("d_divya_k", "d_arjun", "d_karthik", "d_jaya", "d_ramesh_mama",
                                                  "d_appa", "d_vignesh", "d_revathi"),
    ref=[ans(kind="debt", where='status = "open" and amount != 500 INR')]),
  T("any with no amount written down", rows(),
    ref=[ans(kind="debt", where="amount is empty")]))

S("T05-036", "locker type not login username empty",
  T("locker items that aren't logins or cards", rows("wifi", "locker_combo", "aadhaar_id", "upi_pin", "pi_key", "maps_key",
                                                      "passport_item", "sbi_acct", "licence", "office", "wazirx",
                                                      "gym_card", "library", "pan_item"),
    ref=[ans(kind="locker item", where='type != "login" and type != "card"')]),
  T("which logins have no username", rows(),
    ref=[ans(kind="locker item", where='type = "login" and username is empty')]))

S("T05-037", "notebook note count folders doc count",
  T("which notebooks have more than two notes", rows("icu_nb", "journal_nb", "temple_nb", "recipes_nb"),
    ref=[ans(kind="notebook", where="note count > 2")]),
  T("need the folders where the doc count is 3 or above", rows("med_f", "work_f", "house_f"),
    ref=[ans(kind="folder", where="document count >= 3")]))

S("T05-038", "person dates last contacted",
  T("who did i talk to in december", rows("meena", "rajan", "kavya", "arjun"),
    ref=[ans(kind="person", when=W(U("month", -1, name=12)))]),
  T("and who've i not been in touch with since before diwali", rows("anand", "nandini"),
    ref=[ans(kind="person", when=W({"to": D("2025-11-08")}))]),
  T("log a call with anand", diff(upd("anand", date=ANY)),
    ref=[act("log", rows="$anand", args=lines(kind="call"))]))

S("T05-039", "person dates span",
  T("who've i caught up with since the fifteenth", rows("amma", "appa", "karthik", "paati", "divya_s", "sowmya",
                                                   "ramesh_d"),
    ref=[ans(kind="person", when=W({"from": D("2026-01-15"), "to": U("week", 0, weekday=7)}))]),
  T("and from december up to the tenth noon", rows("meena", "rajan", "kavya", "arjun", "farhan"),
    ref=[ans(kind="person", when=W({"from": U("month", -1, name=12), "to": D("2026-01-10", "12:00")}))]))

S("T05-040", "events span dates",
  T("what's on from saturday noon to next monday", rows("night_0124", "cric_0125", "movie", "dentist_ev", "duty_swap",
                                                        "accounts"),
    ref=[ans(kind="event", when=W({"from": U("week", 0, weekday=6, time="12:00"), "to": U("week", 1, weekday=1)}))]),
  T("and between now and thursday lunch", rows("day_0120", "day_0121", "cataract_1"),
    ref=[ans(kind="event", when=W({"from": U("day", 0), "to": U("week", 0, weekday=4, time="12:00")}))]))

S("T05-041", "tasks due dates",
  T("tasks due next week", rows("inverter", "cne_hours", "banner", "farhan_card", "vol_print", "selvi_pay"),
    ref=[ans(kind="task", when=W(U("week", 1)))]),
  T("push the banner one to tomorrow 6pm", diff(upd("banner", date="2026-01-21T18:00")),
    ref=[act("reschedule", rows="$banner", args=lines(to=U("day", 1, time="18:00")))]))

S("T05-042", "tasks span weekday",
  T("what's due between wednesday and sunday", rows("water_can", "projector", "reports", "gas", "vol_call", "kavya_gift",
                                                    "flowers_1", "leave", "volunteers", "receipts", "eb_jan"),
    ref=[ans(kind="task", when=W({"from": U("week", 0, weekday=3), "to": U("week", 0, weekday=7)}))]),
  T("and from next monday on, the priority 1s", rows("selvi_pay", "bls_cert", "insurance_claim"),
    ref=[ans(kind="task", when=W({"from": U("week", 1, weekday=1)}), where="priority = 1")]))

S("T05-043", "notes by created date",
  T("notes i made since the tenth", rows("poosam_plan", "donors", "tc_minutes", "vathal", "pongal_r", "fantasy_n",
                                        "match_bets", "night_journal", "pongal_journal", "sedation", "surgery_n"),
    ref=[ans(kind="note", when=W({"from": D("2026-01-10")}))]),
  T("only from tenth noon to the fifteenth", rows("poosam_plan", "fantasy_n", "donors", "vathal", "pongal_r", "match_bets", "night_journal",
                                            "pongal_journal"),
    ref=[ans(kind="note", when=W({"from": D("2026-01-10", "12:00"), "to": D("2026-01-15")}))]))

S("T05-044", "notes up to last month",
  T("how many notes did i write up to end of last month", val(7),
    ref=[ans(op="count", kind="note", when=W({"to": U("month", -1)}))]),
  T("and up to last sunday", val(20),
    ref=[ans(op="count", kind="note", when=W({"to": U("week", -1, weekday=7)}))]))

S("T05-045", "documents created recently",
  T("docs added since last month", rows("payslip_dec", "roster_doc", "my_blood", "eb_receipt", "donor_sheet",
                                        "volunteer_doc", "amma_scan"),
    ref=[ans(kind="document", when=W({"from": U("month", -1)}))]),
  T("up to this monday only", rows("payslip_dec", "roster_doc", "my_blood", "eb_receipt", "donor_sheet",
                                   "volunteer_doc", "amma_scan"),
    ref=[ans(kind="document", when=W({"from": U("month", -1), "to": U("week", 0, weekday=1)}))]))

S("T05-046", "photos dates",
  T("photos from the last week", rows("sugarcane", "pot", "family_pongal", "big_temple", "kolam_pic", "cows",
                                      "blurry_kolam", "farhan_pic", "receipt_pic", "meme_2"),
    ref=[ans(kind="photo", when=W(U("week", -1, anchor="today")))]),
  T("pongal day to the fifteenth morning", rows("kolam_pic", "blurry_kolam", "pot", "sugarcane", "family_pongal", "cows"),
    ref=[ans(kind="photo", when=W({"from": D("2026-01-14"), "to": D("2026-01-15", "12:00")}))]))

S("T05-047", "photos from month",
  T("pics since november", rows("biryani", "final_score", "amma_appa", "lamp", "rain", "gopuram", "beach",
                                "icu_xmas", "kavya_pic", "filter_coffee", "whiteboard", "dubai_ad", "meme_1", "night_team",
                                "committee_pic", "screen", "gang_selfie", "suri_dance", "meme_2", "kolam_pic",
                                "blurry_kolam", "pot", "sugarcane", "family_pongal", "cows", "big_temple",
                                "farhan_pic", "receipt_pic"),
    ref=[ans(kind="photo", when=W({"from": U("month", -1, name=11)}))]),
  T("december through new year's day", rows("kavya_pic", "lamp", "rain", "gopuram", "beach", "icu_xmas"),
    ref=[ans(kind="photo", when=W({"from": U("month", -1, name=12), "to": D("2026-01-01", "23:59")}))]))

S("T05-048", "debts dated span",
  T("debts from this month up to the twelfth evening", rows("d_divya_k", "d_suresh", "d_karthik", "d_jaya",
                                                         "d_ramesh_mama", "d_sowmya"),
    ref=[ans(kind="debt", when=W({"from": U("month", 0), "to": D("2026-01-12", "20:00")}))]))

S("T05-049", "undo after field reschedule",
  T("move the dentist to 11", diff(upd("dentist_ev", date="2026-01-26T11:00")),
    ref=[act("reschedule", kind="event", name="Dentist appointment", args=lines(to=U("day", 0, anchor="row", time="11:00")))]),
  T("no wait, undo that", diff(upd("dentist_ev", date="2026-01-26T10:00")),
    ref=[act("undo")]))

S("T05-050", "task rel+time create",
  T("remind me to call ramesh anna tomorrow 5pm about the carpool", diff(new("task", name=has("Ramesh"), date="2026-01-21T17:00")),
    ref=[act("create", args=lines(kind="task", name="Call Ramesh anna about the carpool", date=U("day", 1, time="17:00")))]),
  T("what's due tomorrow then", rows("water_can", "projector", "reports", "+1"),
    ref=[ans(kind="task", when=W(U("day", 1)))]))
