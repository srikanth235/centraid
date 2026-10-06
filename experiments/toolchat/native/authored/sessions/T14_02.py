from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T14-026", "seven turns mom cardiology folder star",
  T("mom's cardiology appointment, when's the next one", rows("cardio_nov"),
    ref=[ans(kind="event", name="Mom's cardiology appointment", when=W({"from": U("day", 0)}))]),
  T("who's on it", rows("mae", "helena"),
    ref=[ans(kind="person", linked_to="$cardio_nov")]),
  T("and the rest of that tuesday", rows("cardio_nov", "pickup_mae"),
    ref=[ans(kind="event", when=W(U("week", 2, weekday=2)))]),
  T("get mom's echo results, done yet?", rows("mae_exam"),
    ref=[ans(kind="task", name="Get Mom's echo results")]),
  T("push that to the second, lab said monday", diff(upd("mae_exam", date="2026-11-02")),
    ref=[act("reschedule", rows="$mae_exam", args=lines(to=D("2026-11-02")))]),
  T("what's in the mom medical folder", rows("echo_doc", "blood_doc", "plan_card", "rx"),
    ref=[ans(kind="document", linked_to="$mae_f")]),
  T("star the prescription, dra helena wants to see it", diff(upd("rx", starred=True)),
    ref=[act("star", rows="$rx")]))

S("T14-027", "trashed person find restore prev",
  T("any contacts in the trash with DJ in their role", rows("felipe"),
    ref=[find(kind="person", trashed=True, where='role contains "DJ"'), ans(rows="@prev")]),
  T("restore him, we're talking", diff(restore("felipe")),
    ref=[act("restore", rows="@prev")]),
  T("was there a studio session with him in the diary", rows("felipe_studio"),
    ref=[ans(kind="event", name="Studio session with Felipe"),
         ans(kind="event", name="Studio session with Felipe", trashed=True)]))

S("T14-028", "restore window person ask create",
  T("restore caio martins", ask(),
    ref=[bad(act("restore", kind="person", name="Caio Martins", trashed=True)),
         askc("caio's been in the bin more than 30 days, so he can't come back. make him again as a new contact?")]),
  T("yeah do that, old roommate", diff(new("person", name="Caio Martins", role=ANY)),
    ref=[act("create", args=lines(kind="person", name="Caio Martins", role="old roommate"))]))

S("T14-030", "locker create star unstar new",
  T("new locker entry Serato login, username djtomasf, and star it",
    diff(new("locker item", name="Serato login", username="djtomasf", starred=True)),
    ref=[act("create", more=True, args=lines(kind="locker item", name="Serato login", type="login", username="djtomasf")),
         act("star", rows="$new")]),
  T("eh unstar it, i barely use serato", diff(upd("+1", starred=False)),
    ref=[act("unstar", rows="$c1")]),
  T("which logins do i have starred", rows("uber_login"),
    ref=[ans(kind="locker item", where='type = "login" and starred = yes')]))

S("T14-031", "folder create delete new",
  T("make a folder called Buenos Aires docs", diff(new("folder", name="Buenos Aires docs")),
    ref=[act("create", args=lines(kind="folder", name="Buenos Aires docs"))]),
  T("nah the niceto booking can stay in gig contracts. delete that folder", diff(gone("+1")),
    ref=[act("delete", rows="$c1")]))

S("T14-032", "notebook where count edit prev",
  T("which notebook has only one note in it", rows("old_nb"),
    ref=[find(kind="notebook", where="note count = 1"), ans(rows="@prev")]),
  T("rename it Archive 2025", diff(upd("old_nb", name="Archive 2025")),
    ref=[act("edit", rows="@prev", args=lines(name="Archive 2025"))]))

S("T14-033", "ambiguous folder ask rename",
  T("rename the car folder to Carro", ask("car_docs_f", "car_pool_f"),
    ref=[act("edit", kind="folder", name="car", args=lines(name="Carro")),
         askc("car documents or car pool receipts?", options="$car_docs_f, $car_pool_f")]),
  T("the documents one", diff(upd("car_docs_f", name="Carro")),
    ref=[act("edit", rows="$car_docs_f", args=lines(name="Carro"))]),
  T("what's in it", rows("crlv", "cnh_doc", "ins_policy"),
    ref=[ans(kind="document", linked_to="$car_docs_f")]))

