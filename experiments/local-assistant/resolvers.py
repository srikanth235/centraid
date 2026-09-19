"""Deterministic resolvers: phrases in, structured referents out.

The model never resolves a referent and never writes SQL. It picks an
operation and copies a phrase into a slot; everything in this module turns
that phrase into ids against the seeded world.

Every resolver returns a `Resolution`, never raises for a user-visible
outcome. Three outcomes exist:

- ``ok``        — ``ids`` holds the resolved referents.
- ``ambiguous`` — more than one candidate; ``candidates`` says which, and the
                  protocol turns this into a ``clarify``.
- ``not_found`` — nothing matched; the protocol turns this into a ``none``.

Relative dates resolve against an injected ``today`` (``world.TODAY``). No
resolver reads the wall clock.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

from catalogue import by_name
from world import TODAY

Outcome = Literal["ok", "ambiguous", "not_found"]


@dataclass(frozen=True)
class Resolution:
    """What a phrase resolved to."""

    outcome: Outcome
    ids: list[str] = field(default_factory=list)
    candidates: list[str] = field(default_factory=list)
    detail: str = ""

    @property
    def ok(self) -> bool:
        """True when the phrase resolved to at least one referent."""
        return self.outcome == "ok"


def _ok(ids: list[str], detail: str = "") -> Resolution:
    return Resolution("ok", ids=list(ids), detail=detail)


def _ambiguous(candidates: list[str], detail: str) -> Resolution:
    return Resolution("ambiguous", candidates=list(candidates), detail=detail)


def _missing(detail: str) -> Resolution:
    return Resolution("not_found", detail=detail)


def _norm(text: str) -> str:
    """Lowercase, punctuation-stripped, single-spaced.

    ``-`` and ``:`` survive because ISO dates and clock times pass through here.
    """
    return re.sub(r"[^a-z0-9:\- ]+", " ", (text or "").lower()).strip()


# --------------------------------------------------------------------- dates

_WEEKDAYS = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}

_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}


@dataclass(frozen=True)
class DateRange:
    """An inclusive-start, exclusive-end day range."""

    start: date
    end: date

    def contains(self, day: date) -> bool:
        """Is this day inside the range?"""
        return self.start <= day < self.end

    def as_iso(self) -> tuple[str, str]:
        """The bounds as ISO day strings, for parameterised SQL."""
        return self.start.isoformat(), self.end.isoformat()


def _week_start(day: date) -> date:
    """The Monday of the week containing `day`."""
    return day - timedelta(days=day.weekday())


def resolve_date_range(phrase: str, today: date = TODAY) -> DateRange | None:
    """A date phrase as a day range, or None when it is not a date phrase.

    ``today`` is injected so every run of the suite scores identically. The
    phrases here are the ones the catalogue's ``window``/``due``/``when``
    slots are documented to accept.
    """
    text = _norm(phrase)
    if not text:
        return None

    iso = re.search(r"(\d{4})-(\d{2})-(\d{2})", text)
    if iso:
        try:
            day = date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
        except ValueError:
            # A span tagger copies whatever the user typed, "2026-02-30"
            # included. An impossible day is not a date phrase.
            return None
        return DateRange(day, day + timedelta(days=1))

    month_only = re.fullmatch(r"(\d{4})-(\d{2})", text)
    if month_only:
        year, month = int(month_only.group(1)), int(month_only.group(2))
        start = date(year, month, 1)
        end = date(year + (month == 12), (month % 12) + 1, 1)
        return DateRange(start, end)

    if "today" in text or "tonight" in text:
        return DateRange(today, today + timedelta(days=1))
    if "tomorrow" in text:
        return DateRange(today + timedelta(days=1), today + timedelta(days=2))
    if "yesterday" in text:
        return DateRange(today - timedelta(days=1), today)

    if "overdue" in text:
        # Everything strictly before today, back to the start of the world.
        return DateRange(date(2000, 1, 1), today)

    this_week = _week_start(today)
    if "next week" in text:
        return DateRange(this_week + timedelta(days=7), this_week + timedelta(days=14))
    if "last week" in text:
        return DateRange(this_week - timedelta(days=7), this_week)
    if "this week" in text or text == "the week":
        return DateRange(this_week, this_week + timedelta(days=7))

    month_start = today.replace(day=1)
    if "next month" in text:
        year = month_start.year + (month_start.month == 12)
        month = (month_start.month % 12) + 1
        start = date(year, month, 1)
        end = date(year + (month == 12), (month % 12) + 1, 1)
        return DateRange(start, end)
    if "last month" in text:
        year = month_start.year - (month_start.month == 1)
        month = 12 if month_start.month == 1 else month_start.month - 1
        return DateRange(date(year, month, 1), month_start)
    if "this month" in text:
        year = month_start.year + (month_start.month == 12)
        month = (month_start.month % 12) + 1
        return DateRange(month_start, date(year, month, 1))

    for name, number in _MONTHS.items():
        if name in text:
            year = today.year
            start = date(year, number, 1)
            end = date(year + (number == 12), (number % 12) + 1, 1)
            return DateRange(start, end)

    for name, index in _WEEKDAYS.items():
        if name not in text:
            continue
        if "last" in text:
            back = (today.weekday() - index) % 7 or 7
            day = today - timedelta(days=back)
        else:
            forward = (index - today.weekday()) % 7 or 7
            day = today + timedelta(days=forward)
        return DateRange(day, day + timedelta(days=1))

    ordinal = _ordinal_day_of_month(text, today)
    if ordinal is not None:
        return DateRange(ordinal, ordinal + timedelta(days=1))

    return None


# Ordinal day names, spelled and numeric. A span tagger copies what the user
# said — "the twenty-fifth", "the 3rd" — so the surface form has to land on the
# same day as the ISO form a canonicalising model would have produced.
_ORDINAL_UNITS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6,
    "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10, "eleventh": 11,
    "twelfth": 12, "thirteenth": 13, "fourteenth": 14, "fifteenth": 15,
    "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19,
    "twentieth": 20, "thirtieth": 30,
}

# Words that turn an ordinal into a reference into the last result rather than
# a date: "the first one", "the last two". Those belong to resolve_reference.
_ORDINAL_NOT_A_DATE = {
    "one", "ones", "two", "three", "four", "five", "item", "items", "result",
    "results", "task", "tasks", "note", "notes", "photo", "photos", "doc",
    "docs", "document", "documents", "person", "people",
}


def _ordinal_day_of_month(text: str, today: date) -> date | None:
    """A bare ordinal as a day of the current month, or None.

    Only a phrase that is *nothing but* an ordinal counts. "the first one"
    carries a trailing noun and is a reference into the last result, not a
    date, so it is rejected here and handled by ``resolve_reference``.
    """
    words = text.replace("-", " ").split()
    words = [w for w in words if w not in ("the", "on", "of", "month", "this")]
    if not words or any(w in _ORDINAL_NOT_A_DATE for w in words):
        return None

    number: int | None = None
    if len(words) == 1:
        numeric = re.fullmatch(r"(?P<n>\d{1,2})(?:st|nd|rd|th)", words[0])
        if numeric:
            number = int(numeric.group("n"))
        elif words[0] in _ORDINAL_UNITS:
            number = _ORDINAL_UNITS[words[0]]
    elif len(words) == 2 and words[0] in ("twenty", "thirty") and words[1] in _ORDINAL_UNITS:
        unit = _ORDINAL_UNITS[words[1]]
        if unit <= 9:
            number = (20 if words[0] == "twenty" else 30) + unit
    if number is None or not 1 <= number <= 31:
        return None
    try:
        return today.replace(day=number)
    except ValueError:
        return None


def resolve_day(phrase: str, today: date = TODAY) -> date | None:
    """A single-day phrase as one day, or None."""
    window = resolve_date_range(phrase, today)
    if window is None:
        return None
    return window.start


def resolve_datetime(phrase: str, today: date = TODAY) -> str | None:
    """A date-and-time phrase as an ISO ``YYYY-MM-DDTHH:MM`` stamp, or None.

    The time half is optional: with no clock words the stamp lands at 09:00,
    which is what a bare "move it to Thursday" means on a calendar.
    """
    day = resolve_day(phrase, today)
    if day is None:
        return None
    text = _norm(phrase)
    hour, minute = 9, 0
    clock = re.search(r"\b(\d{1,2}):(\d{2})\b", text)
    if clock:
        hour, minute = int(clock.group(1)), int(clock.group(2))
    else:
        bare = re.search(r"\bat (\d{1,2})\b", text)
        if bare:
            hour = int(bare.group(1))
    if "pm" in text and hour < 12:
        hour += 12
    if "am" in text and hour == 12:
        hour = 0
    if not clock and not re.search(r"\bat \d", text):
        if "morning" in text:
            hour = 9
        elif "afternoon" in text:
            hour = 14
        elif "evening" in text or "tonight" in text:
            hour = 19
    return f"{day.isoformat()}T{hour:02d}:{minute:02d}"


# -------------------------------------------------------------------- people

# Group phrase grammar. A span tagger copies the user's own words, so the same
# group is named several ways — "people at Initech", "everyone at Initech",
# "the Initech people" — and each of them has to reach the same ids as the
# canonical form. Each entry is (interpretation, pattern); `resolve_people`
# tries them in order and keeps the first that resolves, so a phrase that reads
# as a company but names an event ("people at the design review") falls through
# to the event reading rather than failing.
_GROUP_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # Company, named after a preposition.
    ("company", re.compile(
        r"^(?:(?:the|my|our|his|her|their)\s+)?(?:people|everyone|everybody|anyone|folks|contacts|team|colleagues)"
        r"\s+(?:i\s+know\s+)?(?:at|from|with|in)\s+(?:(?:the|my|our|his|her|their)\s+)?(?P<x>.+)$")),
    # Attendees, named after a preposition.
    ("event", re.compile(
        r"^(?:(?:the|my|our|his|her|their)\s+)?(?:attendees|guests|invitees)\s+(?:of|at|for|from|in)"
        r"\s+(?:(?:the|my|our|his|her|their)\s+)?(?P<x>.+)$")),
    # Attendees, named by what they did.
    ("event", re.compile(
        r"^(?:(?:the|my|our|his|her|their)\s+)?(?:people|everyone|everybody|folks|ones)\s+(?:who\s+|that\s+)?"
        r"(?:went\s+to|attended|came\s+to|were\s+at|was\s+at|showed\s+up\s+to)"
        r"\s+(?:(?:the|my|our|his|her|their)\s+)?(?P<x>.+)$")),
    # Attendees, named by a question.
    ("event", re.compile(
        r"^(?:who\s+(?:was|were)\s+at|who\s+came\s+to|who\s+went\s+to|who\s+attended|"
        r"who\s+is\s+coming\s+to|who\s+s\s+coming\s+to)\s+(?:(?:the|my|our|his|her|their)\s+)?(?P<x>.+)$")),
    # Attendees, named by a suffix: "the design review attendees".
    ("event", re.compile(r"^(?:(?:the|my|our|his|her|their)\s+)?(?P<x>.+?)\s+(?:attendees|guests|invitees)$")),
    # Company, named by a suffix: "the Initech people".
    ("company", re.compile(
        r"^(?:(?:the|my|our|his|her|their)\s+)?(?P<x>.+?)\s+(?:people|folks|team|crowd|contacts|colleagues|lot)$")),
    # The original broad prepositional form, kept last as a catch-all.
    ("event", re.compile(
        r"^(?:(?:the|my|our|his|her|their)\s+)?(?:people|everyone|anyone|folks|guests?)\s+(?:of|at|from|in)"
        r"\s+(?:(?:the|my|our|his|her|their)\s+)?(?P<x>.+)$")),
]

_DEICTIC_PEOPLE = {
    "those people", "them", "they", "these people", "those", "these",
    "the same people", "that group", "the group", "the attendees",
    "the same group", "all of them", "everyone there",
}

# The deictics that point at one non-person thing the previous turn produced:
# "move it to Thursday", "book flights for it".
_DEICTIC_THING = {"it", "that", "that one", "this", "this one", "the same one"}


# Determiners, possessives and the type words a user puts around a name. A
# verbatim span carries them ("the offsite flights task", "my Work notebook")
# and they never help identify a row, so they are dropped before scoring.
_FILLER = {
    "the", "a", "an", "my", "our", "his", "her", "their", "its", "that",
    "this", "these", "those", "some", "any", "one", "on", "at", "in", "for",
    "to", "of", "about", "s",
}

_TYPE_WORDS = {
    "task", "tasks", "note", "notes", "notebook", "document", "documents",
    "doc", "docs", "file", "files", "item", "items", "entry", "entries",
    "event", "events", "meeting", "meetings", "photo", "photos", "picture",
    "pictures", "album", "albums", "folder", "folders", "project", "projects",
    "list", "lists", "thing", "things",
}


def _content_tokens(text: str, drop_type_words: bool = True) -> list[str]:
    """The tokens of a phrase that could identify a row."""
    skip = _FILLER | _TYPE_WORDS if drop_type_words else _FILLER
    return [token for token in text.split() if token not in skip]


def _token_hits(token: str, haystack: str) -> bool:
    """Does a token match a word in the haystack, plural or singular?

    Matching is anchored to a word boundary rather than a bare substring, so
    "it" no longer matches inside "Initech", and a prefix match lets "flight"
    find "flights". The singular of a plural token is tried too.
    """
    candidates = {token}
    if len(token) > 3 and token.endswith("s"):
        candidates.add(token[:-1])
    if len(token) > 4 and token.endswith("es"):
        candidates.add(token[:-2])
    return any(re.search(rf"\b{re.escape(candidate)}", haystack) for candidate in candidates)


def _people_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return list(conn.execute("SELECT * FROM person ORDER BY id"))


def resolve_person(conn: sqlite3.Connection, phrase: str, company: str | None = None) -> Resolution:
    """One person from a name phrase.

    First name, full name and nickname all match. A first name shared by two
    people is ``ambiguous`` unless ``company`` narrows it — this is the path
    the suite's clarify cases walk.
    """
    text = _norm(phrase)
    if not text:
        return _missing("empty name")
    rows = _people_rows(conn)
    if company:
        wanted = _norm(company)
        rows = [r for r in rows if _norm(r["company"] or "") == wanted]

    exact_full = [r for r in rows if _norm(r["full_name"]) == text]
    if len(exact_full) == 1:
        return _ok([exact_full[0]["id"]])
    if len(exact_full) > 1:
        return _ambiguous([r["id"] for r in exact_full], f"several people are called {phrase}")

    by_token = [
        r
        for r in rows
        if _norm(r["first_name"]) == text
        or _norm(r["nickname"] or "\0") == text
        or text in _norm(r["full_name"]).split()
    ]
    if len(by_token) == 1:
        return _ok([by_token[0]["id"]])
    if len(by_token) > 1:
        return _ambiguous([r["id"] for r in by_token], f"more than one {phrase}")

    substring = [r for r in rows if text in _norm(r["full_name"])]
    if len(substring) == 1:
        return _ok([substring[0]["id"]])
    if len(substring) > 1:
        return _ambiguous([r["id"] for r in substring], f"more than one match for {phrase}")
    return _missing(f"no person matching {phrase!r}")


def resolve_people(
    conn: sqlite3.Connection,
    phrase: str,
    context: "Context | None" = None,
) -> Resolution:
    """A person, a group phrase, or a reference into the last result.

    This is the resolver that makes cross-app-as-one-call work: the model
    writes ``people="attendees of the design review"`` and never learns that
    two tables were joined to answer it.
    """
    text = _norm(phrase)
    if not text:
        return _missing("empty people phrase")

    # A deictic or filter phrase points at the previous result only when that
    # result held people. After a list of photos, "only the ones with Neha"
    # narrows the photos, and the app's own handler owns that path.
    filter_form = (
        text in _DEICTIC_PEOPLE
        or text.startswith("the ones")
        or text.startswith("only the ones")
    )
    if context is not None and context.last_kind in ("", "person"):
        pointed = resolve_reference(conn, phrase, context, kind="person")
        # A filter form is *only* a reference, so its failure is the answer.
        # An ordinal ("the last one") is likewise a reference when it resolves;
        # anything else falls through to a name lookup.
        if filter_form or pointed.ok:
            return pointed

    if text in {"everyone i owe", "people i owe", "anyone i owe"}:
        ids = [
            row["person_id"]
            for row in conn.execute(
                "SELECT DISTINCT person_id FROM tally_entry WHERE settled = 0 "
                "GROUP BY person_id HAVING SUM(amount) < 0 ORDER BY person_id"
            )
        ]
        return _ok(ids, "everyone I owe") if ids else _missing("I owe nobody")

    if text in {"everyone who owes me", "people who owe me", "anyone who owes me", "who owes me"}:
        ids = [
            row["person_id"]
            for row in conn.execute(
                "SELECT person_id FROM tally_entry WHERE settled = 0 "
                "GROUP BY person_id HAVING SUM(amount) > 0 ORDER BY person_id"
            )
        ]
        return _ok(ids, "everyone who owes me") if ids else _missing("nobody owes me")

    group = _resolve_group_phrase(conn, text)
    if group is not None:
        return group

    # "Neha and Marcus" — a small explicit list. Every member must resolve.
    parts = [p.strip() for p in re.split(r"\band\b|,", phrase) if p.strip()]
    if len(parts) > 1:
        ids: list[str] = []
        for part in parts:
            one = resolve_person(conn, part)
            if not one.ok:
                return one
            ids.extend(one.ids)
        return _ok(sorted(set(ids)), "explicit list")

    return resolve_person(conn, phrase)


def _attendees_of(conn: sqlite3.Connection, phrase: str) -> Resolution:
    """Everybody invited to the event that phrase names."""
    event = resolve_event(conn, phrase)
    if not event.ok:
        return event
    ids = [
        row["person_id"]
        for row in conn.execute(
            "SELECT person_id FROM attendee WHERE event_id = ? ORDER BY person_id",
            (event.ids[0],),
        )
    ]
    return _ok(ids, "attendees") if ids else _missing("that event has no attendees")


def _resolve_group_phrase(conn: sqlite3.Connection, text: str) -> Resolution | None:
    """The first group reading of a phrase that resolves, or None.

    Returns None when the phrase is not a group phrase at all, so the caller
    can fall through to a personal name. When it *is* a group phrase but no
    reading resolves, the first reading's failure is returned, because that is
    the one whose wording the user chose.
    """
    first_failure: Resolution | None = None
    for interpretation, pattern in _GROUP_PATTERNS:
        match = pattern.match(text)
        if not match:
            continue
        argument = match.group("x")
        found = (
            resolve_company_people(conn, argument)
            if interpretation == "company"
            else _attendees_of(conn, argument)
        )
        if found.ok:
            return found
        if first_failure is None:
            first_failure = found
    return first_failure


def resolve_company_people(conn: sqlite3.Connection, company: str) -> Resolution:
    """Everybody recorded at one company."""
    wanted = _norm(company)
    ids = [r["id"] for r in _people_rows(conn) if _norm(r["company"] or "") == wanted]
    if ids:
        return _ok(ids, f"people at {company}")
    return _missing(f"nobody recorded at {company!r}")


# -------------------------------------------------------------------- events


def resolve_event(
    conn: sqlite3.Connection,
    phrase: str,
    today: date = TODAY,
    context: "Context | None" = None,
) -> Resolution:
    """One event from a title phrase, optionally carrying a date word.

    The date half narrows rather than selects: "the design review" and "the
    design review last Thursday" both land on one row, but the second one
    survives a world with two design reviews.

    With a ``context``, a bare "it" or "that" binds to the event the previous
    turn produced, which is how a verbatim span says "for it".
    """
    text = _norm(phrase)
    if not text:
        return _missing("empty event phrase")
    window = resolve_date_range(phrase, today)

    if context is not None and text in _DEICTIC_THING and context.last_kind == "event":
        pointed = resolve_reference(conn, phrase, context, kind="event")
        if pointed.ok:
            return pointed

    rows = list(conn.execute("SELECT * FROM event ORDER BY starts, id"))
    tokens = _content_tokens(text)

    scored: list[tuple[int, sqlite3.Row]] = []
    for row in rows:
        title = _norm(row["title"])
        hits = sum(1 for token in tokens if _token_hits(token, title))
        if hits == 0:
            continue
        if window is not None:
            day = date.fromisoformat(row["starts"][:10])
            if not window.contains(day):
                continue
        scored.append((hits, row))

    if not scored:
        return _missing(f"no event matching {phrase!r}")
    best = max(hits for hits, _ in scored)
    winners = [row for hits, row in scored if hits == best]
    if len(winners) == 1:
        return _ok([winners[0]["id"]])
    return _ambiguous([r["id"] for r in winners], f"more than one event matches {phrase!r}")


# ------------------------------------------------- references into the result


@dataclass
class Context:
    """Conversation state carried between turns.

    ``last_ids`` and ``last_kind`` are what a deictic phrase points at; the
    executor refreshes them after every read and every write.
    """

    last_ids: list[str] = field(default_factory=list)
    last_kind: str = ""
    last_operation: str = ""
    last_request: str = ""

    def remember(self, kind: str, ids: list[str], operation: str = "", request: str = "") -> None:
        """Record what the turn just produced."""
        self.last_kind = kind
        self.last_ids = list(ids)
        if operation:
            self.last_operation = operation
        if request:
            self.last_request = request


_ORDINALS = {
    "first": 1, "1st": 1, "second": 2, "2nd": 2, "third": 3, "3rd": 3,
    "fourth": 4, "4th": 4, "fifth": 5, "5th": 5, "last": -1,
}

_COUNTS = {"two": 2, "three": 3, "four": 4, "couple": 2, "both": 2}

# Every phrase that means "the previous result, all of it". The two deictic
# sets are folded in so a phrase that names the group ("they", "the attendees")
# or the thing ("it", "this one") reaches the same branch as a bare "those".
_WHOLE_RESULT = {
    "those", "them", "these", "all of them", "all of those", "the whole lot",
    "that", "it", "that one", "those ones", "the same ones",
} | _DEICTIC_PEOPLE | _DEICTIC_THING


def resolve_reference(
    conn: sqlite3.Connection,
    phrase: str,
    context: Context,
    kind: str = "",
) -> Resolution:
    """An ordinal or deictic phrase against the previous result.

    Handles "the first one", "those", "the first two", "the last one" and the
    filter form "only the ones with Neha" — the last of which narrows the
    previous result by a person, which is the multi-turn shape the brief calls
    a reference into a result.
    """
    text = _norm(phrase)
    if not context.last_ids:
        return _missing("there is no previous result to point at")
    if kind and context.last_kind and kind != context.last_kind:
        return _missing(f"the last result held {context.last_kind}, not {kind}")
    ids = list(context.last_ids)

    filter_match = re.search(r"only the ones (?:with|for|about|involving) (?P<who>.+)$", text)
    if filter_match:
        return _filter_by_person(conn, ids, context.last_kind, filter_match.group("who"))
    filter_match = re.search(r"^(?:the ones|ones) (?:with|for|about|involving) (?P<who>.+)$", text)
    if filter_match:
        return _filter_by_person(conn, ids, context.last_kind, filter_match.group("who"))

    count_match = re.search(r"\b(?:first|last) (?P<n>two|three|four|couple|\d+)\b", text)
    if count_match:
        raw = count_match.group("n")
        count = _COUNTS.get(raw, int(raw) if raw.isdigit() else 0)
        if count <= 0:
            return _missing(f"cannot read a count out of {phrase!r}")
        chosen = ids[-count:] if "last" in text else ids[:count]
        return _ok(chosen, "slice of the last result")

    for word, index in _ORDINALS.items():
        if re.search(rf"\b{word}\b", text):
            if index == -1:
                return _ok([ids[-1]], "last of the last result")
            if index > len(ids):
                return _missing(f"the last result held only {len(ids)}")
            return _ok([ids[index - 1]], "nth of the last result")

    if text in _WHOLE_RESULT or text.startswith("those ") or text.startswith("that "):
        return _ok(ids, "the whole last result")

    return _missing(f"{phrase!r} is not a reference into the last result")


_FILTER_JOIN = {
    "photo": ("photo_person", "photo_id"),
    "note": ("note_person", "note_id"),
    "task": ("task_assignee", "task_id"),
    "event": ("attendee", "event_id"),
}


def _filter_by_person(
    conn: sqlite3.Connection,
    ids: list[str],
    kind: str,
    who: str,
) -> Resolution:
    """Narrow a previous result to the rows involving one person."""
    person = resolve_person(conn, who)
    if not person.ok:
        return person
    if kind == "person":
        return _ok([i for i in ids if i in person.ids], "filtered people")
    join = _FILTER_JOIN.get(kind)
    if join is None:
        return _missing(f"cannot filter {kind or 'that'} by a person")
    table, column = join
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT {column} AS id FROM {table} "  # noqa: S608 - table/column come from _FILTER_JOIN, never user text
        f"WHERE person_id = ? AND {column} IN ({placeholders})",
        (person.ids[0], *ids),
    )
    kept = {row["id"] for row in rows}
    ordered = [i for i in ids if i in kept]
    if not ordered:
        return _missing("nothing in the last result involves that person")
    return _ok(ordered, "filtered last result")


# --------------------------------------------------- named things, generally


def _resolve_named(
    conn: sqlite3.Connection,
    phrase: str,
    table: str,
    column: str,
    label: str,
    context: Context | None = None,
    kind: str = "",
) -> Resolution:
    """One row of `table` whose `column` best matches a phrase.

    ``table`` and ``column`` are literals chosen by the caller, never user
    text; the phrase itself is always bound as a parameter.
    """
    text = _norm(phrase)
    if not text:
        return _missing(f"empty {label} phrase")
    if context is not None:
        pointed = resolve_reference(conn, phrase, context, kind=kind)
        if pointed.ok:
            return pointed

    rows = list(conn.execute(f"SELECT id, {column} AS label FROM {table} ORDER BY id"))  # noqa: S608 - literals
    tokens = _content_tokens(text)
    if not tokens:
        # The phrase was nothing but determiners and a type word ("that task"),
        # so there is nothing to match on but the previous result.
        return _missing(f"no {label} matching {phrase!r}")
    scored = []
    for row in rows:
        haystack = _norm(row["label"])
        hits = sum(1 for token in tokens if _token_hits(token, haystack))
        if hits:
            scored.append((hits, row["id"]))
    if not scored:
        return _missing(f"no {label} matching {phrase!r}")
    best = max(hits for hits, _ in scored)
    winners = [rid for hits, rid in scored if hits == best]
    if len(winners) == 1:
        return _ok(winners)
    return _ambiguous(winners, f"more than one {label} matches {phrase!r}")


def resolve_task(conn: sqlite3.Connection, phrase: str, context: Context | None = None) -> Resolution:
    """One task from a phrase or a reference into the last result."""
    return _resolve_named(conn, phrase, "task", "title", "task", context, kind="task")


def resolve_note(conn: sqlite3.Connection, phrase: str, context: Context | None = None) -> Resolution:
    """One note from a phrase or a reference into the last result."""
    return _resolve_named(conn, phrase, "note", "title", "note", context, kind="note")


def resolve_document(conn: sqlite3.Connection, phrase: str, context: Context | None = None) -> Resolution:
    """One or more documents from a phrase or a reference into the last result."""
    return _resolve_named(conn, phrase, "document", "name", "document", context, kind="document")


def resolve_locker_item(conn: sqlite3.Connection, phrase: str, context: Context | None = None) -> Resolution:
    """One locker item from a phrase or a reference into the last result."""
    return _resolve_named(conn, phrase, "locker_item", "service", "locker item", context, kind="locker_item")


def resolve_photos(conn: sqlite3.Connection, phrase: str, context: Context | None = None) -> Resolution:
    """Photos, which are only ever named by reference into the last result."""
    if context is None:
        return _missing("photos can only be named by reference")
    return resolve_reference(conn, phrase, context, kind="photo")


def resolve_album(conn: sqlite3.Connection, name: str) -> Resolution:
    """One album by name."""
    return _resolve_named(conn, name, "album", "name", "album")


def resolve_folder(conn: sqlite3.Connection, name: str) -> Resolution:
    """One folder by name."""
    return _resolve_named(conn, name, "folder", "name", "folder")


def resolve_notebook(conn: sqlite3.Connection, name: str) -> Resolution:
    """One notebook by name."""
    return _resolve_named(conn, name, "notebook", "name", "notebook")


def resolve_project(conn: sqlite3.Connection, name: str) -> Resolution:
    """One project by name."""
    return _resolve_named(conn, name, "project", "name", "project")


def resolve_tally_group(conn: sqlite3.Connection, name: str) -> Resolution:
    """One tally group by name."""
    return _resolve_named(conn, name, "tally_group", "name", "tally group")


def describe(conn: sqlite3.Connection, resolution: Resolution) -> list[str]:
    """Human labels for a resolution's candidates, for a clarify question."""
    labels: list[str] = []
    for pid in resolution.candidates or resolution.ids:
        row = conn.execute("SELECT full_name, company FROM person WHERE id = ?", (pid,)).fetchone()
        if row is None:
            labels.append(pid)
            continue
        labels.append(f"{row['full_name']} ({row['company']})" if row["company"] else row["full_name"])
    return labels


