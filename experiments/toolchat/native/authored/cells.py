"""The scenario-cell universe (tables A-H), and its rotation over worlds.

    python3 authored/cells.py                      # cell counts per table, reachable / unreachable
    python3 authored/cells.py --unreachable        # ... plus every unreachable cell and its reason
    python3 authored/cells.py --sheet 0 --of 28    # the markdown sheet of the cells world 0 owns

The tables (BRIEF.md "Coverage" gives authors the same list):
  A  act: verb x kind x selector                  B  where: field x operator x value form
  C  dates: kind x date shape                     D  tool outcome: tool x outcome
  E  runtime behaviour: behaviour x kind          F  conversation structure
  G  phrasing: verb x kind and tool x outcome, by mood and by verbatim naming
  H  message-side decisions: what the MESSAGE says that the reference call does not show (idiom x verb,
     inert clause, same-word lookalike, stop signal, role noun, date phrase, container word). Tables A-G
     describe the reference CALL; a cell there can be full while the message-side distinction is absent
     (every "put it back" following a delete teaches idiom -> restore and never add_to). H cells are detected
     from (message, reference calls, gold, world) by authored/coverage.py `h_turn_uses`; the phrase lists
     that detect them are the H_* constants right below (readable and editable in one place).

The universe is derived from a fresh `nativetools export` (kind_card.txt: kinds, fields, enums,
verbs; tools.json and prompt.sig.txt: tools and their params; metadata.json: decline reasons, compute ops,
all verbs, and every where field with its operators) plus the runtime rules in BRIEF.md "Runtime rules".
A cell whose reachability is uncertain is kept reachable: the report over-states gaps rather than hiding one.

Cells are tuples of strings; the first element is always the table letter, so a cell is
self-describing in json and markdown (`cell_str`).
"""
from __future__ import annotations

import argparse
import functools
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
NT = os.environ.get("NATIVETOOLS", str(NATIVE.parents[2] / "target" / "debug" / "nativetools"))

# THE DATE-SHAPE UNIVERSE: every point shape, and every span whose ends are a date, a relative
# period, a weekday or a named month (either end may be open). The runtime takes more, but these
# are the shapes people's requests map to. (date+time as a span end is observed in authored
# sessions, e.g. an event's own start..end, so it is part of the universe.)
POINTS = ["date", "date+time", "rel+unit", "rel+unit+weekday", "rel+time+unit+weekday", "rel+time+unit",
          "name+rel+unit", "anchor+rel+unit", "anchor+rel+time+unit"]
ENDS = ["date", "date+time", "rel+unit", "rel+unit+weekday", "name+rel+unit"]
SPANS = [f"from..to[{a} | {b}]" for a in ENDS + ["?"] for b in ENDS + ["?"] if (a, b) != ("?", "?")]

SELECTORS = ["named", "where", "prev", "new", "multi"]
WHERE_OPS = ["=", "!=", "<", "<=", ">", ">=", "contains", "in", "is empty", "is set"]
VALUE_FORMS = ["literal", "reldate", "enum", "unit", "linkcount"]
# the two unit forms the runtime refuses on `where` (BRIEF: "1 hour" is refused): repair cells
REFUSED_UNITS = ["refused:1 hour", "refused:2 weeks"]
# undo is judged per class of the write it undoes
VERB_CLASS = {"create": "create", "delete": "delete", "restore": "restore",
              "edit": "field", "reschedule": "field", "complete": "field", "reopen": "field",
              "cancel": "field", "star": "field", "unstar": "field",
              "add_to": "link", "remove_from": "link",
              "log": "ledger", "settle_up": "ledger", "settle_debt": "ledger", "reveal": "read"}
BEHAVIOURS = ["ambiguous", "empty result", "trashed row", "restore window", "refused delete",
              "knock-on diff", "linked_to all", "photo undo", "event overlap"]
PHRASINGS = [(m, v) for m in ("command", "question", "indirect") for v in ("verbatim", "non-verbatim")]


# =============================================================================================
# TABLE H: MESSAGE-SIDE DECISIONS. Every phrase list the H detectors (coverage.py `h_turn_uses`) use
# lives in this block. Regexes run on the lower-cased CLEAN message (the noise-free text when a turn has
# one) with word boundaries; a cell is `("H", <sub-table>, <key>..., <outcome>)`.
# =============================================================================================

