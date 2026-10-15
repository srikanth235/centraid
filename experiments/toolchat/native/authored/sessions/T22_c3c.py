from gold import *
import json

world("T22", "2026-07-13T21:25", "Sven Lindqvist", "train")


def W(expr):
    return json.dumps(expr, separators=(",", ":"))


S("T22-C003", "c3c compound delete restore photos",
  T("delete the rota whiteboard pic and bring back the blurry jetty one",
    diff(trash("p_whiteboard"), restore("p_blurry")),
    ref=[act("delete", kind="photo", name="Rota whiteboard", more=True),
         act("restore", kind="photo", name="Blurry jetty", trashed=True)]))
