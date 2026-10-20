package dev.centraid.shared

import dev.centraid.shared.sync.phone.PhoneFields
import dev.centraid.shared.sync.phone.PhoneRecord
import dev.centraid.shared.sync.phone.PhoneSource
import dev.centraid.shared.sync.phone.PhoneStore
import dev.centraid.shared.sync.phone.StoredLink
import dev.centraid.shared.sync.phone.StoredOrigin
import dev.centraid.shared.sync.phone.VaultRow

/**
 * AN IN-MEMORY VAULT THAT KEEPS THE COMMANDS' OWN RULES: a link refreshes in place and never
 * re-attaches, a detach is set once, a forget deletes, an origin is retired only when no link
 * names it. Every write is logged (`add`, `update`, `trash`, `link`, `touch`…), reads are not.
 */
internal class FakeStore(override val source: PhoneSource = PhoneSource.CONTACTS) : PhoneStore {
    val rows = linkedMapOf<String, VaultRow>()
    val links = linkedMapOf<String, StoredLink>()
    val origins = linkedMapOf<String, StoredOrigin>()
    val writes = mutableListOf<String>()
    var refuseAdds: Set<String> = emptySet()
    var refuse: (PhoneRecord) -> Boolean = { false }
    var covered: (VaultRow) -> Boolean = { true }
    var unreadable: Boolean = false
    private var next = 0

    private fun id(prefix: String) = "$prefix-${++next}"

    /** The vault's clock: always after the snapshots' `readAt`, as the vault's is. */
    private val now = "2026-10-20T23:59:59.000Z"

    fun seed(name: String, vararg phones: String, trashed: Boolean = false): String {
        val entity = id("row")
        rows[entity] = VaultRow(
            entity,
            PhoneFields.of { text("name", name); phones("phones", phones.toList()) },
            trashed,
            matchKey = name.lowercase(),
            tiebreak = phones.map(PhoneFields::phoneNumber).toSet(),
        )
        return entity
    }

    /** The member edits a row in Centraid: fields change, no command of the engine's runs. */
    fun edit(entity: String, fields: PhoneFields) {
        rows[entity] = rows.getValue(entity).copy(fields = fields)
    }

    override suspend fun links() = if (unreadable) null else links.values.toList()

    override suspend fun origins() = if (unreadable) null else origins.values.toList()

    override suspend fun rows() = if (unreadable) null else rows.toMap()

    override suspend fun row(entityId: String) = rows[entityId]

    override suspend fun coverage(): (VaultRow) -> Boolean = covered

    override suspend fun origin(phoneOrigin: String, label: String): String {
        val known = origins.values.firstOrNull { it.phoneOrigin == phoneOrigin }
        if (known == null) {
            val created = StoredOrigin(id("origin"), phoneOrigin, label)
            origins[created.originId] = created
            writes += "origin"
            return created.originId
        }
        if (known.label != label) {
            origins[known.originId] = known.copy(label = label)
            writes += "origin"
        }
        return known.originId
    }

    override suspend fun link(phoneId: String, originId: String, entityId: String, fingerprint: String): String? {
        val known = links.values.firstOrNull { it.phoneId == phoneId }
        if (known?.detached == true) return null
        val refreshed = (known ?: StoredLink(id("link"), phoneId, originId, entityId, fingerprint, false, now))
            .copy(originId = originId, entityId = entityId, fingerprint = fingerprint, lastSeenAt = now)
        if (known != refreshed) {
            links[refreshed.linkId] = refreshed
            writes += "link"
        }
        return refreshed.linkId
    }

    override suspend fun touch(phoneIds: List<String>): Boolean {
        writes += "touch"
        links.replaceAll { _, link -> if (link.phoneId in phoneIds) link.copy(lastSeenAt = now) else link }
        return true
    }

    override suspend fun detach(linkId: String): Boolean {
        val link = links[linkId] ?: return false
        if (!link.detached) {
            links[linkId] = link.copy(detached = true)
            writes += "detach"
        }
        return true
    }

    override suspend fun forget(linkId: String): Boolean {
        if (links.remove(linkId) != null) writes += "forget"
        return true
    }

    override suspend fun retireOrigin(originId: String): Boolean {
        if (links.values.any { it.originId == originId }) return false
        if (origins.remove(originId) != null) writes += "retire"
        return true
    }

    override suspend fun add(record: PhoneRecord): String? {
        if (record.fields.canonical().substringAfter("name=").substringBefore('\n') in refuseAdds || refuse(record)) return null
        val entity = id("row")
        rows[entity] = VaultRow(entity, record.fields, false, record.matchKey, record.tiebreak)
        writes += "add"
        return entity
    }

    override suspend fun update(entityId: String, record: PhoneRecord): Boolean {
        rows[entityId] = rows.getValue(entityId).copy(fields = record.fields)
        writes += "update"
        return true
    }

    override suspend fun trash(entityId: String): Boolean {
        rows[entityId] = rows.getValue(entityId).copy(trashed = true)
        writes += "trash"
        return true
    }
}
