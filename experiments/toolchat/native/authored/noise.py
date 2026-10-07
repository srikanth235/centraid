"""Message noise for the native tool task: what a phone does to a typed request (typos, dropped words, autocorrect
artefacts, fillers), applied to the user message of a turn without touching anything its gold depends on.

    text, ops = perturb(message, world_names, seed, level)        # level "light": one op; "heavy": two or three

Two users share this module: `eval/perturb.py` (the held-out sets, rewritten as a robustness eval) and
`authored/build.py --augment` (the same noise on a share of the training turns). `plan_turns` is the one place that
decides which turns get noise and what it is, so a set perturbed with seed N and a build augmented with seed N agree.

The result is a pure function of (message, seed, level, world_names, keep, needs, only): the same arguments give the same
text and the same `ops`, in any process and any order of calls (the draws come from a generator seeded by a hash of the
arguments, never from global state).

THE OPS (each at most once per message; `ops` says what changed, one dict per op)

    typo        a word of 5+ letters that no gold and no runtime reading depends on: an adjacent swap, a dropped letter,
                a doubled letter or a neighbouring-key (qwerty) substitution; the first letter stays.
    name        the same, but ONLY on a word that names a row of the world (a row name, a nickname, a role or a first
                name), and only so that the runtime still reads it as that name: the near-spelling fallback reaches it
                (`search.rs: word_score`), its disambiguation of a write reads it as the same word (`act.rs: near`: five
                letters or more, one slip, first letter kept, so no swap before seven letters and nothing on a name of
                four letters), and no other name of the world is as close (edit distance, word start). And the block of
                pre-grounded rows keeps every row the turn's reference takes by `$key` (`needs`; `plan_turns` reads them off
                the turn): a word that alone grounds its row loses its last letter, a word in a longer name may take any
                slip. A typo that took such a row out of the block leaves the reference calls unable to name it
                (`ref names $key before the runtime showed it`; on T01 the first version's name typos broke 6 of 151
                sessions at light and 11 at heavy, and no other op broke one), and a model trained on it would learn to
                spell a name it was never shown. A name typo may still take a row the reference does not take by `$key`
                out of the block, which is the case the runtime's near-spelling fallback exists for.
    drop        one of a, the, my, to, of, for, please, can you, could you, where its neighbours are plain words (a
                function word beside a date, a number, a convention word or a cue the runtime reads stays).
    apostrophe  a lost apostrophe ("what's" to "whats", "i'll" to "ill", "plumber's" to "plumbers").
    capital     the first word capitalised.
    period      a trailing period after a message that ends in a plain word.
    space       one doubled space between two words.
    fragment    a filler dropped from the start ("hey", "hmm", "ok so", "quick one") or the end ("thanks"); never a verb
                phrase: "move the dentist on tuesday" does not become "the dentist on tuesday". "ok" and "please" are yes
                words to the runtime (`says_yes`: a short message with one and no word that holds a yes back is a plain
                yes), so they go only where the message reads the same without them: in a long message, or beside "just".

NEVER TOUCHED (by any op; a test checks the sequence of these tokens, case folded, before and after)
    numbers, times, ordinals, amounts and anything with a digit; weekday and month names, day parts, units and the other
    date words; the closed convention words of SPEC section 14 (next, last, this, weekend, week, today, tomorrow, tonight,
    all, every, both, else, besides, apart, except, due, open, done, finished, overdue, still, left, remaining, trash,
    delete, undo, never mind, wifi, password, diary, journal, ...); currency words; the cues of a decline (text, send,
    invent, wipe, everything, forget it, ...); every word the runtime reads in a message (`PROTECTED` is their union with
    the lists above: the arrays of crates/assist/src/native and the cue regexes of eval/regen.py, which
    authored/test_noise.py compares against the sources); anything inside quotes; addresses and other glued strings;
    acronyms; and the `keep` words.
`keep` is for what the gold repeats: the words a created or edited row's text must carry (`keep_words(turn)` reads them
off the gold's row fields and the reference calls' `args`, `text` and `where`). The reference run cannot see this, because
the reference calls do not read the message; a model that copies the user's words faithfully would. A kept word is not
given a typo, not dropped, not made into a contraction without its apostrophe, has no doubled space beside it and no
period after it.

THE GUARDS. After every op the result must read the same to the runtime's message predicates that a clean message does:
`says_yes` (the plain yes that lets a write over the cap through), `is_retraction` (the turn the runtime ends itself), the
person's own row (`me_hit`: my + balance), the container the message points at (`the folder`). They are ports of
crates/nativetools (act.rs, phrases.rs, block.rs); a candidate op that flips one is thrown away and another is tried.

`world_names` is every name the world's rows answer to (`names_of_world(world)`); pass the world's own list, not a sample.
"""
from __future__ import annotations

import collections
import copy
import hashlib
import json
import random
import re
import sys
import unicodedata
from collections.abc import Iterable, Iterator

LEVELS = ("light", "heavy")
OPS = ("typo", "name", "drop", "apostrophe", "capital", "period", "space", "fragment")
GROUP = {"typo": "typo", "name": "name", "drop": "drop", "apostrophe": "auto", "capital": "auto", "period": "auto",
         "space": "auto", "fragment": "fragment"}
# the weight of an op in the draw (an op that does not apply to the message is skipped)
WEIGHTS = {"typo": 14.0, "name": 2.5, "drop": 8.0, "apostrophe": 8.0, "capital": 1.2, "period": 1.2, "space": 0.8,
           "fragment": 5.0}
DROPPABLE = ("a", "the", "my", "to", "of", "for", "please", "can you", "could you")


def _w(text: str) -> frozenset[str]:
    return frozenset(text.split())


# ---------------------------------------------------------------------------------------------
# What is never touched
# ---------------------------------------------------------------------------------------------

