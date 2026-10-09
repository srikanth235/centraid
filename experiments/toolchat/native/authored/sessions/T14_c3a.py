from gold import *

world("T14", "2026-10-24T19:30", "Tomás Ferreira", "train")


def J(d):
    return json.dumps(d, separators=(",", ":"))

S("T14-A001", "ask-options event cancel c3a",
  T("cancel the set at kleber's", ask("kleber_1030", "kleber_1113"),
    ref=[act("cancel", kind="event", name="DJ set at Bar do Kleber"),
         find(kind="event", name="DJ set at Bar do Kleber", when=J({"from": U("day", 0)})),
         askc("The one on 30 Oct or the one on 13 Nov?", options="$kleber_1030, $kleber_1113")]),
  T("the 13th, i'm in sampa on the 30th", diff(upd("kleber_1113", status="cancelled")),
    ref=[act("cancel", rows="$kleber_1113")]))

S("T14-A003", "ask-options task complete c3a",
  T("tick off the mix one", ask("mix", "mix_cover", "mix_upload"),
    ref=[act("complete", kind="task", name="mix"),
         askc("Record promo mix, Design mix cover or Upload mix to SoundCloud?", options="$mix, $mix_cover, $mix_upload")]),
  T("cover, ana paula sent it", diff(upd("mix_cover", status="completed", completed=ANY)),
    ref=[act("complete", rows="$mix_cover")]),
  T("and the dashcam one's done, tick it off", diff(upd("dashcam", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="dashcam")]))

S("T14-A004", "ask-options document delete never_mind c3a",
  T("delete the das receipt", ask("das_sep", "das_aug"),
    ref=[act("delete", kind="document", name="das"),
         askc("The September one or the August one?", options="$das_sep, $das_aug")]),
  T("melhor deixar, the accountant wants both", decline("never_mind"),
    ref=[dec("never_mind")]))

S("T14-A101", "ask-options task complete c3a",
  T("tick off the fix one", ask("headphones", "leak"),
    ref=[act("complete", kind="task", name="fix"),
         askc("Fix headphone cable or Fix bathroom leak?", options="$headphones, $leak")]))

S("T14-A007", "follow-up c3a",
  T("what have i got next week", rows("oil", "airport_otavio", "fut_1029", "kleber_1030", "hand_1026", "physio_1029", "accountant", "blood_work", "lunch_mae", "reh_1028", "landlord"),
    ref=[ans(kind="event", when=J(U("week", 1)))]),
  T("just the ones before thursday", rows("hand_1026", "oil", "airport_otavio", "reh_1028", "blood_work"),
    ref=[ans(within="@prev", when=J({"to": U("week", 1, weekday=3)}))]),
  T("and everything else", rows("lunch_mae", "physio_1029", "fut_1029", "landlord", "kleber_1030", "accountant"),
    ref=[ans(within="@1", exclude="@2")]))

S("T14-A008", "follow-up c3a",
  T("what do i owe", rows("d_wesley", "d_junior", "d_nath", "d_marcos_t", "d_patricia"),
    ref=[ans(kind="debt", where="direction = i_owe and status = open")]),
  T("those but not the haircut", rows("d_marcos_t", "d_patricia", "d_junior", "d_nath"),
    ref=[ans(within="@prev", exclude="$d_wesley")]),
  T("and the biggest one", rows("d_junior"),
    ref=[ans(within="@prev", order="amount desc", limit=1)]))

S("T14-A009", "follow-up c3a",
  T("what's left on the mãe list", rows("plan_11", "mae_split", "mae_rail", "mae_exam", "mae_plan", "mae_meds"),
    ref=[ans(kind="task", linked_to="$mae_l", where="status = open")]),
  T("next week's ones only", rows("mae_meds", "mae_split", "mae_plan", "mae_exam"),
    ref=[ans(within="@prev", when=J(U("week", 1)))]),
  T("any of those priority 1", rows("mae_meds"),
    ref=[ans(within="@prev", where="priority = 1")]))

S("T14-A010", "follow-up c3a",
  T("list what i put in the car docs folder", rows("crlv", "cnh_doc", "ins_policy"),
    ref=[ans(kind="document", linked_to="$car_docs_f")]),
  T("now only the starred ones", rows("crlv"),
    ref=[ans(within="@prev", where="starred = yes")]),
  T("unstar it", diff(upd("crlv", starred=False)),
    ref=[act("unstar", rows="@prev")]))
