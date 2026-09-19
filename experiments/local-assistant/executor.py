"""The executor: an (operation, slots) pair becomes a read or a typed write.

``execute(op_name, slots, context, conn)`` is the only entry point. Reads are
parameterised SQL over the seeded world; writes are typed commands that mutate
it and return the ids they touched. No user text ever reaches SQL by string
formatting — every value is bound.

A turn that cannot proceed returns a ``Result`` with ``kind='no_action'`` and
a ``reason`` of ``clarify`` or ``refuse``. That is the protocol's ``none`` /
``clarify`` outcome, and it is deliberately not reachable as an operation.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable, Literal

import resolvers as R
from catalogue import by_name
from world import TODAY

ResultKind = Literal["ids", "write", "no_action"]
NoActionReason = Literal["clarify", "refuse", ""]


@dataclass
class Result:
    """What one turn did."""

    kind: ResultKind
    operation: str = ""
    ids: list[str] = field(default_factory=list)
    entity: str = ""
    reason: NoActionReason = ""
    detail: str = ""

    @property
    def acted(self) -> bool:
        """True when the turn reached the world."""
        return self.kind in ("ids", "write")


def _clarify(detail: str, operation: str = "") -> Result:
    return Result("no_action", operation=operation, reason="clarify", detail=detail)


def _refuse(detail: str, operation: str = "") -> Result:
    return Result("no_action", operation=operation, reason="refuse", detail=detail)


def _from_resolution(resolution: R.Resolution, operation: str) -> Result | None:
    """Turn a failed resolution into the protocol outcome it implies."""
    if resolution.outcome == "ambiguous":
        return _clarify(resolution.detail, operation)
    if resolution.outcome == "not_found":
        return _refuse(resolution.detail, operation)
    return None


def _slot(slots: dict[str, Any], name: str) -> str:
    return str(slots.get(name) or "").strip()


# ------------------------------------------------------------------- reads


def _ids(rows: list[sqlite3.Row]) -> list[str]:
    return [row["id"] for row in rows]


def _agenda_upcoming(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    window = R.resolve_date_range(_slot(slots, "window"))
    if window is None:
        return _clarify("which days?", "agenda_upcoming")
    start, end = window.as_iso()
    calendar = _slot(slots, "calendar")
    sql = "SELECT id FROM event WHERE status = 'confirmed' AND starts >= ? AND starts < ?"
    params: list[Any] = [start, end]
    if calendar:
        sql += " AND calendar = ?"
        params.append(calendar)
    sql += " ORDER BY starts, id"
    return Result("ids", "agenda_upcoming", _ids(list(conn.execute(sql, params))), "event")


def _agenda_search(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    topic = _slot(slots, "topic")
    if not topic:
        return _clarify("what should I look for?", "agenda_search")
    like = f"%{topic.lower()}%"
    sql = (
        "SELECT id, starts FROM event "
        "WHERE (lower(title) LIKE ? OR lower(notes) LIKE ?) AND status = 'confirmed'"
    )
    params: list[Any] = [like, like]
    window = R.resolve_date_range(_slot(slots, "window"))
    if window is not None:
        start, end = window.as_iso()
        sql += " AND starts >= ? AND starts < ?"
        params += [start, end]
    sql += " ORDER BY starts, id"
    return Result("ids", "agenda_search", _ids(list(conn.execute(sql, params))), "event")


def _agenda_day_context(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    day = R.resolve_day(_slot(slots, "day"))
    if day is None:
        return _clarify("which day?", "agenda_day_context")
    events = _ids(
        list(
            conn.execute(
                "SELECT id FROM event WHERE status = 'confirmed' "
                "AND starts >= ? AND starts < ? ORDER BY starts, id",
                (day.isoformat(), (day.toordinal() + 1 and date.fromordinal(day.toordinal() + 1)).isoformat()),
            )
        )
    )
    tasks = _ids(
        list(conn.execute("SELECT id FROM task WHERE due = ? AND status = 'open' ORDER BY id", (day.isoformat(),)))
    )
    return Result("ids", "agenda_day_context", events + tasks, "day_context")


def _people_at(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    event = R.resolve_event(conn, _slot(slots, "event"))
    failed = _from_resolution(event, "people_at")
    if failed:
        return failed
    response = _slot(slots, "response") or "any"
    sql = "SELECT person_id AS id FROM attendee WHERE event_id = ?"
    params: list[Any] = [event.ids[0]]
    if response != "any":
        sql += " AND response = ?"
        params.append(response)
    sql += " ORDER BY person_id"
    return Result("ids", "people_at", _ids(list(conn.execute(sql, params))), "person")


def _tasks_due(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    window = R.resolve_date_range(_slot(slots, "window"))
    if window is None:
        return _clarify("due when?", "tasks_due")
    start, end = window.as_iso()
    status = _slot(slots, "status") or "open"
    sql = "SELECT id FROM task WHERE due IS NOT NULL AND due >= ? AND due < ?"
    params: list[Any] = [start, end]
    if status != "any":
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY due, id"
    return Result("ids", "tasks_due", _ids(list(conn.execute(sql, params))), "task")


def _tasks_about(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    topic = _slot(slots, "topic")
    if not topic:
        return _clarify("about what?", "tasks_about")
    status = _slot(slots, "status") or "open"
    sql = "SELECT id FROM task WHERE lower(title) LIKE ?"
    params: list[Any] = [f"%{topic.lower()}%"]
    if status != "any":
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY id"
    return Result("ids", "tasks_about", _ids(list(conn.execute(sql, params))), "task")


def _tasks_by_project(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    project = R.resolve_project(conn, _slot(slots, "project"))
    failed = _from_resolution(project, "tasks_by_project")
    if failed:
        return failed
    status = _slot(slots, "status") or "open"
    sql = "SELECT id FROM task WHERE project_id = ?"
    params: list[Any] = [project.ids[0]]
    if status != "any":
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY id"
    return Result("ids", "tasks_by_project", _ids(list(conn.execute(sql, params))), "task")


def _tasks_for_people(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    narrowed = _filter_previous(conn, _slot(slots, "people"), ctx, "task", "tasks_for_people")
    if narrowed is not None:
        return narrowed
    people = R.resolve_people(conn, _slot(slots, "people"), ctx)
    failed = _from_resolution(people, "tasks_for_people")
    if failed:
        return failed
    status = _slot(slots, "status") or "open"
    placeholders = ",".join("?" for _ in people.ids)
    sql = (
        "SELECT DISTINCT t.id AS id, t.due AS due FROM task t "
        "JOIN task_assignee ta ON ta.task_id = t.id "
        f"WHERE ta.person_id IN ({placeholders})"
    )
    params: list[Any] = list(people.ids)
    if status != "any":
        sql += " AND t.status = ?"
        params.append(status)
    sql += " ORDER BY t.id"
    return Result("ids", "tasks_for_people", _ids(list(conn.execute(sql, params))), "task")


def _people_find(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    name = _slot(slots, "name")
    company = _slot(slots, "company") or None
    found = R.resolve_person(conn, name, company)
    if found.outcome == "not_found":
        return _refuse(found.detail, "people_find")
    if found.outcome == "ambiguous":
        return _clarify(found.detail, "people_find")
    return Result("ids", "people_find", found.ids, "person")


def _people_profile(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    person = R.resolve_people(conn, _slot(slots, "person"), ctx)
    failed = _from_resolution(person, "people_profile")
    if failed:
        return failed
    return Result("ids", "people_profile", person.ids, "person")


def _people_at_company(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    found = R.resolve_company_people(conn, _slot(slots, "company"))
    failed = _from_resolution(found, "people_at_company")
    if failed:
        return failed
    return Result("ids", "people_at_company", found.ids, "person")


def _notes_search(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    topic = _slot(slots, "topic")
    if not topic:
        return _clarify("about what?", "notes_search")
    like = f"%{topic.lower()}%"
    sql = "SELECT id FROM note WHERE (lower(title) LIKE ? OR lower(body) LIKE ?)"
    params: list[Any] = [like, like]
    notebook = _slot(slots, "notebook")
    if notebook:
        found = R.resolve_notebook(conn, notebook)
        failed = _from_resolution(found, "notes_search")
        if failed:
            return failed
        sql += " AND notebook_id = ?"
        params.append(found.ids[0])
    sql += " ORDER BY id"
    return Result("ids", "notes_search", _ids(list(conn.execute(sql, params))), "note")


def _notes_in_notebook(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    found = R.resolve_notebook(conn, _slot(slots, "notebook"))
    failed = _from_resolution(found, "notes_in_notebook")
    if failed:
        return failed
    sql = "SELECT id FROM note WHERE notebook_id = ?"
    params: list[Any] = [found.ids[0]]
    window = R.resolve_date_range(_slot(slots, "window"))
    if window is not None:
        start, end = window.as_iso()
        sql += " AND created >= ? AND created < ?"
        params += [start, end]
    sql += " ORDER BY id"
    return Result("ids", "notes_in_notebook", _ids(list(conn.execute(sql, params))), "note")


def _notes_about_people(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    narrowed = _filter_previous(conn, _slot(slots, "people"), ctx, "note", "notes_about_people")
    if narrowed is not None:
        return narrowed
    people = R.resolve_people(conn, _slot(slots, "people"), ctx)
    failed = _from_resolution(people, "notes_about_people")
    if failed:
        return failed
    placeholders = ",".join("?" for _ in people.ids)
    rows = conn.execute(
        "SELECT DISTINCT note_id AS id FROM note_person "  # noqa: S608 - placeholders only
        f"WHERE person_id IN ({placeholders}) ORDER BY note_id",
        people.ids,
    )
    return Result("ids", "notes_about_people", _ids(list(rows)), "note")


def _filter_previous(
    conn: sqlite3.Connection,
    phrase: str,
    ctx: R.Context,
    entity: str,
    operation: str,
) -> Result | None:
    """A read whose phrase narrows the previous result of the same entity.

    "only the ones with Neha" after a list of photos is a filter over those
    photos, not a fresh lookup of Neha's photos. The same phrase after a list
    of people is handled by ``resolve_people``; this is the branch for the
    apps whose results are not people.
    """
    if ctx.last_kind != entity or not phrase:
        return None
    pointed = R.resolve_reference(conn, phrase, ctx, kind=entity)
    if not pointed.ok:
        return None
    return Result("ids", operation, pointed.ids, entity)


def _photos_of_people(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    narrowed = _filter_previous(conn, _slot(slots, "people"), ctx, "photo", "photos_of_people")
    if narrowed is not None:
        return narrowed
    people = R.resolve_people(conn, _slot(slots, "people"), ctx)
    failed = _from_resolution(people, "photos_of_people")
    if failed:
        return failed
    placeholders = ",".join("?" for _ in people.ids)
    sql = (
        "SELECT DISTINCT p.id AS id FROM photo p JOIN photo_person pp ON pp.photo_id = p.id "
        f"WHERE pp.person_id IN ({placeholders})"
    )
    params: list[Any] = list(people.ids)
    window = R.resolve_date_range(_slot(slots, "window"))
    if window is not None:
        start, end = window.as_iso()
        sql += " AND p.taken >= ? AND p.taken < ?"
        params += [start, end]
    sql += " ORDER BY p.id"
    return Result("ids", "photos_of_people", _ids(list(conn.execute(sql, params))), "photo")


def _photos_by_date(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    window = R.resolve_date_range(_slot(slots, "window"))
    if window is None:
        return _clarify("taken when?", "photos_by_date")
    start, end = window.as_iso()
    rows = conn.execute(
        "SELECT id FROM photo WHERE taken >= ? AND taken < ? ORDER BY id", (start, end)
    )
    return Result("ids", "photos_by_date", _ids(list(rows)), "photo")


def _photos_in_album(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    album = R.resolve_album(conn, _slot(slots, "album"))
    failed = _from_resolution(album, "photos_in_album")
    if failed:
        return failed
    rows = conn.execute(
        "SELECT photo_id AS id FROM photo_album WHERE album_id = ? ORDER BY photo_id",
        (album.ids[0],),
    )
    return Result("ids", "photos_in_album", _ids(list(rows)), "photo")


def _photos_at_place(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    place = _slot(slots, "place")
    if not place:
        return _clarify("where?", "photos_at_place")
    sql = "SELECT id FROM photo WHERE lower(place) LIKE ?"
    params: list[Any] = [f"%{place.lower()}%"]
    window = R.resolve_date_range(_slot(slots, "window"))
    if window is not None:
        start, end = window.as_iso()
        sql += " AND taken >= ? AND taken < ?"
        params += [start, end]
    sql += " ORDER BY id"
    rows = list(conn.execute(sql, params))
    if not rows:
        return _refuse(f"no photos at {place!r}", "photos_at_place")
    return Result("ids", "photos_at_place", _ids(rows), "photo")


def _docs_search(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    topic = _slot(slots, "topic")
    if not topic:
        return _clarify("about what?", "docs_search")
    like = f"%{topic.lower()}%"
    sql = "SELECT id FROM document WHERE trashed = 0 AND (lower(name) LIKE ? OR lower(text) LIKE ?)"
    params: list[Any] = [like, like]
    kind = _slot(slots, "kind")
    if kind and kind != "any":
        sql += " AND kind = ?"
        params.append(kind)
    sql += " ORDER BY id"
    return Result("ids", "docs_search", _ids(list(conn.execute(sql, params))), "document")


def _docs_in_folder(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    folder = R.resolve_folder(conn, _slot(slots, "folder"))
    failed = _from_resolution(folder, "docs_in_folder")
    if failed:
        return failed
    rows = conn.execute(
        "SELECT id FROM document WHERE folder_id = ? AND trashed = 0 ORDER BY id", (folder.ids[0],)
    )
    return Result("ids", "docs_in_folder", _ids(list(rows)), "document")


def _locker_find(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    service = _slot(slots, "service")
    if not service:
        return _clarify("which service?", "locker_find")
    sql = "SELECT id FROM locker_item WHERE trashed = 0 AND lower(service) LIKE ?"
    params: list[Any] = [f"%{service.lower()}%"]
    kind = _slot(slots, "kind")
    if kind and kind != "any":
        sql += " AND kind = ?"
        params.append(kind)
    sql += " ORDER BY id"
    rows = list(conn.execute(sql, params))
    if not rows:
        return _refuse(f"nothing in the locker for {service!r}", "locker_find")
    return Result("ids", "locker_find", _ids(rows), "locker_item")


def _locker_weak(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    reason = _slot(slots, "reason") or "any"
    sql = "SELECT id FROM locker_item WHERE trashed = 0 AND health IS NOT NULL"
    params: list[Any] = []
    if reason != "any":
        sql += " AND health = ?"
        params.append(reason)
    sql += " ORDER BY id"
    return Result("ids", "locker_weak", _ids(list(conn.execute(sql, params))), "locker_item")


def _balances(conn: sqlite3.Connection, person_ids: list[str]) -> dict[str, float]:
    placeholders = ",".join("?" for _ in person_ids)
    rows = conn.execute(
        "SELECT person_id, SUM(amount) AS total FROM tally_entry "  # noqa: S608 - placeholders only
        f"WHERE settled = 0 AND person_id IN ({placeholders}) GROUP BY person_id",
        person_ids,
    )
    return {row["person_id"]: float(row["total"]) for row in rows}


def _tally_balance_with(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    people = R.resolve_people(conn, _slot(slots, "people"), ctx)
    failed = _from_resolution(people, "tally_balance_with")
    if failed:
        return failed
    totals = _balances(conn, people.ids)
    direction = _slot(slots, "direction") or "any"
    kept = []
    for pid in people.ids:
        total = totals.get(pid, 0.0)
        if direction == "owed_to_me" and total <= 0:
            continue
        if direction == "i_owe" and total >= 0:
            continue
        if direction == "any" and total == 0:
            continue
        kept.append(pid)
    return Result("ids", "tally_balance_with", kept, "person")


def _tally_who_owes_me(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    direction = _slot(slots, "direction")
    if direction not in ("owed_to_me", "i_owe"):
        return _clarify("who owes whom?", "tally_who_owes_me")
    comparison = "> 0" if direction == "owed_to_me" else "< 0"
    rows = conn.execute(
        "SELECT person_id AS id FROM tally_entry WHERE settled = 0 "  # noqa: S608 - literal comparison
        f"GROUP BY person_id HAVING SUM(amount) {comparison} ORDER BY person_id"
    )
    return Result("ids", "tally_who_owes_me", _ids(list(rows)), "person")


def _tally_group_balance(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    group = R.resolve_tally_group(conn, _slot(slots, "group"))
    failed = _from_resolution(group, "tally_group_balance")
    if failed:
        return failed
    rows = conn.execute(
        "SELECT person_id AS id FROM tally_entry WHERE settled = 0 AND group_id = ? "
        "GROUP BY person_id HAVING SUM(amount) <> 0 ORDER BY person_id",
        (group.ids[0],),
    )
    return Result("ids", "tally_group_balance", _ids(list(rows)), "person")


def _tally_expenses_with(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    people = R.resolve_people(conn, _slot(slots, "people"), ctx)
    failed = _from_resolution(people, "tally_expenses_with")
    if failed:
        return failed
    placeholders = ",".join("?" for _ in people.ids)
    sql = f"SELECT id FROM tally_entry WHERE person_id IN ({placeholders})"  # noqa: S608 - placeholders only
    params: list[Any] = list(people.ids)
    window = R.resolve_date_range(_slot(slots, "window"))
    if window is not None:
        start, end = window.as_iso()
        sql += " AND happened >= ? AND happened < ?"
        params += [start, end]
    sql += " ORDER BY id"
    return Result("ids", "tally_expenses_with", _ids(list(conn.execute(sql, params))), "tally_entry")


# ------------------------------------------------------------------ writes


def _next_id(conn: sqlite3.Connection, table: str, prefix: str, width: int) -> str:
    """The next deterministic id for a table: prefix plus a zero-padded count."""
    count = conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]  # noqa: S608 - literal
    return f"{prefix}{count + 1:0{width}d}"


def _agenda_create_event(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    title = _slot(slots, "title")
    when = R.resolve_datetime(_slot(slots, "when"))
    if not title:
        return _clarify("what should the event be called?", "agenda_create_event")
    if when is None:
        return _clarify("when?", "agenda_create_event")
    attendee_ids: list[str] = []
    if _slot(slots, "attendees"):
        people = R.resolve_people(conn, _slot(slots, "attendees"), ctx)
        failed = _from_resolution(people, "agenda_create_event")
        if failed:
            return failed
        attendee_ids = people.ids
    event_id = _next_id(conn, "event", "e", 2)
    end = f"{when[:11]}{int(when[11:13]) + 1:02d}{when[13:]}"
    conn.execute(
        "INSERT INTO event (id,title,starts,ends,calendar,notes,place) VALUES (?,?,?,?,?,?,?)",
        (event_id, title, when, end, _slot(slots, "calendar") or "personal", "", None),
    )
    for pid in attendee_ids:
        conn.execute("INSERT INTO attendee VALUES (?,?,?)", (event_id, pid, "pending"))
    conn.commit()
    return Result("write", "agenda_create_event", [event_id], "event")


def _agenda_reschedule(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    event = R.resolve_event(conn, _slot(slots, "event"))
    if not event.ok and ctx.last_kind == "event":
        event = R.resolve_reference(conn, _slot(slots, "event"), ctx, kind="event")
    failed = _from_resolution(event, "agenda_reschedule")
    if failed:
        return failed
    when = R.resolve_datetime(_slot(slots, "when"))
    if when is None:
        return _clarify("move it to when?", "agenda_reschedule")
    end = f"{when[:11]}{int(when[11:13]) + 1:02d}{when[13:]}"
    conn.execute("UPDATE event SET starts = ?, ends = ? WHERE id = ?", (when, end, event.ids[0]))
    conn.commit()
    return Result("write", "agenda_reschedule", event.ids, "event")


def _agenda_cancel_event(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    event = R.resolve_event(conn, _slot(slots, "event"))
    if not event.ok and ctx.last_kind == "event":
        event = R.resolve_reference(conn, _slot(slots, "event"), ctx, kind="event")
    failed = _from_resolution(event, "agenda_cancel_event")
    if failed:
        return failed
    conn.execute("UPDATE event SET status = 'cancelled' WHERE id = ?", (event.ids[0],))
    conn.commit()
    return Result("write", "agenda_cancel_event", event.ids, "event")


def _agenda_attendee_add(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    event = R.resolve_event(conn, _slot(slots, "event"))
    if not event.ok and ctx.last_kind == "event":
        event = R.resolve_reference(conn, _slot(slots, "event"), ctx, kind="event")
    failed = _from_resolution(event, "agenda_attendee_add")
    if failed:
        return failed
    people = R.resolve_people(conn, _slot(slots, "people"), ctx)
    failed = _from_resolution(people, "agenda_attendee_add")
    if failed:
        return failed
    for pid in people.ids:
        conn.execute(
            "INSERT OR IGNORE INTO attendee VALUES (?,?,?)", (event.ids[0], pid, "pending")
        )
    conn.commit()
    return Result("write", "agenda_attendee_add", people.ids, "person")


def _tasks_add(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    title = _slot(slots, "title")
    if not title:
        return _clarify("what is the task?", "tasks_add")
    due = R.resolve_day(_slot(slots, "due"))
    project_id: str | None = None
    if _slot(slots, "project"):
        project = R.resolve_project(conn, _slot(slots, "project"))
        failed = _from_resolution(project, "tasks_add")
        if failed:
            return failed
        project_id = project.ids[0]
    task_id = _next_id(conn, "task", "t", 2)
    conn.execute(
        "INSERT INTO task VALUES (?,?,?,?,?)",
        (task_id, title, due.isoformat() if due else None, "open", project_id),
    )
    if _slot(slots, "assignee"):
        people = R.resolve_people(conn, _slot(slots, "assignee"), ctx)
        failed = _from_resolution(people, "tasks_add")
        if failed:
            conn.rollback()
            return failed
        for pid in people.ids:
            conn.execute("INSERT INTO task_assignee VALUES (?,?)", (task_id, pid))
    conn.commit()
    return Result("write", "tasks_add", [task_id], "task")


def _tasks_complete(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    task = R.resolve_task(conn, _slot(slots, "task"), ctx)
    failed = _from_resolution(task, "tasks_complete")
    if failed:
        return failed
    for tid in task.ids:
        conn.execute("UPDATE task SET status = 'done' WHERE id = ?", (tid,))
    conn.commit()
    return Result("write", "tasks_complete", task.ids, "task")


def _tasks_set_due(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    task = R.resolve_task(conn, _slot(slots, "task"), ctx)
    failed = _from_resolution(task, "tasks_set_due")
    if failed:
        return failed
    due = R.resolve_day(_slot(slots, "due"))
    if due is None:
        return _clarify("due when?", "tasks_set_due")
    for tid in task.ids:
        conn.execute("UPDATE task SET due = ? WHERE id = ?", (due.isoformat(), tid))
    conn.commit()
    return Result("write", "tasks_set_due", task.ids, "task")


def _tasks_assign(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    task = R.resolve_task(conn, _slot(slots, "task"), ctx)
    failed = _from_resolution(task, "tasks_assign")
    if failed:
        return failed
    people = R.resolve_people(conn, _slot(slots, "people"), ctx)
    failed = _from_resolution(people, "tasks_assign")
    if failed:
        return failed
    for tid in task.ids:
        for pid in people.ids:
            conn.execute("INSERT OR IGNORE INTO task_assignee VALUES (?,?)", (tid, pid))
    conn.commit()
    return Result("write", "tasks_assign", task.ids, "task")


def _people_add(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    name = _slot(slots, "name")
    if not name:
        return _clarify("who?", "people_add")
    person_id = _next_id(conn, "person", "p", 2)
    first = name.split()[0]
    conn.execute(
        "INSERT INTO person VALUES (?,?,?,?,?,?,?,?)",
        (person_id, name, first, None, _slot(slots, "company") or None, _slot(slots, "email") or None, None, 0),
    )
    conn.commit()
    return Result("write", "people_add", [person_id], "person")


def _people_log_interaction(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    person = R.resolve_people(conn, _slot(slots, "person"), ctx)
    failed = _from_resolution(person, "people_log_interaction")
    if failed:
        return failed
    when = R.resolve_day(_slot(slots, "when")) or TODAY
    channel = _slot(slots, "channel") or "met"
    ids: list[str] = []
    for pid in person.ids:
        row_id = _next_id(conn, "interaction", "i", 1)
        conn.execute(
            "INSERT INTO interaction VALUES (?,?,?,?)", (row_id, pid, channel, when.isoformat())
        )
        ids.append(pid)
    conn.commit()
    return Result("write", "people_log_interaction", ids, "person")


def _people_add_note(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    person = R.resolve_people(conn, _slot(slots, "person"), ctx)
    failed = _from_resolution(person, "people_add_note")
    if failed:
        return failed
    body = _slot(slots, "body")
    if not body:
        return _clarify("what should the note say?", "people_add_note")
    for pid in person.ids:
        row_id = _next_id(conn, "person_note", "pn", 1)
        conn.execute(
            "INSERT INTO person_note VALUES (?,?,?,?)", (row_id, pid, body, TODAY.isoformat())
        )
    conn.commit()
    return Result("write", "people_add_note", person.ids, "person")


def _notes_create(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    title = _slot(slots, "title")
    if not title:
        return _clarify("what should the note be called?", "notes_create")
    notebook_id: str | None = None
    if _slot(slots, "notebook"):
        notebook = R.resolve_notebook(conn, _slot(slots, "notebook"))
        failed = _from_resolution(notebook, "notes_create")
        if failed:
            return failed
        notebook_id = notebook.ids[0]
    note_id = _next_id(conn, "note", "n", 2)
    conn.execute(
        "INSERT INTO note VALUES (?,?,?,?,?)",
        (note_id, title, _slot(slots, "body"), notebook_id, TODAY.isoformat()),
    )
    if _slot(slots, "people"):
        people = R.resolve_people(conn, _slot(slots, "people"), ctx)
        failed = _from_resolution(people, "notes_create")
        if failed:
            conn.rollback()
            return failed
        for pid in people.ids:
            conn.execute("INSERT INTO note_person VALUES (?,?)", (note_id, pid))
    conn.commit()
    return Result("write", "notes_create", [note_id], "note")


def _notes_append(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    note = R.resolve_note(conn, _slot(slots, "note"), ctx)
    failed = _from_resolution(note, "notes_append")
    if failed:
        return failed
    body = _slot(slots, "body")
    if not body:
        return _clarify("append what?", "notes_append")
    for nid in note.ids:
        conn.execute("UPDATE note SET body = body || ' ' || ? WHERE id = ?", (body, nid))
    conn.commit()
    return Result("write", "notes_append", note.ids, "note")


def _photos_add_to_album(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    photos = R.resolve_photos(conn, _slot(slots, "photos"), ctx)
    failed = _from_resolution(photos, "photos_add_to_album")
    if failed:
        return failed
    album = R.resolve_album(conn, _slot(slots, "album"))
    failed = _from_resolution(album, "photos_add_to_album")
    if failed:
        return failed
    for photo_id in photos.ids:
        conn.execute(
            "INSERT OR IGNORE INTO photo_album VALUES (?,?)", (photo_id, album.ids[0])
        )
    conn.commit()
    return Result("write", "photos_add_to_album", photos.ids, "photo")


def _docs_star(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    docs = R.resolve_document(conn, _slot(slots, "docs"), ctx)
    failed = _from_resolution(docs, "docs_star")
    if failed:
        return failed
    for doc_id in docs.ids:
        conn.execute("UPDATE document SET starred = 1 WHERE id = ?", (doc_id,))
    conn.commit()
    return Result("write", "docs_star", docs.ids, "document")


def _docs_move(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    docs = R.resolve_document(conn, _slot(slots, "docs"), ctx)
    failed = _from_resolution(docs, "docs_move")
    if failed:
        return failed
    folder = R.resolve_folder(conn, _slot(slots, "folder"))
    failed = _from_resolution(folder, "docs_move")
    if failed:
        return failed
    for doc_id in docs.ids:
        conn.execute("UPDATE document SET folder_id = ? WHERE id = ?", (folder.ids[0], doc_id))
    conn.commit()
    return Result("write", "docs_move", docs.ids, "document")


def _locker_add(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    service = _slot(slots, "service")
    kind = _slot(slots, "kind")
    if not service:
        return _clarify("which service?", "locker_add")
    if kind not in ("login", "card", "note", "identity"):
        return _clarify("what kind of item?", "locker_add")
    item_id = _next_id(conn, "locker_item", "l", 1)
    conn.execute(
        "INSERT INTO locker_item (id,service,kind,username,health) VALUES (?,?,?,?,?)",
        (item_id, service, kind, _slot(slots, "username") or None, None),
    )
    conn.commit()
    return Result("write", "locker_add", [item_id], "locker_item")


def _tally_add_expense(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    description = _slot(slots, "description")
    if not description:
        return _clarify("what was the expense for?", "tally_add_expense")
    try:
        amount = float(slots.get("amount"))
    except (TypeError, ValueError):
        return _clarify("how much?", "tally_add_expense")
    people = R.resolve_people(conn, _slot(slots, "people"), ctx)
    failed = _from_resolution(people, "tally_add_expense")
    if failed:
        return failed
    group_id: str | None = None
    if _slot(slots, "group"):
        group = R.resolve_tally_group(conn, _slot(slots, "group"))
        failed = _from_resolution(group, "tally_add_expense")
        if failed:
            return failed
        group_id = group.ids[0]
    # The owner paid, so each named person owes their equal share.
    share = round(amount / (len(people.ids) + 1), 2)
    written: list[str] = []
    for pid in people.ids:
        entry_id = _next_id(conn, "tally_entry", "x", 2)
        conn.execute(
            "INSERT INTO tally_entry VALUES (?,?,?,?,?,?,?,?)",
            (entry_id, description, share, pid, group_id, TODAY.isoformat(), "expense", 0),
        )
        written.append(entry_id)
    conn.commit()
    return Result("write", "tally_add_expense", written, "tally_entry")


def _tally_settle_up(conn: sqlite3.Connection, slots: dict[str, Any], ctx: R.Context) -> Result:
    people = R.resolve_people(conn, _slot(slots, "people"), ctx)
    failed = _from_resolution(people, "tally_settle_up")
    if failed:
        return failed
    placeholders = ",".join("?" for _ in people.ids)
    conn.execute(
        f"UPDATE tally_entry SET settled = 1 WHERE settled = 0 AND person_id IN ({placeholders})",  # noqa: S608 - placeholders only
        people.ids,
    )
    conn.commit()
    return Result("write", "tally_settle_up", people.ids, "person")


Handler = Callable[[sqlite3.Connection, dict[str, Any], R.Context], Result]

HANDLERS: dict[str, Handler] = {
    "agenda_upcoming": _agenda_upcoming,
    "agenda_search": _agenda_search,
    "agenda_day_context": _agenda_day_context,
    "people_at": _people_at,
    "agenda_create_event": _agenda_create_event,
    "agenda_reschedule": _agenda_reschedule,
    "agenda_cancel_event": _agenda_cancel_event,
    "agenda_attendee_add": _agenda_attendee_add,
    "tasks_due": _tasks_due,
    "tasks_about": _tasks_about,
    "tasks_by_project": _tasks_by_project,
    "tasks_for_people": _tasks_for_people,
    "tasks_add": _tasks_add,
    "tasks_complete": _tasks_complete,
    "tasks_set_due": _tasks_set_due,
    "tasks_assign": _tasks_assign,
    "people_find": _people_find,
    "people_profile": _people_profile,
    "people_at_company": _people_at_company,
    "people_add": _people_add,
    "people_log_interaction": _people_log_interaction,
    "people_add_note": _people_add_note,
    "notes_search": _notes_search,
    "notes_in_notebook": _notes_in_notebook,
    "notes_about_people": _notes_about_people,
    "notes_create": _notes_create,
    "notes_append": _notes_append,
    "photos_of_people": _photos_of_people,
    "photos_by_date": _photos_by_date,
    "photos_in_album": _photos_in_album,
    "photos_at_place": _photos_at_place,
    "photos_add_to_album": _photos_add_to_album,
    "docs_search": _docs_search,
    "docs_in_folder": _docs_in_folder,
    "docs_star": _docs_star,
    "docs_move": _docs_move,
    "locker_find": _locker_find,
    "locker_weak": _locker_weak,
    "locker_add": _locker_add,
    "tally_balance_with": _tally_balance_with,
    "tally_who_owes_me": _tally_who_owes_me,
    "tally_group_balance": _tally_group_balance,
    "tally_expenses_with": _tally_expenses_with,
    "tally_add_expense": _tally_add_expense,
    "tally_settle_up": _tally_settle_up,
}


def execute(
    op_name: str,
    slots: dict[str, Any],
    context: R.Context,
    conn: sqlite3.Connection,
) -> Result:
    """Run one (operation, slots) pair against the world.

    ``none`` and ``clarify`` are accepted here as *outcomes the caller already
    decided on*, so a model that emits them (or a selector that returns them)
    lands on the protocol's no-action path rather than on a missing handler.
    """
    if op_name == "none":
        return _refuse("nothing in the vault answers this", "none")
    if op_name == "clarify":
        return _clarify("the request needs a follow-up question", "clarify")

    handler = HANDLERS.get(op_name)
    if handler is None:
        return _refuse(f"no such operation: {op_name!r}")

    result = handler(conn, slots, context)
    if result.acted:
        context.remember(result.entity, result.ids, op_name)
    else:
        context.last_operation = op_name
    return result


def catalogue_is_covered() -> list[str]:
    """Catalogue names with no handler. Empty is the invariant."""
    return sorted(set(by_name()) - set(HANDLERS))