# the arrays of crates/assist/src/native that read a message (act.rs UNNAMING PICKED YES WITHHOLD; block.rs PRONOUNS
# FIRST_PERSON SENSE; follow.rs; ground.rs; phrases.rs, WEEKDAYS and MONTHS included; search.rs STOPWORDS SHORT_STOP
# VERB_FORMS ARTICLES; dates_ctx.rs): `test_noise.RuntimeLexicon` rereads them and fails on a word this set lacks
RUNTIME = _w("""
a abort about absolutely actually add added adding affirmative after afternoon afternoons again ago agreed ahead all
alone already alright also altogether am an and another any anyway anyways apr april archive archived are as at aug
august balance balances be because been before between book both bother breakfast bump but by can cancel canceled
canceling cancelled cancelling cancels cant cards certainly change changed closed complete completed completes
completing confirm confirmed copies correct could couple create created creating daily dated day days debt debts dec
december defer definitely degrees delay delete deleted deletes deleting did dinner do doc docs documents does done dont
dozen drinks drop during each earlier early edited editing eight eighteenth eighth eleven eleventh entire evening
evenings event events every everything except feb february few fifteenth fifth file find fine finish finished first
five for forget fortnight four fourteenth fourth fri friday from get give go good got group groups guests had haha hand
has have he her here hers hey hi him his hmm hold hour hours how hr hrs i if ill im in instead into invite is ish it
item items its ja jan january jk jul july jun june just k keep kidding kids last late later latest leave left let lets
list lists locations log logged logging logs lol look looks lunchtime made make many march mark marked mate may me mid
midday min mind mine mins minute minutes mon monday month monthly months more morning mornings most move moved movie
much my myself nah net never nevermind new newest next night nights nine nineteenth ninth no none noon nope not note
notes nothing nov november now nvm oct october of off oh ok okay old oldest on one ones only onwards oops open opened or
other oui our out overdue owe owed owes paid park party past pay people percent person persons photo photos pin pinned
places please pls plus point position postpone postponed previous proceed push pushed put quarter rather re remaining
remind remove removed removing rename renamed reopen reopened reopening reschedule rescheduled rescheduling rest
restore restored restores restoring reveal revealed revealing right rows s said same sat saturday save saved schedule
scheduled scratch seats second sep sept september set settle settled settling seven seventeenth seventh share sharp
she shift should show si side sim since six sixteenth sixth skip so some sorry stage stand standing star starred
starring stars still stop sun sunday supper sure tab take task tasks tell ten tenth than thank thanks that the their
theirs them then there these they third thirteenth this those though three through thru thu thur thurs thursday thx
tick tickets til till time times to today tomorrow tonight too trash trashed tue tues tuesday twelfth twelve two ty uh
um undo undone unless unpin unstar unstarred until up update updated us very vs wait waits was way we wed wednesday
week weekend weekends weekly weeks well were what whats when where which who whole will with without wont would y ya
yah yea yeah year years yep yes yesterday yet you your yup
""")

# the SPEC section 14 conventions and the closed words the brief names, with the words the Python-side convention
# readers (eval/regen.py: WHAT_ELSE, BOUNDED, EVERY, SUPERLATIVE, ...) and eval/conventions.py look for
CONVENTIONS = _w("""
next last this weekend weekends week weeks today tomorrow tonight yesterday all every both else besides apart aside
except due open done finished overdue still left remaining trash trashed delete undo never mind nevermind
others other history empty expired duplicate duplicates already everything just only old completed cancelled canceled
wifi wi fi password passwords pw passcode diary journal entry entries
biggest smallest largest longest shortest long big vault
""")

# dates and times: the words `dates:` and the phrase table read, and the trace quotes as the date of a call
DATES = _w("""
monday tuesday wednesday thursday friday saturday sunday mon tue tues wed weds thu thur thurs fri sat sun
january february march april may june july august september october november december jan feb mar apr jun jul aug
sep sept oct nov dec
today tomorrow tomorow tmrw tmr tonight yesterday weekdays weekend weekends midweek fortnight fortnightly
morning mornings afternoon afternoons evening evenings night nights noon midday midnight lunch lunchtime dinner
breakfast supper brunch overnight oclock
second seconds minute minutes min mins hour hours hr hrs day days week weeks month months year years decade quarter
daily weekly monthly yearly annually biweekly
ago later earlier earliest latest before after since until till til through thru between during from within
onwards upcoming coming following previous recent recently soon now then ahead future outstanding
early late mid end start beginning middle
am pm
""")

NUMBERS = _w("""
zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen
eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million dozen couple few
several half quarter twice once thrice
first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth
sixteenth seventeenth eighteenth nineteenth twentieth thirtieth
""")

CURRENCY = _w("""
pound pounds quid gbp usd eur dollar dollars buck bucks euro euros cent cents pence penny naira ngn rupee rupees inr
yen jpy rand zar peso pesos mxn franc francs chf krona kronor sek nok dkk zloty pln real reais brl aud cad nzd sgd
yuan cny dirham dirhams aed lira
""")

# the cues of a decline (trace.DECLINE_RX, regen.MESSAGING and LOGGING, the retraction phrases): a typo in them would
# change which turn the message is
CUES = _w("""
text texts texting email emails emailing whatsapp send sending forward share message messages dm post tweet paste upload
ping tell invent generate fake guess reset wipe wiped wipes nuke burn purge factory fresh
never mind nevermind nvm forget leave skip scratch kidding jk ignore nothing stop nah nope
dont cant wont
weather news joke recipe translate stock capital flight flights directions google buy order online web
log remind
""")

# the container words the pre-grounding block reads after a determiner ("the folder"), and the words that give a
# person's own row (`me_hit`)
CONTAINERS = _w("album albums folder folders list lists notebook notebooks")
SENSE = _w("balance balances owe owes owed debt debts stand standing position net tab group groups share")
FIRST_PERSON = _w("my me i mine myself")
PRONOUNS = _w("him her he she them they his hers their theirs")

# what a plain yes is to the runtime (act.rs), and the words that hold one back
YES = _w("""
yes yeah yea yep yup ya yah sure ok okay k y confirm confirmed proceed go ahead do please absolutely definitely certainly
agreed alright fine correct right affirmative si sim oui ja all every everything each whole entire
""")
WITHHOLD = _w("""
no nope nah not never dont cant wont stop wait hold cancel abort undo only just except but instead rather keep leave
unless without also plus too nothing none skip rest
""")

# the words a phrase of the date and amount readers is built from: a function word near one of them is not dropped
NEIGHBOUR_DATE = DATES | NUMBERS | CURRENCY | _w("""
next last this weekend week today tomorrow tonight every each all both except due overdue still left remaining open
done finished half couple few dozen
""")
# and the words beside which no function word is dropped: cues, containers, the person's own sense words, the
# conventions, the else cues
NEIGHBOUR_OTHER = CUES | CONTAINERS | SENSE | CONVENTIONS | _w("else besides apart aside others ones")
# what no op alters (by token, case folded): the vocabularies above; the rest of PROTECTED is only ever dropped, whole,
# by `drop` and `fragment`, and never given a typo
SEMANTIC = frozenset(CONVENTIONS | DATES | NUMBERS | CURRENCY | CUES | CONTAINERS | SENSE | NEIGHBOUR_OTHER)

