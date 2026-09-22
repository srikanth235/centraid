# -*- coding: utf-8 -*-
"""Realise authored paraphrase TEMPLATES for every skeleton.

The surface strings all come from surface.py (authored by hand); this module
only assembles them and applies register.  Output: paraphrase.jsonl, one row
per (skeleton, register, variant).

    python3 paraphrase.py
"""
import json
import os
import random
import re
import sys

import surface as S

HERE = os.path.dirname(os.path.abspath(__file__))

# --------------------------------------------------------------------------
# turn frames -- authored
# --------------------------------------------------------------------------
SHOW = {
    "terse": ["{NP}?", "{NP}", "list {NP}", "{NP} pls"],
    "natural": ["what {NP} have I got?", "show me {NP}", "can I see {NP}?",
                "which {NP} do I have?", "pull up {NP}", "let me see {NP}",
                "what have I got in the way of {NP}?", "find me {NP}",
                "have a look for {NP}"],
    "polite": ["could you show me {NP}, please?", "would you mind pulling up {NP}?",
               "if you could list {NP} that would be great",
               "sorry, could I see {NP}?", "when you get a sec, {NP} please"],
    "spoken": ["umm so like, {NP}?", "right so, show me {NP} would you",
               "ok so what I'm after is {NP}", "erm... {NP}, please",
               "yeah so, can you find {NP}", "hang on — {NP}, show me those"],
    "imperative": ["show {NP}", "list {NP}", "give me {NP}", "bring up {NP}",
                   "get me {NP}"],
    "elliptical": ["and {NP}?", "what about {NP}?", "ok and {NP}", "{NP} too?",
                   "now {NP}", "same for {NP}?"],
}
COUNT = {
    "terse": ["how many {NP}?", "count {NP}", "{NP} — how many?"],
    "natural": ["how many {NP} are there?", "how many of {NP} have I got?",
                "what's the count on {NP}?", "give me a number for {NP}"],
    "polite": ["could you tell me how many {NP} there are?",
               "would you mind counting {NP} for me?"],
    "spoken": ["umm, how many {NP} is that?", "so like, how many {NP}?",
               "right, count those — {NP} I mean"],
    "imperative": ["count {NP}", "tell me how many {NP}"],
    "elliptical": ["and how many of those?", "how many though?",
                   "ok but how many {NP}?"],
}
SUM = {
    "terse": ["total {F} for {NP}?", "{F} total, {NP}?"],
    "natural": ["how much {F} across {NP}?", "what do {NP} come to in {F}?",
                "add up the {F} on {NP}", "what's the combined {F} of {NP}?"],
    "polite": ["could you total the {F} for {NP}?",
               "would you add up the {F} on {NP} for me?"],
    "spoken": ["so like what's the whole {F} for {NP}", "umm, total {F}, {NP}?"],
    "imperative": ["total the {F} on {NP}", "sum the {F} of {NP}"],
    "elliptical": ["and the total?", "what's that come to?", "total for those?"],
}
MINMAX = {
    "min": {
        "terse": ["smallest {F} in {NP}?", "lowest {F}, {NP}?"],
        "natural": ["what's the smallest {F} among {NP}?",
                    "which of {NP} has the earliest {F}?",
                    "what's the lowest {F} across {NP}?"],
        "polite": ["could you find the smallest {F} in {NP}?"],
        "spoken": ["umm, what's the smallest {F} out of {NP}"],
        "imperative": ["find the lowest {F} in {NP}"],
        "elliptical": ["and the smallest?", "which is the earliest of those?"],
    },
    "max": {
        "terse": ["biggest {F} in {NP}?", "highest {F}, {NP}?"],
        "natural": ["what's the biggest {F} among {NP}?",
                    "which of {NP} has the latest {F}?",
                    "what's the highest {F} across {NP}?"],
        "polite": ["could you find the largest {F} in {NP}?"],
        "spoken": ["so like, the biggest {F} out of {NP}, what is it"],
        "imperative": ["find the highest {F} in {NP}"],
        "elliptical": ["and the biggest?", "which is the latest of those?"],
    },
}
PROJECT = {
    "terse": ["{F} of {NP}?", "{NP} — {F}?"],
    "natural": ["what's the {F} of {NP}?", "tell me the {F} for {NP}",
                "what {F} does {NP} have?", "remind me of the {F} on {NP}"],
    "polite": ["could you tell me the {F} for {NP}?",
               "would you mind checking the {F} of {NP}?"],
    "spoken": ["umm what's the {F} on {NP} again", "so like, {F} for {NP}?"],
    "imperative": ["give me the {F} of {NP}", "read me the {F} for {NP}"],
    "elliptical": ["and the {F}?", "what's its {F}?", "{F}?"],
}
BALANCE = {
    "terse": ["balance with {WHO} in {WHERE}?", "{WHO} in {WHERE} — where are we?"],
    "natural": ["how do I stand with {WHO} in {WHERE}?",
                "what's my balance with {WHO} in {WHERE}?",
                "how much do I owe {WHO} in {WHERE}?",
                "are {WHO} square with me in {WHERE}?"],
    "polite": ["could you tell me where I stand with {WHO} in {WHERE}?"],
    "spoken": ["umm so who owes who in {WHERE} — {WHO} I mean"],
    "imperative": ["work out the balance for {WHO} in {WHERE}"],
    "elliptical": ["and the balance?", "where does that leave us in {WHERE}?"],
}
SAME = {
    "terse": ["{A} — same as {B}?", "same {sing}?"],
    "natural": ["is {A} the same {sing} as {B}?",
                "are {A} and {B} the same {sing}?",
                "is that the same {sing} as {B}?",
                "do {A} and {B} point at the same {sing}?"],
    "polite": ["could you check whether {A} and {B} are the same {sing}?"],
    "spoken": ["umm is that, like, the same {sing} as {B}?",
               "hang on — is {A} the same one as {B}?"],
    "imperative": ["check if {A} and {B} are the same {sing}"],
    "elliptical": ["same one?", "is that the same {sing}?"],
}
CMD_WRAP = {
    "terse": ["{C}"],
    "natural": ["{C}", "can you {C}", "I need to {C}", "{C} for me"],
    "polite": ["could you {C}, please?", "would you mind if we {C}?",
               "please {C} when you get a moment", "sorry — could you {C}?"],
    "spoken": ["umm, {C}", "right so, {C}", "yeah just {C}",
               "ok so like, {C} would you"],
    "imperative": ["{C}", "{C}, now", "just {C}"],
    "elliptical": ["{C}", "actually, {C}", "and {C}"],
}
SEQ_FRAMES = ["{A}, then {B}", "{A} and then {B}", "{A} — and {B} after that",
              "{A}. after that, {B}", "first {A}, then {B}",
              "{A}, and once that's done {B}",
              "{A} and {B} while you're at it",
              "can you {A}, and then {B}",
              "{A}; {B} too",
              "umm, {A}, oh and {B}",
              "right — {A}, and {B}",
              "{A}. and the other thing: {B}",
              "I need two things: {A}, and {B}",
              "{A}, followed by {B}"]

