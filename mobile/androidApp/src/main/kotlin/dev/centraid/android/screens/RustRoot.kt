package dev.centraid.android.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import centraid.core.v1.DataChanged
import centraid.core.v1.HeldVault
import centraid.core.v1.HomeEvent
import centraid.core.v1.HomeStatus
import centraid.core.v1.NavEvent
import centraid.core.v1.NavPopped
import centraid.core.v1.NavPush
import centraid.core.v1.NavSelectTab
import centraid.core.v1.RoomKind
import centraid.core.v1.Route
import centraid.core.v1.ScreenEvent
import centraid.core.v1.ShellBackupStatus
import centraid.core.v1.StatusActed
import centraid.core.v1.VaultCommand
import dev.centraid.android.kit.BackupCheckScreen
import dev.centraid.android.kit.HomeBand
import dev.centraid.android.kit.HostScreenEffects
import dev.centraid.android.kit.LocalStatusActed
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.TransferScreen
import dev.centraid.design.KitWords
import dev.centraid.android.room.RoomClient
import dev.centraid.android.room.RoomView
import dev.centraid.android.screens.backup.BackupHomeScreen
import dev.centraid.android.screens.pairing.PairLaptopPage
import dev.centraid.android.screens.words.VaultWordsScreen
import dev.centraid.android.screens.words.WordsEnterPage
import dev.centraid.android.screens.words.WordsShowScreen
import dev.centraid.android.session.AppSession
import dev.centraid.android.theme.centraidColor
import dev.centraid.core.Screens
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal class RustRoot {
    private var session: AppSession.Open? = null
    private var scope: CoroutineScope? = null
    private var screens: Screens? by mutableStateOf(null)
    private var rooms: RoomClient? by mutableStateOf(null)

    fun attach(open: AppSession.Open, scope: CoroutineScope) {
        this.session = open
        this.scope = scope
        screens = open.screens
        rooms = open.rooms
    }

    fun detach() {
        session = null
        screens = null
        rooms = null
    }

    private fun activeTab(): String {
        val nav = screens?.navigation?.value ?: return TAB
        return nav.selected_tab.takeIf { selected -> !selected.startsWith(HIDDEN) && nav.tabs.any { it.tab == selected } } ?: TAB
    }

    private fun tabOf(instance: Long): String =
        screens?.navigation?.value?.tabs?.firstOrNull { tab -> tab.entries.any { it.instance == instance } }?.tab ?: TAB

    fun push(route: Route) {
        val runtime = screens ?: return
        val tab = activeTab()
        scope?.launch { runtime.navigate(NavEvent(push = NavPush(tab = tab, route = route))) }
    }

    fun askEntry(entry: HomeEvent.EntryAsked.Entry) {
        val runtime = screens ?: return
        scope?.launch {
            val root = runtime.navigation.value?.tabs?.firstOrNull { it.tab == TAB }?.entries?.firstOrNull()?.instance ?: return@launch
            runtime.send(root, ScreenEvent(home = HomeEvent(entry_asked = HomeEvent.EntryAsked(entry = entry))))
        }
    }

    fun makeVault() {
        val runtime = screens ?: return
        scope?.launch {
            val root = runtime.navigation.value?.tabs?.firstOrNull { it.tab == TAB }?.entries?.firstOrNull()?.instance ?: return@launch
            runtime.send(root, ScreenEvent(home = HomeEvent(make = HomeEvent.MakePressed())))
        }
    }

    internal fun vaultCommandMake(cmd: VaultCommand): Any? = cmd.make

    internal fun statusDestination(status: HomeStatus): HomeStatus.Destination = status.destination

    internal fun backupStatusNowMs(status: ShellBackupStatus): Long = status.now_ms

    internal fun changedTables(change: DataChanged): List<String> = change.tables

    internal fun isVaultResting(vault: HeldVault): Boolean = vault.resting

    internal fun isHoldingsLoaded(holdings: centraid.core.v1.Holdings): Boolean = holdings.loaded

    internal fun backupLineConfirmed(line: centraid.core.v1.BackupLine): Long = line.confirmed

    internal fun chatCardEntity(card: centraid.core.v1.ChatCard): String = card.entity

    internal fun wordsMadeLine(state: centraid.core.v1.WordsMakeState): String = state.made_line

    internal fun isWordsDismissed(
        make: centraid.core.v1.WordsMakeEvent?,
        enter: centraid.core.v1.WordsEnterEvent?,
        show: centraid.core.v1.WordsShowEvent?,
    ): Boolean = make?.dismissed != null || enter?.dismissed != null || show?.dismissed != null

    internal fun neededHash(bytes: centraid.core.v1.NeededBytes): String = bytes.content_hash

    internal fun originalsWithheld(vault: centraid.core.v1.ShellVault): Int = vault.originals_withheld

    internal fun tellPhoneScheme(instance: Long, dark: Boolean) {
        val runtime = screens ?: return
        scope?.launch {
            runtime.send(instance, ScreenEvent(home = HomeEvent(phone_scheme_told = HomeEvent.PhoneSchemeTold(dark = dark))))
        }
    }

    internal fun toldVault(told: HomeEvent.VaultsTold): centraid.core.v1.ShellVault? = told.vault

    internal fun searchChromeLabels(chrome: centraid.core.v1.HomeSearchChrome): Pair<String, String> =
        chrome.scope_label to chrome.close_label

    private fun popToRoot() {
        val runtime = screens ?: return
        val tab = activeTab()
        scope?.launch { runtime.navigate(NavEvent(pop_to_root = centraid.core.v1.NavPopToRoot(tab = tab))) }
    }

    private fun pop(instance: Long) {
        val runtime = screens ?: return
        val tab = tabOf(instance)
        scope?.launch { runtime.navigate(NavEvent(popped = NavPopped(tab = tab, instance = instance))) }
    }

    private fun select(tab: String) {
        val runtime = screens ?: return
        scope?.launch { runtime.navigate(NavEvent(select_tab = NavSelectTab(tab = tab))) }
    }

    @Composable
    fun dark(phoneDark: Boolean): Boolean {
        return when (rooms?.appearance?.collectAsState()?.value) {
            RoomClient.APPEARANCE_DARK -> true
            RoomClient.APPEARANCE_LIGHT -> false
            else -> phoneDark
        }
    }

    @Composable
    fun onStage(): Boolean {
        val roomClient = rooms ?: return false
        val tab by roomClient.activeTab.collectAsState()
        val shown by roomClient.tabs.collectAsState()
        return shown[tab]?.room?.kind == RoomKind.ROOM_KIND_STAGE
    }

    @Composable
    fun Content(phoneDark: Boolean) {
        val runtime = screens
        val roomClient = rooms
        if (runtime == null) {
            Box(Modifier.fillMaxSize().background(centraidColor("bg")))
            return
        }
        Globals()
        val navigation by runtime.navigation.collectAsState()
        val views by runtime.views.collectAsState()
        val tab = activeTab().let { selected -> if (navigation?.tabs.orEmpty().any { it.tab == selected }) selected else TAB }
        val entries = navigation?.tabs?.firstOrNull { it.tab == tab }?.entries.orEmpty()
        val top = entries.lastOrNull()
        val root = entries.firstOrNull()

        val view = top?.let { views[it.instance] }
        if (top == null || root == null || view == null || !hasLegacyScreen(view)) {
            if (roomClient != null) {
                RoomHost(roomClient)
            } else {
                Box(Modifier.fillMaxSize().background(Surface.page))
            }
            return
        }

        BackHandler(enabled = entries.size > 1) { pop(top.instance) }
        BackHandler(enabled = entries.size <= 1 && tab != TAB) { select(TAB) }

        if (top.instance == root.instance) {
            Column(Modifier.fillMaxSize().background(Surface.page)) {
                Box(Modifier.weight(1f)) { Page(runtime, view, top.instance) }
                navigation?.band?.let { band -> HomeBand(band.tabs, ::select) }
            }
        } else {
            Page(runtime, view, top.instance)
        }
    }

    @Composable
    private fun RoomHost(roomClient: RoomClient) {
        val tabs by roomClient.tabs.collectAsState()
        val active by roomClient.activeTab.collectAsState()
        val shown = tabs[active]
        val room = shown?.room
        if (shown == null || room == null) {
            Box(Modifier.fillMaxSize().background(Surface.page))
            return
        }
        RoomView(
            room = room,
            onTap = { selectorId -> scope?.launch { roomClient.tap(shown.instance, selectorId) } },
            onChange = { change -> scope?.launch { roomClient.change(shown.instance, change) } },
            onScrolled = { anchor, fraction -> scope?.launch { roomClient.scrolled(shown.instance, anchor, fraction) } },
            onCanvas = { event -> scope?.launch { roomClient.canvas(shown.instance, event) } },
        )
    }

    @Composable
    private fun Globals() {
        val open = session ?: return
        HostScreenEffects(open, ::push)
        val notices by open.rooms.notices.collectAsState()
        if (notices.isNotEmpty()) {
            AlertDialog(
                onDismissRequest = open.rooms::dismissNotice,
                text = { Text(notices.joinToString("\n\n")) },
                confirmButton = {
                    TextButton(onClick = open.rooms::dismissNotice) { Text(KitWords.DONE) }
                },
            )
        }
        val lifecycleOwner = LocalLifecycleOwner.current
        DisposableEffect(lifecycleOwner, open) {
            val observer = LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_START -> scope?.launch { open.foreground(true) }
                    Lifecycle.Event.ON_STOP -> scope?.launch { open.foreground(false) }
                    else -> Unit
                }
            }
            lifecycleOwner.lifecycle.addObserver(observer)
            onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
        }
    }

    private fun hasLegacyScreen(view: centraid.core.v1.ViewState): Boolean =
        view.settings != null ||
            view.transfer != null ||
            view.backup_home != null ||
            view.backup_check != null ||
            view.words_make != null ||
            view.words_enter != null ||
            view.words_show != null ||
            view.pair_laptop != null

    @Composable
    private fun Page(runtime: Screens, view: centraid.core.v1.ViewState, instance: Long) {
        val send: (ScreenEvent) -> Unit = { event -> scope?.launch { runtime.send(instance, event) } }
        val open: (Route) -> Unit = ::push
        val back: () -> Unit = { pop(instance) }
        CompositionLocalProvider(LocalStatusActed provides { send(ScreenEvent(status_acted = StatusActed())) }) {
            when {
                view.settings != null -> SettingsScreen(
                    state = view.settings!!,
                    onEvent = { send(ScreenEvent(settings = it)) },
                    onOpen = open,
                    onBack = back,
                )
                view.transfer != null -> TransferScreen(
                    view = view.transfer!!,
                    onEvent = { send(ScreenEvent(transfer = it)) },
                    onBack = back,
                )
                view.backup_home != null -> BackupHomeScreen(
                    state = view.backup_home!!,
                    onEvent = { send(ScreenEvent(backup_home = it)) },
                    onOpen = open,
                )
                view.backup_check != null -> BackupCheckScreen(
                    state = view.backup_check!!,
                    onEvent = { send(ScreenEvent(backup_check = it)) },
                    onBack = back,
                )
                view.words_make != null -> VaultWordsScreen(
                    state = view.words_make!!,
                    onEvent = { send(ScreenEvent(words_make = it)) },
                )
                view.words_enter != null -> WordsEnterPage(
                    state = view.words_enter!!,
                    onEvent = { send(ScreenEvent(words_enter = it)) },
                )
                view.words_show != null -> WordsShowScreen(
                    state = view.words_show!!,
                    onEvent = { send(ScreenEvent(words_show = it)) },
                )
                view.pair_laptop != null -> PairLaptopPage(
                    state = view.pair_laptop!!,
                    onEvent = { send(ScreenEvent(pair_laptop = it)) },
                    onDone = back,
                )
            }
        }
    }

    private companion object {
        const val TAB = "home"
        const val HIDDEN = "imports-"
    }
}
