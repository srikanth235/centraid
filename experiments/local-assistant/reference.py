"""The evaluation cases and the reference call sequence for each of them.

This file is the authoring source for the frozen suite. Every case here is
hand-written: the request text, the category, the reference ``(operation,
slots)`` a perfect model would emit for each turn, and the outcome the turn is
scored on.

``build_suite.py --write`` lowers this into ``suite.json``, which is what the
model lanes read. The reference calls are never shown to a model: they exist
so ``run_reference.py`` can prove every case is reachable before any model
runs, which is the method rule the brief calls "freeze the evaluation before
touching a model".

Outcome shapes, one per turn:

- ``("ids", entity)``              — score by the id set the read returned.
  The expected ids are frozen into ``suite.json`` at build time, so the file
  on disk, not a rebuild, is what a later run is scored against.
- ``("write", predicate, args)``   — score by a named predicate in
  ``scoring.py`` evaluated against the world after the turn.
- ``("no_action", reason)``        — score by the protocol outcome, where
  ``reason`` is ``refuse`` or ``clarify``. Never by the text of a message.

``ordered`` is set on an outcome whose order is part of the answer (an agenda
or a due-date list); everywhere else an id set is compared as a set.
"""

from __future__ import annotations

from typing import Any

# A turn: (request, [(operation, slots), ...], outcome, ordered)
Turn = tuple[str, list[tuple[str, dict[str, Any]]], tuple[Any, ...], bool]
Case = tuple[str, str, list[Turn]]


def _t(
    request: str,
    calls: list[tuple[str, dict[str, Any]]],
    outcome: tuple[Any, ...],
    ordered: bool = False,
) -> Turn:
    """One turn of a case."""
    return (request, calls, outcome, ordered)