# C1: "due" / "overdue" / "outstanding" carries `status != completed` beside
# its window, because a completed task is not due.  {W} is the window word.
DUE = {
    "terse": ["what's due {W}?", "due {W}?", "open jobs {W}?"],
    "natural": ["what's due {W}?", "what have I got due {W}?",
                "what's still open {W}?", "what's outstanding {W}?",
                "anything due {W}?", "what's left to do {W}?",
                "what's on my plate {W}?"],
    "polite": ["could you tell me what's due {W}?",
               "would you mind showing me what's still open {W}?"],
    "spoken": ["umm what've I got due {W}", "so like, what's outstanding {W}?",
               "right, what's still to do {W}"],
    "imperative": ["show me what's due {W}", "list what's still open {W}"],
    "elliptical": ["and {W}?", "what about {W}?", "anything {W}?"],
}
OUTSTANDING = {
    "terse": ["what's unsettled {W}?", "outstanding {W}?"],
    "natural": ["what debts are still outstanding {W}?",
                "what hasn't been settled {W}?",
                "who still owes me {W}?", "what's unpaid {W}?"],
    "polite": ["could you show me what's still outstanding {W}?"],
    "spoken": ["umm what's still owing {W}", "so like, what's unsettled {W}?"],
    "imperative": ["list what's unsettled {W}", "show the outstanding debts {W}"],
    "elliptical": ["and {W}?", "what's left {W}?"],
}
# C3: "what's on <weekday>" means the calendar AND the board AND the birthday
# that is on neither.
ONDAY = {
    "terse": ["what's on {W}?", "{W}?", "anything {W}?"],
    "natural": ["what's on {W}?", "what have I got {W}?",
                "what's happening {W}?", "what's my day look like {W}?",
                "anything I should know about {W}?", "what's in store {W}?"],
    "polite": ["could you tell me what's on {W}?",
               "would you mind running through {W} for me?"],
    "spoken": ["umm so what's on {W}", "right, {W} — what have I got?",
               "yeah so like, what's happening {W}"],
    "imperative": ["run through {W}", "show me {W}"],
    "elliptical": ["and {W}?", "what about {W}?"],
}

