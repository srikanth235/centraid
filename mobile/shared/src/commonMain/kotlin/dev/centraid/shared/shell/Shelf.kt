package dev.centraid.shared.shell

import centraid.core.v1.Envelope
import centraid.core.v1.ErrorCode
import centraid.core.v1.PairRequest
import centraid.core.v1.Request
import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreConfiguration
import dev.centraid.core.CoreFailure
import dev.centraid.core.CoreOutcome
import dev.centraid.core.CoreRole
import dev.centraid.core.PairingRecord
import dev.centraid.shared.platform.PlatformServices
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okio.ByteString.Companion.toByteString
import okio.FileSystem
import okio.Path.Companion.toPath

/**
 * EVERY VAULT THIS DEVICE HOLDS, AND THE ONE OBJECT THAT ADDS OR REMOVES ONE
 * (#1025 S7-9).
 *
 * ## What was wrong, stated plainly
 *
 * **Pairing a second gateway onto a device that already held a vault DESTROYED
 * the first one.** Reproduced on the iPhone 17 Pro simulator, and the chain is
 * short enough to state in full: [HomeSession.pair] sent `Request::Pair` down
 * the LIVE core — the one open on vault A's replica — `Handle::pair` called
 * `bootstrap` into that same file with no guard, and vault A's rows were
 * replaced by vault B's. Then [Replicas.settle] looked for a
 * `centraid-pairing.sqlite3` that had never been created, answered null, the
 * session fell back to a path with no file and opened it with `create = false`,
 * and the member — who a second earlier had a vault — read **"No vault yet"**.
 *
 * Two separate objects each held one true fact and neither held the set:
 * `Replicas` knew which files existed and `Pairings`/`EndpointKeys` knew which
 * vaults had a record and an identity, and `VaultRoster.survey` read all of it
 * ONCE at launch and never again. A vault admitted afterwards was invisible
 * until the app was relaunched. Those two objects are now one — [Enrolments],
 * one record per vault — and this class is the set.
 *
 * ## What this is
 *
 * The shelf holds [Holding]s. A holding is a vault id, the file it lives in,
 * what it is called, its OPEN CORE, the last pass's [SyncOutcome] and whether a
 * pass is in flight — from which its [VaultLockup.State] is DERIVED, never
 * stored. **[admit] and [forget] are the only things that add or remove an
 * entry.**
 *
 * Every membership or state change publishes [roster]. The switcher's rows and
 * the header's second line are two renderings of that one stream, which is what
 * stops them disagreeing the way the survey and the session's `link` did.
 *
 * ## A HELD VAULT'S CORE IS OPEN (#1025 S7-13, ruling F)
 *
 * Every holding's core is open — the file and the endpoint — from the moment it
 * is admitted or the shelf launches. **A switch is a pure rebind**: [HomeSession]
 * points its runtime and change reader at the foreground holding's core, and
 * nothing is closed, nothing is reopened, nothing is re-identified. Where the
 * previous wave spent a SQLite close-and-open on every tap of the switcher,
 * this spends nothing.
 *
 * "Open" means the file and the endpoint, and it does **not** mean an active
 * dial. Dialling stays the sync round's decision — foreground first, and the
 * metered rule unchanged — so a background vault's endpoint is a bound socket
 * doing nothing until a round reaches it.
 *
 * ### What the cap was, and why it is gone
 *
 * `OPEN_CORES = 1` cited R-1020-24, and the citation was the whole argument.
 * R-1020-24 is that **app extensions never open the vault**: two handles on ONE
 * FILE is the hazard, because that is two writers and two endpoints for one
 * vault. Two handles on two different vaults share no file, no outbox and no
 * endpoint, and refusing them bought nothing. `SingleHandleGuard` is keyed on
 * the replica path now and the rule it enforces is unchanged for the case it
 * exists for; `D-1020-HOME8`'s survey-before-open dance is no longer needed,
 * because the roster is read off the cores that are already open.
 *
 * ### The only two things that close a background core
 *
 * 1. [forget], which is the member removing the vault.
 * 2. [rest], the OS asking for memory back — iOS's
 *    `didReceiveMemoryWarning` and Android's `onTrimMemory`. It closes every
 *    core but the foreground's; a rested holding reopens on the next touch or
 *    the next sync round.
 *
 * There is deliberately **no idle timeout**. If one is ever wanted, the shape
 * is a per-vault timer on the [Holding] — not a global number of cores — for
 * the same reason [rest] is per holding: "how many may be open" is a question
 * about a device, and every other question here is about a vault.
 *
 * ## A device pairs with a VAULT
 *
 * Two vaults behind one gateway is a coincidence this device never surfaces and
 * never acts on, which is why nothing here is keyed by a gateway: a holding is
 * keyed by vault id, and so are its replica, its byte store, its endpoint, its
 * core and its one [Enrolments] record. **"Gateway" is not a noun this device
 * has** (#1025 S7-13, ruling A).
 */
