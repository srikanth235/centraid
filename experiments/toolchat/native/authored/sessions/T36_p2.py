from gold import *

import json

world("T36", "2026-12-09T21:15", "Dev Mehra", "train")

def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T36-109-P", "mixed kind-word documents notes photos para",
  T("wedding documents, list", rows("marriage_cert_d", "caterer_inv", "decor_inv", "photog_contract", "venue_receipt"),
    ref=[ans(kind="document", linked_to="$wedding_f")]),
  T("wedding notes next",
    rows("w_budget", "w_guests", "w_rituals", "w_vendors", "w_vows", "w_settle", "w_after"),
    ref=[ans(kind="note", linked_to="$wedding_nb")]),
  T("photos?", rows("p_haldi", "p_mehendi", "p_sangeet", "p_phere", "p_family", "p_varmala", "p_reception",
                           "p_friends", "p_decor"),
    ref=[ans(kind="photo", linked_to="$wedding_album")]),
  T("wedding documents, anything trashed from there", rows("old_quote"),
    ref=[ans(kind="document", linked_to="$wedding_f", trashed=True)]))
