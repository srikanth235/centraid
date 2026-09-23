package dev.centraid.shared.shell

import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.platform.PlatformServices
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okio.FileSystem
import okio.Path
import okio.Path.Companion.toPath

/**
 * EVERY VAULT THIS DEVICE HOLDS, AND THE ONE OBJECT THAT ADDS OR REMOVES ONE
 * (#1025 S7-9, reshaped by #1029 §1).
 *
 * ## THE PHONE IS THE VAULT
 *
 * This class used to be the phone's half of a pairing: [admit] redeemed a
 * ticket against a gateway, the gateway named a vault, the copy came down as a
 * bootstrap, a per-vault endpoint identity was minted and kept, and the file a
 * member's rows lived in was a REPLICA of an authority somewhere else. #1029
 * deletes that whole plane. There is no gateway to pair with, no ticket to
 * redeem, no endpoint to enrol and no copy to take: **a vault is a file on this
 * phone, and this is the set of them.**
 *
 * What is left is smaller and says the same thing it always said. The shelf
 * holds [Holding]s — a vault id, the file it lives in, what it is called, and
 * its OPEN CORE — and [found] and [forget] are the only things that add or
 * remove one. Every membership change publishes [roster], so the switcher's
 * rows and the header's second line stay two renderings of one stream.
 *
 * ## ONE WAY TO OPEN A VAULT (#1029 §1)
 *
 * Every vault opens identically: the file, no role, and `create` false for one
 * that is already there. There is no `SEAT_REPLICATED`, no `GATEWAY` and no
 * enrolment record to open ON — `CoreConfiguration` carries a path and a
 * create flag, and `crates/core-ffi`'s `config_from_json` reads exactly those.
 * A `role` an older shell still sent is ignored rather than refused, which is
 * that crate's own note and the reason this could stop sending one on its own.
 *
 * ## A HELD VAULT'S CORE IS OPEN (#1025 S7-13, ruling F)
 *
 * Every holding's core is open — the file — from the moment it is founded or
 * the shelf launches, and it STAYS open. A switch is a pure rebind:
 * [HomeSession] points its runtime and change reader at the foreground
 * holding's core, and nothing is closed, nothing is reopened.
 *
 * `OPEN_CORES = 1` cited R-1020-24, and R-1020-24 is that **app extensions
 * never open the vault**: two handles on ONE FILE is the hazard, because that is
 * two writers for one vault. Two handles on two different files share nothing
 * and refusing them bought nothing. `SingleHandleGuard` is keyed on the vault
 * path and the rule it enforces is unchanged for the case it exists for.
 *
 * ### The only two things that close a background core
 *
 * 1. [forget], which is the member removing the vault.
 * 2. [rest], the OS asking for memory back — iOS's `didReceiveMemoryWarning`
 *    and Android's `onTrimMemory`. It closes every core but the foreground's; a
 *    rested holding reopens on the next touch.
 *
 * There is deliberately **no idle timeout**. If one is ever wanted, the shape is
 * a per-vault timer on the [Holding] — not a global number of cores — because
 * "how many may be open" is a question about a device and every other question
 * here is about a vault.
 *
 * ## THE DIRECTORY IS THE ROSTER, AND A FILE NAME IS NOT AN IDENTITY
 *
 * Every vault this device holds is a `*.sqlite3` file in one directory, and
 * that is the whole index. There is no manifest beside them, for the reason
 * [VaultRoster] gives: a vault's name lives inside the vault, and an index
 * would be a second place it lives that nothing keeps true.
 *
 * **The vault id is no longer in the file name, and losing it from there is
 * what deleted `Replicas.settle`.** `centraid-replica-<vaultId>.sqlite3` existed
 * so the shelf could fetch a vault's ENROLMENT RECORD before opening the file,
 * and so a device could file a just-paired copy under the id the gateway had
 * just named. Neither exists now — there is no record, and no gateway names
 * anything — so a device that founds its own vault would have had to write the
 * file under a provisional name and rename it the moment the core answered. A
 * rename that can half-happen, to buy a fact the file itself already answers,
 * is the defect `Enrolments` was built to end. So the name is opaque, [identify]
 * asks each file what vault it is, and a file that will not say is not a
 * holding.
 *
 * Files written under the old spelling still open: the listing takes every
 * `.sqlite3` in the directory and asks it, rather than matching a prefix.
 * SQLite's `-wal` and `-shm` sidecars are excluded by the suffix.
 */
