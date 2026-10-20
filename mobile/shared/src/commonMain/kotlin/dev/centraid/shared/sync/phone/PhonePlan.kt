package dev.centraid.shared.sync.phone

/** WHY A LINK STOPPED FOLLOWING (R-1127-2). */
public enum class DetachReason {
    /** The vault row no longer matches the fingerprint the engine left on it: the member edited it. */
    EDITED,

    /** The member moved the row to the trash; the phone must not bring it back. */
    TRASHED,

    /** The member kept the rows of an origin that left the phone (R-1127-9). */
    KEPT,
}

/** ONE STEP OF A PASS. [PhoneSync.plan] chooses them; [PhoneSync.run] performs them. */
public sealed interface PhoneAction {
    /** An origin seen for the first time, or under a new label. */
    public data class UpsertOrigin(public val phoneOrigin: String, public val label: String) : PhoneAction

    /** A phone record the vault does not hold: a new row and a link. */
    public data class Add(public val record: PhoneRecord) : PhoneAction

    /** A phone record that is an existing, unlinked vault row: link it, write nothing to the row. */
    public data class Adopt(public val record: PhoneRecord, public val entityId: String) : PhoneAction

    /** The phone's fields changed and the row is as the engine left it: write them, refresh the link. */
    public data class Update(public val link: StoredLink, public val record: PhoneRecord) : PhoneAction

    /** Nothing changed but the record's origin (it moved calendar or account): re-point the link. */
    public data class Rehome(public val link: StoredLink, public val record: PhoneRecord) : PhoneAction

    /** The link stops following; the row is left exactly as it is. */
    public data class Detach(public val link: StoredLink, public val reason: DetachReason) : PhoneAction

    /** The phone record is gone: the row goes to the trash and the link is forgotten (R-1127-3). */
    public data class Trash(public val link: StoredLink) : PhoneAction

    /** The link has nothing left to follow and nothing left to protect. */
    public data class Forget(public val link: StoredLink) : PhoneAction

    /** Followed records seen again with nothing to write. */
    public data class Touch(public val phoneIds: List<String>) : PhoneAction

    /** An origin no link names any more. */
    public data class Retire(public val originId: String) : PhoneAction
}

/**
 * WHAT A PASS WILL DO, AND WHAT IT HOLDS.
 *
 * @property gone origins that left the phone with followed rows in them: one question each, and no
 *   write for their rows.
 * @property invalid phone ids the snapshot carried that name no kind ([PhoneIds.isValid]); they
 *   are skipped.
 */
public data class PhonePlan(
    public val actions: List<PhoneAction>,
    public val gone: List<OriginGone>,
    public val invalid: List<String> = emptyList(),
) {
    /** A pass with nothing to write: a second pass over the same snapshot is this. */
    public fun isEmpty(): Boolean = actions.isEmpty()
}

/**
 * How well a record matches an unlinked row with its [PhoneRecord.matchKey], or null for not at
 * all. The best score wins and only if it is strictly the best: a tie adopts nothing, and the
 * record is added, because a wrong adoption merges two people and a missed one only duplicates one.
 */
public typealias PhoneScore = (PhoneRecord, VaultRow) -> Int?

/** THE PURE HALF OF A PASS: a snapshot and what the vault holds in, a [PhonePlan] out. No I/O. */
public object PhoneSyncPlanner {
    /** The default [PhoneScore]: rank by the tiebreak values a record and a row share. */
    public val byTiebreakOverlap: PhoneScore = { record, row -> record.tiebreak.intersect(row.tiebreak).size }

