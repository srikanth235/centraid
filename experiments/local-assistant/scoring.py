"""Outcome scoring: what the world looks like after a turn, never what was said.

A turn passes on one of three grounds, and never on the text of a tool call:

- ``ids``             — the read returned the expected id set (as a set, or as
                        an ordered list when order is part of the answer).
- ``write_predicate`` — a named predicate here, evaluated against the world
                        after the turn, holds.
- ``no_action``       — the turn refused or asked to clarify, as expected.

A run is labelled. ``runs/<label>.json`` is written once and never
overwritten: a changed run is a new label, which is the brief's method rule.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from executor import Result
from reference import CATEGORIES

# --------------------------------------------------------------- predicates


def _one(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
    return conn.execute(sql, params).fetchone()


def _same_text(left: str, right: str) -> bool:
    """Are these the same text, ignoring case, punctuation and spacing?

    The deployed filler copies slot values verbatim out of the utterance, so a
    body slot arrives as the user typed it — "hire a bus", not "Hire a bus.".
    A predicate that demanded the trailing full stop would be scoring the
    model's punctuation rather than the outcome, so titles and bodies are
    compared on their words.
    """
    return _words(left) == _words(right)


def _contains_text(haystack: str, needle: str) -> bool:
    """Does the haystack contain the needle, compared on words?"""
    return _words(needle) in _words(haystack)


def _words(text: str) -> str:
    """Lowercase words, single-spaced, with punctuation dropped."""
    return " ".join(re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).split())


def task_status(conn: sqlite3.Connection, task_id: str, status: str) -> bool:
    """That task now carries that status."""
    row = _one(conn, "SELECT status FROM task WHERE id = ?", (task_id,))
    return row is not None and row["status"] == status


def task_due(conn: sqlite3.Connection, task_id: str, due: str) -> bool:
    """That task is now due on that day, and is still open."""
    row = _one(conn, "SELECT due, status FROM task WHERE id = ?", (task_id,))
    return row is not None and row["due"] == due and row["status"] == "open"


def task_assigned(conn: sqlite3.Connection, task_id: str, person_ids: list[str]) -> bool:
    """Those people are now on that task."""
    rows = conn.execute("SELECT person_id FROM task_assignee WHERE task_id = ?", (task_id,))
    return set(person_ids) <= {row["person_id"] for row in rows}


def task_exists(conn: sqlite3.Connection, title: str, due: str | None = None) -> bool:
    """An open task with that title exists, due on that day when one is named."""
    for row in conn.execute("SELECT title, due, status FROM task"):
        if not _same_text(row["title"], title) or row["status"] != "open":
            continue
        if due is None or row["due"] == due:
            return True
    return False


def event_exists(conn: sqlite3.Connection, title: str, starts: str) -> bool:
    """An event with that title starts at that stamp."""
    for row in conn.execute("SELECT title, starts, status FROM event"):
        if _same_text(row["title"], title) and row["starts"] == starts and row["status"] == "confirmed":
            return True
    return False


def event_starts(conn: sqlite3.Connection, event_id: str, starts: str) -> bool:
    """That event now starts at that stamp."""
    row = _one(conn, "SELECT starts FROM event WHERE id = ?", (event_id,))
    return row is not None and row["starts"] == starts


def event_status(conn: sqlite3.Connection, event_id: str, status: str) -> bool:
    """That event now carries that status."""
    row = _one(conn, "SELECT status FROM event WHERE id = ?", (event_id,))
    return row is not None and row["status"] == status


def event_has_attendees(conn: sqlite3.Connection, event_id: str, person_ids: list[str]) -> bool:
    """Those people are now invited to that event."""
    rows = conn.execute("SELECT person_id FROM attendee WHERE event_id = ?", (event_id,))
    return set(person_ids) <= {row["person_id"] for row in rows}


def event_has_attendees_by_title(
    conn: sqlite3.Connection, title: str, person_ids: list[str]
) -> bool:
    """The event created with that title carries those attendees."""
    for row in conn.execute("SELECT id, title FROM event"):
        if _same_text(row["title"], title):
            return event_has_attendees(conn, row["id"], person_ids)
    return False


def note_exists(conn: sqlite3.Connection, title: str, notebook_id: str | None = None) -> bool:
    """A note with that title exists, filed in that notebook when one is named."""
    for row in conn.execute("SELECT title, notebook_id FROM note"):
        if not _same_text(row["title"], title):
            continue
        if notebook_id is None or row["notebook_id"] == notebook_id:
            return True
    return False


def note_body_contains(conn: sqlite3.Connection, note_id: str, text: str) -> bool:
    """That note's body now contains that text, and kept what it had."""
    row = _one(conn, "SELECT body FROM note WHERE id = ?", (note_id,))
    return row is not None and _contains_text(row["body"], text)


