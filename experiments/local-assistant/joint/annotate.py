"""Turn the selector lane's templates into *span-annotated* templates.

The joint model tags slots as character spans of the request, so the generator
must know, for every template, which part of the rendered text is which slot.
Spans are recorded while the template is instantiated — never re-found by
string search afterwards, which would be unreliable once the mechanical
register noise (openers, dropped apostrophes, typos) has edited the text.

Annotation grammar, applied to a selector template:

- ``[slot:...]``     the enclosed text (literals and ``{placeholder}`` alike)
  is the span of ``slot``.
- ``<slot=value>``   ``slot`` takes that enum value and contributes no text.
- a bare ``{placeholder}`` is filled but carries no slot.

Most templates are annotated automatically: ``SLOT_MAP`` says which catalogue
slot each placeholder fills for each operation, and every ``{placeholder}``
is wrapped in a ``[slot:{placeholder}]`` marker. ``OVERRIDES`` carries the
templates where the span is wider than the placeholder ("the {company}
people"), where the slot value is a literal deictic ("those"), or where an
enum is implied by the wording rather than filled ("who do I owe" is
``direction=i_owe``).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "selector"))

from templates import CONTINUATION_TEMPLATES, DEPENDENT_TEMPLATES, TEMPLATES  # noqa: E402,F401

CATALOGUE = json.loads((ROOT / "catalogue.json").read_text())
PARAMS: dict[str, dict[str, dict]] = {o["name"]: o["params"] for o in CATALOGUE["operations"]}
OPERATIONS: list[str] = [o["name"] for o in CATALOGUE["operations"]]
LABELS: list[str] = OPERATIONS + ["none", "clarify"]

# Enum slots, by slot name, unioned over the operations that declare them.
ENUM_VALUES: dict[str, list[str]] = {}
for _op, _params in PARAMS.items():
    for _name, _spec in _params.items():
        if "enum" in _spec:
            merged = ENUM_VALUES.setdefault(_name, [])
            for value in _spec["enum"]:
                if value not in merged:
                    merged.append(value)
ENUM_SLOTS = set(ENUM_VALUES)

# Span slots: every slot that is not an enum anywhere.
SPAN_SLOTS = sorted({name for params in PARAMS.values() for name in params} - ENUM_SLOTS)

NUMBER_SLOTS = {
    name
    for params in PARAMS.values()
    for name, spec in params.items()
    if spec.get("type") == "number"
}

# Surface forms of enum values as they appear in generated text.
ENUM_SURFACE = {
    "called": "call",
    "emailed": "email",
    "messaged": "message",
    "met": "met",
}

# placeholder -> catalogue slot, per operation.
SLOT_MAP: dict[str, dict[str, str]] = {
    "agenda_upcoming": {"window": "window", "calendar": "calendar"},
    "agenda_search": {"event": "topic"},
    "agenda_day_context": {"window": "day"},
    "people_at": {"event": "event"},
    "agenda_create_event": {"event": "title", "time": "when", "date": "when", "person": "attendees"},
    "agenda_reschedule": {"event": "event", "date": "when", "time": "when"},
    "agenda_cancel_event": {"event": "event"},
    "agenda_attendee_add": {"person": "people", "event": "event"},
    "tasks_due": {"due": "window"},
    "tasks_about": {"topic": "topic"},
    "tasks_by_project": {"project": "project"},
    "tasks_for_people": {"person": "people", "company": "people"},
    "tasks_add": {"task": "title", "date": "due", "project": "project"},
    "tasks_complete": {"task": "task"},
    "tasks_set_due": {"task": "task", "date": "due"},
    "tasks_assign": {"task": "task", "person": "people"},
    "people_find": {"person": "name"},
    "people_profile": {"person": "person"},
    "people_at_company": {"company": "company"},
    "people_add": {"person": "name", "company": "company"},
    "people_log_interaction": {"person": "person", "channel": "channel", "date": "when"},
    "people_add_note": {"person": "person"},
    "notes_search": {"topic": "topic"},
    "notes_in_notebook": {"notebook": "notebook"},
    "notes_about_people": {"person": "people"},
    "notes_create": {"topic": "title", "notebook": "notebook"},
    "notes_append": {"note": "note"},
    "photos_of_people": {"person": "people"},
    "photos_by_date": {"window": "window"},
    "photos_in_album": {"album": "album"},
    "photos_at_place": {"place": "place"},
    "photos_add_to_album": {"album": "album"},
    "docs_search": {"doc": "topic", "topic": "topic"},
    "docs_in_folder": {"folder": "folder"},
    "docs_star": {"doc": "docs"},
    "docs_move": {"doc": "docs", "folder": "folder"},
    "locker_find": {"service": "service"},
    "locker_weak": {},
    "locker_add": {"service": "service"},
    "tally_balance_with": {"person": "people"},
    "tally_who_owes_me": {},
    "tally_group_balance": {"group": "group"},
    "tally_expenses_with": {"person": "people"},
    "tally_add_expense": {"expense": "description", "amount": "amount", "person": "people", "group": "group"},
    "tally_settle_up": {"person": "people", "amount": "amount"},
    "none": {},
    "clarify": {},
}

# Templates whose annotation is not "wrap each placeholder".
OVERRIDES: dict[str, str] = {
    # tasks_for_people: a company group is a people *phrase*, not a company name.
    "what are the {company} people on the hook for": "what are [people:the {company} people] on the hook for",
    "!show me the tasks for the people at {company}": "!show me the tasks for [people:the people at {company}]",
    # notes / photos / tally company groups
    "!find my notes about the {company} people": "!find my notes about [people:the {company} people]",
    "!any shots of the {company} people": "!any shots of [people:the {company} people]",
    "!how much do the {company} people owe me": "!how much do [people:the {company} people] owe me <direction=owed_to_me>",
    # people_add_note / notes_create / notes_append: free-text bodies.
    "add a note to {person}: they prefer mornings": "add a note to [person:{person}]: [body:they prefer mornings]",
    "note on {person}: allergic to shellfish": "note on [person:{person}]: [body:allergic to shellfish]",
    "remember that {person} is moving to {place}": "remember that [person:{person}] is [body:moving to {place}]",
    "!save a note against {person}'s record": "!save a note against [person:{person}]'s record",
    "attach to {person}: kids are called Ana and Luis": "attach to [person:{person}]: [body:kids are called Ana and Luis]",
    "write on {person}'s record that they hate calls": "write on [person:{person}]'s record that [body:they hate calls]",
    "write a note: the boiler is under warranty until March": "write a note: [title:the boiler is under warranty until March]",
    "new note about {topic}": "new note about [title:{topic}]",
    "jot down that {person} recommended a plumber": "jot down that [title:{person} recommended a plumber]",
    "!create a note in {notebook} about {topic}": "!create a note in [notebook:{notebook}] about [title:{topic}]",
    "note to self: check the {topic} before renewing": "note to self: [title:check the {topic} before renewing]",
    "save a note in {notebook}: buy cable ties": "save a note in [notebook:{notebook}]: [title:buy cable ties]",
    "add to the {note} note: they quoted 400": "add to the [note:{note}] note: [body:they quoted 400]",
    "append to {note}: follow up in a week": "append to [note:{note}]: [body:follow up in a week]",
    "!stick another line on the {note} note": "!stick another line on the [note:{note}] note",
    "add a line to {note} saying it's paid": "add a line to [note:{note}] saying [body:it's paid]",
    "update the {note} note with the new number": "update the [note:{note}] note with [body:the new number]",
    # photos_add_to_album: the photos slot is usually a deictic.
    "put those in the {album} album": "put [photos:those] in the [album:{album}] album",
    "add these to {album}": "add [photos:these] to [album:{album}]",
    "file the {place} photos into {album}": "file [photos:the {place} photos] into [album:{album}]",
    "!move those pictures into {album}": "!move [photos:those pictures] into [album:{album}]",
    "stick them in {album}": "stick [photos:them] in [album:{album}]",
    # docs_star over a folder listing
    "star the ones in {folder}": "star [docs:the ones in {folder}]",
    # locker_weak: the wording is the enum.
    "which passwords are weak": "which passwords are weak <reason=weak>",
    "any reused logins": "any reused logins <reason=reused>",
    "!show me the flagged locker items": "!show me the flagged locker items <reason=any>",
    "what's been breached": "what's been breached <reason=breached>",
    "password health check": "password health check <reason=any>",
    # locker_add: kind is required and always a login in these frames.
    "save my {service} login": "save my [service:{service}] login <kind=login>",
    "store a new password for {service}": "store a new password for [service:{service}] <kind=login>",
    "!add {service} to my locker": "!add [service:{service}] to my locker <kind=login>",
    "put the {service} credentials in the locker": "put the [service:{service}] credentials in the locker <kind=login>",
    # tally_who_owes_me: direction is required and comes from the wording.
    "who owes me money": "who owes me money <direction=owed_to_me>",
    "who do I owe": "who do I owe <direction=i_owe>",
    "!anyone got an outstanding balance with me": "!anyone got an outstanding balance with me <direction=owed_to_me>",
    "am I owed anything by anyone": "am I owed anything by anyone <direction=owed_to_me>",
    "list everyone I still owe": "list everyone I still owe <direction=i_owe>",
    # tally_balance_with direction cues
    "do I owe {person} anything": "do I owe [people:{person}] anything <direction=i_owe>",
    # tasks_due status cue
    "is anything overdue": "is anything [window:overdue]",
    "am I behind on anything": "am I behind on [window:overdue]",
    # agenda_day_context
    "what's my day like {window}": "what's my day like [day:{window}]",
    # people_log_interaction: a bare "record a call with X"
    "record a call with {person}": "record a [channel:call] with [person:{person}]",
    "!log a touchpoint with {person}": "!log a touchpoint with [person:{person}] <channel=met>",
    "mark that {person} and I spoke {date}": "mark that [person:{person}] and I spoke [when:{date}] <channel=call>",
    # docs_search with a document name
    "find the {doc}": "find [topic:{doc}]",
    "where is {doc}": "where is [topic:{doc}]",
    "do I have a file for {doc}": "do I have a file for [topic:{doc}]",
    "pull up {doc}": "pull up [topic:{doc}]",
    # agenda_create_event with an attendee
    "add {event} {time} with {person}": "add [title:{event}] [when:{time}] with [attendees:{person}]",
    "can you set up a {event} with {person} {date}": "can you set up a [title:{event}] with [attendees:{person}] [when:{date}]",
}

# Dependent follow-ups: deictic slots, annotated by hand.
DEPENDENT_ANNOTATION: dict[str, dict[str, str]] = {
    "only the ones with {person}": {"__span__": "{person}"},
    "just the ones with {person} in them": {"__span__": "{person}"},
    "which of those are {person}'s": {"__span__": "{person}"},
    "mark the first one done": {"task": "the first one"},
    "tick off the last one": {"task": "the last one"},
    "push the last one to {date}": {"task": "the last one", "due": "{date}"},
    "give the second one to {person}": {"task": "the second one", "people": "{person}"},
    "assign that first one to {person}": {"task": "that first one", "people": "{person}"},
    "star the second one": {"docs": "the second one"},
    "move the first one into {folder}": {"docs": "the first one", "folder": "{folder}"},
    "put the first two in the {album} album": {"photos": "the first two", "album": "{album}"},
    "file those under {album}": {"photos": "those", "album": "{album}"},
    "log that I {channel} the last one": {"channel": "{channel}", "person": "the last one"},
    "show me the last one's details": {"person": "the last one"},
    "and what do they owe me": {"people": "they", "direction": "owed_to_me"},
    "what's assigned to them": {"people": "them"},
    "any photos of them": {"people": "them"},
    "book an intro call with them {date}": {"title": "intro call", "attendees": "them", "when": "{date}"},
    "now show me the tasks about it": {"topic": "it"},
    "who's going to it": {"event": "it"},
    "add a task to prep for it, due {date}": {"title": "prep for it", "due": "{date}"},
    "cancel it": {"event": "it"},
    "move it to {date}": {"event": "it", "when": "{date}"},
    "add {person} to it": {"people": "{person}", "event": "it"},
}

# Extra templates, already annotated, added by this lane (prefix ``@``).
#
# Cross-app-as-one-call lives or dies on *group phrases*: the whole phrase
# ("everyone at <company>", "the <event> attendees") is the slot value, because
# the resolvers expand it. Run e2e-j03 tagged only the proper noun inside such
# a phrase and the resolver then had nothing to expand, which cost the whole
# ``cross_app_one_call`` category. The selector lane needed no such templates —
# it only ever had to name an operation.
EXTRA_TEMPLATES: dict[str, list[str]] = {
    "tasks_for_people": [
        "@what's assigned to [people:everyone at {company}]",
        "@what are [people:the {event} attendees] meant to be doing",
        "@which tasks belong to [people:the people at {company}]",
    ],
    "tally_balance_with": [
        "@what's my balance with [people:everyone at {company}]",
        "@do I owe any of [people:the {event} attendees] anything <direction=i_owe>",
        "@where do I stand with [people:the people who came to the {event}]",
    ],
    "tally_settle_up": [
        "@settle up with [people:everyone I owe]",
        "@clear the balance with [people:everyone at {company}]",
    ],
    "tally_who_owes_me": [
        "@and who do I owe <direction=i_owe>",
        "@who is it I owe again <direction=i_owe>",
        "@and who owes me <direction=owed_to_me>",
    ],
    "photos_of_people": [
        "@photos of [people:the people who went to the {event}]",
        "@pictures of [people:everyone at {company}]",
        "@shots of [people:the {event} attendees]",
    ],
    "notes_about_people": [
        "@what have I written about [people:the {event} attendees]",
        "@notes about [people:everyone at {company}]",
    ],
    "agenda_attendee_add": [
        "@invite [people:everyone at {company}] to [event:the {event}]",
        "@add [people:the {event} attendees] to [event:the {event}]",
    ],
    "agenda_create_event": [
        "@book [title:a {event}] [when:on {date}] with [attendees:everyone at {company}]",
        "@set up [title:a {event}] [when:{time}] with [attendees:the people at {company}]",
    ],
    "people_at": [
        "@who actually accepted the [event:{event}] invite <response=accepted>",
        "@who turned down the [event:{event}] <response=declined>",
        "@who hasn't replied to the [event:{event}] yet <response=pending>",
    ],
    "photos_in_album": [
        "@show me the [album:{album}] album",
        "@pull up the [album:{album}] photo album",
    ],
    "docs_search": [
        "@find the [topic:{doc}] documents",
        "@anything about [topic:{topic}] in my drive",
    ],
    "tally_group_balance": [
        "@show me the balances in the [group:{group}] group",
        "@how is the [group:{group}] group split",
    ],
    "locker_add": [
        "@save a login for [service:{service}] under my usual username <kind=login>",
        "@add a card for [service:{service}] to the locker <kind=card>",
    ],
    "notes_create": [
        "@start a note called [title:{topic}] in [notebook:{notebook}]",
        "@make a new note [title:{topic}] under [notebook:{notebook}]",
    ],
    "notes_append": [
        "@add to the [note:{note}] note: [body:{topic} is sorted]",
        "@stick [body:a line about {topic}] on the [note:{note}] note",
    ],
    "docs_move": [
        "@file [docs:the {doc}] under [folder:{folder}]",
        "@move [docs:the {doc}] into the [folder:{folder}] folder",
    ],
}

ALL_TEMPLATES: dict[str, list[str]] = {
    label: list(templates) + list(EXTRA_TEMPLATES.get(label, []))
    for label, templates in TEMPLATES.items()
}

_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def slot_for(operation: str, placeholder: str) -> str | None:
    """Which catalogue slot this placeholder fills for this operation."""
    params = PARAMS.get(operation, {})
    mapped = SLOT_MAP.get(operation, {}).get(placeholder)
    if mapped and mapped in params:
        return mapped
    if placeholder in params:
        return placeholder
    return None


def primary_slot(operation: str) -> str | None:
    """The operation's first required slot — what a continuation changes."""
    for name, spec in PARAMS.get(operation, {}).items():
        if spec.get("required"):
            return name
    return None


