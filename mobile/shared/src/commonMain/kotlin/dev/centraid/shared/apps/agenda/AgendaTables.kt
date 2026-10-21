package dev.centraid.shared.apps.agenda

/**
 * THE TABLES AGENDA'S ANSWERS ARE FOLDED FROM, once (#1135): an event is an `entity` with an
 * `event` row, its guests and attachments are `edge`s, a skipped or moved day is an `occurrence`,
 * a calendar is a `container`, a birthday is the `person`'s own column, and the owner is the
 * `vault`'s `self_id`.
 */
internal object AgendaTables {
    /** One event: its row and words, its guests, its days, its calendar and place, what is attached. */
    val EVENT: Set<String> = setOf(
        "entity",
        "event",
        "occurrence",
        "edge",
        "container",
        "person",
        "vault",
        "document",
        "photo",
        "blob",
    )

    /** The agenda: an event's tables, and the tasks it draws with their projects, sections and tags. */
    val HOME: Set<String> = EVENT + "task"
}