# A narrowing turn inside a chain: the member is not naming the board again,
# they are cutting down what is already on screen.  Authored separately from
# SHOW because "them called X" is not how anyone narrows a list out loud.
NARROW = {
    "called": ['just the ones called "{L}"', 'only the "{L}" one',
               'narrow that to "{L}"', 'of those, the "{L}" one',
               'which of them is called "{L}"?', 'just "{L}" out of that lot',
               'the "{L}" one please', 'drop everything but "{L}"'],
    "filter": ["just the ones {P}", "of those, the ones {P}",
               "narrow that down to the ones {P}", "only the ones {P}",
               "and which of those are the ones {P}?",
               "cut that down to the ones {P}", "keep the ones {P}"],
    "during": ["just the ones {W}", "only {W} though", "of those, the ones {W}",
               "narrow that to {W}", "{W} only", "and which of those are {W}?"],
    "order": ["sort that lot — {O}", "put those {O}", "re-sort: {O}",
              "can you give me those {O}", "and {O} please"],
    "first": ["just the first {N}", "only the top {N}",
              "cut that to {N}", "give me {N} of those"],
}


def narrow(op_node, kind, rng):
    """Realise one narrowing step over the rows already on screen."""
    op = op_node["op"]
    frame = rng.choice(NARROW[op])
    if op == "called":
        return articles(frame.replace("{L}", "{%s}" % op_node["slot"]))
    if op == "filter":
        return articles(frame.replace(
            "{P}", pred_phrase(op_node["pred"], rng, kind)))
    if op == "during":
        return articles(frame.replace(
            "{W}", window_word(op_node["window"], rng, kind)))
    if op == "order":
        phrase = rng.choice(S.ORDER[op_node["dir"]]).replace(
            "{field}", field_word(op_node["field"], rng))
        return articles(frame.replace("{O}", phrase))
    return articles(frame.replace("{N}", "{SMALL}"))


# --------------------------------------------------------------------------
# negatives -- authored
# --------------------------------------------------------------------------
REFUSE_UTTERANCES = {
    "out_of_ontology": [
        'text "{PERSON}" and tell them I\'m running late',
        'email "{PERSON}" the "{DOC}" document',
        "what's the weather doing at {PLACE} this weekend?",
        "ring {PERSON} for me",
        "book me a table somewhere near {PLACE} on {DATE}",
        "what's in the news this morning?",
        'order another one of those from the shop',
        "send {PERSON} a message asking about the {EVENT}",
        "call the number you just showed me",
        "post that photo to my feed",
        "can you check the traffic before the {EVENT}?",
        "buy the tickets for {EVENT}",
        "translate the {DOC} document into French and email it over",
        "what's the exchange rate today?",
        "set an alarm on my phone for {DATETIME}",
        "umm can you just ping {PERSON} about it",
        "pay {PERSON} the {AMOUNT} through my bank",
        "look up {PLACE} on a map for me",
    ],
    "sealed_egress": [
        'read me the password for "{LOCKER}"',
        'email the "{LOCKER}" login to {PERSON}',
        "export everything in my locker to a file",
        'copy the password from "{LOCKER}" and send it over',
        "dump all my saved credentials somewhere I can read them",
        'text {PERSON} the code from "{LOCKER}"',
        "put my locker contents in a document",
        "share the whole locker with {PERSON}",
    ],
    "fabricated_secret": [
        'save a login for "{LOCKER}" — make up a password',
        'add "{LOCKER}" to the locker, you pick the password',
        'create a card entry for "{LOCKER}" with whatever number works',
        "set a new password on {LOCKER}, anything will do",
    ],
    "unbounded_destruction": [
        "delete every note in the vault",
        "wipe all my photos",
        "get rid of all my tasks",
        "empty the whole vault",
        "delete everything",
        "remove all my contacts",
        "bin every document I've got",
        "just clear the lot",
    ],
}
NOTHING_UTTERANCES = [
    "actually, forget it", "no, never mind", "scrap that",
    "ignore me, wrong thing", "sorry, cancel that", "don't bother",
    "hold on — no, leave it", "umm actually no, skip it",
    "nah forget I asked", "cancel — I'll do it myself",
    "no no, leave that alone", "on second thoughts don't",
    "wait, stop", "don't do that", "undo that, sorry",
    "no — wrong one, leave it", "actually I'll leave it as it is",
    "erm, forget I said anything", "skip it", "leave it be",
    "no, that's not what I wanted — drop it", "cancel please",
    "belay that", "sorry, I changed my mind", "nope, back out of that",
    "hmm no, don't", "abort", "actually don't bother with that",
    "leave it for now", "forget that last bit",
]
UNPARSED_UTTERANCES = [
    "asdkjh askjdh", "the the the and", "??", "blorp the frimbulator",
    "yes but only if the moon", "xxxx", "can you the?",
    "aaaaaaa", "qwerty qwerty", "...", "gsdfg sdfg sdf",
    "under the over the through", "mm", "12345 67890",
    "widget the widget widgetly", "hnnng", "when where why what",
    "purple the seventeen sideways", "!!!!", "ok so umm",
]

