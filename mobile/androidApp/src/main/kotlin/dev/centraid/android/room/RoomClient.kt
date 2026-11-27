package dev.centraid.android.room

import centraid.core.v1.DeviceGet
import centraid.core.v1.DeviceRequest
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.core.v1.RoomCanvasEvent
import centraid.core.v1.RoomChange
import centraid.core.v1.RoomEvent
import centraid.core.v1.RoomOpen
import centraid.core.v1.RoomRequest
import centraid.core.v1.RoomScrolled
import centraid.core.v1.RoomSend
import centraid.core.v1.RoomShown
import centraid.core.v1.RoomTap
import centraid.core.v1.RoomTransition
import centraid.core.v1.ShellEffect
import centraid.core.v1.ShareInRequest
import centraid.core.v1.ShareInResponse
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.core.ShellEffectAnswers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

internal class RoomClient(
    private val core: CentraidCore,
    private val scope: CoroutineScope,
) {
    private val sendLock = Mutex()
    private val byTab = MutableStateFlow<Map<String, RoomShown>>(emptyMap())
    private val selectedTab = MutableStateFlow(DEFAULT_TAB)
    private val appearanceState = MutableStateFlow(APPEARANCE_SYSTEM)

    val tabs: StateFlow<Map<String, RoomShown>> = byTab.asStateFlow()
    val activeTab: StateFlow<String> = selectedTab.asStateFlow()
    val appearance: StateFlow<String> = appearanceState.asStateFlow()

    fun attach(): Job = scope.launch {
        core.events.collect { event ->
            event.room?.let(::applyShown)
            event.effect?.let(::declineCoreEffect)
        }
    }

    suspend fun loadAppearance() {
        val outcome = core.call(
            Envelope(
                request_id = 0,
                request = Request(
                    device = DeviceRequest(get_ = DeviceGet(key = APPEARANCE_KEY)),
                ),
            ),
        )
        val response = (outcome as? CoreOutcome.Answered)?.value?.response?.device ?: return
        if (!response.found || response.value_.isEmpty()) return
        val parsed = runCatching { JSONObject(response.value_).optString("value", APPEARANCE_SYSTEM) }
            .getOrDefault(APPEARANCE_SYSTEM)
        if (parsed.isNotEmpty()) appearanceState.value = parsed
    }

    suspend fun open(key: String, tab: String = DEFAULT_TAB, root: Boolean = false): CoreOutcome<Unit> =
        sendLock.withLock {
            val outcome = core.call(
                Envelope(
                    request_id = 0,
                    request = Request(
                        room = RoomRequest(open_ = RoomOpen(key = key, tab = tab, root = root, platform = PLATFORM)),
                    ),
                ),
            )
            applyResponse(outcome, asker = null)
        }

    suspend fun send(instance: Long, event: RoomEvent): CoreOutcome<Unit> =
        sendLock.withLock {
            val outcome = core.call(
                Envelope(
                    request_id = 0,
                    request = Request(
                        room = RoomRequest(send = RoomSend(instance = instance, event = event)),
                    ),
                ),
            )
            val result = applyResponse(outcome, asker = instance)
            if (event.change?.selector_id == "choice/appearance") {
                loadAppearance()
            }
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

    suspend fun openDeepLink(url: String, tab: String = activeTab.value): CoreOutcome<Unit>? {
        val roomKey = parseDeepLink(url) ?: return null
        return open(key = roomKey, tab = tab, root = false)
    }

    suspend fun drainShareIn(inboxDir: String): CoreOutcome<ShareInResponse> =
        when (
            val outcome = core.call(
                Envelope(
                    request_id = 0,
                    request = Request(share_in = ShareInRequest(inbox_dir = inboxDir)),
                ),
            )
        ) {
            is CoreOutcome.Failed -> outcome
            is CoreOutcome.Answered -> CoreOutcome.Answered(
                outcome.value.response?.share_in ?: ShareInResponse(),
            )
        }

    fun selectTab(tab: String) {
        selectedTab.value = tab
    }

    private fun applyResponse(outcome: CoreOutcome<Envelope>, asker: Long?): CoreOutcome<Unit> = when (outcome) {
        is CoreOutcome.Failed -> outcome
        is CoreOutcome.Answered -> {
            val room = outcome.value.response?.room
            room?.shown.orEmpty().forEach(::applyShown)
            val effects = room?.effects.orEmpty()
            val instance = asker ?: room?.shown?.lastOrNull()?.instance
            if (effects.isNotEmpty() && instance != null) declineRoomEffects(instance, effects)
            CoreOutcome.Answered(Unit)
        }
    }

    private fun declineRoomEffects(instance: Long, effects: List<ShellEffect>) {
        scope.launch {
            effects.forEach { effect ->
                send(instance, ShellEffectAnswers.roomResult(effect))
            }
        }
    }

    private fun declineCoreEffect(effect: ShellEffect) {
        val answer = ShellEffectAnswers.coreAnswer(effect) ?: return
        scope.launch {
            core.call(Envelope(request_id = 0, request = Request(follow = answer)))
        }
    }

    private fun applyShown(shown: RoomShown) {
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
        private const val DEEP_LINK_PREFIX: String = "centraid://"

        fun parseDeepLink(url: String): String? {
            if (!url.startsWith(DEEP_LINK_PREFIX)) return null
            val path = url.removePrefix(DEEP_LINK_PREFIX)
                .substringBefore('?')
                .substringBefore('#')
            val parts = path.split('/')
            if (parts.size != 3 || parts[0] != "open") return null
            val kind = parts[1]
            val id = parts[2]
            if (kind.isEmpty() || !kind.all { it in 'a'..'z' || it in '0'..'9' || it == '_' }) return null
            if (id.isEmpty() || id.length > 64 || !id.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }) return null
            return "$kind/$id"
        }
    }
}
