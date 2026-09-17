package dev.centraid.shared.shell

import centraid.core.v1.Command
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.platform.MediaLibrary
import dev.centraid.shared.platform.NetworkStatus
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.platform.SecureStore
import dev.centraid.shared.sync.TransferRule
import okio.ByteString.Companion.encodeUtf8

/**
 * THE CAMERA ROLL, GOING UP (#1025 S6, D-1025-S7-73).
 *
 * The half of the product that was missing entirely. `MediaLibrary` could
 * describe a roll, `Staging` could hand bytes to the core, the runtime could
 * decide where a write goes, `ScreenEffect.Backup` could be emitted and
 * `BackupState` could be drawn — and **nothing joined any of them**. There was
 * no caller of `Staging` on any platform, no producer of a `BackupState` other
 * than a permission change, and no code anywhere that turned a photograph on a
 * phone into a row in a vault. A phone was a viewer.
 *
 * ## The shape, and why each step is where it is
 *
 * ```
 *   page(cursor)  ->  open(localId)  ->  Staging.stage  ->  Intent(needs=…)
 *   the platform      the platform       THE CORE NAMES     the gateway pulls
 *   enumerates        streams bytes      THE BYTES          and then commits
 * ```
 *
 * **The phone never computes an identity.** `Staging` exists because the vault's
 * identity is BLAKE3 and no phone SDK offers it (D-1025-S4-6); this class
 * therefore stages first and reads the hash off the core's answer, and the
 * `media.add_asset` it then queues NAMES that hash rather than asserting one.
 *
 * **The gateway is still the only writer.** What goes in the outbox is an
 * ordinary [Intent] carrying [NeededBytes], which is the declaration that makes
 * the gateway open a `blob` stream back down this seat's own connection, fetch
 * and verify the bytes, and only then execute — so a content row never names
 * bytes the gateway does not hold (`crates/seat-link/src/serve.rs`,
 * `crates/centraid/tests/bytes_upward.rs`).
 *
 * ## Idempotence, twice over, because once is not enough
 *
 * 1. **The durable cursor** ([cursorKey]) is what makes a RE-ENUMERATION queue
 *    nothing. It is advanced after each asset is queued, not once at the end, so
 *    a pass the OS kills half way resumes at the photograph it was on rather
 *    than at the one it started from.
 * 2. **The intent id is the CONTENT HASH** and not the asset's local id. That is
 *    the belt to the cursor's braces and it is the half that survives a cursor
 *    that was lost, reset, or written by an older build: the same bytes always
 *    produce the same `media.add_asset:<hash>` id, the gateway's replay ledger
 *    short-circuits the duplicate, and `media.add_asset` DEDUPES on the content
 *    row besides. A member who screenshots the same image twice is two assets
 *    with two hashes and is meant to be; a roll re-walked is one.
 *
 * Keying on the local id instead would break in exactly the case that matters —
 * a restored phone, where every `PHAsset` identifier is new and the bytes are
 * the same, and the member would watch their whole library upload again.
 *
 * ## The transfer rule is the member's ONE setting
 *
 * [TransferRule], read through its own accessor. There is no second
 * switch for photographs: an original is the most expensive thing this product
 * moves, so if the member's answer about bytes did not govern it, the setting
 * would not mean anything. It is read **before each item and not once per
 * pass** (`NATIVE_V0.md:11-19`) — a phone that leaves Wi-Fi half way through a
 * roll stops there, mid-roll, with the cursor where it stopped.
 */