# --------------------------------------------------------------------------
# realisation
# --------------------------------------------------------------------------
POSTMOD_HEADS = {"that", "which", "where", "with", "without", "in", "from",
                 "about", "mentioning", "still", "I", "I've", "I'm", "other",
                 "only", "whose", "having", "marked", "set", "flagged",
                 "they", "no"}


def postmod(text):
    head = text.split()[0]
    if head in POSTMOD_HEADS:
        return text
    return "that are " + text


def field_word(field, rng):
    return rng.choice(S.FIELD.get(field, [field.replace("_", " ")]))


def value_word(value, rng):
    return rng.choice(S.VALUE.get(value, [value]))


# `before now` is the overdue comparison, and only a row that carries an
# obligation to act can BE overdue: a task, a debt, a date that was meant to
# come round.  A document or a photograph with a stamp before today is simply
# old, and calling it overdue is a wrong reading, not a rough one.
OVERDUE_KINDS = {"tasks", "obligations", "important dates", "events", "things"}
STALE_WORDS = ["from before today", "older than today", "dated before today",
               "from earlier than today"]


def window_word(window, rng, host=None):
    text, how = window
    if how == "anchored":
        return rng.choice(S.ANCHORED_WORDS)
    if text == "before now" and host is not None and host not in OVERDUE_KINDS:
        return rng.choice(STALE_WORDS)
    return rng.choice(S.WINDOW[text])