def annotate(operation: str, template: str) -> str:
    """A selector template as an annotated template for this operation."""
    if template.startswith("@"):
        return template[1:]
    if template in OVERRIDES:
        return OVERRIDES[template]

    def wrap(match: re.Match[str]) -> str:
        placeholder = match.group(1)
        slot = slot_for(operation, placeholder)
        if slot is None:
            return match.group(0)
        return f"[{slot}:{{{placeholder}}}]"

    return _PLACEHOLDER.sub(wrap, template)


def annotate_continuation(operation: str, template: str) -> str:
    """A continuation ("and what about {window}") for the operation it repeats."""

    def wrap(match: re.Match[str]) -> str:
        placeholder = match.group(1)
        slot = slot_for(operation, placeholder) or primary_slot(operation)
        if slot is None:
            return match.group(0)
        return f"[{slot}:{{{placeholder}}}]"

    return _PLACEHOLDER.sub(wrap, template)


def annotate_dependent(operation: str, template: str) -> str:
    """A dependent follow-up, using the hand annotation for that template."""
    spec = DEPENDENT_ANNOTATION.get(template)
    if spec is None:
        return annotate_continuation(operation, template)
    if "__span__" in spec:
        slot = primary_slot(operation) or "people"
        return template.replace(spec["__span__"], f"[{slot}:{spec['__span__']}]")
    out = template
    enums: list[str] = []
    for slot, text in spec.items():
        if slot in ENUM_SLOTS and not text.startswith("{"):
            enums.append(f"<{slot}={text}>")
            continue
        if slot not in PARAMS.get(operation, {}):
            continue
        if text in out:
            out = out.replace(text, f"[{slot}:{text}]", 1)
        else:  # a literal the template does not contain (an implied title)
            out = f"{out} [{slot}:{text}]"
    return " ".join([out, *enums]) if enums else out