# --------------------------------------------- resolving a whole slot bundle

# What each slot name is, as a referent. The joint-model lane hands raw spans
# straight from the utterance, so it needs one door that knows which slots are
# phrases and which are literals, rather than re-deriving it per operation.
#
# A slot missing from this table is a literal: a topic, a title, a body, a
# company, a place, a service, an amount or an enum. Literals pass through
# untouched, because the whole point of a span tagger is that the user's words
# are already the value.
SLOT_KINDS: dict[str, str] = {
    "people": "people",
    "attendees": "people",
    "person": "people",
    "assignee": "people",
    "event": "event",
    "task": "task",
    "note": "note",
    "docs": "document",
    "photos": "photos",
    "item": "locker_item",
    "album": "album",
    "folder": "folder",
    "notebook": "notebook",
    "project": "project",
    "group": "tally_group",
    "window": "date_range",
    "due": "day",
    "day": "day",
    "when": "datetime",
}


@dataclass(frozen=True)
class SlotResolution:
    """One slot after resolution: a referent, a date, or a passed-through literal."""

    name: str
    kind: str
    raw: Any
    resolution: Resolution | None = None
    value: Any = None

    @property
    def ok(self) -> bool:
        """True when the slot is usable — a literal always is."""
        return self.resolution is None or self.resolution.ok


