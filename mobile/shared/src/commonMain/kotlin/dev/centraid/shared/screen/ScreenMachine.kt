package dev.centraid.shared.screen

import centraid.screen.v1.ReadFailure
import centraid.screen.v1.ReadFailureKind
import centraid.screen.v1.SeatState

/**
 * A screen is one pure function (#1020, D-1020-E3).
 *
 * `(state, event) -> (state, effects)`. No coroutines, no clock, no I/O, no
 * platform import — which is what makes every screen testable on the JVM and
 * what keeps `commonMain` inside the Konsist rule.
 *
 * **Effects are DATA, never closures.** A closure survives neither a
 * Kotlin/Native boundary nor a test that wants to assert what a screen decided
 * to do, and the same shape is what `centraid.core.v1.PageQuery` chose for the
 * same reason: "a read as DATA, never as a string or a closure".
 */
public interface ScreenMachine<S, E> {
    public fun reduce(state: S, event: E): Step<S>

    /** The state a screen is in before its first event. */
    public fun initial(): S

    /**
     * A ROW MOVED IN THE VAULT. What does this screen make of it?
     * (#1025 S5, D-1025-S5-3.)
     *
     * The core's change stream (`next_event`) says `(table, keys)` and nothing
     * else — it never carries values, which is what makes coalescing lossless
     * in `crates/core`'s event queue. So each screen turns that into its OWN
     * event, here, and `null` means "not mine": a table this screen does not
     * read, or keys it is not showing.
     *
     * **`commitSeq` IS GONE** (#1029 §1). It was the position a SEAT's overlay
     * settled against — `ChangeEvent`'s commit-seq field, allocated by
     * `replica_meta` in the log plane — and no machine ever read it: every one of
     * the four named it and none of them used it, because a screen re-reads its
     * own page and has nothing to compare a commit number to. The overlay, the
     * log plane and `replica_meta` are deleted; the field stays on the wire for
     * a moment longer because `crates/api-proto` is another lane's, and it
     * leaves with its producers there.
     *
     * **One declaration and not two.** The first draft of this had a `tables`
     * set beside a translator, and the two are a pair that can disagree — a
     * screen that adds a read and forgets the set stops moving on sync, with
     * nothing red anywhere. There is one member, so there is one thing to get
     * right.
     *
     * The pk_set is `String` keys and not a typed row id because a change event
     * is about a TABLE: the core has no idea which of a screen's ids a primary
     * key is, and a screen that cannot recognise its own ids in a list of
     * strings has a bigger problem than this signature.
     */
    public fun rowsChanged(table: String, keys: List<String>): E?

    /**
     * WHAT THIS SEAT CAN SAY ABOUT ITSELF, CHANGED (#1025 S5, D-1025-S5-6).
     *
     * Every screen's event already has a `SeatChanged` case and every machine
     * already reduces it — and for two waves **nothing in the product ever sent
     * one**, so `SeatState` was null on every screen for ever. What it decided
     * then was the write gate, and that gate is gone with the gateway it was
     * choosing between (#1029 §1). What is left is what a screen RENDERS:
     * availability, durability and the radio, which are still four facts a
     * member reads off a screen.
     *
     * `null` from a machine means the screen does not render the seat, which is
     * a real answer — Home draws its own status line and needs no seat.
     */
    public fun seatChanged(seat: SeatState): E?

    /**
     * A [ScreenEffect.Schedule] CAME DUE: this screen's own event for [token],
     * or null for a screen that schedules nothing (the kit's autosave debounce).
     *
     * A reducer has no clock, so a delay is an effect the runtime serves and
     * its expiry is an event the machine names here. A default, because most
     * screens never schedule and a stub on each would say nothing.
     */
    public fun ticked(token: String): E? = null

    /**
     * THE SCREEN IS CLOSING: this screen's own event, or null.
     *
     * The bridge's `leave()` sends it BEFORE it releases its scope, so an
     * editor's unsaved words are submitted on close (#1015 D3: close = done).
     * The write runs on the session's scope, so releasing the bridge does not
     * cancel it.
     */
    public fun left(): E? = null
}

