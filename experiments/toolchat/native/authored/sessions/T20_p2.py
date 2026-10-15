from gold import *
import json
def W(expr):
    return json.dumps(expr, separators=(",", ":"))
NOW = W({"from": U("day", 0)})
TOMORROW = W({"from": U("day", 1)})
THIS_WEEK = W(U("week", 0))
NEXT_MONTH = W(U("month", 1))
def W(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))
OPEN = 'status = "open"'
def J(d):
    return json.dumps(d, separators=(",", ":"))


S("T20-116-P", "contrast log person by role then already star para",
  T("i called the head chef, log it", diff(upd("lorenzo_g", date=ANY)),
    ref=[act("log", kind="person", where='role contains "head chef"', args=lines(kind="call"))]),
  T("club captain dropped by the restaurant, log a visit", diff(upd("marco_e", date=ANY)),
    ref=[act("log", kind="person", where='role contains "captain"', args=lines(kind="visit"))]),
  T("giulia gets a star", diff(already=["giulia"]),
    ref=[act("star", kind="person", name="Giulia Conti"), ans(rows="$giulia")]),
  T("club treasurer does the accounts, so she gets a star", diff(upd("bea", starred=True)),
    ref=[act("star", kind="person", where='role contains "treasurer"')]))

S("T20-121-P", "wifi bare read then reveal home wifi para",
  T("home wifi password, where's it kept", rows("wifi_home"),
    ref=[ans(kind="locker item", name="home wifi")]),
  T("guests need the wifi, give me the home wifi password", diff(reveal=[("wifi_home", "oltrarno-2024")]),
    ref=[act("reveal", kind="locker item", name="Home wifi Via Romana", args=lines(field="password"))]))

S("T20-140-P", "latest documents then unbounded typo then ask delete tasting notes never mind then sum tasks para",
  T("latest two documents of mine", rows("scan_2", "scan_1", order=True),
    ref=[ans(kind="document", order="date desc", limit=2)]),
  T("erase my entrie vault", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]),
  T("tasting notes, get rid of them", ask("tasting_nb", "tasting25_nb"),
    ref=[act("delete", kind="notebook", name="Tasting notes"),
         askc("the tasting notes notebook or the 2025 one?", options="$tasting_nb, $tasting25_nb")]),
  T("stop, nothing gets deleted, i study from both the 2025 notes and this year's",
    decline("never_mind"),
    ref=[dec("never_mind")]),
  T("total minutes of tasks due on the fith of june, wich list doesnt matter", val(150),
    ref=[ans(op="sum", field="effort", kind="task", when=W(D("2026-06-05")), where='status = "open"')]))
