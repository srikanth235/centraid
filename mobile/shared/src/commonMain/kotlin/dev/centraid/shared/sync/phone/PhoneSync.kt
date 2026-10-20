package dev.centraid.shared.sync.phone

/**
 * THE VAULT, AS ONE SOURCE'S PASS SEES IT. A source (People, Agenda, Docs) implements the rows and
 * the three writes; [CorePhoneStore] implements the link and the origin over the core's commands.
 * Every method answers null (or false) when the core refused or failed, and **none of them throws**:
 * a refusal is counted and the pass goes on.
 */
public interface PhoneStore {
    public val source: PhoneSource

    /** Every `phone_link` of the source, or null when the read failed (the pass then writes nothing). */
    public suspend fun links(): List<StoredLink>?

    public suspend fun origins(): List<StoredOrigin>?

    /** Every row of the source's kind the engine needs to see, trashed ones too, by entity id. */
    public suspend fun rows(): Map<String, VaultRow>?

    /** One row as the vault reads it now: how the engine learns what it just wrote. */
    public suspend fun row(entityId: String): VaultRow?

    /** `phone.origin`: the origin's row id. */
    public suspend fun origin(phoneOrigin: String, label: String): String?

    /** `phone.link`: the link's id. */
    public suspend fun link(phoneId: String, originId: String, entityId: String, fingerprint: String): String?

    public suspend fun touch(phoneIds: List<String>): Boolean

    public suspend fun detach(linkId: String): Boolean

    public suspend fun forget(linkId: String): Boolean

    public suspend fun retireOrigin(originId: String): Boolean

    /** Write a new row from [record]; its entity id. */
    public suspend fun add(record: PhoneRecord): String?

    /** Write [record]'s fields onto [entityId]. */
    public suspend fun update(entityId: String, record: PhoneRecord): Boolean

    /**
     * Follow [record]'s satellite on [entityId] (a series' skipped and moved occurrences), without
     * touching the row's own fields. Called when the satellite alone changed, and after every
     * [update]. A source with no satellite does nothing.
     */
    public suspend fun follow(entityId: String, record: PhoneRecord): Boolean = true

    /** Move [entityId] to the trash (restorable, R-1127-3). */
    public suspend fun trash(entityId: String): Boolean

    /** The source's adoption ranking; [PhoneSyncPlanner.byTiebreakOverlap] unless it says otherwise. */
    public val score: PhoneScore get() = PhoneSyncPlanner.byTiebreakOverlap

    /**
     * WHICH ROWS A READ COULD HAVE SEEN. A source that reads a window (Agenda reads a week back
     * and two months on) must not take a row outside it for a record that went: such a row is
     * neither trashed nor forgotten. Everything is covered unless the source says otherwise.
     */
    public suspend fun coverage(): (VaultRow) -> Boolean = { true }
}

/** WHAT A PASS DID. [read] is false when the vault could not be read and nothing was done. */
public data class PhoneReport(
    public val read: Boolean = true,
    public val added: Int = 0,
    public val adopted: Int = 0,
    public val updated: Int = 0,
    public val followed: Int = 0,
    public val rehomed: Int = 0,
    public val detached: Int = 0,
    public val trashed: Int = 0,
    public val forgotten: Int = 0,
    public val touched: Int = 0,
    /** The phone ids of records a write was refused for, and of ids that named no kind. */
    public val refused: List<String> = emptyList(),
    /** The origins held for a question (R-1127-9). */
    public val gone: List<OriginGone> = emptyList(),
) {
    /** Rows written to, not counting sightings. */
    public val changed: Int get() = added + adopted + updated + followed + rehomed + detached + trashed + forgotten
}

/**
 * THE ENGINE: ONE PASS OVER A PHONE SNAPSHOT AND THE LINKS THE VAULT HOLDS (#1127).
 *
 * `phone → vault`, one way (R-1127-1). Per record: absent → added (or an existing unlinked row of
 * the same name or title adopted); changed on the phone and untouched in the vault → updated; the
 * vault row no longer as the engine left it → detached and never overwritten (R-1127-2); gone from
 * an origin that is still present, after a complete read → trashed (R-1127-3); an origin gone
 * altogether → held and asked, nothing written (R-1127-9); an incomplete read → nothing trashed.
 * A second pass over the same snapshot writes nothing (R-1088-12).
 */
public object PhoneSync {
    /** Plan and perform one pass. */
    public suspend fun run(store: PhoneStore, snapshot: PhoneSnapshot): PhoneReport {
        require(snapshot.source == store.source) { "a ${snapshot.source} snapshot given to a ${store.source} store" }
        val origins = store.origins() ?: return PhoneReport(read = false)
        val links = store.links() ?: return PhoneReport(read = false)
        val rows = store.rows() ?: return PhoneReport(read = false)
        val plan = PhoneSyncPlanner.plan(snapshot, origins, links, rows, store.score, store.coverage())
        return perform(store, plan.actions, origins, rows, PhoneReport(gone = plan.gone, refused = plan.invalid))
    }