def pred_phrase(pred, rng, host=None):
    tag = pred["p"]
    if tag == "contains":
        slot = "{%s}" % pred["slot"]
        return rng.choice([
            'mentioning "%s"' % slot,
            'about "%s"' % slot,
            'with "%s" in the %s' % (slot, field_word(pred["field"], rng)),
            'that say "%s" somewhere' % slot,
        ])
    if tag == "oneof":
        a, b = (value_word(v, rng) for v in pred["lits"][:2])
        return rng.choice(["that are either %s or %s" % (a, b),
                           "that are %s or %s" % (a, b)])
    if tag == "pwindow":
        word = window_word(pred["window"], rng, host)
        field = field_word(pred["field"], rng)
        if word in ("overdue", "already overdue", "past their date"):
            return "that are %s" % word
        return rng.choice(["with a %s %s" % (field, word),
                           "whose %s is %s" % (field, word),
                           "where the %s is %s" % (field, word)])
    if tag == "band":
        field = field_word(pred["field"], rng)
        return rng.choice(["of about {NUM} in %s" % field,
                           "that are roughly {NUM} in %s" % field,
                           "with a %s around {NUM}" % field])
    if tag == "is":
        field = field_word(pred["field"], rng)
        if pred["what"] == "me":
            return ("that aren't mine" if pred["not"] else "that are mine")
        if pred["not"]:
            return rng.choice(["that have a %s" % field,
                               "where the %s is filled in" % field])
        return rng.choice(["with no %s" % field,
                           "where the %s is blank" % field,
                           "missing a %s" % field])
    if tag == "countwalk":
        bank = S.COUNTWALK.get((pred["kind"], host))
        if bank and bank.get(pred["op"]):
            return rng.choice(bank[pred["op"]]).replace("{N}", "{SMALL}")
        noun = rng.choice(S.BOARD[pred["kind"]])
        word = {"=": "exactly", ">": "more than"}[pred["op"]]
        return "with %s {SMALL} %s" % (word, noun)
    if tag == "member":
        return rng.choice(['in the "{%s}" %s' % (pred["slot"], S.SING[pred["kind"]]),
                           'that belong to "{%s}"' % pred["slot"]])
    if tag == "cmp":
        how, value = pred["rhs"]
        field = field_word(pred["field"], rng)
        if how == "lit":
            word = value_word(value, rng)
            if pred["op"] == "=":
                return postmod(word)
            return rng.choice(["that aren't %s" % word,
                               "other than the ones %s" % word])
        if how == "kw" and value in ("true", "false"):
            table = S.FLAG_TRUE if value == "true" else S.FLAG_FALSE
            return postmod(rng.choice(table.get(pred["field"], [field])))
        if how == "field":
            key = (pred["field"], value, pred["op"])
            if key in S.PAIR:
                return rng.choice(S.PAIR[key])
            return "where the %s matches the %s" % (field, field_word(value, rng))
        if how == "date":
            word = {"<": "before", ">": "after", "=": "on",
                    "<=": "on or before", ">=": "on or after"}[pred["op"]]
            return "with a %s %s {DATE}" % (field, word)
        if how == "num":
            word = {"<": "under", ">": "over", "=": "of exactly",
                    "<=": "at most", ">=": "at least"}[pred["op"]]
            return "with a %s %s {NUM}" % (field, word)
    if tag in ("and", "or"):
        return "%s %s %s" % (pred_phrase(pred["left"], rng, host), tag,
                             pred_phrase(pred["right"], rng, host))
    if tag == "not":
        return "that aren't %s" % pred_phrase(pred["pred"], rng, host)
    raise AssertionError(tag)


def np(node, rng, head=None):
    """A noun phrase for a set expression."""
    op = node["op"]
    if op == "kind":
        return rng.choice(S.BOARD[node["kind"]])
    if op == "ref":
        return rng.choice(S.REF_WORDS[node["ref"]])
    if op == "walk":
        inner = np(node["from"], rng)
        key = (node["kind"], head_kind(node["from"]))
        frames = S.WALK.get(key)
        if not frames:
            frames = ["the %s for {inner}" % rng.choice(S.BOARD[node["kind"]])]
        return rng.choice(frames).replace("{inner}", inner)
    if op == "called":
        k = head_kind(node["set"])
        base = node["set"]
        frame = rng.choice(S.CALLED)
        text = (frame.replace("{sing}", S.SING[k])
                     .replace("{plural}", rng.choice(S.BOARD[k]))
                     .replace("{L}", "{%s}" % node["slot"]))
        if base["op"] != "kind":
            # a named set over something already modified: keep one head noun
            return '%s called "{%s}"' % (np(base, rng), node["slot"])
        return text
    if op == "filter":
        return "%s %s" % (np(node["set"], rng),
                          pred_phrase(node["pred"], rng, head_kind(node["set"])))
    if op == "during":
        return "%s %s" % (np(node["set"], rng),
                          window_word(node["window"], rng,
                                      head_kind(node["set"])))
    if op == "order":
        return "%s %s" % (np(node["set"], rng),
                          rng.choice(S.ORDER[node["dir"]]).replace(
                              "{field}", field_word(node["field"], rng)))
    if op == "first":
        return "%s %s" % (rng.choice(S.FIRST).replace("{n}", "{SMALL}"),
                          np(node["set"], rng))
    if op == "union":
        return rng.choice(["%s and %s", "both %s and %s", "%s plus %s"]) % (
            np(node["left"], rng), np(node["right"], rng))
    if op == "except":
        return rng.choice(["%s but not %s", "%s apart from %s", "%s except %s",
                           "%s minus %s"]) % (np(node["left"], rng),
                                              np(node["right"], rng))
    raise AssertionError(op)


