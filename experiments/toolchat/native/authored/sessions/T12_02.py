from gold import *
import json


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T12-026", "notebook contents remove_from note named add_to",
  T("what's in shop ideas", rows("idea_corn", "idea_tsuke", "idea_kids", "idea_fest"),
    ref=[ans(kind="note", linked_to="$ideas_nb")]),
  T("take kids menu out of it and put it in hana diary instead",
    diff(unlink("ideas_nb", "idea_kids"), link("hana_nb", "idea_kids")),
    ref=[act("remove_from", rows="$idea_kids", args=lines(from_="$ideas_nb"), more=True),
         act("add_to", rows="$idea_kids", args=lines(to="$hana_nb"))]))

S("T12-027", "trashed note empty recovery restore pin",
  T("didn't i have a note with the old summer prices", rows("old_prices"),
    ref=[ans(kind="note", name="Old summer menu prices"),
         ans(kind="note", name="Old summer menu prices", trashed=True)]),
  T("put it back, need it for the autumn pricing", diff(restore("old_prices")),
    ref=[act("restore", rows="$old_prices")]),
  T("and pin it", diff(upd("old_prices", pinned=True)),
    ref=[act("edit", rows="$old_prices", args=lines(pinned="yes"))]))

S("T12-028", "edit document named star read",
  T("rename lease renewal draft to Lease renewal 2026", diff(upd("lease_draft", name="Lease renewal 2026")),
    ref=[act("edit", rows="$lease_draft", args=lines(name="Lease renewal 2026"))]),
  T("star it too", diff(upd("lease_draft", starred=True)),
    ref=[act("star", rows="$lease_draft")]),
  T("what's starred in the lease folder", rows("lease_2024", "lease_draft"),
    ref=[ans(kind="document", linked_to="$lease_f", where="starred = yes")]))

S("T12-029", "unstar document where starred find",
  T("unstar whatever starred doc isn't in a folder", diff(upd("menu_aug", starred=False)),
    ref=[act("unstar", kind="document", where="starred = yes and folder count = 0")]),
  T("which docs are starred", rows("hygiene", "tax_2025", "lease_2024", "hana_vax", "shop_ins"),
    ref=[find(kind="document", where="starred = yes"), ans(rows="@prev")]))

S("T12-030", "create document add_to new folder",
  T("new doc: Fest stall layout", diff(new("document", name="Fest stall layout")),
    ref=[act("create", args=lines(kind="document", name="Fest stall layout"))]),
  T("file it under permits", diff(link("permits_f", "+1")),
    ref=[act("add_to", rows="$c1", args=lines(to="$permits_f"))]),
  T("what's in permits now", rows("hygiene", "fire_cert", "stall_permit", "+1"),
    ref=[ans(kind="document", linked_to="$permits_f")]))

S("T12-031", "single debt date time",
  T("which debt did i jot down on the thirteenth at 8am", rows("d_fujita"),
    ref=[ans(kind="debt", when=W(D("2026-08-13", "08:00")))]))

S("T12-032", "star photo where linked album exclude",
  T("star the pic with min-jun in it", diff(upd("noodle_class", starred=True)),
    ref=[act("star", kind="photo", linked_to="$minjun")]),
  T("what else is in seoul 2026", rows("gwangjang", "seoul_night"),
    ref=[ans(kind="photo", linked_to="$seoul_album", exclude="$noodle_class")]))

S("T12-033", "single add_to photo where album count",
  T("stick any pics of hana that aren't in an album into the hana album", diff(link("hana_album", "hana_noodles")),
    ref=[act("add_to", kind="photo", linked_to="$hana", where="album count = 0", args=lines(to="$hana_album"))]))

S("T12-034", "debt max order limit min",
  T("biggest amount anyone owes me right", val((32000, "JPY")),
    ref=[ans(op="max", field="amount", kind="debt", where='direction = "owes_me" and status = "open"')]),
  T("which one is that", rows("d_takeshi"),
    ref=[ans(kind="debt", where='direction = "owes_me" and status = "open"', order="amount desc", limit=1)]),
  T("and the smallest one i owe", val((2800, "JPY")),
    ref=[ans(op="min", field="amount", kind="debt", where='direction = "i_owe" and status = "open"')]))

S("T12-035", "settle debt named balance person",
  T("paid haruto back for the gas cylinder", diff(upd("d_haruto", status="settled")),
    ref=[act("settle_debt", kind="debt", name="Borrowed gas cylinder")]),
  T("so where am i with him", val((-15000, "JPY")),
    ref=[ans(op="balance", rows="$haruto")]))

S("T12-036", "group currency neq balance group",
  T("which groups aren't in yen", rows("seoul"),
    ref=[ans(kind="group", where='currency != "JPY"')]),
  T("who's in it", rows("shun", "koji", "minjun", "me"),
    ref=[ans(kind="person", linked_to="$seoul")]),
  T("and where am i in it", val((-60000, "KRW")),
    ref=[ans(op="balance", kind="group", name="Seoul ramyeon tour", linked_to="$me")]))

S("T12-037", "create locker edit new",
  T("new locker entry for the gas company login, call it Hokkaido Gas", diff(new("locker item", name="Hokkaido Gas")),
    ref=[act("create", args=lines(kind="locker item", name="Hokkaido Gas", type="login"))]),
  T("username watanabe_ramen, site is https://www.hokkaido-gas.co.jp",
    diff(upd("+1", username="watanabe_ramen", url="https://www.hokkaido-gas.co.jp")),
    ref=[act("edit", rows="$c1", args=lines(username="watanabe_ramen", url="https://www.hokkaido-gas.co.jp"))]))

