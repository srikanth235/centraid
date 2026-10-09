from gold import *

world("T05", "2026-01-20T06:40", "Priya Raman", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T05-A002", "ask-options task complete c3a",
  T("tick off the poosam one", ask("volunteers", "banner"),
    ref=[act("complete", kind="task", name="poosam"),
         askc("Finalise Thai Poosam volunteer list or Get Thai Poosam banner printed?", options="$volunteers, $banner")]),
  T("the banner, got it printed yesterday", diff(upd("banner", status="completed", completed=ANY)),
    ref=[act("complete", rows="$banner")]))

S("T05-A005", "ask-options photo delete c3a",
  T("delete the kolam photo", ask("kolam_pic", "blurry_kolam"),
    ref=[act("delete", kind="photo", name="kolam"),
         askc("The kolam in front of Paati's house or the blurry kolam shot?", options="$kolam_pic, $blurry_kolam")]),
  T("the blurry one, obviously", diff(trash("blurry_kolam"), unlink("pongal_al", "blurry_kolam")),
    ref=[act("delete", rows="$blurry_kolam")]))

S("T05-A006", "ask-options event edit never_mind c3a",
  T("make the amma cataract thing 90 minutes", ask("cataract_1", "cataract_2", "cataract_3"),
    ref=[act("edit", kind="event", name="cataract", args="duration: 90"),
         askc("The consultation on 22 Jan, the surgery on 13 Feb or the follow-up on 14 Feb?", options="$cataract_1, $cataract_2, $cataract_3")]),
  T("never mind, the hospital will say how long it takes", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("and star venkatesh", diff(upd("appa", starred=True)),
    ref=[act("star", kind="person", name="Venkatesh")]))

S("T05-A101", "ask-options event reschedule c3a",
  T("push the visit to thursday", ask("electrician", "bank"),
    ref=[act("reschedule", kind="event", name="visit", args=lines(to=U("week", 0, weekday=4))),
         askc("The electrician visit on the 27th or the bank visit for the FD renewal on the 28th?", options="$electrician, $bank")]))

S("T05-A007", "follow-up c3a",
  T("show me this week", rows("kavya_coffee", "day_0121", "appraisal", "day_0120", "tc_0124", "night_0123", "cric_0125", "cataract_1", "movie", "audit_mtg", "night_0124"),
    ref=[ans(kind="event", when=J(U("week", 0)))]),
  T("up to thursday only", rows("kavya_coffee", "day_0121", "appraisal", "day_0120", "cataract_1", "audit_mtg"),
    ref=[ans(within="@prev", when=J({"to": U("week", 0, weekday=4)}))]),
  T("what about the rest of the week", rows("tc_0124", "night_0123", "movie", "cric_0125", "night_0124"),
    ref=[ans(within="@1", exclude="@2")]))

S("T05-A008", "follow-up c3a",
  T("who do i owe", rows("d_jaya", "d_divya_s", "d_revathi", "d_ramesh_mama", "d_appa"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("those but not the scooty one", rows("d_ramesh_mama", "d_divya_s", "d_revathi", "d_jaya"),
    ref=[ans(within="@prev", exclude="$d_appa")]),
  T("which is the biggest", rows("d_ramesh_mama"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T05-A009", "follow-up c3a",
  T("what's in the icu notebook", rows("noradr", "sedation", "vap", "abg", "handover"),
    ref=[ans(kind="note", linked_to="$icu_nb")]),
  T("any of them pinned", rows("noradr", "abg"),
    ref=[ans(within="@prev", where="pinned = yes")]))

S("T05-A010", "follow-up c3a",
  T("what's left on the ICU list", rows("leave", "bls_cert", "handover_sheet", "tnnmc", "farhan_card", "cne_hours", "vap_poster"),
    ref=[ans(kind="task", linked_to="$iculist", where="status = open")]),
  T("which of those are priority 1", rows("leave", "bls_cert"),
    ref=[ans(within="@prev", where="priority = 1")]),
  T("and the ones due this week", rows("leave"),
    ref=[ans(within="@1", when=J(U("week", 0)))]))
