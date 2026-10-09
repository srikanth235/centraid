from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T19-026", "repair refused weeks cadence people spans",
  T("who am i only meant to check on less often than every two weeks", rows("simo", "mouhcine"),
    ref=[bad(ans(kind="person", where="cadence > 2 weeks")),
         ans(kind="person", where="cadence > 14")]),
  T("and the ones i should see at least once a week", rows("youssef_a", "baba", "dada", "nadia", "rachid", "omar",
                                                            "zineb", "samira_b", "driss", "aicha"),
    ref=[ans(kind="person", where="cadence < 8 days")]),
  T("which of those haven't i talked to since last week", rows("omar", "zineb", "driss", "aicha"),
    ref=[ans(kind="person", within="@prev", when=W({"to": U("week", -1)}))]))

S("T19-027", "repair refused weeks cadence under",
  T("who has a cadence under three days", rows("youssef_a", "baba", "dada"),
    ref=[ans(kind="person", where="cadence < 3 days")]),
  T("and the ones between 1 and two weeks", rows("rachid", "omar", "zineb", "samira_b", "driss", "aicha", "salma",
                                                "kenza", "youssef_b"),
    ref=[bad(ans(kind="person", where="cadence >= 1 week and cadence <= 2 weeks")),
         ans(kind="person", where="cadence >= 7 and cadence <= 14")]))

S("T19-028", "nickname is set nickname != search nickname",
  T("who has a nickname in my contacts", rows("lina", "baba", "zineb", "simo", "dada"),
    ref=[ans(kind="person", where="nickname is set")]),
  T("apart from baba", rows("lina", "zineb", "simo", "dada"),
    ref=[ans(kind="person", where='nickname is set and nickname != "Baba"')]),
  T("what's hajja's actual name", rows("zineb"),
    ref=[find(kind="person", name="Hajja"), search("hajja", kind="person"), ans(rows="$zineb")]))

S("T19-029", "nickname != edit person prev",
  T("list everyone with a nickname except Dada", rows("lina", "baba", "zineb", "simo"),
    ref=[ans(kind="person", where='nickname is set and nickname != "Dada"')]),
  T("lina goes by Loulou now, not lilou", diff(upd("lina", nickname="Loulou")),
    ref=[act("edit", rows="$lina", args=lines(nickname="Loulou"))]))

S("T19-030", "group count person count groups",
  T("which of my contacts are in a group at all", rows("simo", "driss", "kenza", "samira_a", "omar", "salma", "rachid",
                                                       "samira_b", "nadia", "youssef_a", "me", "imane"),
    ref=[ans(kind="person", where="group count != 0")]),
  T("which groups don't have exactly three people", rows("ifrane", "madrid", "coffee", "school_run"),
    ref=[find(kind="group", where="person count != 3"), ans(rows="@prev")]),
  T("how many are in the coffee fund", val(5),
    ref=[ans(op="count", kind="person", linked_to="$coffee")]))

S("T19-031", "group count role contains group person count",
  T("anyone from the pharmacy side in a group", rows("nadia", "kenza", "rachid"),
    ref=[ans(kind="person", where='group count != 0 and role contains "pharmac"')]),
  T("which groups have more than me and one other", rows("coffee", "baba_care", "school_run", "ifrane", "eid_sheep"),
    ref=[ans(kind="group", where="person count != 2")]),
  T("and who's in no group but i see weekly", rows("baba", "dada", "zineb", "aicha"),
    ref=[ans(kind="person", where="group count = 0 and cadence < 8 days")]))

S("T19-032", "four turns task count photo count linked",
  T("who's got more than two tasks tied to them", rows("baba", "adam"),
    ref=[ans(kind="person", where="task count > 2")]),
  T("what's on adam", rows("homework", "fees", "goggles"),
    ref=[ans(kind="task", linked_to="$adam")]),
  T("who shows up in three or more photos", rows("adam", "lina", "baba", "youssef_a", "salma"),
    ref=[ans(kind="person", where="photo count >= 3")]),
  T("pics of baba", rows("eid_table", "eid_baba", "baba_walk", "meter"),
    ref=[ans(kind="photo", linked_to="$baba")]))

S("T19-033", "task person count description is set within",
  T("tasks that involve more than one person", rows("reimburse", "rota", "rota_mail", "sheep"),
    ref=[find(kind="task", where="person count > 1"), ans(rows="@prev")]),
  T("which of those have a description", rows("reimburse"),
    ref=[ans(kind="task", within="@prev", where="description is set")]))