def person_exists(conn: sqlite3.Connection, full_name: str, company: str | None = None) -> bool:
    """A person with that name exists, at that company when one is named."""
    for row in conn.execute("SELECT full_name, company FROM person"):
        if not _same_text(row["full_name"], full_name):
            continue
        if company is None or row["company"] == company:
            return True
    return False


def interaction_logged(
    conn: sqlite3.Connection, person_id: str, channel: str, happened: str
) -> bool:
    """A touchpoint on that person, on that channel, on that day."""
    row = _one(
        conn,
        "SELECT id FROM interaction WHERE person_id = ? AND channel = ? AND happened = ?",
        (person_id, channel, happened),
    )
    return row is not None


def person_note_exists(conn: sqlite3.Connection, person_id: str, body: str) -> bool:
    """A note on that person's record with that body."""
    row = _one(
        conn,
        "SELECT id FROM person_note WHERE person_id = ? AND lower(body) = ?",
        (person_id, body.lower()),
    )
    if row is not None:
        return True
    return any(
        _same_text(other["body"], body)
        for other in conn.execute("SELECT body FROM person_note WHERE person_id = ?", (person_id,))
    )


def photos_in_album(conn: sqlite3.Connection, album_id: str, photo_ids: list[str]) -> bool:
    """Those photos are now in that album."""
    rows = conn.execute("SELECT photo_id FROM photo_album WHERE album_id = ?", (album_id,))
    return set(photo_ids) <= {row["photo_id"] for row in rows}


def doc_starred(conn: sqlite3.Connection, doc_id: str) -> bool:
    """That document is now starred."""
    row = _one(conn, "SELECT starred FROM document WHERE id = ?", (doc_id,))
    return row is not None and row["starred"] == 1


def doc_in_folder(conn: sqlite3.Connection, doc_id: str, folder_id: str) -> bool:
    """That document now sits in that folder, and is not trashed."""
    row = _one(conn, "SELECT folder_id, trashed FROM document WHERE id = ?", (doc_id,))
    return row is not None and row["folder_id"] == folder_id and row["trashed"] == 0


def locker_item_exists(conn: sqlite3.Connection, service: str, kind: str) -> bool:
    """A locker item for that service, of that kind."""
    return any(
        _same_text(row["service"], service)
        for row in conn.execute(
            "SELECT service FROM locker_item WHERE kind = ? AND trashed = 0", (kind,)
        )
    )


def tally_settled(conn: sqlite3.Connection, person_ids: list[str]) -> bool:
    """None of those people has an unsettled entry left."""
    placeholders = ",".join("?" for _ in person_ids)
    row = _one(
        conn,
        "SELECT COUNT(*) AS n FROM tally_entry "  # noqa: S608 - placeholders only
        f"WHERE settled = 0 AND person_id IN ({placeholders})",
        tuple(person_ids),
    )
    return row is not None and row["n"] == 0


def tally_entry_exists(
    conn: sqlite3.Connection, description: str, person_ids: list[str], amount: float
) -> bool:
    """An entry of that amount against each of those people."""
    for person_id in person_ids:
        row = _one(
            conn,
            "SELECT amount FROM tally_entry WHERE lower(description) = ? AND person_id = ?",
            (description.lower(), person_id),
        )
        if row is None or abs(row["amount"] - amount) > 0.001:
            return False
    return True


PREDICATES: dict[str, Callable[..., bool]] = {
    "task_status": task_status,
    "task_due": task_due,
    "task_assigned": task_assigned,
    "task_exists": task_exists,
    "event_exists": event_exists,
    "event_starts": event_starts,
    "event_status": event_status,
    "event_has_attendees": event_has_attendees,
    "event_has_attendees_by_title": event_has_attendees_by_title,
    "note_exists": note_exists,
    "note_body_contains": note_body_contains,
    "person_exists": person_exists,
    "interaction_logged": interaction_logged,
    "person_note_exists": person_note_exists,
    "photos_in_album": photos_in_album,
    "doc_starred": doc_starred,
    "doc_in_folder": doc_in_folder,
    "locker_item_exists": locker_item_exists,
    "tally_settled": tally_settled,
    "tally_entry_exists": tally_entry_exists,
}


