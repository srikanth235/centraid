from gold import *
import json

world("T06", "2026-02-07T23:15", "Lukas Brandt", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T06-C001", "c3c compound delete restore note separate targets",
  T("delete the heating problems note and bring back my draft mail to kuhn",
    diff(trash("heating"), restore("draft_mail")),
    ref=[act("delete", kind="note", name="Heating problems", more=True),
         act("restore", kind="note", name="Draft mail to Kuhn", trashed=True)]))

S("T06-C002", "c3c compound star unstar people",
  T("star kalle and take the star off mira, she's moving out anyway",
    diff(upd("kalle", starred=True), upd("mira", starred=False)),
    ref=[search("kalle", kind="person"), act("star", rows="@prev", more=True),
         act("unstar", kind="person", name="Mira")]))

S("T06-C003", "c3c compound edit reschedule same target",
  T("rename the cleaning rota task to House rota and move it to monday",
    diff(upd("cleaning_rota", name="House rota", date="2026-02-09")),
    ref=[act("edit", kind="task", name="cleaning rota", args=lines(name="House rota"), more=True),
         act("reschedule", rows="$cleaning_rota", args=lines(to=U("week", 1, weekday=1)))]))

S("T06-C004", "c3c compound add_to two docs then star one",
  T("file the PA rental offer and the van contract in contracts, and star the van one",
    diff(link("contracts_f", "rental_offer"), link("contracts_f", "van_contract"), upd("van_contract", starred=True)),
    ref=[act("add_to", kind="document", name="PA rental offer", args=lines(to="$contracts_f"), more=True),
         act("add_to", kind="document", name="Van rental contract", args=lines(to="$contracts_f"), more=True),
         act("star", rows="$van_contract")]))

S("T06-C101", "c3c bulk delete per kind last year then second kind",
  T('delete all my tasks from last year', diff(trash("kitty_09"), trash("kitty_10"), trash("kitty_11"), trash("kitty_12"), trash("rent_11"), trash("rent_12")),
    ref=[find(kind="task", when=W(U("year", -1))),
         act("delete", rows="@prev")]),
  T('and the notes from before this year too', diff(trash("tonkeller_room"), trash("band_money"), trash("wifi_note"), trash("soljanka"), trash("tour_2023")),
    ref=[find(kind="note", when=W({"to": U("year", -1)})),
         act("delete", rows="@prev")]))

S("T06-C901", "c3c cell7 empty recovery nickname search then span",
  T('what does kalle do in the band', rows("kalle"),
    ref=[find(kind="person", name="Kalle"), search("kalle", kind="person"), ans(rows="$kalle")]),
  T("what's on from the 9th at 2pm to the 13th", rows("gig_tonkeller", "reh_0210", "theatre_tech", "premiere", "podcast", "sc_0213"),
    ref=[ans(kind="event", when=W(span(D("2026-02-09", "14:00"), D("2026-02-13"))))]))

S("T06-C902", "c3c cell7 rejected effort unit",
  T('add a task to coil the stage snake cables, an hour, due wednesday', diff(new("task", name="Coil the stage snake cables", date="2026-02-11", effort=60)),
    ref=[bad(act("create", args=lines(kind="task", name="Coil the stage snake cables", date=U("week", 1, weekday=3), effort="1 hour"))), act("create", args=lines(kind="task", name="Coil the stage snake cables", date=U("week", 1, weekday=3), effort=60))]),
  T("who've i spoken to from monday to the 6th at 10pm", rows("ines", "lena", "jonas_w", "marek", "kalle", "felix", "jonas_k"),
    ref=[ans(kind="person", when=W(span(U("week", 0, weekday=1), D("2026-02-06", "22:00"))))]))
