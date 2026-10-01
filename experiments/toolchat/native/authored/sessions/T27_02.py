from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T27-026", "edit photo where weekday time add_to album",
  T("the photo from tuesday at 7:45, rename it Praline brioche v2", diff(upd("p_praline", name="Praline brioche v2")),
    ref=[act("edit", kind="photo", when=W(U("week", 0, weekday=2, time="07:45")), args=lines(name="Praline brioche v2"))]),
  T("put it in the Opening day album as well", diff(link("opening_al", "p_praline")),
    ref=[act("add_to", rows="$p_praline", args=lines(to="$opening_al"))]))

S("T27-027", "photo weekday time star people",
  T("what did i snap last monday at half 7", rows("p_kouign"),
    ref=[ans(kind="photo", when=W(U("week", -1, weekday=1, time="07:30")))]),
  T("star that", diff(upd("p_kouign", starred=True)),
    ref=[act("star", rows="@prev")]),
  T("who's tagged in it", rows("nadia"),
    ref=[ans(kind="person", linked_to="$p_kouign")]))

S("T27-028", "restore photo named undo restore",
  T("restore Blurry display case", diff(restore("p_blurry")),
    ref=[act("restore", kind="photo", name="Blurry display case", trashed=True)]),
  T("ugh it really is blurry. undo", diff(trash("p_blurry")),
    ref=[act("undo")]))

S("T27-029", "restore photo named trashed album not restored add_to",
  T("did i delete the duplicate bump photo", rows("p_dup"),
    ref=[ans(kind="photo", name="Duplicate bump photo"),
         ans(kind="photo", name="Duplicate bump photo", trashed=True)]),
  T("restore Duplicate bump photo, its actually the better one", diff(restore("p_dup")),
    ref=[act("restore", rows="$p_dup")]),
  T("is it back in the Bump album", rows("p_bump20", "p_bump24", "p_bump28", "p_ultra"),
    ref=[ans(kind="photo", linked_to="$bump_al")]),
  T("put it in there", diff(link("bump_al", "p_dup")),
    ref=[act("add_to", rows="$p_dup", args=lines(to="$bump_al"))]))

S("T27-030", "create album add_to photo count album",
  T("make an album Nursery and put the paint samples photo in it",
    diff(new("album", name="Nursery"), link("new", "p_paint")),
    ref=[act("create", args=lines(kind="album", name="Nursery"), more=True),
         act("add_to", kind="photo", name="Nursery paint samples", args=lines(to="$new"))]),
  T("which albums have three photos or fewer", rows("lyon_al", "opening_al", "+1"),
    ref=[ans(kind="album", where="photo count <= 3")]))

S("T27-031", "single create album",
  T("new album called Opening week", diff(new("album", name="Opening week")),
    ref=[act("create", args=lines(kind="album", name="Opening week"))]))

S("T27-032", "delete album prev find-only photo count",
  T("do i have any empty albums", rows("opening_al"),
    ref=[find(kind="album", where="photo count <= 0"), ans(rows="@prev")]),
  T("delete it, i'll make a proper one on the day", diff(gone("opening_al")),
    ref=[act("delete", rows="@prev")]))

S("T27-033", "delete album prev count",
  T("how many photos in the lyon album", val(3),
    ref=[ans(op="count", kind="photo", linked_to="$lyon_al")]),
  T("which ones", rows("p_fourviere", "p_market", "p_quays"),
    ref=[ans(kind="photo", linked_to="$lyon_al")]),
  T("ok delete the album, the photos can stay loose",
    diff(gone("lyon_al"), unlink("lyon_al", "p_fourviere"), unlink("lyon_al", "p_market"), unlink("lyon_al", "p_quays")),
    ref=[find(kind="album", name="Lyon"), act("delete", rows="@3")]))

S("T27-034", "delete locker multi count",
  T("delete the Ethereum wallet and Recipe costing software, i don't use either",
    diff(trash("eth"), trash("costing")),
    ref=[act("delete", rows="$eth, $costing")]),
  T("how many things left in the locker", val(16),
    ref=[ans(op="count", kind="locker item")]))

