from gold import *
import json

world("T36", "2026-12-09T21:15", "Dev Mehra", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T36-K001", "decline not_found document find miss i3skill S5",
  T("where's the venue contract", decline("not_found"),
    ref=[find(kind="document", name="venue contract"), dec("not_found")]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T36-K101", "family word dad mother-in-law role i3skill S6",
  T("when did i last call dad", rows("papa"),
    ref=[ans(kind="person", where='role = "dad"')]),
  T("and my mother-in-law", rows("aai"),
    ref=[ans(kind="person", where='role = "mother-in-law"')]))

S("T36-K102", "list word is a note name not the list kind i3skill S6",
  T("open the guest list split note", rows("w_guests"),
    ref=[ans(kind="note", name="Guest list split")]),
  T("and the who paid what one", rows("w_settle"),
    ref=[ans(kind="note", name="Who paid what")]))

S("T36-K103", "iou debt either direction i3skill S6",
  T("any ious with sneha", rows("d_sneha"),
    ref=[ans(kind="debt", linked_to="$sneha")]),
  T("and kunal", rows("d_kunal"),
    ref=[ans(kind="debt", linked_to="$kunal")]))

# --- S7 look then pick --------------------------------------------------------------------------

S("T36-K201", "pick later dinner reschedule i3skill S7",
  T("when's dinner at mummy's", rows("dinner_mummy_old", "dinner_mummy"),
    ref=[ans(kind="event", name="Dinner at Mummy's")]),
  T("move the later one to 7", diff(upd("dinner_mummy", date="2026-12-26T19:00")),
    ref=[act("reschedule", rows="$dinner_mummy", args=lines(to=D("2026-12-26", "19:00")))]))

S("T36-K202", "ask then the cousin one log i3skill S7",
  T("log a call with rohan", ask("rohan_m", "rohan_k"),
    ref=[act("log", kind="person", name="Rohan", args=lines(kind="call"))]),
  T("the cousin", diff(upd("rohan_m", date=ANY)),
    ref=[act("log", rows="$rohan_m", args=lines(kind="call"))]))

S("T36-K203", "ask then anjali's cousin star i3skill S7",
  T("star priya", ask("priya_d", "priya_s"),
    ref=[act("star", kind="person", name="Priya")]),
  T("anjali's cousin", diff(upd("priya_s", starred=True)),
    ref=[act("star", rows="$priya_s")]))

S("T36-K204", "other two subtasks reschedule i3skill S7",
  T("what's left under anjali's name change", rows("nc_aadhaar", "nc_pan", "nc_bank", "nc_passport"),
    ref=[ans(kind="task", linked_to="$name_change")]),
  T("did aadhaar and pan today", diff(upd("nc_aadhaar", status="completed", completed=ANY), upd("nc_pan", status="completed", completed=ANY)),
    ref=[act("complete", rows="$nc_aadhaar, $nc_pan")]),
  T("push the other two to the 15th of january", diff(upd("nc_bank", date="2027-01-15"), upd("nc_passport", date="2027-01-15")),
    ref=[find(within="@1", exclude="$nc_aadhaar, $nc_pan"), act("reschedule", rows="@prev", args=lines(to=D("2027-01-15")))]))

S("T36-K205", "pick by description debt settle i3skill S7",
  T("which debts are over 25000", rows("d_vikram", "d_baba", "d_rohan_m"),
    ref=[ans(kind="debt", where="amount > 25000 INR")]),
  T("settle the caterer one", diff(upd("d_vikram", status="settled")),
    ref=[act("settle_debt", rows="$d_vikram")]))
