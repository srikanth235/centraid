from gold import *
import json

world("D", "2026-12-20T19:40", "Marisol Reyes-Kapoor", "eval")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("D-E085", "party event people reschedule span",
  T("is gabi's party still in january, on the sixteenth", rows("gabi_party"),
    ref=[ans(kind="event", name="gabi's 40th birthday party", when=W(U("month", 1)))]),
  T("who's invited, and can the kids come along to the restaurant too", rows("gabi", "liz"),
    ref=[ans(kind="person", linked_to="$gabi_party")]),
  T("move it an hour earlier", diff(upd("gabi_party", date="2027-01-16T18:00")),
    ref=[act("reschedule", rows="$gabi_party", args=lines(to=U("hour", -1, anchor="row")))]),
  T("what else is that weekend", rows("call_mama158", "gabi_party"),
    ref=[ans(kind="event", when=W(span(D("2027-01-16"), D("2027-01-17"))))]))

S("D-E086", "locker read reveal star",
  T("what's saved for wells fargo, the login not the bank account", rows("bank_d"),
    ref=[ans(kind="locker item", name="wells fargo", where="type = login")]),
  T("read me the password", diff(reveal=[("bank_d", "Tamal3s!")]),
    ref=[act("reveal", rows="$bank_d", args="field: password")]),
  T("star it", diff(upd("bank_d", starred=True)),
    ref=[act("star", rows="$bank_d")]),
  T("star the costco one too, the membership for the register", diff(upd("costco_d", starred=True)),
    ref=[act("star", kind="locker item", name="costco")]))

S("D-E087", "debt read settle compute sum",
  T("is the gabi flight debt still open, she said she'd pay by now", rows("gabi_flight"),
    ref=[ans(kind="debt", name="gabi flight", where="status = open")]),
  T("she's paid up, close that debt", diff(upd("gabi_flight", status="settled")),
    ref=[act("settle_debt", rows="$gabi_flight")]),
  T("how much is still owed to me then", val((813.83, "USD")),
    ref=[comp(op="sum", field="amount", kind="debt", where="direction = owes_me and status = open"), ans(value="@prev")]),
  T("and what i owe", val((1217.93, "USD")),
    ref=[ans(op="sum", field="amount", kind="debt", where="direction = i_owe and status = open")]))

S("D-E088", "balance multi-currency group-balance settle",
  T("how are we doing money-wise, me and dev", val((-828.28, "USD"), (108.33, "MXN")),
    ref=[ans(op="balance", rows="$dev")]),
  T("just the ski weekend", val((238.48, "USD")),
    ref=[ans(op="balance", kind="group", name="Vermont Ski Weekend", linked_to="$dev")]),
  T("settle that up", diff(upd("dev", balance=ANY)),
    ref=[act("settle_up", rows="$dev", args="group: $ski")]),
  T("so what's left", val((-716.12, "USD"), (108.33, "MXN")),
    ref=[ans(op="balance", rows="$dev")]))

S("D-E089", "notebook count within order pin",
  T("how many garden notes do i have", val(11),
    ref=[find(kind="notebook", name="garden"), ans(op="count", kind="note", linked_to="$garden_nb")]),
  T("any about hydrangeas, three of them died last year", rows("nn70", "nn71", "nn72", "nn73"),
    ref=[ans(kind="note", where='body contains "hydrangea"')]),
  T("which is the newest", rows("nn73"),
    ref=[ans(within="@prev", order="date desc", limit=1)]),
  T("pin it", diff(upd("nn73", pinned=True)),
    ref=[act("edit", rows="$nn73", args="pinned: yes")]))

S("D-E090", "folder count filter move count",
  T("how many docs are in the taxes folder", val(10),
    ref=[find(kind="folder", name="taxes"), ans(op="count", kind="document", linked_to="$taxes_f")]),
  T("which ones are from 2024", rows("dc7", "dc10", "dc11", "dc14"),
    ref=[ans(kind="document", linked_to="$taxes_f", name="2024")]),
  T("move the 1099 to the work folder and star it", diff(unlink("taxes_f", "dc10"), link("work_f", "dc10"), upd("dc10", starred=True)),
    ref=[act("add_to", kind="document", name="1099", args="to: $work_f", more=True), act("star", kind="document", name="1099")]),
  T("how many are left in taxes", val(9),
    ref=[ans(op="count", kind="document", linked_to="$taxes_f")]))

