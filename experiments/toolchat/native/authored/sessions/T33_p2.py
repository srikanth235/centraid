from gold import *

def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T33-103-P", "date-window or-older from-on both-tenses repair-where-date para",
  T("documents dated 2025 and earlier",
    rows("d_sp25", "d_birth", "d_contract", "d_insure_h", "d_bylaws", "d_tax24", "d_booklet", "d_passport_k", "d_permit"),
    ref=[ans(kind="document", when=J({"to": U("year", -1)}))]),
  T("events starting the 20th and onward",
    rows("tree_lighting", "work_review", "dentist_ev", "flight_pg", "pa_birthday", "flight_back", "cm_0105", "agm", "cm_0202", "japan_flight"),
    ref=[ans(kind="event", when=J({"from": D("2026-12-20")}))]),
  T("playgroups we've had since the start of november", rows("play_1104", "play_1118", "play_1125", "play_1202", "play_1209"),
    ref=[bad(ans(kind="event", name="playgroup", where="status != cancelled and date >= 2026-11-01")),
         ans(kind="event", name="playgroup", where="status != cancelled",
             when=J(span(U("month", 0, name=11), U("day", 0))))]))

S("T33-107-P", "mixed note-body-append open-then-edit para",
  T("penang food list note, append laksa at the market",
    diff(upd("penang_ideas", body=has("laksa at the market", "kek seng", "kway teow"))),
    ref=[opn("$penang_ideas"),
         act("edit", rows="$penang_ideas",
             args="body: char kway teow at Lorong Selamat, cendol on Penang Road, Ma's nasi kandar, ABC at Kek Seng, laksa at the market")]))