# H1 idiom x verb. family -> (message regex, the reference sides that must each exist). A side is the
# act verb ("restore"), "create:<kind>" for a create of that kind, "read" for any read tool (answer, find,
# search, open), or "decline:<reason>" / "ask". The point of the table is that BOTH sides of an idiom
# are present: "put it back" after a delete is restore, "put the photo back in the album" is add_to.
_BACK = r"(?:it|that|this|them|him|her|(?:the|my|his|her|their|our) [^,.;!?]{1,40}?)"
_DAY = (r"(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?|today|tonight|tomorrow|next week|"
        r"\d{1,2}(?:st|nd|rd|th)|\d{1,2}(?::\d\d)? ?(?:am|pm)|noon|midday|this (?:morning|afternoon|evening)")
H1_IDIOMS = {
    "put-it-back": (rf"\b(?:put|set|stick|pop|move) {_BACK} back\b", ["restore", "add_to", "reschedule", "undo"]),
    "bring-it-back": (r"\b(?:bring|get|fetch|dig) (?:it|that|this|them|him|her) back\b", ["restore", "add_to", "undo"]),
    "mark-in-progress": (r"\bin[- ]progress\b|\bstarted (?:on |working on )?(?:it|that|this|the)\b|\bworking on (?:it|that|this)\b|\bunderway\b",
                         ["edit", "read"]),
    "make-it-clock": (r"\bmake (?:it|that) (?:at |for |by )?(?:\d{1,2}(?:[:.]\d\d)? ?(?:am|pm)?|noon|midday|midnight|half \w+|quarter \w+)\b"
                      r"(?! ?(?:min|hour|hr|day|week|%|sack|k\b))", ["reschedule", "create:event", "edit"]),
    "make-it-duration": (r"\bmake (?:it|that) (?:\d+|an?|one|two|three|half an?) ?(?:mins?|minutes?|hours?|hrs?|days?)\b|"
                         r"\b(?:make|set) it (?:an? )?(?:hour|half hour)\b", ["edit", "reschedule", "create:event"]),
    "block-time-for": (r"\bblock (?:out |off |up )?(?:\w+ ){0,4}?(?:for|out)\b|\b(?:set aside|carve out|clear|hold|reserve|free up|keep) "
                       r"(?:\w+ ){0,3}?(?:time|slot|hours?|afternoon|morning|evening|day|mon|tues?|wed|thu|fri|sat|sun)\w*(?: \w+){0,3}? for\b",
                       ["create:event", "read"]),
    "jot-down-note-that": (r"\bjot\b|\b(?:write|put|note|type|scribble) (?:it |that |this |these |them )?down\b|"
                           r"\bnote (?:that|this|to self)\b(?! (?:mentions|says|has|is|about|with|from))|\bmake a note\b|\bremember that\b",
                           ["create:note", "edit", "read"]),
    "no-wait-day": (rf"\b(?:no,? ?wait|wait,? no|actually|scratch that|sorry,?|make that|i mean|hold on|on second thought)\b.{{0,40}}\b(?:{_DAY})\b",
                    ["reschedule", "undo", "decline:never_mind"]),
    "add-one-another": (r"\b(?:add|book|set up|make|get|create|start|log|put in|schedule) (?:me )?(?:one|another|a second|one more|a new one)\b|"
                        r"\banother one\b|\bone more\b|\ba second one\b", ["create", "add_to", "read"]),
    "log-a-call-word": (r"\blog (?:(?:a|an|that|the|this) )?(?:call|visit|message|text|coffee|chat|meeting|catch ?up|it|that|this|one)\b|"
                        r"\bmake a note of a call\b",
                        ["log", "ask"]),
    "contact-happened": (r"\b(?:rang|phoned|called me|texted|messaged|whatsapped|popped (?:round|by|in)|dropped (?:round|by)|"
                         r"had (?:a )?(?:tea|coffee|lunch|dinner|chat|call|catch[- ]?up)|got off the phone|just spoke|(?:spoke|spoken) (?:to|with)|"
                         r"talked (?:to|with)|met (?:up )?with)\b", ["log", "read", "create:event"]),
    "call-someone-request": (r"^(?:and |also |then |please |can you )?(?:remind me to )?(?:call(?! (?:it|them|that|this|him|her)\b)|ring|phone|catch up with|speak to|talk to)\b",
                             ["create:event", "create:task"]),
}