S("T19-034", "effort is set effort unit reschedule",
  T("on baba's list, which ones have a time estimate", rows("insulin", "strips", "shoes", "reimburse"),
    ref=[ans(kind="task", linked_to="$baba_l", where="effort is set")]),
  T("anything that takes exactly half an hour", rows("invoices", "invites", "lina_forms"),
    ref=[ans(kind="task", where="effort = 30 minutes")]),
  T("i'll do fill lina's kindergarten forms tonight, move it to today", diff(upd("lina_forms", date="2026-04-14")),
    ref=[act("reschedule", kind="task", name="Fill Lina's kindergarten forms", args=lines(to=U("day", 0)))]))

S("T19-035", "effort unit description is set",
  T("any fifteen minute jobs i can knock out tonight", rows("photocopy", "goggles", "rota_mail"),
    ref=[ans(kind="task", where='effort = 15 minutes and status = "open"')]),
  T("what about the in progress ones that have a description", rows("glucose_log_t", "fridge_log", "party_plan"),
    ref=[ans(kind="task", where='description is set and status = "in_progress"')]))

S("T19-036", "event duration description in reschedule",
  T("anything short tomorrow, under half an hour", rows("lina_vacc"),
    ref=[find(kind="event", when=W(U("day", 1)), where="duration < 30"), ans(rows="@prev")]),
  T("what's coming up at clinique badr or labo anfa", rows("endo_may", "hba1c", "eye_exam"),
    ref=[ans(kind="event", where='description in ("Clinique Badr", "Labo Anfa")', when=W({"from": U("day", 0)}))]),
  T("move baba's eye exam to 4pm same day", diff(upd("eye_exam", date="2026-04-28T16:00")),
    ref=[act("reschedule", rows="$eye_exam", args=lines(to=D("2026-04-28", "16:00")))]))

S("T19-037", "event description in month duration within",
  T("what have i got at dr kettani's clinic or piscine anfa this month",
    rows("lina_vacc", "adam_checkup", "swim_0401", "swim_0408", "swim_0415", "swim_0422", "swim_0429"),
    ref=[ans(kind="event", where='description in ("Dr Kettani\'s clinic", "Piscine Anfa")', when=W(U("month", 0)))]),
  T("which of those are shorter than 45 min", rows("lina_vacc", "adam_checkup"),
    ref=[ans(kind="event", within="@prev", where="duration < 45")]))

S("T19-038", "event date span next week ambiguous reschedule",
  T("what did i have between the tenth and twelfth of april", rows("anniversary", "hammam"),
    ref=[ans(kind="event", when=W(span(D("2026-04-10"), D("2026-04-12"))))]),
  T("and next week?", rows("accountant", "nurse_1", "run_0421", "hba1c", "adam_checkup", "swim_0422", "run_0423",
                           "council", "dentist_adam", "omar_visit", "lina_party"),
    ref=[ans(kind="event", when=W(U("week", 1)))]),
  T("push nurse visit for baba on the twentieth to 7pm", diff(upd("nurse_1", date="2026-04-20T19:00")),
    ref=[act("reschedule", kind="event", name="Nurse visit for Baba", args=lines(to=D("2026-04-20", "19:00"))),
         act("reschedule", rows="$nurse_1", args=lines(to=D("2026-04-20", "19:00")))]))

S("T19-039", "event date span description cancel",
  T("anything at the pharmacy between first may and tenth may", rows("garde_0502", "staff_05"),
    ref=[ans(kind="event", where='description = "pharmacy"', when=W(span(D("2026-05-01"), D("2026-05-10"))))]),
  T("cancel the pharmacy staff meeting, we'll do it on whatsapp", diff(upd("staff_05", status="cancelled")),
    ref=[act("cancel", rows="$staff_05")]))

S("T19-040", "event open span weekday count",
  T("night duty shifts from this saturday on", rows("garde_0418", "garde_0502", "garde_0516", "garde_0530"),
    ref=[ans(kind="event", name="Night duty", when=W({"from": U("week", 0, weekday=6)}))]),
  T("how many is that", val(4),
    ref=[ans(op="count", rows="@prev")]))

S("T19-041", "event open span named month span linked",
  T("baba's appointments since last monday", rows("podiatrist", "nurse_1", "hba1c", "omar_visit", "nurse_2", "eye_exam",
                                                  "endo_may", "eid_adha"),
    ref=[find(kind="person", name="Baba"), search("baba", kind="person"),
         ans(kind="event", linked_to="$baba", when=W({"from": U("week", -1, weekday=1)}))]),
  T("and from march up to last sunday", rows("endo_mar", "eid_fitr"),
    ref=[ans(kind="event", linked_to="$baba", when=W(span(U("month", 0, name=3), U("week", -1, weekday=7))))]),
  T("who came to the eid lunch", rows("baba", "omar", "salma", "simo"),
    ref=[ans(kind="person", linked_to="$eid_fitr")]))

