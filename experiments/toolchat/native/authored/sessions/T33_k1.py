from gold import *
import json

world("T33", "2026-12-12T08:50", "Hiro Tanaka-Lim", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T33-K001", "decline not_found document other kinds hint i3skill S5",
  T("where's my osaka itinerary doc", decline("not_found"),
    ref=[ans(kind="document", name="Osaka itinerary"), dec("not_found")]))

S("T33-K002", "decline out_of_scope book after read i3skill S5",
  T("when's pa's birthday dinner", rows("pa_birthday"),
    ref=[ans(kind="event", name="Pa's birthday dinner")]),
  T("book a table at the restaurant for it", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T33-K003", "decline no field air quality then read i3skill S5",
  T("what's the haze reading today", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("when's the condo agm", rows("agm"),
    ref=[ans(kind="event", name="Condo AGM")]))

S("T33-K004", "decline text helper then read permit event i3skill S5",
  T("text rina to pick up kenji at noon", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("when's rina's work permit appointment", rows("permit_visit"),
    ref=[ans(kind="event", name="MOM appointment for Rina's work permit")]))

S("T33-K005", "decline not_found photo find then search i3skill S5",
  T("any photos from the christmas concert", decline("not_found"),
    ref=[find(kind="photo", name="christmas concert"), search("concert", kind="photo"), dec("not_found")]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T33-K101", "family word father-in-law mother role i3skill S6",
  T("when did i last call my father-in-law", rows("pa"),
    ref=[ans(kind="person", where='role = "father-in-law"')]),
  T("and my mother", rows("okaasan"),
    ref=[ans(kind="person", where='role = "mother"')]))

S("T33-K102", "list word is a note name not the list kind i3skill S6",
  T("what's on the penang food list", rows("penang_ideas"),
    ref=[ans(kind="note", name="Penang food list")]),
  T("pin it", diff(upd("penang_ideas", pinned=True)),
    ref=[act("edit", rows="$penang_ideas", args=lines(pinned="yes"))]))

S("T33-K103", "diary entry means note i3skill S6",
  T("show me my diary entries", rows("diary_tired", "diary_happy"),
    ref=[ans(kind="note", name="Diary entry")]),
  T("which one mentions the fever", rows("diary_tired"),
    ref=[ans(kind="note", within="@prev", where='body contains "fever"')]))

S("T33-K104", "iou debt either direction i3skill S6",
  T("any iou with ravi", rows("d_ravi"),
    ref=[ans(kind="debt", linked_to="$ravi")]),
  T("and wei jie", rows("d_weijie"),
    ref=[ans(kind="debt", linked_to="$weijie")]))

S("T33-K105", "a note about body search then move to notebook i3skill S6",
  T("that note about the rempah", rows("rc_laksa"),
    ref=[ans(kind="note", where='body contains "rempah"')]),
  T("move it to the ideas notebook", diff(link("ideas_nb", "rc_laksa"), unlink("recipes_nb", "rc_laksa")),
    ref=[act("add_to", rows="$rc_laksa", args=lines(to="$ideas_nb"))]))