# H2 inert clause: a trailing purpose / reason / aside after the request. class -> regex that STARTS the clause.
# The clause is inert when none of its content words reaches the reference call (args text or the names of
# the rows it touches); carried when one does (a real filter or a name).
H2_CLAUSES = {
    "purpose": r"\bfor (?:the|my|our|his|her|their|a|an)\b|\bso (?:that |i |we |he |she |they |it |you )|\bto pay for\b|\bto cover\b|"
               r"\bin order to\b|\bin case\b|\bahead of\b",
    "reason": r"\bbecause\b|\bcos\b|\bcoz\b|\bcuz\b|\bas (?:he|she|they|it|we|i)\b|\bsince (?:he|she|they|it|we|i)\b|\bseeing as\b",
    "aside": r",\s*(?:he|she|they|we|i|it|its|it's|my|his|her|their|the|there)\b",
}
# words that carry a date or an amount of time, never a condition by themselves, and words too weak to
# tell a clause from its request
H2_DATE_WORDS = set("""today tomorrow tonight yesterday week weeks weekend month months year years morning afternoon evening night
    monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september
    october november december hour hours minute minutes day days time soon later now next last this that
    first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth
    seventeenth eighteenth nineteenth twentieth thirtieth midday noon midnight lunchtime""".split())
H_STOP = set("""the and for with from your you are was were has have had not but about into over under then than that this these those them
    they their there what when where which who whom how why can could would should will shall may might must just also only very much more
    some any all each every both either neither does did doing done been being its it's his her him she mine our ours out off too
    again once here after before while until because since while should""".split())

# H3 same-word lookalike: words too generic to make two rows lookalikes (kind nouns, small connectives)
H3_GENERIC = set("""list lists note notes task tasks event events album albums photo photos folder folders document documents
    group groups person people debt debts locker item items login logins the and for with from new old plan plans trip trips day days week
    weeks home work general misc other stuff things thing""".split())
# the lookalike carries every name word the message says of the target (so the words alone do not pick the row);
# extent: the message says only part of the target's name (partial) or all of it (whole, e.g. target "Kids",
# lookalike "Kids pool party"); form: how the reference call picks the row (a qualifier is where / when / linked_to)
H3_FORMS = ["name", "name+qualifier", "#n", "where", "ask"]
H3_EXTENTS = ["partial", "whole"]
H3_RELATIONS = ["same-kind", "other-kind", "trashed"]

# H4 stop signal x outcome
H4_RETRACT = (r"\b(?:never ?mind|nvm|forget (?:it|that|about it)|scratch that|ignore (?:that|me)|disregard|cancel that|"
              r"actually,? (?:no|nah|don'?t|leave|keep|forget)|no,? ?wait|hold on|wait,? no|changed my mind|on second thought|"
              r"leave (?:it|them|both|that)|keep (?:it|them|both|all)(?: of them)?|nah)\b")
H4_ALL = r"\b(?:all|every\w*|the rest|the lot|whatever|anything)\b"  # the quantifier of an all-but-one message ...
H4_EXCEPT = r"\b(?:except|but|apart from|other than|bar|keep (?:just|only)|leave (?:just|only))\b"  # ... and its exception
H4_DESTROY = r"\b(?:delete|erase|wipe|clear|remove|get rid of|bin|trash|purge|throw away|dump)\b"
# a message with none of these (and a statement shape) is an FYI: it states a fact and asks for nothing
H4_COMMAND = (r"\b(?:add|log|star|unstar|move|push|shove|delete|remove|cancel|complete|tick|mark|set|change|make|create|show|find|tell|"
              r"give|remind|restore|bring|undo|settle|put|rename|edit|update|bump|clear|read|reveal|get|jot|reopen|reschedule|"
              r"what|when|who|how|where|which|why|is|are|do|does|did|can|could|please|any|anything|anyone|erase|wipe|search|look|check|"
              r"display|print|export|need|want|wanna)\b")
_FYI_PRED = (r"paid|got|went|saw|gave|took|left|sent|made|came|met|had|has|have|is|are|was|were|will|'ll|owe|owes|wants?|needs?|"
             r"says?|said|told|rang|called|texted|bought|sold|lost|forgot|found|broke|moved|changed|can't|won't|didn't|isn't|doesn't|don't|"
             r"know|think|reckon|guess|figure")
H4_FYI = (r"^(?:fyi,? |heads up,? |just so you know,? |btw,? |by the way,? |so |oh,? |ok so |well,? )?(?!whats?\b|what's\b|who|how|when|where|which|why)"
          r"(?:(?:i|we|he|she|they|it|(?:my|the|our|his|her|their) \w+) (?:just |also |already |still |now |finally |both |all |really )?"
          rf"(?:\w+ed|{_FYI_PRED})|\w+(?:'s)? (?:just |also |already |still |now |finally |both |all |really )?(?:{_FYI_PRED}))\b")  # subject + predicate: a fact, no request