public data class Step<S>(val state: S, val effects: List<ScreenEffect> = emptyList())

/**
 * What a screen asked the shell to do.
 *
 * The shell's effect runner is the only thing that touches `CentraidCore`, so
 * the reducers never see a handle, a dispatcher or a suspend function.
 */
public sealed interface ScreenEffect {
    /**
     * Read one page. `afterCursor` is the keyset cursor, never an offset — and
     * `null` means the first page rather than "start from zero", which for a
     * pruned feed is a different request.
     */
    public data class ReadPage(
        public val screenId: String,
        public val afterCursor: String?,
    ) : ScreenEffect

    /**
     * WAKE THIS SCREEN LATER. A reducer is pure and has no clock, so a delay is
     * data: the runtime serving [screenId] waits [delayMs] and sends the
     * machine's [ScreenMachine.ticked] event for [token]. A later schedule does
     * not cancel an earlier one; the machine drops a token it has moved past,
     * which is what makes the debounce a pure function.
     */
    public data class Schedule(
        public val screenId: String,
        public val token: String,
        public val delayMs: Long,
    ) : ScreenEffect

    /** Ask the OS. The answer arrives as an event, because it is a state. */
    public data object RequestMediaPermission : ScreenEffect

    /**
     * Submit a write.
     *
     * **`onlineOnly` LEFT WITH THE OUTBOX IT FORBADE** (#1029 §1). The flag
     * meant "a gateway this device cannot reach is a FAILURE, not a delay",
     * and it was read by `WriteGate` to refuse rather than enqueue. The phone
     * is the vault: a write commits here or it does not, there is no outbox to
     * fall back to, and a flag forbidding a fallback that cannot happen is a
     * field every caller has to fill in and nothing reads.
     */
    public data class SubmitWrite(
        public val command: String,
        public val inputJson: String,
        public val invokeKey: String,
    ) : ScreenEffect

    /**
     * Tell the member a verb is WITHHELD rather than queued.
     *
     * Tally's `materialize-recurring-expense` is the case: its occurrence id is
     * minted by the canonical engine, so a seat withholds it offline rather
     * than queueing a copy (`docs/mobile-offline.md:257`).
     */
    public data class WithheldOffline(
        public val verb: String,
        public val sentence: String,
    ) : ScreenEffect

    /** Start, pause or resume the camera-roll backup. */
    public data class Backup(public val action: Action) : ScreenEffect {
        public enum class Action { START, PAUSE, RESUME }
    }

    /**
     * RE-POINT THE WHOLE APP AT ANOTHER VAULT.
     *
     * An effect and not a reduce, because switching is closing one core and
     * opening another — I/O that can fail, on a file the reducer has never
     * seen. The machine names the vault by id and nothing else; which file that
     * is, and whether it opens, belongs to the session that owns the core.
     *
     * It carries no path for the same reason `VaultLockup` does not: a screen
     * effect with a filesystem in it is a screen effect one shell can serve and
     * the other cannot.
     */
    public data class SwitchVault(public val vaultId: String) : ScreenEffect

    /**
     * FETCH ONE ORIGINAL THE MEMBER TAPPED (#1025 S5, D-1025-S7-63).
     *
     * WhatsApp's download arrow. An effect and not a write: it commits
     * nothing.
     *
     * **WHAT SERVES IT, AND WHAT IS STILL MISSING** (#1029 §1, W6).
     *
     * It rode `seat.bytes.fetch`, which left with the seat plane —
     * `grep -rn 'seat.bytes.fetch' crates/` is empty — so `ScreenRuntime` has
     * not answered it since. W6 built the two halves under it and NOT the hop
     * between them, and the honest state is worth writing down rather than
     * discovering:
     *
     * - the vault knows where the original is and holds the key that opens it
     *   (`backup_blob_placement`, `backup::custody::open_blob`);
     * - the member's transfer rule decides whether this window may ask for it,
     *   and a tap overrides the rule for that one item
     *   (`centraid_blobs::plan::wants_from_custody`, `Budget::only`);
     * - **there is no core request that carries the tap.** `Request` has no
     *   `fetch_original` arm, so a shell has nothing to send. Adding one means
     *   a proto field, a handler, and a gateway transport inside
     *   `crates/core` — which is a layering decision for the umbrella and not
     *   one to take while wiring a screen.
     *
     * The affordance and this effect are kept rather than deleted because that
     * remaining hop is a wire, not a design.
     */
    public data class FetchOriginal(
        public val screenId: String,
        public val assetId: String,
        public val contentHash: String,
    ) : ScreenEffect