public class Shelf(
    /** Where every vault this device holds lives. */
    private val vaultDir: String,
    private val services: PlatformServices,
    private val dispatcher: CoroutineDispatcher,
    private val uiThreadName: String,
) {
    /** ONE VAULT, AS THIS DEVICE HOLDS IT. */
    public data class Holding(
        public val vaultId: String,
        /** The vault file. Resolving an id to a path is the shell's business. */
        public val path: String,
        /**
         * What to call it.
         *
         * Read out of the vault's own `core_vault.display_name` the moment
         * there is a file to read it from ([VaultRoster.identify]). A vault's
         * name lives inside the vault.
         */
        public val name: String,
        public val color: String = "",
        /**
         * THIS VAULT'S OPEN CORE, or null while the holding is RESTING
         * (#1025 S7-13, ruling F).
         *
         * A per-vault lifecycle and not a global number of open cores: "how
         * many may be open" is a question about a device, and every other
         * question on this class is about a vault. A holding rests only when
         * [rest] is called — the OS asking for memory back — and wakes on the
         * next touch.
         *
         * Compared by IDENTITY, which is what a data class does with a type
         * that has no `equals`, and which is the right comparison: a holding
         * whose core was replaced IS a different holding, and the roster
         * republishes.
         */
        public val core: CentraidCore? = null,
        /**
         * THIS VAULT MOVED TO ANOTHER PHONE (#1029 F1), or null.
         *
         * Set by [freeze] and never cleared here. See [Moved] and [freeze].
         */
        public val moved: Moved? = null,
    ) {
        /** Closed to give the OS its memory back, and reopened on next touch. */
        public val resting: Boolean get() = core == null

        /**
         * WRITES ARE REFUSED ON THIS VAULT, AND READS ARE NOT (#1029 F1).
         *
         * A frozen vault is fully readable. That is the whole shape of the
         * ruling: the member keeps everything they had, and what stops is
         * adding to a vault whose authority has moved to the phone they
         * restored onto.
         */
        public val readOnly: Boolean get() = moved != null

        /**
         * WHAT THE MEMBER IS OWED WHEN THEY TOUCH A FROZEN VAULT (#1029 F1).
         *
         * "N changes since <date>", and the number is the SPOOL THIS PHONE IS
         * STILL HOLDING — not a count of what is lost. Nothing was lost:
         * [freeze] deletes nothing and this device keeps every row it had. The
         * line exists so the member can see there is something here worth
         * carrying across rather than discovering it after they wipe the phone.
         *
         * The DATE is the first ten characters of an RFC 3339 instant, which is
         * its date part. `commonMain` has no calendar and adding one to render
         * one line would be a dependency for a substring; a shell that wants a
         * localised date has the raw [Moved.atIso] beside it.
         */
        public val frozenLine: String?
            get() {
                val at = moved ?: return null
                val day = at.atIso.take(DATE_CHARS)
                val changes = if (at.unacked == 1L) "1 change" else "${at.unacked} changes"
                return "$changes since $day"
            }

        /**
         * THE STATE, AND ON THIS DEVICE THERE ARE TWO (#1029 §1, F1).
         *
         * It was a function of the last pass's outcome and whether a pass was
         * in flight, and it had three answers because there were three things a
         * gateway could be doing. **The phone is the vault.** There is no pass,
         * no gateway and no copy still coming, so a vault this shelf holds is a
         * file on this device whose core opened — `STATE_ONLINE`, whose own
         * wording is a PAST-TENSE fact ("synced") rather than a claim about a
         * live link.
         *
         * A RESTING holding is `STATE_ONLINE` too, and that is not a guess: the
         * file is whole and [rest] closed its handle to give the OS memory back.
         * Nothing about the vault changed.
         *
         * **AND THE SECOND ONE IS THE FREEZE** (#1029 W5, hand-off 3).
         * `STATE_SYNCING` and `STATE_OFFLINE` were facts about a pass and are
         * reserved in `screen.proto` now, by number and by name;
         * [VaultLockup.State.STATE_FROZEN] took their place. Until W5 this shelf
         * could only say `STATE_ONLINE` about a vault that had MOVED, and a
         * switcher row that said "synced" over a vault refusing every write is
         * the shape the umbrella's UI invariant forbids — the phone claiming a
         * backup the gateway never acked.
         */
        public val state: VaultLockup.State
            get() = if (moved == null) {
                VaultLockup.State.STATE_ONLINE
            } else {
                VaultLockup.State.STATE_FROZEN
            }

        /** This holding as a row the switcher and the header both draw. */
        public fun lockup(): VaultLockup = VaultLockup(
            vault_id = vaultId,
            vault_name = name,
            color = color,
            state = state,
            // THE LINE RIDES THE LOCKUP (#1029 W5, hand-off 3). Empty for a
            // vault that has not moved, which is the proto zero and a real
            // state. It was a door on `HomeBridge` because there was no slot;
            // there is one, so there is one source.
            frozen_line = frozenLine.orEmpty(),
            // `originals_withheld` IS LEFT AT ITS PROTO ZERO (#1029 §1). It
            // carried the last pass's `withheld` — originals a TRANSFER RULE
            // held back on a metered link — and a vault whose originals are on
            // the device that took them withholds nothing from itself.
        )
    }

    /**
     * THIS VAULT MOVED TO ANOTHER PHONE (#1029 §1, F1).
     *
     * ## Cooperation, not enforcement
     *
     * Both phones hold the same seed, so no lease and no lock can DECIDE who
     * owns a vault — either phone could ignore any answer it is given and go on
     * writing. What supersession buys is an ORDER (F3): the restored phone
     * claims the next lease epoch, and a phone that learns its own epoch has
     * been superseded stops writing because that is the cooperative thing to
     * do, not because something stopped it.
     *
     * So this state does three things and no more: writes are refused
     * ([Holding.readOnly]), the unacked spool is SHOWN ([Holding.frozenLine]),
     * and it is KEPT. **Never wipe, never auto-take-back.** Wiping would
     * destroy a member's only copy of whatever this phone wrote last; taking
     * the vault back automatically would be two phones claiming one authority
     * in a loop, with the member watching it flip.
     *
     * @property atIso when the other phone claimed the vault, RFC 3339.
     * @property unacked how many changes this phone holds that the vault it
     *   moved to has not seen. A count and never a deletion.
     */
    public data class Moved(
        public val atIso: String,
        public val unacked: Long,
    )

    /** Why a [found] did not add a holding. A CODE; the sentence is the shell's. */
    public enum class FoundRefusal {
        /** The core would not open the new file at all. */
        NO_CORE,

        /**
         * THE FILE OPENED AND NO VAULT WAS FOUNDED IN IT.
         *
         * **The door exists now** (#1029 W5, hand-off 1): `envelope.proto`
         * carries a `FoundRequest` arm and `crates/core`'s `api::found` writes
         * `core_vault` and the owner's `core_party` in one commit. This refusal
         * is no longer the standing state of the build — it is what remains
         * when that write is REFUSED: a file that already holds a vault
         * (`ERROR_CODE_VAULT_ALREADY_HELD`), or a core that answered the found
         * and then could not name what it made.
         *
         * The file is deleted on this path. A `.sqlite3` in the directory that
         * names no vault would be listed by every later [load], refused by
         * `VaultRoster.identify` every time, and invisible to the member who
         * made it.
         */
        NOT_FOUNDED,

        /** This device already holds the vault that file turned out to be. */
        ALREADY_HELD,
    }

    public sealed interface FoundOutcome {
        public data class Founded(public val holding: Holding) : FoundOutcome

        public data class Refused(public val because: FoundRefusal) : FoundOutcome
    }

    private val holdings = MutableStateFlow<List<Holding>>(emptyList())

    private val rosterFlow = MutableStateFlow<List<VaultLockup>>(emptyList())

    /**
     * The roster, republished on every membership change.
     *
     * A `StateFlow` and not a one-shot answer, because the one-shot answer is
     * precisely what was wrong: `VaultRoster.survey` ran at launch, and a vault
     * added a minute later did not exist to any screen until the next relaunch.
     */
    public val roster: StateFlow<List<VaultLockup>> get() = rosterFlow.asStateFlow()

    private var foregroundId: String? = null

    /**
     * ONE STRUCTURAL CHANGE AT A TIME.
     *
     * [found], [forget], [bringToFront] and [rest] each open or close cores, and
     * two of them interleaved would leave the process holding a handle nobody
     * owns — `SingleHandleGuard` is acquired by one open and released by the
     * other's close. A member double-tapping two rows in the switcher is exactly
     * that race.
     */
    private val gate = Mutex()

    private val fs: FileSystem get() = FileSystem.SYSTEM

    /** Which vault is in front. Null before [load], and on a device holding none. */
    public val foreground: String? get() = foregroundId

    /** The holding in front, when there is one. */
    public fun foregroundHolding(): Holding? =
        holdings.value.firstOrNull { it.vaultId == foregroundId }

    /** Every holding, foreground first. */
    public fun all(): List<Holding> {
        val held = holdings.value
        val front = held.firstOrNull { it.vaultId == foregroundId } ?: return held
        return listOf(front) + held.filter { it.vaultId != front.vaultId }
    }

    /**
     * The core the foreground holding is open on, or null.
     *
     * It does **not** wake a resting holding — waking is a suspending act and
     * this is read from a property on the session's hot path; [bringToFront] and
     * [awaken] are what wake. Null is a device holding no vault, which is a
     * state of the device and shows the empty shelf rather than an error.
     */
    public fun core(): CentraidCore? = foregroundHolding()?.core

    // -----------------------------------------------------------------------
    // Launch
    // -----------------------------------------------------------------------

    /**
     * OPEN EVERY VAULT THIS DEVICE HOLDS (#1025 S7-9, reshaped by #1029 §1).
     *
     * Every `.sqlite3` in the directory is opened — one way, with no role and
     * without creating anything — and it STAYS open. A file that will not open,
     * or that will not say which vault it is, is simply not a holding: a row
     * that fails on tap is a door that does not open, and a file the shelf
     * cannot name is a blank the member could tap.
     *
     * Then the FOREGROUND is chosen: the vault the member last had in front.
     */
    public suspend fun load(): Unit = gate.withLock {
        val found = mutableListOf<Holding>()
        for (path in vaultFiles(vaultDir)) {
            val holding = adopt(path) ?: continue
            // TWO FILES, ONE VAULT, is a thing a directory can hold — a copy
            // taken by hand, a restore written beside the original — and two
            // holdings under one id would give the switcher two rows that
            // cannot be told apart and the session two cores on one vault's
            // rows. The first file wins because the listing is sorted, so the
            // same device picks the same one twice running.
            if (found.any { it.vaultId == holding.vaultId }) {
                holding.core?.close()
                continue
            }
            found += holding
        }
        holdings.value = found
        val remembered = services.secureStore.read(FOREGROUND_KEY)
        foregroundId = found.firstOrNull { it.vaultId == remembered }?.vaultId
            ?: found.firstOrNull()?.vaultId
        publish()
    }

    // -----------------------------------------------------------------------
    // Found — the phone making itself a vault
    // -----------------------------------------------------------------------

    /**
     * MAKE A VAULT ON THIS PHONE (#1029 §1).
     *
     * The inverse of [forget] and the replacement for `admit`, which redeemed a
     * pairing ticket against a gateway. **The shell can create a vault**: it
     * names a fresh file, opens it with `create`, and the core founds the vault
     * inside it.
     *
     * The file is named by [freshVaultFile] and the name is arbitrary — the
     * vault's own id is read back off the file afterwards ([identify]) and the
     * two are never reconciled, because the file name is not an identity. That
     * is what makes this one act rather than the write-then-rename `Replicas`
     * had to do.
     *
     * **THE DOOR LANDED** (#1029 W5, hand-off 1). `Core::open` with `create`
     * lays the migrations down and [VaultRoster.found] writes the two rows that
     * make them a vault. The order is open → found → identify, and the identify
     * is not redundant: the NAME on the holding must come out of the vault and
     * never off the string this function sent ([VaultRoster.identify]).
     *
     * A refusal on either step deletes the file rather than leaving one the
     * shelf can never name.
     *
     * @param name what `core_vault.display_name` is set to. Empty is a real
     *   state — a vault with no name draws "No vault yet" — and the member
     *   renames it inside the vault afterwards.
     * @param ownerName what the owner's `core_party` is called. A DISPLAY NAME
     *   and nothing else: there is no email address, no phone number and no
     *   account anywhere on this path.
     */
    public suspend fun found(
        name: String = DEFAULT_VAULT_NAME,
        ownerName: String = DEFAULT_OWNER_NAME,
    ): FoundOutcome = gate.withLock {
        val path = freshVaultFile()
        val core = openCore(path, create = true)
            ?: return@withLock FoundOutcome.Refused(FoundRefusal.NO_CORE)
        if (!VaultRoster.found(core, displayName = name, ownerName = ownerName)) {
            core.close()
            deleteVault(path)
            return@withLock FoundOutcome.Refused(FoundRefusal.NOT_FOUNDED)
        }
        val named = VaultRoster.identify(core)
        if (named == null || named.vault_id.isEmpty()) {
            core.close()
            deleteVault(path)
            return@withLock FoundOutcome.Refused(FoundRefusal.NOT_FOUNDED)
        }
        if (holdings.value.any { it.vaultId == named.vault_id }) {
            core.close()
            deleteVault(path)
            return@withLock FoundOutcome.Refused(FoundRefusal.ALREADY_HELD)
        }
        val holding = Holding(
            vaultId = named.vault_id,
            path = path,
            name = named.vault_name,
            color = named.color,
            core = core,
        )
        holdings.value = holdings.value + holding
        foregroundId = holding.vaultId
        services.secureStore.write(FOREGROUND_KEY, holding.vaultId)
        publish()
        FoundOutcome.Founded(holding)
    }

    // -----------------------------------------------------------------------
    // Forget — the inverse
    // -----------------------------------------------------------------------

    /**
     * REMOVE A VAULT FROM THIS DEVICE (#1025 S7-9).
     *
     * THIS vault's core is closed — every other holding's stays open — the
     * holding drops off the shelf, and the file, its byte store and its SQLite
     * sidecars are deleted.
     *
     * **This is the one thing on this class that destroys a member's rows.** On
     * a phone that IS the vault there is no copy anywhere else to fall back to:
     * `forget` used to mean "this phone is not holding that gateway's vault any
     * more", and it now means the vault is gone. Whatever calls it owes the
     * member a confirmation and a backup; this function is not the place for
     * either, and #1029 W5 owns the restore that makes the trade survivable.
     *
     * The next foreground is the first remaining holding, or none — a device
     * holding zero vaults is a state of the device and shows the empty shelf.
     */
    public suspend fun forget(vaultId: String): Unit = gate.withLock {
        val going = holdings.value.firstOrNull { it.vaultId == vaultId } ?: return@withLock
        going.core?.close()
        holdings.value = holdings.value.filter { it.vaultId != vaultId }
        deleteVault(going.path)
        if (foregroundId == vaultId) {
            foregroundId = holdings.value.firstOrNull()?.vaultId
            services.secureStore.write(FOREGROUND_KEY, foregroundId.orEmpty())
            wake(foregroundId)
        }
        publish()
    }

    // -----------------------------------------------------------------------
    // Foreground
    // -----------------------------------------------------------------------

    /**
     * BRING A HOLDING TO THE FRONT. A REBIND, NOT A REOPEN (#1025 S7-13).
     *
     * The core it answers is the one that has been open since this holding was
     * founded or the shelf launched. Nothing is closed and nothing is opened —
     * [HomeSession] re-points its runtime and change reader and the switch is a
     * pointer move.
     *
     * The one case that does open a core is a RESTING holding: [rest] closed it
     * to give the OS its memory back, and a tap is exactly the touch that wakes
     * it.
     *
     * Answers null when the id names no holding, or when a rested holding's file
     * will not reopen — in which case the shelf STAYS where it was, still
     * showing something real.
     */
    public suspend fun bringToFront(vaultId: String): CentraidCore? = gate.withLock {
        val next = holdings.value.firstOrNull { it.vaultId == vaultId } ?: return@withLock null
        val core = wake(vaultId) ?: return@withLock null
        if (foregroundId != next.vaultId) {
            foregroundId = next.vaultId
            services.secureStore.write(FOREGROUND_KEY, next.vaultId)
            publish()
        }
        core
    }

    /**
     * The core for [vaultId], reopening a RESTING holding, WITHOUT moving the
     * foreground (#1025 S7-13).
     */
    public suspend fun awaken(vaultId: String): CentraidCore? = gate.withLock { wake(vaultId) }

    /**
     * Close every open core. The holdings stay: they are files on disk, and a
     * closed app still holds its vaults.
     */
    public suspend fun closeAll(): Unit = gate.withLock {
        holdings.value.forEach { it.core?.close() }
        holdings.value = holdings.value.map { it.copy(core = null) }
    }

    // -----------------------------------------------------------------------
    // Rest — the OS asking for memory back
    // -----------------------------------------------------------------------

    /**
     * CLOSE EVERY CORE BUT THE FOREGROUND'S (#1025 S7-13, ruling F).
     *
     * Wired from iOS's `UIApplication.didReceiveMemoryWarningNotification` and
     * Android's `onTrimMemory`. **It is the only thing besides [forget] that
     * closes a background core**, and that is the whole lifecycle: a held
     * vault's core is open, an OS under pressure gets the memory back, and the
     * next touch reopens what it needs.
     *
     * The foreground is kept because closing it would tear the screen the member
     * is looking at out from under them — a memory warning is not a reason to
     * show someone an empty vault.
     */
    public suspend fun rest(): Unit = gate.withLock {
        var changed = false
        holdings.value = holdings.value.map { holding ->
            if (holding.vaultId == foregroundId || holding.core == null) {
                holding
            } else {
                holding.core.close()
                changed = true
                holding.copy(core = null)
            }
        }
        if (changed) publish()
    }

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    /**
     * FREEZE A VAULT THAT MOVED TO ANOTHER PHONE (#1029 F1).
     *
     * **The only way in, and there is no way out.** Taking a vault back is a
     * deliberate act and never an automatic one, so there is no `thaw` here:
     * the act that would undo this is a member choosing to make THIS phone the
     * authority again, which claims the next lease epoch — and the lease is
     * #1029 W5's, with the restore it belongs to.
     *
     * ## Who calls this
     *
     * Whatever learns the vault moved, which is W5's restore client: it holds
     * the lease and hears the supersession. **There is no typed error to key
     * this on yet** — `error.proto` has no `ERROR_CODE_VAULT_MOVED`,
     * `crates/api-proto` is another lane's, and inventing a code number here
     * would be a second mechanism that disagreed with the first one minted.
     * When that code lands, the mapping goes beside the others in
     * `sync/ReadFailures.kt` and calls THIS function; the state, the refusal
     * and the line do not move.
     *
     * Deletes nothing, closes nothing and keeps the core open: a frozen vault
     * is fully readable, which is the point of freezing rather than forgetting.
     */
    public fun freeze(vaultId: String, atIso: String, unacked: Long) {
        update(vaultId) { it.copy(moved = Moved(atIso = atIso, unacked = unacked)) }
    }

    /** Re-read a holding's identity from its own file. */
    public fun rename(vaultId: String, name: String, color: String) {
        if (name.isEmpty()) return
        update(vaultId) { it.copy(name = name, color = color) }
    }

    private fun update(vaultId: String, change: (Holding) -> Holding) {
        val before = holdings.value
        val after = before.map { if (it.vaultId == vaultId) change(it) else it }
        if (after == before) return
        holdings.value = after
        publishFrom(after)
    }

    // -----------------------------------------------------------------------
    // The plumbing
    // -----------------------------------------------------------------------

    private fun publish() {
        publishFrom(holdings.value)
    }

    private fun publishFrom(held: List<Holding>) {
        // FOREGROUND FIRST, and otherwise the shelf's own order, which is the
        // directory's. A roster that re-sorted itself as states moved would move
        // the row under a member's thumb.
        val front = held.firstOrNull { it.vaultId == foregroundId }
        val ordered = if (front == null) {
            held
        } else {
            listOf(front) + held.filter { it.vaultId != front.vaultId }
        }
        rosterFlow.value = ordered.map { it.lockup() }
    }

    /**
     * Reopen a RESTING holding, or answer the core it already has.
     *
     * Called under [gate].
     */
    private suspend fun wake(vaultId: String?): CentraidCore? {
        val holding = holdings.value.firstOrNull { it.vaultId == vaultId } ?: return null
        holding.core?.let { return it }
        val opened = openCore(holding.path, create = false) ?: return null
        holdings.value = holdings.value.map {
            if (it.vaultId == holding.vaultId) it.copy(core = opened) else it
        }
        publish()
        return opened
    }

    /** Open a file and ask it which vault it is. Null for either refusal. */
    private suspend fun adopt(path: String): Holding? {
        val core = openCore(path, create = false) ?: return null
        val named = VaultRoster.identify(core)
        if (named == null || named.vault_id.isEmpty()) {
            core.close()
            return null
        }
        return Holding(
            vaultId = named.vault_id,
            path = path,
            name = named.vault_name,
            color = named.color,
            core = core,
        )
    }

    /**
     * THE ONE OPEN (#1029 §1).
     *
     * A path and whether this call may found a vault there, and nothing else.
     * It carried a `role` — `SEAT_REPLICATED`, always, hard-coded — and the
     * enrolment record this device held for the vault; the first named a plane
     * that is deleted and the second a relationship that no longer exists.
     *
     * `create` is FALSE for every open but [found]'s, and that is the same rule
     * it always kept for the opposite reason: it used to be false because a
     * replica is a COPY and founding an empty vault in its place would stand a
     * silently empty product in for one that had not synced. It is false now
     * because a file that is not there is a vault this device does not hold, and
     * `crates/core`'s own note says the same — a shell opening a vault a restore
     * is about to write is answered "there is nothing here" rather than handed
     * an empty one.
     */
    private suspend fun openCore(path: String, create: Boolean): CentraidCore? = when (
        val outcome = CentraidCore.open(
            CoreConfiguration(databasePath = path, create = create),
            dispatcher,
            uiThreadName,
        )
    ) {
        is CoreOutcome.Answered -> outcome.value
        is CoreOutcome.Failed -> null
    }

    // -----------------------------------------------------------------------
    // The file layer — `Replicas`, as it survives the deletion
    // -----------------------------------------------------------------------

    /**
     * Every vault file in the directory, sorted by name.
     *
     * Sorted so the same device picks the same foreground twice running rather
     * than whichever file the filesystem happened to enumerate first. `-wal` and
     * `-shm` are excluded by the suffix: they are SQLite's sidecars, not vaults,
     * and opening one as a vault fails at the door.
     *
     * **It matches no prefix**, which is what lets files written under the old
     * `centraid-replica-<vaultId>.sqlite3` spelling keep opening beside the ones
     * [freshVaultFile] makes. A vault says what it is; a file name does not.
     */
    private fun vaultFiles(directory: String): List<String> {
        val dir = directory.toPath()
        if (!fs.exists(dir)) return emptyList()
        return fs.list(dir)
            .filter { it.name.endsWith(SUFFIX) }
            .map { it.toString() }
            .sorted()
    }

    /**
     * A file name no vault in this directory is using.
     *
     * The middle is random rather than a counter: a counter would have to be
     * stored somewhere, and a second place to keep it is a second thing that can
     * be wrong. `SecureRandom` is used because it is the RNG this module has —
     * `kotlin.random.Random` is seeded from the clock, and two vaults founded in
     * the same tick is exactly the collision it would produce.
     */
    private fun freshVaultFile(): String {
        val dir = vaultDir.toPath()
        while (true) {
            val name = PREFIX + hex(services.secureRandom.bytes(NAME_BYTES)) + SUFFIX
            val candidate = dir.resolve(name)
            if (!fs.exists(candidate)) return candidate.toString()
        }
    }

    /** The vault file, its byte store and SQLite's sidecars, together. */
    private fun deleteVault(path: String) {
        val file = path.toPath()
        runCatching { fs.delete(file, mustExist = false) }
        SIDECARS.forEach { suffix ->
            runCatching { fs.delete(file.parent!!.resolve(file.name + suffix), mustExist = false) }
        }
        runCatching { fs.deleteRecursively(byteStoreOf(file), mustExist = false) }
    }

    /**
     * `<stem>.sqlite3` -> `<stem>.bytes`.
     *
     * THE LAST EXTENSION IS REPLACED, NOT APPENDED. This was `name + ".bytes"`
     * for one simulator run, and the run is how it was found: a file's store
     * stayed behind while the vault beside it opened a fresh, empty one. Every
     * photograph was orphaned and nothing failed — a library of rows pointing at
     * nothing renders as a grid of placeholders rather than as an error.
     */
    private fun byteStoreOf(file: Path): Path =
        file.parent!!.resolve(file.name.substringBeforeLast('.', file.name) + ".bytes")

    private fun hex(bytes: ByteArray): String =
        bytes.joinToString("") { byte ->
            val value = byte.toInt() and 0xff
            HEX[value shr 4].toString() + HEX[value and 0x0f]
        }

    public companion object {
        /**
         * Which vault the member last had in front, kept in the secure store.
         *
         * Not a preference file: it is cleared with the vault data, it survives
         * a launch, and a second mechanism for "things that must survive a
         * launch and be cleared with the vault" would be a second thing to
         * remember. It is not a secret and does not claim to be.
         */
        public const val FOREGROUND_KEY: String = "shelf.foreground"

        /** What [freshVaultFile] writes. A label on a file, never an identity. */
        internal const val PREFIX: String = "centraid-vault-"

        /**
         * WHAT MAKES A FILE IN THE VAULT DIRECTORY A VAULT.
         *
         * `public` because a shell that PLACES a file there has to spell it the
         * same way — Android's asset copy filtered on `.db`, the suffix
         * `mobile/scripts/demo-vault.sh` used to write, so a fixture was copied
         * into the vault directory and then ignored by the roster that was
         * meant to adopt it. Nothing failed; the switcher simply said the
         * device held one vault. A second spelling of this constant is how that
         * happened, so there is one and it is reachable.
         */
        public const val SUFFIX: String = ".sqlite3"

        /** 128 bits of file name. Enough that a collision is not a case. */
        private const val NAME_BYTES: Int = 16

        private const val HEX: String = "0123456789abcdef"

        /** `YYYY-MM-DD` — an RFC 3339 instant's date part. */
        private const val DATE_CHARS: Int = 10

        /**
         * WHAT A WRITE TO A FROZEN VAULT IS ANSWERED WITH (#1029 F1).
         *
         * One sentence, here, because a rule that lives in every reducer is a
         * rule one reducer will get wrong — the argument `WriteGate` made and
         * the one thing about it worth keeping. It says what happened and what
         * is still true, and it offers no way back: taking the vault back is a
         * deliberate act (W5's) and a sentence that implied a button would be
         * describing one that is not there.
         */
        public const val MOVED_SENTENCE: String =
            "This vault moved to your other phone. Everything here is still readable."

        /**
         * WHAT A VAULT IS CALLED WHEN NOBODY NAMED IT (#1029 W5).
         *
         * The make-vault sheet on both shells is a button and no text field, so
         * the found has to carry a string and this is it. It lives here rather
         * than in `CentraidCopy` because that table is GENERATED from `copy/`
         * and hand-editing it is what the mobile-jvm gate's clean-tree
         * assertion refuses; a name a member can change from inside the vault
         * is also not app copy in the sense that table holds.
         *
         * **A DEFAULT AND NOT A PLACEHOLDER.** It is written to
         * `core_vault.display_name`, the one place a vault's name lives, so a
         * member who never renames it reads this on the header — which is why
         * it is a sentence-case thing a person would say and not `Vault 1`.
         */
        public const val DEFAULT_VAULT_NAME: String = "My vault"

        /**
         * WHAT THE OWNER PARTY IS CALLED WHEN NOBODY NAMED THEM (#1029 W5).
         *
         * A display name on a `core_party` of kind `person`, and the only party
         * in a fresh vault. There is no email address, no phone number and no
         * account here and nowhere for one to arrive — the same rule
         * `lease.proto` states for the gateway plane.
         */
        public const val DEFAULT_OWNER_NAME: String = "Me"

        private val SIDECARS = listOf("-wal", "-shm")
    }
}