_POS = ("start", "middle", "end")
H4_SIGNALS = {
    "not_found": ["search-miss", "find-miss", "read-by-name-miss", "write-by-name-miss", "with-near-hit-row", "no-near-hit-row"],
    # where in the message the retraction sits x what the reference did (a retraction that is followed by a new
    # request is act, a retraction of the last write is undo)
    "retraction": [f"{p}>{o}" for o in ("decline:never_mind", "undo", "act") for p in _POS] + ["any>decline:not_found"],
    "fyi-only": ["act", "ask", "decline", "read"],
    "all-but-one": ["decline:unbounded_destruction", "delete-by-find", "act-other", "read"],
    "off-topic": ["first-turn", "later-turn", "vault-word-decoy"],
}

# H5 role-noun lookup: kinship and trade nouns (world roles of the people rows add a third class, "world-role")
H5_KIN = set("""mum mom mam mother mummy dad father daddy papa sister brother aunt auntie aunty uncle cousin nan nana gran granny grandma
    grandmother grandpa grandfather grandson granddaughter wife husband partner son daughter niece nephew in-law mother-in-law
    father-in-law sister-in-law brother-in-law stepmum stepdad godmother godfather ammi abbu""".split())
H5_TRADE = set("""dentist doctor gp vet plumber electrician landlord landlady accountant mechanic boss manager teacher tutor barber hairdresser
    pharmacist solicitor lawyer builder decorator joiner carpenter roofer cleaner nanny childminder optician physio therapist
    midwife surgeon consultant foreman supplier contractor agent banker broker""".split())
H5_FORMS = ["role-filter", "name-or-key", "pick", "whole-set"]
H5_CLASSES = ["kinship", "trade", "world-role"]

# H6 date phrase x span form x tense. phrase -> (regex, the forms the reference should take). Forms of a `when`:
# closed (from and to), open-to, open-from, point; of a duration condition: where-duration (events) / where-effort (tasks).
_DATEISH = (r"(?:\d|(?:mon|tues?|wed|thu|fri|sat|sun)\w*|jan\w*|feb\w*|mar\w*|apr\w*|may\b|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|"
            r"dec\w*|tomorrow|tonight|today|noon|midnight|midday|end\b|weekend|week\b|month\b|year\b|christmas|easter|new year|"
            r"(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|twentieth)\b)")
_DET = r"(?:the |next |this |end of |the end of )?"
H6_PHRASES = {
    "before-X": (rf"\bbefore {_DET}{_DATEISH}", ["closed", "open-to"]),
    "by-X": (rf"\bby {_DET}{_DATEISH}", ["closed", "open-to"]),
    "until-X": (rf"\b(?:until|till|up to|through|thru|to the end of) {_DET}{_DATEISH}", ["open-to", "closed"]),
    "from-X-on": (r"\bonwards?\b|\bfrom [\w' ]{2,25} on\b(?! (?:the|my|a|an|our|his|her)\b)", ["open-from", "closed"]),
    "named-month": (r"\b(?:in|during|of|for|every|all of|last|next|this) (?:january|february|march|april|may|june|july|august|september|"
                    r"october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b(?! ?\d)", ["closed", "point"]),
    "or-older": (r"\b(?:or|and) (?:older|earlier|before|prior)\b", ["open-to", "closed"]),
    "last-year": (r"\blast year\b", ["point", "closed"]),
    "N-years-ago": (r"\b(?:two|three|four|five|\d+) years? ago\b|\byears? back\b|\byear before last\b|\ban? (?:\w+ )?year ago\b", ["point", "closed"]),
    "longer-than-N-hours": (r"\b(?:longer|more|over|under|shorter|less|greater|at least|at most|exceeding) (?:than )?(?:an? |one |two |three |four |"
                            r"half an? |\d+(?:\.\d+)? ?)(?:hours?|hrs?|minutes?|mins?)\b|\b(?:\d+|two|three|an) hours? or (?:more|less|longer|shorter)\b|"
                            r"\bover an hour\b", ["where-duration", "where-effort"]),
}
H6_PAST = (r"\b(?:did|was|were|had|been|last|ago|went|spoke|paid|saw|earlier|previous|used to|since|already|ever|"
           r"have i (?:had|done|been|spoken|seen|heard|talked|met)|how many (?:\w+ ){0,3}(?:did|were))\b")