    public fun plan(
        snapshot: PhoneSnapshot,
        origins: List<StoredOrigin>,
        links: List<StoredLink>,
        rows: Map<String, VaultRow>,
        score: PhoneScore = byTiebreakOverlap,
        covers: (VaultRow) -> Boolean = { true },
    ): PhonePlan {
        val invalid = mutableListOf<String>()
        val records = linkedMapOf<String, PhoneRecord>()
        for (record in snapshot.records) {
            if (!PhoneIds.isValid(record.phoneId)) {
                invalid += record.phoneId
                continue
            }
            records.putIfAbsent(record.phoneId, record)
        }
        val storedByPhone = origins.associateBy { it.phoneOrigin }
        val storedById = origins.associateBy { it.originId }
        val present = linkedMapOf<String, String>()
        snapshot.origins.forEach { present.putIfAbsent(it.id, it.label) }
        records.values.forEach { present.putIfAbsent(it.origin, it.origin) }

        val actions = mutableListOf<PhoneAction>()
        val usedOrigins = records.values.map { it.origin }.toSet() +
            links.mapNotNull { storedById[it.originId]?.phoneOrigin }
        for ((id, label) in present) {
            if (id !in usedOrigins) continue
            val stored = storedByPhone[id]
            if (stored == null || stored.label != label) actions += PhoneAction.UpsertOrigin(id, label)
        }

        val linkByPhone = links.associateBy { it.phoneId }
        val consumed = links.map { it.entityId }.toMutableSet()
        val candidates = rows.values.filter { !it.trashed && it.matchKey.isNotEmpty() }.groupBy { it.matchKey }
        val stale = mutableListOf<String>()
        val seen = mutableSetOf<String>()

        for (record in records.values) {
            val link = linkByPhone[record.phoneId]
            if (link == null) {
                val adopted = adoptable(record, candidates, consumed, score)
                actions += if (adopted != null) PhoneAction.Adopt(record, adopted.entityId) else PhoneAction.Add(record)
                continue
            }
            seen += link.phoneId
            if (link.detached) {
                if (isStale(link, snapshot)) stale += link.phoneId
                continue
            }
            val row = rows[link.entityId] ?: continue
            val parts = PhoneFingerprint.parts(link.fingerprint)
            when {
                parts == null || row.fields.digest() != parts.vault ->
                    actions += PhoneAction.Detach(link, DetachReason.EDITED)
                row.trashed -> actions += PhoneAction.Detach(link, DetachReason.TRASHED)
                record.fields.digest() != parts.phone -> actions += PhoneAction.Update(link, record)
                storedByPhone[record.origin]?.originId != link.originId -> actions += PhoneAction.Rehome(link, record)
                isStale(link, snapshot) -> stale += link.phoneId
            }
        }

        val goneCounts = linkedMapOf<String, Int>()
        if (snapshot.complete) {
            for (link in links) {
                if (link.phoneId in seen) continue
                val origin = storedById[link.originId]
                if (origin != null && origin.phoneOrigin !in present) {
                    if (!link.detached) goneCounts[origin.originId] = (goneCounts[origin.originId] ?: 0) + 1
                    continue
                }
                // A record the read could not have seen (an event outside the window it read) is
                // not a record that went: it is left, trashed by nothing and forgotten by nothing.
                val row = rows[link.entityId] ?: continue
                if (!covers(row)) continue
                when {
                    link.detached -> actions += PhoneAction.Forget(link)
                    else -> {
                        val parts = PhoneFingerprint.parts(link.fingerprint)
                        actions += when {
                            parts == null || row.fields.digest() != parts.vault ->
                                PhoneAction.Detach(link, DetachReason.EDITED)
                            row.trashed -> PhoneAction.Forget(link)
                            else -> PhoneAction.Trash(link)
                        }
                    }
                }
            }
        }
        if (stale.isNotEmpty()) actions += PhoneAction.Touch(stale)
        val gone = goneCounts.map { (originId, count) ->
            val origin = storedById.getValue(originId)
            OriginGone(snapshot.source, originId, origin.phoneOrigin, origin.label, count)
        }
        return PhonePlan(actions, gone, invalid)
    }

    /**
     * THE ANSWER TO "KEEP ITS 214 EVENTS?", as steps. Keeping detaches every followed row of the
     * origin; trashing trashes the ones the member never edited and forgets their links. **A row
     * the member edited is kept either way** (detached): trash is restorable, but the member's own
     * words are not the phone's to discard.
     */
    public fun resolve(
        originId: String,
        choice: GoneChoice,
        links: List<StoredLink>,
        rows: Map<String, VaultRow>,
    ): List<PhoneAction> {
        val actions = mutableListOf<PhoneAction>()
        var remaining = 0
        for (link in links.filter { it.originId == originId }) {
            if (link.detached) {
                remaining += 1
                continue
            }
            val row = rows[link.entityId]
            val parts = PhoneFingerprint.parts(link.fingerprint)
            val edited = row == null || parts == null || row.fields.digest() != parts.vault
            when {
                choice == GoneChoice.KEEP -> {
                    actions += PhoneAction.Detach(link, DetachReason.KEPT)
                    remaining += 1
                }
                edited -> {
                    actions += PhoneAction.Detach(link, DetachReason.EDITED)
                    remaining += 1
                }
                row?.trashed == true -> actions += PhoneAction.Forget(link)
                else -> actions += PhoneAction.Trash(link)
            }
        }
        if (remaining == 0) actions += PhoneAction.Retire(originId)
        return actions
    }

    /**
     * A link not yet sighted in this snapshot's second. Sightings are compared to the second:
     * the vault stamps milliseconds and a shell's `readAt` may not, and a link sighted by the
     * pass that read the snapshot must not look stale to the next pass over it.
     */
    private fun isStale(link: StoredLink, snapshot: PhoneSnapshot): Boolean =
        link.lastSeenAt.take(SECOND) < snapshot.readAt.take(SECOND)

    private fun adoptable(
        record: PhoneRecord,
        candidates: Map<String, List<VaultRow>>,
        consumed: MutableSet<String>,
        score: PhoneScore,
    ): VaultRow? {
        if (record.matchKey.isEmpty()) return null
        val ranked = candidates[record.matchKey].orEmpty()
            .filter { it.entityId !in consumed }
            .mapNotNull { row -> score(record, row)?.let { row to it } }
        val best = ranked.maxOfOrNull { it.second } ?: return null
        val top = ranked.filter { it.second == best }
        if (top.size != 1) return null
        return top.single().first.also { consumed += it.entityId }
    }

    /** `YYYY-MM-DDTHH:MM:SS`. */
    private const val SECOND: Int = 19
}