PROTECTED = frozenset(RUNTIME | SEMANTIC | FIRST_PERSON | PRONOUNS | YES | WITHHOLD)


# ---------------------------------------------------------------------------------------------
# Text helpers (ports of what the runtime does to a message)
# ---------------------------------------------------------------------------------------------

_SPELLED = {"ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "đ": "d", "ð": "d", "þ": "th", "ł": "l"}
_WORDS = re.compile(r"[^\W_]+")


def fold(text: str) -> str:
    """Lower case with the accents dropped, as the runtime folds a name (`search.rs: fold`)."""
    return "".join(_SPELLED.get(c, c) for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c))


def fold_words(text: str) -> list[str]:
    return _WORDS.findall(fold(text))


def without_possessive(text: str) -> str:
    """`Chi's Hen Do` as the runtime's name matching reads it: `Chi Hen Do`."""
    return re.sub(r"(?<=[A-Za-z0-9])['’][sS]\b", "", text)


def edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        current = [i + 1]
        for j, cb in enumerate(b):
            current.append(min(previous[j] + (ca != cb), previous[j + 1] + 1, current[j] + 1))
        previous = current
    return previous[-1]


def word_score(query: str, word: str) -> int:
    """3 exact, 2 word start, 1 near spelling, 0 none: `search.rs: word_score`, the tiers the runtime's name fallback reads."""
    if query == word:
        return 3
    if len(query) >= 2 and word.startswith(query):
        return 2
    limit = 2 if len(query) >= 7 else 1
    if len(query) >= 4 and edit_distance(query, word) <= limit:
        return 1
    return 0


_SUFFIXES = ("ations", "ation", "ings", "ing", "ions", "ion", "ated", "ates", "ed", "es", "s")


def _stem(word: str) -> str:
    out = word
    for suffix in _SUFFIXES:  # the first suffix that comes off and leaves four letters
        if out.endswith(suffix) and len(out) - len(suffix) >= 4:
            out = out[:-len(suffix)]
            break
    return out[:-1] if out.endswith("e") and len(out) - 1 >= 4 else out


def near(name: str, word: str) -> bool:
    """`act.rs: near`, what the runtime's own disambiguation of a write reads as the same word: equal, the same word in
    another form, or one letter off in words of five or more letters that start alike (a swap is two letters off)."""
    if name == word:
        return True
    if word.isdigit():
        return name.startswith(word) and len(name) == len(word) + 1 and name[-1].isalpha()
    stem_name, stem_word = _stem(name), _stem(word)
    if stem_name == stem_word and len(stem_name) >= 4:
        return True
    if len(name) < 5 or len(word) < 5 or abs(len(name) - len(word)) > 1 or name[0] != word[0]:
        return False
    common = next((k for k in range(min(len(name), len(word))) if name[k] != word[k]), min(len(name), len(word)))
    tail = next((k for k in range(min(len(name), len(word))) if name[-1 - k] != word[-1 - k]), min(len(name), len(word)))
    return common + tail + 1 >= max(len(name), len(word))


def plural_of(word: str, vocab: frozenset[str]) -> bool:
    return (word.endswith("s") and len(word) > 3 and word[:-1] in vocab) or (word.endswith("es") and len(word) > 4 and word[:-2] in vocab)


def protected(word: str) -> bool:
    """Whether a folded, apostrophe-free word is one the runtime or a convention reads."""
    return word in PROTECTED or plural_of(word, PROTECTED)


# the runtime's retraction (phrases.rs `is_retraction`) and plain yes (act.rs `says_yes`)
_RETRACTIONS = ("never mind", "nevermind", "nvm", "forget it", "forget that", "forget about it", "forget about that",
                "kidding", "jk", "skip it", "skip that", "scratch that", "scratch it", "leave it", "leave that", "drop it",
                "drop that", "dont bother", "do not bother")
_RETRACTION_LEAD = _w("""
actually no nope nah wait oh oops ok okay hmm um uh well sorry please just lets let its it you can i im ill said yeah so hey
""")
_RETRACTION_TAIL = _w("""
thanks thank you thx ty lol haha anyway anyways now then please sorry though mate ok okay all good that it about already
alone for
""")
_RESIGNATIONS = (("fine",), ("fine", "then"), ("ok", "fine"), ("okay", "fine"), ("oh", "well"))
_YES_WORDS = 10


def is_retraction(message: str) -> bool:
    sentences: list[tuple[list[str], bool]] = []
    words: list[str] = []
    word: list[str] = []

    def close(question: bool) -> None:
        if word:
            words.append("".join(word))
            word.clear()
        if words:
            sentences.append((list(words), question))
            words.clear()

    for char in message.lower():
        if char in "'’‘`":
            continue
        if char in ".!\n…":
            close(False)
        elif char == "?":
            close(True)
        elif char.isalnum():
            word.append(char)
        elif word:
            words.append("".join(word))
            word.clear()
    close(False)
    if not sentences:
        return False
    last = sentences[-1][0]
    if len(sentences) > 1 and sentences[-2][1] and any(list(shrug) == last for shrug in _RESIGNATIONS):
        return True
    for phrase in _RETRACTIONS:
        parts = phrase.split(" ")
        for at in range(len(last) - len(parts) + 1):
            if (last[at:at + len(parts)] == parts and all(w in _RETRACTION_LEAD for w in last[:at])
                    and all(w in _RETRACTION_TAIL for w in last[at + len(parts):])):
                return True
    return False


def says_yes(message: str) -> bool:
    lower = message.lower()
    if "n't" in lower or "n’t" in lower:
        return False
    words = fold_words(message)
    return bool(words) and len(words) <= _YES_WORDS and any(w in YES for w in words) and not any(w in WITHHOLD for w in words)


def me_hit(message: str) -> bool:
    words = fold_words(message)
    return any(w in FIRST_PERSON for w in words) and any(w in SENSE for w in words)


_DETERMINERS = _w("that the this same those these its")


def container_pair(message: str) -> bool:
    words = fold_words(message)
    return any(a in _DETERMINERS and b in CONTAINERS for a, b in zip(words, words[1:]))


def signature(message: str) -> tuple:
    """What the runtime's message predicates say of `message`; an op must leave it as it was."""
    words = fold_words(message)
    return (says_yes(message), is_retraction(message), me_hit(message), container_pair(message),
            tuple(sorted(w for w in set(words) if w in PRONOUNS)))


# ---------------------------------------------------------------------------------------------
# The world's names
# ---------------------------------------------------------------------------------------------

