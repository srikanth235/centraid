from gold import *

world("T28", "2026-02-21T12:00", "Wiremu Tane", "train")

# 201 both / all of them
S("T28-201", "p4 both prev task reschedule event weekday at-row",
  T("anything due tomorrow", rows("mara", "ring_rawiri"),
    ref=[ans(kind="task", when=U("day", 1))]),
  T("both to monday", diff(upd("mara", date="2026-02-23"), upd("ring_rawiri", date="2026-02-23")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=1)))]),
  T("which marae committee meetings are still to come", rows("marae_0301", "marae_0405"),
    ref=[ans(kind="event", name="Marae committee meeting", when={"from": U("day", 0)})]),
  T("hemi says make both 3", diff(upd("marae_0301", date="2026-03-01T15:00"), upd("marae_0405", date="2026-04-05T15:00")),
    ref=[act("reschedule", rows="@prev", args=lines(to=U("day", 0, anchor="row", time="15:00")))]))

# 202 ordinal / positional
S("T28-202", "p4 ordinal event cancel reschedule kapa relist",
  T("kapa haka practice coming up", rows("kapa_0225", "kapa_0304", "kapa_0311", "kapa_0318", "kapa_0325"),
    ref=[ans(kind="event", name="Kapa haka practice", when={"from": U("day", 0)}, order="date asc")]),
  T("cancel the second one, whaea hine is away", diff(upd("kapa_0304", status="cancelled")),
    ref=[act("cancel", rows="$kapa_0304")]),
  T("what's left", rows("kapa_0225", "kapa_0311", "kapa_0318", "kapa_0325"),
    ref=[ans(kind="event", name="Kapa haka practice", when={"from": U("day", 0)}, where='status != "cancelled"', order="date asc")]),
  T("third one to 7", diff(upd("kapa_0318", date="2026-03-18T19:00")),
    ref=[act("reschedule", rows="$kapa_0318", args=lines(to=D("2026-03-18", "19:00")))]))

# 203 owe direction
S("T28-203", "p4 owe direction balance debt settle_debt both signs",
  T("where am i with ria", val((25, "NZD")),
    ref=[ans(op="balance", kind="person", name="Ria Tane")]),
  T("and ngaire", val((-220, "NZD")),
    ref=[ans(op="balance", kind="person", name="Ngaire Tomoana")]),
  T("paid ngaire her deposit, settle mine", diff(upd("d_ngaire", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$ngaire", where='direction = "i_owe" and status = "open"')]),
  T("rawiri sent the deposit back, settle his", diff(upd("d_rawiri", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$rawiri", where='direction = "owes_me" and status = "open"')]))

# 204 except / besides
S("T28-204", "p4 except exclude subtask complete person log visit",
  T("what's under the reunion invites task", rows("inv_aus", "inv_fb", "inv_kaum"),
    ref=[ans(kind="task", linked_to="$invites")]),
  T("tick off all of them except ringing the kaumātua", diff(upd("inv_aus", status="completed", completed=ANY), upd("inv_fb", status="completed", completed=ANY)),
    ref=[find(kind="task", within="@prev", exclude="$inv_kaum"), act("complete", rows="@prev")]),
  T("who are the mokopuna", rows("manaia", "tama", "ana", "aroha_w", "nikau"),
    ref=[ans(kind="person", where='role contains "mokopuna"')]),
  T("log a visit with all of them but nikau, he was sick", diff(upd("manaia", date=ANY), upd("tama", date=ANY), upd("ana", date=ANY), upd("aroha_w", date=ANY)),
    ref=[find(kind="person", within="@prev", exclude="$nikau"), act("log", rows="@prev", args=lines(kind="visit"))]))

# 205 bare weekdays and at N
S("T28-205", "p4 weekday at-N reschedule create range event",
  T("move the wof to monday at 8", diff(upd("wof", date="2026-02-23T08:00")),
    ref=[act("reschedule", kind="event", name="Car WOF at Tony's", args=lines(to=U("week", 1, weekday=1, time="08:00")))]),
  T("aroha's birthday dinner to friday at 7", diff(upd("aroha_bday", date="2026-02-27T19:00")),
    ref=[act("reschedule", kind="event", name="Aroha's birthday dinner", args=lines(to=U("week", 1, weekday=5, time="19:00")))]),
  T("what did i have monday to wednesday this week", rows("touch_0216", "school_mtg", "bowls", "kapa_0218"),
    ref=[ans(kind="event", when=span(U("week", 0, weekday=1), U("week", 0, weekday=3)))]),
  T("put a call with ria in the diary sunday at 5", diff(new("event", name=has("ria"), date="2026-02-22T17:00")),
    ref=[act("create", args=lines(kind="event", name="Call with Ria", date=U("week", 0, weekday=7, time="17:00")))]))

# 206 two writes in one message
S("T28-206", "p4 two writes settle_debt complete direction debt read",
  T("kevin paid me the petrol money and i updated the koha book", diff(upd("d_kevin", status="settled"), upd("koha_book", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", linked_to="$kevin", where='direction = "owes_me" and status = "open"', more=True),
         act("complete", kind="task", name="Update the koha book")]),
  T("gave pita the tangi petrol money and rang the kaumātua", diff(upd("d_pita", status="settled"), upd("inv_kaum", status="completed", completed=ANY)),
    ref=[act("settle_debt", kind="debt", linked_to="$pita", where='direction = "i_owe" and status = "open"', more=True),
         act("complete", kind="task", name="kaumātua")]),
  T("what's left on my side", rows("d_trev", "d_hemi", "d_ngaire", "d_ria", "d_sam"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status = "open"')]))
