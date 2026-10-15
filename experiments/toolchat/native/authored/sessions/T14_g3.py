from gold import *
import json

world("T14", "2026-10-24T19:30", "Tomás Ferreira", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


LIVE = 'status = "open"'
LIVE_EV = 'status != "cancelled"'


def next_kleber():
    return find(kind="event", name="DJ set at Bar do Kleber", when=W({"from": U("day", 0)}), order="date asc", limit=1)


def rehearsals():
    return find(kind="event", name="Collective rehearsal", when=W({"from": U("day", 0)}))


S("T14-132", "recovery twice rehearsals then mae list sum dj list min max",
  T("next three rehearsals, i need to tell the collective which ones i'll miss", rows("reh_1028", "reh_1104", "reh_1111", order=True),
    ref=[rehearsals(), bad(rehearsals()), bad(rehearsals()),
         ans(within="@prev", order="date asc", limit=3)]),
  T("how long is everything on mae's list put togther, i want to do it all sunday at mom's", val(235),
    ref=[comp(op="sum", field="effort", kind="task", linked_to="$mae_l", where=LIVE), ans(value="@prev")]),
  T("shortest thing on the dj list, something i can do before i leave", val(15),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$dj_l", where=LIVE)]),
  T("and the longest one, that's the buenos aires set right", val(240),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$dj_l", where=LIVE)]))

S("T14-136", "ask cancel baile never mind then recent contacts limit then longest this week",
  T("cancel the baile", ask("baile_11", "baile_12", "baile_13"),
    ref=[act("cancel", kind="event", name="Baile Torto"),
         askc("baile 11, 12 or 13?", options="$baile_11, $baile_12, $baile_13")]),
  T("no no leave them all, ana paula would kill me if i cancelled any of them", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("who did i talk to most recntly, three people", rows("larissa", "junior", "guga", order=True),
    ref=[ans(kind="person", order="date desc", limit=3)]),
  T("what's the longest thing on my calendar this week that's still on", val(300),
    ref=[ans(op="max", field="duration", kind="event", when=W(U("week", 0)), where=LIVE_EV)]))

S("T14-137", "unbounded notes then ask delete flyer photo never mind then unbounded contacts",
  T("delete every setlist and every note in the vault, i'm starting from zero after tonight everythng goes", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("delete the flyer photo", ask("flyer_12", "flyer_11", "flyer_bsas"),
    ref=[act("delete", kind="photo", name="Flyer"),
         askc("baile 12, baile 11 or buenos aires?", options="$flyer_12, $flyer_11, $flyer_bsas")]),
  T("nvm ana paula wants them for the next one", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("wipe all my contacts, fresh start after tonight", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))

S("T14-138", "latest photos limit then unbounded documents then mae list min max",
  T("three latest photos i took", rows("haircut_p", "football", "rain_car", order=True),
    ref=[ans(kind="photo", order="date desc", limit=3)]),
  T("delete every document i've got, the mei stuff and the contracts too, it's all on the drive now", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("shrtest thing on mae's list, i've got five minutes at the traffic light", val(20),
    ref=[ans(op="min", field="effort", kind="task", linked_to="$mae_l", where=LIVE)]),
  T("and the longest one, the grab rail i bet", val(120),
    ref=[ans(op="max", field="effort", kind="task", linked_to="$mae_l", where=LIVE)]))

S("T14-140", "newest docs limit then unbounded tasks then ask log marcos never mind then carro sum",
  T("two newest docments", rows("fuel_rcpt", "rider", order=True),
    ref=[ans(kind="document", order="date desc", limit=2)]),
  T("get rid of all my tasks, fresh start after the baile tonigt", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("log a call with marcos", ask("marcos_o", "marcos_t"),
    ref=[act("log", kind="person", name="Marcos", args=lines(kind="call")),
         askc("marcos oliveira the dj or marcos tavares the mechanic?", options="$marcos_o, $marcos_t")]),
  T("hold on, let me check which marcos it was before i log anything", decline("never_mind"),
    ref=[dec("never_mind")]),
  T("how much time is my carro list altogether", val(225),
    ref=[ans(op="sum", field="effort", kind="task", linked_to="$carro_l", where=LIVE)]))