SECTIONS = ("people", "groups", "lists", "events", "tasks", "notebooks", "notes", "folders", "documents", "albums",
            "photos", "debts", "locker")


def names_of_world(world: dict) -> list[str]:
    """Every name a row of the world answers to: its name, a person's nickname and role, and the person's own name
    (the model's rows; the group expenses are not rows the runtime matches a name against)."""
    out = [world.get("me") or ""]
    for section in SECTIONS:
        for row in world.get(section, []):
            out.append(row.get("name") or "")
            if section == "people":
                out += [row.get("nickname") or "", row.get("role") or ""]
    return [n for n in out if n]


def key_names(world: dict) -> dict[str, str]:
    """World key -> the name of that row, for the rows the reference calls take by `$key`."""
    out = {"me": world.get("me") or ""}
    for section in SECTIONS:
        for row in world.get(section, []):
            if row.get("key") and row.get("name"):
                out[row["key"]] = row["name"]
    return out


_KEY_REF = re.compile(r"\$([A-Za-z0-9_]+)")


def ref_keys(turn: dict) -> frozenset[str]:
    """The world keys a turn's reference calls take rows by (`$key`; `$new`, `$c1` and `$me` are no world row's name)."""
    out: set[str] = set()
    for call in turn.get("ref") or []:
        for value in (call.get("args") or {}).values():
            out.update(k for k in _KEY_REF.findall(str(value)) if k not in ("new", "me") and not re.fullmatch(r"c\d+", k))
    return frozenset(out)


class Names:
    """The folded words the world's names are made of, for the checks a typo must pass."""

    def __init__(self, names: Iterable[str]):
        tokens: set[str] = set()
        token_names: dict[str, set[int]] = {}
        counts = collections.Counter(names)
        self.rows = []  # how many rows answer to each distinct name (a name may be many events')
        self.ids = {name: i for i, name in enumerate(counts)}
        for i, name in enumerate(counts):  # each distinct name once, in order
            self.rows.append(counts[name])
            words = set(fold_words(name)) | set(fold_words(without_possessive(name)))  # the block reads the name without its 's
            tokens.update(words)
            for word in words:
                token_names.setdefault(word, set()).add(i)
        self.tokens = frozenset(tokens)
        self.token_names = {w: frozenset(ix) for w, ix in token_names.items()}
        owners: dict[str, set[str]] = {}
        for token in self.tokens:
            for k in range(3, len(token) + 1):
                owners.setdefault(token[:k], set()).add(token)
        self.owners = {prefix: frozenset(ws) for prefix, ws in owners.items()}
        by_len: dict[int, list[str]] = {}
        for token in sorted(self.tokens):
            by_len.setdefault(len(token), []).append(token)
        self.by_len = by_len

    def row_count(self, ids: frozenset[int]) -> int:
        return sum(self.rows[i] for i in ids)

    def grounded(self, text: str) -> frozenset[int]:
        """The names the pre-grounding block would hit for a message: a word of the message that is, or begins, a word of the
        name (three letters or more; a word the runtime reads as something else is left out, which only undercounts)."""
        hit: set[int] = set()
        for word in fold_words(without_possessive(text)):
            if len(word) >= 3 and not protected(word):
                for token in self.owners.get(word, ()):
                    hit |= self.token_names[token]
        return frozenset(hit)

    def like(self, word: str) -> bool:
        """Whether the pre-grounding block would read `word` as (the start of) a name word."""
        return word in self.tokens or word in self.owners

    def nearby(self, word: str, radius: int = 2) -> Iterator[str]:
        for length in range(max(1, len(word) - radius), len(word) + radius + 1):
            yield from self.by_len.get(length, ())

    def safe_typo(self, typo: str, original: str) -> bool:
        """`typo` of the name word `original`: reached by the runtime's near-spelling fallback (`word_score`) and read as the
        same word by its disambiguation (`near`), and no other name word is as close (an exact, word-start or near-spelling
        hit, or an edit distance not greater)."""
        if typo == original or len(typo) < 3 or typo[0] != original[0] or protected(typo):
            return False
        if word_score(typo, original) < 1 or not near(original, typo):
            return False
        if self.owners.get(typo, frozenset()) - {original}:
            return False
        reach = edit_distance(typo, original)
        for other in self.nearby(typo):
            if other == original:
                continue
            if word_score(typo, other) > 0 or edit_distance(typo, other) <= reach:
                return False
        return True

    def nameish(self, word: str) -> bool:
        """Whether `word` is, or is one slip or two from, a word of a name: a mention of a row, however it is spelled. The
        trace takes a call's `name` from the message words that read as the name's (`trace.same`: one slip), so a second
        typo on a mention the message already misspells would leave the call's name with no source."""
        return word in self.tokens or (len(word) >= 5 and any(edit_distance(word, other) <= 2 for other in self.nearby(word)))

    def safe_word(self, typo: str) -> bool:
        """`typo` of a word that is no name: it must not become one, nor a word the block would take for the start of one,
        nor a one-letter slip of one (`act.rs: near`)."""
        if protected(typo) or self.like(typo):
            return False
        return all(edit_distance(typo, other) >= 2 for other in self.nearby(typo, 1))


_INDEX_CACHE: dict[tuple, Names] = {}


def names_index(world_names: "Iterable[str] | Names | None") -> Names:
    if isinstance(world_names, Names):
        return world_names
    key = tuple(world_names or ())
    if key not in _INDEX_CACHE:
        if len(_INDEX_CACHE) > 64:
            _INDEX_CACHE.clear()
        _INDEX_CACHE[key] = Names(key)
    return _INDEX_CACHE[key]


# ---------------------------------------------------------------------------------------------
# What the gold repeats
# ---------------------------------------------------------------------------------------------

def _strings(value) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            if key != "any":
                yield from _strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item)


def keep_words(turn: dict) -> frozenset[str]:
    """The folded words of a turn that its gold or its reference calls state as text: the fields a created or edited row
    must carry (`has`, `prefix`, exact), the values of the reference `args` body lines, and the `text` and `where` of a
    call. A model that copies the user's words writes them; a typo there would change what it writes, not how it reads."""
    out: set[str] = set()
    for accept in turn.get("gold") or []:
        for row in (accept.get("diff") or {}).get("rows") or []:
            for matcher in (row.get("fields") or {}).values():
                for text in _strings(matcher):
                    out.update(fold_words(text))
    for call in turn.get("ref") or []:
        args = call.get("args") or {}
        for key in ("text", "where"):
            if args.get(key):
                out.update(fold_words(str(args[key])))
        for line in str(args.get("args") or "").splitlines():
            _, _, value = line.partition(":")
            value = value.strip()
            if value and not value.startswith(("{", "[")):
                out.update(fold_words(value))
    return frozenset(out)