    /**
     * The member's answer to an [OriginGone]. [seenBefore] is its `seenBefore` for an origin that
     * only lost most of its rows, so the answer reaches those and no others.
     */
    public suspend fun resolveGone(
        store: PhoneStore,
        originId: String,
        choice: GoneChoice,
        seenBefore: String? = null,
    ): PhoneReport {
        val origins = store.origins() ?: return PhoneReport(read = false)
        val links = store.links() ?: return PhoneReport(read = false)
        val rows = store.rows() ?: return PhoneReport(read = false)
        return perform(store, PhoneSyncPlanner.resolve(originId, choice, links, rows, seenBefore), origins, rows, PhoneReport())
    }

    private suspend fun perform(
        store: PhoneStore,
        actions: List<PhoneAction>,
        stored: List<StoredOrigin>,
        rows: Map<String, VaultRow>,
        start: PhoneReport,
    ): PhoneReport {
        val originIds = stored.associate { it.phoneOrigin to it.originId }.toMutableMap()
        var report = start
        val refuse = { id: String -> report = report.copy(refused = report.refused + id) }
        for (action in actions) {
            when (action) {
                is PhoneAction.UpsertOrigin ->
                    store.origin(action.phoneOrigin, action.label)?.let { originIds[action.phoneOrigin] = it }
                is PhoneAction.Add -> {
                    val origin = originIds[action.record.origin]
                    val entity = if (origin == null) null else store.add(action.record)
                    // A row written whose link was refused is found again next pass by matching.
                    val linked = entity != null && origin != null && link(store, action.record, origin, entity)
                    if (linked) report = report.copy(added = report.added + 1) else refuse(action.record.phoneId)
                }
                is PhoneAction.Adopt -> {
                    val origin = originIds[action.record.origin]
                    val row = rows[action.entityId]
                    val linked = origin != null && row != null &&
                        store.link(
                            action.record.phoneId,
                            origin,
                            action.entityId,
                            PhoneFingerprint.pack(action.record.fields.digest(), action.record.satellite.digest(), row.fields.digest()),
                        ) != null
                    if (linked) report = report.copy(adopted = report.adopted + 1) else refuse(action.record.phoneId)
                }
                is PhoneAction.Update -> {
                    val origin = originIds[action.record.origin]
                    val entity = action.link.entityId
                    val done = origin != null && entity != null &&
                        store.update(entity, action.record) &&
                        store.follow(entity, action.record) &&
                        link(store, action.record, origin, entity)
                    if (done) report = report.copy(updated = report.updated + 1) else refuse(action.record.phoneId)
                }
                is PhoneAction.Satellite -> {
                    val origin = originIds[action.record.origin]
                    val entity = action.link.entityId
                    val done = origin != null && entity != null &&
                        store.follow(entity, action.record) &&
                        link(store, action.record, origin, entity)
                    if (done) report = report.copy(followed = report.followed + 1) else refuse(action.record.phoneId)
                }
                is PhoneAction.Rehome -> {
                    val origin = originIds[action.record.origin]
                    val entity = action.link.entityId
                    val done = origin != null && entity != null && store.link(
                        action.link.phoneId,
                        origin,
                        entity,
                        action.link.fingerprint,
                    ) != null
                    if (done) report = report.copy(rehomed = report.rehomed + 1) else refuse(action.link.phoneId)
                }
                is PhoneAction.Detach ->
                    if (store.detach(action.link.linkId)) {
                        report = report.copy(detached = report.detached + 1)
                    } else {
                        refuse(action.link.phoneId)
                    }
                is PhoneAction.Trash ->
                    if (action.link.entityId?.let { store.trash(it) } == true && store.forget(action.link.linkId)) {
                        report = report.copy(trashed = report.trashed + 1)
                    } else {
                        refuse(action.link.phoneId)
                    }
                is PhoneAction.Forget ->
                    if (store.forget(action.link.linkId)) {
                        report = report.copy(forgotten = report.forgotten + 1)
                    } else {
                        refuse(action.link.phoneId)
                    }
                is PhoneAction.Touch ->
                    if (store.touch(action.phoneIds)) report = report.copy(touched = report.touched + action.phoneIds.size)
                is PhoneAction.Retire -> store.retireOrigin(action.originId)
            }
        }
        return report
    }

    /** Link [record] to [entity], held against the row as the vault reads it NOW. */
    private suspend fun link(store: PhoneStore, record: PhoneRecord, origin: String, entity: String): Boolean {
        val row = store.row(entity) ?: return false
        val fingerprint = PhoneFingerprint.pack(record.fields.digest(), record.satellite.digest(), row.fields.digest())
        return store.link(record.phoneId, origin, entity, fingerprint) != null
    }
}
