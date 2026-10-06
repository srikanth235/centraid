from gold import *
import json

world("T34", "2027-06-20T21:15", "Obinna Okafor", "train")


def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


# ---- container-link-reads -------------------------------------------------------------------------

S("T34-091", "container-link-read list-name-collision parent-narrow within linked_to, then in-progress edit",
  T("what's left for the church", rows("church_hall_3", "tithe_270701", "church_hall_1", "church_hall_2", "church_hall"),
    ref=[ans(kind="task", linked_to="$church_l", where="status = open")]),
  T("which are for the hall dedication", rows("church_hall_3", "church_hall_1", "church_hall_2"),
    ref=[ans(within="@prev", linked_to="$church_hall")]),
  T("mark the plaque as in progress, the supplier's started", diff(upd("church_hall_1", status="in_progress")),
    ref=[act("edit", rows="$church_hall_1", args="status: in_progress")]))

S("T34-092", "container-link-read owner-row count groups-i-am-in within linked_to person",
  T("how many groups am i in", val(15),
    ref=[ans(op="count", kind="group", linked_to="$me")]),
  T("which has my brother chidi in it", rows("family_fund", "mama_care", "london", "wedding"),
    ref=[find(kind="person", name="Chidi", where='role = "brother"'),
         ans(within="@1", linked_to="$chidi_o")]))

S("T34-093", "container-link-read person-appointments name-collision within name",
  T("what's coming up with chidi anyanwu", rows("sd_270621", "shop_anniv", "sd_270705", "sd_270719"),
    ref=[ans(kind="event", linked_to="$chidi_a", when=W({"from": U("day", 0)}))]),
  T("just the deliveries", rows("sd_270621", "sd_270705", "sd_270719"),
    ref=[ans(within="@prev", name="delivery")]))

S("T34-094", "container-link-read notebook body-word-collision within pinned",
  T("what's in my kitchen notebook",
    rows("rec_1", "rec_2", "rec_3", "rec_4", "rec_5", "rec_6", "rec_7", "rec_8"),
    ref=[ans(kind="note", linked_to="$kitchen_nb")]),
  T("which are pinned", rows("rec_1"),
    ref=[ans(within="@prev", where="pinned = yes")]))

S("T34-095", "container-link-read parent-task done-subtasks theme-word-is-list within order",
  T("what did we finish on the house repaint",
    rows("house_paint_1", "house_paint_2", "house_paint_3", "house_paint_4", "house_paint_5"),
    ref=[ans(kind="task", linked_to="$house_paint", where="status = completed")]),
  T("which one was last", rows("house_paint_5"),
    ref=[ans(within="@prev", order="date desc", limit=1)]))

# ---- stray-or-operator-conditions -----------------------------------------------------------------

S("T34-096", "stray-condition photos inert-purpose-clause no-description-on-photos star within",
  T("what pics have we got of mama nnukwu for the bday card",
    rows("ph_mama_a_03", "ph_village25_06", "ph_village25_12", "ph_village25_14", "ph_mama_a_20"),
    ref=[ans(kind="photo", linked_to="$mama_nnukwu")]),
  T("star the praying one, she looks so happy in it", diff(upd("ph_mama_a_03", starred=True)),
    ref=[bad(act("star", kind="photo", where='description contains "praying"', within="@prev")),
         act("star", kind="photo", name="Praying", within="@prev")]))

S("T34-097", "stray-condition person met-contains inert-purpose role-exact log",
  T("who do i know in oshodi, wanna send them the anniversary invite", rows("tunde_k", "chidi_a", "obiagheli"),
    ref=[ans(kind="person", where='met contains "Oshodi"')]),
  T("just the contractor", rows("tunde_k"),
    ref=[ans(within="@prev", where='role = "contractor"')]),
  T("just got off with him about the invite, log it", diff(upd("tunde_k", date=ANY)),
    ref=[act("log", rows="$tunde_k", args="kind: call")]))