def resolve_all(
    op: str,
    slots: dict[str, Any],
    context: Context | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, SlotResolution]:
    """Resolve every slot of one operation's raw spans in one call.

    The filler hands over what the user said, verbatim; this turns each slot
    into the referent it names. ``op`` is carried so a slot the operation does
    not declare is reported rather than silently resolved — the catalogue, not
    this table, decides what an operation takes.

    The first slot that fails does not stop the rest: every slot is reported,
    so a caller can tell a clarify (one ambiguous name) from a refusal
    (nothing matched at all).
    """
    if conn is None:
        raise ValueError("resolve_all needs a connection to the world")
    declared = by_name().get(op)
    context = context if context is not None else Context()

    resolved: dict[str, SlotResolution] = {}
    for name, raw in slots.items():
        if declared is not None and name not in declared["params"]:
            resolved[name] = SlotResolution(
                name, "undeclared", raw, _missing(f"{op} declares no slot called {name!r}")
            )
            continue
        kind = SLOT_KINDS.get(name, "literal")
        phrase = "" if raw is None else str(raw)
        if kind == "literal":
            resolved[name] = SlotResolution(name, kind, raw, None, raw)
        elif kind == "date_range":
            window = resolve_date_range(phrase)
            resolved[name] = SlotResolution(
                name, kind, raw,
                None if window else _missing(f"{phrase!r} is not a date phrase"),
                window,
            )
        elif kind == "day":
            day = resolve_day(phrase)
            resolved[name] = SlotResolution(
                name, kind, raw,
                None if day else _missing(f"{phrase!r} is not a date phrase"),
                day,
            )
        elif kind == "datetime":
            stamp = resolve_datetime(phrase)
            resolved[name] = SlotResolution(
                name, kind, raw,
                None if stamp else _missing(f"{phrase!r} is not a date-and-time phrase"),
                stamp,
            )
        else:
            found = _REFERENT_RESOLVERS[kind](conn, phrase, context)
            resolved[name] = SlotResolution(name, kind, raw, found, found.ids)
    return resolved


