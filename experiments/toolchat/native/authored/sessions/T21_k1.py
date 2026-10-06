from gold import *
import json

world("T21", "2026-06-06T09:00", "Grace Mwangi", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T21-K001", "decline not_found document find miss i3skill S5",
  T("where did i put the nairobi hotel booking", decline("not_found"),
    ref=[find(kind="document", name="hotel booking"), dec("not_found")]))

S("T21-K002", "decline out_of_scope call after read i3skill S5",
  T("when's the county education meeting", rows("county_meet"),
    ref=[ans(kind="event", name="County education meeting")]),
  T("call the county office and confirm the venue", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T21-K003", "decline distance then read then book i3skill S5",
  T("how far is nakuru from eldoret", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("when's brian's graduation", rows("brian_grad"),
    ref=[ans(kind="event", name="Brian's graduation")]),
  T("book me a seat on the eldoret bus", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T21-K004", "decline text then log message is a write i3skill S5",
  T("text kevin to call me tonight", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("log that i messaged kevin", diff(upd("kevin", date=ANY)),
    ref=[act("log", rows="$kevin", args=lines(kind="message"))]))

S("T21-K005", "decline send money then read last contact i3skill S5",
  T("send mama njeri 3000 on mpesa", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("when did i last talk to her", rows("esther"),
    ref=[ans(kind="person", name="Mama Njeri")]))

S("T21-K006", "decline not_found note find then search i3skill S5",
  T("any note about the borehole", decline("not_found"),
    ref=[find(kind="note", name="borehole"), search("borehole", kind="note"), dec("not_found")]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T21-K101", "family word sister brother-in-law role i3skill S6",
  T("when did i last speak to my sister", rows("esther"),
    ref=[ans(kind="person", where='role contains "sister"')]),
  T("and my brother-in-law", rows("james"),
    ref=[ans(kind="person", where='role = "brother-in-law"')]))

S("T21-K102", "list word is a document name i3skill S6",
  T("is the fees arrears list in the fees folder", rows("arrears_list"),
    ref=[ans(kind="document", name="Fees arrears list", linked_to="$fees_f")]),
  T("star it", diff(upd("arrears_list", starred=True)),
    ref=[act("star", rows="$arrears_list")]))

S("T21-K103", "iou debt either direction i3skill S6",
  T("any iou with brian", rows("d_brian"),
    ref=[ans(kind="debt", linked_to="$brian")]),
  T("and kevin", rows("d_kevin"),
    ref=[ans(kind="debt", linked_to="$kevin")]))

S("T21-K104", "a note about body search pin i3skill S6",
  T("that note about the missing beacons", rows("plot_notes"),
    ref=[ans(kind="note", where='body contains "beacons"')]),
  T("pin it", diff(upd("plot_notes", pinned=True)),
    ref=[act("edit", rows="$plot_notes", args=lines(pinned="yes"))]))