S("T12-038", "unstar locker where starred find",
  T("unstar the card in the locker", diff(upd("jcb", starred=False)),
    ref=[act("unstar", kind="locker item", where='type = "card"')]),
  T("what's starred in there", rows("pos", "costco"),
    ref=[find(kind="locker item", where="starred = yes"), ans(rows="@prev")]))

S("T12-039", "search miss decline event named",
  T("anything in there about the kushiro trip", decline("not_found"),
    ref=[search("kushiro"), dec("not_found")]),
  T("hm. when's the seoul ramyeon tour", rows("seoul_trip"),
    ref=[ans(kind="event", name="Seoul ramyeon tour")]))

S("T12-040", "edit notebook refused name repair ask named count",
  T("rename the hana diary notebook to Hana", ask(),
    ref=[bad(act("edit", rows="$hana_nb", args=lines(name="Hana"))),
         askc("there's already something called Hana, so that name's taken. Hana notes instead?")]),
  T("ok hana notes", diff(upd("hana_nb", name="Hana notes")),
    ref=[act("edit", rows="$hana_nb", args=lines(name="Hana notes"))]),
  T("how many notes in it", val(3),
    ref=[ans(op="count", kind="note", linked_to="$hana_nb")]))

S("T12-041", "linked_to all notebook exclude",
  T("which notebook is the kombu order note in", rows("supplier_nb"),
    ref=[find(kind="note", name="Kombu order"), ans(kind="notebook", linked_to="@prev")]),
  T("what else is in there", rows("noodle_specs", "fujita_prices", "corn_sched"),
    ref=[ans(kind="note", linked_to="$supplier_nb", exclude="$kombu_order")]))

S("T12-042", "delete folder where count",
  T("delete whichever folder is empty", diff(gone("oldmenus_f")),
    ref=[act("delete", kind="folder", where="document count = 0")]),
  T("how many folders left", val(6),
    ref=[ans(op="count", kind="folder")]))

S("T12-043", "refused delete folder ask never mind",
  T("delete the lease folder", ask(),
    ref=[bad(act("delete", rows="$lease_f")),
         askc("the lease folder still has the 2024 lease and the renewal draft in it. delete those first?")]),
  T("nah leave it then", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T12-044", "event overlap refused ask create read day",
  T("book coffee with koji thursday at 2", ask(),
    ref=[bad(act("create", args=lines(kind="event", name="Coffee with Koji",
                                       date=U("week", 0, weekday=4, time="14:00")))),
         askc("that clashes with the accountant meeting at 2. 3pm instead?")]),
  T("3 is fine", diff(new("event", name="Coffee with Koji", date="2026-08-20T15:00")),
    ref=[act("create", args=lines(kind="event", name="Coffee with Koji", date=U("week", 0, weekday=4, time="15:00")))]),
  T("what's thursday look like", rows("pork_0820", "acct_aug", "+1"),
    ref=[ans(kind="event", when=W(U("week", 0, weekday=4)))]))

S("T12-045", "person role literal within linked",
  T("who are my part-timers", rows("aiko", "ryo_t", "mei"),
    ref=[find(kind="person", where='role = "part-timer"'), ans(rows="@prev")]),
  T("which of them are in year-end party 2026", rows("aiko", "mei"),
    ref=[ans(within="@prev", linked_to="$yearend")]))

S("T12-046", "cadence gte within open span person",
  T("who am i meant to catch up with monthly or less often",
    rows("emi", "nishiyama", "fujita", "endo", "ogawa", "ito", "hayashi_t", "kimura", "koji", "haruto"),
    ref=[find(kind="person", where="cadence >= 30"), ans(rows="@prev")]),
  T("which of those did i last talk to in june or before", rows("endo", "ogawa", "koji"),
    ref=[ans(within="@prev", when=W({"to": U("month", -2)}))]),
  T("rang endo now about the corn, log it", diff(upd("endo", date=ANY)),
    ref=[act("log", rows="$endo", args=lines(kind="call"))]))

S("T12-047", "trashed people find restore named log",
  T("who's sitting in my contacts trash", rows("tetsuya", "sora", "abe"),
    ref=[find(kind="person", trashed=True), ans(rows="@prev")]),
  T("restore sora inoue", diff(restore("sora")),
    ref=[act("restore", rows="$sora")]),
  T("log a message from him, he texted about delivery shifts", diff(upd("sora", date=ANY)),
    ref=[act("log", rows="$sora", args=lines(kind="message"))]))

S("T12-048", "person event count gt",
  T("who have i got more than five things in the calendar with",
    rows("daisuke", "aiko", "ryo_t", "fujita", "hana", "takeshi"),
    ref=[find(kind="person", where="event count > 5"), ans(rows="@prev")]),
  T("the ones in shop staff kitty", rows("daisuke", "aiko", "ryo_t"),
    ref=[ans(within="@prev", linked_to="$staff")]))

S("T12-049", "single person note count gt",
  T("who've i got more than one note about", rows("hana", "yuki", "nishiyama"),
    ref=[find(kind="person", where="note count > 1"), ans(rows="@prev")]))

S("T12-050", "empty recovery nickname search notes linked four calls",
  T("any notes mentioning nishi-san", rows("noodle_specs", "idea_tsuke"),
    ref=[find(kind="note", where='body contains "Nishi-san"'),
         search("Nishi-san", kind="person"),
         ans(kind="note", linked_to="$nishiyama")]),
  T("the tsukemen one, move it to supplier notes", diff(unlink("ideas_nb", "idea_tsuke"), link("supplier_nb", "idea_tsuke")),
    ref=[act("remove_from", rows="$idea_tsuke", args=lines(from_="$ideas_nb"), more=True),
         act("add_to", rows="$idea_tsuke", args=lines(to="$supplier_nb"))]))
