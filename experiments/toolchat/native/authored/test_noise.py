"""Tests of the message noise: authored/noise.py, eval/perturb.py and `authored/build.py --augment`.

    python3 -m unittest authored/test_noise.py        # from experiments/toolchat/native; no runtime needed
    NOISE_INTEGRATION=1 NATIVETOOLS=... EVAL_VAULTS=... python3 -m unittest authored.test_noise.Integration
        # builds a few T01 sessions with --augment through the runtime (the interpreter that runs build.py: torch)

The messages here are our own. Nothing reads eval/sets, eval/sessions, eval/worlds or data/.
"""
from __future__ import annotations

import collections
import copy
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
EVAL = NATIVE / "eval"
sys.path.insert(0, str(HERE))
import noise  # noqa: E402

CORPUS = [
    "what's on friday", "whats due this weekend", "move the dentist to tuesday at 3", "push it to next monday",
    "how much does priya owe me", "star the kitchen fitting", "delete the old photos", "undo that", "what's left on my list",
    "any tasks overdue", "add milk to the shopping list", "mark the boiler service as done",
    "tick off the council tax, paid it on my lunch", "can you rename the budget note to household budget please",
    "who's coming to the barbecue on saturday", "what's in the trash", "what's the wifi password", "show me the router password",
    "text jordan that i'm running late", "forget it", "never mind, i'll do it later", "actually no, leave it", "yes", "go ahead",
    "all of them", "ok so delete everything on the list", "what else is on besides the dentist", "everything except the invoices",
    "the 25th of november", "end of march", "3pm tomorrow", "from monday to wednesday next week", "how many tasks are open",
    "what's my balance with him", "what do i owe her", "my share of the trip", "move the folder to archive", "that album",
    'add "pay the rent" to my tasks', "email me at sam.park@example.com", "it costs 40 pounds a month", "twenty quid for the plumber",
    "log a call with mum", "quick one, what's today", "could you tell me which events are cancelled", "hey, can you add a reminder for the bins",
    "settle up with the neighbour for the fence", "which documents are in the taxes folder", "rename the holiday album to summer 2025",
    "what time is the physio appointment on thursday", "give me the biggest expense this month", "restore the invoice i deleted",
    "who did i speak to last week", "put the reunion in the diary for saturday at 6", "i need to book the boiler engineer before december",
    "which of those are still open", "and the one after", "wifi pw?", "tick it off", "thanks", "ok", "remind me to water the plants every sunday",
    "what's the total of my grocery receipts for last month", "reschedule the haircut to the 14th", "star the second one",
]
PROTECTED_BRIEF = set("""next last this weekend week today tomorrow tonight all every both else besides apart except due open done
finished overdue still left remaining trash delete undo never mind monday tuesday wednesday thursday friday saturday sunday january
february march april may june july august september october november december pounds quid dollars euros""".split())

WORLD = {
    "me": "Sam Park",
    "people": [{"key": "priya_n", "name": "Priya Nair", "role": "nurse"}, {"key": "priya_s", "name": "Priya Shah", "role": "teacher"},
               {"key": "meera", "name": "Meera Iyer", "nickname": "Mimi"}, {"key": "mira", "name": "Mira Iyengar"},
               {"key": "kwame", "name": "Kwame Mensah"}, {"key": "kwabena", "name": "Kwabena Owusu"},
               {"key": "gemma", "name": "Gemma Wells"}, {"key": "gemma2", "name": "Emma Wells"},
               {"key": "ruth", "name": "Ruth Okafor"}, {"key": "ruben", "name": "Ruben Okafor"}],
    "groups": [{"key": "trip", "name": "Lisbon Easter Trip"}], "lists": [{"key": "shop", "name": "Shopping"}],
    "events": [{"key": "dentist", "name": "Dentist"}, {"key": "fitting", "name": "Kitchen fitting starts"}],
    "tasks": [{"key": "tax", "name": "Pay council tax"}, {"key": "tiles", "name": "Order tiles"}],
    "notebooks": [{"key": "work", "name": "Work Notes"}], "notes": [{"key": "bud", "name": "Household budget"}],
    "folders": [{"key": "taxes", "name": "Taxes"}], "documents": [{"key": "inv", "name": "Invoice 2025"}],
    "albums": [{"key": "kids", "name": "Kids"}], "photos": [], "debts": [{"key": "d1", "name": "canteen lunch"}],
    "locker": [{"key": "wifi", "name": "Mum's wifi"}],
}
NAMES = noise.names_of_world(WORLD)


def lev(a: str, b: str) -> int:
    """An independent edit distance (the module has its own)."""
    d = [[i + j if i * j == 0 else 0 for j in range(len(b) + 1)] for i in range(len(a) + 1)]
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] != b[j - 1]))
    return d[-1][-1]


