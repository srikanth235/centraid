package dev.centraid.shared.kit

import centraid.core.v1.ContainerHit
import centraid.screen.v1.ChatCard
import centraid.screen.v1.SearchContainer
import dev.centraid.design.copy.SharedCopy

/**
 * A CONTAINER AS A SEARCH RESULT (#1097, R-1097-19..21): the notebook, album,
 * project or Docs folder a member typed the name of.
 *
 * ONE PLACE FINISHES IT. Home's `VaultSearchHit` and the four owning apps'
 * [ContainerHit] say the same thing in two wire shapes; both come through [of],
 * so the kind's word, its glyph and the noun the router opens it by
 * are written once, and a shell draws every container with one row.
 *
 * Every container opens by its own `id`.
 *
 * | index entity | app | kind | router noun | opens by |
 * | --- | --- | --- | --- | --- |
 * | `core.collection` | notes | Notebook | `notebook` | the collection id |
 * | `core.collection` | photos | Album | `album` | the collection id |
 * | `schedule.project` | tasks | Project | `project` | the project id |
 * | `core.concept` | docs | Folder | `folder` | the concept id |
 *
 * A pair this table does not name is no container ([of] answers null), so a
 * hit of an entity added later is a plain row until it is taught here.
 */
public object SearchContainers {
    /** The apps' own answers, folded; a hit that is no container is dropped. */
    public fun fold(hits: List<ContainerHit>): List<SearchContainer> =
        hits.mapNotNull { of(it.entity, it.id, it.app_id, it.title) }

    /** One container, or null when [entity] in [appId] is not one. */
    public fun of(entity: String, id: String, appId: String, title: String): SearchContainer? {
        val kind = KINDS[entity to appId] ?: return null
        return SearchContainer(
            entity = entity,
            id = id,
            app_id = appId,
            kind_label = kind.label,
            title = title,
            icon_key = kind.icon,
            accessibility_label = listOf(kind.label, title).filter { it.isNotBlank() }.joinToString(", "),
            target = ChatCard(app = appId, entity = kind.noun, id = id, title = title),
        )
    }

    private class Kind(val label: String, val noun: String, val icon: String)

    private val KINDS: Map<Pair<String, String>, Kind> = mapOf(
        ("core.collection" to "notes") to Kind(SharedCopy.SEARCH_KIND_NOTEBOOK, "notebook", "Book"),
        ("core.collection" to "photos") to Kind(SharedCopy.SEARCH_KIND_ALBUM, "album", "Image"),
        ("schedule.project" to "tasks") to Kind(SharedCopy.SEARCH_KIND_PROJECT, "project", "List"),
        ("core.concept" to "docs") to Kind(SharedCopy.SEARCH_KIND_FOLDER, "folder", "Folder"),
    )
}