S("T14-034", "event overlap refused ask create",
  T("dinner with bianca next wednesday at 9pm", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Dinner with Bianca", date=U("week", 1, weekday=3, time="21:00")))),
         askc("you've got collective rehearsal 8 to 11 that night. another night?")]),
  T("tuesday then, same time", diff(new("event", name="Dinner with Bianca", date="2026-10-27T21:00")),
    ref=[act("create", args=lines(kind="event", name="Dinner with Bianca", date=U("week", 1, weekday=2, time="21:00")))]),
  T("what's that tuesday look like", rows("airport_otavio", "blood_work", "+1"),
    ref=[ans(kind="event", when=W(U("week", 1, weekday=2)))]))

S("T14-035", "find ambiguous note ask delete",
  T("delete the pharmacy list, bought everything", ask("pharm_1", "pharm_2"),
    ref=[find(kind="note", name="Pharmacy list"),
         act("delete", kind="note", name="Pharmacy list"),
         askc("two of them: the one in mom's health or the loose one?", options="$pharm_1, $pharm_2")]),
  T("the loose one", diff(trash("pharm_2")),
    ref=[act("delete", rows="$pharm_2")]))

S("T14-036", "linked_to all event search nickname",
  T("anything in the diary with both larissa and guga", rows("flight_bsas"),
    ref=[search("guga", kind="person"),
         ans(kind="event", linked_to="$larissa, $guga")]),
  T("and everything that weekend", rows("flight_bsas", "gig_bsas"),
    ref=[ans(kind="event", when=W(span(D("2026-12-04"), D("2026-12-06"))))]))

S("T14-037", "linked_to all list",
  T("which list are renew cnh and install dashcam on", rows("carro_l"),
    ref=[ans(kind="list", linked_to="$cnh, $dashcam")]),
  T("lists that aren't for work", rows("dj_l", "casa_l", "mae_l", "admin_l", "compras_l"),
    ref=[find(kind="list", where='area != "work"'), ans(rows="@prev")]))

S("T14-038", "cadence empty set cadence",
  T("who don't i have a check-in rhythm for", rows("otavio", "neide", "bianca", "helena", "jhonatan", "juliana", "me"),
    ref=[find(kind="person", where="cadence is empty"), ans(rows="@prev")]),
  T("set dona neide to every fourteen days", diff(upd("neide", cadence=14)),
    ref=[act("edit", rows="$neide", args=lines(cadence=14))]))

S("T14-039", "event count gte",
  T("who's in five or more things in my diary",
    rows("rafa_s", "nath", "mae", "thiago", "wesley", "guga", "junior", "juliana"),
    ref=[find(kind="person", where="event count >= 5"), ans(rows="@prev")]),
  T("of those who's family", rows("mae", "thiago"),
    ref=[ans(within="@prev", where='role in ("mother", "cousin")')]))

S("T14-040", "photo count eq",
  T("people who are in exactly two photos", rows("nath", "rafa_m", "thiago", "wesley"),
    ref=[find(kind="person", where="photo count = 2"), ans(rows="@prev")]),
  T("and the pics of wesley santos", rows("football", "haircut_p"),
    ref=[ans(kind="photo", linked_to="$wesley")]))

S("T14-041", "status set duration set next week",
  T("everything in the diary next week that has a status on it",
    rows("hand_1026", "airport_otavio", "blood_work", "oil", "reh_1028", "physio_1029", "accountant", "fut_1029",
         "kleber_1030", "landlord", "lunch_mae"),
    ref=[ans(kind="event", when=W(U("week", 1)), where="status is set")]),
  T("which of those are over two hours", rows("kleber_1030", "reh_1028", "lunch_mae"),
    ref=[ans(within="@prev", where="duration > 120")]))