def words(text: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9']+", text)


class Determinism(unittest.TestCase):
    def test_same_arguments_same_result(self):
        for m in CORPUS:
            for level in noise.LEVELS:
                self.assertEqual(noise.perturb(m, NAMES, 7, level), noise.perturb(m, NAMES, 7, level), m)

    def test_other_seeds_and_levels_give_other_results(self):
        outs = {noise.perturb("tick off the council tax, paid it on my lunch", NAMES, s, "heavy")[0] for s in range(30)}
        self.assertGreater(len(outs), 10)
        self.assertNotEqual({noise.perturb(m, NAMES, 1, "light")[0] for m in CORPUS}, {noise.perturb(m, NAMES, 1, "heavy")[0] for m in CORPUS})

    def test_independent_of_the_process_and_of_hash_randomisation(self):
        code = ("import sys, json; sys.path.insert(0, %r); import noise; "
                "print(json.dumps([noise.perturb(m, noise.names_of_world(json.loads(sys.argv[1])), 3, l) for m in json.loads(sys.argv[2]) for l in ('light', 'heavy')]))"
                % str(HERE))
        outs = []
        for hashseed in ("0", "12345"):
            r = subprocess.run([sys.executable, "-c", code, json.dumps(WORLD), json.dumps(CORPUS[:25])], capture_output=True, text=True,
                               env={**os.environ, "PYTHONHASHSEED": hashseed})
            self.assertEqual(r.returncode, 0, r.stderr)
            outs.append(json.loads(r.stdout))
        here = [list(noise.perturb(m, NAMES, 3, l)) for m in CORPUS[:25] for l in ("light", "heavy")]
        self.assertEqual(outs[0], outs[1])
        self.assertEqual(outs[0], json.loads(json.dumps(here)))

    def test_light_is_one_op_and_heavy_two_or_three(self):
        light, heavy = collections.Counter(), collections.Counter()
        for i, m in enumerate(CORPUS):
            light[len(noise.perturb(m, NAMES, i, "light")[1])] += 1
            heavy[len(noise.perturb(m, NAMES, i, "heavy")[1])] += 1
        self.assertEqual(set(light), {1}, light)
        self.assertTrue(set(heavy) <= {1, 2, 3} and heavy[2] + heavy[3] >= len(CORPUS) - 3, heavy)
        self.assertGreater(heavy[3], 0)

    def test_ops_name_what_changed(self):
        for i, m in enumerate(CORPUS):
            text, ops = noise.perturb(m, NAMES, i, "heavy")
            self.assertEqual(text != m, bool(ops), m)
            for op in ops:
                self.assertIn(op["op"], noise.OPS)
                self.assertIsInstance(noise.label(op), str)
            json.dumps(ops)  # plain data

    def test_a_message_no_op_applies_to_comes_back_as_it_was(self):
        self.assertEqual(noise.perturb("", NAMES, 1, "light"), ("", []))
        self.assertEqual(noise.perturb("3pm", NAMES, 1, "heavy"), ("3pm", []))
        self.assertEqual(noise.perturb("12:30?", NAMES, 1, "light"), ("12:30?", []))

    def test_unknown_level_or_op_is_an_error(self):
        with self.assertRaises(ValueError):
            noise.perturb("hi", NAMES, 1, "extreme")
        with self.assertRaises(ValueError):
            noise.perturb("hi there", NAMES, 1, "light", only=["typo", "shout"])


class Protected(unittest.TestCase):
    def protected_sequence(self, text: str) -> list[str]:
        quoted = [(m.start(), m.end()) for m in re.finditer(r'"[^"]*"', text)]
        out = []
        for m in re.finditer(r"[A-Za-z0-9']+", text):
            w = m.group(0).lower()
            if any(c.isdigit() for c in w) or w in PROTECTED_BRIEF or any(a <= m.start() < b for a, b in quoted):
                out.append(w)
        return out

    def test_numbers_dates_convention_words_currency_and_quotes_are_never_touched(self):
        for m in CORPUS:
            for level in noise.LEVELS:
                for seed in range(25):
                    text, _ = noise.perturb(m, NAMES, seed, level)
                    self.assertEqual(self.protected_sequence(m), self.protected_sequence(text), f"{m!r} -> {text!r}")

    def test_the_words_inside_quotes_keep_their_spaces_too(self):
        m = 'add "pay  the rent  now" to my tasks'
        for seed in range(40):
            text, _ = noise.perturb(m, NAMES, seed, "heavy")
            self.assertIn('"pay  the rent  now"', text)

    def test_addresses_and_acronyms_are_left_alone(self):
        for m in ["email me at sam.park@example.com", "send it to sam.park@example.com please", "what does the NHS login say", "open the MOT reminder"]:
            for seed in range(40):
                text, _ = noise.perturb(m, NAMES, seed, "heavy")
                for token in re.findall(r"\S*@\S*|\b[A-Z]{2,}\b", m):
                    self.assertIn(token, text, (m, text))

    def test_decline_cues_and_closed_words_of_the_runtime_are_not_typo_targets(self):
        for word in ["whatsapp", "forward", "message", "invent", "everything", "tomorrow", "overdue", "remaining", "finished", "yesterday",
                     "weekend", "balance", "reschedule", "postpone", "december", "afternoon", "completed", "cancelled", "everything"]:
            self.assertTrue(noise.protected(word), word)
        for seed in range(50):
            for m in ["text jordan that the weekend is overdue", "send everything to the whatsapp group", "invent a password for the router"]:
                text, ops = noise.perturb(m, NAMES, seed, "heavy")
                self.assertFalse([o for o in ops if o["op"] in ("typo", "name") and noise.protected(o["from"].lower())], (m, ops))

    def test_conventions_are_detected_as_before(self):
        sys.path.insert(0, str(EVAL))
        import conventions
        for m in CORPUS:
            want = conventions.detect({"user": m, "ref": [], "gold": []})
            for level in noise.LEVELS:
                for seed in range(15):
                    text, _ = noise.perturb(m, NAMES, seed, level)
                    self.assertEqual(want, conventions.detect({"user": text, "ref": [], "gold": []}), f"{m!r} -> {text!r}")

    def test_what_follows_a_besides_or_except_cue_is_read_as_written(self):
        for m in ["what else is on besides the dentist visit", "everything except the council invoices", "apart from the plumber, who else", "not the second dentist, the first"]:
            for seed in range(40):
                text, _ = noise.perturb(m, NAMES, seed, "heavy", only=["typo", "name", "drop", "fragment"])
                tail = re.split(r"besides|except|apart from|not", m, maxsplit=1)[1]
                self.assertIn(tail.strip().split()[-1], text, (m, text))


class Ops(unittest.TestCase):
    def run_op(self, op, messages, seeds=60, **kw):
        out = []
        for m in messages:
            for seed in range(seeds):
                text, ops = noise.perturb(m, NAMES, seed, "light", only=[op], **kw)
                if ops:
                    out.append((m, text, ops[0]))
        return out

    def test_typo_kinds_and_their_shape(self):
        got = self.run_op("typo", ["move the appointment reminder", "which invoices have no attachment", "show me the longest receipts"])
        kinds = {o["kind"] for _, _, o in got}
        self.assertEqual(kinds, {"swap", "drop", "double", "key"})
        for m, text, o in got:
            a, b = o["from"], o["to"]
            self.assertGreaterEqual(len(a), 5)
            self.assertEqual(a[0], b[0], o)
            self.assertEqual(sorted(words(text.lower())) == sorted(words(m.lower())), False)
            if o["kind"] == "swap":
                self.assertEqual(len(a), len(b))
                self.assertEqual(sum(x != y for x, y in zip(a, b)), 2)
            elif o["kind"] == "drop":
                self.assertEqual(len(b), len(a) - 1)
            elif o["kind"] == "double":
                self.assertEqual(len(b), len(a) + 1)
            else:
                self.assertEqual((len(a), sum(x != y for x, y in zip(a, b))), (len(b), 1))
                qwerty = {k: set(noise._NEIGHBOURS[k]) for k in noise._NEIGHBOURS}
                i = next(i for i in range(len(a)) if a[i] != b[i])
                self.assertIn(b[i].lower(), qwerty[a[i].lower()])
            self.assertEqual(text, m.replace(a, b, 1))

    def test_a_typo_never_lands_on_a_word_the_world_names_or_the_runtime_reads(self):
        index = noise.names_index(NAMES)
        for m, text, o in self.run_op("typo", ["move the appointment reminder", "what does the plumber charge for a callout", "check kitchen fitting invoice"]):
            new = o["to"].lower()
            self.assertFalse(noise.protected(new) or index.like(new), o)
            self.assertFalse(index.like(o["from"].lower()), o)  # and it did not start on a name word either

    def test_a_mention_the_message_already_misspells_takes_no_second_slip(self):
        index = noise.names_index(NAMES)
        self.assertTrue(index.nameish("househlod") and index.nameish("budgte") and not index.nameish("calendar"))
        m = "open the househlod budget note"  # "household" is a name word, one swap off
        for seed in range(60):
            for level in noise.LEVELS:
                text, ops = noise.perturb(m, NAMES, seed, level, only=["typo", "name"])
                self.assertEqual((text, ops), (m, []), (text, ops))
        free = {noise.perturb("what does the calendar invitation say", NAMES, s, "light", only=["typo"])[0] for s in range(40)}
        self.assertGreater(len(free), 3)

    def test_kept_words_are_not_typo_targets(self):
        m = "add pay the plumber to my list"
        for seed in range(60):
            text, ops = noise.perturb(m, NAMES, seed, "heavy", keep=["pay", "plumber"])
            self.assertIn("plumber", text)
        free = {noise.perturb(m, NAMES, s, "light", only=["typo"])[0] for s in range(60)}
        self.assertTrue(any("plumber" not in t for t in free))

    def test_name_typos(self):
        got = self.run_op("name", ["when is priya's lesson", "star the kitchen fitting", "what does ruben owe me", "photos of kwabena", "is gemma free on friday",
                                   "open the household budget", "add the invoice to the taxes folder"], needs=[])
        self.assertGreater(len(got), 20)
        index = noise.names_index(NAMES)
        for m, text, o in got:
            a, b = o["from"].lower(), o["to"].lower()
            self.assertIn(a, index.tokens)
            self.assertEqual(a[0], b[0])
            self.assertGreaterEqual(len(b), 4)
            self.assertFalse(o["kind"] == "swap" and len(a) < 7, o)
            # one edit away (a swap, allowed from seven letters, is two to a plain edit distance)
            self.assertLessEqual(lev(a, b), 2 if o["kind"] == "swap" else 1, o)
            # and read as the same name by the runtime: its fallback reaches it, its disambiguation takes it for the word
            self.assertGreaterEqual(noise.word_score(b, a), 1, o)
            self.assertTrue(noise.near(a, b), o)

    def test_a_name_typo_is_never_closer_to_another_name_than_to_the_original(self):
        index = noise.names_index(NAMES)
        n = 0
        for a in sorted(index.tokens):
            if len(a) < 4 or noise.protected(a):
                continue
            for kind in noise.TYPO_KINDS:
                for b in noise.typo_variants(a, kind):
                    if not index.safe_typo(b.lower(), a):
                        continue
                    n += 1
                    for other in index.tokens:
                        if other == a:
                            continue
                        self.assertGreater(lev(b.lower(), other), lev(b.lower(), a), (a, b, other))
                        self.assertFalse(other.startswith(b.lower()), (a, b, other))  # not the start of another name
                        self.assertNotEqual(other, b.lower())
        self.assertGreater(n, 30)

    def test_close_names_get_no_typo_that_could_be_the_other(self):
        index = noise.names_index(NAMES)
        # meera/mira, kwame/kwabena, gemma/emma, ruth/ruben: a name word is never given as a typo of another
        for a in index.tokens:
            for b in index.tokens:
                if a != b and lev(a, b) <= 2:
                    self.assertFalse(index.safe_typo(b, a), (a, b))
        self.assertFalse(index.safe_typo("mira", "meera"))
        self.assertFalse(index.safe_typo("emma", "gemma"))

    def test_a_name_typo_keeps_the_rows_the_reference_needs_in_the_block(self):
        index = noise.names_index(NAMES)
        # one word names the row: only a word start survives; a name inside a longer one may take any slip
        found = collections.Counter()
        for seed in range(60):
            text, ops = noise.perturb("how much does kwabena owe me", NAMES, seed, "light", only=["name"], needs=["Kwabena Owusu"])
            for o in ops:
                found["kwabena"] += 1
                self.assertIn(index.ids["Kwabena Owusu"], index.grounded(text), (text, o))
                self.assertTrue(noise.near("kwabena", o["to"].lower()))
            text, ops = noise.perturb("star the kitchen fitting", NAMES, seed, "light", only=["name"], needs=["Kitchen fitting starts"])
            for o in ops:
                found["fitting"] += 1
                self.assertIn(index.ids["Kitchen fitting starts"], index.grounded(text), (text, o))
        self.assertGreater(found["kwabena"], 0)
        self.assertGreater(found["fitting"], 0)
        # without the need the same word may leave the block: the runtime's near-spelling fallback has to find the row
        left = 0
        for s in range(60):
            text, ops = noise.perturb("how much does kwabena owe me", NAMES, s, "light", only=["name"], needs=[])
            left += bool(ops) and index.ids["Kwabena Owusu"] not in index.grounded(text)
        self.assertGreater(left, 0)

    def test_a_name_typo_leaves_the_block_roomy(self):
        index = noise.names_index(["Dentist"] * 9 + ["Gym", "Cat sitter"])
        for seed in range(30):
            # nine rows share the name and the reference needs one of them: a slip that keeps them grounded would crowd the block
            text, ops = noise.perturb("move the dentist visit", index, seed, "light", only=["name"], needs=["Dentist"])
            self.assertEqual(ops, [], text)
            # a slip that takes them all out of the block (the reference needs none of them) crowds nothing
            text, ops = noise.perturb("move the dentist visit", index, seed, "light", only=["name"], needs=[])
            self.assertTrue(ops)

    def test_drops(self):
        cases = {"the": "put the milk in the fridge", "a": "give her a star", "my": "star my notes", "to": "send the files to jordan",
                 "of": "what is the name of the dentist", "for": "pay for the skip", "please": "star the kitchen fitting and the plumber visit and the tiles delivery please",
                 "can you": "can you star it", "could you": "could you add a note"}
        self.assertEqual(set(cases), set(noise.DROPPABLE))
        # "please" is a yes word to the runtime: in a short message with no word that holds a yes back it keeps the message a plain yes
        self.assertEqual(noise.perturb("star it please", NAMES, 1, "light", only=["drop"]), ("star it please", []))
        for kind, m in cases.items():
            got = [(text, o) for text, o in (noise.perturb(m, NAMES, s, "light", only=["drop"]) for s in range(60)) if o]
            self.assertTrue(got, m)
            for text, ops in got:
                self.assertEqual(len(ops), 1)
            kinds = {ops[0]["kind"] for _, ops in got}
            self.assertIn(kind, kinds, (m, kinds))
            for text, ops in got:
                dropped = ops[0]["kind"].split()
                left = words(m)
                for w in words(text):
                    left.remove(w)
                self.assertEqual([w.lower() for w in left], dropped, (m, text))
                self.assertNotIn("  ", text)
                self.assertTrue(text == text.strip())

    def test_function_words_beside_dates_numbers_and_conventions_stay(self):
        for m in ["move it to friday", "push it to 3", "the 25th of november", "end of the month", "for tomorrow", "a couple of days", "all of them",
                  "what's the balance", "what's my balance with kwame", "the folder", "that album", "the weekend", "up to saturday", "text the landlord",
                  "in the next week", "for the week", "once a week", "half an hour", "a month ago"]:
            for seed in range(30):
                text, ops = noise.perturb(m, NAMES, seed, "light", only=["drop"])
                self.assertEqual(ops, [], (m, text))

    def test_apostrophe(self):
        got = self.run_op("apostrophe", ["what's on friday", "i'll ask her first", "who's coming", "it's done", "where's my passport", "the plumber's number", "can't you see"])
        self.assertTrue(got)
        seen = {(o["from"], o["to"]) for _, _, o in got}
        self.assertIn(("what's", "whats"), seen)
        self.assertIn(("i'll", "ill"), seen)
        self.assertIn(("plumber's", "plumbers"), seen)
        for m, text, o in got:
            self.assertEqual(text, m.replace(o["from"], o["to"], 1))
        # a possessive on a name, and the cues, keep theirs
        for m in ["when's priya's lesson", "don't delete it", "can't you move it", "kwabena's number"]:
            for seed in range(30):
                text, ops = noise.perturb(m, NAMES, seed, "light", only=["apostrophe"])
                self.assertFalse([o for o in ops if o["from"] in ("priya's", "don't", "can't", "kwabena's")], (m, text))

    def test_capital_period_space_fragment(self):
        for m in ["what's on friday", "move the plumber to monday"]:
            t, ops = noise.perturb(m, NAMES, 1, "light", only=["capital"])
            self.assertEqual(t, m[0].upper() + m[1:])
            t, ops = noise.perturb(m, NAMES, 1, "light", only=["period"])
            self.assertEqual(t, m + ".")
            t, ops = noise.perturb(m, NAMES, 1, "light", only=["space"])
            self.assertEqual(t.replace("  ", " "), m)
            self.assertEqual(t.count("  "), 1)
        for m in ["what's on at 3", "what's on?", "move it to 5.", "Sat?"]:  # a message that ends in a digit or punctuation takes no period
            self.assertEqual(noise.perturb(m, NAMES, 1, "light", only=["period"]), (m, []))
        self.assertEqual(noise.perturb("Already capital", NAMES, 1, "light", only=["capital"]), ("Already capital", []))
        self.assertEqual(noise.perturb('"quoted" first', NAMES, 1, "light", only=["capital"]), ('"quoted" first', []))
        got = [noise.perturb(m, NAMES, s, "light", only=["fragment"]) for m in ["hey what's on friday", "oh just the plumber then", "what's on friday thanks", "hmm i need the invoice"] for s in range(5)]
        self.assertEqual([t for t, o in got[:5]], ["what's on friday"] * 5)
        self.assertEqual(got[5][0], "just the plumber then")
        self.assertEqual(got[10][0], "what's on friday")
        self.assertEqual(got[15][0], "i need the invoice")
        # "ok" is a yes to the runtime: a short message with it is a plain yes, so the guard keeps it; one that holds a yes back may lose it
        self.assertEqual(noise.perturb("ok so move the plumber", NAMES, 1, "light", only=["fragment"]), ("ok so move the plumber", []))
        self.assertEqual(noise.perturb("ok so just move the plumber", NAMES, 1, "light", only=["fragment"])[0], "just move the plumber")
        # never a verb phrase: nothing else is dropped
        for m in ["move the dentist on tuesday", "delete the old photos"]:
            self.assertEqual(noise.perturb(m, NAMES, 1, "light", only=["fragment"]), (m, []))

    def test_the_whole_corpus_survives_every_op_and_level(self):
        for op in noise.OPS:
            for m in CORPUS:
                for seed in range(5):
                    text, ops = noise.perturb(m, NAMES, seed, "heavy", only=[op])
                    self.assertTrue(text.strip(), (op, m))


class Guards(unittest.TestCase):
    YES = ["yes", "Yes.", "yes please", "yeah go ahead", "ok do it", "okay", "sure", "yep!", "all of them", "yes, delete them all", "go ahead",
           "confirmed", "Sí, adelante todo"]
    NOT_YES = ["", "no", "nope, wait", "yes but only the done ones", "fine just the ones i already finished, keep the open", "yes keep the open ones",
               "yes and the events too", "yes, also the notes", "don't", "no don’t do it", "do not delete them", "never mind", "stop", "cancel that",
               "what is left on the list", "delete them",
               "yes it is fine to delete them all but first tell me what is on the list again please"]
    RETRACT = ["never mind", "Never mind.", "nevermind", "forget it", "forget that", "forget about it", "kidding", "just kidding", "I'm just kidding!", "skip it",
               "scratch that", "leave it", "drop it", "don't bother", "dont bother", "no wait... forget it", "no wait forget it", "actually no, forget it",
               "actually never mind, thanks", "never mind thanks", "what's on friday? never mind", "oh he's already gone? fine", "oh he’s already gone? fine.",
               "ok forget it for now"]
    NOT_RETRACT = ["", "fine", "yes please", "fine, leave him", "skip it, what's on friday", "never mind. what's on friday?", "never mind the dishes, add milk",
                   "forget it, add milk to the list", "forget it and move the dentist to friday", "don't forget it", "don't forget to call mum", "leave it open",
                   "drop it in the taxes folder", "skip it and do the next one", "never again", "I'm not kidding, delete it", "scratch that off the list",
                   "what did I forget", "oh he's already gone? fine, move it to friday"]

    def test_the_ports_agree_with_the_runtime_tests(self):
        for m in self.YES:
            self.assertTrue(noise.says_yes(m), m)
        for m in self.NOT_YES:
            self.assertFalse(noise.says_yes(m), m)
        for m in self.RETRACT:
            self.assertTrue(noise.is_retraction(m), m)
        for m in self.NOT_RETRACT:
            self.assertFalse(noise.is_retraction(m), m)

    def test_near_agrees_with_the_runtime_tests(self):
        for a, b in [("aadhaar", "aadhar"), ("9b", "9"), ("tires", "tire"), ("rotated", "rotation"), ("rotation", "rotated"), ("sundays", "sunday")]:
            self.assertTrue(noise.near(a, b), (a, b))
        for a, b in [("planner", "plant"), ("rental", "dental"), ("dental", "mental"), ("test", "text"), ("30", "3"), ("312", "3")]:
            self.assertFalse(noise.near(a, b), (a, b))

    def test_no_op_changes_what_the_runtime_reads_in_a_message(self):
        for m in self.YES + self.NOT_YES + self.RETRACT + self.NOT_RETRACT + CORPUS:
            for level in noise.LEVELS:
                for seed in range(12):
                    text, _ = noise.perturb(m, NAMES, seed, level)
                    self.assertEqual(noise.signature(m), noise.signature(text), f"{m!r} -> {text!r}")

    def test_my_stays_beside_a_balance_and_the_container_words_keep_their_determiner(self):
        for m in ["what's my balance with kwame", "where do i stand in the trip group", "the folder", "that album please", "is the list empty"]:
            for seed in range(40):
                text, _ = noise.perturb(m, NAMES, seed, "heavy")
                self.assertEqual(noise.me_hit(m), noise.me_hit(text), text)
                self.assertEqual(noise.container_pair(m), noise.container_pair(text), text)


class Fuzz(unittest.TestCase):
    def test_arbitrary_text_never_raises_and_keeps_its_guarantees(self):
        import random
        rng = random.Random(2026)
        alphabet = list("abcdefghijklmnopqrstuvwxyz ABCDEFGHIJ0123456789   ,.?!'’\"“”:;-/@#£$%é日😀\n\t")
        pool = ["what's", "tomorrow", "3pm", "kwame", "priya's", "the", "to", "please", "can you", "never mind", "don't", "wifi", "NHS", "e-mail", "o'clock",
                "plumber", "reminder", "balance", "my", "folder", "besides", "friday", "40", "£5.50", "a", "of", "for", "yes", "ok so", "hey"]
        for i in range(400):
            if i % 2:
                m = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 40)))
            else:
                m = " ".join(rng.choice(pool) for _ in range(rng.randint(1, 9)))
            for level in noise.LEVELS:
                text, ops = noise.perturb(m, NAMES, i, level)
                self.assertEqual(noise.perturb(m, NAMES, i, level), (text, ops))
                self.assertEqual(text != m, bool(ops), (m, text, ops))
                if ops:
                    self.assertTrue(noise.consistent(m, text), (m, text, ops))
                    self.assertEqual(noise.signature(m), noise.signature(text), (m, text))

    def test_restore_gives_back_the_clean_session(self):
        s = copy.deepcopy(SESSIONS[0])
        s["id"] += "-noise-light"
        s["tags"] = s["tags"] + ["augmented"]
        s["turns"][1]["noise"] = {"level": "light", "ops": [{"op": "capital", "kind": ""}], "clean": s["turns"][1]["user"]}
        s["turns"][1]["user"] = "Move the dentist to tuesday at 3"
        back = noise.restore(s)
        self.assertEqual(back, SESSIONS[0])
        self.assertEqual(s["turns"][1]["user"], "Move the dentist to tuesday at 3")  # the argument is left as it was


