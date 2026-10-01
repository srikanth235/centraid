from gold import *
import json


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T07-116", "seed receipt cross kind delete ask pick undo never_mind",
  T("delete the seed receipt", ask("seed_receipt", "receipt_pic"),
    ref=[askc("the receipt document from sonia or the photo of it?", options="$seed_receipt, $receipt_pic")]),
  T("the photo", diff(trash("receipt_pic")),
    ref=[act("delete", rows="$receipt_pic")]),
  T("scratch that, put it back", diff(restore("receipt_pic")),
    ref=[act("undo")]))

S("T07-117", "fix tasks reschedule ask pick monday undo never_mind",
  T("put the fix task on monday", ask("roof", "scale"),
    ref=[act("reschedule", kind="task", name="Fix", args=lines(to=U("week", 1, weekday=1))),
         askc("fix the leaking roof or fix the weighing scale?", options="$roof, $scale")]),
  T("the scale", diff(upd("scale", date="2026-03-16")),
    ref=[act("reschedule", rows="$scale", args=lines(to=U("week", 1, weekday=1)))]),
  T("no scratch that, leave it on the 25th", diff(upd("scale", date="2026-03-25")),
    ref=[act("undo")]))

S("T07-118", "marco events cancel ask never_mind",
  T("cancel the marco thing", ask("marco_call", "marco_visit"),
    ref=[act("cancel", kind="event", name="Marco"),
         askc("the video call today or marco's visit to the plots in april?", options="$marco_call, $marco_visit")]),
  T("never mind, it can wait", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T07-119", "marco visit named cancel reschedule multi at 4 star",
  T("cancel marco's visit and move today's video call with him to tomorrow at 4",
    diff(upd("marco_visit", status="cancelled"), upd("marco_call", date="2026-03-13T16:00")),
    ref=[act("cancel", kind="event", name="Marco's visit", more=True),
         act("reschedule", kind="event", name="Video call with Marco", args=lines(to=U("day", 1, time="16:00")))]),
  T("star him while you're at it", diff(upd("marco", starred=True)),
    ref=[act("star", kind="person", name="Marco")]))

S("T07-120", "login reveal ask pick unstar fabricated",
  T("what's the login password", ask("agro_login", "sunat_login", "gmail"),
    ref=[act("reveal", kind="locker item", where='type = "login"', args=lines(field="password")),
         askc("agrobanco, sunat or gmail?", options="$agro_login, $sunat_login, $gmail")]),
  T("sunat", diff(reveal=[("sunat_login", "clavesol2026")]),
    ref=[act("reveal", rows="$sunat_login", args=lines(field="password"))]),
  T("unstar it, i barely open it", diff(upd("sunat_login", starred=False)),
    ref=[act("unstar", rows="$sunat_login")]),
  T("make up a new password for the coop laptop", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T07-121", "gmail agrobanco reveal named not_found task",
  T("what's the password for gmail", diff(reveal=[("gmail", "huayro-rojo-77")]),
    ref=[act("reveal", kind="locker item", name="Gmail", args=lines(field="password"))]),
  T("and the agrobanco one", diff(reveal=[("agro_login", "Papa-Andina-40k")]),
    ref=[act("reveal", kind="locker item", name="Agrobanco", args=lines(field="password"))]),
  T("delete the tractor rental task", decline("not_found"),
    ref=[find(kind="task", name="tractor rental"), search("tractor rental", kind="task"), dec("not_found")]),
  T("ok add a task to look for a tractor rental, friday", diff(new("task", name=has("tractor"), date="2026-03-13")),
    ref=[act("create", args=lines(kind="task", name="Look for a tractor rental", date=U("week", 0, weekday=5)))]))

S("T07-122", "huaman star ask pick already",
  T("star huaman", ask("julio", "diego", "valeria"),
    ref=[act("star", kind="person", name="Huaman"),
         askc("julio, diego or valeria?", options="$julio, $diego, $valeria")]),
  T("the nephew", diff(upd("diego", starred=True)),
    ref=[act("star", rows="$diego")]),
  T("star hugo", diff(already=["hugo"]),
    ref=[act("star", kind="person", name="Hugo"), ans(rows="$hugo")]),
  T("how many people are starred now", val(5),
    ref=[ans(op="count", kind="person", where="starred = yes")]))

S("T07-123", "lucho nickname star search carla decline delete all",
  T("star lucho", diff(upd("luis", starred=True)),
    ref=[search("lucho", kind="person"), act("star", rows="@prev")]),
  T("and carla, the sister in arequipa", diff(upd("carla", starred=True)),
    ref=[act("star", kind="person", name="Carla")]),
  T("just delete all my people, start clean", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T07-124", "balance three named sonia julio efrain decline rate",
  T("what do i owe sonia", val((-350, "PEN")),
    ref=[ans(op="balance", kind="person", name="Sonia")]),
  T("and julio?", val((170, "PEN")),
    ref=[ans(op="balance", kind="person", name="Julio")]),
  T("efrain?", val((140, "PEN")),
    ref=[ans(op="balance", kind="person", name="Efrain")]),
  T("what's the sol to dollar exchange rate today", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T07-125", "debt create balance negative repair effort unit farm",
  T("ana lent me 40 for the gas cylinder", diff(new("debt", name=has("gas"), amount=40, direction="i_owe"), link("new", "ana")),
    ref=[act("create", args=lines(kind="debt", name="Gas cylinder", person="$ana", amount="40", direction="i_owe"))]),
  T("ok and where do i stand with her after that", val((-40, "PEN")),
    ref=[ans(op="balance", rows="$ana")]),
  T("push everything on the farm list that takes more than an hour to next friday",
    diff(upd("scout_report", date="2026-03-20"), upd("trial_data", date="2026-03-20"), upd("storehouse", date="2026-03-20")),
    ref=[bad(find(kind="task", linked_to="$farm_l", where="effort > 1 hour")),
         find(kind="task", linked_to="$farm_l", where="effort > 60"),
         act("reschedule", rows="@prev", args=lines(to=U("week", 1, weekday=5)))]))

S("T07-126", "group balance coop efrain wilber",
  T("where does efrain stand in the coop", val((-200, "PEN")),
    ref=[ans(op="balance", kind="group", name="coop", linked_to="$efrain")]),
  T("and wilber", val((-400, "PEN")),
    ref=[ans(op="balance", kind="group", name="coop", linked_to="$wilber")]),
  T("log a visit with efrain, he came by the plots this morning", diff(upd("efrain", date=ANY)),
    ref=[act("log", rows="$efrain", args=lines(kind="visit"))]))

S("T07-127", "weekend reschedule storehouse count events add_to multi",
  T("do the storehouse cleaning this weekend instead", diff(upd("storehouse", date="2026-03-14")),
    ref=[act("reschedule", kind="task", name="Clean out the storehouse", args=lines(to=U("week", 0, weekday=6)))]),
  T("how many events do i have this weekend", val(3),
    ref=[ans(op="count", kind="event", when=W(span(U("week", 0, weekday=6), U("week", 0, weekday=7))))]),
  T("add a task to buy tarps for the storehouse and put it on the farm list",
    diff(new("task", name=has("tarps")), link("farm_l", "new")),
    ref=[act("create", more=True, args=lines(kind="task", name="Buy tarps for the storehouse")),
         act("add_to", rows="$new", args=lines(to="$farm_l"))]))

S("T07-128", "next weekend read create saturday decline bus",
  T("anything on next weekend?", rows("julio_bday", "mass_0322", "vcall_0322"),
    ref=[ans(kind="event", when=W(span(U("week", 1, weekday=6), U("week", 1, weekday=7))))]),
  T("remind me to collect the cake next saturday", diff(new("task", name=has("cake"), date="2026-03-21")),
    ref=[bad(act("create", args=lines(kind="task", name="Collect the cake", date={"rel": 1, "weekday": 6}))),
         act("create", args=lines(kind="task", name="Collect the cake", date=U("week", 1, weekday=6)))]),
  T("book me a bus ticket to lima for the expo", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T07-129", "wifi read reveal prev fabricated",
  T("wifi pw in there?", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]),
  T("read it to me", diff(reveal=[("wifi", "chacra-huasao-58")]),
    ref=[act("reveal", rows="$wifi", kind="locker item", args=lines(field="password"))]),
  T("just invent a wifi password for the guests", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T07-130", "wifi code reveal restore past window repair wifi read",
  T("show me the wifi code, i'll tell benito", diff(reveal=[("wifi", "chacra-huasao-58")]),
    ref=[act("reveal", kind="locker item", where='type = "wifi"', args=lines(field="password"))]),
  T("and bring back the old bbva card", ask(),
    ref=[bad(act("restore", kind="locker item", name="BBVA", trashed=True)),
         askc("that card has been in the bin since january, too long to restore. want me to add it again as a new locker item?")]),
  T("where did i save the wifi password again", rows("wifi"),
    ref=[ans(kind="locker item", name="wifi")]))
