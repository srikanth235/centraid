from gold import *
import json

world("T31", "2026-11-05T20:40", "Tomasz Wisniewski", "train")


def J(expr):
    """a `when` filter as the JSON text the model writes"""
    return json.dumps(expr, separators=(",", ":"))


S("T31-162", "ask-reminder missing content",
  T("set a reminder", ask(),
    ref=[askc("What should I remind you about, and when?")]))

S("T31-163", "ask-rename missing target",
  T("rename it", ask(),
    ref=[askc("Which one should I rename, and to what?")]))

S("T31-164", "ask-add-them missing group",
  T("add them", ask(),
    ref=[askc("Which people, and to which group?")]))

S("T31-165", "decline-unbounded whole calendar",
  T("delete my whole calendar", decline("unbounded_destruction"),
    ref=[dec("unbounded_destruction")]))