# ---------------------------------------------------------------------------------------------
# The message as tokens
# ---------------------------------------------------------------------------------------------

_TOKEN = re.compile(r"[A-Za-z0-9À-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*")
_GLUE = re.compile(r"[@/\\#_=+*<>~^|%$£€¥]|://|(?<=[A-Za-z0-9])[.:,](?=[A-Za-z0-9])")
_APOSTROPHES = "'’"


def _quoted_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    straight = [i for i, c in enumerate(text) if c == '"']
    for k in range(0, len(straight), 2):
        spans.append((straight[k], straight[k + 1] + 1 if k + 1 < len(straight) else len(text)))
    for m in re.finditer(r"“[^”]*(?:”|$)", text):
        spans.append(m.span())
    singles = [i for i, c in enumerate(text) if c in "'‘’"
               and not (0 < i < len(text) - 1 and text[i - 1].isalpha() and text[i + 1].isalpha())]
    for k in range(0, len(singles) - 1, 2):
        spans.append((singles[k], singles[k + 1] + 1))
    return spans


def _glued_spans(text: str) -> list[tuple[int, int]]:
    return [m.span() for m in re.finditer(r"\S+", text) if _GLUE.search(m.group(0))]


def _within(spans: list[tuple[int, int]], start: int, end: int) -> bool:
    return any(s < end and start < e for s, e in spans)


def _bare(token: str) -> str:
    """The folded token without its apostrophes: `what's` is `whats`."""
    return fold(token).replace("'", "").replace("’", "")


def _base(token: str) -> str:
    """The token before its first apostrophe (`kwame` of `kwame's`)."""
    return re.split(r"['’]", token, maxsplit=1)[0]


class Doc:
    """A message cut into tokens, with what keeps a token out of every op.

    `hard`    no op may touch the token whatever the word is: digits, quotes, addresses, acronyms, other scripts;
    `sem`     hard, or a word of the closed vocabularies (`SEMANTIC`): no op changes it, drops it or reorders it;
    `frozen`  sem, or any word the runtime reads (`PROTECTED`): never given a typo."""

    def __init__(self, text: str):
        self.text = text
        self.toks = [(m.start(), m.end(), m.group(0)) for m in _TOKEN.finditer(text)]
        quotes, glued = _quoted_spans(text), _glued_spans(text)
        self.hard = [self._hard(s, e, t, quotes, glued) for s, e, t in self.toks]
        words = [_bare(t) for _, _, t in self.toks]
        self.sem = [h or w in SEMANTIC or plural_of(w, SEMANTIC) for h, w in zip(self.hard, words)]
        self.frozen = [h or protected(w) for h, w in zip(self.hard, words)]
        # what follows "besides", "except", "apart from", "not the" is matched against the names of the rows just shown
        # (follow.rs): those words are read as written
        for i, w in enumerate(words):
            nxt = words[i + 1] if i + 1 < len(words) else None
            start = (i + 1 if w in ("besides", "except") or (w == "not" and nxt in ("the", "my", "this", "that"))
                     else i + 2 if w in ("apart", "aside") and nxt == "from" else None)
            if start is not None:
                for j in range(start, len(words)):
                    self.sem[j] = self.frozen[j] = True
        # a hyphenated word read as one ("wi-fi", "e-mail", "re-open", "mid-week")
        for i in range(len(self.toks) - 1):
            if text[self.toks[i][1]:self.toks[i + 1][0]] == "-" and protected(words[i] + words[i + 1]):
                self.sem[i] = self.sem[i + 1] = self.frozen[i] = self.frozen[i + 1] = True

    @staticmethod
    def _hard(s: int, e: int, t: str, quotes, glued) -> bool:
        base = _base(t)
        return (any(c.isdigit() for c in t) or _within(quotes, s, e) or _within(glued, s, e)
                or not t.isascii() or (len(base) >= 2 and base.isupper()) or (len(base) > 1 and base[1:] != base[1:].lower()))

    def gap(self, i: int) -> str:
        """The text between token i and the next token (or the end)."""
        return self.text[self.toks[i][1]:self.toks[i + 1][0]] if i + 1 < len(self.toks) else self.text[self.toks[i][1]:]

    def digit(self, j: int) -> bool:
        return any(c.isdigit() for c in self.toks[j][2])

    def near(self, i: int, vocab: frozenset[str], radius: int, digits: bool = True) -> bool:
        """Whether a token within `radius` of token i (not i itself) is in `vocab`, or has a digit."""
        for j in range(max(0, i - radius), min(len(self.toks), i + radius + 1)):
            if j == i:
                continue
            w = _bare(self.toks[j][2])
            if (digits and self.digit(j)) or w in vocab or plural_of(w, vocab):
                return True
        return False


def _sem_sequence(text: str) -> list[str]:
    d = Doc(text)
    return [_bare(t) for s, (_, _, t) in zip(d.sem, d.toks) if s]


# ---------------------------------------------------------------------------------------------
# The ops: each yields candidate (text, op) pairs, best draw first; `perturb` takes the first that passes the guards
# ---------------------------------------------------------------------------------------------

_KEYS = ("qwertyuiop", "asdfghjkl", "zxcvbnm")
_NEIGHBOURS: dict[str, str] = {}
for _r, _row in enumerate(_KEYS):
    for _c, _ch in enumerate(_row):
        _near = set()
        for _d in (-1, 1):
            if 0 <= _c + _d < len(_row):
                _near.add(_row[_c + _d])
        if _r > 0:  # the keys above sit half a key to the right of the ones below
            for _d in (0, 1):
                if 0 <= _c + _d < len(_KEYS[_r - 1]):
                    _near.add(_KEYS[_r - 1][_c + _d])
        if _r + 1 < len(_KEYS):
            for _d in (-1, 0):
                if 0 <= _c + _d < len(_KEYS[_r + 1]):
                    _near.add(_KEYS[_r + 1][_c + _d])
        _NEIGHBOURS[_ch] = "".join(sorted(_near))
TYPO_KINDS = ("swap", "drop", "double", "key")
TRIES = 24  # candidates one op may offer before `perturb` gives up on it
# the block shows 8 rows (meta.rs PREGROUND_CAP), a container the message points at and the person's own row among them, ranked
# by how well the words fit: a name typo ranks its rows lower, so it is made only where every row it grounds has room
BLOCK_ROOMY = 6


