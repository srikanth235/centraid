from gold import *
import json

world("T14", "2026-10-24T19:30", "Tomás Ferreira", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


WEEKEND = span(U("week", 0, weekday=6), U("week", 0, weekday=7))

S("T14-101", "ask options haircut reschedule balance negative",
  T("push the haircut to friday at 4", ask("haircut_1023", "haircut_1106"),
    ref=[act("reschedule", kind="event", name="Haircut with Wesley",
             args=lines(to=U("week", 1, weekday=5, time="16:00"))),
         find(kind="event", name="Haircut with Wesley"),
         askc("the one on the 23rd or the one on nov 6?", options="$haircut_1023, $haircut_1106")]),
  T("nov 6, the other one's done", diff(upd("haircut_1106", date="2026-10-30T16:00")),
    ref=[act("reschedule", rows="$haircut_1106", args=lines(to=U("week", 1, weekday=5, time="16:00")))]),
  T("how much do i owe wesley", val((-35, "BRL")),
    ref=[ans(op="balance", rows="$wesley")]))

S("T14-102", "haircut next then reschedule star person",
  T("when's my next haircut", rows("haircut_1106"),
    ref=[ans(kind="event", name="Haircut with Wesley", when=W({"from": U("day", 0)}))]),
  T("push the haircut to friday at 3", diff(upd("haircut_1106", date="2026-10-30T15:00")),
    ref=[act("reschedule", rows="$haircut_1106", args=lines(to=U("week", 1, weekday=5, time="15:00")))]),
  T("star wesley, best barber i've had", diff(upd("wesley", starred=True)),
    ref=[act("star", kind="person", name="Wesley")]))

S("T14-103", "ask options ipva complete balance negative",
  T("tick pay ipva", ask("ipva_26", "ipva_25"),
    ref=[act("complete", kind="task", name="Pay IPVA"),
         find(kind="task", name="Pay IPVA"),
         askc("this year's, due nov 16, or the 2025 one?", options="$ipva_26, $ipva_25")]),
  T("this year's", diff(upd("ipva_26", status="completed", completed=ANY)),
    ref=[act("complete", rows="$ipva_26")]),
  T("and what do i owe juninho", val((-640, "BRL")),
    ref=[search("juninho", kind="person"), ans(op="balance", rows="$junior")]))

S("T14-104", "carro list then complete already star",
  T("what's still open on the carro list", rows("rating", "dashcam", "ipva_26", "cnh"),
    ref=[ans(kind="task", linked_to="$carro_l", where='status = "open"')]),
  T("pay ipva done, paid at the bank", diff(upd("ipva_26", status="completed", completed=ANY)),
    ref=[act("complete", rows="$ipva_26")]),
  T("star the crlv too", diff(already=["crlv"]),
    ref=[act("star", rows="$crlv", kind="document"), ans(rows="$crlv")]))

S("T14-105", "ask options das receipt star contract",
  T("star the das receipt", ask("das_aug", "das_sep"),
    ref=[act("star", kind="document", name="DAS receipt"),
         askc("august or september?", options="$das_aug, $das_sep")]),
  T("august", diff(upd("das_aug", starred=True)),
    ref=[act("star", rows="$das_aug")]),
  T("and the contract", diff(upd("contract_cv", starred=True)),
    ref=[act("star", kind="document", name="contract")]))

S("T14-106", "ask options marcos star balance negative",
  T("star marcos", ask("marcos_o", "marcos_t"),
    ref=[act("star", kind="person", name="Marcos"),
         askc("marcos oliveira the dj or marcos tavares the mechanic?", options="$marcos_o, $marcos_t")]),
  T("the mechanic", diff(upd("marcos_t", starred=True)),
    ref=[act("star", rows="$marcos_t")]),
  T("how much do i still owe him", val((-250, "BRL")),
    ref=[ans(op="balance", rows="$marcos_t")]))

S("T14-107", "star by role unstar nickname search",
  T("star the mechanic, i keep losing his number", diff(upd("marcos_t", starred=True)),
    ref=[act("star", kind="person", where='role contains "mechanic"')]),
  T("unstar mãe, she's on speed dial anyway", diff(upd("mae", starred=False)),
    ref=[search("mãe", kind="person"), act("unstar", rows="$mae")]))

S("T14-108", "ask options cnh cross kind star unstar",
  T("star the cnh", ask("cnh_l", "cnh_doc"),
    ref=[search("cnh", kind="locker item, document"),
         askc("the cnh in the locker or the cnh scan document?", options="$cnh_l, $cnh_doc")]),
  T("the scan", diff(upd("cnh_doc", starred=True)),
    ref=[act("star", rows="$cnh_doc")]),
  T("unstar the crlv, i have the paper copy", diff(upd("crlv", starred=False)),
    ref=[act("unstar", kind="document", name="CRLV")]))

S("T14-109", "ask options logins reveal wifi read",
  T("what's the login password", ask("uber_login", "soundcloud", "gmail", "gov"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("uber, soundcloud, gmail or gov.br?", options="$uber_login, $soundcloud, $gmail, $gov")]),
  T("gmail", diff(reveal=[("gmail", "Madalena#2026")]),
    ref=[act("reveal", rows="$gmail", args=lines(field="password"))]),
  T("and where's the wifi password", rows("wifi"),
    ref=[ans(kind="locker item", name="Casa wifi")]))

S("T14-110", "reveal gmail star reveal wifi verb",
  T("what's the gmail password", diff(reveal=[("gmail", "Madalena#2026")]),
    ref=[act("reveal", kind="locker item", name="Gmail", args=lines(field="password"))]),
  T("star it, i keep looking for it", diff(upd("gmail", starred=True)),
    ref=[act("star", rows="$gmail")]),
  T("show me the wifi password", diff(reveal=[("wifi", "plantas-da-lari")]),
    ref=[act("reveal", kind="locker item", name="Casa wifi", args=lines(field="password"))]))

S("T14-111", "ask options cardiology cancel never mind undo",
  T("cancel mom's cardiology appointment", ask("cardio_sep", "cardio_nov"),
    ref=[act("cancel", kind="event", name="Mom's cardiology appointment"),
         find(kind="event", name="Mom's cardiology appointment"),
         askc("the one on sep 15 or the one on nov 3?", options="$cardio_sep, $cardio_nov")]),
  T("november, dra helena's out that day", diff(upd("cardio_nov", status="cancelled")),
    ref=[act("cancel", rows="$cardio_nov")]),
  T("scratch that, she just messaged, she's back", diff(),
    ref=[act("undo")]))

S("T14-112", "cancel with month cancel pickup",
  T("cancel mom's cardiology appointment in november", diff(upd("cardio_nov", status="cancelled")),
    ref=[act("cancel", kind="event", name="Mom's cardiology appointment", when=W(U("month", 0, name=11)))]),
  T("and pick up mom, drop that too", diff(upd("pickup_mae", status="cancelled")),
    ref=[act("cancel", kind="event", name="Pick up Mom from the clinic")]))

S("T14-113", "balance positive settle debt balance positive",
  T("how much does kleber owe me", val((600, "BRL")),
    ref=[ans(op="balance", rows="$kleber")]),
  T("settle it, he pixed me", diff(upd("d_kleber", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$kleber", where='status = "open"')]),
  T("and where do i stand with larissa", val((950, "BRL")),
    ref=[ans(op="balance", rows="$larissa")]))

S("T14-114", "unbounded destruction not found trashed",
  T("delete everything in my diary", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("fine. delete the sell the bike task then", decline("not_found"),
    ref=[act("delete", kind="task", name="Sell the bike"), dec("not_found")]))

S("T14-115", "out of scope weekend read",
  T("book me an uber to the galpão for tonight", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("anything on the weekend besides the baile", rows("regina_lunch"),
    ref=[ans(kind="event", when=W(WEEKEND), exclude="$baile_12")]))


# follow-up turns
X("T14-102",
  T("and what do i owe patrícia", val((-230, "BRL")),
    ref=[ans(op="balance", rows="$patricia")]))

X("T14-103",
  T("also remind me to check the fuel receipts, due monday",
    diff(new("task", name=has("fuel"), date="2026-10-26")),
    ref=[act("create", args=lines(kind="task", name="Check the fuel receipts", date=U("week", 1, weekday=1)))]))

X("T14-104",
  T("push the dashcam to sunday", diff(upd("dashcam", date="2026-10-25")),
    ref=[act("reschedule", kind="task", name="Install dashcam", args=lines(to=U("week", 0, weekday=7)))]))

X("T14-105",
  T("unstar the mei certificate, fernanda has the copy", diff(upd("mei_cert", starred=False)),
    ref=[act("unstar", kind="document", name="MEI certificate")]))

X("T14-106",
  T("what's the tally of people with my star", val(3),
    ref=[ans(op="count", kind="person", where="starred = yes")]))

X("T14-107",
  T("and what does bianca owe me", val((40, "BRL")),
    ref=[ans(op="balance", rows="$bianca")]))

X("T14-108",
  T("so what's my starred docs count", val(4),
    ref=[ans(op="count", kind="document", where="starred = yes")]))

X("T14-110",
  T("star the casa wifi too, the visitors ask", diff(upd("wifi", starred=True)),
    ref=[act("star", kind="locker item", name="Casa wifi")]))

X("T14-112",
  T("star dra helena, she's the one to ring", diff(upd("helena", starred=True)),
    ref=[act("star", kind="person", name="Helena")]))

X("T14-113",
  T("how many debts are still open", val(10),
    ref=[ans(op="count", kind="debt", where='status = "open"')]))

X("T14-114",
  T("add a task, sell the old cdj deck, due friday", diff(new("task", name=has("cdj"), date="2026-10-30")),
    ref=[act("create", args=lines(kind="task", name="Sell the old CDJ deck", date=U("week", 1, weekday=5)))]))

X("T14-115",
  T("put the buenos aires flyer in the flyers album", diff(link("flyers_album", "flyer_bsas")),
    ref=[act("add_to", kind="photo", name="Flyer Buenos Aires", args=lines(to="$flyers_album"))]))
