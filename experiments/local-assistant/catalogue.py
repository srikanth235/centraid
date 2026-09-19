"""The operation catalogue the assistant selects over.

One source of truth. ``catalogue.json`` is generated from ``OPERATIONS`` by
``python3 catalogue.py --write``; ``test_executor.py`` asserts the file on disk
holds the same document, so the JSON can never drift from the Python. Run
``bun run format`` after a rebuild — oxfmt owns JSON whitespace here, so the
comparison is of the parsed document rather than of bytes.

Design rules this file obeys, from the owner's brief:

- Descriptions are written to be *discriminative from siblings*, not merely
  accurate. ``tasks_due`` and ``tasks_about`` differ by what the user is
  slicing on, and the sentences say so.
- No one-required-string sink operations (brief, fact 5). Every operation that
  takes a bare noun phrase either has a declared sibling that contrasts it or
  carries a second discriminating slot.
- Cross-app requests are composed *in code*: an operation may take a phrase
  argument ("attendees of the design review") that resolvers expand. The model
  never plans a chain to get there.
- ``none``/``clarify`` is a protocol outcome, not an operation. It is
  deliberately absent from ``OPERATIONS`` and lives in ``NON_OPERATIONS``.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

APPS: tuple[str, ...] = (
    "agenda",
    "tasks",
    "people",
    "notes",
    "photos",
    "docs",
    "locker",
    "tally",
)

# The two outcomes the protocol reserves. They are not tools: a model asked to
# emit them as tools stops emitting real calls (brief, fact 4).
NON_OPERATIONS: dict[str, str] = {
    "none": "The request is outside the vault's reach, or asks for something no operation covers; refuse.",
    "clarify": "The request names a referent that resolves to more than one thing, or omits a required slot; ask one question.",
}


def _op(
    name: str,
    app: str,
    kind: str,
    description: str,
    params: dict[str, Any],
    siblings: list[str],
    example_utterances: list[str],
) -> dict[str, Any]:
    """One catalogue row, in the order the JSON is written."""
    return {
        "name": name,
        "app": app,
        "kind": kind,
        "description": description,
        "params": params,
        "siblings": siblings,
        "example_utterances": example_utterances,
    }


def _p(
    type_: str,
    *,
    required: bool = False,
    enum: list[str] | None = None,
    description: str = "",
) -> dict[str, Any]:
    """One parameter, JSON-schema-like."""
    slot: dict[str, Any] = {"type": type_, "required": required}
    if enum is not None:
        slot["enum"] = enum
    if description:
        slot["description"] = description
    return slot


_PHRASE = "A noun phrase resolved in code, never an id: a name, a group ('people at Initech'), or a reference into the last result ('those people')."

OPERATIONS: list[dict[str, Any]] = [
    # ---------------------------------------------------------------- agenda
    _op(
        "agenda_upcoming",
        "agenda",
        "read",
        "List events on the calendar inside a date window, ordered by start time, regardless of what they are about.",
        {
            "window": _p("string", required=True, description="A date phrase: 'tomorrow', 'next week', 'this month', '2026-10-02'."),
            "calendar": _p("string", enum=["personal", "work", "family"]),
        },
        ["agenda_search", "agenda_day_context"],
        [
            "what's on my calendar next week",
            "show me tomorrow's schedule",
            "anything on this month",
            "what do I have on Friday",
        ],
    ),
    _op(
        "agenda_search",
        "agenda",
        "read",
        "Find events whose title or notes mention a topic, across all dates rather than inside a window.",
        {
            "topic": _p("string", required=True, description="Words that appear in the event title or its notes."),
            "window": _p("string", description="Optional date phrase narrowing the topic search."),
        },
        ["agenda_upcoming", "agenda_day_context"],
        [
            "find the design review",
            "when is the offsite",
            "search my calendar for anything about onboarding",
        ],
    ),
    _op(
        "agenda_day_context",
        "agenda",
        "read",
        "Give the full picture for one specific day: its events, the tasks due on it, and who is expected.",
        {"day": _p("string", required=True, description="A single day phrase: 'today', 'last Friday', '2026-09-24'.")},
        ["agenda_upcoming", "agenda_search"],
        [
            "what does my Thursday look like",
            "brief me on today",
            "give me the rundown for tomorrow",
        ],
    ),
    _op(
        "people_at",
        "agenda",
        "read",
        "List the people attending one named event; the answer is a set of people, not the event itself.",
        {
            "event": _p("string", required=True, description="An event phrase: its title, or a title plus a date word."),
            "response": _p("string", enum=["accepted", "declined", "pending", "any"]),
        },
        ["agenda_search", "agenda_attendee_add"],
        [
            "who's coming to the design review",
            "who was at the offsite",
            "who accepted the sprint planning invite",
        ],
    ),
    _op(
        "agenda_create_event",
        "agenda",
        "write",
        "Put a new event on the calendar at a stated time, optionally inviting people.",
        {
            "title": _p("string", required=True),
            "when": _p("string", required=True, description="A date-and-time phrase."),
            "attendees": _p("string", description=_PHRASE),
            "calendar": _p("string", enum=["personal", "work", "family"]),
        },
        ["agenda_reschedule", "agenda_attendee_add"],
        [
            "schedule a 1:1 with Neha tomorrow at 3",
            "put a dentist appointment on Friday morning",
            "book a retro next Tuesday with the Initech folks",
        ],
    ),
    _op(
        "agenda_reschedule",
        "agenda",
        "write",
        "Move an event that already exists to a different time, leaving its title and guest list alone.",
        {
            "event": _p("string", required=True, description="An event phrase, or a reference into the last result."),
            "when": _p("string", required=True, description="The new date-and-time phrase."),
        },
        ["agenda_create_event", "agenda_cancel_event"],
        [
            "move the design review to Thursday",
            "push the 1:1 back an hour",
            "reschedule that to next week",
        ],
    ),
    _op(
        "agenda_cancel_event",
        "agenda",
        "write",
        "Take an event off the calendar entirely, rather than changing when it happens.",
        {"event": _p("string", required=True, description="An event phrase, or a reference into the last result.")},
        ["agenda_reschedule"],
        ["cancel the offsite", "drop tomorrow's standup", "call off that meeting"],
    ),
    _op(
        "agenda_attendee_add",
        "agenda",
        "write",
        "Invite more people to an event that is already scheduled, without changing its time.",
        {
            "event": _p("string", required=True, description="An event phrase, or a reference into the last result."),
            "people": _p("string", required=True, description=_PHRASE),
        },
        ["agenda_create_event", "people_at"],
        [
            "add Neha to the design review",
            "invite everyone at Initech to the offsite",
            "also invite those people to the retro",
        ],
    ),
    # ----------------------------------------------------------------- tasks
    _op(
        "tasks_due",
        "tasks",
        "read",
        "List open tasks sliced by when they are due, without regard to what they are about.",
        {
            "window": _p("string", required=True, description="A date phrase bounding the due date."),
            "status": _p("string", enum=["open", "done", "any"]),
        },
        ["tasks_about", "tasks_for_people", "tasks_by_project"],
        [
            "what's due this week",
            "anything overdue",
            "tasks due tomorrow",
            "what do I have to finish today",
        ],
    ),
    _op(
        "tasks_about",
        "tasks",
        "read",
        "Find tasks whose title mentions a topic, whenever they happen to be due.",
        {
            "topic": _p("string", required=True, description="Words appearing in the task title."),
            "status": _p("string", enum=["open", "done", "any"]),
        },
        ["tasks_due", "tasks_by_project", "notes_search"],
        [
            "find my tasks about the migration",
            "anything on my list mentioning invoices",
            "do I have a task about the visa",
        ],
    ),
    _op(
        "tasks_by_project",
        "tasks",
        "read",
        "List the tasks filed under one named project or section, which is where they live rather than what they say.",
        {
            "project": _p("string", required=True, description="A project name, e.g. 'Website refresh'."),
            "status": _p("string", enum=["open", "done", "any"]),
        },
        ["tasks_about", "tasks_due"],
        ["what's left in Website refresh", "show me the Home project", "tasks in Q4 planning"],
    ),
    _op(
        "tasks_for_people",
        "tasks",
        "read",
        "List tasks assigned to a person or a group of people, resolving the group phrase in code.",
        {
            "people": _p("string", required=True, description=_PHRASE),
            "status": _p("string", enum=["open", "done", "any"]),
        },
        ["tasks_due", "tasks_about"],
        [
            "what is Neha on the hook for",
            "tasks assigned to the people at Initech",
            "what do the design review attendees owe me",
        ],
    ),
    _op(
        "tasks_add",
        "tasks",
        "write",
        "Create a new task with a title, optionally with a due date, project, or assignee.",
        {
            "title": _p("string", required=True),
            "due": _p("string", description="A date phrase."),
            "project": _p("string"),
            "assignee": _p("string", description=_PHRASE),
        },
        ["tasks_complete", "tasks_set_due", "notes_create"],
        [
            "remind me to renew the domain on Friday",
            "add a task to file the Initech invoice",
            "new task: book flights, due next week",
        ],
    ),
    _op(
        "tasks_complete",
        "tasks",
        "write",
        "Mark an existing task done; it changes a task's status rather than its schedule.",
        {"task": _p("string", required=True, description="A task phrase, or a reference into the last result.")},
        ["tasks_set_due"],
        ["mark the invoice task done", "I finished that one", "tick off the first two"],
    ),
    _op(
        "tasks_set_due",
        "tasks",
        "write",
        "Change when a task is due, leaving its title and status alone.",
        {
            "task": _p("string", required=True, description="A task phrase, or a reference into the last result."),
            "due": _p("string", required=True, description="The new date phrase."),
        },
        ["tasks_complete", "tasks_assign", "tasks_add"],
        ["push the domain renewal to next month", "make that due tomorrow instead"],
    ),
    _op(
        "tasks_assign",
        "tasks",
        "write",
        "Hand a task to a person, leaving its due date alone.",
        {
            "task": _p("string", required=True, description="A task phrase, or a reference into the last result."),
            "people": _p("string", required=True, description=_PHRASE),
        },
        ["tasks_set_due", "tasks_add"],
        ["give that to Neha", "assign the invoice task to Marcus"],
    ),
    # ---------------------------------------------------------------- people
    _op(
        "people_find",
        "people",
        "read",
        "Look up the people whose name matches, returning the matching person records themselves.",
        {
            "name": _p("string", required=True, description="A first name, full name, or nickname."),
            "company": _p("string", description="Narrows the match when a first name is shared."),
        },
        ["people_at_company", "people_profile"],
        ["who is Neha", "find Marcus", "look up Priya Raman"],
    ),
    _op(
        "people_profile",
        "people",
        "read",
        "Show one person's stored detail — channels, company, important dates — for a person already pinned down.",
        {
            "person": _p("string", required=True, description=_PHRASE),
            "section": _p("string", enum=["channels", "dates", "relationships", "all"]),
        },
        ["people_find"],
        ["what's Neha's email", "show me Marcus's card", "her phone number"],
    ),
    _op(
        "people_at_company",
        "people",
        "read",
        "List every person recorded as working at one company; the answer is a group, not one person.",
        {"company": _p("string", required=True)},
        ["people_find", "people_profile"],
        ["who do I know at Initech", "everyone at Hooli", "my Acme contacts"],
    ),
    _op(
        "people_add",
        "people",
        "write",
        "Create a new person record from a name, optionally with a company or a channel.",
        {
            "name": _p("string", required=True),
            "company": _p("string"),
            "email": _p("string"),
        },
        ["people_log_interaction"],
        ["add Dev Sharma to my contacts", "new contact: Rhea at Initech"],
    ),
    _op(
        "people_log_interaction",
        "people",
        "write",
        "Record that you were in touch with someone on a date, as a dated touchpoint rather than a note.",
        {
            "person": _p("string", required=True, description=_PHRASE),
            "when": _p("string", description="A date phrase; defaults to today."),
            "channel": _p("string", enum=["call", "email", "message", "met"]),
        },
        ["people_add_note"],
        ["log that I called Neha", "note that I met Marcus last Friday"],
    ),
    _op(
        "people_add_note",
        "people",
        "write",
        "Attach a free-text note to a person's record, as remembered detail rather than a dated touchpoint.",
        {
            "person": _p("string", required=True, description=_PHRASE),
            "body": _p("string", required=True),
        },
        ["people_log_interaction", "notes_create"],
        ["note on Neha: allergic to shellfish", "add to Marcus's card that he prefers mornings"],
    ),
    # ----------------------------------------------------------------- notes
    _op(
        "notes_search",
        "notes",
        "read",
        "Find notes whose title or body mentions a topic, wherever they are filed.",
        {
            "topic": _p("string", required=True),
            "notebook": _p("string", description="Optional notebook to narrow the search."),
        },
        ["notes_in_notebook", "notes_about_people", "docs_search"],
        ["find my notes on the migration", "any note mentioning Initech"],
    ),
    _op(
        "notes_in_notebook",
        "notes",
        "read",
        "List the notes filed in one named notebook, which is where they live rather than what they say.",
        {
            "notebook": _p("string", required=True),
            "window": _p("string", description="Optional date phrase over when they were written."),
        },
        ["notes_search", "notes_about_people"],
        ["what's in my Work notebook", "show the Journal notebook"],
    ),
    _op(
        "notes_about_people",
        "notes",
        "read",
        "List notes linked to a person or a group of people, resolving the group phrase in code.",
        {"people": _p("string", required=True, description=_PHRASE)},
        ["notes_search", "people_profile"],
        ["notes about Neha", "anything I wrote about the design review attendees"],
    ),
    _op(
        "notes_create",
        "notes",
        "write",
        "Write a new note with a body, optionally filed in a notebook or linked to people.",
        {
            "title": _p("string", required=True),
            "body": _p("string"),
            "notebook": _p("string"),
            "people": _p("string", description=_PHRASE),
        },
        ["notes_append", "tasks_add", "people_add_note"],
        ["start a note called Offsite ideas", "new note in Work: rework the onboarding"],
    ),
    _op(
        "notes_append",
        "notes",
        "write",
        "Add a line to a note that already exists, leaving what is there in place.",
        {
            "note": _p("string", required=True, description="A note phrase, or a reference into the last result."),
            "body": _p("string", required=True),
        },
        ["notes_create"],
        ["add to the offsite note: book the venue", "append that to my migration note"],
    ),
    # ---------------------------------------------------------------- photos
    _op(
        "photos_of_people",
        "photos",
        "read",
        "Find photos in which named people appear, resolving the person or group phrase in code.",
        {
            "people": _p("string", required=True, description=_PHRASE),
            "window": _p("string", description="Optional date phrase over when they were taken."),
        },
        ["photos_in_album", "photos_by_date", "photos_at_place"],
        ["photos of Neha", "pictures with the offsite attendees", "shots of Marcus this month"],
    ),
    _op(
        "photos_by_date",
        "photos",
        "read",
        "List photos taken inside a date window, regardless of who or what is in them.",
        {"window": _p("string", required=True, description="A date phrase.")},
        ["photos_of_people", "photos_in_album", "photos_at_place"],
        ["photos from last week", "what did I shoot in August"],
    ),
    _op(
        "photos_in_album",
        "photos",
        "read",
        "List the photos placed in one named album, which is where they were filed rather than when they were taken.",
        {"album": _p("string", required=True)},
        ["photos_by_date", "photos_of_people"],
        ["show me the Goa album", "what's in Offsite 2026"],
    ),
    _op(
        "photos_at_place",
        "photos",
        "read",
        "List photos taken at a named place, which is where they were shot rather than where they were filed.",
        {
            "place": _p("string", required=True),
            "window": _p("string", description="Optional date phrase."),
        },
        ["photos_by_date", "photos_in_album"],
        ["photos from Goa", "anything I shot at the Bangalore office"],
    ),
    _op(
        "photos_add_to_album",
        "photos",
        "write",
        "Put existing photos into an album, usually the ones just returned.",
        {
            "photos": _p("string", required=True, description="A photo phrase, or a reference into the last result."),
            "album": _p("string", required=True),
        },
        [],
        ["put those in the Offsite album", "add the first three to Goa"],
    ),
    # ------------------------------------------------------------------ docs
    _op(
        "docs_search",
        "docs",
        "read",
        "Find documents whose filename or extracted text mentions a topic, wherever they sit in the drive.",
        {
            "topic": _p("string", required=True),
            "kind": _p("string", enum=["pdf", "sheet", "doc", "image", "any"]),
        },
        ["docs_in_folder", "notes_search"],
        ["find the Initech contract", "any pdf about the lease"],
    ),
    _op(
        "docs_in_folder",
        "docs",
        "read",
        "List the documents sitting in one named folder, which is where they are filed rather than what they say.",
        {"folder": _p("string", required=True)},
        ["docs_search"],
        ["what's in the Contracts folder", "list my Receipts folder"],
    ),
    _op(
        "docs_star",
        "docs",
        "write",
        "Mark documents as starred, which flags them rather than moving them.",
        {"docs": _p("string", required=True, description="A document phrase, or a reference into the last result.")},
        ["docs_move"],
        ["star that contract", "flag the first one"],
    ),
    _op(
        "docs_move",
        "docs",
        "write",
        "Move documents into a different folder, changing where they are filed.",
        {
            "docs": _p("string", required=True, description="A document phrase, or a reference into the last result."),
            "folder": _p("string", required=True),
        },
        ["docs_star"],
        ["move that into Contracts", "file those under Receipts"],
    ),
    # ---------------------------------------------------------------- locker
    _op(
        "locker_find",
        "locker",
        "read",
        "Find a stored credential or secure item by the service it belongs to, returning the item without its secret.",
        {
            "service": _p("string", required=True, description="The site or service name."),
            "kind": _p("string", enum=["login", "card", "note", "identity", "any"]),
        },
        ["locker_weak"],
        ["do I have a login for Initech VPN", "find my bank card entry"],
    ),
    _op(
        "locker_weak",
        "locker",
        "read",
        "List locker items flagged by watchtower as reused, weak, or breached, which is a health judgement rather than a lookup.",
        {"reason": _p("string", enum=["reused", "weak", "breached", "any"])},
        ["locker_find"],
        ["anything reused in my vault", "show weak passwords"],
    ),
    _op(
        "locker_add",
        "locker",
        "write",
        "Store a new locker item for a service.",
        {
            "service": _p("string", required=True),
            "kind": _p("string", required=True, enum=["login", "card", "note", "identity"]),
            "username": _p("string"),
        },
        [],
        ["save a login for Hooli", "add a secure note for the safe code"],
    ),
    # ----------------------------------------------------------------- tally
    _op(
        "tally_balance_with",
        "tally",
        "read",
        "Show the net balance between you and named people or a group phrase, netting every shared expense.",
        {
            "people": _p("string", required=True, description=_PHRASE),
            "direction": _p("string", enum=["owed_to_me", "i_owe", "any"]),
        },
        ["tally_who_owes_me", "tally_expenses_with", "tally_group_balance"],
        [
            "do I owe Neha anything",
            "what's my balance with the design review attendees",
            "am I square with Marcus",
        ],
    ),
    _op(
        "tally_who_owes_me",
        "tally",
        "read",
        "List everyone with an outstanding balance in one direction, without naming anybody up front.",
        {"direction": _p("string", required=True, enum=["owed_to_me", "i_owe"])},
        ["tally_balance_with", "tally_group_balance"],
        ["who owes me money", "everyone I owe", "who hasn't paid me back"],
    ),
    _op(
        "tally_group_balance",
        "tally",
        "read",
        "Show the balances inside one named tally group, which slices by group rather than by person.",
        {"group": _p("string", required=True)},
        ["tally_balance_with", "tally_who_owes_me"],
        ["how are we doing in the Goa trip group", "balances for Flatmates"],
    ),
    _op(
        "tally_expenses_with",
        "tally",
        "read",
        "List the individual shared expenses involving named people, rather than the netted balance.",
        {
            "people": _p("string", required=True, description=_PHRASE),
            "window": _p("string", description="Optional date phrase."),
        },
        ["tally_balance_with", "tally_group_balance"],
        ["what have Neha and I split", "list the expenses with Marcus this month"],
    ),
    _op(
        "tally_add_expense",
        "tally",
        "write",
        "Record a new shared expense with an amount and who it is split between.",
        {
            "description": _p("string", required=True),
            "amount": _p("number", required=True),
            "people": _p("string", required=True, description=_PHRASE),
            "group": _p("string"),
        },
        ["tally_settle_up"],
        ["I paid 1200 for dinner, split with Neha", "add 4000 cab fare across the Goa trip group"],
    ),
    _op(
        "tally_settle_up",
        "tally",
        "write",
        "Record that a balance has been paid off, which zeroes it rather than adding a new expense.",
        {
            "people": _p("string", required=True, description=_PHRASE),
            "amount": _p("number", description="Optional; defaults to the whole outstanding balance."),
        },
        ["tally_add_expense"],
        ["Neha paid me back", "settle up with Marcus", "mark those as settled"],
    ),
]


def catalogue() -> dict[str, Any]:
    """The whole catalogue as a JSON-serialisable document."""
    return {
        "version": 1,
        "apps": list(APPS),
        "non_operations": NON_OPERATIONS,
        "operations": OPERATIONS,
    }


def by_name() -> dict[str, dict[str, Any]]:
    """Operations keyed by name."""
    return {op["name"]: op for op in OPERATIONS}


def operations_for(app: str) -> list[dict[str, Any]]:
    """Every operation belonging to one app."""
    return [op for op in OPERATIONS if op["app"] == app]


def json_path() -> Path:
    """Where the generated catalogue is written."""
    return Path(__file__).resolve().parent / "catalogue.json"


def render() -> str:
    """The exact bytes ``catalogue.json`` must hold."""
    return json.dumps(catalogue(), indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    """Write or check the generated JSON."""
    parser = argparse.ArgumentParser(description="Render the operation catalogue.")
    parser.add_argument("--write", action="store_true", help="Write catalogue.json.")
    args = parser.parse_args()
    text = render()
    if args.write:
        json_path().write_text(text, encoding="utf-8")
        print(f"wrote {json_path()} ({len(OPERATIONS)} operations)")
        return 0
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