class _Ctx:
    def __init__(self, names: Names, keep: frozenset[str], rng: random.Random, needs: frozenset[str] | None):
        self.names, self.keep, self.rng, self.needs = names, keep, rng, needs
        self.dirty: set[str] = set()  # words an op already changed

    def kept(self, token: str) -> bool:
        """Whether a token carries a word the gold repeats as text: no op alters it, drops it or spaces around it."""
        return any(w in self.keep for w in fold_words(token))


def typo_variants(word: str, kind: str) -> list[str]:
    """Every slip of `kind` on `word` (the first letter kept), distinct and different from the word."""
    n, out = len(word), []
    if kind == "swap":  # two neighbouring letters trade places
        out = [word[:i] + word[i + 1] + word[i] + word[i + 2:] for i in range(1, n - 1) if word[i].lower() != word[i + 1].lower()]
    elif kind == "drop":  # a letter is missed
        out = [word[:i] + word[i + 1:] for i in range(1, n)]
    elif kind == "double":  # a key is hit twice
        out = [word[:i + 1] + word[i] + word[i + 1:] for i in range(1, n)
               if word[i].lower() != word[i - 1].lower() and (i + 1 == n or word[i].lower() != word[i + 1].lower())]
    elif kind == "key":  # a neighbouring key is hit instead
        for i in range(1, n):
            for sub in _NEIGHBOURS.get(word[i].lower(), ""):
                out.append(word[:i] + (sub.upper() if word[i].isupper() else sub) + word[i + 1:])
    else:
        raise ValueError(kind)
    return [w for w in dict.fromkeys(out) if w != word]


def typo_of(word: str, kind: str, rng: random.Random) -> str | None:
    """One slip of `kind` on `word`, drawn at random; None when the word has no place for it."""
    variants = typo_variants(word, kind)
    return rng.choice(variants) if variants else None


def _replace(text: str, start: int, end: int, new: str) -> str:
    return text[:start] + new + text[end:]


def _plain_word(base: str) -> bool:
    return base.isascii() and base.isalpha()


def _op_typo(text: str, ctx: _Ctx):
    doc = Doc(text)
    order = list(range(len(doc.toks)))
    ctx.rng.shuffle(order)
    for i in order:
        s, e, token = doc.toks[i]
        base = _base(token)
        low = base.lower()
        if (len(base) < 5 or not _plain_word(base) or doc.frozen[i] or protected(low) or low in ctx.keep or low in ctx.dirty
                or ctx.names.like(low) or ctx.names.nameish(low)):
            continue
        for kind in ctx.rng.sample(TYPO_KINDS, len(TYPO_KINDS)):
            variants = typo_variants(base, kind)
            ctx.rng.shuffle(variants)
            for new in variants:
                if ctx.names.safe_word(new.lower()):
                    yield _replace(text, s, s + len(base), new), {"op": "typo", "kind": kind, "from": base, "to": new}
                    break


def _op_name(text: str, ctx: _Ctx):
    """A slip in a word that names a row. The block of the noisy message must still show every row the clean one does: a name
    the message hit before is hit after, and no more than `BLOCK_ROOMY` rows are hit, so none is ranked out. The reference
    calls of a turn take their rows by `$key` from the block, so a typo that took a row out of it would leave the turn
    unanswerable in its own terms (the reference run fails with `ref names $key before the runtime showed it`), and a
    model trained on it would learn to spell a name it was never shown. A word that alone grounds its row therefore keeps
    its start: it loses its last letter. The word must also read as the same word to the runtime's disambiguation
    (`near`), which is why a name of four letters or fewer is never given a typo."""
    doc = Doc(text)
    before = ctx.names.grounded(text)
    # a message that already misspells a mention of a name (one slip off a name word) takes no second slip in the name
    if any(len(w) >= 5 and w not in ctx.names.tokens and ctx.names.nameish(w) for w in (_bare(t) for _, _, t in doc.toks)):
        return
    if ctx.needs is not None:  # only the rows the reference takes by `$key` must stay in the block
        before &= frozenset(ctx.names.ids[n] for n in ctx.needs if n in ctx.names.ids)
    order = list(range(len(doc.toks)))
    ctx.rng.shuffle(order)
    for i in order:
        s, e, token = doc.toks[i]
        base = _base(token)
        low = base.lower()
        if (len(base) < 4 or not _plain_word(base) or doc.frozen[i] or protected(low) or low in ctx.keep or low in ctx.dirty
                or low not in ctx.names.tokens):
            continue
        for kind in ctx.rng.sample(TYPO_KINDS, len(TYPO_KINDS)):
            if kind == "swap" and len(base) < 7:
                continue  # two edits to the runtime: it reaches them from 7 letters
            variants = typo_variants(base, kind)
            ctx.rng.shuffle(variants)
            for new in variants:
                candidate = _replace(text, s, s + len(base), new)
                after = ctx.names.grounded(candidate)
                if before <= after and ctx.names.row_count(after) <= BLOCK_ROOMY and ctx.names.safe_typo(new.lower(), low):
                    yield candidate, {"op": "name", "kind": kind, "from": base, "to": new}
                    break


def _cut(doc: Doc, first: int, last: int) -> str | None:
    """The text without tokens first..last and the gap beside them; None when a boundary of the sentence is in the way or
    fewer than two words would be left."""
    text, n = doc.text, len(doc.toks)
    if last + 1 < n:  # a word follows: the gap after the words goes with them
        if doc.gap(last).strip(" \t,") != "":
            return None
        out = text[:doc.toks[first][0]] + text[doc.toks[last + 1][0]:]
    elif first > 0:  # the last words: the gap before them goes, what follows (a ?) stays
        if text[doc.toks[first - 1][1]:doc.toks[first][0]].strip(" \t,") != "":
            return None
        out = text[:doc.toks[first - 1][1]] + text[doc.toks[last][1]:]
    else:
        return None
    return out if len(Doc(out).toks) >= 2 else None


