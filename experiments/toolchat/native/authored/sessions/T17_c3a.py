from gold import *

world("T17", "2026-01-30T13:35", "Elena Petrova", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T17-A002", "ask-options event reschedule c3a",
  T("can stefan pick viktor up on saturday instead", ask("handover_0201", "handover_0208"),
    ref=[act("reschedule", kind="event", name="Stefan picks up Viktor", args=lines(to=U("week", 0, weekday=6))),
         find(kind="event", name="Stefan picks up Viktor", when=J({"from": U("day", 0)})),
         askc("This Sunday the 1st or next Sunday the 8th?", options="$handover_0201, $handover_0208")]),
  T("the first one, he's busy the week after", diff(upd("handover_0201", date="2026-01-31T18:00")),
    ref=[act("reschedule", rows="$handover_0201", args=lines(to=U("week", 0, weekday=6)))]))

S("T17-A003", "ask-options task complete c3a",
  T("tick off choosing the piece", ask("piece_kalina", "piece_boris"),
    ref=[act("complete", kind="task", name="piece"),
         askc("Choose a piece for Kalina or Choose a piece for Boris?", options="$piece_kalina, $piece_boris")]),
  T("kalina's, we settled on the clementi", diff(upd("piece_kalina", status="completed", completed=ANY)),
    ref=[act("complete", rows="$piece_kalina")]),
  T("and the prepare one's done, tick it off", diff(upd("programme", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="prepare")]))

S("T17-A005", "ask-options debt settle_debt c3a",
  T("settle the lessons one", ask("d_maria_k", "d_kalina", "d_daniela"),
    ref=[act("settle_debt", kind="debt", name="lessons"),
         askc("Maria's January lessons (100), Kalina's two January lessons (80) or Daniela's for Boris's December lessons (160)?", options="$d_maria_k, $d_kalina, $d_daniela")]),
  T("daniela's, she brought cash", diff(upd("d_daniela", status="settled")),
    ref=[act("settle_debt", rows="$d_daniela")]))

S("T17-A006", "ask-options note delete never_mind c3a",
  T("delete the progress note", ask("maria_notes", "ivan_notes"),
    ref=[act("delete", kind="note", name="progress"),
         askc("Maria D. progress or Ivan progress?", options="$maria_notes, $ivan_notes")]),
  T("hmm no, i still need both for the reports", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star nikola", diff(upd("niki", starred=True)),
    ref=[act("star", kind="person", name="Nikola")]))

S("T17-A101", "ask-options event reschedule c3a",
  T("move the concert to friday", ask("school_concert", "concert_mar"),
    ref=[act("reschedule", kind="event", name="concert", args=lines(to=U("week", 0, weekday=5))),
         askc("Viktor's school concert on 11 Feb or the choir concert on 14 March?", options="$school_concert, $concert_mar")]))

S("T17-A007", "follow-up c3a",
  T("what's open on the teaching list", rows("piece_boris", "programme", "roster", "piece_kalina", "sheet_1", "niki_letter", "theory", "invoice_feb", "certificates"),
    ref=[ans(kind="task", linked_to="$teaching_l", where="status = open")]),
  T("i only care about what's due next week out of those", rows("piece_kalina", "piece_boris", "sheet_1"),
    ref=[ans(within="@prev", when=J(U("week", 1)))]),
  T("what about the others", rows("certificates", "programme", "roster", "invoice_feb", "niki_letter", "theory"),
    ref=[ans(within="@1", exclude="@2")]))

S("T17-A008", "follow-up c3a",
  T("what's on this week", rows("tiling_start", "maria_0128", "niki_lesson", "vesi_reh_jan", "ivan_0126", "choir_0127", "coffee_mila", "handover_0201", "sofia_run", "lunch_petar"),
    ref=[ans(kind="event", when=J(U("week", 0)))]),
  T("now only the lessons", rows("maria_0128", "niki_lesson", "ivan_0126"),
    ref=[ans(within="@prev", name="lesson")]),
  T("what else is on", rows("tiling_start", "vesi_reh_jan", "choir_0127", "coffee_mila", "handover_0201", "sofia_run", "lunch_petar"),
    ref=[ans(within="@1", exclude="@2")]))

S("T17-A009", "follow-up c3a",
  T("who still owes me money", rows("d_kalina", "d_daniela", "d_stefan", "d_maria_k", "d_niki", "d_sofia"),
    ref=[ans(kind="debt", where="direction = owes_me and status = open")]),
  T("which of those are over 90", rows("d_niki", "d_daniela", "d_maria_k"),
    ref=[ans(within="@prev", where="amount > 90 BGN")]),
  T("the rest of them", rows("d_sofia", "d_stefan", "d_kalina"),
    ref=[ans(within="@1", exclude="@2")]))

S("T17-A010", "follow-up c3a",
  T("what's in the choir album", rows("choir_warmup", "plovdiv_old", "choir_xmas", "r25_group", "choir_altos"),
    ref=[ans(kind="photo", linked_to="$choir_album")]),
  T("are some of them starred", rows("choir_xmas", "r25_group"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar both of them", diff(upd("choir_xmas", starred=False), upd("r25_group", starred=False)),
    ref=[act("unstar", rows="@prev")]))