class KeepWords(unittest.TestCase):
    TURN = {"user": "add pay the plumber to my list, due friday",
            "gold": [{"type": "diff", "diff": {"rows": [{"new": "task", "fields": {"name": {"has": ["plumber"]}, "due": "2026-03-13"}}], "links": []}}],
            "ref": [{"tool": "act", "args": {"verb": "create", "kind": "task", "args": "name: Pay the plumber\ndue: {\"date\":\"2026-03-13\"}"}},
                    {"tool": "answer", "args": {"kind": "task", "where": 'description contains "Ward 7"', "name": "council tax", "rows": "$tax"}},
                    {"tool": "search", "args": {"text": "kitchen fitting"}}]}

    def test_words_the_gold_and_the_reference_state_as_text(self):
        kept = noise.keep_words(self.TURN)
        self.assertTrue({"plumber", "pay", "the", "ward", "description", "kitchen", "fitting"} <= kept, kept)
        self.assertNotIn("council", kept)  # a name selector is a lookup: the near-spelling fallback reaches it
        self.assertEqual(noise.ref_keys(self.TURN), {"tax"})

    def test_ref_keys_leave_out_the_specials(self):
        turn = {"ref": [{"tool": "act", "args": {"rows": "$new, $c1, $me, $tiles", "args": "to: $shop"}}]}
        self.assertEqual(noise.ref_keys(turn), {"tiles", "shop"})

    def test_a_kept_phrase_comes_out_as_it_went_in(self):
        m = "hey can you add pay the plumber's fee to my list please"
        keep = ["pay", "the", "plumber", "s", "fee"]
        for seed in range(80):
            for level in noise.LEVELS:
                text, ops = noise.perturb(m, NAMES, seed, level, keep=keep)
                self.assertIn("pay the plumber's fee", text, (text, ops))  # no typo, no dropped word, no doubled space, no 's lost

    def test_a_turn_perturbs_without_touching_what_it_keeps(self):
        keep = noise.keep_words(self.TURN)
        for seed in range(60):
            text, _ = noise.perturb(self.TURN["user"], NAMES, seed, "heavy", keep=keep)
            for w in ("pay", "plumber", "friday"):
                self.assertIn(w, text)