def _op_drop(text: str, ctx: _Ctx):
    doc = Doc(text)
    n = len(doc.toks)
    spots = []
    for i, (s, e, token) in enumerate(doc.toks):
        word = _bare(token)
        if doc.hard[i] or ctx.kept(token) or any(c in token for c in _APOSTROPHES):
            continue
        if word in ("can", "could") and i + 1 < n and _bare(doc.toks[i + 1][2]) == "you" and doc.gap(i).strip(" \t") == "" \
                and not doc.hard[i + 1] and not ctx.kept(doc.toks[i + 1][2]):
            phrase, last = f"{word} you", i + 1
        elif word in ("a", "the", "my", "to", "of", "for", "please"):
            phrase, last = word, i
        else:
            continue
        if i > 0 and doc.text[doc.toks[i - 1][1]:s].strip(" \t") != "":
            continue  # a clause or sentence boundary before it
        after = last + 1 < n
        if phrase in ("a", "the", "my", "to", "of", "for") and not after:
            continue  # "what are you up to"
        if phrase in ("a", "the", "my") and doc.near(i, NEIGHBOUR_DATE | NEIGHBOUR_OTHER, 1):
            continue
        if phrase in ("to", "of", "for") and (doc.near(i, NEIGHBOUR_DATE, 3) or doc.near(i, NEIGHBOUR_OTHER, 1)
                                              or (phrase == "to" and i > 0 and _bare(doc.toks[i - 1][2]) == "up")):
            continue
        if phrase in ("please", "can you", "could you") and (doc.near(i, frozenset(), 1) or (after and doc.sem[last + 1] and phrase != "please")):
            continue  # beside a number; "can you text ...": a cue keeps its lead
        spots.append((i, last, phrase))
    ctx.rng.shuffle(spots)
    for i, last, phrase in spots:
        out = _cut(doc, i, last)
        if out is not None:
            yield out, {"op": "drop", "kind": phrase, "word": " ".join(doc.toks[k][2] for k in range(i, last + 1))}


# contractions whose apostrophe phones lose, and what they become (both forms are words the runtime already reads)
CONTRACTIONS = {
    "what's": "whats", "who's": "whos", "when's": "whens", "where's": "wheres", "how's": "hows", "that's": "thats",
    "there's": "theres", "here's": "heres", "it's": "its", "he's": "hes", "she's": "shes", "let's": "lets", "i'm": "im",
    "i'll": "ill", "i've": "ive", "i'd": "id", "you're": "youre", "you'll": "youll", "you've": "youve", "we've": "weve",
    "they're": "theyre", "they've": "theyve", "isn't": "isnt", "aren't": "arent", "wasn't": "wasnt", "weren't": "werent",
    "doesn't": "doesnt", "didn't": "didnt", "hasn't": "hasnt", "haven't": "havent", "hadn't": "hadnt", "wouldn't": "wouldnt",
    "couldn't": "couldnt", "shouldn't": "shouldnt",
}


def _op_apostrophe(text: str, ctx: _Ctx):
    doc = Doc(text)
    spots = []
    for i, (s, e, token) in enumerate(doc.toks):
        if doc.hard[i] or ctx.kept(token) or not any(c in token for c in _APOSTROPHES):
            continue
        low = token.replace("’", "'").lower()
        if low in CONTRACTIONS:
            spots.append((i, "contraction", CONTRACTIONS[low]))
        elif low.endswith("'s") and _plain_word(low[:-2]) and len(low) > 5:  # a possessive on a word that is no name
            word = low[:-2]
            if not (protected(word) or word in ctx.keep or ctx.names.like(word) or word in ctx.dirty or doc.frozen[i]):
                spots.append((i, "possessive", word + "s"))
    ctx.rng.shuffle(spots)
    for i, kind, new in spots:
        s, e, token = doc.toks[i]
        if token[:1].isupper():
            new = new[:1].upper() + new[1:]
        yield _replace(text, s, e, new), {"op": "apostrophe", "kind": kind, "from": token, "to": new}


def _op_capital(text: str, ctx: _Ctx):
    doc = Doc(text)
    if not doc.toks or doc.toks[0][0] != len(text) - len(text.lstrip()):
        return
    s, e, token = doc.toks[0]
    if not doc.hard[0] and token[0].islower() and token[0].isascii():
        yield _replace(text, s, s + 1, token[0].upper()), {"op": "capital", "kind": ""}


def _op_period(text: str, ctx: _Ctx):
    stripped = text.rstrip()
    doc = Doc(text)
    if not doc.toks or not stripped[-1:].isalpha() or not stripped[-1:].isascii():
        return  # already ends in punctuation, or in a digit, an emoji, ...
    s, e, token = doc.toks[-1]
    if e == len(stripped) and not doc.hard[-1] and not ctx.kept(token):
        yield stripped + "." + text[len(stripped):], {"op": "period", "kind": ""}


def _op_space(text: str, ctx: _Ctx):
    doc = Doc(text)
    spots = [i for i in range(len(doc.toks) - 1) if doc.gap(i) == " " and not doc.hard[i] and not doc.hard[i + 1]
             and not (ctx.kept(doc.toks[i][2]) and ctx.kept(doc.toks[i + 1][2]))]
    ctx.rng.shuffle(spots)
    for i in spots:
        e = doc.toks[i][1]
        yield text[:e] + "  " + text[e + 1:], {"op": "space", "kind": ""}


# fillers a message starts or ends with that carry no request. A bare yes, a retraction, "just", "now" and "then" are
# words the runtime reads, so they are not among them; "ok" and "ok so" are, and the guards decide where they go
LEAD_FILLERS = (("hey",), ("hi",), ("hello",), ("hmm",), ("um",), ("uh",), ("oh",), ("well",), ("so",), ("ok", "so"),
                ("okay", "so"), ("ok",), ("okay",), ("quick", "one"), ("quick", "question"), ("right", "so"), ("alright", "so"),
                ("anyway",))
TRAIL_FILLERS = (("thanks",), ("thx",), ("ta",), ("cheers",), ("mate",), ("pls",), ("lol",), ("haha",), ("ty",), ("thank", "you"))


def _op_fragment(text: str, ctx: _Ctx):
    doc = Doc(text)
    n = len(doc.toks)
    words = [_bare(t) for _, _, t in doc.toks]
    spots = []
    for filler in LEAD_FILLERS:
        k = len(filler)
        if (tuple(words[:k]) == filler and n - k >= 2 and not any(doc.hard[:k]) and not any(ctx.kept(doc.toks[j][2]) for j in range(k))
                and all(doc.gap(j).strip(" \t") == "" for j in range(k - 1))):
            spots.append((0, k - 1, " ".join(filler), "lead"))
    for filler in TRAIL_FILLERS:
        k = len(filler)
        if (n - k >= 2 and tuple(words[n - k:]) == filler and not any(doc.hard[n - k:])
                and not any(ctx.kept(doc.toks[j][2]) for j in range(n - k, n))):
            spots.append((n - k, n - 1, " ".join(filler), "trail"))
    ctx.rng.shuffle(spots)
    for first, last, phrase, where in spots:
        out = _cut(doc, first, last)
        if out is not None:
            yield out, {"op": "fragment", "kind": where, "word": phrase}


