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
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
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
                        room = RoomRequest(open_ = RoomOpen(key = key, tab = tab, root = root)),
                    ),
                ),
            )
            applyResponse(outcome)
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
            val result = applyResponse(outcome)
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

    fun selectTab(tab: String) {
        selectedTab.value = tab
    }

    private fun applyResponse(outcome: CoreOutcome<Envelope>): CoreOutcome<Unit> = when (outcome) {
        is CoreOutcome.Failed -> outcome
        is CoreOutcome.Answered -> {
            outcome.value.response?.room?.shown.orEmpty().forEach(::applyShown)
            CoreOutcome.Answered(Unit)
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
        const val DEFAULT_TAB: String = "home"
        const val APPEARANCE_KEY: String = "settings.appearance"
        const val APPEARANCE_SYSTEM: String = "system"
        const val APPEARANCE_LIGHT: String = "light"
        const val APPEARANCE_DARK: String = "dark"
    }
}