H6_FUTURE = (r"\b(?:will|going to|upcoming|next|coming|due|have i got|do i have|am i|are we|on the calendar|scheduled|remaining|left|"
             r"still|what'?s on|what is on|coming up)\b")
H6_TENSES = ["past", "future"]
H6_PAST_ONLY = ("last-year", "N-years-ago")  # a year ago is only ever read backwards

# H7 container word collision: container kind -> the field of a member row that names it
H7_CONTAINERS = {"list": ("task", "list"), "notebook": ("note", "notebook"), "folder": ("document", "folder"),
                 "album": ("photo", "albums"), "group": ("expense", "group")}
H7_FORMS = ["linked_to", "name-filter"]
# how the message names the container: its kind word ("the kitchen list"), its full name, or only a theme word of its name
H7_NAMING = ["full-name", "kind-word", "theme-word"]
# the kind word of each container kind
H7_KIND_WORD = {"list": r"\blist\b", "notebook": r"\b(?:notebook|notes)\b", "folder": r"\bfolder\b", "album": r"\balbum\b",
                "group": r"\b(?:group|split|expenses|trip|fund|pool)\b"}


def _table_h():
    reach = []
    for fam, (_rx, sides) in H1_IDIOMS.items():
        reach += [("H", "H1 idiom", fam, side) for side in sides]
    for cls in H2_CLAUSES:
        for rw in ("read", "write"):
            reach += [("H", "H2 inert clause", cls, rw, st) for st in ("inert", "carried")]
    # an ask only ever lists live rows, so a trashed lookalike has no `ask` cell
    reach += [("H", "H3 lookalike", rel, ext, form) for rel in H3_RELATIONS for ext in H3_EXTENTS for form in H3_FORMS
              if not (rel == "trashed" and form == "ask")]
    for sig, outs in H4_SIGNALS.items():
        reach += [("H", "H4 stop signal", sig, o) for o in outs]
    reach += [("H", "H5 role noun", cls, form) for cls in H5_CLASSES for form in H5_FORMS]
    for ph, (_rx, forms) in H6_PHRASES.items():
        reach += [("H", "H6 date phrase", ph, f, tense) for f in forms for tense in (["past"] if ph in H6_PAST_ONLY else H6_TENSES)]
    reach += [("H", "H7 container word", kind, nm, form) for kind in H7_CONTAINERS for nm in H7_NAMING for form in H7_FORMS]
    return reach, []


def universe_h() -> dict:
    """Table H alone: static, needs no `nativetools export`."""
    r, u = _table_h()
    return {"reachable": r, "unreachable": u}


# --- the export -------------------------------------------------------------------------------


# What the `where` mini-language takes of a field, by the type metadata.json gives it (the runtime's own table, crates/nativetools/src/whr.rs):
# number, money: the six comparisons on a number; text: = and != on a literal, contains, in; enum: = and != on one of its values, in;
# bool: = and != on yes|no (a value form of "enum"); date: no condition. Every field but a bool also takes `is empty` / `is set`.
# A link takes a count comparison: `<linked kind> count`.
_NUM = {o: "number" for o in WHERE_OPS[:6]}
_TEXT = {"=": "literal", "!=": "literal", "contains": "literal", "in": "literal"}
_ENUM = {"=": "enum", "!=": "enum", "in": "enum"}
_BOOL = {"=": "enum", "!=": "enum"}
_FIELD_OPS = {"number": _NUM, "money": _NUM, "text": _TEXT, "enum": _ENUM, "bool": _BOOL, "date": {}}


def _field_ops(field: dict) -> dict:
    ops = dict(_FIELD_OPS[field["type"]])
    if field["type"] != "bool":
        ops["is empty"] = ops["is set"] = "—"
    return ops


def _tool_params(tools: list[dict], sig: str, selector: list[str]) -> dict[str, list[str]]:
    """tool -> its parameter names. tools.json lists a tool's properties alphabetically, so it says WHICH names; the order is the
    runtime's: the parameters the tool's signature line in prompt.sig.txt lists (`act(verb: ..., rows? | selector, args?, more?)`; `selector` stands
    for the selector parameters, which it does not spell out), then the selector parameters in `metadata.json` order."""
    lines = sig.split("<tools>\n", 1)[1].split("</tools>", 1)[0].splitlines()
    listed = {}
    for line in lines:
        fn = json.loads(line)["function"]
        inner = re.match(r"\w+\((.*?)\) — ", fn["description"]).group(1)
        listed[fn["name"]] = [n for p in inner.split(", ") if (n := re.match(r"\w+", p).group()) != "selector"]
    out = {}
    for t in tools:
        fn = t["function"]
        have = set(fn["parameters"]["properties"])
        names = listed[fn["name"]] + [p for p in selector if p in have and p not in listed[fn["name"]]]
        if set(names) != have:
            raise ValueError("tools.json and prompt.sig.txt disagree on the parameters of %s: %s" % (fn["name"], sorted(set(names) ^ have)))
        out[fn["name"]] = names
    return out