_REFERENT_RESOLVERS: dict[str, Any] = {
    "people": lambda conn, phrase, ctx: resolve_people(conn, phrase, ctx),
    "event": lambda conn, phrase, ctx: resolve_event(conn, phrase, TODAY, ctx),
    "task": lambda conn, phrase, ctx: resolve_task(conn, phrase, ctx),
    "note": lambda conn, phrase, ctx: resolve_note(conn, phrase, ctx),
    "document": lambda conn, phrase, ctx: resolve_document(conn, phrase, ctx),
    "photos": lambda conn, phrase, ctx: resolve_photos(conn, phrase, ctx),
    "locker_item": lambda conn, phrase, ctx: resolve_locker_item(conn, phrase, ctx),
    "album": lambda conn, phrase, _ctx: resolve_album(conn, phrase),
    "folder": lambda conn, phrase, _ctx: resolve_folder(conn, phrase),
    "notebook": lambda conn, phrase, _ctx: resolve_notebook(conn, phrase),
    "project": lambda conn, phrase, _ctx: resolve_project(conn, phrase),
    "tally_group": lambda conn, phrase, _ctx: resolve_tally_group(conn, phrase),
}


__all__ = [
    "Context",
    "DateRange",
    "Resolution",
    "SLOT_KINDS",
    "SlotResolution",
    "describe",
    "resolve_album",
    "resolve_all",
    "resolve_company_people",
    "resolve_date_range",
    "resolve_datetime",
    "resolve_day",
    "resolve_document",
    "resolve_event",
    "resolve_folder",
    "resolve_locker_item",
    "resolve_note",
    "resolve_notebook",
    "resolve_people",
    "resolve_person",
    "resolve_photos",
    "resolve_project",
    "resolve_reference",
    "resolve_tally_group",
    "resolve_task",
]