def head_kind(node):
    op = node["op"]
    if op in ("kind", "walk"):
        return node["kind"]
    if op in ("called", "filter", "during", "order", "first"):
        return head_kind(node["set"])
    if op in ("union", "except"):
        return head_kind(node["left"])
    return node.get("assume")


# --------------------------------------------------------------------------
# a / an.  The clause fragments are authored without knowing what follows
# them, so the article is fixed once the sentence exists.  Spelling, not
# sound, with the short list of words English disagrees with itself about.
AN_ANYWAY = ("hour", "honest", "honour", "heir")
A_ANYWAY = ("uni", "use", "user", "usual", "utili", "one", "euro", "ewe")


def _article(word):
    lower = word.lower()
    if lower.startswith(AN_ANYWAY):
        return "an"
    if lower.startswith(A_ANYWAY):
        return "a"
    return "an" if lower[:1] in "aeiou" else "a"


_ARTICLE_RE = re.compile(r"\b([Aa])n?\s+([A-Za-z][\w'-]*)")


def articles(text):
    """Fix `a`/`an` across a realised utterance, outside quotes and slots."""
    parts = re.split(r'("[^"]*"|\{[A-Z0-9]+\})', text)
    for index, part in enumerate(parts):
        if part.startswith('"') or part.startswith("{"):
            continue

        def fix(match):
            head, word = match.group(1), match.group(2)
            form = _article(word)
            if head == "A":
                form = form.capitalize()
            return "%s %s" % (form, word)

        parts[index] = _ARTICLE_RE.sub(fix, part)
    return "".join(parts)


# --------------------------------------------------------------------------
# typos: real transpositions and drops, never inside a {SLOT}
# --------------------------------------------------------------------------
def typo(text, rng):
    parts = re.split(r"(\{[A-Z0-9]+\})", text)
    for _ in range(rng.randint(1, 2)):
        indexes = [i for i, p in enumerate(parts)
                   if not p.startswith("{") and len(p.strip()) > 6]
        if not indexes:
            break
        index = rng.choice(indexes)
        chunk = list(parts[index])
        spots = [i for i, c in enumerate(chunk) if c.isalpha()]
        if len(spots) < 3:
            continue
        spot = rng.choice(spots[:-1])
        style = rng.random()
        if style < 0.45 and spot + 1 < len(chunk) and chunk[spot + 1].isalpha():
            chunk[spot], chunk[spot + 1] = chunk[spot + 1], chunk[spot]   # swap
        elif style < 0.8:
            del chunk[spot]                                               # drop
        else:
            chunk.insert(spot, chunk[spot])                               # double
        parts[index] = "".join(chunk)
    return "".join(parts)


# --------------------------------------------------------------------------
# per-skeleton realisation
# --------------------------------------------------------------------------
# Eleven slots so a skeleton gets an even spread, with the two registers a
# real corpus has most of (plain natural speech, and typos) doubled.
REGISTERS = ["terse", "natural", "polite", "spoken", "imperative",
             "elliptical", "typo", "natural", "terse", "spoken", "typo"]


def frames_for(row):
    parts = row["parts"]
    turn = row["turn"]
    if turn == "show":
        convention = parts.get("convention")
        if convention == "C1":
            frames = DUE if parts["kind"] == "tasks" else OUTSTANDING
            return frames, {"W": parts["set"]["window"]}
        if convention == "C3":
            return ONDAY, {"W": parts["set"]["window"]}
        return SHOW, {"NP": parts["set"]}
    if turn == "value":
        agg = parts["agg"]
        if agg == "count":
            return COUNT, {"NP": parts["set"]}
        if agg == "sum":
            return SUM, {"NP": parts["set"], "F": parts["field"]}
        if agg in ("min", "max"):
            return MINMAX[agg], {"NP": parts["set"], "F": parts["field"]}
        if agg == "project":
            return PROJECT, {"NP": parts["set"], "F": parts["field"]}
        if agg == "balance":
            return BALANCE, {"WHO": parts["set"], "WHERE": parts["in"]}
    if turn == "same":
        return SAME, {"A": parts["left"], "B": parts["right"]}
    return None, None


