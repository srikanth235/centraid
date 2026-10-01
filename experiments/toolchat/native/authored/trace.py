"""Forward slot trace (CONTRACT_V2 §2): the `<think>` block written before each call.

    intent: read|count|write|ask|decline "<deciding phrase>"
    verb:   <closed verb set>                        (writes)
    scope:  one|some|all "<qualifier>"               (a write on rows that already exist)
    refer:  it|both|that|nth "<phrase>" -> @k|#n     (the call names rows of an earlier turn)
    target: "<span>" · "<span>"                      (names, attributes, new values, as said)
    when:   "<date phrase as said>"                  (a date is involved)
            | earlier "<phrase>"                     (said in an earlier message, or an earlier call's own date)
            | now                                    (the unstated default, from today on)
    pick:   #n ok · #n no (<reason>)                 (a row is chosen among several shown)

Fixed order. A value is a closed word or a quoted span of the user message; nothing the runtime
can compute (no row lists, no resolved dates). A slot depends only on the message, the context
the model can read and the slots above it. `retry: rejected` leads the block after a rejected call.
Choices this file makes where CONTRACT_V2 §2 is silent:
  - a lookup (find, search, open) carries the intent of the call it prepares, read off the turn's own
    next call; when that call is an ask or a decline (the outcome of the lookup) the message alone decides;
  - `scope` is written on an `act` that names existing rows (not on create or undo), `refer` when the call
    names rows an earlier turn showed and the message does not name them, `pick` when a `#n` is chosen
    among several rows a listing shows (a pick reason is one of kind, name, position, date, status, other);
  - `target` also carries the attribute and the new values the call uses, as said ("over fifty dollars",
    "Dr Patel"); a number or a literal that the message does not say but the context does is sourced there;
  - `when` has two closed words besides a quote (see above), for a date the message does not state.

The generator works from what a record shows (`derive_trace(call, history, today, retry, ahead)`,
history = the messages before the call, as build.py's records or the eval Transcript keep them),
so a training think is always rebuildable from the context in front of it. `ahead` are the calls
still to come in the turn: a lookup (`find`, `search`, `open`) carries the intent of the call it
prepares.

`render`, `parse`, `check_call` and `sources` are the renderer, the parser and the two checks of
trace_check.py: trace-call consistency (a call rebuilt from the parsed slots equals the gold call
in every field the slots decide) and argument sources (every value the call carries traces to a
slot, a handle or the context). The Rust guard (crates/nativetools/src/trace.rs) parses the same
three slots it enforces (intent, scope, refer) from the same text.
"""
from __future__ import annotations

import datetime
import json
import re
import unicodedata
from dataclasses import dataclass, field

ROW_CAP = 12  # crates/nativetools meta::ROW_CAP: rows a result shows, and the most a write may take unless scope is all
INTENTS = ("read", "count", "write", "ask", "decline")
VERBS = ("create", "edit", "reschedule", "complete", "reopen", "cancel", "delete", "restore", "star", "unstar",
         "add_to", "remove_from", "log", "settle_up", "settle_debt", "reveal", "undo")
LOOKUPS = ("find", "search", "open")
AGG_OPS = ("count", "sum", "min", "max", "balance")
SCOPES = ("one", "some", "all")
REFERS = ("it", "both", "that", "nth")
REASONS = ("kind", "name", "position", "date", "status", "other")
SLOT_ORDER = ("retry", "intent", "verb", "scope", "refer", "target", "when", "pick")
# what each intent may call; lookups serve any intent
TOOLS_FOR = {"read": ("answer",), "count": ("answer", "compute"), "write": ("act",), "ask": ("ask",), "decline": ("decline",)}