_APPLY = {"typo": _op_typo, "name": _op_name, "drop": _op_drop, "apostrophe": _op_apostrophe, "capital": _op_capital,
          "period": _op_period, "space": _op_space, "fragment": _op_fragment}


def _rng(*parts) -> random.Random:
    digest = hashlib.sha256("\x1f".join(str(p) for p in parts).encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def consistent(before: str, after: str) -> bool:
    """Whether `after` keeps what `before` is to the gold and the runtime: every token of the closed vocabularies, with
    digits and quotes, in order (case folded, apostrophes dropped), the quoted text, and the readings of the message that
    `signature` lists; and it still says something."""
    if not after.strip() or len(Doc(after).toks) < 1:
        return False
    if _sem_sequence(before) != _sem_sequence(after) or signature(before) != signature(after):
        return False
    return [before[a:b] for a, b in _quoted_spans(before)] == [after[a:b] for a, b in _quoted_spans(after)]


def label(op: dict) -> str:
    """The name an op is counted under: `typo:swap`, `drop:the`, `capital`."""
    return f"{op['op']}:{op['kind']}" if op.get("kind") else op["op"]


def perturb(message: str, world_names: "Iterable[str] | Names | None", seed, level: str = "light", *,
            keep: Iterable[str] = (), only: Iterable[str] | None = None,
            needs: Iterable[str] | None = None) -> tuple[str, list[dict]]:
    """`message` with the noise of `level` ("light": one op, "heavy": two or three), and what changed.

    `world_names`: the names the world's rows answer to (`names_of_world`). `keep`: words the gold repeats (`keep_words`).
    `needs`: the names of the rows the turn's reference calls take by `$key` (`plan_turns` reads them off the turn); a name
    typo leaves them in the block. None: every row the message grounds is kept (the strictest reading). `only`: restrict
    the draw to these ops (a diagnostic). Returns (message, []) when no op applies. Deterministic in all the arguments."""
    if level not in LEVELS:
        raise ValueError(f"level {level!r}: want one of {LEVELS}")
    only = None if only is None else list(only)
    unknown = set(only or ()) - set(OPS)
    if unknown:
        raise ValueError(f"unknown ops {sorted(unknown)}: want {OPS}")
    allowed = [op for op in OPS if only is None or op in only]
    rng = _rng(seed, level, message)
    ctx = _Ctx(names_index(world_names), frozenset(fold(w) for w in keep), rng, None if needs is None else frozenset(needs))
    want = 1 if level == "light" else (2 if rng.random() < 0.6 else 3)
    order = sorted(allowed, key=lambda op: rng.random() ** (1.0 / WEIGHTS[op]), reverse=True)
    text, done = message, []
    for op in order:
        if len(done) == want:
            break
        for tries, (candidate, record) in enumerate(_APPLY[op](text, ctx)):
            if tries >= TRIES:
                break
            if consistent(text, candidate):
                text = candidate
                done.append(record)
                if "to" in record:
                    ctx.dirty.add(fold(record["to"]))
                break
    return text, done


# ---------------------------------------------------------------------------------------------
# Which turns, for the two users
# ---------------------------------------------------------------------------------------------

def turn_seed(seed, session_id: str, turn: int) -> str:
    return f"{seed}:{session_id}:{turn}"


def plan_turns(session: dict, world_names: "Iterable[str] | Names | None", share: float, seed, level: str,
               only: Iterable[str] | None = None, keys: dict[str, str] | None = None) -> dict[int, dict]:
    """The turns of a session that get noise, `{turn index: {"text", "ops", "clean", "level"}}`: each turn is chosen with
    probability `share` by a draw keyed on (seed, session id, turn), and perturbed with `keep_words(turn)` kept and the
    rows its reference takes by `$key` (named by `keys`, `key_names(world)`) kept in the block. A turn no op applies to is
    left out. The same session, seed, level and share give the same plan wherever it is made."""
    names = names_index(world_names)
    out: dict[int, dict] = {}
    for ti, turn in enumerate(session["turns"]):
        if share < 1.0 and _rng(seed, "share", session["id"], ti).random() >= share:
            continue
        needs = None if keys is None else [keys[k] for k in ref_keys(turn) if k in keys]
        text, ops = perturb(turn["user"], names, turn_seed(seed, session["id"], ti), level, keep=keep_words(turn), only=only,
                            needs=needs)
        if ops and text != turn["user"]:
            out[ti] = {"text": text, "ops": ops, "clean": turn["user"], "level": level}
    return out


def put_back_which(noisy: Iterable[int], bad: list[int]) -> int:
    """Which noisy turn to put back after a failure that first shows at turn `min(bad)` (0-based): that one if it has noise,
    else the nearest noisy one before it (a failure shows at the turn it happens in, or later), else the last noisy turn."""
    noisy = sorted(noisy)
    if bad:
        first = min(bad)
        if first in noisy:
            return first
        before = [t for t in noisy if t < first]
        if before:
            return before[-1]
    return noisy[-1]


def restore(session: dict) -> dict:
    """A copy of a session built by `build.py --augment` or `eval/perturb.py` with every noisy message put back as it was
    (`noise.clean`), the `noise` keys dropped, and the `augmented` tag and the `-noise-<level>` id suffix taken off."""
    s = copy.deepcopy(session)
    for turn in s["turns"]:
        n = turn.pop("noise", None)
        if n:
            turn["user"] = n["clean"]
    s["tags"] = [t for t in s.get("tags", []) if t != "augmented"]
    return {**s, "id": re.sub(r"-noise-(?:%s)$" % "|".join(LEVELS), "", s["id"])}


def main(argv: list[str] | None = None) -> None:
    import argparse
    ap = argparse.ArgumentParser(description="print the noise of one or more messages (a quick look; no world unless --world)")
    ap.add_argument("messages", nargs="+")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--level", choices=LEVELS, default="light")
    ap.add_argument("--only", help="comma list of ops")
    ap.add_argument("--world", help="a world JSON file: its names are the world's names")
    a = ap.parse_args(argv)
    names = names_of_world(json.load(open(a.world))) if a.world else []
    for m in a.messages:
        text, ops = perturb(m, names, a.seed, a.level, only=a.only.split(",") if a.only else None)
        print(json.dumps({"in": m, "out": text, "ops": [label(o) for o in ops]}, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