@functools.lru_cache(maxsize=1)
def export(path: str | None = None) -> dict:
    """Read a `nativetools export` (a fresh one unless `path` names an existing directory)."""
    d = path or tempfile.mkdtemp(prefix="cells-export-")
    if not path:
        subprocess.run([NT, "export", d], check=True, capture_output=True)
    meta = json.loads(Path(d, "metadata.json").read_text())
    card = Path(d, "kind_card.txt").read_text()
    tool_defs = {t["function"]["name"]: t for t in json.loads(Path(d, "tools.json").read_text())}
    tools = _tool_params([tool_defs[n] for n in meta["tools"]], Path(d, "prompt.sig.txt").read_text(), meta["selector_params"])
    verbs, fields, enums, dated, units = {}, {}, {}, set(), {}
    for line in card.splitlines():
        m = re.match(r"^([a-z ]+): (.*)$", line)
        if not m:
            continue
        kind, rest = m.group(1), m.group(2)
        vm = re.search(r"verbs: ([a-z_ ]+)", rest)
        verbs[kind] = vm.group(1).split() if vm else []
        head = rest.split(" · ")[0]
        fields[kind] = [f.split(" (")[0].strip() for f in re.split(r", (?![^()]*\))", head)]
        for f, u in re.findall(r"(\w+) \((days|min|[A-Z]{3})\)", head):
            units[f"{kind}.{f}"] = u
        if "date" in fields[kind]:
            dated.add(kind)
        for f, vals in re.findall(r"(\w+) \(([a-z_]+(?:\|[a-z_]+)+)\)", head):
            enums[f"{kind}.{f}"] = vals.split("|")
    # where: per kind, per field, the operators and value types the language admits (a kind with no field and no link has none)
    where = {}
    for k in meta["kinds"]:
        per = where.setdefault(k["name"], {})
        for f in k["fields"]:
            per[f["name"]] = _field_ops(f)
        for link in k["links"]:
            per[f"{link['kind']} count"] = {o: "linkcount" for o in WHERE_OPS[:6]}
    return {"tools": tools, "verbs": verbs, "fields": fields, "enums": enums, "dated": dated,
            "where": where, "units": units, "reasons": meta["decline_reasons"], "ops": meta["ops"],
            "all_verbs": [v["name"] for v in meta["verbs"]], "kinds": [k["name"] for k in meta["kinds"]]}


# --- the universe -----------------------------------------------------------------------------


def _table_a(x):
    reach, unr = [], []
    for kind in x["kinds"]:
        for verb in x["all_verbs"]:
            if verb == "undo":
                continue
            if verb not in x["verbs"].get(kind, []):
                unr.append((("A", verb, kind, "*"), f"kind_card: {kind} does not take {verb}"))
                continue
            if verb == "create":
                reach.append(("A", verb, kind, "—"))
                continue
            for sel in SELECTORS:
                cell = ("A", verb, kind, sel)
                if sel == "new" and "create" not in x["verbs"].get(kind, []):
                    unr.append((cell, f"no verb creates a {kind}, so no $new {kind} exists"))
                elif sel == "new" and verb == "restore":
                    # possible only as create -> delete -> restore in one session: odd but legal
                    reach.append(cell)
                else:
                    reach.append(cell)
    reach.append(("A", "undo", "any", "—"))
    return reach, unr