public class Shelf(
    /** Where every replica this device holds lives. See [Replicas]. */
    private val replicaDir: String,
    private val services: PlatformServices,
    private val dispatcher: CoroutineDispatcher,
    private val uiThreadName: String,
) {
    /**
     * ONE VAULT, AS THIS DEVICE HOLDS IT.
     *
     * [outcome] is the LAST pass's report and null before any pass has run.
     * [passInFlight] is the shelf's own bookkeeping. Neither is a state; [state]
     * is computed from both, every time it is asked.
     */
    public data class Holding(
        public val vaultId: String,
        /** The replica file. Resolving an id to a path is the shell's business. */
        public val path: String,
        /**
         * What to call it.
         *
         * Read out of the replica's own `core_vault.display_name` the moment
         * there is a file to read it from ([VaultRoster.identify]). A name that
         * came off a pairing TICKET is a placeholder and nothing more: the
         * gateway mints its ticket with its `--vault-name` flag, which on a
         * seeded demo said "Centraid" over a vault called "Tahoe Demo". A
         * vault's name lives inside the vault.
         */
        public val name: String,
        public val color: String = "",
        public val outcome: SyncOutcome? = null,
        public val passInFlight: Boolean = false,
        /**
         * A TAIL IS OPEN ON THIS HOLDING (#1025 S2, D-1025-S7-40).
         *
         * The foreground holding's ordinary state while a member is looking at
         * the app: one stream to the gateway, held open, carrying every page
         * the vault commits. **A receiving tail over a reachable last pass IS
         * a gateway that is reached** — which is why it decides [state] ahead
         * of a successful last pass, and why a quiet vault does not drift
         * towards "offline" after an hour of nobody writing anything. A mark
         * set when the stream is merely asked for does not outrank a
         * just-recorded unreachable (R-SHELL-1).
         */
        public val tailing: Boolean = false,
        /**
         * THIS VAULT'S OPEN CORE, or null while the holding is RESTING
         * (#1025 S7-13, ruling F).
         *
         * A per-vault lifecycle and not a global number of open cores: "how
         * many may be open" is a question about a device, and every other
         * question on this class is about a vault. A holding rests only when
         * [rest] is called — the OS asking for memory back — and wakes on the
         * next touch or the next sync round.
         *
         * Compared by IDENTITY, which is what a data class does with a type
         * that has no `equals`, and which is the right comparison: a holding
         * whose core was replaced IS a different holding, and the roster
         * republishes.
         */
        public val core: CentraidCore? = null,
    ) {
        /** Closed to give the OS its memory back, and reopened on next touch. */
        public val resting: Boolean get() = core == null

        /**
         * THE STATE, DERIVED (#1025 S7-9; R-SHELL-1).
         *
         * Cases, in this order, and the order is the whole definition:
         *
         * 1. A pass IN FLIGHT is syncing, whatever the last one said.
         * 2. A just-recorded unreachable is OFFLINE — even if [tailing] was
         *    marked true when the stream was asked for. Marking the ask must
         *    not outrank a failed pass or a dead tail (trap unreachable-vault).
         * 3. A receiving / asked-for tail over a reachable last pass is ONLINE
         *    (#1025 S2, D-1025-S7-40).
         * 4. A bootstrap that ran and has not fetched the whole copy is
         *    syncing — "paired, no file yet" and "the copy is 40% here".
         * 5. Otherwise the last pass decides: it reached the gateway, or it did
         *    not.
         *
         * **A holding that has never run a pass is [VaultLockup.State.STATE_SYNCING]
         * and not "online".** It is a vault nothing has reported on yet, and
         * the honest thing to say is that Centraid is working on it — claiming
         * "synced" over a pass nobody ran is exactly the guess that put "not
         * connected to a gateway" over a synced device for two waves.
         */
        public val state: VaultLockup.State
            get() {
                if (passInFlight) return VaultLockup.State.STATE_SYNCING
                val last = outcome
                // UNREACHABLE OUTRANKS A PENDING TAIL MARK (R-SHELL-1).
                // `openTail` sets `tailing` when the stream is asked for, before
                // any byte arrives. That mark alone must not say ONLINE over a
                // pass (or closed tail) that already reported unreachable.
                if (last != null && last.unreachable) {
                    return VaultLockup.State.STATE_OFFLINE
                }
                // A TAIL OVER A REACHABLE LAST PASS IS ONLINE (#1025 S2,
                // D-1025-S7-40). Quiet vaults move nothing for hours and are
                // not offline for a second of it.
                if (tailing) return VaultLockup.State.STATE_ONLINE
                if (last == null) return VaultLockup.State.STATE_SYNCING
                if (last.bootstrap.ran && last.copyFetched < last.copyTotal) {
                    return VaultLockup.State.STATE_SYNCING
                }
                return VaultLockup.State.STATE_ONLINE
            }

        /** This holding as a row the switcher and the header both draw. */
        public fun lockup(): VaultLockup = VaultLockup(
            vault_id = vaultId,
            vault_name = name,
            color = color,
            state = state,
            // THE LAST PASS'S OWN NUMBER (#1025 S4). Not computed here and not
            // remembered across passes: `withheld` is a fact about the window
            // that just ran, and a stale count would tell a member photographs
            // are waiting after the Wi-Fi window that brought them.
            originals_withheld = (outcome?.originalsWithheld ?: 0L)
                .coerceIn(0L, Int.MAX_VALUE.toLong()).toInt(),
        )
    }

    /** Why an [admit] did not add a holding. A CODE; the sentence is the shell's. */
    public enum class AdmitRefusal {
        /**
         * THIS DEVICE ALREADY HOLDS THAT VAULT.
         *
         * Refused before the ticket is redeemed, so nothing is burned and no
         * second endpoint key is minted — a second key would enrol this device
         * twice on one gateway, and revoking one of the two would leave a
         * holding that dials with an identity its gateway has never seen.
         *
         * **A matching display NAME is not this.** Names are labels: two
         * households may both call a vault "Home", and merging them on a string
         * would put one member's rows under another's authority. Two vaults
         * with one name are two rows, told apart by colour.
         */
        ALREADY_HELD,

        /** The gateway was not reached. Come back in range; the code is still good. */
        UNREACHABLE,

        /** The ticket expired, or was never one. Mint another. */
        BAD_TICKET,

        /** The core would not open, or the pairing answered nothing usable. */
        NO_CORE,
    }

    public sealed interface AdmitOutcome {
        /**
         * Admitted. [holding] carries the vault's REAL name when the copy
         * landed inside the pair call, and the ticket's placeholder when it did
         * not — [copyLanded] is how a caller tells which, so the pair sheet can
         * say "Paired with Tahoe Demo" or "…and your vault is being copied"
         * rather than confidently naming a gateway's CLI flag.
         */
        public data class Admitted(
            public val holding: Holding,
            public val copyLanded: Boolean,
        ) : AdmitOutcome

        public data class Refused(public val because: AdmitRefusal) : AdmitOutcome
    }

    private val holdings = MutableStateFlow<List<Holding>>(emptyList())

    private val rosterFlow = MutableStateFlow<List<VaultLockup>>(emptyList())

    /**
     * The roster, republished on every membership or state change.
     *
     * A `StateFlow` and not a one-shot answer, because the one-shot answer is
     * precisely what was wrong: `VaultRoster.survey` ran at launch, and a vault
     * admitted a minute later did not exist to any screen until the next
     * relaunch.
     */
    public val roster: StateFlow<List<VaultLockup>> get() = rosterFlow.asStateFlow()

    private var foregroundId: String? = null

    /**
     * THE CORE A DEVICE HOLDING NO VAULT PAIRS FROM.
     *
     * Not a holding: it is open on [Replicas.PAIRING_FILE], which names no
     * vault and cannot, and it exists because pairing rides `Request::Pair`
     * through a handle — a core has to be OPEN before it can pair. It is closed
     * the moment a real holding exists, and [admit] opens its own.
     */
    private var pairingCore: CentraidCore? = null

    /**
     * ONE STRUCTURAL CHANGE AT A TIME.
     *
     * [admit], [forget], [bringToFront] and [rest] each open or close cores,
     * and two of them interleaved would leave the process holding a handle
     * nobody owns — `SingleHandleGuard` is acquired by one open and released by
     * the other's close. A member double-tapping two rows in the switcher is
     * exactly that race.
     */
    private val gate = Mutex()

    private val fs: FileSystem get() = FileSystem.SYSTEM

    /** Which vault is in front. Null before [load], and on a device holding none. */
    public val foreground: String? get() = foregroundId

    /** The holding in front, when there is one. */
    public fun foregroundHolding(): Holding? =
        holdings.value.firstOrNull { it.vaultId == foregroundId }

    /** Every holding, foreground first. The order [syncRound] walks. */
    public fun all(): List<Holding> {
        val held = holdings.value
        val front = held.firstOrNull { it.vaultId == foregroundId } ?: return held
        return listOf(front) + held.filter { it.vaultId != front.vaultId }
    }

    /**
     * The core the foreground holding is open on, or null.
     *
     * A device holding no vault answers the pairing core, which is what
     * [HomeSession.pair] rides on a first run. It does **not** wake a resting
     * holding — waking is a suspending act and this is read from a property on
     * the session's hot path; [bringToFront] and [syncRound] are what wake.
     */
    public fun core(): CentraidCore? = foregroundHolding()?.core ?: pairingCore

    // -----------------------------------------------------------------------
    // Launch
    // -----------------------------------------------------------------------

    /**
     * OPEN EVERY REPLICA THIS DEVICE HOLDS (#1025 S7-9, reshaped by S7-13).
     *
     * Every file in [Replicas.list] is opened as the seat it is — with its own
     * [Enrolments] record, so its own endpoint identity and its own relay
     * decision — and it STAYS open. The previous wave opened each one with a
     * `GATEWAY`-role probe, read one row and closed it again before the next,
     * because one core per process meant it could hold none of them; the probe
     * is gone with the cap, and a holding's name is now read off the core it
     * already has (#1025 S7-13, ruling H).
     *
     * A file that will not open is simply not a holding: a vault whose bytes
     * are corrupt or mid-copy cannot be switched to, and a row that fails on
     * tap is a door that does not open. **An identity mismatch is one of those
     * refusals** — a vault whose secret is gone opens no core, so no dial is
     * made with a stranger's key.
     *
     * Then the FOREGROUND is chosen: the vault the member last had in front,
     * kept beside the enrolment records.
     */
    public suspend fun load(): Unit = gate.withLock {
        val found = mutableListOf<Holding>()
        for (path in Replicas.list(replicaDir)) {
            val core = openCore(path, Replicas.vaultIdOf(path)) ?: continue
            val named = VaultRoster.identify(core)
            if (named == null || named.vault_id.isEmpty()) {
                core.close()
                continue
            }
            found += Holding(
                vaultId = named.vault_id,
                path = path,
                name = named.vault_name,
                color = named.color,
                core = core,
            )
        }
        holdings.value = found
        val remembered = services.secureStore.read(FOREGROUND_KEY)
        foregroundId = found.firstOrNull { it.vaultId == remembered }?.vaultId
            ?: found.firstOrNull()?.vaultId
        // A DEVICE HOLDING NO VAULT STILL NEEDS A CORE TO PAIR THROUGH.
        if (found.isEmpty()) openPairingCore()
        publish()
    }

    // -----------------------------------------------------------------------
    // Admit — the pairing action
    // -----------------------------------------------------------------------

    /**
     * REDEEM A TICKET, AND ADD WHAT IT NAMED (#1025 S7-9).
     *
     * **Always into a fresh file at [Replicas.PAIRING_FILE], and never down the
     * live core.** That single sentence is the fix for the defect this class's
     * header describes: `Handle::pair` bootstraps its first copy into whatever
     * file the core it rides is open on, so pairing down a core holding vault A
     * writes vault B over vault A. The first vault and the Nth take the
     * identical path — there is no branch on "does this device already hold
     * one" — which is what stops the Nth being the one that was never tested.
     *
     * The order is load-bearing:
     *
     * 1. Refuse a vault already held, if the ticket names one this device has.
     *    This cannot be checked before the redemption in general — a ticket
     *    does not reliably name its vault — so it is checked again after, and
     *    that path un-does nothing: see [AdmitRefusal.ALREADY_HELD].
     * 2. The PAIRING core is closed if one is open — it is on the very file
     *    this is about to pair into, which is the one collision the path-keyed
     *    `SingleHandleGuard` does refuse. Every HOLDING's core stays open:
     *    pairing a second vault does not disturb the first (#1025 S7-13).
     * 3. A fresh core opens at the pairing file, on the identity
     *    [Enrolments.minted] kept under [Enrolments.PAIRING].
     * 4. The ticket is redeemed; the core takes the first copy into that file.
     * 5. **Two** moves settle under the vault id: the replica, and the one
     *    enrolment record. It was three, and three renames is three chances to
     *    settle by halves.
     * 6. The holding is appended with its own core REOPENED on the settled
     *    path — the file moved out from under the pairing core, so that one
     *    handle cannot be carried over — made foreground, and published.
     */
    public suspend fun admit(
        ticket: String,
        deviceName: String,
        platform: String,
    ): AdmitOutcome = gate.withLock {
        closePairingCore()
        val pairingPath = Replicas.pairingPath(replicaDir)
        // A PAIRING FILE LEFT OVER FROM AN ATTEMPT THAT DID NOT SETTLE is not a
        // vault — it has no id to be filed under — and pairing into it would
        // hit the core's own guard, which refuses a replica already holding
        // rows. It is cleared rather than reused.
        clearPairingFile()
        val core = openWith(pairingPath, Enrolments.minted(services))
        if (core == null) {
            openPairingCore()
            return@withLock AdmitOutcome.Refused(AdmitRefusal.NO_CORE)
        }
        val answer = core.call(
            Envelope(
                request = Request(
                    pair = PairRequest(
                        // THE ENCODED TICKET THE CAMERA READ, not a redemption.
                        // `Handle::pair` mints the real one: the secret, the
                        // ticket id and this device's public key are all things
                        // the core knows or derives, and a shell that assembled
                        // them would be a second place they live.
                        code = ticket.encodeToByteArray().toByteString(),
                        device_name = deviceName,
                        platform = platform,
                    ),
                ),
            ),
        )
        val ok = when (answer) {
            is CoreOutcome.Failed -> {
                core.close()
                openPairingCore()
                val failure = answer.failure
                val unreachable = failure is CoreFailure.Refused &&
                    (
                        failure.code == ErrorCode.ERROR_CODE_PEER_UNREACHABLE.value ||
                            failure.code == ErrorCode.ERROR_CODE_NO_RELAY_REACHABLE.value ||
                            failure.code == ErrorCode.ERROR_CODE_TIMEOUT.value
                        )
                return@withLock AdmitOutcome.Refused(
                    if (unreachable) AdmitRefusal.UNREACHABLE else AdmitRefusal.BAD_TICKET,
                )
            }
            // WIRE FLATTENS A `oneof` INTO NULLABLE FIELDS. At most one is set.
            is CoreOutcome.Answered -> answer.value.response?.pair?.ok
        }
        // THE GATEWAY'S VOCABULARY IS THREE CODES AND CARRIES NO TEXT, and
        // expired and never-existed answer the SAME refusal here: a member
        // holding a screenshot of an old QR must not learn from the answer
        // whether that ticket ever existed. The case is read anyway, so that
        // the log line can say which, and so a future sheet that wants to
        // distinguish them has somewhere to start.
        if (ok == null || ok.vault_id.isEmpty()) {
            core.close()
            openPairingCore()
            return@withLock AdmitOutcome.Refused(AdmitRefusal.BAD_TICKET)
        }
        // ALREADY HELD, CHECKED WHERE IT CAN BE CHECKED.
        //
        // The ticket is burned by now — the gateway enrolled this device and
        // there is nothing to un-burn — so this is not a "burn nothing" path
        // and does not pretend to be. What it protects is the FILE: the vault
        // this device is already holding keeps its replica, its outbox and its
        // endpoint key, and the duplicate copy that just landed in the pairing
        // file is discarded. The member is told to stop, not silently merged.
        if (holdings.value.any { it.vaultId == ok.vault_id }) {
            core.close()
            clearPairingFile()
            openPairingCore()
            return@withLock AdmitOutcome.Refused(AdmitRefusal.ALREADY_HELD)
        }
        // WHAT THE GATEWAY SAID, KEPT — before there is a replica to write it
        // into. A device that paired and could not take its copy used to lose
        // the pairing entirely: the record goes in the transaction that adopts
        // the copy, so a bootstrap that did not land left a burned ticket and a
        // member minting another for nothing.
        //
        // AND THE KEY THE GATEWAY SAYS IT ENROLLED (#1025 S7-13). It is the
        // only thing on this device that can tell "the secret is gone" from
        // "the gateway is unreachable", and without it the first is reported as
        // a version-window refusal — a member sent to update an app that is
        // working correctly.
        val answered = PairingRecord(
            gatewayAddress = ok.gateway_address,
            vaultId = ok.vault_id,
            vaultName = ok.vault_name,
            relayUrl = ok.relay_url,
            directAddrs = ok.direct_addrs,
            enrolledPublicKey = hex(ok.enrolled_public_key),
        )
        // IDENTITY OUT OF THE VAULT, WHILE THE FILE IS STILL OPEN. If the copy
        // landed inside the pair call the replica can name itself, and that
        // name beats the ticket's — which is the gateway's `--vault-name` flag
        // and not the vault's `display_name`.
        val identified = VaultRoster.identify(core)
        val landed = identified != null && identified.vault_id == ok.vault_id
        core.close()

        // ONE RENAME FOR THE RECORD, ONE FOR THE FILE. The enrolment carries
        // this device's minted secret across, which is the key the gateway just
        // enrolled — see [Enrolments.settle] for why the destination is
        // overwritten rather than protected.
        Enrolments.settle(services, ok.vault_id, answered)
        val settled = Replicas.settle(replicaDir, ok.vault_id)
            ?: Replicas.pathOf(replicaDir, MountKey(ok.vault_id))
        val holding = Holding(
            vaultId = ok.vault_id,
            path = settled,
            // THE TICKET'S NAME IS A PLACEHOLDER AND ONLY THAT. It stands in
            // until a copy lands and the replica can say what it is called.
            name = if (landed) identified.vault_name else ok.vault_name,
            color = identified?.color.orEmpty(),
            // OPENED ON THE SETTLED PATH, with the settled enrolment — so this
            // vault's endpoint comes up on the identity the gateway enrolled
            // and with the relay decision its record states.
            core = openCore(settled, ok.vault_id),
        )
        holdings.value = holdings.value + holding
        foregroundId = holding.vaultId
        services.secureStore.write(FOREGROUND_KEY, holding.vaultId)
        publish()
        AdmitOutcome.Admitted(holding = holding, copyLanded = landed)
    }

    // -----------------------------------------------------------------------
    // Forget — the inverse
    // -----------------------------------------------------------------------

    /**
     * REMOVE A VAULT FROM THIS DEVICE (#1025 S7-9).
     *
     * The exact inverse of [admit], and it removes every one of the things
     * admit created: THIS vault's core is closed — every other holding's stays
     * open — the holding drops off the shelf, and the replica, its byte store,
     * its SQLite sidecars and its one enrolment record are deleted. A
     * half-forget — the file gone and the identity left — is a credential
     * nothing will ever use again that every reader of the store has to step
     * over.
     *
     * **THE GATEWAY KEEPS THIS DEVICE ENROLLED.** Forgetting is local: it says
     * "this phone is not holding that vault any more", not "that vault should
     * stop trusting this phone". Revoking an enrolment is the gateway's act,
     * taken on the gateway, by whoever holds the vault — a phone that could
     * revoke itself from a household's gateway by tapping a row on its own
     * screen would be a phone that can lock a member out of their own vault.
     * #1025 builds no revocation; `crates/net`'s allowlist is where it would
     * live when it is built.
     *
     * The next foreground is the first remaining holding, or none — a device
     * holding zero vaults is an UNPAIRED DEVICE, which is a state of the device
     * and shows the pair flow.
     */
    public suspend fun forget(vaultId: String): Unit = gate.withLock {
        val going = holdings.value.firstOrNull { it.vaultId == vaultId } ?: return@withLock
        going.core?.close()
        holdings.value = holdings.value.filter { it.vaultId != vaultId }
        deleteReplica(going.path)
        Enrolments.forget(services, vaultId)
        if (foregroundId == vaultId) {
            foregroundId = holdings.value.firstOrNull()?.vaultId
            services.secureStore.write(FOREGROUND_KEY, foregroundId.orEmpty())
            // A DEVICE THAT NOW HOLDS NOTHING IS AN UNPAIRED DEVICE, and needs
            // a core to pair through again.
            if (holdings.value.isEmpty()) openPairingCore() else wake(foregroundId)
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
     * admitted or the shelf launched. Nothing is closed and nothing is opened —
     * [HomeSession] re-points its runtime and change reader and the switch is a
     * pointer move. The previous wave closed one SQLite file and opened another
     * on every tap, and cited a cap that did not mean what it was read to mean.
     *
     * The one case that does open a core is a RESTING holding: [rest] closed it
     * to give the OS its memory back, and a tap is exactly the touch that wakes
     * it.
     *
     * Answers null when the id names no holding, or when a rested holding's
     * file will not reopen — in which case the shelf STAYS where it was, still
     * showing something real.
     *
     * The choice is remembered beside the enrolment records, so the next launch
     * opens the vault the member was last in rather than whichever file sorted
     * first.
     */
    public suspend fun bringToFront(vaultId: String): CentraidCore? = gate.withLock {
        val next = holdings.value.firstOrNull { it.vaultId == vaultId } ?: return@withLock null
        val core = wake(vaultId) ?: return@withLock null
        if (foregroundId != next.vaultId) {
            foregroundId = next.vaultId
            services.secureStore.write(FOREGROUND_KEY, next.vaultId)
            // THE PAIRING CORE GOES when a real vault comes forward: it is open
            // on a file that is not a vault, and keeping it would leave a
            // handle nothing reads.
            closePairingCore()
            publish()
        }
        core
    }

    /**
     * The core for [vaultId], reopening a RESTING holding, WITHOUT moving the
     * foreground (#1025 S7-13).
     *
     * What the sync round walks with. The round used to call [bringToFront] on
     * every holding in turn and then switch back at the end, because there was
     * only ever one open core — which meant an ordinary "Sync now" moved the
     * whole app onto each vault and back, and a round that ended early left the
     * member somewhere they had not asked to be.
     */
    public suspend fun awaken(vaultId: String): CentraidCore? = gate.withLock { wake(vaultId) }

    /**
     * Close every open core. The holdings stay: they are files on disk, and a
     * closed app still holds its vaults.
     */
    public suspend fun closeAll(): Unit = gate.withLock {
        holdings.value.forEach { it.core?.close() }
        holdings.value = holdings.value.map { it.copy(core = null) }
        closePairingCore()
    }

    // -----------------------------------------------------------------------
    // Rest — the OS asking for memory back
    // -----------------------------------------------------------------------

    /**
     * CLOSE EVERY CORE BUT THE FOREGROUND'S (#1025 S7-13, ruling F).
     *
     * Wired from iOS's `UIApplication.didReceiveMemoryWarningNotification` /
     * `didReceiveMemoryWarning` and Android's `onTrimMemory`. **It is the only
     * thing besides [forget] that closes a background core**, and that is the
     * whole lifecycle: a held vault's core is open, an OS under pressure gets
     * the memory back, and the next touch or sync round reopens what it needs.
     *
     * A per-vault state and not a global cap. "How many cores may be open" is a
     * question about a device; every other question this class answers is about
     * a vault, and a number would make the answer to "is this vault open"
     * depend on how recently some other vault was touched.
     *
     * The foreground is kept because closing it would tear the screen the
     * member is looking at out from under them — a memory warning is not a
     * reason to show someone an empty vault.
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
     * A TAIL OPENED ON [vaultId] (#1025 S2, D-1025-S7-40; R-SHELL-1).
     *
     * Called when the stream is asked for, not when the first page lands. The
     * round runs a bounded catch-up first; [Holding.state] still refuses ONLINE
     * when the last outcome is unreachable, so marking the ask alone cannot
     * claim "synced" over a gateway that just failed to answer.
     */
    public fun tailOpened(vaultId: String) {
        update(vaultId) { it.copy(tailing = true) }
    }

    /**
     * The tail on [vaultId] closed, with what it moved before it did.
     *
     * Every close is ORDINARY: the deadline, the member leaving, the lock, a
     * dropped connection. The cursor is durable at every page boundary, so the
     * outcome is recorded exactly like a pass's and the state falls back to
     * what it says.
     */
    public fun tailClosed(vaultId: String, outcome: SyncOutcome) {
        update(vaultId) {
            it.copy(tailing = false, passInFlight = false, outcome = outcome)
        }
    }

    /** Mark a pass started on [vaultId], so its state reads `SYNCING`. */
    public fun passStarted(vaultId: String) {
        update(vaultId) { it.copy(passInFlight = true) }
    }

    /**
     * Record what a pass did, and with it the vault's state.
     *
     * The NAME is refreshed from the replica's own row whenever a caller has
     * one to give: a vault whose copy landed after the pairing is a vault whose
     * placeholder name can finally be replaced by its real one.
     */
    public fun passSettled(vaultId: String, outcome: SyncOutcome, name: String? = null) {
        update(vaultId) {
            it.copy(
                outcome = outcome,
                passInFlight = false,
                name = name?.takeIf { given -> given.isNotEmpty() } ?: it.name,
            )
        }
    }

    /** Re-read a holding's identity from its replica. */
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
        // directory's. A roster that re-sorted itself as states moved would
        // move the row under a member's thumb.
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
        val opened = openCore(holding.path, holding.vaultId) ?: return null
        holdings.value = holdings.value.map {
            if (it.vaultId == holding.vaultId) it.copy(core = opened) else it
        }
        publish()
        return opened
    }

    /**
     * The core a device holding NO vault pairs through.
     *
     * It opens at the pairing path, holds no file, refuses reads by name, and
     * the member's next move is the pair flow. It carries the minted identity
     * so that the endpoint this device pairs with is the endpoint whose secret
     * it has already written down — the key the gateway is about to enrol.
     */
    private suspend fun openPairingCore() {
        if (pairingCore != null) return
        pairingCore = openWith(Replicas.pairingPath(replicaDir), Enrolments.minted(services))
    }

    private fun closePairingCore() {
        pairingCore?.close()
        pairingCore = null
    }

    /**
     * `SEAT_REPLICATED`, on the enrolment this device holds for [vaultId].
     *
     * A holding with NO record opens with none, and the core mints a fresh
     * endpoint. That is a vault this device holds a copy of and has no identity
     * for — it can read offline and cannot dial — and it is reported by the
     * pass rather than hidden, because there is no key here to invent.
     */
    private suspend fun openCore(path: String, vaultId: String): CentraidCore? =
        openWith(path, if (vaultId.isEmpty()) null else Enrolments.of(services, vaultId))

    /**
     * `create = false`: a replica is a COPY, and a fresh empty vault founded in
     * its place would be a silently empty product standing in for one that has
     * not synced yet.
     *
     * A refusal is a null holding, and the loudest of them is
     * `ERROR_CODE_IDENTITY_MISMATCH` — the endpoint that came up is not the one
     * this vault's gateway enrolled, so the core refuses rather than dialling
     * as a stranger (#1025 S7-13).
     */
    private suspend fun openWith(path: String, enrolment: PairingRecord?): CentraidCore? = when (
        val outcome = CentraidCore.open(
            CoreConfiguration(
                databasePath = path,
                role = CoreRole.SEAT_REPLICATED,
                create = false,
                pairing = enrolment,
            ),
            dispatcher,
            uiThreadName,
        )
    ) {
        is CoreOutcome.Answered -> outcome.value
        is CoreOutcome.Failed -> null
    }

    /** 32 raw bytes as 64 lowercase hex, which is how a record spells a key. */
    private fun hex(bytes: okio.ByteString): String = bytes.hex()

    /** The replica, its byte store and SQLite's sidecars, together. */
    private fun deleteReplica(path: String) {
        val file = path.toPath()
        runCatching { fs.delete(file, mustExist = false) }
        SIDECARS.forEach { suffix ->
            runCatching { fs.delete(file.parent!!.resolve(file.name + suffix), mustExist = false) }
        }
        val bytes = file.parent!!.resolve(
            file.name.substringBeforeLast('.', file.name) + ".bytes",
        )
        runCatching { fs.deleteRecursively(bytes, mustExist = false) }
    }

    private fun clearPairingFile() {
        deleteReplica(Replicas.pairingPath(replicaDir))
    }

    public companion object {
        /**
         * Which vault the member last had in front, kept in the secure store
         * beside the pairing records.
         *
         * Not a preference file: it is cleared with the vault data, it survives
         * a launch, and a second mechanism for "things that must survive a
         * launch and be cleared with the vault" would be a second thing to
         * remember. It is not a secret and does not claim to be.
         */
        public const val FOREGROUND_KEY: String = "shelf.foreground"

        private val SIDECARS = listOf("-wal", "-shm")
    }
}
