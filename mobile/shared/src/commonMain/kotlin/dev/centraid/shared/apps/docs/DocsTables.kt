package dev.centraid.shared.apps.docs

/**
 * THE TABLES A DOCS COMMAND CHANGES (#1135): a change event names tables. A
 * document is an `entity` (its title, its trash) with a `document` row (its
 * bytes, its folder), a star or a label is an `edge`, a folder is a
 * `container`, a version is a `revision`, and the bytes' text is a
 * `derivative` of a `blob`.
 *
 * The model has one `entity` table for every kind, so another app's command
 * moves it too: Docs re-reads a shelf it did not need to, never a wrong one.
 */
public object DocsTables {
    /** What every Docs read depends on. */
    public val SHELF: Set<String> = setOf("entity", "document", "edge", "container", "blob", "derivative")

    /** The shelf's tables and the revisions a document's history lists. */
    public val DOCUMENT: Set<String> = SHELF + "revision"

    /** What one document's activity reads: its journal. */
    public val ACTIVITY: Set<String> = DOCUMENT + "journal"
}