class TraceError(Exception):
    """A call the generator cannot trace; the session is left to the fix-up pass."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason, self.detail = reason, detail


# ---------------------------------------------------------------------------------------------
# text helpers
# ---------------------------------------------------------------------------------------------

WORD = re.compile(r"[^\W_]+", re.U)
ROW = re.compile(r"#(\d+)(?: \[(\d+)\])? ([a-z ]+?) \"([^\"]*)\"")
HANDLE = re.compile(r"[#@]\d+")
STOP = {"the", "a", "an", "of", "to", "and", "for", "in", "on", "at", "my", "our", "with", "from", "is", "it", "s"}
SMALL = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
         "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
         "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
         "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100, "half": 0.5, "quarter": 0.25, "a": 1, "an": 1,
         "couple": 2, "dozen": 12}


def fold(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c))


def stem(word: str) -> str:
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith("es") and len(word) > 4:
        return word[:-2]
    if word.endswith("s") and len(word) > 3:
        return word[:-1]
    return word


def _lev1(a: str, b: str) -> bool:
    """Edit distance <= 1 (a typo)."""
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        diff = [i for i in range(len(a)) if a[i] != b[i]]
        return len(diff) == 1 or (len(diff) == 2 and diff[1] == diff[0] + 1 and a[diff[0]] == b[diff[1]] and a[diff[1]] == b[diff[0]])
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1:]


def same(a: str, b: str) -> bool:
    """Two folded words that read as the same word: equal, same stem, a typo, or a clipped form."""
    if a == b:
        return True
    sa, sb = stem(a), stem(b)
    if sa == sb:
        return True
    if min(len(a), len(b)) >= 5 and _lev1(sa, sb):
        return True
    if min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a)):
        return True
    return False


@dataclass
class Tok:
    norm: str
    start: int
    end: int


def toks(text: str) -> list[Tok]:
    out = []
    for m in WORD.finditer(text):
        w = fold(m.group(0))
        out.append(Tok(w, m.start(), m.end()))
    # a possessive "s" after an apostrophe is not a word of its own
    return [t for t in out if not (t.norm == "s" and t.start > 0 and text[t.start - 1] in "'’")]


def norm_words(text: str) -> list[str]:
    return [t.norm for t in toks(text)]


def find_span(value_words: list[str], mt: list[Tok], msg: str, min_share: float = 0.5) -> tuple[str, float, list] | None:
    """The stretch of the message that says `value_words`: the window with the most matched words
    (each message word used once), starting and ending on a match, tightest first.
    (span, share of the words matched, the matched words' (start, end) ranges)."""
    want = [w for w in value_words if w]
    if not want or not mt:
        return None
    content = [w for w in want if w not in STOP] or want
    best = None
    n = len(mt)
    for i in range(n):
        for j in range(i, min(n, i + len(want) + 4)):
            used, hit, first, last, hits = set(), 0, None, None, []
            for k in range(i, j + 1):
                for wi, w in enumerate(want):
                    if wi in used:
                        continue
                    if same(mt[k].norm, w):
                        used.add(wi)
                        hits.append((mt[k].start, mt[k].end))
                        if w in content or not content:
                            hit += 1
                        first = k if first is None else first
                        last = k
                        break
            if first != i or last != j or hit == 0:
                continue
            share = hit / len(content)
            score = (hit, -(j - i))
            if best is None or score > best[0]:
                best = (score, i, j, share, hits)
    if best is None or best[3] < min_share:
        return None
    _, i, j, share, hits = best
    return msg[mt[i].start:mt[j].end], share, hits


# ---------------------------------------------------------------------------------------------
# context
# ---------------------------------------------------------------------------------------------

@dataclass
class Row:
    n: int
    kind: str
    name: str
    line: str = ""


@dataclass
class Listing:
    """Rows an observation (or the vault block) shows, in order."""
    idx: int  # position among the events
    turn: int
    kind: str  # block | result | ambiguous | other
    handle: int | None  # @k
    rows: list[int]
    total: int | None = None
    compacted: bool = False
    value: bool = False


@dataclass
class Ctx:
    system: str = ""
    me: str = ""
    turn: int = 0
    message: str = ""
    block: str = ""
    rows: dict[int, Row] = field(default_factory=dict)
    lists: list[Listing] = field(default_factory=list)
    results: dict[int, Listing] = field(default_factory=dict)
    directory: set[int] = field(default_factory=set)
    texts: list[str] = field(default_factory=list)  # every text the model can read, for value sources
    calls_this_turn: list[dict] = field(default_factory=list)
    last_tool_error: bool = False
    prior_exprs: set = field(default_factory=set)  # date expressions of every earlier call
    user_msgs: list = field(default_factory=list)  # (turn, text) of every user message so far, this one last


CALL_TEXT = re.compile(r"<function=(\w+)>(.*?)</function>", re.S)
PARAM = re.compile(r"<parameter=(\w+)>\n?(.*?)\n?</parameter>", re.S)


def _parse_call_text(text: str) -> tuple[str, dict]:
    m = CALL_TEXT.search(text)
    if not m:
        return "", {}
    return m.group(1), {k: v for k, v in PARAM.findall(m.group(2))}


def _row_lines(text: str) -> list[tuple[int, str, str, str]]:
    out = []
    for line in text.split("\n"):
        for m in ROW.finditer(line):
            out.append((int(m.group(1)), m.group(3), m.group(4), line))
    return out


def build_ctx(history: list[dict]) -> Ctx:
    """What the model can read in front of a call: the system prompt (me, the vault directory), every
    user block and message, every runtime reply as compacted so far, and this turn's earlier calls."""
    ctx = Ctx()
    turn = 0
    for idx, m in enumerate(history):
        role = m["role"]
        if role == "system":
            ctx.system = m.get("content") or ""
            mm = re.search(r"^me: (.+)$", ctx.system, re.M)
            ctx.me = mm.group(1).strip() if mm else ""
            for n_txt in re.finditer(r"\(#(\d+)\)", ctx.system):
                ctx.directory.add(int(n_txt.group(1)))
            for line in ctx.system.split("\n"):
                mm = re.match(r"(groups|albums|notebooks|folders|lists): (.*)$", line)
                if mm:
                    kind = mm.group(1)[:-1]
                    for name, n in re.findall(r"(.+?) \(#(\d+)\)(?:, |$)", mm.group(2)):
                        ctx.rows[int(n)] = Row(int(n), kind, name.strip(), line)
            ctx.texts.append(ctx.system.split("vault directory:")[-1])
        elif role == "user":
            turn += 1
            if "text" in m:
                block, text = m.get("preground") or "", m["text"]
            else:
                block, _, text = (m.get("content") or "").rpartition("\n\n")
            ctx.turn, ctx.message, ctx.block = turn, text, block
            ctx.calls_this_turn = []
            ctx.last_tool_error = False
            rows = _row_lines(block)
            for n, kind, name, line in rows:
                ctx.rows[n] = Row(n, kind, name, line)
            ctx.lists.append(Listing(idx, turn, "block", None, [n for n, _, _, _ in rows]))
            ctx.texts.extend([block, text])
            ctx.user_msgs.append((turn, text))
        elif role == "assistant":
            if "tool" in m:
                tool, args = m["tool"], dict(m.get("args") or {})
            else:
                tool, args = _parse_call_text(m.get("content") or "")
            ctx.calls_this_turn.append({"tool": tool, "args": args})
            ctx.prior_exprs.update(canon_expr(e) for e in date_values(args))
            ctx.texts.append(" ".join(str(v) for v in args.values()))
        elif role == "tool":
            content = m.get("content") or ""
            ctx.texts.append(content)
            ctx.last_tool_error = content.startswith("error")
            rows = _row_lines(content)
            for n, kind, name, line in rows:
                ctx.rows[n] = Row(n, kind, name, line)
            heads = list(re.finditer(r"^(?:answered: )?@(\d+)(?: · | = )(.*)$", content, re.M))
            if heads:
                for h in heads:
                    k = int(h.group(1))
                    seg = content[h.end():]
                    nxt = re.search(r"^(?:answered: )?@\d+(?: · | = )", seg, re.M)
                    seg = seg[:nxt.start()] if nxt else seg
                    rs = [n for n, _, _, _ in _row_lines(seg)] if " · " in h.group(0)[:12 + len(str(k))] else []
                    tot = re.match(r"(?:search \"[^\"]*\": )?(\d+)\b", h.group(2))
                    lst = Listing(idx, turn, "result", k, rs, int(tot.group(1)) if tot else len(rs),
                                  "compacted" in h.group(2), value=" = " in h.group(0)[:8 + len(str(k))])
                    ctx.results[k] = lst
                    ctx.lists.append(lst)
            elif rows:
                kind = "ambiguous" if content.startswith("ambiguous") else "other"
                ctx.lists.append(Listing(idx, turn, kind, None, [n for n, _, _, _ in rows]))
    return ctx


def handles_of(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [h for v in value for h in handles_of(v)]
    return HANDLE.findall(str(value))


def rows_of(ctx: Ctx, handle: str) -> list[int] | None:
    """Row numbers a handle stands for; None when the context cannot say."""
    if handle.startswith("#"):
        return [int(handle[1:])]
    lst = ctx.results.get(int(handle[1:]))
    if lst is None or lst.value:
        return None
    return list(lst.rows)


def handle_size(ctx: Ctx, handle: str) -> int | None:
    if handle.startswith("#"):
        return 1
    lst = ctx.results.get(int(handle[1:]))
    if lst is None or lst.value:
        return None
    return lst.total if lst.total is not None else len(lst.rows)


HANDLE_ARGS = ("rows", "row", "within", "value", "linked_to", "exclude", "options")
PRIMARY = ("rows", "row", "within", "value", "linked_to", "exclude")


# ---------------------------------------------------------------------------------------------
# lexicons
# ---------------------------------------------------------------------------------------------

def _rx(*alts: str) -> re.Pattern:
    return re.compile(r"\b(?:" + "|".join(alts) + r")\b", re.I)


VERB_RX = {
    "cancel": _rx(r"cancel(?:led)?", r"call(?:ed)? off", r"scrap", r"drop", r"axe", r"kill", r"nix"),
    "complete": _rx(r"tick(?:ed)? (?:it |them |that )?off", r"mark(?:ed)? \w+ (?:as )?(?:done|complete\w*|finished)", r"mark(?:ed)?",
                    r"(?:is|are|was|were|got|it's|its|i've|ive|all|been)? ?(?:done|finished|complete\w*|sorted|ordered|paid|booked|handled)",
                    r"check(?:ed)? off", r"cross(?:ed)? off", r"did", r"done", r"finish(?:ed)?", r"got through", r"knocked out", r"tick\w*", r"sent it",
                    r"uploaded", r"printed", r"found", r"got \w+", r"paid", r"sent"),
    "reopen": _rx(r"re-?open\w*", r"un-?complete", r"not done", r"undo the tick", r"not finished", r"back on"),
    "delete": _rx(r"delete\w*", r"remove", r"wipe", r"get rid", r"clear(?:ed)? out", r"bin", r"scrap", r"trash", r"erase", r"junk",
                  r"ditch", r"dump", r"lose", r"can go", r"kill", r"just the", r"same for", r"skip"),
    "restore": _rx(r"restore\w*", r"put (?:it |them |that |this |him |her |the \w+ )?back", r"bring(?:ing)? (?:it |them |that |this |him |her |\w+ )*back",
                   r"undelete", r"get (?:\w+ ){0,4}back", r"recover", r"come back", r"out of the (?:trash|bin)", r"back from the (?:trash|bin)", r"back"),
    "undo": _rx(r"undo", r"revert", r"take that back", r"reverse", r"undone", r"scratch that"),
    "reschedule": _rx(r"move", r"push(?:ed)?", r"shift", r"re-?schedule", r"bring (?:it )?forward", r"postpone", r"delay", r"put (?:it )?back", r"due", r"make (?:\w+ ){0,4}(?:\d+|\w+ \d+|half \w+)",
                      r"can wait", r"instead", r"give it", r"at half \d+", r"is \d+:\d\d now",
                      r"change (?:the )?(?:time|date|day)", r"make (?:it|that|them) (?:earlier|later)", r"swap", r"slide"),
    "create": _rx(r"add", r"new", r"book", r"schedule", r"create", r"owes? me", r"catch up with", r"ring \w+", r"folder for", r"go on", r"yes,? \w+ \w+", r"put \w+(?: \w+){0,4} in(?: the diary| the calendar)?", r"make", r"set up",
                  r"remind me", r"save", r"log", r"note down", r"start", r"open a", r"put in", r"put (?:a|an) \w+", r"stick"),
    "star": _rx(r"star(?:red)?", r"favou?rite", r"fav", r"bookmark"),
    "unstar": _rx(r"un-?star", r"un-?favou?rite", r"unfav\w*", r"remove (?:the )?star", r"drop (?:the )?star"),
    "add_to": _rx(r"put", r"add", r"file", r"move", r"stick", r"pop", r"drop", r"chuck", r"save"),
    "remove_from": _rx(r"take", r"remove", r"drop", r"pull", r"out of", r"kick", r"get \w+ out"),
    "log": _rx(r"log", r"record", r"note", r"tick", r"rang", r"met", r"had a", r"call with", r"a (?:call|visit|message|coffee)", r"stopped by", r"called", r"rings?",
               r"dropped by", r"texted", r"brew", r"visit", r"spoke"),
    "settle_up": _rx(r"settle(?:d)?(?: him| her| them)? up", r"square(?:d)? up", r"pay(?:ing)? (?:him |her |them )?back", r"settle"),
    "settle_debt": _rx(r"settle\w*", r"paid(?: off)?", r"cleared?", r"squared", r"pay(?:ing)? off", r"mark(?:ed)?", r"is paid"),
    "reveal": _rx(r"show me", r"tell me", r"read (?:it |me )?out", r"read me", r"reveal", r"give me", r"what(?:'s| is) the", r"show", r"read"),
    "edit": _rx(r"rename", r"change", r"update", r"edit", r"set", r"make (?:it|her|him|that|\w+)", r"put", r"add", r"pin", r"unpin", r"fix", r"correct",
                r"call (?:it|him|her)", r"its?", r"is now", r"not", r"goes by", r"nickname", r"every \w+ (?:weeks?|days?|months?)", r"monthly", r"weekly",
                r"should be called", r"note in", r"save", r"check in", r"every (?:two|three|\d+)", r"yes do that"),
}
READ_LEAD = re.compile(
    r"^(?:(?:ok|okay|and|so|now|also|then|hey|hi|hm+|um+|oh|well|yeah|nah|no|yes|right|actually|wait|sorry|please|pls|can you|could you|"
    r"can i|do you|did you|tell me|show me|let me see|i want to see|give me|i need to know|do i|did i|have i|what about)\s+)*"
    r"(what'?s?|whats|which|who'?s?|whos|whose|whom|when'?s?|whens|where'?s?|wheres|how|any|is|are|was|were|do|does|did|have|has|"
    r"list|show|find|see|check|got|gimme|give|tell)\b", re.I)
COUNT_RX = _rx(r"how many", r"how much", r"count", r"total", r"sum", r"add up", r"balance", r"owe[sd]?", r"up or down", r"average", r"most",
               r"least", r"biggest", r"smallest", r"cheapest", r"longest", r"shortest", r"spent", r"cost\w*", r"in all", r"altogether",
               r"number of", r"stand", r"where am i with", r"am i (?:up|down)", r"net")
DECLINE_RX = {
    "sealed_egress": _rx(r"text \w+", r"whats?app", r"e-?mail(?:ing)? \w+", r"send \w+", r"text (?:it|them|her|him|that)", r"e-?mail(?:ing)? (?:it|them|that|her|him)", r"send (?:it|them|that|me)",
                         r"forward", r"share (?:it|them|that)", r"message (?:it|them|that)", r"dm", r"text", r"e-?mail", r"send", r"share",
                         r"post", r"tweet", r"paste", r"upload"),
    "fabricated_secret": _rx(r"make (?:one |it |a \w+ )?up", r"invent", r"generate", r"come up with", r"create a (?:new )?password", r"made[- ]up",
                             r"fake", r"pick one", r"think of", r"just guess", r"guess", r"reset"),
    "unbounded_destruction": _rx(r"delete (?:all|every|everything)", r"wipe\w*", r"clear (?:out )?(?:all|everything)", r"fresh start",
                                 r"everything", r"every \w+", r"all (?:my|the|of)", r"nuke", r"burn", r"purge", r"factory reset", r"start over"),
    "never_mind": _rx(r"never ?mind", r"leave it", r"forget it", r"forget that", r"cancel that", r"hang on", r"actually,? no", r"don'?t",
                      r"no need", r"scrap that", r"leave (?:it|that|them)", r"stop", r"ignore", r"nah", r"ok(?:ay)? then", r"nothing"),
    "out_of_scope": _rx(r"weather", r"news", r"joke", r"recipe", r"translate", r"stock", r"who (?:is|was)", r"how do i", r"what(?:'s| is) the (?:capital|time)",
                        r"book a", r"call (?:a|the)", r"order", r"buy", r"flight", r"directions?", r"google", r"search the web", r"look up online"),
    "not_found": _rx(r"\w+"),
}
ALL_RX = re.compile(r"\b(all of them|all of those|all of these|all the|all|every|everything|each|whole|entire)\b", re.I)
BOTH_RX = re.compile(r"\b(both of them|both|the two of them|the two|all three|the three|all four|the four|these two|those two|them both|them|those|these|"
                     r"all of them|all of those)\b", re.I)
PLURAL_RX = re.compile(r"\b(?:the )?(?:small|big|old|new|open|other|rest of the|remaining|cheap|long|short|\w+) ones\b", re.I)
EXCEPT_RX = re.compile(r"\b(except|besides|apart from|other than|but not|but keep|minus|aside from|leave out|not the)\b", re.I)
IT_RX = re.compile(r"\b(it|its|this|that|him|his|her|hers|he|she|there|the same|that one|this one|the one)\b", re.I)
NTH = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "last": -1, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5,
       "top": 1, "next": 2}
NTH_RX = re.compile(r"\b(the (?:first|second|third|fourth|fifth|sixth|last|top|other|earlier|later|latter|former)(?: one)?|(?:first|second|third|"
                    r"fourth|fifth|last|1st|2nd|3rd|4th|5th) one|number \d+|no\.? ?\d+|#\d+|the \d+(?:st|nd|rd|th) one|"
                    r"\d+ is fine|the (?:other|later|earlier) one|(?:option|choice) \w+)\b", re.I)
REFER_PHRASE_RX = re.compile(r"\b(the (?:one|ones)[^,.;]*|that one|this one|those|these|them|both|it|its|him|his|her|hers|there|that|this|the same)\b", re.I)

# ------ dates -------
_WD = r"(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)"
_MO = (r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|"
       r"nov(?:ember)?|dec(?:ember)?)")
_ORD_W = (r"(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|"
          r"seventeenth|eighteenth|nineteenth|twentieth|twenty[- ](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|thirtieth|"
          r"thirty[- ]first)")
_NUM_W = r"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|a couple of|a|an|half an?|couple)"
_UNIT = r"(?:min(?:ute)?s?|hours?|hrs?|days?|weeks?|months?|years?|nights?)"
DATE_TOKEN = re.compile(
    r"\b(?:" + _WD + r"|(?:" + _MO + r")(?=\W+\d|\W+the\b|\b)|today|tonight|tomorrow|tmrw|tmr|yesterday|weekends?|weekdays?|noon|midnight|"
    r"lunch(?:time)?|dinner ?time|morning|afternoon|evening|night|ago|"
    r"\d{1,2}(?::\d\d)?\s*(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}:\d\d|\d{1,2}(?:st|nd|rd|th)|" + _ORD_W + r"|o'?clock|(?:19|20)\d\d|"
    r"(?:\d+|" + _NUM_W + r")\s+" + _UNIT + r"|(?:this|next|last|coming|following|previous|every|each)\s+(?:" + _UNIT + r"|" + _WD + r"|weekend|" +
    _MO + r")|" + _UNIT + r"|later|earlier|earliest|latest|soon|now|then|half past|quarter (?:to|past)|before|after|since|until|till|"
    r"by|from|thru|through|between|weekly|daily|monthly|yearly|fortnight|weekend)\b", re.I)
STRONG_DATE = re.compile(
    r"\b(?:" + _WD + r"|" + _MO + r"|today|tonight|tomorrow|tmrw|tmr|yesterday|weekends?|weekdays?|noon|midnight|lunch(?:time)?|morning|afternoon|"
    r"evening|night|ago|\d{1,2}(?::\d\d)?\s*(?:am|pm)|\d{1,2}:\d\d|\d{1,2}(?:st|nd|rd|th)|" + _ORD_W + r"|o'?clock|(?:19|20)\d\d|"
    r"(?:\d+|" + _NUM_W + r")\s+" + _UNIT + r"|(?:this|next|last|coming|following|previous|every|each|past|the)\s+" + _UNIT + r"|"
    r"later|earlier|weekly|daily|monthly|fortnight)\b", re.I)
BRIDGE = {"the", "of", "at", "on", "to", "till", "until", "thru", "through", "from", "since", "before", "after", "by", "in", "and", "or", "a", "an",
          "this", "next", "last", "coming", "every", "each", "around", "about", "back", "forward", "earlier", "later", "for", "till", "than", "is", "s"}
LEAD_OK = {"from", "since", "before", "after", "until", "till", "by", "between", "next", "last", "this", "coming", "every", "each", "on", "at",
           "in", "the"}
LOOSE_DATE = re.compile(
    r"\b(?:(?:at|to|till|until|by|around|for|from)\s+\d{1,2}(?::\d\d)?(?![\d:]|\s*(?:people|things|items|rows|of))|half\s+(?:past\s+)?\d{1,2}|"
    r"quarter\s+(?:to|past)\s+\d{1,2}|next|upcoming|coming up|soon|still to come|from now|remaining|left|future|so far|yet|already|ahead|"
    r"outstanding|overdue|latest|recent(?:ly)?|(?:since|before|after|until|till)\s+(?:before\s+)?"
    r"(?:the\s+)?[^\W\d_]+(?:\s+[^\W\d_]+)?)\b", re.I)
WD_ONLY = re.compile(_WD, re.I)
MO_ONLY = re.compile(_MO, re.I)
NOW_WORDS = re.compile(r"\b(?:today|now|tonight|upcoming|next|coming|soon|future|left|remaining|still|yet|later|from now|ahead|outstanding)\b", re.I)
BARE_HOUR = re.compile(r"(?<![#@\d:.])\b(?:[1-9]|1\d|2[0-4])\b(?![\d:.]|\s*(?:people|things|items|rows|of|%))")
MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
WDAYS = {"mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6, "sun": 7}


def date_cues(text: str) -> dict:
    """Facts a date phrase states outright (for choosing between clusters and for the sanity check)."""
    low = fold(text)
    cues: dict = {}
    wd = [WDAYS[m[:3]] for m in re.findall(r"\b" + _WD + r"\b", low)]
    if wd:
        cues["weekday"] = wd
    mo = [MONTHS[m[:3]] for m in re.findall(r"\b" + _MO + r"\b", low) if not (m == "may" and not re.search(r"\bmay\W+\d|\d\W+may\b|(?:in|last|next|of) may", low))]
    if mo:
        cues["month"] = mo
    days = [int(n) for n in re.findall(r"\b(\d{1,2})(?:st|nd|rd|th)\b", low)]
    for i, w in enumerate(["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth",
                           "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"], 1):
        if re.search(r"\b" + w + r"\b", low):
            days.append(i)
    for tens, base in (("twenty", 20), ("thirty", 30)):
        for i, w in enumerate(["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"], 1):
            if re.search(tens + r"[- ]" + w, low):
                days.append(base + i)
    if days:
        cues["day"] = days
    for w, key in (("tomorrow", 1), ("tmrw", 1), ("tmr", 1), ("today", 0), ("tonight", 0), ("yesterday", -1)):
        if re.search(r"\b" + w + r"\b", low):
            cues["rel_day"] = key
    if re.search(r"\bnext week\b", low):
        cues["rel_week"] = 1
    if re.search(r"\blast week\b", low):
        cues["rel_week"] = -1
    if re.search(r"\bthis week\b", low):
        cues["rel_week"] = 0
    hours: set[int] = set()
    for h, _mn, mer in re.findall(r"\b(\d{1,2})(?::(\d\d))?\s*(am|pm|a\.m\.|p\.m\.)", low):
        hours.add((int(h) % 12) + (12 if mer.startswith("p") else 0))
    for h in re.findall(r"\b(?:at|to|till|until|by|around|half|past|quarter to|quarter past)\s+(\d{1,2})\b(?!\s*(?:am|pm|:))", low):
        hours.update({int(h) % 24, (int(h) % 12) + 12})
    for h in re.findall(r"\b(\d{1,2}):\d\d\b(?!\s*(?:am|pm))", low):
        hours.add(int(h) % 24)
    if re.search(r"\bnoon\b", low):
        hours.add(12)
    if hours:
        cues["hour"] = sorted(hours)
    return cues


def date_clusters(msg: str, loose: bool = True, exclude: list | None = None) -> list[tuple[int, int, str]]:
    """Stretches of the message that talk about time: (start, end, text). `loose` (the call carries a
    date expression, so something in the message is its phrase) also takes a bare hour after at / to /
    till ("move it to 7"), "half 4", a relative word ("the next one") and "before <event>"."""
    mt = toks(msg)
    skip = lambda a, b: any(a < hi and b > lo for lo, hi in (exclude or []))  # noqa: E731 -- words of a name are not a date
    strong = [(m.start(), m.end()) for m in STRONG_DATE.finditer(msg) if not skip(m.start(), m.end())]
    hits = [(m.start(), m.end()) for m in DATE_TOKEN.finditer(msg) if not skip(m.start(), m.end())]
    if loose:
        for m in LOOSE_DATE.finditer(msg):
            if not skip(m.start(), m.end()):
                hits.append((m.start(), m.end()))
                strong.append((m.start(), m.end()))
    if not strong:
        return []
    marks = []
    for a, b in hits:
        ti = [i for i, t in enumerate(mt) if t.start < b and t.end > a]
        if ti:
            marks.append((ti[0], ti[-1], any(sa < b and sb > a for sa, sb in strong)))
    if not marks:
        return []
    marks.sort()
    clusters: list[list] = []
    for lo, hi, strong_flag in marks:
        if clusters and lo - clusters[-1][1] <= 3 and all(mt[i].norm in BRIDGE or mt[i].norm.isdigit() for i in range(clusters[-1][1] + 1, lo)):
            clusters[-1][1] = max(clusters[-1][1], hi)
            clusters[-1][2] = clusters[-1][2] or strong_flag
        else:
            clusters.append([lo, hi, strong_flag])
    out = []
    for lo, hi, strong_flag in clusters:
        if not strong_flag:
            continue
        while lo < hi and mt[lo].norm in BRIDGE and mt[lo].norm not in LEAD_OK:
            lo += 1
        while hi > lo and mt[hi].norm in BRIDGE:
            hi -= 1
        out.append((mt[lo].start, mt[hi].end, msg[mt[lo].start:mt[hi].end]))
    return out


def canon_expr(e: str) -> str:
    try:
        return json.dumps(json.loads(e), sort_keys=True, separators=(",", ":"))
    except Exception:  # noqa: BLE001
        return e


def is_default_now(e: str) -> bool:
    """The unstated default reading: from today on."""
    return canon_expr(e) in (canon_expr('{"from":{"unit":"day","rel":0}}'), canon_expr('{"unit":"day","rel":0}'))


def date_values(args: dict) -> list[str]:
    """Every date expression a call carries: `when` and the date-valued lines of `args`."""
    out = []
    w = args.get("when")
    if w not in (None, "", "null"):
        out.append(w if isinstance(w, str) else json.dumps(w))
    body = args.get("args")
    if isinstance(body, str):
        for ln in body.split("\n"):
            k, _, v = ln.partition(": ")
            v = v.strip()
            if k in ("to", "date", "due", "from", "start", "end") and (v.startswith("{") or re.fullmatch(r"\d{4}-\d\d-\d\d(?:T\d\d:\d\d)?", v)):
                out.append(v)
    return out


def expr_cues(expr: str) -> dict:
    """Facts a date expression states (the sanity check against the phrase)."""
    cues: dict = {"weekday": [], "day": [], "month": [], "rel_day": [], "rel_week": [], "hour": []}
    try:
        val = json.loads(expr)
    except Exception:  # noqa: BLE001
        m = re.match(r"(\d{4})-(\d\d)-(\d\d)", expr)
        val = {"date": m.group(0)} if m else {}

    def walk(o):
        if isinstance(o, dict):
            if o.get("unit") == "week" and "weekday" in o:
                cues["weekday"].append(o["weekday"])
            if o.get("unit") == "week" and "weekday" not in o:
                cues["rel_week"].append(o.get("rel", 0))
            if o.get("unit") == "day" and "anchor" not in o:
                cues["rel_day"].append(o.get("rel", 0))
            if o.get("unit") == "month" and "name" in o:
                cues["month"].append(o["name"])
            if isinstance(o.get("time"), str) and re.fullmatch(r"\d\d:\d\d", o["time"]):
                cues["hour"].append(int(o["time"][:2]))
            if isinstance(o.get("date"), str):
                try:  # a malformed date (a deliberate mistake) states nothing
                    y, mo, d = (int(x) for x in o["date"].split("-"))
                    wd = datetime.date(y, mo, d).isoweekday()
                except ValueError:
                    pass
                else:
                    cues["month"].append(mo)
                    cues["day"].append(d)
                    cues["weekday"].append(wd)
            for v in o.values():
                walk(v)
    walk(val)
    return cues


def cluster_score(text: str, want: list[dict]) -> int:
    """How well a date phrase agrees with the cues of the expressions (2 per fact shared, -1 per fact contradicted)."""
    cues = date_cues(text)
    s = 0
    for w in want:
        for key in ("weekday", "day", "month", "hour"):
            have = cues.get(key, [])
            if have and w[key]:
                s += 2 * len(set(have) & set(w[key])) - (len(set(have) - set(w[key])) if key != "hour" else 0)
        for key in ("rel_day", "rel_week"):
            if key in cues and w[key]:
                s += 2 if cues[key] in w[key] else -1
    return s


def pick_cluster(clusters: list[tuple[int, int, str]], exprs: list[str], intent_pos: int | None = None):
    """The cluster that best agrees with the expressions' own cues (ties: the first)."""
    if len(clusters) <= 1:
        return clusters[0] if clusters else None
    want = [expr_cues(e) for e in exprs]
    best, best_s = None, None
    for c in clusters:
        s = cluster_score(c[2], want)
        if best_s is None or s > best_s:
            best, best_s = c, s
    return best


def when_sane(phrase: str, exprs: list[str]) -> bool:
    """Informational: no cue the phrase states outright is contradicted by the expressions."""
    cues = date_cues(phrase)
    for e in exprs:
        w = expr_cues(e)
        for key in ("weekday", "day", "month"):
            have = cues.get(key, [])
            if have and w[key] and not (set(have) & set(w[key])):
                return False
        for key in ("rel_day", "rel_week"):
            if key in cues and w[key] and cues[key] not in w[key]:
                return False
    return True


# ---------------------------------------------------------------------------------------------
# argument analysis
# ---------------------------------------------------------------------------------------------

CLOSED_ARGS = {"kind", "op", "field", "group", "order", "limit", "trashed", "more", "reason", "verb", "question", "type", "direction",
               "status", "starred", "pinned", "currency"}
NUM_MULT = (1, 60, 1440, 10080, 24, 7, 30, 0.5, 2, 12)
CURRENCY = {"gbp", "usd", "eur", "cad", "aud", "ngn", "inr", "jpy", "chf", "cny", "brl", "mxn", "nzd", "sek", "nok", "dkk", "pln", "zar", "sgd",
            "hkd", "krw", "try", "aed", "thb", "idr", "php", "myr", "czk", "huf", "ils", "egp", "ars", "clp", "cop", "pen", "kes", "ghs", "rub"}
ENUM_WORDS = {"open", "in_progress", "completed", "cancelled", "settled", "owes_me", "i_owe", "owed_to_me", "yes", "no", "confirmed", "tentative",
              "true", "false", "low", "high", "call", "message", "visit", "coffee", "password", "code", "card_number", "cvv", "content", "login", "card",
              "note", "identity", "wifi", "ssh_key", "api_credential", "passport", "bank_account", "driving_licence", "software_licence",
              "crypto_wallet", "membership", "document", "asc", "desc", "me", "self"}


def split_where(where: str) -> list[str]:
    parts, cur, q = [], "", False
    i = 0
    while i < len(where):
        ch = where[i]
        if ch == '"':
            q = not q
        if not q and where[i:i + 5] == " and ":
            parts.append(cur)
            cur = ""
            i += 5
            continue
        cur += ch
        i += 1
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def where_literals(where: str) -> list[tuple[str, str]]:
    """(kind, text) for each literal of a where clause: ('str', 'x') or ('num', '50')."""
    out = []
    for cond in split_where(where):
        rest = cond
        for m in re.finditer(r"\"([^\"]*)\"", cond):
            out.append(("str", m.group(1)))
        rest = re.sub(r"\"[^\"]*\"", " ", cond)
        for m in re.finditer(r"(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])", rest):
            out.append(("num", m.group(0)))
        for m in re.finditer(r"\b[A-Z]{3}\b", rest):
            out.append(("cur", m.group(0)))
    return out


def body_lines(args: dict) -> list[tuple[str, str]]:
    body = args.get("args")
    if not isinstance(body, str):
        return []
    out = []
    for ln in body.split("\n"):
        if not ln.strip():
            continue
        k, sep, v = ln.partition(": ")
        if not sep:
            k, sep, v = ln.partition(":")
        out.append((k.strip(), v.strip()))
    return out


def numbers_in(msg: str) -> set[float]:
    """Every number the message states: digits and number words (and simple compounds)."""
    out: set[float] = set()
    low = fold(msg)
    for m in re.finditer(r"\d+(?:[.,]\d+)?", low):
        try:
            out.add(float(m.group(0).replace(",", ".")))
        except ValueError:
            pass
    words = re.findall(r"[a-z]+", low)
    for i, w in enumerate(words):
        if w in SMALL:
            out.add(float(SMALL[w]))
            if w in ("twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety") and i + 1 < len(words) and words[i + 1] in SMALL and SMALL[words[i + 1]] < 10:
                out.add(float(SMALL[w] + SMALL[words[i + 1]]))
        for name, val in (("first", 1), ("second", 2), ("third", 3), ("fourth", 4), ("fifth", 5)):
            if w == name:
                out.add(float(val))
    for m in re.finditer(r"\b(\d+|an?|one|two|three|four|five)\s+(?:hours?|hrs?|days?|weeks?|mins?|minutes?)\s+and\s+(?:a\s+)?half\b", low):
        base = m.group(1)
        out.add((float(base) if base.isdigit() else float(SMALL[base])) + 0.5)
    for m in re.finditer(r"(\d+)\s*(?:h|hr|hrs|hour|hours)\s*(\d+)?", low):
        out.add(float(m.group(1)) * 60 + (float(m.group(2)) if m.group(2) else 0))
    return out


def num_sourced(value: float, nums: set[float]) -> bool:
    for n in nums:
        for mult in NUM_MULT:
            if abs(n * mult - value) < 1e-9 or (mult != 1 and n and abs(value / mult - n) < 1e-9):
                return True
    return False


# ---------------------------------------------------------------------------------------------
# the trace
# ---------------------------------------------------------------------------------------------

@dataclass
class Trace:
    slots: dict = field(default_factory=dict)  # slot -> value (see render)
    flags: list[str] = field(default_factory=list)  # quality notes (fallback phrases, unsourced args)
    unsourced: list[tuple[str, str]] = field(default_factory=list)  # (arg, value) with no source
    sources: list[tuple[str, str, str]] = field(default_factory=list)  # (arg, value, how it is sourced)

    def text(self) -> str:
        return render(self)


def q(text: str) -> str:
    return '"' + text.replace('"', "'") + '"'


def render(tr: Trace | dict) -> str:
    slots = tr.slots if isinstance(tr, Trace) else tr
    lines = []
    if slots.get("retry"):
        lines.append("retry: rejected")
    i = slots["intent"]
    lines.append(f"intent: {i[0]}" + (f" {q(i[1])}" if i[1] else ""))
    if slots.get("verb"):
        lines.append(f"verb: {slots['verb']}")
    if slots.get("scope"):
        s = slots["scope"]
        lines.append(f"scope: {s[0]}" + (f" {q(s[1])}" if s[1] else ""))
    if slots.get("refer"):
        r = slots["refer"]
        lines.append(f"refer: {r[0]}" + (f" {q(r[1])}" if r[1] else "") + " -> " + ", ".join(r[2]))
    if slots.get("target"):
        lines.append("target: " + " · ".join(q(t) for t in slots["target"]))
    if slots.get("when"):
        w = slots["when"]
        lines.append("when: " + (q(w[1]) if w[0] == "q" else ("earlier" + (" " + q(w[1]) if w[1] else "") if w[0] == "e" else w[1])))
    if slots.get("pick"):
        lines.append("pick: " + " · ".join(f"#{n} ok" if why is None else f"#{n} no ({why})" for n, why in slots["pick"]))
    return "\n".join(lines)


_QUOTED = r'"([^"\n]*)"'
LINE_RX = {
    "retry": re.compile(r"^retry: rejected$"),
    "intent": re.compile(r"^intent: (read|count|write|ask|decline)(?: " + _QUOTED + r")?$"),
    "verb": re.compile(r"^verb: (\w+)$"),
    "scope": re.compile(r"^scope: (one|some|all)(?: " + _QUOTED + r")?$"),
    "refer": re.compile(r"^refer: (it|both|that|nth)(?: " + _QUOTED + r")? -> ([#@]\d+(?:, [#@]\d+)*)$"),
    "target": re.compile(r"^target: (" + _QUOTED + r"(?: · " + _QUOTED + r")*)$"),
    "when": re.compile(r"^when: (?:" + _QUOTED + r"|(now)|(earlier)(?: " + _QUOTED.replace("(", "(?P<e>", 1) + r")?)$"),
    "pick": re.compile(r"^pick: (#\d+ (?:ok|no \((?:" + "|".join(REASONS) + r")\))(?: · #\d+ (?:ok|no \((?:" + "|".join(REASONS) + r")\)))*)$"),
}


def parse(text: str) -> dict:
    """The slots of a trace text, in order; ValueError if a line is not a slot or the order is broken."""
    slots: dict = {}
    last = -1
    for line in text.strip().split("\n"):
        line = line.rstrip()
        key = line.split(":", 1)[0]
        if key not in LINE_RX:
            raise ValueError(f"not a slot: {line!r}")
        m = LINE_RX[key].match(line)
        if not m:
            raise ValueError(f"bad {key} line: {line!r}")
        pos = SLOT_ORDER.index(key)
        if pos <= last:
            raise ValueError(f"slot out of order: {line!r}")
        last = pos
        if key == "retry":
            slots["retry"] = True
        elif key == "intent":
            slots["intent"] = (m.group(1), m.group(2) or "")
        elif key == "verb":
            slots["verb"] = m.group(1)
        elif key == "scope":
            slots["scope"] = (m.group(1), m.group(2) or "")
        elif key == "refer":
            slots["refer"] = (m.group(1), m.group(2) or "", m.group(3).split(", "))
        elif key == "target":
            slots["target"] = re.findall(_QUOTED, m.group(1))
        elif key == "when":
            slots["when"] = ("q", m.group(1)) if m.group(1) is not None else (("w", "now") if m.group(2) else ("e", m.group("e") or ""))
        elif key == "pick":
            slots["pick"] = [(int(n), None if v == "ok" else v[4:-1]) for n, v in re.findall(r"#(\d+) (ok|no \(\w+\))", m.group(1))]
    if "intent" not in slots:
        raise ValueError("no intent line")
    return slots


# ------ deciding phrases -------

def _first_words(msg: str, n: int = 4) -> str:
    mt = toks(msg)
    if not mt:
        return ""
    return msg[mt[0].start:mt[min(n, len(mt)) - 1].end]


def lead_phrase(msg: str, n: int = 7) -> str:
    """No lexeme decides: the message itself when it is short, else its first clause."""
    mt = toks(msg)
    if len(mt) <= n:
        return msg.strip().rstrip("?!.,")
    clause = re.split(r"[,;:.!?]| - | — |\bso\b|\bbecause\b", msg, maxsplit=1)[0]
    ct = toks(clause)
    if 2 <= len(ct) <= n:
        return clause.strip()
    return _first_words(msg, 5)


def guess_intent(msg: str) -> tuple[str, str | None]:
    """What the message alone says it wants (for a lookup whose turn ends in an ask or a decline:
    the outcome is not known when the lookup is written)."""
    if READ_LEAD.search(msg):
        return ("count" if COUNT_RX.search(msg) else "read"), None
    for verb in ("undo", "restore", "cancel", "delete", "reschedule", "complete", "reopen", "unstar", "star", "settle_up", "log", "reveal",
                 "create"):
        if VERB_RX[verb].search(msg):
            return "write", verb
    return "read", None


def intent_phrase(msg: str, intent: str, verb: str | None, reason: str | None, hint: str | None, flags: list[str]) -> str:
    """The stretch of the message that decides the intent (a quote), else the message's opening words."""
    m = None
    if intent == "write" and verb in VERB_RX:
        m = VERB_RX[verb].search(msg)
    elif intent == "count":
        m = COUNT_RX.search(msg)
    elif intent == "read":
        m = READ_LEAD.search(msg)
        if m:
            # keep the question word and what follows it
            mt = toks(msg)
            end = m.end()
            after = [t for t in mt if t.start >= end][:2]
            if after:
                return msg[m.start():after[-1].end].strip() if m.start() == 0 or True else ""
    elif intent == "decline":
        m = DECLINE_RX.get(reason or "", None)
        m = m.search(msg) if m else None
        if reason == "not_found" and hint:
            return hint
    elif intent == "ask":
        if hint:
            return hint
    if m:
        s = m.group(0).strip()
        if s:
            return msg[m.start():m.end()].strip()
    flags.append("intent-phrase-fallback")
    return lead_phrase(msg)


def scope_phrase(msg: str, scope: str, n_rows: int) -> str:
    if scope == "one":
        return ""
    m = EXCEPT_RX.search(msg)
    if m:
        mt = toks(msg)
        stop = re.search(r"[,;.!?]", msg[m.end():])
        limit = m.end() + stop.start() if stop else len(msg)
        tail = [t for t in mt if m.end() <= t.start < limit][:4]
        end = tail[-1].end if tail else m.end()
        return msg[m.start():end]
    m = ALL_RX.search(msg) if scope == "all" else None
    if m:
        return m.group(0)
    m = BOTH_RX.search(msg)
    if m:
        return m.group(0)
    for mm in re.finditer(r"\b(two|three|four|five|six|2|3|4|5|6)\b(?: (?:of )?(?:them|those|these|\w+s\b))?", msg, re.I):
        return mm.group(0)
    return ""


# ------ the generator -------

def _terminal_class(tool: str, args: dict) -> str | None:
    if tool == "act":
        return "write"
    if tool == "ask":
        return "ask"
    if tool == "decline":
        return "decline"
    if tool == "compute":
        return "count"
    if tool == "answer":
        return "count" if (args.get("op") in AGG_OPS or args.get("value")) else "read"
    return None


def _ahead_calls(ahead) -> list[dict]:
    out = []
    for a in ahead or []:
        if a.get("bad") or a.get("loss") is False:
            continue
        if "tool" in a:
            out.append({"tool": a["tool"], "args": a.get("args") or {}})
        elif "content" in a and a.get("role") == "assistant":
            t, ar = _parse_call_text(a["content"])
            out.append({"tool": t, "args": ar})
    return out


def _turn_slice(ahead) -> list:
    """Assistant messages of the rest of this turn (up to the next user message)."""
    out = []
    for a in ahead or []:
        if a.get("role") == "user":
            break
        if a.get("role") in (None, "assistant"):
            out.append(a)
    return out


def _visible_listing(ctx: Ctx, n: int):
    for lst in reversed(ctx.lists):
        if n in lst.rows:
            return lst
    return None


def _row_date(line: str) -> str | None:
    m = re.search(r"\b\d{4}-\d\d-\d\d(?: \d\d:\d\d)?", line)
    return m.group(0) if m else None


def _row_status(line: str) -> str | None:
    m = re.search(r"status (\w+)", line)
    return m.group(1) if m else None


def _why_not(ctx: Ctx, cand: int, picked: list[int], msg_words: list[str], nth: bool) -> str:
    c, ps = ctx.rows.get(cand), [ctx.rows[p] for p in picked if p in ctx.rows]
    if not c or not ps:
        return "other"
    if c.kind not in {p.kind for p in ps}:
        return "kind"

    def overlap(row: Row) -> int:
        return sum(1 for w in norm_words(row.name) if w not in STOP and any(same(w, x) for x in msg_words))

    if overlap(c) < max(overlap(p) for p in ps):
        return "name"
    if nth:
        return "position"
    cd, pds = _row_date(c.line), {_row_date(p.line) for p in ps}
    if cd and pds and cd not in pds:
        return "date"
    cs, pss = _row_status(c.line), {_row_status(p.line) for p in ps}
    if cs and pss and cs not in pss:
        return "status"
    return "date" if cd else "other"


def derive_trace(call: dict, history: list[dict], today: str | None = None, retry: bool = False, ahead=None,
                 bad: bool = False, strict: bool = True) -> Trace:
    """The trace of `call`, from the context `history` (messages before it). Raises TraceError when
    the call cannot be traced: a value with no source (`strict`; a call marked `bad` is a deliberate
    mistake and may carry one) or no user message."""
    tool, args = call["tool"], dict(call.get("args") or {})
    ctx = build_ctx(history)
    msg = ctx.message
    mt = toks(msg)
    mwords = [t.norm for t in mt]
    tr = Trace()
    flags = tr.flags
    if not msg.strip():
        raise TraceError("no user message")

    # ---- intent
    own = _terminal_class(tool, args)
    if own is None:  # a lookup carries the intent of the call it prepares
        nxt = None
        for a in _ahead_calls(_turn_slice(ahead)):
            c = _terminal_class(a["tool"], a["args"])
            if c:
                nxt = (c, a)
                break
        if nxt and nxt[0] in ("write", "read", "count"):
            own, ahead_call = nxt
        else:  # an ask or a decline follows: the lookup's reading is the message's own
            own, gverb = guess_intent(msg)
            ahead_call = {"tool": "act", "args": {"verb": gverb}} if gverb else None
    else:
        ahead_call = None
    intent = own
    verb = args.get("verb") if tool == "act" else (ahead_call["args"].get("verb") if (ahead_call and ahead_call["tool"] == "act") else None)
    reason = args.get("reason") if tool == "decline" else None

    # ---- handles
    hs: dict[str, list[str]] = {k: handles_of(args.get(k)) for k in HANDLE_ARGS if args.get(k) not in (None, "")}
    body = body_lines(args)
    for k, v in body:
        if handles_of(v):
            hs["args." + k] = handles_of(v)
    primary_key = next((k for k in PRIMARY if k in hs), None)
    primary = hs.get(primary_key, [])
    unknown = [h for h in primary if rows_of(ctx, h) is None and not (h.startswith("@") and h[1:].isdigit() and int(h[1:]) in ctx.results)]
    unknown += [h for h in primary if h.startswith("#") and int(h[1:]) not in ctx.rows]
    prow: list[int] = []
    for h in primary:
        r = rows_of(ctx, h)
        if r:
            prow += [x for x in r if x not in prow]

    # ---- refer: the call names rows an earlier turn showed and this turn's message does not name
    def earlier_listing(h: str):
        """The latest listing of an earlier turn that shows the handle, else None."""
        if h.startswith("@"):
            lst = ctx.results.get(int(h[1:]))
            return lst if lst is not None and lst.turn < ctx.turn else None
        for lst in reversed(ctx.lists):
            if lst.turn < ctx.turn and lst.kind != "block" and int(h[1:]) in lst.rows:
                return lst
        return None

    def named_by_block(h: str) -> bool:
        """A `#n` of this turn's vault block whose name the message shares a word with."""
        if not h.startswith("#"):
            return False
        n = int(h[1:])
        if n not in ctx.lists[[i for i, l in enumerate(ctx.lists) if l.turn == ctx.turn and l.kind == "block"][0]].rows if any(
                l.turn == ctx.turn and l.kind == "block" for l in ctx.lists) else True:
            return False
        row = ctx.rows.get(n)
        return bool(row) and any(w not in STOP and any(same(w, x) for x in mwords) for w in norm_words(row.name))

    refer = None
    followup = bool(primary) and not unknown and primary_key != "options" and any(
        earlier_listing(h) is not None and not named_by_block(h) for h in primary)
    if followup:
        tgt = [h for h in dict.fromkeys(primary) if h.startswith("@") and earlier_listing(h) is not None]
        if tgt:  # `#n` rows named beside a result are part of the referent too
            covered = {r for h in tgt for r in (rows_of(ctx, h) or [])}
            tgt += [h for h in dict.fromkeys(primary) if h.startswith("#") and int(h[1:]) not in covered]
        if not tgt:
            tgt = list(dict.fromkeys(primary))
            for lst in reversed(ctx.lists):  # the earlier result these rows came from, when one holds them all
                if lst.handle and lst.turn < ctx.turn and not lst.value and lst.rows and set(prow) <= set(lst.rows):
                    tgt = ["@%d" % lst.handle]
                    break
        want: set[int] = set()
        for h in tgt:
            want |= set(rows_of(ctx, h) or [])
        sizes = [handle_size(ctx, h) for h in primary]
        n = sum(z for z in sizes if z) if any(sizes) else len(prow)
        whole = any(h.startswith("@") for h in primary) or (
            bool(prow) and set(prow) == want and all(handle_size(ctx, h) in (None, len(rows_of(ctx, h) or [])) for h in tgt if h.startswith("@")))
        m_nth, m_both, m_all, m_it = NTH_RX.search(msg), BOTH_RX.search(msg) or PLURAL_RX.search(msg), ALL_RX.search(msg), IT_RX.search(msg)
        if n > 1 and whole and (m_both or m_all):
            kind, ph = "both", (m_both or m_all).group(0)
        elif m_nth and n <= 1:
            kind, ph = "nth", m_nth.group(0)
        elif m_it and m_it.group(0).lower() in ("it", "its", "him", "his", "her", "hers", "he", "she"):
            kind, ph = "it", m_it.group(0)
        elif m_it:
            kind, ph = "that", m_it.group(0)
        elif n > 1 and (m_both or m_all):
            kind, ph = "that", (m_both or m_all).group(0)
        else:
            kind, ph = "that", ""
            found = []  # describe the referent by the words of its names the message uses
            for r in prow[:3]:
                row = ctx.rows.get(r)
                hit = find_span(norm_words(row.name), mt, msg) if row else None
                if hit:
                    i = msg.lower().find(hit[0].lower())
                    found.append((i, i + len(hit[0])))
            if found:
                lo, hi = min(a for a, _ in found), max(b for _, b in found)
                ph = msg[lo:hi] if len(toks(msg[lo:hi])) <= 8 else msg[found[0][0]:found[0][1]]
            if not ph:
                dc = date_clusters(msg)
                ph = dc[0][2] if dc else lead_phrase(msg, 6)
                flags.append("refer-phrase-fallback")
        refer = (kind, ph, tgt)

    # ---- scope
    scope = None
    n_write = None
    if tool == "act" and verb not in ("create", "undo"):
        if "rows" in hs:
            sizes = [handle_size(ctx, h) for h in hs["rows"]]
            n_write = sum(s for s in sizes if s) if all(s is not None for s in sizes) else None
        else:
            n_write = 1  # a selector that fits several rows is answered `ambiguous:`; an accepted one names one row
        if n_write is None:
            flags.append("scope-unknown-size")
            n_write = len(prow) or 1
        if n_write > ROW_CAP:
            sc = "all"
        elif n_write == 1:
            sc = "one"
        else:
            whole_result = any(h.startswith("@") and rows_of(ctx, h) and set(rows_of(ctx, h)) == set(prow) for h in hs.get("rows", []))
            if EXCEPT_RX.search(msg) or "exclude" in hs:
                sc = "some"
            elif ALL_RX.search(msg) or BOTH_RX.search(msg) or PLURAL_RX.search(msg) or whole_result:
                sc = "all"  # every row the message or the result it points at covers
            else:
                sc = "some"  # several rows, named one by one
        scope = (sc, scope_phrase(msg, sc, n_write))

    # ---- target: spans of the message the call's values come from
    spans: list[str] = []
    unsourced: list[tuple[str, str]] = []
    sources: list[tuple[str, str, str]] = []
    ctx_names = [(r.n, set(norm_words(r.name))) for r in ctx.rows.values()]
    ctx_words = set()
    for t in ctx.texts:
        ctx_words.update(norm_words(t))
    ctx_words.update(norm_words(ctx.me))

    name_ranges: list[tuple[int, int]] = []  # where the message says a name: not a date

    def add_span(sp: str, at: list | None = None):
        for a, b in at or []:  # a name's own words are not a date (a weekday or month in a name may still be)
            if not (WD_ONLY.fullmatch(msg[a:b]) or MO_ONLY.fullmatch(msg[a:b])):
                name_ranges.append((a, b))
        if sp and not any(sp.lower() == s.lower() for s in spans):
            spans.append(sp)

    def source_text(arg: str, value: str, whole_phrase_ok: bool = True) -> None:
        """A literal the message or the context says: a span, or a context row's name."""
        words = norm_words(value)
        if not words:
            return
        fw = [w for w in words if w not in STOP] or words
        # 1. the message says it
        r = find_span(words, mt, msg)
        if r and r[1] >= 0.999:
            add_span(r[0], r[2])
            sources.append((arg, value, "message"))
            return
        # 2. some words in the message, the rest from a context row's name (or my own name)
        rest = fw
        if r:
            spw = set(norm_words(r[0]))
            rest = [w for w in fw if not any(same(w, s) for s in spw)]
        if r:
            for _n, nm in ctx_names:
                if all(any(same(w, x) for x in nm) for w in fw):
                    add_span(r[0], r[2])
                    sources.append((arg, value, "message+context row #%d" % _n))
                    return
            if all(any(same(w, x) for x in norm_words(ctx.me)) for w in rest):
                add_span(r[0], r[2])
                sources.append((arg, value, "message+me"))
                return
        # 3. a context row's name says it all (a follow-up: "cancel it")
        for _n, nm in ctx_names:
            if all(any(same(w, x) for x in nm) for w in fw):
                sources.append((arg, value, "context row #%d" % _n))
                return
        if all(any(same(w, x) for x in norm_words(ctx.me)) for w in fw):
            sources.append((arg, value, "me"))
            return
        # 4. the words are all somewhere in what the model can read
        if r:
            add_span(r[0], r[2])
        if all(any(same(w, x) for x in ctx_words) or w.isdigit() for w in fw):
            sources.append((arg, value, "context text"))
            return
        unsourced.append((arg, value))

    def source_number(arg: str, text: str) -> None:
        try:
            v = float(text)
        except ValueError:
            return
        if num_sourced(v, numbers_in(msg)):
            # quote the number as the message says it
            m = re.search(r"\b" + re.escape(text.split(".")[0]) + r"\b", msg)
            sources.append((arg, text, "message"))
            return
        if v <= ROW_CAP and float(v).is_integer():
            sources.append((arg, text, "closed (small count)"))
            return
        if any(abs(v - float(x)) < 1e-9 for x in numbers_in(" ".join(ctx.texts)) if x):
            sources.append((arg, text, "context text"))
            return
        unsourced.append((arg, text))

    # name / search text
    if args.get("name"):
        source_text("name", str(args["name"]))
    if tool == "search" and args.get("text"):
        source_text("text", str(args["text"]))
    # where literals
    if args.get("where"):
        for kind_, lit in where_literals(str(args["where"])):
            if kind_ == "num":
                source_number("where", lit)
            elif kind_ == "cur":
                sources.append(("where", lit, "closed (currency)"))
            elif fold(lit) in ENUM_WORDS or lit.lower() in CURRENCY:
                sources.append(("where", lit, "closed (enum)"))
            else:
                source_text("where", lit)
    # act args
    for k, v in body:
        if not v:
            continue
        if handles_of(v) and not re.search(r"[A-Za-z]{3}", re.sub(r"[#@]\d+", "", v)):
            for h in handles_of(v):
                if (h.startswith("#") and int(h[1:]) in ctx.rows) or (h.startswith("@") and int(h[1:]) in ctx.results):
                    sources.append(("args." + k, h, "context handle"))
                else:
                    unsourced.append(("args." + k, h))
            continue
        if v.startswith("{") or re.fullmatch(r"\d{4}-\d\d-\d\d(?:T\d\d:\d\d)?", v):
            continue  # a date: the when slot
        if fold(v) in ENUM_WORDS or v.lower() in CURRENCY or k in ("kind", "field", "status", "direction", "type", "currency", "starred", "pinned"):
            sources.append(("args." + k, v, "closed (enum)"))
            continue
        if re.fullmatch(r"-?\d+(?:\.\d+)?", v):
            source_number("args." + k, v)
            continue
        source_text("args." + k, v)
    # handles: shown somewhere the model can read
    for key, hlist in hs.items():
        if key.startswith("args."):
            continue
        for h in hlist:
            if (h.startswith("#") and int(h[1:]) in ctx.rows) or (h.startswith("@") and int(h[1:]) in ctx.results):
                sources.append((key, h, "context handle"))
            else:
                unsourced.append((key, h))
    # the rows the call picks out by `#n` and the message names ("rename lisbon 2026 to ..."): quote how
    # the message says them, ahead of the other spans, so the handle is read off a quoted name
    if not refer:
        front: list[str] = []
        for key, hlist in hs.items():
            if key in ("options", "within", "value"):
                continue
            for h in hlist:
                row = ctx.rows.get(int(h[1:])) if h.startswith("#") else None
                if row and row.kind not in ("group", "album", "notebook", "folder", "list") or (row and key in ("rows", "row", "linked_to")):
                    hit = find_span(norm_words(row.name), mt, msg)
                    if hit and hit[1] >= 0.5:
                        if not any(hit[0].lower() == f.lower() for f in front):
                            front.append(hit[0])
                        add_span("", hit[2])
        spans[:0] = [f for f in front[:3] if not any(f.lower() == x.lower() for x in spans)]

    # ---- when
    dvals = date_values(args)
    when = None
    if dvals:
        chosen = pick_cluster(date_clusters(msg, exclude=name_ranges), dvals)
        if chosen and all(is_default_now(e) for e in dvals) and not date_cues(chosen[2]) and not NOW_WORDS.search(chosen[2]):
            chosen = None  # the default reading, and no word of the message says it
        earlier_best = None
        if chosen and not all(is_default_now(e) for e in dvals):
            # this message's phrase says nothing the expression says, an earlier message's does ("this week's" after "to 2pm")
            want = [expr_cues(e) for e in dvals]
            if any(want_k for w in want for want_k in (w["weekday"], w["day"], w["month"], w["hour"])) and cluster_score(chosen[2], want) <= 0:
                for _t, text in reversed(ctx.user_msgs[:-1]):
                    c = pick_cluster(date_clusters(text), dvals)
                    if c and cluster_score(c[2], want) > 0:
                        earlier_best = c
                        break
        if not chosen and not all(is_default_now(e) for e in dvals):
            bh = BARE_HOUR.search(msg)  # "6 then", "make it 5"
            if bh:
                chosen = (bh.start(), bh.end(), bh.group(0))
        if earlier_best:
            when = ("e", earlier_best[2])
            sources.append(("when", "; ".join(dvals)[:60], "earlier message"))
        elif chosen:
            when = ("q", chosen[2])
            sources.append(("when", "; ".join(dvals)[:60], "message"))
        elif all(is_default_now(e) for e in dvals):
            when = ("w", "now")
            sources.append(("when", "; ".join(dvals)[:60], "closed (now)"))
        else:
            # said in an earlier message of the conversation ("move the call to 3" ... "marcus")
            best = None
            for _t, text in reversed(ctx.user_msgs[:-1]):
                c = pick_cluster(date_clusters(text), dvals)
                if c:
                    best = c
                    break
            if best:
                when = ("e", best[2])
                sources.append(("when", "; ".join(dvals)[:60], "earlier message"))
            elif all(canon_expr(e) in ctx.prior_exprs for e in dvals):
                when = ("e", "")
                sources.append(("when", "; ".join(dvals)[:60], "earlier call"))
        if when is None and not chosen and not earlier_best:
            flags.append("when-no-phrase")
            unsourced.append(("when", "; ".join(dvals)[:60]))

    # ---- pick: a row chosen among several shown
    pick = None
    if primary_key in ("rows", "row") and primary and all(h.startswith("#") for h in primary) and not unknown:
        cands: list[int] = []
        for r in prow:
            lst = _visible_listing(ctx, r)
            if lst is None:  # a container of the vault directory: shown, but in no listing
                if r not in cands:
                    cands.append(r)
                continue
            for x in lst.rows:
                if x not in cands:
                    cands.append(x)
        if len(cands) > 1 and set(prow) != set(cands):
            if len(cands) > 10:
                keep = [c for c in cands if c in prow]
                for c in cands:
                    if len(keep) >= 10:
                        break
                    if c not in keep:
                        keep.append(c)
                cands = [c for c in cands if c in keep]
            nth = bool(refer and refer[0] == "nth")
            pick = [(c, None if c in prow else _why_not(ctx, c, prow, mwords, nth)) for c in cands]

    # ---- the intent phrase
    hint = None
    if intent == "ask":
        for c in reversed(ctx.calls_this_turn):
            nm = c["args"].get("name") or c["args"].get("text")
            if nm:
                sp = find_span(norm_words(str(nm)), mt, msg)
                if sp:
                    hint = sp[0]
                    break
    elif intent == "decline" and reason == "not_found":
        nm = None
        for c in reversed(ctx.calls_this_turn):
            nm = c["args"].get("name") or c["args"].get("text")
            if nm:
                break
        if nm:
            sp = find_span(norm_words(str(nm)), mt, msg)
            hint = sp[0] if sp else None
    iphrase = intent_phrase(msg, intent, verb, reason, hint, flags)

    tr.slots["intent"] = (intent, iphrase)
    if retry:
        tr.slots["retry"] = True
    if verb:
        tr.slots["verb"] = verb
    if scope and tool == "act":
        tr.slots["scope"] = scope
    if refer:
        tr.slots["refer"] = refer
    if spans:
        tr.slots["target"] = spans
    if when:
        tr.slots["when"] = when
    if pick:
        tr.slots["pick"] = pick
    tr.unsourced, tr.sources = unsourced, sources
    if unsourced and strict and not bad:
        raise TraceError("unsourced", "; ".join(f"{a}={str(v)[:50]}" for a, v in unsourced))
    return tr


# ------ the checks trace_check.py reports -------

GUARD_KEYS = ("rows", "row", "within", "linked_to")  # the parameters the runtime's refer guard compares


def check_call(text: str, call: dict, history: list[dict], ahead=None) -> list[str]:
    """Trace-call consistency: parse the text, rebuild what the slots decide about the call and compare
    with the call (tool class, verb, scope against the rows named, refer against the rows, pick against
    the rows, when present iff a date is carried, every quote a span of the conversation's own words).
    Returns the disagreements (empty = consistent)."""
    bad = []
    try:
        slots = parse(text)
    except ValueError as e:
        return [f"unparsable: {e}"]
    tool, args = call["tool"], dict(call.get("args") or {})
    ctx = build_ctx(history)
    intent = slots["intent"][0]
    # the tool the intent allows (a lookup serves any intent)
    if tool not in LOOKUPS and tool not in TOOLS_FOR.get(intent, ()):
        bad.append(f"intent {intent} vs tool {tool}")
    if tool == "act":
        if slots.get("verb") != args.get("verb"):
            bad.append(f"verb {slots.get('verb')} vs {args.get('verb')}")
    elif "verb" in slots and (tool not in LOOKUPS or slots["verb"] not in VERBS):
        bad.append("verb slot on a call that is not a write")
    # scope against the rows the write names
    verb = args.get("verb")
    if tool == "act" and verb not in ("create", "undo"):
        if "scope" not in slots:
            bad.append("write on existing rows without scope")
        else:
            sc = slots["scope"][0]
            if args.get("rows") not in (None, ""):
                sizes = [handle_size(ctx, h) for h in handles_of(args["rows"])]
                if all(z is not None for z in sizes):
                    n = sum(sizes)
                    if sc == "one" and n != 1:
                        bad.append(f"scope one on {n} rows")
                    if sc != "one" and n == 1:
                        bad.append(f"scope {sc} on 1 row")
                    if n > ROW_CAP and sc != "all":
                        bad.append(f"{n} rows without scope all")
            elif sc != "one":
                bad.append(f"scope {sc} on a selector write")
    elif "scope" in slots:
        bad.append("scope slot on a call that is not a write on existing rows")
    # refer against the rows the call names
    prim = next((k for k in GUARD_KEYS if args.get(k) not in (None, "")), None)
    if "refer" in slots:
        kind, _ph, tgt = slots["refer"]
        want: set[int] = set()
        for h in tgt:
            want |= set(rows_of(ctx, h) or [])
        have: set[int] = set()
        if prim:
            for h in handles_of(args[prim]):
                have |= set(rows_of(ctx, h) or [])
        if prim is None and not any(args.get(k) not in (None, "") for k in ("value", "exclude", "options")):
            bad.append("refer on a call that names no handle")
        if have and want and (not have <= want or (kind == "both" and have != want)):
            bad.append(f"refer {tgt} ({kind}) but {prim} is {args[prim]}")
    # pick against the rows
    if "pick" in slots:
        ok = {n for n, why in slots["pick"] if why is None}
        have = set()
        for h in handles_of(args.get("rows") or args.get("row")):
            have |= set(rows_of(ctx, h) or [])
        if ok != have:
            bad.append(f"pick ok {sorted(ok)} vs rows {sorted(have)}")
    # when present iff the call carries a date
    dv = date_values(args)
    if bool(dv) != ("when" in slots):
        bad.append("when slot " + ("missing" if dv else "on a call without a date"))
    # every quote is a span of the user's own words
    said = fold(ctx.message).replace('"', "'")
    earlier = " | ".join(fold(t) for _n, t in ctx.user_msgs[:-1]).replace('"', "'")
    quotes = list(slots.get("target", [])) + [v[1] for k, v in slots.items() if k in ("intent", "scope", "refer") and v[1]]
    for s in quotes:
        if fold(s).replace('"', "'") not in said:
            bad.append(f"span not in the message: {s!r}")
    w = slots.get("when")
    if w and w[0] == "q" and fold(w[1]).replace('"', "'") not in said:
        bad.append(f"when span not in the message: {w[1]!r}")
    if w and w[0] == "e" and w[1] and fold(w[1]).replace('"', "'") not in earlier:
        bad.append(f"when span not in an earlier message: {w[1]!r}")
    return bad


def sources(call: dict, history: list[dict], today: str | None = None, ahead=None) -> list[tuple[str, str]]:
    """Call arguments with no source (the generator's own account, recomputed)."""
    return derive_trace(call, history, today, False, ahead).unsourced


def trace_messages(msgs: list[dict], today: str | None = None, strict: bool = True) -> dict[int, "Trace"]:
    """The trace of every assistant message of a record (index -> Trace). A message marked `loss: False`
    is a deliberate rejected call; `retry` is set on the call that follows it in the same turn."""
    out: dict[int, Trace] = {}
    prev_bad = False
    for i, m in enumerate(msgs):
        if m["role"] == "user":
            prev_bad = False
        if m["role"] != "assistant":
            continue
        bad = m.get("loss") is False
        out[i] = derive_trace({"tool": m["tool"], "args": m["args"]}, msgs[:i], today, prev_bad, msgs[i + 1:], bad=bad, strict=strict)
        prev_bad = bad
    return out
