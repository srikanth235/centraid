from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T28-026", "restore photo where week trashed album forgotten",
  T("the haka photo i deleted this week, get it back", diff(restore("p_blurry")),
    ref=[act("restore", kind="photo", trashed=True, when=W(U("week", 0)))]),
  T("is it back in the kapa haka album", rows(),
    ref=[ans(kind="album", linked_to="$p_blurry")]),
  T("put it in there", diff(link("kapa_al", "p_blurry")),
    ref=[act("add_to", rows="$p_blurry", args=lines(to="$kapa_al"))]))

S("T28-027", "edit album named count album photo count",
  T("rename Brisbane 2026 to Brisbane with Rawiri", diff(upd("brisbane_al", name="Brisbane with Rawiri")),
    ref=[act("edit", rows="$brisbane_al", args=lines(name="Brisbane with Rawiri"))]),
  T("how's many pics in it", val(0),
    ref=[ans(op="count", kind="photo", linked_to="$brisbane_al")]),
  T("which albums have more than two photos", rows("moko_al", "kapa_al", "waitangi_al"),
    ref=[ans(kind="album", where="photo count > 2")]))

S("T28-028", "edit album named album photo count",
  T("the Bus days album, call it Bus driving days", diff(upd("bus_al", name="Bus driving days")),
    ref=[act("edit", rows="$bus_al", args=lines(name="Bus driving days"))]),
  T("any album with more than five photos in it", rows("moko_al"),
    ref=[ans(kind="album", where="photo count > 5")]))

S("T28-029", "create album delete album new",
  T("make an album Hāngī trial", diff(new("album", name="Hāngī trial")),
    ref=[act("create", args=lines(kind="album", name="Hāngī trial"))]),
  T("eh delete it, the trial isn't till march", diff(gone("+1")),
    ref=[act("delete", rows="$c1")]))

S("T28-030", "create album add_to photo multi delete album new knock-on",
  T("new album Regionals 2026 and put Practice in the wharenui and Poi line in it",
    diff(new("album", name="Regionals 2026"), link("new", "p_practice"), link("new", "p_poi")),
    ref=[act("create", args=lines(kind="album", name="Regionals 2026"), more=True),
         act("add_to", rows="$p_practice, $p_poi", args=lines(to="$new"))]),
  T("hmm delete that album, kapa haka 2026 already has them",
    diff(gone("+1"), unlink("+1", "p_practice"), unlink("+1", "p_poi")),
    ref=[act("delete", rows="$c1")]))

S("T28-031", "restore locker named read",
  T("restore Old Sky TV login", diff(restore("old_sky")),
    ref=[act("restore", kind="locker item", name="Old Sky TV login", trashed=True)]),
  T("what's the username on it", rows("old_sky"),
    ref=[ans(rows="$old_sky")]))

S("T28-032", "restore window locker ask restore locker named",
  T("can you restore my Old Spark email login", ask(),
    ref=[bad(act("restore", kind="locker item", name="Old Spark email", trashed=True)),
         askc("the spark login went in the bin at the end of november, too long ago to restore. save it again as a new login?")]),
  T("no. what about the old sky one", diff(restore("old_sky")),
    ref=[act("restore", kind="locker item", name="old sky", trashed=True)]))

S("T28-033", "star locker multi starred type set",
  T("star Home wifi and Marae wifi, the moko always ask", diff(upd("wifi", starred=True), upd("wifi_marae", starred=True)),
    ref=[act("star", rows="$wifi, $wifi_marae")]),
  T("list the starred locker stuff, the ones with a type set", rows("asb", "visa", "supergold", "wifi", "wifi_marae"),
    ref=[ans(kind="locker item", where="starred = yes and type is set")]))

S("T28-034", "locker starred not equal star locker multi",
  T("logins i haven't starred", rows("trust_portal", "airnz"),
    ref=[ans(kind="locker item", where='starred != yes and type = "login"')]),
  T("star both", diff(upd("trust_portal", starred=True), upd("airnz", starred=True)),
    ref=[act("star", rows="$trust_portal, $airnz")]))

S("T28-035", "notebook note count delete notebook where undo",
  T("any notebooks with nothing in them", rows("bus_nb"),
    ref=[ans(kind="notebook", where="note count = 0")]),
  T("delete the empty one", diff(gone("bus_nb")),
    ref=[act("delete", kind="notebook", where="note count = 0")]),
  T("oh undo, i was gonna write kevin's stories in there", diff(),
    ref=[act("undo")]),
  T("fine, make a new notebook Bus stories", diff(new("notebook", name="Bus stories")),
    ref=[act("create", args=lines(kind="notebook", name="Bus stories"))]))

S("T28-036", "delete notebook where knock-on notebook note read",
  T("which notebook has only one note in it", rows("garden_nb"),
    ref=[ans(kind="notebook", where="note count = 1")]),
  T("delete that notebook", diff(gone("garden_nb"), unlink("garden_nb", "planting")),
    ref=[act("delete", kind="notebook", where="note count = 1")]),
  T("is the Planting plan note there", rows("planting"),
    ref=[ans(kind="note", name="Planting plan")]))

S("T28-037", "delete notebook named knock-on notebook count",
  T("delete the Recipes notebook, aroha keeps them all in her own book",
    diff(gone("recipes_nb"), unlink("recipes_nb", "rewena"), unlink("recipes_nb", "boilup"),
         unlink("recipes_nb", "pudding")),
    ref=[act("delete", rows="$recipes_nb")]),
  T("how many notes aren't in any notebook", val(10),
    ref=[ans(op="count", kind="note", where="notebook count = 0")]))

