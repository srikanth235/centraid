"""The blind re-check set: cases written without sight of the training data.

The frozen suite's cross-app templates were written after the joint lane's
failures were known, so the .811 number it reports could be a template fit
rather than a capability. This set is written against the catalogue, the
seeded world and the scorer alone — no template file, no generator, no
training corpus, no suite case past the first three — so a model that scores
the same here generalises, and one that does not was fitted.

Same schema as ``suite.json``: ids ``b01``…, the same seven categories in the
suite's proportions, the same outcome kinds (``ids`` / ``write_predicate`` /
``no_action``). Each case is
``(id, category, note, [(request, calls, outcome, ordered)])``; ``note`` is
``"needs canonical"`` when a slot the case needs cannot be a verbatim span of
the utterance (an enum value such as ``direction="i_owe"``), and ``""``
otherwise.
"""

from __future__ import annotations

from typing import Any

Call = tuple[str, dict[str, Any]]
Turn = tuple[str, list[Call], tuple[Any, ...], bool]
Case = tuple[str, str, str, list[Turn]]

CATEGORIES = [
    "single_read",
    "single_write",
    "cross_app_one_call",
    "chain",
    "follow_up",
    "reference_into_result",
    "refusal_none",
]

CASES: list[Case] = [
    # ------------------------------------------------------- single_read 10
    (
        "b01",
        "single_read",
        "",
        [
            (
                "anything next week on my calendar?",
                [("agenda_upcoming", {"window": "next week"})],
                ("ids", "event"),
                True,
            )
        ],
    ),
    (
        "b02",
        "single_read",
        "",
        [
            (
                "show me the photos taken in Goa",
                [("photos_at_place", {"place": "Goa"})],
                ("ids", "photo"),
                False,
            )
        ],
    ),
    (
        "b03",
        "single_read",
        "",
        [
            (
                "which tasks are overdue",
                [("tasks_due", {"window": "overdue"})],
                ("ids", "task"),
                True,
            )
        ],
    ),
    (
        "b04",
        "single_read",
        "",
        [
            (
                "pull up the notes in my Journal notebook",
                [("notes_in_notebook", {"notebook": "Journal"})],
                ("ids", "note"),
                False,
            )
        ],
    ),
    (
        "b05",
        "single_read",
        "",
        [
            (
                "whos at initech",
                [("people_at_company", {"company": "initech"})],
                ("ids", "person"),
                False,
            )
        ],
    ),
    (
        "b06",
        "single_read",
        "",
        [
            (
                "any docs in the Contracts folder",
                [("docs_in_folder", {"folder": "Contracts"})],
                ("ids", "document"),
                False,
            )
        ],
    ),
    (
        "b07",
        "single_read",
        "needs canonical",
        [
            (
                "which locker logins got flagged as reused",
                [("locker_weak", {"reason": "reused"})],
                ("ids", "locker_item"),
                False,
            )
        ],
    ),
    (
        "b08",
        "single_read",
        "needs canonical",
        [
            (
                "who am i in the red with",
                [("tally_who_owes_me", {"direction": "i_owe"})],
                ("ids", "person"),
                False,
            )
        ],
    ),
    (
        "b09",
        "single_read",
        "",
        [
            (
                "tasks filed under Migration please",
                [("tasks_by_project", {"project": "Migration"})],
                ("ids", "task"),
                False,
            )
        ],
    ),
    (
        "b10",
        "single_read",
        "",
        [
            (
                "find my notes about onboarding",
                [("notes_search", {"topic": "onboarding"})],
                ("ids", "note"),
                False,
            )
        ],
    ),
    # ------------------------------------------------------- single_write 8
    (
        "b11",
        "single_write",
        "",
        [
            (
                "add a task to water the plants",
                [("tasks_add", {"title": "water the plants"})],
                ("write", "task_exists", {"title": "water the plants"}),
                False,
            )
        ],
    ),
    (
        "b12",
        "single_write",
        "",
        [
            (
                "Renew the domain is done",
                [("tasks_complete", {"task": "Renew the domain"})],
                ("write", "task_status", {"task_id": "t01", "status": "done"}),
                False,
            )
        ],
    ),
    (
        "b13",
        "single_write",
        "",
        [
            (
                "push Draft the migration plan to next friday",
                [("tasks_set_due", {"task": "Draft the migration plan", "due": "next friday"})],
                ("write", "task_due", {"task_id": "t03", "due": "2026-09-25"}),
                False,
            )
        ],
    ),
    (
        "b14",
        "single_write",
        "",
        [
            (
                "put Team lunch on the calendar tuesday at 13:00",
                [("agenda_create_event", {"title": "Team lunch", "when": "tuesday at 13:00"})],
                ("write", "event_exists", {"title": "Team lunch", "starts": "2026-09-22T13:00"}),
                False,
            )
        ],
    ),
    (
        "b15",
        "single_write",
        "",
        [
            (
                "start a note called Grocery list",
                [("notes_create", {"title": "Grocery list"})],
                ("write", "note_exists", {"title": "Grocery list"}),
                False,
            )
        ],
    ),
    (
        "b16",
        "single_write",
        "needs canonical",
        [
            (
                "log that i rang Priya yesterday",
                [
                    (
                        "people_log_interaction",
                        {"person": "Priya", "when": "yesterday", "channel": "call"},
                    )
                ],
                (
                    "write",
                    "interaction_logged",
                    {"person_id": "p05", "channel": "call", "happened": "2026-09-18"},
                ),
                False,
            )
        ],
    ),
    (
        "b17",
        "single_write",
        "",
        [
            (
                "save a login for Netflix in the locker",
                [("locker_add", {"service": "Netflix", "kind": "login"})],
                ("write", "locker_item_exists", {"service": "Netflix", "kind": "login"}),
                False,
            )
        ],
    ),
    (
        "b18",
        "single_write",
        "",
        [
            (
                "new contact: Rahul Verma, he's at Acme",
                [("people_add", {"name": "Rahul Verma", "company": "Acme"})],
                ("write", "person_exists", {"full_name": "Rahul Verma", "company": "Acme"}),
                False,
            )
        ],
    ),
    # ------------------------------------------------- cross_app_one_call 6
    (
        "b19",
        "cross_app_one_call",
        "needs canonical",
        [
            (
                "do i owe anything to the people who came to the design review",
                [
                    (
                        "tally_balance_with",
                        {
                            "people": "the people who came to the design review",
                            "direction": "i_owe",
                        },
                    )
                ],
                ("ids", "person"),
                False,
            )
        ],
    ),
    (
        "b20",
        "cross_app_one_call",
        "",
        [
            (
                "what's on the plate for the Initech people",
                [("tasks_for_people", {"people": "the Initech people"})],
                ("ids", "task"),
                False,
            )
        ],
    ),
    (
        "b21",
        "cross_app_one_call",
        "",
        [
            (
                "photos of everyone at the Initech offsite",
                [("photos_of_people", {"people": "everyone at the Initech offsite"})],
                ("ids", "photo"),
                False,
            )
        ],
    ),
    (
        "b22",
        "cross_app_one_call",
        "",
        [
            (
                "notes about the design review attendees",
                [("notes_about_people", {"people": "the design review attendees"})],
                ("ids", "note"),
                False,
            )
        ],
    ),
    (
        "b23",
        "cross_app_one_call",
        "",
        [
            (
                "invite the Acme people to the quarterly review",
                [
                    (
                        "agenda_attendee_add",
                        {"event": "the quarterly review", "people": "the Acme people"},
                    )
                ],
                (
                    "write",
                    "event_has_attendees",
                    {"event_id": "e09", "person_ids": ["p04", "p07", "p10"]},
                ),
                False,
            )
        ],
    ),
    (
        "b24",
        "cross_app_one_call",
        "",
        [
            (
                "list the expenses with everyone who went to the Initech offsite",
                [("tally_expenses_with", {"people": "everyone who went to the Initech offsite"})],
                ("ids", "tally_entry"),
                False,
            )
        ],
    ),
    # -------------------------------------------------------------- chain 4
    (
        "b25",
        "chain",
        "",
        [
            (
                "find the Acme paperwork and star it",
                [
                    ("docs_search", {"topic": "Acme"}),
                    ("docs_star", {"docs": "those"}),
                ],
                ("write", "doc_starred", {"doc_id": "d2"}),
                False,
            )
        ],
    ),
    (
        "b26",
        "chain",
        "",
        [
            (
                "take the photos in the Goa album and put them in Family too",
                [
                    ("photos_in_album", {"album": "Goa"}),
                    ("photos_add_to_album", {"photos": "them", "album": "Family"}),
                ],
                (
                    "write",
                    "photos_in_album",
                    {
                        "album_id": "a3",
                        "photo_ids": ["ph05", "ph06", "ph07", "ph13", "ph14", "ph19"],
                    },
                ),
                False,
            )
        ],
    ),
    (
        "b27",
        "chain",
        "",
        [
            (
                "who's coming to sprint planning — add them to the retro as well",
                [
                    ("people_at", {"event": "sprint planning"}),
                    ("agenda_attendee_add", {"event": "the retro", "people": "them"}),
                ],
                (
                    "write",
                    "event_has_attendees",
                    {"event_id": "e06", "person_ids": ["p03", "p05", "p08"]},
                ),
                False,
            )
        ],
    ),
    (
        "b28",
        "chain",
        "",
        [
            (
                "look up the migration runbook and move it into Contracts",
                [
                    ("docs_search", {"topic": "migration runbook"}),
                    ("docs_move", {"docs": "it", "folder": "Contracts"}),
                ],
                ("write", "doc_in_folder", {"doc_id": "d8", "folder_id": "f1"}),
                False,
            )
        ],
    ),
    # ---------------------------------------------------------- follow_up 4
    (
        "b29",
        "follow_up",
        "",
        [
            (
                "what's due next week",
                [("tasks_due", {"window": "next week"})],
                ("ids", "task"),
                True,
            ),
            (
                "and next month?",
                [("tasks_due", {"window": "next month"})],
                ("ids", "task"),
                True,
            ),
        ],
    ),
    (
        "b30",
        "follow_up",
        "",
        [
            (
                "who works at Hooli",
                [("people_at_company", {"company": "Hooli"})],
                ("ids", "person"),
                False,
            ),
            (
                "what about Acme",
                [("people_at_company", {"company": "Acme"})],
                ("ids", "person"),
                False,
            ),
        ],
    ),
    (
        "b31",
        "follow_up",
        "",
        [
            (
                "show me the Work notebook",
                [("notes_in_notebook", {"notebook": "Work"})],
                ("ids", "note"),
                False,
            ),
            (
                "the Ideas one now",
                [("notes_in_notebook", {"notebook": "Ideas"})],
                ("ids", "note"),
                False,
            ),
        ],
    ),
    (
        "b32",
        "follow_up",
        "needs canonical",
        [
            (
                "does anyone owe me money",
                [("tally_who_owes_me", {"direction": "owed_to_me"})],
                ("ids", "person"),
                False,
            ),
            (
                "other way round?",
                [("tally_who_owes_me", {"direction": "i_owe"})],
                ("ids", "person"),
                False,
            ),
        ],
    ),
    # ----------------------------------------------- reference_into_result 4
    (
        "b33",
        "reference_into_result",
        "",
        [
            (
                "photos taken in Koramangala",
                [("photos_at_place", {"place": "Koramangala"})],
                ("ids", "photo"),
                False,
            ),
            (
                "only the ones with Lena",
                [("photos_of_people", {"people": "only the ones with Lena"})],
                ("ids", "photo"),
                False,
            ),
        ],
    ),
    (
        "b34",
        "reference_into_result",
        "",
        [
            (
                "what's overdue",
                [("tasks_due", {"window": "overdue"})],
                ("ids", "task"),
                True,
            ),
            (
                "mark the first one done",
                [("tasks_complete", {"task": "the first one"})],
                ("write", "task_status", {"task_id": "t08", "status": "done"}),
                False,
            ),
        ],
    ),
    (
        "b35",
        "reference_into_result",
        "",
        [
            (
                "find the events about migration",
                [("agenda_search", {"topic": "migration"})],
                ("ids", "event"),
                True,
            ),
            (
                "move the last one to Thursday at 15:00",
                [("agenda_reschedule", {"event": "the last one", "when": "Thursday at 15:00"})],
                ("write", "event_starts", {"event_id": "e06", "starts": "2026-09-24T15:00"}),
                False,
            ),
        ],
    ),
    (
        "b36",
        "reference_into_result",
        "needs canonical",
        [
            (
                "who was at the offsite",
                [("people_at", {"event": "the offsite"})],
                ("ids", "person"),
                False,
            ),
            (
                "log that i met them today",
                [
                    (
                        "people_log_interaction",
                        {"person": "them", "when": "today", "channel": "met"},
                    )
                ],
                (
                    "write",
                    "interaction_logged",
                    {"person_id": "p01", "channel": "met", "happened": "2026-09-19"},
                ),
                False,
            ),
        ],
    ),
    # ------------------------------------------------------- refusal_none 4
    (
        "b37",
        "refusal_none",
        "",
        [
            (
                "what's the weather in Goa tomorrow",
                [("none", {})],
                ("no_action", "refuse"),
                False,
            )
        ],
    ),
    (
        "b38",
        "refusal_none",
        "",
        [
            (
                "order me a pizza",
                [("none", {})],
                ("no_action", "refuse"),
                False,
            )
        ],
    ),
    (
        "b39",
        "refusal_none",
        "",
        [
            (
                "whats Neha's email",
                [("people_profile", {"person": "Neha", "section": "channels"})],
                ("no_action", "clarify"),
                False,
            )
        ],
    ),
    (
        "b40",
        "refusal_none",
        "",
        [
            (
                "note on Marcus's record that he prefers evenings",
                [("people_add_note", {"person": "Marcus", "body": "he prefers evenings"})],
                ("no_action", "clarify"),
                False,
            )
        ],
    ),
]


def category_counts() -> dict[str, int]:
    """How many cases sit in each category."""
    counts = {category: 0 for category in CATEGORIES}
    for _, category, _, _ in CASES:
        counts[category] += 1
    return {category: count for category, count in counts.items() if count}


REFERENCE: dict[str, list[list[Call]]] = {
    case_id: [calls for _, calls, _, _ in turns] for case_id, _, _, turns in CASES
}

NOTES: dict[str, str] = {case_id: note for case_id, _, note, _ in CASES if note}