CASES: list[Case] = [
    # ------------------------------------------------------- single_read (18)
    ("r01", "single_read", [_t(
        "what's on my calendar next week",
        [("agenda_upcoming", {"window": "next week"})],
        ("ids", "event"), True)]),
    ("r02", "single_read", [_t(
        "anything on the calendar tomorrow",
        [("agenda_upcoming", {"window": "tomorrow"})],
        ("ids", "event"), True)]),
    ("r03", "single_read", [_t(
        "find the design review on my calendar",
        [("agenda_search", {"topic": "design review"})],
        ("ids", "event"))]),
    ("r04", "single_read", [_t(
        "what does the twenty-fifth look like",
        [("agenda_day_context", {"day": "2026-09-25"})],
        ("ids", "day_context"))]),
    ("r05", "single_read", [_t(
        "what's due this week",
        [("tasks_due", {"window": "this week"})],
        ("ids", "task"), True)]),
    ("r06", "single_read", [_t(
        "is anything overdue",
        [("tasks_due", {"window": "overdue"})],
        ("ids", "task"), True)]),
    ("r07", "single_read", [_t(
        "do I have anything on my list about the visa",
        [("tasks_about", {"topic": "visa"})],
        ("ids", "task"))]),
    ("r08", "single_read", [_t(
        "what's left in the Website refresh project",
        [("tasks_by_project", {"project": "Website refresh"})],
        ("ids", "task"))]),
    ("r09", "single_read", [_t(
        "who do I know at Initech",
        [("people_at_company", {"company": "Initech"})],
        ("ids", "person"))]),
    ("r10", "single_read", [_t(
        "look up Priya Raman",
        [("people_find", {"name": "Priya Raman"})],
        ("ids", "person"))]),
    ("r11", "single_read", [_t(
        "find my notes about onboarding",
        [("notes_search", {"topic": "onboarding"})],
        ("ids", "note"))]),
    ("r12", "single_read", [_t(
        "what's in my Journal notebook",
        [("notes_in_notebook", {"notebook": "Journal"})],
        ("ids", "note"))]),
    ("r13", "single_read", [_t(
        "show me the Goa album",
        [("photos_in_album", {"album": "Goa"})],
        ("ids", "photo"))]),
    ("r14", "single_read", [_t(
        "what photos did I take last week",
        [("photos_by_date", {"window": "last week"})],
        ("ids", "photo"))]),
    ("r15", "single_read", [_t(
        "find anything about Initech in my drive",
        [("docs_search", {"topic": "Initech"})],
        ("ids", "document"))]),
    ("r16", "single_read", [_t(
        "what's in my Contracts folder",
        [("docs_in_folder", {"folder": "Contracts"})],
        ("ids", "document"))]),
    ("r17", "single_read", [_t(
        "is anything in my locker reused or weak",
        [("locker_weak", {"reason": "any"})],
        ("ids", "locker_item"))]),
    ("r18", "single_read", [_t(
        "who owes me money",
        [("tally_who_owes_me", {"direction": "owed_to_me"})],
        ("ids", "person"))]),

    # ------------------------------------------------------ single_write (14)
    ("w01", "single_write", [_t(
        "schedule a budget review tomorrow at 3 pm",
        [("agenda_create_event", {"title": "Budget review", "when": "tomorrow at 3 pm"})],
        ("write", "event_exists", {"title": "Budget review", "starts": "2026-09-20T15:00"}))]),
    ("w02", "single_write", [_t(
        "move the design review to Thursday",
        [("agenda_reschedule", {"event": "the design review", "when": "Thursday"})],
        ("write", "event_starts", {"event_id": "e01", "starts": "2026-09-24T09:00"}))]),
    ("w03", "single_write", [_t(
        "cancel the Initech offsite",
        [("agenda_cancel_event", {"event": "the Initech offsite"})],
        ("write", "event_status", {"event_id": "e04", "status": "cancelled"}))]),
    ("w04", "single_write", [_t(
        "add Priya to the retro",
        [("agenda_attendee_add", {"event": "the retro", "people": "Priya"})],
        ("write", "event_has_attendees", {"event_id": "e06", "person_ids": ["p05"]}))]),
    ("w05", "single_write", [_t(
        "remind me to call the landlord on Friday",
        [("tasks_add", {"title": "Call the landlord", "due": "Friday"})],
        ("write", "task_exists", {"title": "Call the landlord", "due": "2026-09-25"}))]),
    ("w06", "single_write", [_t(
        "mark the domain renewal done",
        [("tasks_complete", {"task": "the domain renewal"})],
        ("write", "task_status", {"task_id": "t01", "status": "done"}))]),
    ("w07", "single_write", [_t(
        "push the passport renewal to next month",
        [("tasks_set_due", {"task": "the passport renewal", "due": "next month"})],
        ("write", "task_due", {"task_id": "t06", "due": "2026-10-01"}))]),
    ("w08", "single_write", [_t(
        "give the offsite flights task to Priya",
        [("tasks_assign", {"task": "book offsite flights", "people": "Priya"})],
        ("write", "task_assigned", {"task_id": "t04", "person_ids": ["p05"]}))]),
    ("w09", "single_write", [_t(
        "add Rhea Kapoor at Initech to my contacts",
        [("people_add", {"name": "Rhea Kapoor", "company": "Initech"})],
        ("write", "person_exists", {"full_name": "Rhea Kapoor", "company": "Initech"}))]),
    ("w10", "single_write", [_t(
        "log that I called Priya today",
        [("people_log_interaction", {"person": "Priya", "when": "today", "channel": "call"})],
        ("write", "interaction_logged",
         {"person_id": "p05", "channel": "call", "happened": "2026-09-19"}))]),
    ("w11", "single_write", [_t(
        "start a note called Offsite debrief in Work",
        [("notes_create", {"title": "Offsite debrief", "notebook": "Work", "body": "Went well."})],
        ("write", "note_exists", {"title": "Offsite debrief", "notebook_id": "nb1"}))]),
    ("w12", "single_write", [_t(
        "add to the offsite ideas note: hire a bus",
        [("notes_append", {"note": "offsite ideas", "body": "Hire a bus."})],
        ("write", "note_body_contains", {"note_id": "n03", "text": "Hire a bus."}))]),
    ("w13", "single_write", [_t(
        "save a login for Hooli VPN under srikanth",
        [("locker_add", {"service": "Hooli VPN", "kind": "login", "username": "srikanth"})],
        ("write", "locker_item_exists", {"service": "Hooli VPN", "kind": "login"}))]),
    ("w14", "single_write", [_t(
        "file the migration runbook under Personal",
        [("docs_move", {"docs": "the migration runbook", "folder": "Personal"})],
        ("write", "doc_in_folder", {"doc_id": "d8", "folder_id": "f3"}))]),

    # ------------------------------------------------ cross_app_one_call (10)
    ("x01", "cross_app_one_call", [_t(
        "who was at the design review",
        [("people_at", {"event": "the design review"})],
        ("ids", "person"))]),
    ("x02", "cross_app_one_call", [_t(
        "who actually accepted the sprint planning invite",
        [("people_at", {"event": "sprint planning", "response": "accepted"})],
        ("ids", "person"))]),
    ("x03", "cross_app_one_call", [_t(
        "do I owe any of the design review attendees",
        [("tally_balance_with",
          {"people": "attendees of the design review", "direction": "i_owe"})],
        ("ids", "person"))]),
    ("x04", "cross_app_one_call", [_t(
        "what's my balance with everyone at Initech",
        [("tally_balance_with", {"people": "people at Initech"})],
        ("ids", "person"))]),
    ("x05", "cross_app_one_call", [_t(
        "what are the Initech people on the hook for",
        [("tasks_for_people", {"people": "people at Initech"})],
        ("ids", "task"))]),
    ("x06", "cross_app_one_call", [_t(
        "what have I written about the design review attendees",
        [("notes_about_people", {"people": "attendees of the design review"})],
        ("ids", "note"))]),
    ("x07", "cross_app_one_call", [_t(
        "photos of the people who went to the Initech offsite",
        [("photos_of_people", {"people": "attendees of the Initech offsite"})],
        ("ids", "photo"))]),
    ("x08", "cross_app_one_call", [_t(
        "settle up with everyone I owe",
        [("tally_settle_up", {"people": "everyone I owe"})],
        ("write", "tally_settled",
         {"person_ids": ["p03", "p06", "p07", "p09", "p11", "p14"]}))]),
    ("x09", "cross_app_one_call", [_t(
        "invite everyone at Initech to the retro",
        [("agenda_attendee_add", {"event": "the retro", "people": "everyone at Initech"})],
        ("write", "event_has_attendees",
         {"event_id": "e06", "person_ids": ["p01", "p03", "p05", "p08", "p13"]}))]),
    ("x10", "cross_app_one_call", [_t(
        "book a planning session on Thursday with everyone at Acme",
        [("agenda_create_event",
          {"title": "Planning session", "when": "Thursday", "attendees": "everyone at Acme"})],
        ("write", "event_exists",
         {"title": "Planning session", "starts": "2026-09-24T09:00"}))]),

    # ------------------------------------------------------------- chain (8)
    ("c01", "chain", [
        _t("who's coming to the design review",
           [("people_at", {"event": "the design review"})],
           ("ids", "person")),
        _t("and what do they owe me",
           [("tally_balance_with",
             {"people": "attendees of the design review", "direction": "owed_to_me"})],
           ("ids", "person")),
    ]),
    ("c02", "chain", [
        _t("find my notes about the migration",
           [("notes_search", {"topic": "migration"})],
           ("ids", "note")),
        _t("now show me the tasks about it",
           [("tasks_about", {"topic": "migration"})],
           ("ids", "task")),
    ]),
    ("c03", "chain", [
        _t("what's due this week",
           [("tasks_due", {"window": "this week"})],
           ("ids", "task"), True),
        _t("mark the electricity bill one done",
           [("tasks_complete", {"task": "the electricity bill"})],
           ("write", "task_status", {"task_id": "t08", "status": "done"})),
    ]),
    ("c04", "chain", [
        _t("who do I know at Acme",
           [("people_at_company", {"company": "Acme"})],
           ("ids", "person")),
        _t("book an intro call with them on Thursday",
           [("agenda_create_event",
             {"title": "Intro call", "when": "Thursday", "attendees": "those people"})],
           ("write", "event_has_attendees_by_title",
            {"title": "Intro call", "person_ids": ["p04", "p07", "p10"]})),
    ]),
    ("c05", "chain", [
        _t("show me the Goa album",
           [("photos_in_album", {"album": "Goa"})],
           ("ids", "photo")),
        _t("put those in Offsite 2026",
           [("photos_add_to_album", {"photos": "those", "album": "Offsite 2026"})],
           ("write", "photos_in_album",
            {"album_id": "a2", "photo_ids": ["ph05", "ph06", "ph07", "ph13", "ph14", "ph19"]})),
    ]),
    ("c06", "chain", [
        _t("what's in my Contracts folder",
           [("docs_in_folder", {"folder": "Contracts"})],
           ("ids", "document")),
        _t("star the Acme one",
           [("docs_star", {"docs": "the Acme pilot contract"})],
           ("write", "doc_starred", {"doc_id": "d2"})),
    ]),
    ("c07", "chain", [
        _t("when is the offsite",
           [("agenda_search", {"topic": "offsite"})],
           ("ids", "event")),
        _t("add a task to book flights for it, due Monday",
           [("tasks_add", {"title": "Book offsite flights again", "due": "Monday"})],
           ("write", "task_exists",
            {"title": "Book offsite flights again", "due": "2026-09-21"})),
    ]),
    ("c08", "chain", [
        _t("what do the Initech people owe me",
           [("tally_balance_with",
             {"people": "people at Initech", "direction": "owed_to_me"})],
           ("ids", "person")),
        _t("nudge them by logging that I messaged Priya",
           [("people_log_interaction", {"person": "Priya", "channel": "message"})],
           ("write", "interaction_logged",
            {"person_id": "p05", "channel": "message", "happened": "2026-09-19"})),
    ]),

    # --------------------------------------------------------- follow_up (8)
    ("f01", "follow_up", [
        _t("what's on my calendar next week",
           [("agenda_upcoming", {"window": "next week"})],
           ("ids", "event"), True),
        _t("and what about October",
           [("agenda_upcoming", {"window": "October"})],
           ("ids", "event"), True),
    ]),
    ("f02", "follow_up", [
        _t("what's due this week",
           [("tasks_due", {"window": "this week"})],
           ("ids", "task"), True),
        _t("what about next week",
           [("tasks_due", {"window": "next week"})],
           ("ids", "task"), True),
    ]),
    ("f03", "follow_up", [
        _t("who do I know at Initech",
           [("people_at_company", {"company": "Initech"})],
           ("ids", "person")),
        _t("and at Hooli",
           [("people_at_company", {"company": "Hooli"})],
           ("ids", "person")),
    ]),
    ("f04", "follow_up", [
        _t("photos of Lena",
           [("photos_of_people", {"people": "Lena"})],
           ("ids", "photo")),
        _t("just the ones from this month",
           [("photos_of_people", {"people": "Lena", "window": "this month"})],
           ("ids", "photo")),
    ]),
    ("f05", "follow_up", [
        _t("find my notes that mention a plan",
           [("notes_search", {"topic": "plan"})],
           ("ids", "note")),
        _t("only the ones in my Work notebook",
           [("notes_search", {"topic": "plan", "notebook": "Work"})],
           ("ids", "note")),
    ]),
    ("f06", "follow_up", [
        _t("who owes me money",
           [("tally_who_owes_me", {"direction": "owed_to_me"})],
           ("ids", "person")),
        _t("and who do I owe",
           [("tally_who_owes_me", {"direction": "i_owe"})],
           ("ids", "person")),
    ]),
    ("f07", "follow_up", [
        _t("find the Initech documents",
           [("docs_search", {"topic": "Initech"})],
           ("ids", "document")),
        _t("just the spreadsheets",
           [("docs_search", {"topic": "Initech", "kind": "sheet"})],
           ("ids", "document")),
    ]),
    ("f08", "follow_up", [
        _t("show me the balances in the Goa trip group",
           [("tally_group_balance", {"group": "Goa trip"})],
           ("ids", "person")),
        _t("and the Flatmates group",
           [("tally_group_balance", {"group": "Flatmates"})],
           ("ids", "person")),
    ]),

    # ----------------------------------------------- reference_into_result (8)
    ("i01", "reference_into_result", [
        _t("what's due this week",
           [("tasks_due", {"window": "this week"})],
           ("ids", "task"), True),
        _t("mark the first one done",
           [("tasks_complete", {"task": "the first one"})],
           ("write", "task_status", {"task_id": "t08", "status": "done"})),
    ]),
    ("i02", "reference_into_result", [
        _t("what's due this week",
           [("tasks_due", {"window": "this week"})],
           ("ids", "task"), True),
        _t("push the last one to next month",
           [("tasks_set_due", {"task": "the last one", "due": "next month"})],
           ("write", "task_due", {"task_id": "t04", "due": "2026-10-01"})),
    ]),
    ("i03", "reference_into_result", [
        _t("photos of Lena",
           [("photos_of_people", {"people": "Lena"})],
           ("ids", "photo")),
        _t("put the first two in the Family album",
           [("photos_add_to_album", {"photos": "the first two", "album": "Family"})],
           ("write", "photos_in_album", {"album_id": "a3", "photo_ids": ["ph03", "ph04"]})),
    ]),
    ("i04", "reference_into_result", [
        _t("who was at the Initech offsite",
           [("people_at", {"event": "the Initech offsite"})],
           ("ids", "person")),
        _t("only the ones with Priya",
           [("people_profile", {"person": "only the ones with Priya"})],
           ("ids", "person")),
    ]),
    ("i05", "reference_into_result", [
        _t("show me the Goa album",
           [("photos_in_album", {"album": "Goa"})],
           ("ids", "photo")),
        _t("only the ones with Marcus Reed",
           [("photos_of_people", {"people": "only the ones with Marcus Reed"})],
           ("ids", "photo")),
    ]),
    ("i06", "reference_into_result", [
        _t("what's in my Contracts folder",
           [("docs_in_folder", {"folder": "Contracts"})],
           ("ids", "document")),
        _t("star the second one",
           [("docs_star", {"docs": "the second one"})],
           ("write", "doc_starred", {"doc_id": "d2"})),
    ]),
    ("i07", "reference_into_result", [
        _t("what's left in the Migration project",
           [("tasks_by_project", {"project": "Migration"})],
           ("ids", "task")),
        _t("assign that first one to Priya",
           [("tasks_assign", {"task": "the first one", "people": "Priya"})],
           ("write", "task_assigned", {"task_id": "t03", "person_ids": ["p05"]})),
    ]),
    ("i08", "reference_into_result", [
        _t("who do I know at Acme",
           [("people_at_company", {"company": "Acme"})],
           ("ids", "person")),
        _t("log that I emailed the last one",
           [("people_log_interaction", {"person": "the last one", "channel": "email"})],
           ("write", "interaction_logged",
            {"person_id": "p10", "channel": "email", "happened": "2026-09-19"})),
    ]),

    # ------------------------------------------------------ refusal/none (8)
    ("n01", "refusal_none", [_t(
        "book me a flight to Lisbon",
        [("none", {})],
        ("no_action", "refuse"))]),
    ("n02", "refusal_none", [_t(
        "what's the weather tomorrow",
        [("none", {})],
        ("no_action", "refuse"))]),
    ("n03", "refusal_none", [_t(
        "what's Neha's email",
        [("people_profile", {"person": "Neha"})],
        ("no_action", "clarify"))]),
    ("n04", "refusal_none", [_t(
        "log that I called Marcus",
        [("people_log_interaction", {"person": "Marcus", "channel": "call"})],
        ("no_action", "clarify"))]),
    ("n05", "refusal_none", [_t(
        "cancel the shareholders meeting",
        [("agenda_cancel_event", {"event": "the shareholders meeting"})],
        ("no_action", "refuse"))]),
    ("n06", "refusal_none", [_t(
        "mark the renew one done",
        [("tasks_complete", {"task": "renew"})],
        ("no_action", "clarify"))]),
    ("n07", "refusal_none", [_t(
        "put the first one in the Goa album",
        [("photos_add_to_album", {"photos": "the first one", "album": "Goa"})],
        ("no_action", "refuse"))]),
    ("n08", "refusal_none", [_t(
        "show me my photos from Reykjavik",
        [("photos_at_place", {"place": "Reykjavik"})],
        ("no_action", "refuse"))]),
]


REFERENCE: dict[str, list[list[tuple[str, dict[str, Any]]]]] = {
    case_id: [turn[1] for turn in turns] for case_id, _category, turns in CASES
}

CATEGORIES: tuple[str, ...] = (
    "single_read",
    "single_write",
    "cross_app_one_call",
    "chain",
    "follow_up",
    "reference_into_result",
    "refusal_none",
)


def category_counts() -> dict[str, int]:
    """How many cases sit in each category."""
    counts = dict.fromkeys(CATEGORIES, 0)
    for _case_id, category, _turns in CASES:
        counts[category] += 1
    return counts