def realise(row, rng, register):
    turn = row["turn"]
    if turn in ("cmd", "seq", "refuse", "nothing"):
        return realise_write(row, rng, register)
    frames, slots = frames_for(row)
    if frames is None:
        return None
    pool = frames.get(register) or frames["natural"]
    text = rng.choice(pool)
    for key, node in slots.items():
        if key in ("NP", "A", "B", "WHO", "WHERE"):
            text = text.replace("{%s}" % key, np(node, rng))
        elif key == "W":
            text = text.replace("{W}", window_word(node, rng))
        else:
            text = text.replace("{F}", field_word(node, rng))
    if "{F}" in text:
        text = text.replace("{F}", field_word(slots.get("F", "title"), rng))
    if "{sing}" in text:
        kind = row["parts"].get("kind") or "thing"
        text = text.replace("{sing}", S.SING.get(kind, "thing"))
    return text


def command_clause(step, rng):
    gloss, kind = step["gloss"], step["kind"]
    bank = S.VERB.get(gloss)
    if isinstance(bank, dict):
        options = bank.get(kind)
        if not options:
            return None
        return rng.choice(options)
    if not bank:
        return None
    anchor = np(step["set"], rng) if step["set"] else ""
    return rng.choice(bank).replace("{NP}", anchor)


def realise_write(row, rng, register):
    turn = row["turn"]
    if turn == "refuse":
        return rng.choice(REFUSE_UTTERANCES[row["parts"]["reason"]])
    if turn == "nothing":
        return rng.choice(NOTHING_UTTERANCES)
    if turn == "seq":
        left = command_clause(row["parts"]["steps"][0], rng)
        right = command_clause(row["parts"]["steps"][1], rng)
        if not left or not right:
            return None
        return rng.choice(SEQ_FRAMES).replace("{A}", left).replace("{B}", right)
    clause = command_clause(row["parts"], rng)
    if not clause:
        return None
    pool = CMD_WRAP.get(register) or CMD_WRAP["natural"]
    return rng.choice(pool).replace("{C}", clause)


def needs_prev(row, register):
    text = row["canonical"]
    for ref in ("it", "them", "the other one", "the earlier one",
                "the last thing I added", "the 2nd one", "the 3rd one"):
        if re.search(r"(?<![\w\"])%s(?![\w\"])" % re.escape(ref), text):
            return True
    return register == "elliptical" or row["turn"] == "nothing"


def main():
    rows = json.load(open(os.path.join(HERE, "skeletons.json")))
    out, seen = [], set()
    counter = 0
    for row in rows:
        rng = random.Random(row["skel_id"])
        wanted = 11
        if row["turn"] in ("refuse", "nothing"):
            wanted = 40
        tries = 0
        made = 0
        while made < wanted and tries < wanted * 6:
            tries += 1
            register = REGISTERS[tries % len(REGISTERS)]
            base_register = "natural" if register == "typo" else register
            text = realise(row, rng, base_register)
            if not text:
                break
            text = articles(text)
            if register == "typo":
                text = typo(text, rng)
            key = (row["canonical"], text)
            if key in seen:
                continue
            seen.add(key)
            counter += 1
            out.append({
                "template_id": "t%06d" % counter,
                "skel_id": row["skel_id"],
                "family": row["family"],
                "turn": row["turn"],
                "canonical": row["canonical"],
                "utterance": text,
                "register": register,
                "needs_prev": needs_prev(row, register),
            })
            made += 1
    # nonsense: honest Unparsed, not a guess
    for index, text in enumerate(UNPARSED_UTTERANCES):
        counter += 1
        out.append({"template_id": "t%06d" % counter, "skel_id": "sk_unparsed",
                    "family": "unparsed|nonsense", "turn": "unparsed",
                    "canonical": "Unparsed", "utterance": text,
                    "register": "nonsense", "needs_prev": False})
    path = os.path.join(HERE, "paraphrase.jsonl")
    with open(path, "w") as handle:
        for item in out:
            handle.write(json.dumps(item) + "\n")
    registers = {}
    for item in out:
        registers[item["register"]] = registers.get(item["register"], 0) + 1
    print("paraphrase templates : %d" % len(out))
    print("skeletons covered    : %d" % len({i["skel_id"] for i in out}))
    print("by register          : %s" % dict(sorted(registers.items())))
    print("follow-up templates  : %d" % sum(1 for i in out if i["needs_prev"]))


if __name__ == "__main__":
    main()