class Lexicon(unittest.TestCase):
    """The protected words cover every word the runtime reads in a message: arrays of crates/nativetools/src, and the cue
    regexes of eval/regen.py. A word added there and not here fails this test."""
    SRC = HERE.parents[3] / "crates" / "nativetools" / "src"
    ARRAYS = {"act.rs": ["UNNAMING", "PICKED", "YES", "WITHHOLD"], "block.rs": ["PRONOUNS", "FIRST_PERSON", "SENSE"], "follow.rs": ["OTHER_NOT", "FILLER"],
              "ground.rs": ["WORD_LIKE", "BROAD", "SPANNING", "SINCE_ENDS", "BEFORE_SHORT_WEEKDAY", "WAITING", "UNITS", "TIME_SPANS", "ROW_MARKERS", "SETTERS",
                            "DESTINATIONS", "STATUS_WORDS", "EVERY_STATUS", "NEXT_NOT", "NUMBER_WORDS"],
              "phrases.rs": ["RETRACTIONS", "RETRACTION_LEAD", "RETRACTION_TAIL", "RESIGNATIONS", "SHORT_WEEKDAYS", "BEFORE_SHORT_WEEKDAY", "JOINS", "MONTH_WORDS",
                             "BEFORE_MONTH", "BEFORE_YEAR", "EVENING", "MORNING", "UNITS", "AFTER_HOUR", "AFTER_DAY", "WRITE_WORDS", "ROW_FILLER"],
              "search.rs": ["STOPWORDS", "SHORT_STOP", "VERB_FORMS", "ARTICLES"], "dates_ctx.rs": ["UNITS"]}

    @unittest.skipUnless((HERE.parents[3] / "crates" / "nativetools" / "src").is_dir(), "the runtime source is not here")
    def test_every_word_of_the_runtime_arrays_is_protected(self):
        array = re.compile(r"(?:pub(?:\(crate\))? )?(?:const|static) ([A-Z_0-9]+): (?:\[&str; \d+\]|&\[&str\]) = &?\[(.*?)\];", re.S)
        tuples = re.compile(r"const ([A-Z_0-9]+): \[\(&str, i8\); \d+\] = \[(.*?)\];", re.S)
        missing, found = set(), 0
        for file, names in self.ARRAYS.items():
            text = (self.SRC / file).read_text()
            for m in array.finditer(text):
                if m.group(1) in names:
                    for w in re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(2)):
                        found += 1
                        missing.update(p for p in w.split() if not noise.protected(p))
        text = (self.SRC / "phrases.rs").read_text()
        for m in tuples.finditer(text):
            for w in re.findall(r'\("([a-z]+)",', m.group(2)):
                found += 1
                missing.update([w] if not noise.protected(w) else [])
        self.assertGreater(found, 400)
        self.assertEqual(missing, set(), "the runtime reads these words in a message: add them to authored/noise.py")

    def test_every_cue_word_of_the_convention_readers_is_protected(self):
        sys.path.insert(0, str(EVAL))
        import regen
        missing = set()
        for name in ("WHAT_ELSE", "BOUNDED", "UNBOUNDED", "DUE", "EVERY", "MESSAGING", "LOGGING", "SUPERLATIVE", "STILL_IN"):
            pattern = re.sub(r"\\[A-Za-z]", " ", getattr(regen, name).pattern)
            for w in re.findall(r"[a-z]{3,}", pattern):
                if not noise.protected(w) and not noise.protected(w.rstrip("s")) and w not in {"mail"}:  # "e-?mail"
                    missing.add(w)
        self.assertEqual(missing, set())

    def test_the_droppable_words_are_function_words_the_runtime_only_skips(self):
        for phrase in noise.DROPPABLE:
            for w in phrase.split():
                self.assertNotIn(w, noise.SEMANTIC, w)


