from gold import *
import json

world("T22", "2026-07-13T21:25", "Sven Lindqvist", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


# T22-095, relabelled (Wave 3c, owner ruling): "delete everything from last year" is a bounded
# request, so it is ACTED ON PER KIND, not declined wholesale. One find over every kind that can
# hold a dated row shows what last year holds, then one delete per kind that has rows; kinds with
# no rows (no 2025 task, note or document in this vault) get no act. The rest of the session is
# unchanged.
LAST_YEAR = W(U("year", -1))

S("T22-095", "five turns bulk delete per kind sealed search miss not found create read",
  T("delete everything from last year",
    diff(trash("crayfish_2025"), trash("p_gotcha"), unlink("elias_al", "p_gotcha"), trash("p_wall"), unlink("berlin_al", "p_wall"),
         trash("p_currywurst"), unlink("berlin_al", "p_currywurst"), trash("p_tv"), unlink("berlin_al", "p_tv")),
    ref=[find(kind="event,task,note,document,photo", when=LAST_YEAR),
         act("delete", rows="$crayfish_2025", more=True),
         act("delete", rows="$p_gotcha, $p_wall, $p_currywurst, $p_tv")]),
  T("text the Home wifi password to karin", decline("sealed_egress"),
    ref=[dec("sealed_egress")]),
  T("any task about the forklift battery", decline("not_found"),
    ref=[search("forklift battery", kind="task"), dec("not_found")]),
  T("add Check forklift battery chargers, due friday, warehouse list",
    diff(new("task", name="Check forklift battery chargers", date="2026-07-17"), link("work_l", "new")),
    ref=[act("create", args=lines(kind="task", name="Check forklift battery chargers", date=U("week", 0, weekday=5),
                                  list="$work_l"))]),
  T("what's due friday now", rows("licences", "scanners", "+1"),
    ref=[ans(kind="task", when=W(U("week", 0, weekday=5)))]))
