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
 * THE CAMERA ROLL, GOING IN (#1025 S6, D-1025-S7-73; #1080, the walker).
 *
 * The half of the product that turns a photograph on a phone into a row in a
 * vault and a sealed part in its spool.
 *
 * ## The shape, and why each step is where it is
 *
 * ```
 *   page(cursor)  ->  open(ref)       ->  Staging.stage   ->  media.add_asset
 *   the platform      the platform        THE CORE NAMES      THIS VAULT
 *   enumerates        streams bytes       AND SEALS THEM      COMMITS THE ROW
 * ```
 *
 * **The phone never computes an identity.** `Staging` exists because the vault's
 * identity is BLAKE3 and no phone SDK offers it (D-1025-S4-6); this class
 * therefore stages first and reads the hash off the core's answer, and the
 * `media.add_asset` it then commits NAMES that hash rather than asserting one.
 *
 * **NO SECOND COPY** (#1080 ruling 6). Every resource is staged with
 * `source = OS_LIBRARY` and its `os_ref`: the core hashes the bytes and, when a
 * gateway is paired and the spool has room, seals them in the same stream,
 * and keeps no plaintext copy — the library already holds one. When the spool
 * had no room the core asks for the bytes again later (`DrainResponse.need_bytes`,
 * `LibraryFeed`), which is why a ref must find the same bytes after a relaunch
 * and why the ORIGINAL is the camera's and never an edit's render.
 *
 * **The platform renders the derivatives.** The core cannot decode HEIC and
 * keeps no library original to decode later, so after an original is staged
 * the walker asks [MediaLibrary.render] for the thumbnail and the preview —
 * drawn from the current edit — and stages each with `for_hash` and `tier`.
 *
 * **A Live Photo is one asset with two resources**: the still is committed as
 * a `photo` row and its movie as a `video` row in the same capture group.
 *
 * ## Idempotence, twice over, because once is not enough
 *
 * 1. **The durable cursor** ([cursorKey]) is what makes a RE-ENUMERATION queue
 *    nothing. It is advanced after each asset ([MediaLibrary.Asset.after]), so
 *    a pass the OS kills half way resumes at the photograph it was on rather
 *    than at the one it started from.
 * 2. **The invoke key is the CONTENT HASH** and not the asset's local id. The
 *    same bytes always produce the same key, the core's own replay ledger
 *    short-circuits the duplicate, and `media.add_asset` DEDUPES on the
 *    content row besides. It never leaves this device (#1029 §4).
 *
 * Keying on the local id instead would break in exactly the case that matters —
 * a restored phone, where every `PHAsset` identifier is new and the bytes are
 * the same, and the member would watch their whole library upload again.
 *
 * ## The link governs downloads only
 *
 * Staging is LOCAL: it reads the library and writes this phone's spool, and
 * the pass never waits for Wi-Fi to do it. What crosses a link is the
 * gateway's upload, which the core plans under the member's rule
 * (`DrainRequest.rule`), and — here — an original that lives only in iCloud,
 * which is downloaded only when the rule lets it cross the link the phone is
 * on ([mayFetch]). One that may not is [Opened.InCloud]: the walk stops at it,
 * with the cursor before it, and says so.
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
     * captured at construction would keep importing into a vault frozen
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
         * Assets the platform would not produce bytes for. NOT a failure: one
         * removed between the page and the read, one outside a LIMITED
         * selection.
         */
        public val skipped: Int = 0,
        public val bytes: Long = 0,
        /** Assets still ahead of the cursor, when the walk stopped early. */
        public val remaining: Int = 0,
        /** The walk stopped at an original only in iCloud that it may not download now. */
        public val waitingInCloud: Int = 0,
        public val state: BackupState = BackupState(),
    )

    /**
     * ONE BOUNDED PASS over the roll.
     *
     * [limit] bounds the page AND the pass: a camera roll is tens of thousands
     * of items and a pass that walked all of them would be a pass no window
     * ever finishes, reporting nothing until it did.
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
        val key = cursorKey(vaultId)
        val cursor = services.secureStore.read(key)
        val page = services.mediaLibrary.page(cursor, limit)
        if (page.assets.isEmpty()) {
            // A PLATFORM MAY MOVE THE CURSOR WITH NOTHING TO OFFER — iOS trades
            // a finished first walk for a change token — and it is kept.
            page.nextCursor?.takeIf { it != cursor }?.let { services.secureStore.write(key, it) }
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
        for ((index, asset) in page.assets.withIndex()) {
            val left = page.assets.size - index
            when (val outcome = offer(handle, asset)) {
                is Offered.Skipped -> skipped += 1
                is Offered.Queued -> {
                    if (outcome.alreadyHeld) held += 1
                    queued += 1
                    moved += outcome.bytes
                }
                is Offered.InCloud -> {
                    // THE CURSOR STAYS BEFORE IT: a keyset cannot skip one asset
                    // and come back, so the walk waits here for a link the rule
                    // lets the download cross, and resumes on this photograph.
                    val waiting = BackupState(
                        phase = BackupState.Phase.PHASE_WAITING_FOR_UNMETERED,
                        assets_remaining = left,
                        assets_transferred_this_session = queued,
                        bytes_transferred_this_session = moved,
                        paused_reason = IN_CLOUD_SENTENCE,
                    )
                    onState(waiting)
                    return Report(
                        enumerated = page.assets.size,
                        queued = queued,
                        alreadyHeld = held,
                        skipped = skipped,
                        bytes = moved,
                        remaining = left,
                        waitingInCloud = 1,
                        state = waiting,
                    )
                }
                is Offered.Refused -> {
                    // ONE PHOTOGRAPH'S REFUSAL IS NOT THE PASS'S. The cursor is
                    // NOT advanced past it, so the next pass tries it again —
                    // a transient refusal (the core out of space, a stage the
                    // OS interrupted) must not silently cost a photograph.
                    val stopped = BackupState(
                        phase = BackupState.Phase.PHASE_PARKED_LOW_DISK,
                        assets_remaining = left,
                        assets_transferred_this_session = queued,
                        bytes_transferred_this_session = moved,
                        paused_reason = outcome.sentence,
                    )
                    onState(stopped)
                    return Report(
                        enumerated = page.assets.size,
                        queued = queued,
                        alreadyHeld = held,
                        skipped = skipped,
                        bytes = moved,
                        remaining = left,
                        state = stopped,
                    )
                }
            }
            // ADVANCED PER ASSET. A pass the OS kills resumes where it was.
            asset.after?.let { services.secureStore.write(key, it) }
            onState(
                BackupState(
                    phase = BackupState.Phase.PHASE_TRANSFERRING,
                    assets_remaining = left - 1,
                    assets_transferred_this_session = queued,
                    bytes_transferred_this_session = moved,
                ),
            )
        }
        // THE PAGE'S OWN CURSOR LAST: it is the one the platform minted, and on
        // iOS the one that turns a finished walk into a change token.
        page.nextCursor?.let { services.secureStore.write(key, it) }

        val finished = BackupState(
            phase = if (page.exhausted) BackupState.Phase.PHASE_DONE else BackupState.Phase.PHASE_TRANSFERRING,
            assets_transferred_this_session = queued,
            bytes_transferred_this_session = moved,
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

        data object InCloud : Offered

        data class Queued(val alreadyHeld: Boolean, val bytes: Long) : Offered

        data class Refused(val sentence: String) : Offered
    }

    /**
     * One asset: every resource streamed in and committed, then the
     * original's derivatives.
     *
     * An asset is offered WHOLE or not at all as far as the cursor is
     * concerned: a resource that has to wait for iCloud stops the walk on this
     * asset even when its still already landed, and the next pass re-offers
     * both — the still as `already_held`.
     */
    private suspend fun offer(handle: CentraidCore, asset: MediaLibrary.Asset): Offered {
        var queued: Offered.Queued? = null
        for (resource in asset.resources) {
            val original = resource.role == MediaLibrary.Resource.Role.ORIGINAL
            val kind = if (original) asset.kind else MediaLibrary.Kind.VIDEO
            // BEFORE EACH RESOURCE: a phone that leaves Wi-Fi half way through
            // a roll stops downloading from iCloud there.
            val allowNetwork = mayFetch(services.networkStatus.current(), kind)
            val opened = when (val answer = services.mediaLibrary.open(resource.ref, allowNetwork)) {
                is MediaLibrary.Opened.Ready -> answer.original
                MediaLibrary.Opened.InCloud -> return Offered.InCloud
                // A STILL THAT IS GONE IS THE ASSET GONE; a movie that is gone
                // costs the still nothing.
                MediaLibrary.Opened.Gone -> if (original) return Offered.Skipped else continue
            }
            val staged = try {
                Staging.stage(
                    core = handle,
                    mediaType = opened.mediaType,
                    byteSize = opened.bytes,
                    source = Staging.Source.OS_LIBRARY,
                    osRef = resource.ref,
                    read = opened::read,
                )
            } catch (why: IllegalStateException) {
                // A STREAM THAT FAILED MID-WAY IS A REFUSAL, NOT A SHORT FILE.
                // `MediaLibrary.Original.read` throws rather than ending quietly
                // for exactly this reason — a truncated original staged as if
                // it were whole would be committed, under the truncation's own
                // hash, as the member's photograph.
                return Offered.Refused(why.message ?: "Centraid could not read that photograph.")
            } finally {
                opened.close()
            }
            val ok = when (staged) {
                is Staging.Outcome.No -> return Offered.Refused(staged.refused.sentence)
                is Staging.Outcome.Ok -> staged.staged
            }
            commit(handle, inputFor(asset, ok.contentHash, kind), ok.contentHash)?.let { return it }
            if (original) {
                // A RE-WALK RENDERS NOTHING: the core already holds this
                // original, and its derivatives went in with it the first time.
                if (!ok.alreadyHeld) derivatives(handle, resource.ref, ok.contentHash)
                queued = Offered.Queued(alreadyHeld = ok.alreadyHeld, bytes = ok.byteSize)
            } else {
                queued = queued?.let { it.copy(bytes = it.bytes + ok.byteSize) }
            }
        }
        return queued ?: Offered.Skipped
    }

    /** `media.add_asset` for one staged resource; a refusal, or null when it was queued. */
    private suspend fun commit(handle: CentraidCore, input: String, hash: String): Offered.Refused? {
        val answer = handle.call(
            Envelope(
                request = Request(
                    command = Command(
                        name = ACTION,
                        // THE HASH IS THE INVOKE KEY. See the class comment on
                        // why it is not the local identifier: the same
                        // photograph re-offered is the same key, so the re-walk
                        // that follows a reinstall commits once.
                        invoke_key = "$ACTION:$hash",
                        input = input.encodeUtf8(),
                    ),
                ),
            ),
        )
        return when (answer) {
            is CoreOutcome.Failed -> Offered.Refused(
                answer.failure.sentence.ifEmpty { "Centraid could not queue that photograph." },
            )
            is CoreOutcome.Answered -> null
        }
    }

    /**
     * The thumbnail and the preview of one original, as the platform drew
     * them, staged against its content hash. **A derivative that fails costs
     * nothing but itself**: the original is committed already, and the grid
     * falls back to it.
     */
    private suspend fun derivatives(handle: CentraidCore, ref: String, hash: String) {
        for (tier in MediaLibrary.Tier.entries) {
            val bytes = services.mediaLibrary.render(ref, tier) ?: continue
            var at = 0
            Staging.stage(
                core = handle,
                mediaType = DERIVATIVE_MEDIA_TYPE,
                byteSize = bytes.size.toLong(),
                forHash = hash,
                tier = tier.wire,
            ) { max ->
                val end = minOf(at + max, bytes.size)
                bytes.copyOfRange(at, end).also { at = end }
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
     * dangling foreign key wearing a field's name. The library's own reference
     * travels on the stage door as `os_ref`, where the core keeps it beside
     * the bytes it names and nowhere a row is read.
     *
     * **`phash` is not sent either.** It is a duplicates hint, and a phone
     * computing one would be decoding every original to produce a second
     * opinion about a value that never merges anything.
     *
     * Hand-spelled rather than serialised: the input is the HASH PREIMAGE, so it
     * has to be the exact bytes the core rehashes, and a JSON library's key
     * order is not something this layer may leave to a dependency.
     */
    internal fun inputFor(asset: MediaLibrary.Asset, hash: String, kind: MediaLibrary.Kind = asset.kind): String =
        buildString {
            append("{\"staged_sha\":\"").append(hash).append('"')
            append(",\"kind\":\"").append(kind.wire).append('"')
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
     * MAY THIS PASS DOWNLOAD AN ORIGINAL THAT LIVES ONLY IN iCLOUD? (#1080)
     *
     * The member's one setting, against the platform's real answer, read
     * before each resource. A refused platform reading counts as expensive: a
     * guess wrong towards cheap spends a data plan, a guess wrong towards
     * expensive delays a photograph. A video never crosses a metered link,
     * whatever the rule, and under MANUAL what a backup needs waits for Wi-Fi
     * as under WIFI_ONLY (R-1080-D7).
     */
    internal suspend fun mayFetch(reading: NetworkStatus.Reading, kind: MediaLibrary.Kind): Boolean {
        if (!reading.online) return false
        val expensive = reading.metered || reading.platformRefused
        if (!expensive) return true
        return when (TransferRule.read(services.secureStore)) {
            TransferRule.WIFI_AND_CELLULAR_PHOTOS -> kind == MediaLibrary.Kind.PHOTO
            TransferRule.WIFI_ONLY, TransferRule.MANUAL -> false
        }
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
            "Centraid imports the photos you selected."
        MediaPermission.MEDIA_PERMISSION_NOT_ASKED ->
            "Centraid needs access to your photos to back them up."
        MediaPermission.MEDIA_PERMISSION_DENIED ->
            "Photo access is off. Turn it on in Settings to import your camera roll."
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

        /** `crates/media/src/renditions.rs`' `DERIVATIVE_MEDIA_TYPE`. */
        internal const val DERIVATIVE_MEDIA_TYPE: String = "image/jpeg"

        /** Why the walk is waiting on an original it may not download now. */
        public const val IN_CLOUD_SENTENCE: String =
            "Some originals are only in iCloud. Centraid fetches them on Wi-Fi."

        /**
         * One page, and one pass.
         *
         * Small because each item is an ORIGINAL — tens of megabytes, sometimes
         * hundreds — and a window will not finish more. The cursor is what
         * makes a small page cost nothing: the next pass starts where this one
         * stopped.
         */
        public const val PAGE: Int = 25

        /**
         * PER VAULT, because a photograph offered to two vaults is two imports
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
         * and the content-hash invoke key makes that walk queue nothing.
         */
        public fun cursorKey(vaultId: String): String = "camera-roll.cursor.$vaultId"
    }
}