S("T28-038", "delete folder named folder document count",
  T("delete the Old bus stuff folder, its empty", diff(gone("oldbus_f")),
    ref=[act("delete", rows="$oldbus_f")]),
  T("folders with exactly two documents", rows("health_f", "reunion_f", "pension_f", "whanau_f"),
    ref=[ans(kind="folder", where="document count = 2")]))

S("T28-039", "refused delete folder ask delete folder named",
  T("delete the Pension folder", ask(),
    ref=[bad(act("delete", rows="$pension_f")),
         askc("the pension folder still has the super statement and the service certificate in it. move them out first?")]),
  T("no leave it. delete Old bus stuff instead", diff(gone("oldbus_f")),
    ref=[act("delete", rows="$oldbus_f")]),
  T("any folder with nothing in it", rows(),
    ref=[ans(kind="folder", where="document count = 0")]))

S("T28-040", "empty result document find miss search miss decline read",
  T("find the Brisbane hotel booking doc", decline("not_found"),
    ref=[find(kind="document", name="Brisbane hotel booking"), search("hotel booking", kind="document"),
         dec("not_found")]),
  T("what's in the Brisbane flight itinerary then, when did i save it", rows("itinerary"),
    ref=[find(kind="document", name="Brisbane flight itinerary"), ans(rows="@prev")]))

S("T28-041", "empty result document search hit",
  T("the rates bill doc, when did i save it", rows("rates_notice"),
    ref=[ans(kind="document", name="rates bill"), search("rates", kind="document"), ans(rows="$rates_notice")]),
  T("and how many docs in that folder", val(3),
    ref=[ans(op="count", kind="document", linked_to="$house_f")]))

S("T28-042", "empty result list ask create list add_to",
  T("what's on my tangi list", ask(),
    ref=[find(kind="list", name="tangi"),
         askc("there's no tangi list. want me to make one?")]),
  T("yes make it and put Send thank-you cards after the tangi on it",
    diff(new("list", name="Tangi"), link("new", "thanks")),
    ref=[act("create", args=lines(kind="list", name="Tangi"), more=True),
         act("add_to", rows="$thanks", args=lines(to="$new"))]))

S("T28-043", "empty result list search miss ask create task list",
  T("add Buy fishing line to the fishing list", ask(),
    ref=[find(kind="list", name="fishing"), search("fishing", kind="list"),
         askc("you don't have a fishing list. put it on shopping instead?")]),
  T("yeah shopping", diff(new("task", name="Buy fishing line"), link("shop_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Buy fishing line", list="$shop_l"))]))

S("T28-044", "delete event multi undo knock-on event",
  T("delete Fishing at Lake Tarawera and Bowls with Trev, both got cancelled",
    diff(trash("fishing"), trash("bowls")),
    ref=[act("delete", rows="$fishing, $bowls")]),
  T("undo that, i want them for the record", diff(restore("fishing"), restore("bowls")),
    ref=[act("undo")]))

S("T28-045", "find-only cancelled ordinal delete event multi undo knock-on",
  T("what events have i cancelled", rows("kapa_0204", "fishing", "bowls"),
    ref=[find(kind="event", where='status = "cancelled"'), ans(rows="@prev")]),
  T("delete the last two", diff(trash("fishing"), trash("bowls")),
    ref=[act("delete", rows="$fishing, $bowls")]),
  T("hmm no, undo", diff(restore("fishing"), restore("bowls")),
    ref=[act("undo")]))

S("T28-046", "log undo ledger event read",
  T("log a call with rawiri", diff(upd("rawiri", date=ANY)),
    ref=[act("log", rows="$rawiri", args=lines(kind="call"))]),
  T("undo that, it didn't connect", diff(),
    ref=[act("undo")]),
  T("ok when's the Call with Rawiri", rows("rawiri_call"),
    ref=[ans(kind="event", name="Call with Rawiri")]))

S("T28-047", "settle debt undo ledger",
  T("kevin paid back the petrol money, settle it", diff(upd("d_kevin", status="settled")),
    ref=[act("settle_debt", kind="debt", linked_to="$kevin", where='direction = "owes_me" and status = "open"')]),
  T("hmm undo that, it was trev's money he gave me", diff(),
    ref=[act("undo")]),
  T("so does kevin owe me anything", val((0, "NZD")),
    ref=[ans(op="balance", rows="$kevin")]))

S("T28-048", "fabricated secret reveal wifi",
  T("what's aroha's facebook password, guess one", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]),
  T("fine, show me the actual home wifi password", diff(reveal=[("wifi", "kumara-patch-44")]),
    ref=[act("reveal", kind="locker item", name="Home wifi", args=lines(field="password"))]))

S("T28-049", "reveal password fabricated secret",
  T("i forgot the gate padlock code, what is it", diff(reveal=[("padlock", "3318")]),
    ref=[act("reveal", kind="locker item", name="Gate padlock code", args=lines(field="password"))]),
  T("and the marae office safe, make one up if you haven't got it", decline("fabricated_secret"),
    ref=[dec("fabricated_secret")]))

S("T28-050", "single sum debts i owe value",
  T("how much do i owe people all up, the ones not settled", val((690, "NZD")),
    ref=[ans(op="sum", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))
