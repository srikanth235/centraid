from gold import *
import json

world("T37", "2027-03-09T10:40", "Liam O'Brien", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# --- S5 decline ---------------------------------------------------------------------------------

S("T37-K001", "decline not_found document other kinds hint i3skill S5",
  T("where's the receipt for the hearing aids", decline("not_found"),
    ref=[find(kind="document", name="hearing aids receipt"), dec("not_found")]))

S("T37-K002", "decline out_of_scope ring after read i3skill S5",
  T("when's the physio review", rows("physio_review"),
    ref=[ans(kind="event", name="Physio review")]),
  T("ring eimear and move it to next week", decline("out_of_scope"),
    ref=[dec("out_of_scope")]))

S("T37-K003", "decline no field steps then read i3skill S5",
  T("how many steps did i walk today", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("when's the gaa agm", rows("gaa_agm"),
    ref=[ans(kind="event", name="GAA AGM")]))

S("T37-K004", "decline text then debt read i3skill S5",
  T("text declan i'm on the way", decline("out_of_scope"),
    ref=[dec("out_of_scope")]),
  T("what's the debt with him about", rows("d_declan"),
    ref=[ans(kind="debt", linked_to="$declan")]))

S("T37-K005", "decline not_found photos find then search i3skill S5",
  T("any photos from the camino", decline("not_found"),
    ref=[find(kind="photo", name="camino"), search("camino", kind="photo"), dec("not_found")]))

# --- S6 vocabulary ------------------------------------------------------------------------------

S("T37-K101", "family word son daughter role i3skill S6",
  T("when did i last talk to my son", rows("conor"),
    ref=[ans(kind="person", where='role = "son"')]),
  T("and my daughter", rows("aoife"),
    ref=[ans(kind="person", where='role = "daughter"')]))

S("T37-K102", "list word is a note name not the list kind i3skill S6",
  T("what's on my medication list", rows("hl_meds"),
    ref=[ans(kind="note", name="Medication list")]),
  T("any note about the puck-outs", rows("gaa_match1"),
    ref=[ans(kind="note", where='body contains "puck-outs"')]))

S("T37-K103", "iou debt either direction i3skill S6",
  T("any ious with gerry", rows("d_gerry"),
    ref=[ans(kind="debt", linked_to="$gerry")]),
  T("and tadhg", rows("d_tadhg"),
    ref=[ans(kind="debt", linked_to="$tadhg")]))

S("T37-K104", "diary entry means note i3skill S6",
  T("my diary entries", rows("diary_walk", "diary_cian"),
    ref=[ans(kind="note", name="Diary entry")]),
  T("which one's about the goal", rows("diary_cian"),
    ref=[ans(kind="note", within="@prev", where='body contains "goal"')]))
