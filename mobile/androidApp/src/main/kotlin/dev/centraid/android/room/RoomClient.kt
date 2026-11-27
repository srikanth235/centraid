package dev.centraid.android.room

import centraid.core.v1.DeviceGet
import centraid.core.v1.DeviceRequest
import centraid.core.v1.Event
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.core.v1.RoomCanvasEvent
import centraid.core.v1.RoomChange
import centraid.core.v1.RoomEvent
import centraid.core.v1.RoomOpen
import centraid.core.v1.RoomLifecycle
import centraid.core.v1.RoomRequest
import centraid.core.v1.RoomScrolled
import centraid.core.v1.RoomSend
import centraid.core.v1.RoomShown
import centraid.core.v1.RoomTap
import centraid.core.v1.RoomTransition
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShellEffectResult
import centraid.core.v1.ShellFailed
import centraid.core.v1.FollowRequest
import centraid.core.v1.ShareInRequest
import centraid.core.v1.ShareInResponse
import dev.centraid.android.kit.EffectReason
import dev.centraid.android.session.RoomShellEffectPerformer
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.core.ShellEffectAnswers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.ZoneId
import java.util.LinkedHashSet

internal class RoomClient internal constructor(
    private val eventStream: Flow<Event>?,
    private val callCore: suspend (Envelope) -> CoreOutcome<Envelope>,
    private val scope: CoroutineScope,
) {
    constructor(core: CentraidCore, scope: CoroutineScope) : this(core.events, { core.call(it) }, scope)

    internal constructor(callCore: suspend (Envelope) -> CoreOutcome<Envelope>, scope: CoroutineScope) :
        this(null, callCore, scope)
    private val sendLock = Mutex()
    private val effectClaimLock = Any()
    private val claimedRoomEffects = LinkedHashSet<Pair<Long, Long>>()
    private val byTab = MutableStateFlow<Map<String, RoomShown>>(emptyMap())
    private val selectedTab = MutableStateFlow(DEFAULT_TAB)
    private val appearanceState = MutableStateFlow(APPEARANCE_SYSTEM)
    private val noticeState = MutableStateFlow<List<String>>(emptyList())
    @Volatile private var backgrounded = false
    /** Secure snapshots older than this epoch must never re-enter the rendered cache. */
    @Volatile private var minimumSecureEpoch = 0L
    @Volatile var shellEffectPerformer: (suspend (ShellEffect) -> ShellEffectResult)? = null
    @Volatile var followReadPerformer: (suspend (ShellEffect) -> FollowRequest)? = null
    private val roomEffectDispatcher = RoomShellEffectPerformer(::performShellEffect)

    val tabs: StateFlow<Map<String, RoomShown>> = byTab.asStateFlow()
    val activeTab: StateFlow<String> = selectedTab.asStateFlow()
    val appearance: StateFlow<String> = appearanceState.asStateFlow()
    val notices: StateFlow<List<String>> = noticeState.asStateFlow()

    fun attach(): Job {
        val events = eventStream ?: return scope.launch {}
        return scope.launch {
            events.collect { event ->
                event.room?.let(::applyShown)
                event.effect?.let(::performCoreEffect)
                if (event.change?.table == "appearance") loadAppearance()
            }
        }
    }

    suspend fun loadAppearance() {
        val outcome = callCore(
            Envelope(
                request_id = 0,
                request = Request(
                    device = DeviceRequest(get_ = DeviceGet(key = APPEARANCE_KEY)),
                ),
            ),
        )
        val response = (outcome as? CoreOutcome.Answered)?.value?.response?.device ?: return
        appearanceState.value = appearanceValue(response.found, response.value_)
    }

    suspend fun open(key: String, tab: String = DEFAULT_TAB, root: Boolean = false): CoreOutcome<Unit> =
        sendLock.withLock {
            val outcome = callCore(
                Envelope(
                    request_id = 0,
                    request = Request(
                        room = RoomRequest(
                            open_ = RoomOpen(
                                key = key,
                                tab = tab,
                                root = root,
                                platform = PLATFORM,
                                time_zone = ZoneId.systemDefault().id,
                            ),
                        ),
                    ),
                ),
            )
            applyResponse(outcome, asker = null)
        }

    suspend fun send(instance: Long, event: RoomEvent): CoreOutcome<Unit> =
        sendLock.withLock {
            val outcome = callCore(
                Envelope(
                    request_id = 0,
                    request = Request(
                        room = RoomRequest(send = RoomSend(instance = instance, event = event)),
                    ),
                ),
            )
            val result = applyResponse(outcome, asker = instance)
            result
        }

    suspend fun tap(instance: Long, selectorId: String): CoreOutcome<Unit> =
        send(instance, RoomEvent(tap = RoomTap(selector_id = selectorId)))

    suspend fun change(instance: Long, change: RoomChange): CoreOutcome<Unit> =
        send(instance, RoomEvent(change = change))

    suspend fun scrolled(instance: Long, anchorSelectorId: String, fractionMilli: Int): CoreOutcome<Unit> =
        send(
            instance,
            RoomEvent(
                scrolled = RoomScrolled(
                    anchor_selector_id = anchorSelectorId,
                    anchor_fraction_milli = fractionMilli,
                ),
            ),
        )

    suspend fun canvas(instance: Long, event: RoomCanvasEvent): CoreOutcome<Unit> =
        send(instance, RoomEvent(canvas = event))

    suspend fun background() {
        sendLock.withLock {
            // Clear cached secure room protobufs before awaiting native/core work: the system may
            // capture the app switcher image as soon as this callback starts.
            backgrounded = true
            val cachedEpoch = byTab.value.values
                .filter { it.room?.secure == true }
                .maxOfOrNull { it.secure_epoch } ?: 0L
            minimumSecureEpoch = maxOf(minimumSecureEpoch, cachedEpoch) + 1L
            byTab.value = byTab.value.filterValues { it.room?.secure != true }
            val outcome = callCore(
                Envelope(
                    request_id = 0,
                    request = Request(
                        room = RoomRequest(lifecycle = RoomLifecycle(phase = RoomLifecycle.Phase.BACKGROUND)),
                    ),
                ),
            )
            applyResponse(outcome, asker = null)
        }
    }

    suspend fun foreground() {
        sendLock.withLock {
            // Core returns an authoritative locked top for secure tabs. Keep the epoch floor
            // raised while applying it so queued pre-background events cannot win this race.
            val outcome = callCore(
                Envelope(
                    request_id = 0,
                    request = Request(
                        room = RoomRequest(lifecycle = RoomLifecycle(phase = RoomLifecycle.Phase.FOREGROUND)),
                    ),
                ),
            )
            if (outcome is CoreOutcome.Answered) backgrounded = false
            applyResponse(outcome, asker = null)
        }
    }

    suspend fun openDeepLink(url: String, tab: String = activeTab.value): CoreOutcome<Unit> {
        return sendOpen(
            RoomOpen(
                deep_link = url,
                tab = tab,
                root = false,
                platform = PLATFORM,
                time_zone = ZoneId.systemDefault().id,
            ),
        )
    }

    private suspend fun sendOpen(open: RoomOpen): CoreOutcome<Unit> = sendLock.withLock {
        val outcome = callCore(
            Envelope(request_id = 0, request = Request(room = RoomRequest(open_ = open))),
        )
        applyResponse(outcome, asker = null)
    }

    suspend fun drainShareIn(inboxDir: String): CoreOutcome<ShareInResponse> =
        when (
            val outcome = callCore(
                Envelope(
                    request_id = 0,
                    request = Request(share_in = ShareInRequest(inbox_dir = inboxDir)),
                ),
            )
        ) {
            is CoreOutcome.Failed -> outcome
            is CoreOutcome.Answered -> {
                val response = outcome.value.response?.share_in ?: ShareInResponse()
                val kept = response.items
                    .filter { it.fate == centraid.core.v1.ShareInFate.SHARE_IN_FATE_KEPT }
                    .map { it.detail }
                    .filter(String::isNotBlank)
                if (kept.isNotEmpty()) noticeState.value = kept
                CoreOutcome.Answered(response)
            }
        }

    fun dismissNotice() {
        noticeState.value = emptyList()
    }

    fun selectTab(tab: String) {
        selectedTab.value = tab
    }

    private fun applyResponse(outcome: CoreOutcome<Envelope>, asker: Long?): CoreOutcome<Unit> = when (outcome) {
        is CoreOutcome.Failed -> outcome
        is CoreOutcome.Answered -> {
            val room = outcome.value.response?.room
            val priorFloor = minimumSecureEpoch
            val staleRoomResponse = room != null && room.secure_epoch < priorFloor
            room?.takeUnless { staleRoomResponse }?.let {
                val shownEpoch = it.shown.filter { shown -> shown.room?.secure == true }.maxOfOrNull { shown -> shown.secure_epoch } ?: 0L
                minimumSecureEpoch = maxOf(minimumSecureEpoch, it.secure_epoch, shownEpoch)
            }
            room?.shown.orEmpty().forEach(::applyShown)
            val effects = room?.effects.orEmpty().filterNot { effect ->
                staleRoomResponse && (
                    effect.owner_check != null ||
                        effect.clipboard_copy?.clear_owned == true ||
                        effect.clipboard_copy?.sealed_ == true
                    )
            }
            val instance = asker ?: room?.shown?.lastOrNull()?.instance
            if (effects.isNotEmpty() && instance != null) {
                performRoomEffects(instance, effects, room?.secure_epoch ?: minimumSecureEpoch)
            }
            CoreOutcome.Answered(Unit)
        }
    }

    private fun performRoomEffects(instance: Long, effects: List<ShellEffect>, responseEpoch: Long) {
        scope.launch {
            effects.forEach { effect ->
                if (!claimRoomEffect(instance, effect.effect_id)) return@forEach
                // The epoch may advance after the response was accepted but before this coroutine
                // reaches the platform. Never open a stale Locker prompt or restore its clipboard.
                if (isSecureEffect(effect) && responseEpoch < minimumSecureEpoch) return@forEach
                if (effect.store_read != null) {
                    val answer = try {
                        followReadPerformer?.invoke(effect)
                            ?: FollowRequest(
                                verb = centraid.core.v1.FollowVerb.FOLLOW_VERB_PASS,
                                system = effect.store_read!!.system,
                                ask_id = effect.effect_id,
                                grant = centraid.core.v1.FollowGrant.FOLLOW_GRANT_UNAVAILABLE,
                            )
                    } catch (cancelled: kotlinx.coroutines.CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        FollowRequest(
                            verb = centraid.core.v1.FollowVerb.FOLLOW_VERB_PASS,
                            system = effect.store_read!!.system,
                            ask_id = effect.effect_id,
                            grant = centraid.core.v1.FollowGrant.FOLLOW_GRANT_UNAVAILABLE,
                        )
                    }
                    val outcome = callCore(Envelope(request_id = 0, request = Request(follow = answer)))
                    followNotice(outcome)?.let { noticeState.value = listOf(it) }
                } else {
                    roomEffectDispatcher.answer(instance, effect) { target, event -> send(target, event) }
                }
            }
        }
    }

    private fun isSecureEffect(effect: ShellEffect): Boolean =
        effect.owner_check != null || effect.clipboard_copy?.clear_owned == true || effect.clipboard_copy?.sealed_ == true

    /** Room responses can be replayed while the caller is reloading; every effect runs once. */
    private fun claimRoomEffect(instance: Long, effectId: Long): Boolean = synchronized(effectClaimLock) {
        val key = instance to effectId
        if (!claimedRoomEffects.add(key)) return@synchronized false
        while (claimedRoomEffects.size > MAX_CLAIMED_ROOM_EFFECTS) {
            claimedRoomEffects.remove(claimedRoomEffects.first())
        }
        true
    }

    private suspend fun performShellEffect(effect: ShellEffect): ShellEffectResult =
        try {
            shellEffectPerformer?.invoke(effect)
                ?: ShellEffectResult(effect_id = effect.effect_id, failed = ShellFailed(reason = EffectReason.UNAVAILABLE))
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            ShellEffectResult(effect_id = effect.effect_id, failed = ShellFailed(reason = EffectReason.FAILED))
        }

    private fun performCoreEffect(effect: ShellEffect) {
        scope.launch {
            if (effect.store_read == null) {
                shellEffectPerformer?.invoke(effect)
                return@launch
            }
            val answer = try {
                followReadPerformer?.invoke(effect)
                    ?: FollowRequest(
                        verb = centraid.core.v1.FollowVerb.FOLLOW_VERB_PASS,
                        system = effect.store_read!!.system,
                        ask_id = effect.effect_id,
                        grant = centraid.core.v1.FollowGrant.FOLLOW_GRANT_UNAVAILABLE,
                    )
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                FollowRequest(
                    verb = centraid.core.v1.FollowVerb.FOLLOW_VERB_PASS,
                    system = effect.store_read!!.system,
                    ask_id = effect.effect_id,
                    grant = centraid.core.v1.FollowGrant.FOLLOW_GRANT_UNAVAILABLE,
                )
            }
            val outcome = callCore(Envelope(request_id = 0, request = Request(follow = answer)))
            followNotice(outcome)?.let { noticeState.value = listOf(it) }
        }
    }

    private fun applyShown(shown: RoomShown) {
        if (shown.room?.secure == true) {
            if (backgrounded || shown.secure_epoch < minimumSecureEpoch) return
            minimumSecureEpoch = maxOf(minimumSecureEpoch, shown.secure_epoch)
        }
        val tab = shown.tab.ifEmpty { DEFAULT_TAB }
        byTab.value = byTab.value + (tab to shown)
        if (shown.transition != RoomTransition.ROOM_TRANSITION_RELOAD) {
            selectedTab.value = tab
        }
    }

    companion object {
        const val PLATFORM: String = "android"
        const val DEFAULT_TAB: String = "home"
        const val APPEARANCE_KEY: String = "settings.appearance"
        const val APPEARANCE_SYSTEM: String = "system"
        const val APPEARANCE_LIGHT: String = "light"
        const val APPEARANCE_DARK: String = "dark"
        private const val MAX_CLAIMED_ROOM_EFFECTS = 2_048
    }
}

internal fun followNotice(outcome: CoreOutcome<Envelope>): String? {
    val response = (outcome as? CoreOutcome.Answered)?.value?.response?.follow ?: return null
    return response.sentence.takeIf(String::isNotBlank)
}

internal fun appearanceValue(found: Boolean, json: String): String {
    if (!found || json.isEmpty()) return RoomClient.APPEARANCE_SYSTEM
    val parsed = runCatching { Regex("\\\"value\\\"\\s*:\\s*\\\"([^\\\"]*)\\\"").find(json)?.groupValues?.get(1) }
        .getOrDefault(RoomClient.APPEARANCE_SYSTEM)
    return parsed?.takeIf {
        it == RoomClient.APPEARANCE_SYSTEM || it == RoomClient.APPEARANCE_LIGHT || it == RoomClient.APPEARANCE_DARK
    } ?: RoomClient.APPEARANCE_SYSTEM
}