S("T27-035", "delete locker multi types",
  T("what techy stuff have i got in the locker, keys, api, software, crypto",
    rows("web_key", "order_api", "costing", "eth"),
    ref=[ans(kind="locker item", where='type in ("ssh_key", "api_credential", "software_licence", "crypto_wallet")')]),
  T("delete the first two, we moved hosts",
    diff(trash("web_key"), trash("order_api")),
    ref=[act("delete", rows="$web_key, $order_api")]))

S("T27-036", "create locker star new",
  T("add a locker entry Lyon Pro bank app, it's a login", diff(new("locker item", name="Lyon Pro bank app", type="login")),
    ref=[act("create", args=lines(kind="locker item", name="Lyon Pro bank app", type="login"))]),
  T("star it", diff(upd("+1", starred=True)),
    ref=[act("star", rows="$c1")]),
  T("which locker things are starred", rows("bank_login", "biz_visa", "metro_card", "+1"),
    ref=[ans(kind="locker item", where="starred = yes")]))

S("T27-037", "create locker star new knock-on locker add_to document",
  T("save a wifi item called Shop guest wifi", diff(new("locker item", name="Shop guest wifi", type="wifi")),
    ref=[act("create", args=lines(kind="locker item", name="Shop guest wifi", type="wifi"))]),
  T("star it, and file the Menu draft under Shop while you're at it",
    diff(upd("+1", starred=True), link("shop_f", "menu_draft")),
    ref=[act("star", rows="$c1", more=True),
         act("add_to", kind="document", name="Menu draft", args=lines(to="$shop_f"))]))

S("T27-038", "knock-on locker star add_to document move",
  T("star the Till PIN and move the Business insurance policy into Bank",
    diff(upd("till_pin", starred=True), unlink("shop_f", "insurance"), link("bank_f", "insurance")),
    ref=[act("star", kind="locker item", name="Till PIN", more=True),
         act("add_to", rows="$insurance", args=lines(to="$bank_f"))]),
  T("what's in bank now", rows("loan", "bizplan", "partnership", "insurance"),
    ref=[ans(kind="document", linked_to="$bank_f")]))

S("T27-039", "delete notebook named note survives",
  T("delete the Old Paris notes notebook", diff(gone("paris_nb"), unlink("paris_nb", "paris_contacts")),
    ref=[act("delete", kind="notebook", name="Old Paris notes")]),
  T("is the contacts note around", rows("paris_contacts"),
    ref=[ans(kind="note", name="Old Paris contacts")]),
  T("delete that too", diff(trash("paris_contacts")),
    ref=[act("delete", rows="@prev")]))

S("T27-040", "delete notebook named empty undo not undone",
  T("notebooks holding four-plus notes", rows("recipes_nb", "plans_nb", "preg_nb"),
    ref=[ans(kind="notebook", where="note count >= 4")]),
  T("and delete Menu ideas, never used it", diff(gone("menu_nb")),
    ref=[act("delete", kind="notebook", name="Menu ideas")]),
  T("undo that", diff(),
    ref=[act("undo")]))

S("T27-041", "edit folder multi named",
  T("rename both Receipts and Old Paris to Archive", diff(upd("receipts_f", name="Archive"), upd("paris_f", name="Archive")),
    ref=[act("edit", rows="$receipts_f, $paris_f", args=lines(name="Archive"))]))

S("T27-042", "edit folder multi prev document count",
  T("which folders have nothing live in them", rows("receipts_f", "paris_f"),
    ref=[find(kind="folder", where="document count = 0"), ans(rows="@prev")]),
  T("call them both To sort", diff(upd("receipts_f", name="To sort"), upd("paris_f", name="To sort")),
    ref=[act("edit", rows="@prev", args=lines(name="To sort"))]))

S("T27-043", "empty result folder search hit",
  T("what's in my invoices folder", rows("oven_invoice"),
    ref=[find(kind="folder", name="Invoices"), search("invoice"), ans(rows="$oven_invoice")]),
  T("which folder is it in", rows("sup_f"),
    ref=[ans(kind="folder", linked_to="$oven_invoice")]))