S("D-E091", "album count person-and star add",
  T("ballet album photo count", val(41),
    ref=[ans(op="count", kind="photo", linked_to="$al_ballet")]),
  T("how many of those have lucia", val(29),
    ref=[search("Lucia", kind="person"), ans(op="count", kind="photo", linked_to="$al_ballet, $lucia")]),
  T("star the recital bow one, it's my favourite from last year", diff(already=["recital_2025"]),
    ref=[act("star", kind="photo", name="recital bow"), ans(rows="$recital_2025")]),
  T("add it to kids as well", diff(link("al_kids", "recital_2025")),
    ref=[find(kind="album", name="kids"), act("add_to", rows="$recital_2025", args="to: $al_kids")]))

S("D-E092", "create subtask parent count",
  T("add a step to gabi's surprise, order the cake, due the ninth of january", diff(new("task", name=has("cake"), date="2027-01-09"), link("gabi_gift", "new")),
    ref=[find(kind="task", name="surprise"),
         act("create", args=lines(kind="task", name="Order the cake", date=D("2027-01-09"), parent="$gabi_gift"))]),
  T("how many steps does it have now", val(3),
    ref=[comp(op="count", kind="task", linked_to="$gabi_gift"), ans(value="@prev")]))

S("D-E093", "event counts status compute",
  T("how many events do i have in january", val(26),
    ref=[comp(op="count", kind="event", when=W(U("month", 1))), ans(value="@prev")]),
  T("how many are cancelled", val(0),
    ref=[ans(op="count", kind="event", when=W(U("month", 1)), where="status = cancelled")]),
  T("and how long is the longest one", val(75),
    ref=[ans(op="max", field="duration", kind="event", when=W(U("month", 1)))]))

S("D-E094", "effort sum max compute",
  T("how many minutes of work is on the christmas list", val(210),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$xmas_l", where="status = open"), ans(value="@prev")]),
  T("and the reno one", val(60),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$reno_l", where="status = open")]),
  T("what's the longest task i've got", val(240),
    ref=[comp(op="max", field="effort", kind="task"), ans(value="@prev")]))

S("D-E095", "debt min person",
  T("smallest amount owed to me right now", val((16.48, "USD")),
    ref=[comp(op="min", field="amount", kind="debt", where="direction = owes_me and status = open"), ans(value="@prev")]),
  T("who is that one, from the dinner ages ago", rows("pp2"),
    ref=[find(kind="debt", where="direction = owes_me and status = open", order="amount asc", limit=1), ans(kind="person", linked_to="$db24")]),
  T("remind her about it", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("D-E096", "groups count currency members balance",
  T("number of groups i belong to", val(11),
    ref=[search("Marisol", kind="person"), ans(op="count", kind="group", linked_to="$me")]),
  T("which ones are in pesos", rows("gdl"),
    ref=[ans(kind="group", where='currency = "MXN"')]),
  T("who's in it, we need a headcount for the rental car", rows("me", "dev", "mama", "papa", "gabi", "tio"),
    ref=[ans(kind="person", linked_to="$gdl")]),
  T("where do i stand there", val((58.3, "MXN")),
    ref=[ans(op="balance", kind="group", name="Guadalajara Christmas", linked_to="$me")]))

S("D-E097", "people group-count filter",
  T("anyone sharing at least three groups with me", rows("me", "liz", "dev", "pp20"),
    ref=[ans(kind="person", where="group count >= 3")]),
  T("which of them is starred", rows("liz", "dev", "pp20"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("when did i last talk to my best friend liz", rows("liz"),
    ref=[ans(kind="person", name="liz", where='role = "best friend"')]))