    /**
     * RENDER AN EDIT AND KEEP IT AS A NEW PHOTOGRAPH (#1029, photos port; v0's
     * `photo-edit-save.ts`).
     *
     * An effect and not a write, because the write cannot be composed yet:
     * `media.add_asset` names STAGED BYTES, and the bytes do not exist until a
     * platform has decoded the original and drawn the plan onto it — CoreImage
     * on one shell, `Bitmap` and `Matrix` on the other. The reducer states the
     * intent; the shell renders, stages and commits, and answers with the
     * screen's own settle event.
     *
     * [key] is CONTENT-DERIVED — the asset and the plan — so a settle that
     * arrives for a plan the member has since changed is recognisably stale.
     * [plan] is an encoded `PhotoEditPlan`: Swift decodes it with
     * SwiftProtobuf, and a Wire object would not cross.
     *
     * [capturedAt], [tzOffsetMinutes] and [placeId] are the ORIGINAL's: an
     * edit keeps the date and the place of the photograph it was made from, as
     * Apple Photos does. Empty or null means the original records none, and
     * none is written.
     */
    public data class RenderEdit(
        public val screenId: String,
        public val key: String,
        public val sourceAssetId: String,
        public val sourcePath: String,
        public val title: String,
        public val capturedAt: String,
        public val tzOffsetMinutes: Int?,
        public val placeId: String,
        public val plan: okio.ByteString,
    ) : ScreenEffect
}

/**
 * The three-state read law, in one place (census §E seam 3).
 *
 * Every screen's `content` oneof has exactly these three shapes, and the
 * helpers below are how a reducer moves between them without ever producing the
 * fourth one — an empty data case standing in for a failure.
 */
public object Reads {
    /** A refusal from the access plane: its sentence, never its predicate. */
    public fun refused(sentence: String): ReadFailure = ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_REFUSED,
        sentence = sentence,
    )

    /** This seat has no copy yet. A first sync, not a refusal. */
    public fun noCopyYet(): ReadFailure = ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_NO_COPY_YET,
        sentence = "This device has not copied these yet.",
        remedy = "Stay on Wi-Fi while Centraid catches up.",
    )

    /**
     * Out of disk: the feed is PARKED. The cursor and the rows stay, the retry
     * cadence stops, and freeing space resumes from the durable cursor
     * (`docs/mobile-offline.md:238`). Centraid never evicts canonical rows or
     * queued writes to manufacture space.
     */
    public fun lowDiskParked(): ReadFailure = ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_LOW_DISK_PARKED,
        sentence = "This device is out of space, so Centraid has paused.",
        remedy = "Free up space and Centraid picks up where it stopped.",
    )

    public fun unavailable(sentence: String): ReadFailure = ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_UNAVAILABLE,
        sentence = sentence,
        remedy = "Centraid tries again when it can reach your gateway.",
    )

    public fun coreRestarted(): ReadFailure = ReadFailure(
        kind = ReadFailureKind.READ_FAILURE_KIND_CORE_RESTARTED,
        sentence = "Centraid hit a problem and restarted.",
    )

    /**
     * Is the feed parked? A parked feed emits NO re-read effect: a retry loop
     * that keeps re-applying the failing batch is the regression the device
     * contract test already pins (census §E seam 8).
     */
    public fun isParked(failure: ReadFailure?): Boolean =
        failure?.kind == ReadFailureKind.READ_FAILURE_KIND_LOW_DISK_PARKED

    /** Is this seat writing to its own outbox rather than to the gateway? */
    public fun isLocalOnly(seat: SeatState?): Boolean =
        seat?.durability != SeatState.Durability.DURABILITY_AUTHORITATIVE
}