S("T27-044", "empty result folder decline not found create folder add_to",
  T("open the tax folder", decline("not_found"),
    ref=[find(kind="folder", name="Tax"), dec("not_found")]),
  T("make one called Taxes and move the Kbis extract into it",
    diff(new("folder", name="Taxes"), unlink("shop_f", "kbis"), link("new", "kbis")),
    ref=[act("create", args=lines(kind="folder", name="Taxes"), more=True),
         act("add_to", rows="$kbis", args=lines(to="$new"))]))

S("T27-045", "empty result note search hit",
  T("show me my croissant recipe note", rows("lamination"),
    ref=[find(kind="note", name="Croissant recipe"), search("croissant", kind="note"), ans(rows="$lamination")]),
  T("is it pinned", rows("lamination"),
    ref=[ans(kind="note", name="Croissant lamination", where="pinned = yes")]))

S("T27-046", "empty result note body contains",
  T("the note about the fève", rows("galette"),
    ref=[find(kind="note", name="fève"), find(kind="note", where='body contains "fève"'), ans(rows="@prev")]),
  T("who's it linked to", rows("odette"),
    ref=[ans(kind="person", linked_to="$galette")]))

S("T27-047", "decline sealed egress reveal wifi",
  T("text the shop wifi password to inès", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("the till engineer's here, need the shop wifi password", diff(reveal=[("wifi_shop", "austerlitz-7am")]),
    ref=[act("reveal", kind="locker item", name="Shop wifi", args=lines(field="password"))]))

S("T27-048", "single decline sealed egress card",
  T("email camille the number on the Business Visa so she can pay the flour", decline("sealed_egress"),
    ref=[dec("sealed_egress")]))

S("T27-049", "edit note undo field body literal",
  T("rename Opening prices to Opening price list", diff(upd("prices", name="Opening price list")),
    ref=[act("edit", kind="note", name="Opening prices", args=lines(name="Opening price list"))]),
  T("hmm undo that, camille searches for the old name", diff(upd("prices", name="Opening prices")),
    ref=[act("undo")]),
  T("which note says exactly most active after coffee", rows("kicks"),
    ref=[ans(kind="note", where='body = "most active after coffee"')]))

S("T27-050", "seven turns flour delivery ambiguous ask reschedule overlap bad create ask log undo ledger",
  T("move the flour delivery to half 7", ask("flour_1", "flour_2"),
    ref=[act("reschedule", kind="event", name="Flour delivery", args=lines(to=U("day", 0, anchor="row", time="07:30"))),
         find(kind="event", name="Flour delivery"),
         askc("tomorrow's or the one on the 11th?", options="$flour_1, $flour_2")]),
  T("tomorrow's", diff(upd("flour_1", date="2026-12-04T07:30")),
    ref=[act("reschedule", rows="$flour_1", args=lines(to=U("day", 0, anchor="row", time="07:30")))]),
  T("what's on tomorrow morning", rows("flour_1", "butter_del"),
    ref=[ans(kind="event", when=W(span(U("day", 1, time="00:00"), U("day", 1, time="12:00"))))]),
  T("add Coffee with Thomas Girard tomorrow at 8", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Coffee with Thomas Girard", date=U("day", 1, time="08:00")))),
         askc("the butter delivery is 8 to 8:30 tomorrow. want the coffee at 8:30 instead?")]),
  T("yeah 8:30", diff(new("event", name="Coffee with Thomas Girard", date="2026-12-04T08:30")),
    ref=[act("create", args=lines(kind="event", name="Coffee with Thomas Girard", date=U("day", 1, time="08:30")))]),
  T("make a note of a call with him, phoned to confirm", diff(upd("thomas_g", date=ANY)),
    ref=[act("log", rows="$thomas_g", args=lines(kind="call"))]),
  T("hold on, that was yesterday not today, reverse it", diff(),
    ref=[act("undo")]))