S("T34-098", "stray-condition events description-contains date inert-clause cancel",
  T("which of aunty uche's calls this year have mama nnukwu on, wanna tell her", rows("au_270626", "au_270703"),
    ref=[ans(kind="event", name="Call Aunty Uche", where='description contains "Mama Nnukwu"', when=W(U("year", 0)))]),
  T("cancel the first one, she's travelling", diff(upd("au_270626", status="cancelled")),
    ref=[act("cancel", rows="$au_270626")]))

S("T34-099", "stray-condition by-name-write inert-purpose-clause complete star, no-body-on-notebooks",
  T("tick off pay staff salaries, chinwe is waiting for it",
    diff(upd("sal_270625", status="completed", completed=ANY)),
    ref=[act("complete", kind="task", name="Pay staff salaries", where="status = open")]),
  T("star ifeanyi's 2026 fees receipt, need it for the visa form", diff(upd("doc_48", starred=True)),
    ref=[act("star", kind="document", name="fees receipt Ifeanyi 2026")]),
  T("which notebook has the egusi recipe", rows("kitchen_nb"),
    ref=[bad(ans(kind="notebook", where='body contains "egusi"')),
         opn("$rec_2"), ans(rows="$kitchen_nb")]))

S("T34-100", "stray-condition role-contains-vs-exact within met inert-purpose within linked_to group-decoy",
  T("who are my drivers",
    rows("damilola_oyelaran", "emmanuel_edet", "ifunanya_ogundipe", "kingsley_chukwu", "musa", "somto_okoro", "temitope_opara",
         "ugochukwu_okoro"),
    ref=[ans(kind="person", where='role contains "driver"')]),
  T("which of them are at the shop, for the christmas bonus",
    rows("damilola_oyelaran", "kingsley_chukwu", "musa", "temitope_opara"),
    ref=[ans(within="@prev", where='met contains "Okafor and Sons"')]),
  T("any of them in the staff group", rows("musa"),
    ref=[ans(within="@prev", linked_to="$staff")]))

# ---- date-window-reads ----------------------------------------------------------------------------

S("T34-101", "date-window before closed-window-from-today future past-tense open-start",
  T("what's on before the anniversary", rows("ss_270620", "sd_270621", "bs_270623", "st_270625", "au_270626", "ss_270627"),
    ref=[ans(kind="event", when=W(span(U("day", 0), D("2027-07-02"))))]),
  T("which sunday services were called off before the london trip",
    rows("ss_240107", "ss_240128", "ss_240317", "ss_240818", "ss_250126"),
    ref=[ans(kind="event", name="Sunday service", where="status = cancelled", when=W({"to": D("2026-07-30")}))]))

S("T34-102", "date-window named-month whole-month past-perfect-count-to-today named-month-future",
  T("how many bible studies did we have in march", val(2),
    ref=[ans(op="count", kind="event", name="Bible study", when=W(U("month", 0, name=3)))]),
  T("and how many had we had by now this year", val(8),
    ref=[ans(op="count", kind="event", name="Bible study", when=W(span(D("2027-01-01"), U("day", 0))))]),
  T("any bible studies still on in july", rows("bs_270707", "bs_270721"),
    ref=[ans(kind="event", name="Bible study", where="status != cancelled", when=W(U("month", 0, name=7)))]))

S("T34-103", "date-window X-or-older ends-at-end year-arithmetic two-years-ago",
  T("any generator services from 2024 or older",
    rows("gen_230606", "gen_230905", "gen_231205", "gen_240305", "gen_240604", "gen_240903", "gen_241203"),
    ref=[ans(kind="event", name="Generator service", when=W({"to": D("2024-12-31")}))]),
  T("and the ones two years ago", rows("gen_250304", "gen_250603", "gen_250909", "gen_251209"),
    ref=[ans(kind="event", name="Generator service", when=W(U("year", -2)))]))