S("T14-042", "task status ne effort unit",
  T("open jobs over an hour, anything not done", rows("cnh", "dashcam", "setlist12", "mix", "bsas_setlist", "mae_rail",
                                                    "leak", "shelf", "passport"),
    ref=[bad(ans(kind="task", where='effort > 1 hour and status = "open"')),
         ans(kind="task", where='effort > 60 minutes and status = "open"')]),
  T("and of those, anything due by end of october", rows("dashcam", "setlist12", "leak"),
    ref=[ans(within="@prev", when=W({"to": D("2026-10-31")}))]))

S("T14-043", "task description literal",
  T("which task did i mark with pix", rows("tyre_pay"),
    ref=[ans(kind="task", where='description = "pix"')]),
  T("who's it linked to", rows("junior"),
    ref=[ans(kind="person", linked_to="$tyre_pay")]),
  T("done, sent it this afternoon", diff(upd("tyre_pay", status="completed", completed=ANY)),
    ref=[act("complete", rows="$tyre_pay")]))

S("T14-045", "note body empty person count ne",
  T("any notes with nothing in the body", rows(),
    ref=[ans(kind="note", where="body is empty")]),
  T("ok which notes mention someone", rows("rodizio", "mae_meds_n", "ins_claim", "lease_note", "idea_collab", "set_cv",
                                          "gift_ideas", "vo_party", "set12", "mae_bp", "helena_qs"),
    ref=[ans(kind="note", where="person count != 0")]))

S("T14-046", "photo album count album photo count",
  T("photos that haven't been sorted into albums yet", rows("paulista", "flyer_bsas", "cv_lights", "car_rafa", "sunset_marg", "movie_night",
                                          "vinyl_haul", "rain_car", "football", "haircut_p"),
    ref=[find(kind="photo", where="album count < 1"), ans(rows="@prev")]),
  T("is there an album with nothing in it", rows("empty_album"),
    ref=[find(kind="album", where="photo count = 0"), ans(rows="@prev")]),
  T("put the buenos aires flyer in it", diff(link("empty_album", "flyer_bsas")),
    ref=[act("add_to", rows="$flyer_bsas", args=lines(to="$empty_album"))]))

S("T14-047", "debt amount empty status in",
  T("any debts where i never put an amount", rows(),
    ref=[ans(kind="debt", where="amount is empty")]),
  T("list every debt i owe, paid or not", rows("d_junior", "d_nath", "d_patricia", "d_larissa", "d_wesley", "d_marcos_t"),
    ref=[ans(kind="debt", where='direction = "i_owe" and status in ("open", "settled")')]))

S("T14-048", "locker username set notes ne",
  T("which locker things have a username on them", rows("gmail", "gov", "soundcloud", "uber_login"),
    ref=[find(kind="locker item", where="username is set"), ans(rows="@prev")]),
  T("which ones have notes on them, apart from the current technical rider one",
    rows("rekordbox", "gate", "ssh", "spotify_api", "passport_l", "itau", "cnh_l", "btc", "smart_fit"),
    ref=[ans(kind="locker item", where='notes is set and notes != "current technical rider"')]))

S("T14-049", "list task count area ne",
  T("which lists have fewer than five things", rows("compras_l", "admin_l"),
    ref=[find(kind="list", where="task count < 5"), ans(rows="@prev")]),
  T("add renew passport to compras too... no wait, what's on papelada", rows("das", "mei_decl", "nf", "passport"),
    ref=[ans(kind="task", linked_to="$admin_l")]))

S("T14-050", "six turns larissa birthday",
  T("when's larissa's birthday dinner", rows("lari_bday"),
    ref=[ans(kind="event", name="Larissa's birthday dinner")]),
  T("who's coming", rows("larissa", "bianca"),
    ref=[ans(kind="person", linked_to="$lari_bday")]),
  T("buy larissa's birthday gift, done yet?", rows("gift_lari"),
    ref=[ans(kind="task", name="Buy Larissa's birthday gift")]),
  T("what did i put in gift ideas for larissa", rows("gift_ideas"),
    ref=[ans(kind="note", name="Gift ideas for Larissa")]),
  T("pin that note", diff(upd("gift_ideas", pinned=True)),
    ref=[act("edit", rows="$gift_ideas", args=lines(pinned="yes"))]),
  T("and bianca owes me for pizza right", rows("d_bianca"),
    ref=[ans(kind="debt", linked_to="$bianca")]))
