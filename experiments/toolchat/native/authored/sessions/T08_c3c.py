from gold import *
import json

world("T08", "2026-04-06T17:50", "Deshawn Carter", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T08-C001", "c3c compound add_to unstar referential document",
  T("file the custody agreement in the house folder and unstar it, too visible",
    diff(link("house_f", "custody_doc"), upd("custody_doc", starred=False)),
    ref=[act("add_to", kind="document", name="Custody agreement", args=lines(to="$house_f"), more=True),
         act("unstar", rows="$custody_doc")]))

S("T08-C003", "c3c compound cancel create event at N",
  T("cancel the haircut saturday and put one in friday at 2",
    diff(upd("haircut", status="cancelled"), new("event", name=has("haircut"), date="2026-04-10T14:00")),
    ref=[act("cancel", kind="event", name="Haircut", more=True),
         act("create", args=lines(kind="event", name="Haircut", date=U("week", 0, weekday=5, time="14:00")))]))

S("T08-C004", "c3c compound delete restore photos",
  T("delete the gutter photo and bring the poster board receipt back",
    diff(trash("p_gutter"), restore("p_receipt")),
    ref=[act("delete", kind="photo", name="Gutter full of leaves", more=True),
         act("restore", kind="photo", name="Receipt for poster board", trashed=True)]))

S("T08-C101", "c3c bulk delete per kind before year where starred keep",
  T('clear out everything before 2025, except the starred ones', diff(trash("title"), trash("union_contract"), trash("p_r24_group"), unlink("reunion24_album", "p_r24_group"), trash("p_r24_spades"), unlink("reunion24_album", "p_r24_spades"), trash("p_r24_grill"), unlink("reunion24_album", "p_r24_grill"), trash("p_r24_kids"), unlink("reunion24_album", "p_r24_kids"), trash("p_r24_shirts"), unlink("reunion24_album", "p_r24_shirts")),
    ref=[find(kind="document", when=W({"to": D("2024-12-31")}), where="starred = no"),
         act("delete", rows="@prev", more=True),
         find(kind="photo", when=W({"to": D("2024-12-31")}), where="starred = no"),
         act("delete", rows="@prev")]))

S("T08-C901", "c3c cell7 empty recovery no_link",
  T("what's on for the boosters", rows("boost_0413", "car_wash", "boost_0511"),
    ref=[find(kind="event", linked_to="$boosters"), ans(kind="event", name="boosters", when=W({"from": U("day", 0)}))]))

S("T08-C902", "c3c cell7 rejected edit date event",
  T('put the tax appointment on thursday at 2', diff(upd("tax_appt", date="2026-04-09T14:00")),
    ref=[bad(act("edit", kind="event", name="Tax appointment", args=lines(date="thursday 2pm"))), act("reschedule", kind="event", name="Tax appointment", args=lines(to=U("week", 0, weekday=4, time="14:00")))]))