# ------------------------------------------------------------------ scoring


@dataclass
class TurnScore:
    """One turn's verdict."""

    index: int
    passed: bool
    detail: str = ""


@dataclass
class CaseScore:
    """One case's verdict — every turn must pass."""

    case_id: str
    category: str
    turns: list[TurnScore] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        """True when every turn passed."""
        return bool(self.turns) and all(turn.passed for turn in self.turns)

    @property
    def first_failure(self) -> str:
        """The first failing turn's detail, for a report line."""
        for turn in self.turns:
            if not turn.passed:
                return f"turn {turn.index}: {turn.detail}"
        return ""


def score_turn(
    index: int,
    expected: dict[str, Any],
    result: Result,
    conn: sqlite3.Connection,
) -> TurnScore:
    """Judge one turn against its expected outcome."""
    kind = expected["type"]

    if kind == "no_action":
        if result.kind != "no_action":
            return TurnScore(index, False, f"expected no action, got {result.kind} {result.ids}")
        if result.reason != expected["reason"]:
            return TurnScore(index, False, f"expected {expected['reason']}, got {result.reason}")
        return TurnScore(index, True)

    if result.kind == "no_action":
        return TurnScore(index, False, f"unexpected {result.reason}: {result.detail}")

    if kind == "ids":
        want = list(expected["ids"])
        got = list(result.ids)
        if expected.get("ordered"):
            if got != want:
                return TurnScore(index, False, f"expected ordered {want}, got {got}")
        elif set(got) != set(want):
            return TurnScore(index, False, f"expected {sorted(want)}, got {sorted(got)}")
        return TurnScore(index, True)

    if kind == "write_predicate":
        predicate = PREDICATES.get(expected["predicate"])
        if predicate is None:
            return TurnScore(index, False, f"no such predicate: {expected['predicate']}")
        if not predicate(conn, **expected["args"]):
            return TurnScore(index, False, f"predicate {expected['predicate']} does not hold")
        return TurnScore(index, True)

    return TurnScore(index, False, f"unknown outcome type: {kind}")


def summarise(scores: list[CaseScore]) -> dict[str, Any]:
    """Per-category accuracy plus the overall count."""
    per_category: dict[str, dict[str, int | float]] = {}
    for category in CATEGORIES:
        cases = [s for s in scores if s.category == category]
        if not cases:
            continue
        passed = sum(1 for s in cases if s.passed)
        per_category[category] = {
            "cases": len(cases),
            "passed": passed,
            "accuracy": round(passed / len(cases), 4),
        }
    passed = sum(1 for s in scores if s.passed)
    return {
        "cases": len(scores),
        "passed": passed,
        "failed": len(scores) - passed,
        "accuracy": round(passed / len(scores), 4) if scores else 0.0,
        "per_category": per_category,
    }


def runs_dir() -> Path:
    """Where run reports land."""
    return Path(__file__).resolve().parent / "runs"


def write_report(label: str, variant: str, scores: list[CaseScore]) -> Path:
    """Write ``runs/<label>.json``, refusing to overwrite an existing label.

    Append-only runs are the brief's method rule: a changed run is a new
    label, never an overwrite of an old one.
    """
    if not label or "/" in label or label.startswith("."):
        raise ValueError(f"not a usable run label: {label!r}")
    directory = runs_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{label}.json"
    if path.exists():
        raise FileExistsError(
            f"run label {label!r} already exists at {path}; pick a new label rather than overwriting"
        )
    report = {
        "label": label,
        "variant": variant,
        "summary": summarise(scores),
        "cases": [
            {
                "case_id": score.case_id,
                "category": score.category,
                "passed": score.passed,
                "detail": score.first_failure,
            }
            for score in scores
        ],
    }
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def print_report(scores: list[CaseScore]) -> None:
    """The per-case and per-category lines, for a terminal."""
    for score in scores:
        mark = "pass" if score.passed else "FAIL"
        line = f"  {mark}  {score.case_id}  {score.category}"
        if not score.passed:
            line += f"  — {score.first_failure}"
        print(line)
    summary = summarise(scores)
    print()
    for category, row in summary["per_category"].items():
        print(f"  {category:<24} {row['passed']:>3}/{row['cases']:<3} {row['accuracy']:.0%}")
    print()
    print(f"  total {summary['passed']}/{summary['cases']} — {summary['failed']} failures")