def _table_b(x):
    reach, unr = [], [(("B", "*", "*", "reldate"), "where has no date comparison; dates go in `when` (table C)")]
    for kind, per in x["where"].items():
        for f, ops in per.items():
            key = f"{kind}.{f}"
            forms_seen = set()
            for op in WHERE_OPS:
                if op not in ops:
                    unr.append((("B", key, op, "*"), f"where: {f} on {kind} has no `{op}`"))
                    continue
                t = ops[op]
                if t == "—":
                    reach.append(("B", key, op, "—"))
                    continue
                if t == "number":
                    forms = ["literal", "unit"] if key in x["units"] else ["literal"]
                else:
                    forms = {"linkcount": ["linkcount"], "enum": ["enum"],
                             "literal": ["enum"] if key in x["enums"] else ["literal"]}[t]
                forms_seen |= set(forms)
                reach += [("B", key, op, vf) for vf in forms]
            for vf in VALUE_FORMS:
                if vf != "reldate" and vf not in forms_seen and forms_seen:
                    why = ("has no unit in kind_card" if vf == "unit" and "literal" in forms_seen
                           else f"takes {'/'.join(sorted(forms_seen))} values only")
                    unr.append((("B", key, "*", vf), f"{f} on {kind} {why}"))
    for r in REFUSED_UNITS:
        reach.append(("B", "*number*", "cmp", r))
    return reach, unr


def _table_c(x):
    reach, unr = [], []
    for kind in x["kinds"]:
        if kind not in x["dated"]:
            unr.append((("C", kind, "*"), f"kind_card: {kind} has no date field"))
            continue
        for shape in POINTS + SPANS:
            reach.append(("C", kind, shape))
    return reach, unr


def _table_d(x):
    reach, unr = [], []
    for o in ("rows", "value", "empty"):
        reach.append(("D", "answer", o))
    for o in ("hit", "miss", "ambiguous"):  # find ambiguous: uncertain, kept reachable
        reach.append(("D", "find", o))
    for o in ("hit", "miss"):
        reach.append(("D", "search", o))
    reach.append(("D", "open", "row"))
    for o in ("changed", "already", "refused", "ambiguous"):
        reach.append(("D", "act", o))
    for o in x["ops"]:
        reach.append(("D", "compute", o))
    for o in ("with options", "without options"):
        reach.append(("D", "ask", o))
    for r in x["reasons"]:
        reach.append(("D", "decline", r))
    for c in sorted(set(VERB_CLASS.values())):
        if c == "read":
            unr.append((("D", "undo", "after read"), "reveal changes nothing, so there is nothing to undo"))
        else:
            reach.append(("D", "undo", f"after {c}"))
    return reach, unr


def _table_e(x):
    reach, unr = [], []
    restorable = {k for k, vs in x["verbs"].items() if "restore" in vs}
    linked = {k for k, fs in x["where"].items() if any(f.endswith(" count") for f in fs)}
    rules = {
        "ambiguous": (set(x["kinds"]), ""),
        "empty result": (set(x["kinds"]), ""),
        "trashed row": (restorable, "has no trash (deleted for good, or never deleted)"),
        "restore window": (restorable, "has no restore verb"),
        "refused delete": ({"group", "folder", "person"},
                           "is never refused: the runtime refuses only group/folder deletes and person remove_from"),
        "knock-on diff": (set(x["kinds"]), ""),
        "linked_to all": (linked, "has no links"),
        "photo undo": ({"photo"}, "is not a photo: undo restoring albums is photo-only"),
        "event overlap": ({"event"}, "is not an event: only events have the non-overlap rule"),
    }
    for b in BEHAVIOURS:
        ok, why = rules[b]
        for kind in x["kinds"]:
            (reach.append(("E", b, kind)) if kind in ok else unr.append((("E", b, kind), f"{kind} {why}")))
    return reach, unr


def _table_f(_x):
    reach = [("F", "referent", r) for r in ("@prev", "pronoun", "ordinal")]
    reach += [("F", "calls/turn", n) for n in ("1", "2", "3", "4+")]
    reach += [("F", "more= continuation", "—"), ("F", "repair mid-session", "—"),
              ("F", "write then read same row", "—")]
    reach += [("F", "session length", str(n) if n < 7 else "7+") for n in range(1, 8)]
    return reach, []


def _table_g(x, a, d):
    fams = sorted({("verb×kind", f"{c[1]}×{c[2]}") for c in a} | {("tool×outcome", f"{c[1]}:{c[2]}") for c in d})
    # one cell per family key; coverage.py judges it: at least two of the three moods,
    # and both verbatim and non-verbatim naming wherever the turn names a row
    return [("G", fam, key) for fam, key in fams], []


# turns of these outcomes name no row, so verbatim / non-verbatim naming does not apply
NO_NAMING = ("undo:", "decline:", "ask:", "compute:")


def g_needs_naming(key: str) -> bool:
    return not key.startswith(NO_NAMING)