def load_perturb():
    spec = importlib.util.spec_from_file_location("eval_perturb", EVAL / "perturb.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["eval_perturb"] = mod
    spec.loader.exec_module(mod)
    return mod


SESSIONS = [
    {"id": "TX-001", "set": "train", "world": "TX", "today": "2026-03-12T18:20", "me": "Sam Park", "tags": ["a", "b"], "replay": [{"x": 1}],
     "turns": [
         {"user": "how much does kwabena owe me", "gold": [{"type": "value", "values": [{"amount": 5, "unit": None}]}],
          "ref": [{"tool": "answer", "args": {"op": "balance", "rows": "$kwabena"}}], "tags": ["convention"]},
         {"user": "move the dentist to tuesday at 3", "gold": [{"type": "diff", "diff": {"rows": [{"key": "dentist", "change": "updated", "fields": {"date": "2026-03-17T15:00"}}], "links": []}}],
          "ref": [{"tool": "act", "args": {"verb": "reschedule", "name": "Dentist", "args": "to: {\"date\":\"2026-03-17\",\"time\":\"15:00\"}"}}], "tags": []},
         {"user": "what's in the household budget note", "gold": [{"type": "rows", "rows": ["bud"]}],
          "ref": [{"tool": "answer", "args": {"kind": "note", "name": "Household budget"}}], "tags": []}]},
    {"id": "TX-002", "set": "train", "world": "TX", "today": "2026-03-12T18:20", "me": "Sam Park", "tags": [],
     "turns": [{"user": "add pay the plumber to my list", "gold": [{"type": "diff", "diff": {"rows": [{"new": "task", "fields": {"name": {"has": ["plumber"]}}}], "links": []}}],
                "ref": [{"tool": "act", "args": {"verb": "create", "kind": "task", "args": "name: Pay the plumber"}}], "tags": []}]},
]


class PerturbSet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.perturb = load_perturb()

    def run_set(self, level, seed, share=1.0, **kw):
        return self.perturb.perturb_sessions(copy.deepcopy(SESSIONS), level, seed, share, names_of=lambda w: NAMES, keys_of=lambda w: noise.key_names(WORLD), **kw)

    def test_gold_reference_and_tags_are_untouched_and_ids_are_suffixed(self):
        for level in noise.LEVELS:
            out, stats = self.run_set(level, 3)
            self.assertEqual([s["id"] for s in out], [f"{s['id']}-noise-{level}" for s in SESSIONS])
            for new, old in zip(out, SESSIONS):
                self.assertEqual({k: v for k, v in new.items() if k not in ("id", "turns")}, {k: v for k, v in old.items() if k not in ("id", "turns")})
                for nt, ot in zip(new["turns"], old["turns"]):
                    for k in ("gold", "ref", "tags"):
                        self.assertEqual(nt[k], ot[k])
                    self.assertEqual(set(nt) - set(ot), {"noise"} if "noise" in nt else set())
            self.assertEqual(stats["sessions"], 2)
            self.assertEqual(stats["turns"], 4)

    def test_noise_field_says_what_changed(self):
        out, stats = self.run_set("heavy", 5)
        n = 0
        for new, old in zip(out, SESSIONS):
            for nt, ot in zip(new["turns"], old["turns"]):
                if "noise" in nt:
                    n += 1
                    self.assertEqual(set(nt["noise"]), {"level", "ops", "clean"})
                    self.assertEqual(nt["noise"]["level"], "heavy")
                    self.assertEqual(nt["noise"]["clean"], ot["user"])
                    self.assertNotEqual(nt["user"], ot["user"])
                    self.assertTrue(2 <= len(nt["noise"]["ops"]) <= 3 or len(nt["noise"]["ops"]) == 1)
                else:
                    self.assertEqual(nt["user"], ot["user"])
        self.assertEqual(n, stats["turns_perturbed"])
        self.assertEqual(sum(stats["ops"].values()), sum(len(t["noise"]["ops"]) for s in out for t in s["turns"] if "noise" in t))

    def test_the_same_seed_gives_the_same_set_and_another_gives_another(self):
        a, _ = self.run_set("light", 1)
        b, _ = self.run_set("light", 1)
        c, _ = self.run_set("light", 2)
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_share_picks_a_share_of_the_turns(self):
        none, stats = self.run_set("light", 1, share=0.0)
        self.assertEqual(stats["turns_perturbed"], 0)
        self.assertEqual([s["turns"] for s in none], [s["turns"] for s in SESSIONS])
        sessions = [{**copy.deepcopy(SESSIONS[0]), "id": f"TX-{i:03d}"} for i in range(200)]
        out, stats = self.perturb.perturb_sessions(sessions, "light", 9, 0.25, names_of=lambda w: NAMES, keys_of=lambda w: noise.key_names(WORLD))
        self.assertTrue(0.15 < stats["turns_perturbed"] / stats["turns"] < 0.35, stats)

    def test_words_the_gold_repeats_survive_and_the_reference_rows_stay_in_the_block(self):
        index = noise.names_index(NAMES)
        for seed in range(80):
            out, _ = self.run_set("heavy", seed)
            self.assertIn("plumber", out[1]["turns"][0]["user"])
            self.assertIn("pay", out[1]["turns"][0]["user"])
            first = out[0]["turns"][0]["user"]
            self.assertIn(index.ids["Kwabena Owusu"], index.grounded(first), first)  # the reference takes $kwabena
            self.assertIn("tuesday at 3", " ".join(out[0]["turns"][1]["user"].lower().split()))

    def test_verify_puts_back_the_turn_that_breaks_the_reference_run(self):
        out, stats = self.run_set("heavy", 5)
        noisy = {(s["id"], ti) for s in out for ti, t in enumerate(s["turns"]) if "noise" in t}
        self.assertTrue(noisy)
        victim = next(iter(sorted(noisy)))

        def breaks(session):  # the reference run of a session breaks at the victim turn while it is noisy
            sid, ti = victim
            if session["id"] == sid and "noise" in session["turns"][ti]:
                return ti + 1, "KeyError: ref names $x before the runtime showed it"
            return None, ""
        res = self.perturb.verify_sessions(out, breaks)
        self.assertEqual([(r["session"], r["turn"] - 1) for r in res["turns"]], [victim])
        self.assertEqual(res["checked"], len({s for s, _ in noisy}))
        self.assertEqual(sum(res["put_back"].values()), len(res["turns"][0]["ops"]))
        s = next(s for s in out if s["id"] == victim[0])
        self.assertNotIn("noise", s["turns"][victim[1]])
        self.assertEqual(s["turns"][victim[1]]["user"], SESSIONS[[x["id"] for x in SESSIONS].index(victim[0].split("-noise")[0])]["turns"][victim[1]]["user"])
        self.assertEqual(self.perturb.counts(out, "heavy", 5, 1.0)["turns_perturbed"], len(noisy) - 1)

    def test_verify_stops_when_the_clean_session_breaks_by_itself(self):
        out, _ = self.run_set("light", 5)
        res = self.perturb.verify_sessions(out, lambda s: (1, "the clean run fails"))
        self.assertTrue(res["clean_fails"])
        self.assertEqual(self.perturb.counts(out, "light", 5, 1.0)["turns_perturbed"], 0)  # all noise put back, then it gave up

    def test_ops_filter(self):
        out, stats = self.run_set("light", 4, only=["capital"])
        self.assertEqual(set(stats["ops"]), {"capital"})

    def test_cli_end_to_end(self):
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            (t / "worlds").mkdir()
            (t / "worlds" / "TX.json").write_text(json.dumps(WORLD))
            src = t / "set.jsonl"
            src.write_text("".join(json.dumps(s) + "\n" for s in SESSIONS))
            out = t / "out" / "noisy.jsonl"
            r = subprocess.run([sys.executable, str(EVAL / "perturb.py"), str(src), "--out", str(out), "--level", "light", "--seed", "4"],
                               capture_output=True, text=True, env={**os.environ, "EVAL_WORLDS": str(t / "worlds")})
            self.assertEqual(r.returncode, 0, r.stderr)
            rows = [json.loads(l) for l in out.read_text().splitlines()]
            self.assertEqual([s["id"] for s in rows], ["TX-001-noise-light", "TX-002-noise-light"])
            stats = json.loads(Path(str(out) + ".noise.json").read_text())
            self.assertEqual(stats["turns_perturbed"], sum("noise" in t for s in rows for t in s["turns"]))
            self.assertIn("by op", r.stdout)
            subprocess.run([sys.executable, str(EVAL / "perturb.py"), str(src), "--out", str(t / "again.jsonl"), "--level", "light", "--seed", "4"],
                           capture_output=True, text=True, env={**os.environ, "EVAL_WORLDS": str(t / "worlds")})
            self.assertEqual((t / "again.jsonl").read_text(), out.read_text())


def load_build():
    try:
        sys.path.insert(0, str(HERE))
        import build  # noqa: F401  (needs torch through train/hf_backend.py)
        return build
    except Exception:  # noqa: BLE001
        return None


BUILD = load_build()


@unittest.skipUnless(BUILD, "authored/build.py does not import here (it needs torch)")
class Augment(unittest.TestCase):
    def base(self):
        s = copy.deepcopy(SESSIONS[0])
        s["tags"] = ["a", "b"]
        return s

    def plan(self):
        return {0: {"text": "how much does kwabena ow me", "ops": [{"op": "typo", "kind": "drop", "from": "owe", "to": "ow"}], "clean": SESSIONS[0]["turns"][0]["user"], "level": "light"},
                1: {"text": "Move the dentist to tuesday at 3", "ops": [{"op": "capital", "kind": ""}, {"op": "drop", "kind": "the", "word": "the"}],
                    "clean": SESSIONS[0]["turns"][1]["user"], "level": "light"},
                2: {"text": "what's in the household  budget note", "ops": [{"op": "space", "kind": ""}], "clean": SESSIONS[0]["turns"][2]["user"], "level": "light"}}

    def result(self, s, ok=True, problems=()):
        return {"s": s, "ok": ok, "problems": list(problems), "changes": [], "ends": [], "msgs": [], "changed": 0, "trace_turn": None}

    def test_noisy_copy_carries_the_noise_and_the_tag(self):
        s = BUILD.noisy_copy(self.base(), {1: self.plan()[1]})
        self.assertEqual(s["turns"][1]["user"], "Move the dentist to tuesday at 3")
        self.assertEqual(s["turns"][1]["noise"]["clean"], SESSIONS[0]["turns"][1]["user"])
        self.assertEqual(s["turns"][0]["user"], SESSIONS[0]["turns"][0]["user"])
        self.assertNotIn("noise", s["turns"][0])
        self.assertEqual(s["tags"], ["a", "b", "augmented"])
        self.assertEqual(s["turns"][1]["gold"], SESSIONS[0]["turns"][1]["gold"])

    def test_every_noisy_turn_that_verifies_is_kept(self):
        calls = []

        def verify(s, gold_from_ref, holder):
            calls.append(s)
            return self.result(s)
        res, note = BUILD.augment_session(self.base(), self.result(self.base()), self.plan(), True, verify)
        self.assertEqual(len(calls), 1)
        self.assertEqual(sorted(note["kept"]), [0, 1, 2])
        self.assertEqual(note["dropped"], [])
        self.assertIn("augmented", res["s"]["tags"])

    def test_a_failing_turn_is_put_back_clean_and_the_rest_stays(self):
        def verify(s, gold_from_ref, holder):
            if s["turns"][1]["user"].startswith("Move"):  # the capital/drop turn fails its gold
                return self.result(s, ok=False, problems=[{"turn": 2, "user": s["turns"][1]["user"], "problems": ["missing change on dentist"]}])
            return self.result(s)
        res, note = BUILD.augment_session(self.base(), self.result(self.base()), self.plan(), True, verify)
        self.assertEqual(sorted(note["kept"]), [0, 2])
        self.assertEqual([(t, why) for t, _, why in note["dropped"]], [(1, "gold fails")])
        self.assertEqual(res["s"]["turns"][1]["user"], SESSIONS[0]["turns"][1]["user"])
        self.assertNotIn("noise", res["s"]["turns"][1])
        self.assertEqual(res["s"]["turns"][0]["user"], "how much does kwabena ow me")

    def test_a_failure_shows_late_puts_back_the_nearest_noisy_turn_before_it(self):
        def verify(s, gold_from_ref, holder):
            if s["turns"][0]["user"].endswith("ow me"):  # noise on turn 1 breaks turn 2 (state)
                return self.result(s, ok=False, problems=[{"turn": 2, "user": "", "problems": ["x"]}])
            return self.result(s)
        plan = {0: self.plan()[0], 2: self.plan()[2]}
        res, note = BUILD.augment_session(self.base(), self.result(self.base()), plan, True, verify)
        # turn 2 is clean; the failure shows there; the nearest noisy turn at or before it is turn 1
        self.assertEqual([t for t, _, _ in note["dropped"]], [0])
        self.assertEqual(sorted(note["kept"]), [2])

    def test_a_raise_names_its_turn_and_a_trace_error_its_own(self):
        seen = []

        def verify(s, gold_from_ref, holder):
            seen.append(sum(1 for t in s["turns"] if "noise" in t))
            if "noise" in s["turns"][2]:
                err = KeyError("ref names $x before the runtime showed it")
                err.turn = 3
                raise err
            return self.result(s)
        res, note = BUILD.augment_session(self.base(), self.result(self.base()), self.plan(), True, verify)
        self.assertEqual(seen, [3, 2])
        self.assertEqual([(t, why) for t, _, why in note["dropped"]], [(2, "error: KeyError")])
        self.assertEqual(BUILD.implicated_turns([{"trace": "roundtrip", "detail": "turn 4 call 2: compile refused"}, {"turn": 2}]), [1, 3])
        self.assertEqual(BUILD.implicated_turns([{"trace": "unsourced", "detail": "name=x"}], trace_at=2), [1])

    def test_a_gold_the_noise_changed_is_put_back(self):
        clean = self.result(self.base())

        def verify(s, gold_from_ref, holder):
            r = self.result(copy.deepcopy(s))
            if s["turns"][0]["user"].endswith("ow me"):
                r["s"]["turns"][0]["gold"] = [{"type": "rows", "rows": ["x"]}]  # --gold-from-ref derived another effect
            return r
        res, note = BUILD.augment_session(self.base(), clean, self.plan(), True, verify)
        self.assertEqual([(t, why) for t, _, why in note["dropped"]], [(0, "gold changed")])

    def test_everything_put_back_returns_the_clean_result(self):
        clean = self.result(self.base())

        def verify(s, gold_from_ref, holder):
            return self.result(s, ok=False, problems=[{"error": "x"}])
        res, note = BUILD.augment_session(self.base(), clean, self.plan(), False, verify)
        self.assertIs(res, clean)
        self.assertEqual(note["kept"], {})
        self.assertEqual(sorted(t for t, _, _ in note["dropped"]), [0, 1, 2])
        self.assertNotIn("augmented", res["s"]["tags"])

    def test_put_back_order(self):
        chosen = {0: 1, 2: 1, 5: 1}
        self.assertEqual(BUILD.put_back_which(chosen, [2]), 2)
        self.assertEqual(BUILD.put_back_which(chosen, [3]), 2)
        self.assertEqual(BUILD.put_back_which(chosen, [1, 4]), 0)
        self.assertEqual(BUILD.put_back_which(chosen, []), 5)
        self.assertEqual(BUILD.put_back_which({4: 1}, [1]), 4)


@unittest.skipUnless(os.environ.get("NOISE_INTEGRATION") and os.environ.get("NATIVETOOLS") and BUILD, "needs the runtime and torch")
class Integration(unittest.TestCase):
    def test_build_augment_tags_counts_and_keeps_the_clean_sessions(self):
        only = "T01-001,T01-007,T01-012"
        with tempfile.TemporaryDirectory() as t:
            env = {**os.environ, "EVAL_VAULTS": os.environ.get("EVAL_VAULTS", str(Path(t) / "vaults"))}

            def build(out, *extra):
                r = subprocess.run([sys.executable, str(HERE / "build.py"), "T01", "--out", str(Path(t) / out), "--only", only, "--gold-from-ref", *extra],
                                   capture_output=True, text=True, env=env)
                self.assertEqual(r.returncode, 0, r.stderr[-2000:])
                return r.stderr
            build("clean")
            err = build("aug", "--augment", "1.0", "--augment-seed", "3", "--augment-level", "light")
            self.assertRegex(err, r"T01: augment 1\.0 light \(seed 3\)")
            stats = json.loads((Path(t) / "aug" / "T01.augment.json").read_text())
            self.assertEqual(stats["planned"], stats["turns_kept"].get("light", 0) + stats["turns_dropped"].get("light", 0))
            self.assertEqual(sum(stats["kept"].values()) >= stats["turns_kept"].get("light", 0), True)
            import gzip
            clean = {json.loads(l)["id"] for l in gzip.open(Path(t) / "clean" / "T01.jsonl.gz", "rt")}
            recs = [json.loads(l) for l in gzip.open(Path(t) / "aug" / "T01.jsonl.gz", "rt")]
            self.assertEqual({r["id"] for r in recs}, clean)  # the same sessions: no session is lost to the noise
            gold = {json.loads(l)["id"]: json.loads(l) for l in (Path(t) / "aug" / "T01.gold.jsonl").read_text().splitlines()}
            for r in recs:
                g = gold[r["id"].split("-", 1)[1]]
                noisy = [t for t in g["turns"] if "noise" in t]
                self.assertEqual("augmented" in r["tags"], bool(noisy))
                users = [m["content"].split("\n\n")[-1] for m in r["messages"] if m["role"] == "user"]
                self.assertEqual(users, [t["user"] for t in g["turns"]])  # the record was built from the message in the gold
            # the augmented build derives the same gold as the clean one
            cg = {json.loads(l)["id"]: json.loads(l) for l in (Path(t) / "clean" / "T01.gold.jsonl").read_text().splitlines()}
            for sid, g in gold.items():
                if sid in cg:
                    self.assertEqual([t["gold"] for t in g["turns"]], [t["gold"] for t in cg[sid]["turns"]], sid)


if __name__ == "__main__":
    unittest.main()