S("T34-104", "date-window from-X-on open-span-future ordinal-past-tense from-X-on-count-to-today",
  T("which sunday services are still on from the 11th of july on", rows("ss_270711", "ss_270718", "ss_270725"),
    ref=[ans(kind="event", name="Sunday service", where="status != cancelled", when=W({"from": D("2027-07-11")}))]),
  T("was there a bible study on the 9th", rows("bs_270609"),
    ref=[ans(kind="event", name="Bible study", when=W(D("2027-06-09")))]),
  T("how many bible studies did we have from may on", val(3),
    ref=[ans(op="count", kind="event", name="Bible study", when=W(span(D("2027-05-01"), U("day", 0))))]))

S("T34-105", "date-window duration-longer-than where-not-when refused-unit-repair time-of-day-pick-no-when",
  T("which events last year ran longer than four hours",
    rows("daddy_bday_2026", "easter_2026", "enugu_26", "london_26", "harvest_2026", "chidi_trad", "dealers", "chidi_wedding",
         "village_26"),
    ref=[bad(ans(kind="event", where="duration > 4 hours", when=W(U("year", -1)))),
         ans(kind="event", where="duration > 240", when=W(U("year", -1)))]),
  T("which started after noon", rows("daddy_bday_2026", "london_26"),
    ref=[ans(rows="$daddy_bday_2026, $london_26")]))

# ---- mixed ----------------------------------------------------------------------------------------

S("T34-106", "mixed rename quoted-span-in-sentence notebook count",
  T("rename the kitchen notebook to 'Mummy Grace Recipes', it's mostly her stuff",
    diff(upd("kitchen_nb", name="Mummy Grace Recipes")),
    ref=[act("edit", kind="notebook", name="Kitchen", args="name: Mummy Grace Recipes")]),
  T("how many notes are in it", val(8),
    ref=[ans(op="count", kind="note", linked_to="$kitchen_nb")]))

S("T34-107", "mixed note body-append open edit pin",
  T("add 'oil change due in august' to the generator oil schedule note",
    diff(upd("loose_6", body=has("Engr Segun comes in March", "oil change due in august"))),
    ref=[opn("$loose_6"),
         act("edit", rows="$loose_6",
             args=lines(body="change oil every 200 hours, filters every 400, Engr Segun comes in March, June, September and December. oil change due in august"))]),
  T("and pin it", diff(upd("loose_6", pinned=True)),
    ref=[act("edit", rows="$loose_6", args="pinned: yes")]))

S("T34-108", "mixed settle_up amount person group search",
  T("my sister ngozi gave me 100k toward the family fund, settle her up",
    diff(upd("ngozi_o", balance=ANY), settle=[("Ngozi Okafor-Bello", "100000.00")]),
    ref=[search("ngozi", kind="person"),
         act("settle_up", rows="$ngozi_o", args=lines(group="$family_fund", amount="100k"))]))

S("T34-109", "mixed kind-word-decides documents photos tasks same-topic",
  T("any documents on the generator", rows("doc_12", "doc_24", "doc_39", "doc_51"),
    ref=[ans(kind="document", name="generator")]),
  T("and photos", rows("ph_loose_253", "ph_loose_283", "ph_loose_298"),
    ref=[ans(kind="photo", name="generator")]),
  T("any open tasks about it", rows("genman_270703", "solar_7"),
    ref=[ans(kind="task", name="generator", where="status = open")]))

S("T34-110", "mixed reschedule weekday-and-clock-in-one-phrase two-writes",
  T("move wednesday's bible study to thursday at 7", diff(upd("bs_270623", date="2027-06-24T19:00")),
    ref=[act("reschedule", kind="event", name="Bible study", when=W(U("week", 1, weekday=3)),
             args=lines(to=U("week", 1, weekday=4, time="19:00")))]),
  T("and the stocktake on friday to saturday at 10", diff(upd("st_270625", date="2027-06-26T10:00")),
    ref=[act("reschedule", kind="event", name="stocktake", when=W(U("week", 1, weekday=5)),
             args=lines(to=U("week", 1, weekday=6, time="10:00")))]))
