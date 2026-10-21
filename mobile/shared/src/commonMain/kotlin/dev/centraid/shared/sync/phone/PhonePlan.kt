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
    /** An origin seen for the first time, under a new label, or first on this device. */
    public data class UpsertOrigin(public val phoneOrigin: String, public val label: String) : PhoneAction

    /** A phone record the vault does not hold: a new row and a link. */
    public data class Add(public val record: PhoneRecord) : PhoneAction

    /** A phone record that is an existing, unlinked vault row: link it, write nothing to the row. */
    public data class Adopt(public val record: PhoneRecord, public val entityId: String) : PhoneAction

    /** The phone's fields changed and the row is as the engine left it: write them, refresh the link. */
    public data class Update(public val link: StoredLink, public val record: PhoneRecord) : PhoneAction

    /** Only the record's satellite changed (a series' skipped or moved occurrence): follow it, leave the row's fields, refresh the link. */
    public data class Satellite(public val link: StoredLink, public val record: PhoneRecord) : PhoneAction

    /**
     * A LINK RE-FOUND UNDER A NEW PHONE ID (`phone.relink`): the link moves to [record]'s id, this
     * device and its origin, and keeps its row, fingerprint, detach and tombstone. The rest of the
     * pass then treats it as [record]'s own link, so a record whose fields moved is an [Update] and
     * an edited row a [Detach]. Two ways in: another device's `local:` link met by its match key on
     * this one (F-K-1, a vault restored onto a new phone), and, for a store that opts in
     * ([PhoneStore.refindLost], R-1129-15), this device's own lost link met by a new record of the
     * same key in the same pass.
     */
    public data class Refind(public val link: StoredLink, public val record: PhoneRecord) : PhoneAction

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

    /**
     * One pass's plan. [device] is the phone the pass runs on ([PhoneDevice]): a link another
     * device made for a `local:` id is FOREIGN here, and so is an origin another device last read.
     * A foreign link is re-found by its match key or, on a complete read, forgotten; it is never
     * trashed, never purged and never counted lost, and a foreign origin's absence is never asked
     * about (F-K-1). A null [device] makes every link this device's own.
     */
    public fun plan(
        snapshot: PhoneSnapshot,
        origins: List<StoredOrigin>,
        links: List<StoredLink>,
        rows: Map<String, VaultRow>,
        score: PhoneScore = byTiebreakOverlap,
        covers: (VaultRow) -> Boolean = { true },
        refindLost: Boolean = false,
        device: String? = null,
    ): PhonePlan {
        val invalid = mutableListOf<String>()
        val records = linkedMapOf<String, PhoneRecord>()
        for (record in snapshot.records) {
            if (!PhoneIds.isValid(record.phoneId)) {
                invalid += record.phoneId
                continue
            }
            if (record.phoneId !in records) records[record.phoneId] = record
        }
        val storedByPhone = origins.associateBy { it.phoneOrigin }
        val storedById = origins.associateBy { it.originId }
        val present = linkedMapOf<String, String>()
        snapshot.origins.forEach { if (it.id !in present) present[it.id] = it.label }
        records.values.forEach { if (it.origin !in present) present[it.origin] = it.origin }

        val actions = mutableListOf<PhoneAction>()
        // EVERY ORIGIN PRESENT IS REGISTERED, empty ones too: a calendar with no event yet is still
        // what the member imported, and it is what makes the source followed (a vault holds an
        // origin for the sources the member brought in). One another device last read becomes this
        // one's: it is here, so this device judges it from now on.
        for ((id, label) in present) {
            val stored = storedByPhone[id]
            if (stored == null || stored.label != label || foreign(stored.deviceId, device)) {
                actions += PhoneAction.UpsertOrigin(id, label)
            }
        }

        val own = links.filter { !foreign(it.deviceId, device) }
        val theirs = links.filter { foreign(it.deviceId, device) }
        val linkByPhone = own.associateBy { it.phoneId }.toMutableMap()
        val consumed = links.mapNotNull { it.entityId }.toMutableSet()
        val candidates = rows.values.filter { !it.trashed && it.matchKey.isNotEmpty() }.groupBy { it.matchKey }
        val stale = mutableListOf<String>()
        val seen = mutableSetOf<String>()

        // A LINK RE-FOUND UNDER A NEW ID, before anything is added or counted lost. This device's
        // own lost row first (R-1129-15, a store that opts in), then another device's links: a
        // new phone's own ids for the same records are the same rows, not new ones, and not a vanish.
        val refound = linkedMapOf<PhoneRecord, StoredLink>()
        if (refindLost && snapshot.complete) {
            refound += refind(records, linkByPhone, rows, storedByPhone, storedById, present, covers)
        }
        val unclaimed = records.values.filter { it.phoneId !in linkByPhone && it !in refound }
        refound += refindForeign(theirs, unclaimed)
        for ((record, link) in refound) {
            actions += PhoneAction.Refind(link, record)
            seen += link.linkId
            // From here on it is the record's own link, already sighted and already in its origin.
            linkByPhone[record.phoneId] = link.copy(
                phoneId = record.phoneId,
                deviceId = if (PhoneIds.isPortable(record.phoneId)) null else device,
                originId = storedByPhone[record.origin]?.originId ?: link.originId,
                lastSeenAt = snapshot.readAt,
            )
        }
        val refoundIds = refound.keys.map { it.phoneId }.toSet()
        val refoundLinks = refound.values.map { it.linkId }.toSet()

        // ANOTHER DEVICE'S LINK NOTHING HERE MATCHED, on a read that saw everything it covers: the
        // link goes and the row stays, an ordinary row from now on; nothing is trashed or asked.
        // Before any add, so a source that adopts an unlinked row (Docs' title and bytes) can
        // adopt it in this same pass.
        val forgotten = mutableSetOf<String>()
        if (snapshot.complete) {
            for (link in theirs) {
                if (link.linkId in refoundLinks) continue
                val row = link.entityId?.let { rows[it] }
                if (!link.purged && (row == null || !covers(row))) continue
                actions += PhoneAction.Forget(link)
                forgotten += link.linkId
            }
        }

        for (record in records.values) {
            val link = linkByPhone[record.phoneId]
            if (link == null) {
                val adopted = adoptable(record, candidates, consumed, score)
                actions += if (adopted != null) PhoneAction.Adopt(record, adopted.entityId) else PhoneAction.Add(record)
                continue
            }
            seen += link.linkId
            // A PURGED ROW'S RECORD IS NEVER ADDED AGAIN: the member deleted it forever.
            val entity = link.entityId ?: continue
            if (link.detached) {
                if (isStale(link, snapshot)) stale += link.phoneId
                continue
            }
            val row = rows[entity] ?: continue
            val parts = PhoneFingerprint.parts(link.fingerprint)
            when {
                parts == null || row.fields.digest() != parts.vault ->
                    actions += PhoneAction.Detach(link, DetachReason.EDITED)
                row.trashed -> actions += PhoneAction.Detach(link, DetachReason.TRASHED)
                record.fields.digest() != parts.phone -> actions += PhoneAction.Update(link, record)
                record.phoneId !in refoundIds && storedByPhone[record.origin]?.originId != link.originId ->
                    actions += PhoneAction.Rehome(link, record)
                record.satellite.digest() != parts.satellite -> actions += PhoneAction.Satellite(link, record)
                isStale(link, snapshot) -> stale += link.phoneId
            }
        }

        val left = mutableListOf<OriginGone>()
        val vanishedGone = mutableListOf<OriginGone>()
        if (snapshot.complete) {
            val goneCounts = linkedMapOf<String, Int>()
            // What a complete read of a PRESENT origin did not find, by origin: links with their rows.
            val lost = linkedMapOf<String, MutableList<Pair<StoredLink, VaultRow?>>>()
            for (link in own) {
                if (link.linkId in seen) continue
                val origin = storedById[link.originId]
                if (origin != null && origin.phoneOrigin !in present) {
                    // AN ORIGIN ANOTHER DEVICE LAST READ is not this one's to judge: its absence
                    // here says nothing, so its device-independent links wait to be seen again.
                    if (foreign(origin.deviceId, device)) continue
                    if (!link.detached && !link.purged) goneCounts[origin.originId] = (goneCounts[origin.originId] ?: 0) + 1
                    continue
                }
                val row = link.entityId?.let { rows[it] }
                // A record the read could not have seen (an event outside the window it read) is
                // not a record that went: it is left, trashed by nothing and forgotten by nothing.
                if (!link.purged && (row == null || !covers(row))) continue
                lost.getOrPut(link.originId) { mutableListOf() } += link to row
            }
            val held = vanished(own, rows, seen, covers, lost.keys)
            for ((originId, count) in held) {
                val origin = storedById.getValue(originId)
                vanishedGone += OriginGone(snapshot.source, originId, origin.phoneOrigin, origin.label, count, GoneReason.VANISHED, snapshot.readAt)
            }
            for ((originId, group) in lost) {
                // A VANISH HOLDS THE WHOLE ORIGIN'S ABSENT ROWS, tombstones and detached links too:
                // if the records come back, nothing must have been forgotten.
                if (originId in held) continue
                for ((link, row) in group) {
                    actions += when {
                        link.purged || link.detached -> PhoneAction.Forget(link)
                        else -> {
                            val parts = PhoneFingerprint.parts(link.fingerprint)
                            when {
                                row == null || parts == null || row.fields.digest() != parts.vault ->
                                    PhoneAction.Detach(link, DetachReason.EDITED)
                                row.trashed -> PhoneAction.Forget(link)
                                else -> PhoneAction.Trash(link)
                            }
                        }
                    }
                }
            }
            goneCounts.forEach { (originId, count) ->
                val origin = storedById.getValue(originId)
                left += OriginGone(snapshot.source, originId, origin.phoneOrigin, origin.label, count)
            }
        }
        if (stale.isNotEmpty()) actions += PhoneAction.Touch(stale)
        // ANOTHER DEVICE'S ORIGIN THAT NO LINK NAMES ANY MORE is retired: a restored vault's old
        // folders and containers do not linger on the new phone as followed ones.
        for (origin in origins) {
            if (!foreign(origin.deviceId, device) || origin.phoneOrigin in present) continue
            val named = links.any { it.originId == origin.originId && it.linkId !in forgotten && it.linkId !in refoundLinks }
            if (!named) actions += PhoneAction.Retire(origin.originId)
        }
        return PhonePlan(actions, left + vanishedGone, invalid)
    }

    /**
     * Whether a link or origin stamped [stamped] belongs to another device than [device]. No stamp
     * is no device at all (a `uid:` or `lookup:` link), and no [device] makes nothing foreign.
     */
    private fun foreign(stamped: String?, device: String?): Boolean =
        device != null && !stamped.isNullOrEmpty() && stamped != device

    /**
     * ANOTHER DEVICE'S LINKS PAIRED WITH THIS PASS'S UNLINKED RECORDS (F-K-1). They pair on the
     * match key the link's record had when the engine last wrote it (the fingerprint's key digest),
     * so a tombstone, a detached row and a trashed row are re-found as surely as a live one, and the
     * new phone holds exactly what the old one did. **Only one to one**: a key that two links or two
     * records share pairs nothing, because merging two people or two events into one is worse than
     * a duplicate the member can delete; the links are then forgotten and the records added.
     */
    private fun refindForeign(theirs: List<StoredLink>, unclaimed: List<PhoneRecord>): Map<PhoneRecord, StoredLink> {
        if (theirs.isEmpty()) return emptyMap()
        val links = theirs.mapNotNull { link ->
            PhoneFingerprint.parts(link.fingerprint)?.key?.takeIf { it != PhoneFingerprint.NO_KEY }?.let { it to link }
        }.groupBy({ it.first }, { it.second })
        val records = unclaimed.filter { it.matchKey.isNotEmpty() }.groupBy { PhoneFingerprint.key(it.matchKey) }
        val paired = linkedMapOf<PhoneRecord, StoredLink>()
        for ((key, named) in records) {
            val candidates = links[key] ?: continue
            if (named.size == 1 && candidates.size == 1) paired[named.single()] = candidates.single()
        }
        return paired
    }

    /**
     * LOST LINKS PAIRED WITH NEW RECORDS OF THE SAME ROW (R-1129-15). A link is lost when its
     * record is absent from an origin still present on this (complete) read, its row is covered,
     * live and as the engine left it (an edited row is not re-found: it detaches as before). A
     * record is new when no link names its phone id. They pair on the row's non-blank match key and
     * the same origin, one record to one row: rows in match-key order then link id (so the earliest
     * start goes first), records in the snapshot's order.
     */
    private fun refind(
        records: Map<String, PhoneRecord>,
        linkByPhone: Map<String, StoredLink>,
        rows: Map<String, VaultRow>,
        storedByPhone: Map<String, StoredOrigin>,
        storedById: Map<String, StoredOrigin>,
        present: Map<String, String>,
        covers: (VaultRow) -> Boolean,
    ): Map<PhoneRecord, StoredLink> {
        val lost = linkByPhone.values.filter { link ->
            if (link.phoneId in records || link.detached || link.purged) return@filter false
            val origin = storedById[link.originId] ?: return@filter false
            val row = link.entityId?.let { rows[it] } ?: return@filter false
            val parts = PhoneFingerprint.parts(link.fingerprint)
            origin.phoneOrigin in present && !row.trashed && covers(row) && row.matchKey.isNotEmpty() &&
                parts != null && row.fields.digest() == parts.vault
        }.sortedWith(compareBy({ rows.getValue(it.entityId!!).matchKey }, { it.linkId })).toMutableList()
        val paired = linkedMapOf<PhoneRecord, StoredLink>()
        for (record in records.values) {
            if (lost.isEmpty()) break
            if (record.matchKey.isEmpty() || record.phoneId in linkByPhone) continue
            val originId = storedByPhone[record.origin]?.originId ?: continue
            val at = lost.indexOfFirst { it.originId == originId && rows.getValue(it.entityId!!).matchKey == record.matchKey }
            if (at >= 0) paired[record] = lost.removeAt(at)
        }
        return paired
    }

    /**
     * THE ORIGINS A COMPLETE READ LOST MOST OF (gap 4 of #1127), with how many followed rows each
     * lost. An origin still on the phone whose read finds fewer than half of its followed rows is
     * a sync glitch or an account mid-resync far more often than a member deleting their address
     * book, so its absent rows are held for the question rather than trashed. **At least
     * [VANISH_MIN] lost and more than half of those the read could have seen**: below five, a few
     * deletions are a member tidying and a question each time would be noise; at or under half,
     * the rest of the origin is plainly there. A member who did delete most of an account answers
     * "Move to trash" once. [links] are this device's own: another device's are never lost here.
     */
    private fun vanished(
        links: List<StoredLink>,
        rows: Map<String, VaultRow>,
        seen: Set<String>,
        covers: (VaultRow) -> Boolean,
        origins: Set<String>,
    ): Map<String, Int> {
        val held = linkedMapOf<String, Int>()
        for (originId in origins) {
            var followed = 0
            var missing = 0
            for (link in links) {
                if (link.originId != originId || link.detached || link.purged) continue
                val row = link.entityId?.let { rows[it] } ?: continue
                if (row.trashed || !covers(row)) continue
                followed += 1
                if (link.linkId !in seen) missing += 1
            }
            if (missing >= VANISH_MIN && missing * 2 > followed) held[originId] = missing
        }
        return held
    }

    /**
     * THE ANSWER TO "KEEP ITS 214 EVENTS?", as steps. Keeping detaches every followed row of the
     * origin; trashing trashes the ones the member never edited and forgets their links. **A row
     * the member edited is kept either way** (detached): trash is restorable, but the member's own
     * words are not the phone's to discard. A purged row's tombstone is forgotten either way.
     *
     * [seenBefore] is the pass's read time for an origin that is still on the phone and only lost
     * most of its rows ([GoneReason.VANISHED]): the answer then touches the links not sighted
     * since, which are the ones the read lost, and never the rest. Another [device]'s links are
     * never touched: they are re-found or forgotten by a pass, and they keep the origin.
     */
    public fun resolve(
        originId: String,
        choice: GoneChoice,
        links: List<StoredLink>,
        rows: Map<String, VaultRow>,
        seenBefore: String? = null,
        device: String? = null,
    ): List<PhoneAction> {
        val actions = mutableListOf<PhoneAction>()
        val ofOrigin = links.filter { it.originId == originId }
        // Compared whole, milliseconds included: both are `YYYY-MM-DDTHH:MM:SS.mmmZ`.
        val targets = ofOrigin.filter { !foreign(it.deviceId, device) && (seenBefore == null || it.lastSeenAt < seenBefore) }
        var remaining = ofOrigin.size - targets.size
        for (link in targets) {
            if (link.purged) {
                actions += PhoneAction.Forget(link)
                continue
            }
            if (link.detached) {
                remaining += 1
                continue
            }
            val row = link.entityId?.let { rows[it] }
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
                row.trashed -> actions += PhoneAction.Forget(link)
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

    /** Fewest followed rows a read may lose from a present origin before it is held for a question. */
    public const val VANISH_MIN: Int = 5
}
