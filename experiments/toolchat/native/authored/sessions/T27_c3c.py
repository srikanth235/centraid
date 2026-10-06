from gold import *
import json

world("T27", "2026-12-03T04:50", "Sophie Dubois", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T27-C001", "c3c compound add_to note edit pin referential",
  T("move the baby names note into pregnancy and pin it",
    diff(link("preg_nb", "baby_names"), upd("baby_names", pinned=True)),
    ref=[search("baby names", kind="note"), act("add_to", rows="$baby_names", args=lines(to="$preg_nb"), more=True),
         act("edit", rows="$baby_names", args=lines(pinned="yes"))]))

S("T27-C002", "c3c compound cancel delete event document",
  T("cancel the photo shoot, we'll do it later, and delete the menu draft doc",
    diff(upd("photoshoot", status="cancelled"), trash("menu_draft")),
    ref=[act("cancel", kind="event", name="Photo shoot for the website", more=True),
         act("delete", kind="document", name="Menu draft")]))

S("T27-C003", "c3c compound both debts settle log find",
  T("chloe paid me back for both, settle them and log a coffee with her",
    diff(upd("d_chloe", status="settled"), upd("d_chloe2", status="settled"), upd("chloe", date=ANY)),
    ref=[search("chloe", kind="person"), find(kind="debt", linked_to="$chloe"), act("settle_debt", rows="@prev", more=True),
         act("log", rows="$chloe", args=lines(kind="coffee"))]))

S("T27-C004", "c3c compound three writes add_to star complete",
  T("file the menu draft in shop and star it, and tick off the menu boards",
    diff(link("shop_f", "menu_draft"), upd("menu_draft", starred=True), upd("menu_boards", status="completed", completed=ANY)),
    ref=[act("add_to", kind="document", name="Menu draft", args=lines(to="$shop_f"), more=True),
         act("star", rows="$menu_draft", more=True),
         act("complete", kind="task", name="Write the menu boards")]))

S("T27-C901", "c3c cell7 empty recovery misspelled search",
  T("when's the hygine inspection", rows("hygiene"),
    ref=[find(kind="event", name="hygine inspection"), search("hygine inspection", kind="event"), ans(rows="$hygiene")]),
  T('photos from last monday to the 30th at 8am', rows("p_croissants", "p_burnt", "p_stroller", "p_class", "p_lea", "p_xmas", "p_market", "p_oven", "p_bump28", "p_receipt", "p_kouign"),
    ref=[ans(kind="photo", when=W(span(U("week", -1, weekday=1), D("2026-11-30", "08:00"))))]))