public class CameraRoll(
    private val services: PlatformServices,
    /** The open core, read at each use. See `ScreenRuntime`'s own note on this. */
    private val core: () -> CentraidCore?,
    /**
     * WHY THIS VAULT REFUSES WRITES, OR NULL (#1029 F1).
     *
     * A backup is a WRITE — every photograph it offers commits a
     * `media.add_asset` — so a vault that moved to the member's other phone
     * refuses one exactly as it refuses a note save. A supplier and not a flag
     * for the same reason [core] is one: a pass runs for minutes and a value
     * captured at construction would keep uploading into a vault frozen
     * halfway through it.
     */
    private val readOnly: () -> String? = { null },
) {
    /** What one pass did, and what the screen should now say. */
    public data class Report(
        /** Assets the platform handed this pass. */
        public val enumerated: Int = 0,
        /** Assets whose bytes reached the core and whose write is queued. */
        public val queued: Int = 0,
        /** Assets the core ALREADY held — a re-walk, and the cheap case. */
        public val alreadyHeld: Int = 0,
        /**
         * Assets the platform would not produce bytes for. NOT a failure: an
         * iCloud-only original with no network, one removed between the page
         * and the read, one outside a LIMITED selection.
         */
        public val skipped: Int = 0,
        public val bytes: Long = 0,
        /** Assets still ahead of the cursor, when the walk stopped early. */
        public val remaining: Int = 0,
        public val state: BackupState = BackupState(),
    )

    /**
     * ONE BOUNDED PASS over the roll.
     *
     * [limit] bounds the page AND the pass: a camera roll is tens of thousands
     * of items and a pass that walked all of them would be a pass no background
     * window ever finishes, reporting nothing until it did.
     *
     * Answers a [Report] rather than throwing. The only thing a member can do
     * about any of these outcomes is read a sentence, and a backup that took the
     * app down over one photograph Photos would not open is worse than every
     * failure it could be reporting.
     */
    public suspend fun pass(
        vaultId: String,
        limit: Int = PAGE,
        onState: (BackupState) -> Unit = {},
    ): Report {
        val permission = services.mediaLibrary.permission()
        if (!canEnumerate(permission)) {
            // THE GRID IS UNAFFECTED and the backup is idle. Two planes, two
            // permissions: a denied photo grant must never blank a library the
            // member already owns (`PhotosGridMachine`).
            val idle = BackupState(
                phase = BackupState.Phase.PHASE_IDLE,
                paused_reason = permissionSentence(permission),
            )
            onState(idle)
            return Report(state = idle)
        }

        // A FROZEN VAULT TAKES NO PHOTOGRAPHS (#1029 F1). IDLE and not parked:
        // parked is a device out of disk, which resumes when space is freed,
        // and this does not resume — the vault moved. The cursor is left where
        // it is, so a member who takes this vault back later resumes from the
        // photograph this pass stopped at rather than re-walking the roll.
        //
        // **BEFORE THE CORE IS ASKED FOR**, and the order is the sentence: a
        // frozen holding that is also RESTING has no handle, and reading the
        // core first would answer "No vault is open on this device" over a
        // vault the member is looking at. What happened is that it moved.
        readOnly()?.let { sentence ->
            val frozen = BackupState(
                phase = BackupState.Phase.PHASE_IDLE,
                paused_reason = sentence,
            )
            onState(frozen)
            return Report(state = frozen)
        }

        val handle = core() ?: return Report(
            state = BackupState(
                phase = BackupState.Phase.PHASE_IDLE,
                paused_reason = "No vault is open on this device.",
            ),
        ).also { onState(it.state) }

        onState(BackupState(phase = BackupState.Phase.PHASE_ENUMERATING))
        val cursor = services.secureStore.read(cursorKey(vaultId))
        val page = services.mediaLibrary.page(cursor, limit)
        if (page.assets.isEmpty()) {
            // NOTHING NEW IS "DONE", NOT "IDLE". A member whose roll is fully
            // backed up must be able to tell that from a backup that is off.
            val done = BackupState(phase = BackupState.Phase.PHASE_DONE)
            onState(done)
            return Report(state = done)
        }

        var queued = 0
        var held = 0
        var skipped = 0
        var moved = 0L
        var at = cursor
        for ((index, asset) in page.assets.withIndex()) {
            // BEFORE EACH ITEM, NOT ONCE PER PASS. See the class comment.
            val verdict = mayMove(services.networkStatus.current())
            if (verdict != null) {
                at?.let { services.secureStore.write(cursorKey(vaultId), it) }
                val waiting = BackupState(
                    phase = verdict,
                    assets_remaining = (page.assets.size - index),
                    assets_transferred_this_session = queued,
                    bytes_transferred_this_session = moved,
                    transport = BackupState.Transport.TRANSPORT_IROH_BLOBS,
                    paused_reason = waitingSentence(verdict),
                )
                onState(waiting)
                return Report(
                    enumerated = page.assets.size,
                    queued = queued,
                    alreadyHeld = held,
                    skipped = skipped,
                    bytes = moved,
                    remaining = page.assets.size - index,
                    state = waiting,
                )
            }

            when (val outcome = offer(handle, asset)) {
                is Offered.Skipped -> skipped += 1
                is Offered.Queued -> {
                    if (outcome.alreadyHeld) held += 1
                    queued += 1
                    moved += outcome.bytes
                }
                is Offered.Refused -> {
                    // ONE PHOTOGRAPH'S REFUSAL IS NOT THE PASS'S. The cursor is
                    // NOT advanced past it, so the next pass tries it again —
                    // a transient refusal (the core out of space, a stage the
                    // OS interrupted) must not silently cost a photograph.
                    val stopped = BackupState(
                        phase = BackupState.Phase.PHASE_PARKED_LOW_DISK,
                        assets_remaining = (page.assets.size - index),
                        assets_transferred_this_session = queued,
                        bytes_transferred_this_session = moved,
                        transport = BackupState.Transport.TRANSPORT_IROH_BLOBS,
                        paused_reason = outcome.sentence,
                    )
                    at?.let { services.secureStore.write(cursorKey(vaultId), it) }
                    onState(stopped)
                    return Report(
                        enumerated = page.assets.size,
                        queued = queued,
                        alreadyHeld = held,
                        skipped = skipped,
                        bytes = moved,
                        remaining = page.assets.size - index,
                        state = stopped,
                    )
                }
            }
            // ADVANCED PER ASSET. A pass the OS kills resumes where it was.
            at = cursorAfter(page, index) ?: at
            at?.let { services.secureStore.write(cursorKey(vaultId), it) }
            onState(
                BackupState(
                    phase = BackupState.Phase.PHASE_TRANSFERRING,
                    assets_remaining = (page.assets.size - index - 1),
                    assets_transferred_this_session = queued,
                    bytes_transferred_this_session = moved,
                    transport = BackupState.Transport.TRANSPORT_IROH_BLOBS,
                ),
            )
        }

        val finished = BackupState(
            phase = if (page.nextCursor == null) {
                BackupState.Phase.PHASE_DONE
            } else {
                BackupState.Phase.PHASE_TRANSFERRING
            },
            assets_transferred_this_session = queued,
            bytes_transferred_this_session = moved,
            transport = BackupState.Transport.TRANSPORT_IROH_BLOBS,
            // LIMITED IS SAID EVEN WHEN IT IS WORKING. A member who granted a
            // selection must be able to see that the other photographs are not
            // missing by accident.
            paused_reason = permissionSentence(permission),
        )
        onState(finished)
        return Report(
            enumerated = page.assets.size,
            queued = queued,
            alreadyHeld = held,
            skipped = skipped,
            bytes = moved,
            state = finished,
        )
    }

    private sealed interface Offered {
        data object Skipped : Offered

        data class Queued(val alreadyHeld: Boolean, val bytes: Long) : Offered

        data class Refused(val sentence: String) : Offered
    }

    /**
     * One photograph: open it, stage it, queue the write that claims it.
     *
     * `close()` is in a `finally` and is owed on every path, the refusals
     * included: an abandoned `PHAssetResourceManager` request holds a Photos
     * queue for the life of the process, and an abandoned Android descriptor is
     * a file handle.
     */
    private suspend fun offer(handle: CentraidCore, asset: MediaLibrary.Asset): Offered {
        val original = services.mediaLibrary.open(asset.localId) ?: return Offered.Skipped
        val staged = try {
            Staging.stage(
                core = handle,
                mediaType = original.mediaType,
                byteSize = original.bytes,
                read = original::read,
            )
        } catch (why: IllegalStateException) {
            // A STREAM THAT FAILED MID-WAY IS A REFUSAL, NOT A SHORT FILE.
            // `MediaLibrary.Original.read` throws rather than ending quietly for
            // exactly this reason — a truncated original staged as if it were
            // whole would be committed, under the truncation's own hash, as the
            // member's photograph.
            return Offered.Refused(
                why.message ?: "Centraid could not read that photograph.",
            )
        } finally {
            original.close()
        }
        return when (staged) {
            is Staging.Outcome.No -> Offered.Refused(staged.refused.sentence)
            is Staging.Outcome.Ok -> {
                val hash = staged.staged.contentHash
                val answer = handle.call(
                    Envelope(
                        request = Request(
                            command = Command(
                                name = ACTION,
                                // THE HASH IS THE INVOKE KEY. See the class
                                // comment on why it is not the local
                                // identifier. It was `Intent.intent_id` and it
                                // does the same job: the same photograph
                                // re-offered is the same key, so the re-walk
                                // that follows a reinstall commits once.
                                invoke_key = "$ACTION:$hash",
                                input = inputFor(asset, hash).encodeUtf8(),
                                // NO `needs` AND NO `online_only` (#1029 §1).
                                // `NeededBytes` was the declaration a GATEWAY
                                // pulled the bytes on, and `online_only` was
                                // the flag that forbade the outbox. There is no
                                // gateway and no outbox: the bytes are already
                                // staged in THIS vault's own store by the call
                                // above, and the command commits the row beside
                                // them.
                            ),
                        ),
                    ),
                )
                when (answer) {
                    is CoreOutcome.Failed -> Offered.Refused(
                        answer.failure.sentence.ifEmpty {
                            "Centraid could not queue that photograph."
                        },
                    )
                    is CoreOutcome.Answered -> Offered.Queued(
                        alreadyHeld = staged.staged.alreadyHeld,
                        bytes = staged.staged.byteSize,
                    )
                }
            }
        }
    }

    /**
     * `media.add_asset`'s input, hand-spelled.
     *
     * **`source_asset_id` IS NOT THE PHONE'S LOCAL IDENTIFIER** and the local
     * identifier is deliberately not sent at all. The column is an FK to
     * `media_asset(asset_id)` and it means EDIT LINEAGE (#711) — "this asset was
     * cropped out of that one" — so a `PHAsset` identifier there would be a
     * dangling foreign key wearing a field's name. There is no column anywhere
     * in `media_asset` for a device's own id for a photograph, which is why the
     * durable cursor and the content-hash intent id, both of which live on the
     * phone, are what keep a re-walk from re-uploading.
     *
     * **`phash` is not sent either.** It is a duplicates hint, the gateway
     * derives one at commit from bytes it now holds (D-1025-S7-50), and a phone
     * computing one would be decoding every original to produce a second
     * opinion about a value that never merges anything.
     *
     * Hand-spelled rather than serialised: the input is the HASH PREIMAGE, so it
     * has to be the exact bytes the gateway rehashes, and a JSON library's key
     * order is not something this layer may leave to a dependency.
     */
    internal fun inputFor(asset: MediaLibrary.Asset, hash: String): String = buildString {
        append("{\"staged_sha\":\"").append(hash).append('"')
        append(",\"kind\":\"").append(asset.kind.wire).append('"')
        if (asset.capturedAtIso.isNotEmpty()) {
            append(",\"captured_at\":\"").append(asset.capturedAtIso).append('"')
        }
        append(",\"tz_offset_min\":").append(asset.capturedUtcOffsetMinutes)
        asset.captureGroupId?.let {
            append(",\"capture_group_id\":\"").append(it).append('"')
        }
        append('}')
    }

    /**
     * The cursor to write once the asset at [index] is queued.
     *
     * The page's OWN `nextCursor` is only correct at the end of the page, so
     * mid-page this is the platform's cursor for the asset just done — which
     * `MediaLibrary.page` defines as "everything up to and including this has
     * been offered". A page whose last asset is done takes `nextCursor`,
     * because that is the one the platform minted and the one that says whether
     * the roll is exhausted.
     */
    internal fun cursorAfter(page: MediaLibrary.Page, index: Int): String? =
        if (index == page.assets.lastIndex) page.nextCursor else null

    /**
     * MAY AN ORIGINAL MOVE ON THIS LINK RIGHT NOW? Null means yes.
     *
     * The member's one setting, against the platform's real answer. A refused
     * platform reading counts as expensive, matching the deleted window policy's
     * asymmetry: a guess wrong towards cheap spends a data plan, a guess wrong
     * towards expensive delays a photograph.
     */
    internal suspend fun mayMove(reading: NetworkStatus.Reading): BackupState.Phase? {
        val expensive = reading.metered || reading.platformRefused
        return when (TransferRule.read(services.secureStore)) {
            // THE UPLOAD OBEYS THE SAME RULE AS THE DOWNLOAD (#1025 S4). A
            // member who set this phone not to fetch full-size photographs on
            // its own did not thereby ask it to PUSH them on any link, and one
            // sentence in a sheet governing one direction would be a sheet
            // that lies by omission.
            TransferRule.MANUAL -> BackupState.Phase.PHASE_WAITING_FOR_UNMETERED
            TransferRule.WIFI_ONLY ->
                if (expensive) BackupState.Phase.PHASE_WAITING_FOR_UNMETERED else null
            // A PHOTOGRAPH ON CELLULAR, AND A VIDEO NOT — the fixed rule, on
            // the way up as well. `crates/blobs` applies it on the way down;
            // this walk has no tier to plan over, so the one distinction it
            // can draw is the asset's own kind.
            TransferRule.WIFI_AND_CELLULAR_PHOTOS -> null
        }
    }

    private fun waitingSentence(phase: BackupState.Phase): String = when (phase) {
        BackupState.Phase.PHASE_WAITING_FOR_UNMETERED ->
            "Centraid backs these up on Wi-Fi."
        BackupState.Phase.PHASE_WAITING_FOR_POWER ->
            "Centraid backs these up when this phone is charging."
        else -> ""
    }

    /**
     * WHAT THE GRANT MEANS, IN WORDS, AND NEVER A MEMBER'S FAULT.
     *
     * The same four sentences `PhotosGridMachine` already words, kept identical
     * here rather than reworded: a pass and a reducer telling a member two
     * different things about one grant is the defect this duplication is
     * checked against in `CameraRollSpec`.
     */
    internal fun permissionSentence(permission: MediaPermission): String = when (permission) {
        MediaPermission.MEDIA_PERMISSION_GRANTED -> ""
        MediaPermission.MEDIA_PERMISSION_LIMITED ->
            "Centraid backs up the photos you selected."
        MediaPermission.MEDIA_PERMISSION_NOT_ASKED ->
            "Centraid needs access to your photos to back them up."
        MediaPermission.MEDIA_PERMISSION_DENIED ->
            "Photo access is off. Turn it on in Settings to back up your camera roll."
        MediaPermission.MEDIA_PERMISSION_RESTRICTED ->
            "This device does not allow photo access."
        MediaPermission.MEDIA_PERMISSION_UNSPECIFIED -> ""
    }

    internal fun canEnumerate(permission: MediaPermission): Boolean =
        permission == MediaPermission.MEDIA_PERMISSION_GRANTED ||
            // LIMITED COUNTS. A selection is a real library the member chose.
            permission == MediaPermission.MEDIA_PERMISSION_LIMITED

    public companion object {
        internal const val APP: String = "media"
        internal const val ACTION: String = "media.add_asset"

        /**
         * One page, and one pass.
         *
         * Small because each item is an ORIGINAL — tens of megabytes, sometimes
         * hundreds — and a background window that iOS ends after thirty seconds
         * will not finish more. The cursor is what makes a small page cost
         * nothing: the next pass starts where this one stopped.
         */
        public const val PAGE: Int = 25

        /**
         * PER VAULT, because a photograph offered to two vaults is two uploads
         * and two rows (`docs/mobile-offline.md:175`) — so a device that holds
         * two vaults walks the roll once for each and each walk has its own
         * place in it.
         *
         * It is in [SecureStore] because that is the only durable key-value this
         * seam has, and [TransferRule] already keeps a non-secret there
         * for the same reason. A cursor is not a secret; what it is is
         * small, per-device, and required to survive a relaunch, and the
         * Keychain's `ThisDeviceOnly` accessibility gives it the right
         * lifetime — a restored phone finds no cursor, walks the roll again,
         * and the content-hash intent id makes that walk queue nothing.
         */
        public fun cursorKey(vaultId: String): String = "camera-roll.cursor.$vaultId"
    }
}