@functools.lru_cache(maxsize=1)
def universe() -> dict[str, dict]:
    """{table: {"reachable": [cell...], "unreachable": [(cell, reason)...]}} for tables A-H."""
    x = export()
    out = {}
    for t, fn in (("A", _table_a), ("B", _table_b), ("C", _table_c), ("D", _table_d), ("E", _table_e),
                  ("F", _table_f)):
        r, u = fn(x)
        out[t] = {"reachable": r, "unreachable": u}
    r, u = _table_g(x, out["A"]["reachable"], out["D"]["reachable"])
    out["G"] = {"reachable": r, "unreachable": u}
    out["H"] = universe_h()
    return out


# Cells confirmed unreachable by authoring. They stay in the rotation (so every world's sheet is
# stable) but coverage reports them as unreachable, not uncovered.
CONFIRMED_UNREACHABLE = {
    ("D", "find", "ambiguous"): "only an act gets an `ambiguous:` reply; a find returns the rows",
    ("A", "edit", "notebook", "multi"): "notebook names are unique and name is its only editable "
                                        "field, so a multi-row edit is always refused",
    ("G", "tool×outcome", "find:ambiguous"): "find:ambiguous is unreachable (table D)",
    ("A", "edit", "group", "multi"): "group names are unique and name is its only editable field "
                                     "(currency cannot be edited), so a multi-row edit is refused",
}


def cell_str(c: tuple) -> str:
    return f"{c[0]}: " + " · ".join(c[1:])


# --- the rotation -----------------------------------------------------------------------------


ASSIGNED = "ABCDE"  # F (structure), G (phrasing) and H (message-side decisions) are corpus-wide, not owned by a world


def assign(n_worlds: int) -> dict[tuple, list[int]]:
    """Every reachable A-E cell -> two distinct worlds, deterministic and balanced: cell j goes to
    world j % n and to a second world shifted by a rotation that changes every n cells, so each
    block of n cells gives every world exactly two cells and no two worlds are always paired."""
    if n_worlds < 2:
        raise ValueError("a cell needs two worlds")
    u = universe()
    cells = [c for t in ASSIGNED for c in u[t]["reachable"]]
    out = {}
    for j, c in enumerate(cells):
        w1 = j % n_worlds
        w2 = (w1 + 1 + (j // n_worlds) % (n_worlds - 1)) % n_worlds
        out[c] = [w1, w2]
    return out


def owned(i: int, n: int) -> list[tuple]:
    return [c for c, ws in assign(n).items() if i in ws]


TABLE_TITLE = {"A": "A. Act (verb · kind · selector)", "B": "B. Where (field · operator · value form)",
               "C": "C. Dates (kind · date shape)", "D": "D. Tool outcome (tool · outcome)",
               "E": "E. Runtime behaviour (behaviour · kind)"}


def world_sheet(i: int, n: int) -> str:
    cells = owned(i, n)
    lines = [f"# Cell sheet: world {i} of {n}", "",
             f"You own {len(cells)} cells. Each needs at least 2 uses, in different sessions. "
             "Selectors: named = the row by name or $key; where = a filter (where/when/linked_to); "
             "prev = @n from an earlier result; new = $new/$c1 created this session; multi = more "
             "than one row in one call. Value forms: unit = a number with its unit or currency; "
             "linkcount = `<kind> count`; refused:* = a bad(...) where the runtime rejects the unit, "
             "then the fixed call.", ""]
    for t in ASSIGNED:
        mine = [c for c in cells if c[0] == t]
        if not mine:
            continue
        lines += [f"## {TABLE_TITLE[t]} ({len(mine)})", ""]
        lines += [f"- {' · '.join(c[1:])}" for c in mine]
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--unreachable", action="store_true")
    ap.add_argument("--sheet", type=int)
    ap.add_argument("--of", type=int, default=28)
    a = ap.parse_args()
    if a.sheet is not None:
        print(world_sheet(a.sheet, a.of))
        return
    u = universe()
    for t, v in u.items():
        print(f"{t}: {len(v['reachable'])} reachable, {len(v['unreachable'])} unreachable")
        if a.unreachable:
            for c, why in v["unreachable"]:
                print(f"  - {cell_str(c)}: {why}")
    per = collections_counter(assign(a.of))
    print(f"assign({a.of}): cells per world min {min(per.values())} max {max(per.values())}")


def collections_counter(asg):
    per = {}
    for ws in asg.values():
        for w in ws:
            per[w] = per.get(w, 0) + 1
    return per


if __name__ == "__main__":
    main()