S("T19-042", "event named month span weekday within",
  T("my school runs from april up to this friday", rows("run_0402", "run_0407", "run_0409", "run_0414", "run_0416"),
    ref=[ans(kind="event", name="School run", when=W(span(U("month", 0, name=4), U("week", 0, weekday=5))))]),
  T("which one got cancelled", rows("run_0402"),
    ref=[ans(kind="event", within="@prev", where='status = "cancelled"')]))

S("T19-043", "task spans date time named month priority",
  T("pharmacy tasks due between wed 9am and fri 6pm", rows("cnss_claims", "order_0416", "count_sheets"),
    ref=[ans(kind="task", linked_to="$pharm_l", when=W(span(U("week", 0, weekday=3, time="09:00"), U("week", 0, weekday=5, time="18:00"))))]),
  T("and from wed 9am to the end of april", rows("cnss_claims", "order_0416", "count_sheets", "expiry", "invoices",
                                                 "scooter", "rota"),
    ref=[ans(kind="task", linked_to="$pharm_l", when=W(span(U("week", 0, weekday=3, time="09:00"), U("month", 0, name=4))))]),
  T("which of those are priority one", rows("cnss_claims"),
    ref=[ans(kind="task", within="@prev", where="priority = 1")]),
  T("is the quarterly stock count on my task list too", rows("stock_count"),
    ref=[find(kind="task", name="quarterly stock count"), ans(rows="$stock_count")]))

S("T19-044", "task spans date time",
  T("kids list stuff due from friday noon to the twenty-fourth 9pm", rows("fees", "rota_mail"),
    ref=[ans(kind="task", linked_to="$kids_l", when=W(span(U("week", 0, weekday=5, time="12:00"), D("2026-04-24", "21:00"))))]),
  T("anything on baba's list from monday 8am through may", rows("reimburse", "shoes"),
    ref=[ans(kind="task", linked_to="$baba_l", when=W(span(U("week", 1, weekday=1, time="08:00"), U("month", 0, name=5))))]))

S("T19-045", "notes date yesterday pin",
  T("what notes did i write on tenth march", rows("meds", "fassi_advice"),
    ref=[find(kind="note", when=W(D("2026-03-10"))), ans(rows="@prev")]),
  T("anything from yesterday", rows("generics"),
    ref=[ans(kind="note", when=W(U("day", -1)))]),
  T("pin generics to push", diff(upd("generics", pinned=True)),
    ref=[act("edit", rows="$generics", args=lines(pinned="yes"))]))

S("T19-046", "notes last week date",
  T("notes from last week", rows("staff_apr", "ifrane_plan", "prices", "teacher_notes", "gift_ideas", "low_sugar"),
    ref=[ans(kind="note", when=W(U("week", -1)))]),
  T("the one from april ninth, what does it say", rows("teacher_notes"),
    ref=[ans(kind="note", when=W(D("2026-04-09")))]))

S("T19-047", "notes spans weekday date time",
  T("notes made last monday onward, cutting off at noon saturday", rows("staff_apr", "ifrane_plan", "prices", "teacher_notes"),
    ref=[ans(kind="note", when=W(span(U("week", -1, weekday=1), U("week", -1, weekday=6, time="12:00"))))]),
  T("and from last saturday through today", rows("gift_ideas", "low_sugar", "generics", "fridge_note"),
    ref=[ans(kind="note", when=W(span(U("week", -1, weekday=6), U("day", 0))))]))

S("T19-048", "notes spans notebook weekday",
  T("pharmacy notebook notes from last monday till today", rows("staff_apr", "prices", "generics", "fridge_note"),
    ref=[ans(kind="note", linked_to="$nb_pharm", when=W(span(U("week", -1, weekday=1), U("day", 0))))]),
  T("all notes from sunday up to thursday 7pm",
    rows("lina_words", "staff_apr", "ifrane_plan", "prices", "teacher_notes"),
    ref=[ans(kind="note", when=W(span(U("week", -2, weekday=7), U("week", -1, weekday=4, time="19:00"))))]))

S("T19-049", "note notebook count person count linked",
  T("notes that have a pin and live inside a notebook", rows("readings", "meds", "garde_check"),
    ref=[ans(kind="note", where="notebook count != 0 and pinned = yes")]),
  T("notes with two or more people on them", rows("meds", "fassi_advice", "staff_apr", "rota_note", "teacher_notes",
                                                "gift_ideas", "ifrane_plan"),
    ref=[ans(kind="note", where="person count >= 2")]),
  T("who's on the ifrane plan", rows("omar", "simo"),
    ref=[ans(kind="person", linked_to="$ifrane_plan")]))

S("T19-050", "note notebook count person count read",
  T("notebook notes that have at least three people tagged", rows("staff_apr", "rota_note"),
    ref=[ans(kind="note", where="notebook count != 0 and person count >= 3")]),
  T("what does the school run rota say", rows("rota_note"),
    ref=[ans(kind="note", name="School run rota")]))
