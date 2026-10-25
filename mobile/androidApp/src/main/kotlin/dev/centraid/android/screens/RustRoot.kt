package dev.centraid.android.screens

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import centraid.core.v1.DocsDriveEvent
import centraid.core.v1.DocsFollowed
import centraid.core.v1.DocsPermission
import centraid.core.v1.HealthConnectRoute
import centraid.core.v1.HomeBackupLine
import centraid.core.v1.HomeEvent
import centraid.core.v1.HomeScheme
import centraid.core.v1.HomeStatus
import centraid.core.v1.HomeTone
import centraid.core.v1.HomeVaultState
import centraid.core.v1.LockerLockRoute
import centraid.core.v1.LockerWallEvent
import centraid.core.v1.NavEvent
import centraid.core.v1.NavPopToRoot
import centraid.core.v1.NavPopped
import centraid.core.v1.NavPush
import centraid.core.v1.NavSelectTab
import centraid.core.v1.PhotosDestination
import centraid.core.v1.PhotosHomeEvent
import centraid.core.v1.Route
import centraid.core.v1.ScreenEvent
import centraid.core.v1.ShellVault
import centraid.core.v1.VaultCommand
import centraid.screen.v1.BackupLine
import centraid.screen.v1.VaultLockup
import dev.centraid.android.kit.AndroidHealth
import dev.centraid.android.kit.AndroidPhoneFollow
import dev.centraid.android.kit.PerformScreenEffects
import dev.centraid.android.kit.TrashScreen
import dev.centraid.android.screens.agenda.AgendaEditorScreen
import dev.centraid.android.screens.agenda.AgendaEventScreen
import dev.centraid.android.screens.agenda.TodoCatchUpScreen
import dev.centraid.android.screens.agenda.TodoDetailScreen
import dev.centraid.android.screens.agenda.TodoListScreen
import dev.centraid.android.screens.agenda.TodoProjectScreen
import dev.centraid.android.screens.docs.DocsDocumentScreen
import dev.centraid.android.screens.docs.DocsDriveScreen
import dev.centraid.android.screens.docs.DocsEditorScreen
import dev.centraid.android.screens.docs.DocsFiles
import dev.centraid.android.screens.docs.DocsVersionsScreen
import dev.centraid.android.screens.docs.rememberDocsPickers
import dev.centraid.android.screens.health.HealthConnectScreen
import dev.centraid.android.screens.health.HealthHomeScreen
import dev.centraid.android.screens.health.HealthMetricScreen
import dev.centraid.android.screens.health.HealthRationale
import dev.centraid.android.screens.health.HealthWorkoutScreen
import dev.centraid.android.screens.locker.LockerAccessScreen
import dev.centraid.android.screens.locker.LockerEditorScreen
import dev.centraid.android.screens.locker.LockerExportScreen
import dev.centraid.android.screens.locker.LockerHomeScreen
import dev.centraid.android.screens.locker.LockerImportScreen
import dev.centraid.android.screens.locker.LockerItemScreen
import dev.centraid.android.screens.locker.LockerLockPage
import dev.centraid.android.screens.money.MoneyAccountsScreen
import dev.centraid.android.screens.money.MoneyCategoriesScreen
import dev.centraid.android.screens.money.MoneyHomeScreen
import dev.centraid.android.screens.money.MoneyImportScreen
import dev.centraid.android.screens.money.MoneyRecurringScreen
import dev.centraid.android.screens.money.MoneyRulesScreen
import dev.centraid.android.screens.money.MoneySearchScreen
import dev.centraid.android.screens.money.MoneyTargetScreen
import dev.centraid.android.screens.money.MoneyTransactionScreen
import dev.centraid.android.screens.notes.NotesEditorScreen
import dev.centraid.android.screens.notes.NotesHistoryScreen
import dev.centraid.android.screens.notes.NotesHomeScreen
import dev.centraid.android.screens.people.PeopleEditorScreen
import dev.centraid.android.screens.people.PeopleHomeScreen
import dev.centraid.android.screens.people.PeoplePersonScreen
import dev.centraid.android.screens.photos.PhotosDuplicateReviewScreen
import dev.centraid.android.screens.photos.PhotosDuplicatesScreen
import dev.centraid.android.screens.photos.PhotosEditorScreen
import dev.centraid.android.screens.photos.PhotosHomeScreen
import dev.centraid.android.screens.photos.PhotosLightboxScreen
import dev.centraid.android.screens.photos.PhotosShelfFamilyScreen
import dev.centraid.android.theme.centraidColor
import dev.centraid.core.CentraidCore
import dev.centraid.core.Screens
import dev.centraid.shared.nav.LockerEntry
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.PhotosDevice
import dev.centraid.shared.sync.phone.PhoneSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.Locale
import java.util.TimeZone
import centraid.screen.v1.HomeStatus as ShelfStatus

/**
 * THE ONE NAVIGATION ROOT, OVER THE SCREEN RUNTIME (#1135, lane H1). Every
 * screen on this phone that Rust owns — Home, its search, and every app's pages —
 * is a `ViewState` this file draws and a `ScreenEvent` it sends. Rust holds the
 * route stack of the one `home` tab: its root is Home, an app opens as a page
 * pushed on it, and back pops it. This file keeps no stack of its own: it draws
 * `Screens.navigation`, reports a pop (`NavPopped`) and pushes the route a row
 * carried (`NavPush`). It names no destination beyond mapping which `ViewState`
 * arm Rust sent to the composable that draws it.
 *
 * ONE [Screens] PER VAULT CORE, built when the session's core is first seen and
 * again if the foreground vault changes, and ONE performer for every effect
 * ([PerformScreenEffects]) — composed here so a late answer (a calendar read that
 * outlives its page) is still performed, and so no effect is performed twice.
 *
 * WHAT THE SHELF TELLS HOME. The vault files, the roster and the backup line are
 * still the KMP shelf's ([HomeSession.state]); [feedHome] forwards them to Home
 * as facts (`VaultsTold`, `BackupLineTold`, `StatusTold`) and Rust words them.
 * What Home asks of the shelf comes back as one `VaultCommand` effect, performed
 * by [vaultCommand].
 *
 * THE CAMERA ROLL IS THE SHELL'S ([PhotosDevice]): the OS grant and each pass's
 * progress reach Photos' home as events, and what the screen asks of the roll
 * comes back as effects.
 *
 * TRANSITIONAL (lanes I and H2): chat and the Backup tab are still hosted natively
 * beside this root by `MainActivity`; they join it as Rust tabs and that hosting
 * is deleted.
 */
internal class RustRoot(
    private val phone: AndroidPhoneFollow,
    private val health: AndroidHealth,
    private val openWords: () -> Unit,
    /** What Home asks of the shelf: switch, make, restore, forget, rename, open a settings door. */
    private val vaultCommand: (VaultCommand) -> Unit,
) {
    private var session: HomeSession? = null
    private var scope: CoroutineScope? = null

    /** The runtime for the core it was built on, or null before there is one. Read by composition. */
    private var screens: Screens? by mutableStateOf(null)
    private var core: CentraidCore? = null
    private var attached: Job? = null
    private var facts: Job? = null

    private val docsFiles = DocsFiles()

    /** THE DEVICE'S HALF OF PHOTOS: the camera roll (walked once PER VAULT), free up space and an original from the gateway. */
    private val device = PhotosDevice()

    /** What the camera roll last said, replayed to a Photos home that opens after it. */
    private var grant: PhotosHomeEvent? = null
    private var progress: PhotosHomeEvent? = null
    private val told = mutableSetOf<Long>()

    fun attach(session: HomeSession, scope: CoroutineScope) {
        this.session = session
        this.scope = scope
        docsFiles.attach(session)
        // THE CAMERA ROLL FIRST: the screen is told its grant as it opens. **Called
        // exactly once**, because attaching routes a host onto the change stream.
        device.attach(session)
        // THE ROLL'S GRANT AND PROGRESS go to every Photos home that is open.
        device.observe { bytes ->
            val event = PhotosHomeEvent.ADAPTER.decode(bytes)
            if (event.permission != null) grant = event else progress = event
            scope.launch {
                val runtime = screens ?: return@launch
                runtime.views.value.filterValues { it.photos_home != null }.keys
                    .forEach { runtime.send(it, ScreenEvent(photos_home = event)) }
            }
        }
        ensureScreens()
    }

    /**
     * A VAULT WAS JUST MADE and the system's photo prompt was answered
     * (R-ONBOARD-8): read the grant and, when it allows, bring the camera roll
     * in. The prompt itself is the activity's launcher.
     */
    fun photosAnswered() {
        device.perform(PhotosDevice.ACTION_ASK_PERMISSION)
    }

    /** The 24 words' sheet closed: every Locker wall re-reads whether this core holds keys (a re-key just landed). */
    fun foregrounded() {
        val runtime = screens ?: return
        scope?.launch { runtime.lifecycle(foreground = true) }
    }

    // -- navigation: Rust's, reported ------------------------------------------

    /** Push the route a row, a tile or the search key carried. */
    fun push(route: Route) {
        val runtime = screens ?: return
        scope?.launch { runtime.navigate(NavEvent(push = NavPush(tab = TAB, route = route))) }
    }

    private fun pop(instance: Long) {
        val runtime = screens ?: return
        scope?.launch { runtime.navigate(NavEvent(popped = NavPopped(tab = TAB, instance = instance))) }
    }

    /** Back to Home: every page above the root goes. */
    fun popToRoot() {
        val runtime = screens ?: return
        scope?.launch { runtime.navigate(NavEvent(pop_to_root = NavPopToRoot(tab = TAB))) }
    }

    private fun select(tab: String) {
        val runtime = screens ?: return
        scope?.launch { runtime.navigate(NavEvent(select_tab = NavSelectTab(tab = tab))) }
    }

    /** Tell Home a fact the shell holds (an outcome of a rename or a make). */
    fun tell(event: HomeEvent) {
        val runtime = screens ?: return
        scope?.launch {
            val root = runtime.navigation.value?.tabs?.firstOrNull { it.tab == TAB }?.entries?.firstOrNull() ?: return@launch
            runtime.send(root.instance, ScreenEvent(home = event))
        }
    }

    // -- theme: Rust's choice ---------------------------------------------------

    /** Whether the app is dark: the member's choice (Home's appearance key, kept by Rust) or else the phone's. */
    @Composable
    fun dark(phoneDark: Boolean): Boolean {
        val runtime = screens ?: return phoneDark
        val views by runtime.views.collectAsState()
        val navigation by runtime.navigation.collectAsState()
        val root = navigation?.tabs?.firstOrNull { it.tab == TAB }?.entries?.firstOrNull()?.instance
        return when (root?.let { views[it]?.home?.scheme }) {
            HomeScheme.HOME_SCHEME_DARK -> true
            HomeScheme.HOME_SCHEME_LIGHT -> false
            else -> phoneDark
        }
    }

    /** Whether the page on top stands on the photograph's stage (edge to edge, light bar icons). */
    @Composable
    fun onStage(): Boolean {
        val runtime = screens ?: return false
        val views by runtime.views.collectAsState()
        val navigation by runtime.navigation.collectAsState()
        val top = navigation?.tabs?.firstOrNull { it.tab == TAB }?.entries?.lastOrNull()?.instance
        val view = top?.let { views[it] } ?: return false
        return view.photos_lightbox != null || view.photos_editor != null
    }

    // -- the root ---------------------------------------------------------------

    /**
     * THE TOP OF RUST'S STACK, and the platform work around it. The Backup tab is
     * still the native one (TRANSITIONAL, lane H2): while it shows, Home draws it.
     */
    @Composable
    fun Content(
        phoneDark: Boolean,
        backupShown: Boolean,
        onOpenBackup: () -> Unit,
        onOpenHome: () -> Unit,
        backupTab: @Composable () -> Unit,
        onDownloadSettings: () -> Unit,
    ) {
        val runtime = screens
        if (runtime == null) {
            Box(Modifier.fillMaxSize().background(centraidColor("bg")))
            return
        }
        Globals(runtime)
        val navigation by runtime.navigation.collectAsState()
        val views by runtime.views.collectAsState()
        val entries = navigation?.tabs?.firstOrNull { it.tab == TAB }?.entries.orEmpty()
        val top = entries.lastOrNull()
        val root = entries.firstOrNull()
        if (top == null || root == null) {
            Box(Modifier.fillMaxSize().background(centraidColor("bg")))
            return
        }
        // BACK IS RUST'S STACK, AND A BAND IS NOT A STEP IN IT. DISABLED AT HOME, so the
        // floor keeps the platform's own meaning: back out of the app. Photos' Collections
        // and Search are places of ONE Rust screen, so back returns it to its library first.
        BackHandler(enabled = entries.size > 1) {
            val photos = views[top.instance]?.photos_home
            if (photos != null &&
                photos.destination != PhotosDestination.PHOTOS_DESTINATION_LIBRARY &&
                photos.destination != PhotosDestination.PHOTOS_DESTINATION_UNSPECIFIED
            ) {
                scope?.launch {
                    runtime.send(
                        top.instance,
                        ScreenEvent(photos_home = PhotosHomeEvent(destination = PhotosDestination.PHOTOS_DESTINATION_LIBRARY)),
                    )
                }
            } else {
                pop(top.instance)
            }
        }
        // WHAT HOME NEEDS TO BE TOLD THE PHONE DOES: its own scheme, once it is open and when it moves.
        LaunchedEffect(root.instance, phoneDark) {
            runtime.send(
                root.instance,
                ScreenEvent(home = HomeEvent(phone_scheme_told = HomeEvent.PhoneSchemeTold(dark = phoneDark))),
            )
        }
        // HOME IS ON SCREEN AGAIN after a cover was popped: the Locker's state and any tile may have
        // moved without a table changing.
        val atRoot = top.instance == root.instance
        var cover by remember { mutableStateOf(false) }
        LaunchedEffect(atRoot) {
            if (atRoot && cover) {
                runtime.send(root.instance, ScreenEvent(home = HomeEvent(shown = HomeEvent.Shown())))
            }
            cover = !atRoot
        }
        val view = views[top.instance] ?: run {
            Box(Modifier.fillMaxSize().background(centraidColor("bg")))
            return
        }
        val home = view.home
        if (home != null) {
            HomeScreen(
                state = home,
                band = navigation?.band,
                runtimeTabs = navigation?.tabs.orEmpty().map { it.tab }.toSet(),
                onEvent = { event -> scope?.launch { runtime.send(top.instance, ScreenEvent(home = event)) } },
                onOpen = ::push,
                onSelectTab = ::select,
                onDownloadSettings = onDownloadSettings,
                onOpenBackup = onOpenBackup,
                backupShown = backupShown,
                onOpenHome = onOpenHome,
                backupTab = backupTab,
            )
            return
        }
        Page(runtime, view, top.instance)
    }

    /**
     * WHAT THE SHELL PERFORMS WHEREVER THE MEMBER IS: every effect Rust asks for (one performer for
     * the one runtime), the Locker's relock when the app leaves the foreground, and a request from
     * outside the app (Health Connect's "what this app reads").
     */
    @Composable
    private fun Globals(runtime: Screens) {
        // A REQUEST FROM OUTSIDE THE APP (Health Connect's "what this app reads"): the Connect page.
        // GAP: this is a deep link and Kotlin names the page; Rust has no inbound-route event yet.
        if (HealthRationale.requested) {
            LaunchedEffect(Unit) {
                HealthRationale.requested = false
                push(Route(screen = "health.connect", health_connect = HealthConnectRoute(parent = "")))
            }
        }
        // AN UNLOCK IS WHEN A VAULT'S OWN KEY CAN BE FILED, and when Home's tile learns the Locker is open.
        val pickers = rememberDocsPickers(docsFiles, onFollowed = { phone.requested(PhoneSource.FILES) })
        PerformScreenEffects(
            runtime,
            phone,
            photos = device,
            onAnnounce = { topic ->
                if (topic == "locker.unlocked") session?.let { LockerEntry.unlocked(it) }
            },
            docs = pickers,
            health = health,
            openRoute = ::push,
            vaultCommand = vaultCommand,
        )
        // THE APP LEAVING THE FOREGROUND RELOCKS THE LOCKER: the core does it, every open screen hears it.
        val owner = LocalLifecycleOwner.current
        DisposableEffect(owner, runtime) {
            val observer = LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_STOP -> {
                        LockerEntry.setOpen(false)
                        scope?.launch { runtime.lifecycle(foreground = false) }
                    }
                    Lifecycle.Event.ON_START -> scope?.launch { runtime.lifecycle(foreground = true) }
                    else -> Unit
                }
            }
            owner.lifecycle.addObserver(observer)
            onDispose { owner.lifecycle.removeObserver(observer) }
        }
    }

    /** The runtime for the foreground vault's core; a new one when the core changed. */
    private fun ensureScreens(): Screens? {
        val live = session?.shelf?.core() ?: return screens
        if (live === core) return screens
        val home = scope ?: return null
        attached?.cancel()
        facts?.cancel()
        told.clear()
        val next = Screens(live, home)
        core = live
        screens = next
        attached = next.attach()
        home.launch {
            // THE DEVICE'S LOCALE AND ZONE, then the tabs' roots, then any page a
            // previous run of this process left open above them is closed.
            next.environment(Locale.getDefault().toLanguageTag(), TimeZone.getDefault().id)
            next.start()
            next.navigate(NavEvent(pop_to_root = NavPopToRoot(tab = TAB)))
            // ENTERING LOCKER FROM CHAT'S KEY SLOT: the one place a lock page is pushed.
            LockerEntry.install()
            LockerEntry.pushLock = { home.launch { push(Route(screen = "locker.lock", locker_lock = LockerLockRoute())) } }
        }
        // A PHOTOS HOME THAT OPENS LATER IS TOLD WHAT THE ROLL ALREADY SAID.
        home.launch {
            next.views.collect { views ->
                views.filterValues { it.photos_home != null }.keys
                    .filter { told.add(it) }
                    .forEach { instance ->
                        grant?.let { next.send(instance, ScreenEvent(photos_home = it)) }
                        progress?.let { next.send(instance, ScreenEvent(photos_home = it)) }
                    }
            }
        }
        facts = feedHome(next, session ?: return next, home)
        return next
    }

    /**
     * THE SHELF'S FACTS, TOLD TO HOME. The vault in front, the roster, the backup line and the
     * ribbon are the KMP shelf's; whenever they change Home is told them as given. Home sorts
     * nothing and words them itself.
     */
    private fun feedHome(runtime: Screens, shelf: HomeSession, scope: CoroutineScope): Job = scope.launch {
        val root = runtime.navigation.filterNotNull()
            .first { nav -> nav.tabs.any { it.tab == TAB && it.entries.isNotEmpty() } }
            .tabs.first { it.tab == TAB }.entries.first().instance
        var lastVaults: HomeEvent.VaultsTold? = null
        var lastLine: HomeBackupLine? = null
        var lastRibbon: HomeStatus? = null
        shelf.state.collect { kmp ->
            val now = HomeEvent.VaultsTold(
                vault = kmp.vault?.takeIf { it.vault_id.isNotEmpty() }?.let(::shellVault),
                vaults = kmp.vaults.filter { it.vault_id.isNotEmpty() }.map(::shellVault),
                // A phone with no vault is the shelf's failed Home; a lockup still landing is neither.
                none = kmp.data_ == null && kmp.failure != null,
            )
            if (now != lastVaults && (now.vault != null || now.none)) {
                lastVaults = now
                runtime.send(root, ScreenEvent(home = HomeEvent(vaults_told = now)))
            }
            val backup = kmp.backup_line?.let(::backupLine)
            if (backup != lastLine) {
                lastLine = backup
                runtime.send(root, ScreenEvent(home = HomeEvent(backup_told = HomeEvent.BackupLineTold(line = backup))))
            }
            val status = kmp.data_?.status?.let(::ribbon)
            if (status != lastRibbon) {
                lastRibbon = status
                runtime.send(root, ScreenEvent(home = HomeEvent(status_told = HomeEvent.StatusTold(status = status))))
            }
        }
    }

    /**
     * ONE PAGE: the top of the stack's view state, drawn by which `ViewState` arm Rust
     * sent. A row's route is pushed; a view that is `dismissed` or `finished` is popped.
     */
    @Composable
    private fun Page(runtime: Screens, view: centraid.core.v1.ViewState, instance: Long) {
        val context = LocalContext.current
        val send: (ScreenEvent) -> Unit = { event -> scope?.launch { runtime.send(instance, event) } }
        val open: (Route) -> Unit = ::push
        val back = { pop(instance) }
        val toHome = { popToRoot() }
        val sendWall: (LockerWallEvent) -> Unit = { event -> send(ScreenEvent(locker_wall = event)) }

        // THE SHELF FAMILY (a shelf, the picker, places) draws itself; the rest is below.
        if (PhotosShelfFamilyScreen(view, send, open) { back() }) return

        val home = view.agenda_home
        val event = view.agenda_event
        val editor = view.agenda_editor
        val list = view.todo_list
        val project = view.todo_project
        val detail = view.todo_detail
        val catchUp = view.todo_catch_up
        val trash = view.trash
        val lockerHome = view.locker_home
        val lockerItem = view.locker_item
        val lockerEditor = view.locker_editor
        val lockerAccess = view.locker_access
        val lockerExport = view.locker_export
        val lockerImport = view.locker_import
        val lockerLock = view.locker_lock
        val moneyHome = view.money_home
        val moneyTransaction = view.money_transaction
        val moneyTarget = view.money_target
        val moneyRecurring = view.money_recurring
        val moneyAccounts = view.money_accounts
        val moneyRules = view.money_rules
        val moneyCategories = view.money_categories
        val moneyImport = view.money_import
        val moneySearch = view.money_search
        val drive = view.docs_drive
        val doc = view.docs_document
        val versions = view.docs_versions
        val docEditor = view.docs_editor
        val notesHome = view.notes_home
        val notesEditor = view.notes_editor
        val notesHistory = view.notes_history
        val peopleHome = view.people_home
        val peoplePerson = view.people_person
        val peopleEditor = view.people_editor
        val healthHome = view.health_home
        val healthMetric = view.health_metric
        val healthWorkout = view.health_workout
        val healthConnect = view.health_connect

        // THE SCREEN IS DONE (a cancel committed, the editor saved or left, the task deleted): its page goes.
        val done = event?.dismissed == true || editor?.dismissed == true || detail?.finished == true ||
            doc?.dismissed == true || peoplePerson?.done == true || healthConnect?.finished == true ||
            lockerItem?.finished == true || lockerEditor?.finished == true || lockerLock?.finished == true ||
            moneyTarget?.finished == true || moneyImport?.finished == true
        LaunchedEffect(done) {
            if (done) back()
        }

        val photosHome = view.photos_home
        val photosLightbox = view.photos_lightbox
        val photosEditor = view.photos_editor
        val photosDuplicates = view.photos_duplicates
        val photosReview = view.photos_duplicate_review
        val homeSearch = view.home_search

        when {
            home != null -> AgendaHomeScreen(
                state = home,
                onEvent = { send(ScreenEvent(agenda_home = it)) },
                onOpen = open,
                onHome = toHome,
            )
            event != null -> AgendaEventScreen(
                state = event,
                onEvent = { send(ScreenEvent(agenda_event = it)) },
                onOpen = open,
                onBack = back,
                onCall = { uri -> openCall(context, uri) },
            )
            editor != null -> AgendaEditorScreen(
                state = editor,
                onEvent = { send(ScreenEvent(agenda_editor = it)) },
            )
            list != null -> TodoListScreen(
                state = list,
                onEvent = { send(ScreenEvent(todo_list = it)) },
                onOpen = open,
                onBack = back,
            )
            project != null -> TodoProjectScreen(
                state = project,
                onEvent = { send(ScreenEvent(todo_project = it)) },
                onOpen = open,
                onBack = back,
            )
            detail != null -> TodoDetailScreen(
                state = detail,
                onEvent = { send(ScreenEvent(todo_detail = it)) },
                onOpen = open,
                // CLOSE = DONE: the pop; Rust flushes the autosave when it sees the page leave.
                onClose = back,
            )
            catchUp != null -> TodoCatchUpScreen(
                state = catchUp,
                onEvent = { send(ScreenEvent(todo_catch_up = it)) },
                onOpen = open,
                onBack = back,
            )
            lockerHome != null -> LockerHomeScreen(
                state = lockerHome,
                onEvent = { send(ScreenEvent(locker_home = it)) },
                sendWall = sendWall,
                onOpen = open,
                onWords = openWords,
                onHome = toHome,
            )
            lockerItem != null -> LockerItemScreen(
                state = lockerItem,
                onEvent = { send(ScreenEvent(locker_item = it)) },
                sendWall = sendWall,
                onOpen = open,
                onWords = openWords,
                onBack = back,
            )
            lockerEditor != null -> LockerEditorScreen(
                state = lockerEditor,
                onEvent = { send(ScreenEvent(locker_editor = it)) },
                sendWall = sendWall,
                onWords = openWords,
                onClose = back,
            )
            lockerAccess != null -> LockerAccessScreen(
                state = lockerAccess,
                onEvent = { send(ScreenEvent(locker_access = it)) },
                sendWall = sendWall,
                onWords = openWords,
                onBack = back,
            )
            lockerExport != null -> LockerExportScreen(
                state = lockerExport,
                onEvent = { send(ScreenEvent(locker_export = it)) },
                sendWall = sendWall,
                onWords = openWords,
                onBack = back,
            )
            lockerImport != null -> LockerImportScreen(
                state = lockerImport,
                onEvent = { send(ScreenEvent(locker_import = it)) },
                sendWall = sendWall,
                onWords = openWords,
                onBack = back,
            )
            lockerLock != null -> LockerLockPage(
                state = lockerLock,
                send = sendWall,
                onWords = openWords,
                onClose = back,
            )
            moneyHome != null -> MoneyHomeScreen(
                state = moneyHome,
                onEvent = { send(ScreenEvent(money_home = it)) },
                onOpen = open,
                onHome = toHome,
            )
            moneyTransaction != null -> MoneyTransactionScreen(
                state = moneyTransaction,
                onEvent = { send(ScreenEvent(money_transaction = it)) },
                onBack = back,
            )
            moneyTarget != null -> MoneyTargetScreen(
                state = moneyTarget,
                onEvent = { send(ScreenEvent(money_target = it)) },
                onBack = back,
            )
            moneyRecurring != null -> MoneyRecurringScreen(
                state = moneyRecurring,
                onEvent = { send(ScreenEvent(money_recurring = it)) },
                onBack = back,
            )
            moneyAccounts != null -> MoneyAccountsScreen(
                state = moneyAccounts,
                onEvent = { send(ScreenEvent(money_accounts = it)) },
                onBack = back,
            )
            moneyRules != null -> MoneyRulesScreen(
                state = moneyRules,
                onEvent = { send(ScreenEvent(money_rules = it)) },
                onBack = back,
            )
            moneyCategories != null -> MoneyCategoriesScreen(
                state = moneyCategories,
                onEvent = { send(ScreenEvent(money_categories = it)) },
                onBack = back,
            )
            moneyImport != null -> MoneyImportScreen(
                state = moneyImport,
                onEvent = { send(ScreenEvent(money_import = it)) },
                onOpen = open,
                onBack = back,
            )
            moneySearch != null -> MoneySearchScreen(
                state = moneySearch,
                onEvent = { send(ScreenEvent(money_search = it)) },
                onOpen = open,
                onBack = back,
            )
            drive != null -> {
                // WHAT THE OS LETS DOCS OFFER, and the folders followed, reported as state.
                DocsReports(instance, send)
                DocsDriveScreen(
                    state = drive,
                    onEvent = { send(ScreenEvent(docs_drive = it)) },
                    onOpen = open,
                    onHome = toHome,
                    onBack = back,
                )
            }
            doc != null -> DocsDocumentScreen(
                state = doc,
                onEvent = { send(ScreenEvent(docs_document = it)) },
                onOpen = open,
                onBack = back,
            )
            versions != null -> DocsVersionsScreen(
                state = versions,
                onEvent = { send(ScreenEvent(docs_versions = it)) },
                onBack = back,
            )
            docEditor != null -> DocsEditorScreen(
                state = docEditor,
                onEvent = { send(ScreenEvent(docs_editor = it)) },
                onClose = back,
            )
            notesHome != null -> NotesHomeScreen(
                state = notesHome,
                onEvent = { send(ScreenEvent(notes_home = it)) },
                onOpen = open,
                onHome = toHome,
            )
            // CLOSE = DONE: the pop; Rust flushes the autosave when it sees the page leave.
            notesEditor != null -> NotesEditorScreen(
                state = notesEditor,
                onEvent = { send(ScreenEvent(notes_editor = it)) },
                onOpen = open,
                onClose = back,
            )
            notesHistory != null -> NotesHistoryScreen(
                state = notesHistory,
                onEvent = { send(ScreenEvent(notes_history = it)) },
                onBack = back,
            )
            peopleHome != null -> PeopleHomeScreen(
                state = peopleHome,
                onEvent = { send(ScreenEvent(people_home = it)) },
                onOpen = open,
                onHome = toHome,
            )
            peoplePerson != null -> PeoplePersonScreen(
                state = peoplePerson,
                onEvent = { send(ScreenEvent(people_person = it)) },
                onOpen = open,
                onBack = back,
            )
            // CLOSE = DONE: the pop; Rust flushes the autosave when it sees the page leave.
            peopleEditor != null -> PeopleEditorScreen(
                state = peopleEditor,
                onEvent = { send(ScreenEvent(people_editor = it)) },
                onClose = back,
            )
            healthHome != null -> HealthHomeScreen(
                state = healthHome,
                onEvent = { send(ScreenEvent(health_home = it)) },
                onOpen = open,
                onHome = toHome,
            )
            healthMetric != null -> HealthMetricScreen(
                state = healthMetric,
                onEvent = { send(ScreenEvent(health_metric = it)) },
                onBack = back,
            )
            healthWorkout != null -> HealthWorkoutScreen(
                state = healthWorkout,
                onEvent = { send(ScreenEvent(health_workout = it)) },
                onBack = back,
            )
            healthConnect != null -> HealthConnectScreen(
                state = healthConnect,
                onEvent = { send(ScreenEvent(health_connect = it)) },
                onBack = back,
            )
            // PHOTOS (#1135): its home, the lightbox, the editor and the duplicates. The shelf
            // family (a shelf, the picker, places) drew itself above.
            photosHome != null -> PhotosHomeScreen(
                state = photosHome,
                onEvent = { send(ScreenEvent(photos_home = it)) },
                onOpen = open,
                onHome = toHome,
                onResume = { device.opened() },
            )
            photosLightbox != null -> {
                // A deleted-for-good photograph leaves its own room.
                LaunchedEffect(photosLightbox.dismissed) { if (photosLightbox.dismissed) back() }
                PhotosLightboxScreen(
                    state = photosLightbox,
                    onEvent = { send(ScreenEvent(photos_lightbox = it)) },
                    onOpen = open,
                    onClose = back,
                )
            }
            photosEditor != null -> PhotosEditorScreen(
                state = photosEditor,
                onEvent = { send(ScreenEvent(photos_editor = it)) },
                onClose = back,
                // The saved photograph replaces the editor, so back lands on the lightbox it came from.
                onSaved = { route ->
                    scope?.launch {
                        runtime.navigate(NavEvent(popped = NavPopped(tab = TAB, instance = instance)))
                        runtime.navigate(NavEvent(push = NavPush(tab = TAB, route = route)))
                    }
                },
            )
            photosDuplicates != null -> PhotosDuplicatesScreen(
                state = photosDuplicates,
                onEvent = { send(ScreenEvent(photos_duplicates = it)) },
                onOpen = open,
                onBack = back,
            )
            photosReview != null -> PhotosDuplicateReviewScreen(
                state = photosReview,
                onEvent = { send(ScreenEvent(photos_duplicate_review = it)) },
                onBack = back,
            )
            // HOME'S SEARCH (R-CHROME-6): a Rust screen like the rest.
            homeSearch != null -> HomeSearchScreen(
                state = homeSearch,
                onEvent = { send(ScreenEvent(home_search = it)) },
                onOpen = open,
                onCancel = back,
            )
            trash != null -> TrashScreen(
                view = trash,
                onEvent = { send(ScreenEvent(trash = it)) },
                onBack = back,
            )
        }
    }

    /** The permission and the followed list Docs' drive shows, reported once per page. */
    @Composable
    private fun DocsReports(instance: Long, send: (ScreenEvent) -> Unit) {
        val context = LocalContext.current
        LaunchedEffect(instance) {
            val camera = if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
                DocsPermission.DOCS_PERMISSION_GRANTED
            } else {
                DocsPermission.DOCS_PERMISSION_UNAVAILABLE
            }
            send(ScreenEvent(docs_drive = DocsDriveEvent(permission = DocsDriveEvent.PermissionChanged(
                surface = DocsDriveEvent.PermissionChanged.Surface.SURFACE_FILES,
                permission = DocsPermission.DOCS_PERMISSION_GRANTED,
            ))))
            send(ScreenEvent(docs_drive = DocsDriveEvent(permission = DocsDriveEvent.PermissionChanged(
                surface = DocsDriveEvent.PermissionChanged.Surface.SURFACE_CAMERA,
                permission = camera,
            ))))
            docsFiles.follow.followed { folders ->
                val followed = folders.map { DocsFollowed(origin_id = it.originId, name = it.name, documents = it.documents) }
                send(ScreenEvent(docs_drive = DocsDriveEvent(followed_changed = DocsDriveEvent.FollowedChanged(followed = followed))))
            }
        }
    }

    private companion object {
        /** Rust's one tab for every page this root draws: Home is its root and an app opens on it. */
        const val TAB = "home"
    }
}

/** A shelf lockup, as the fact Home is told: ids, names and states, no words. */
private fun shellVault(lockup: VaultLockup): ShellVault = ShellVault(
    vault_id = lockup.vault_id,
    name = lockup.vault_name,
    color = lockup.color,
    state = when (lockup.state) {
        VaultLockup.State.STATE_ONLINE -> HomeVaultState.HOME_VAULT_STATE_ONLINE
        VaultLockup.State.STATE_FROZEN -> HomeVaultState.HOME_VAULT_STATE_FROZEN
        VaultLockup.State.STATE_UNSPECIFIED -> HomeVaultState.HOME_VAULT_STATE_UNSPECIFIED
    },
    originals_withheld = lockup.originals_withheld,
)

private fun tone(tone: BackupLine.Tone): HomeTone = when (tone) {
    BackupLine.Tone.TONE_QUIET -> HomeTone.HOME_TONE_QUIET
    BackupLine.Tone.TONE_ATTENTION -> HomeTone.HOME_TONE_ATTENTION
    BackupLine.Tone.TONE_URGENT -> HomeTone.HOME_TONE_URGENT
    BackupLine.Tone.TONE_UNSPECIFIED -> HomeTone.HOME_TONE_UNSPECIFIED
}

/** The backup's finished line (the backup lane words it), as Home is told it. */
private fun backupLine(line: BackupLine): HomeBackupLine =
    HomeBackupLine(status = line.status, tone = tone(line.tone), accessibility_label = line.accessibility_label)

/** The shelf's ribbon (a stranded write, a low disk), as Home is told it. */
private fun ribbon(status: ShelfStatus): HomeStatus = HomeStatus(
    tone = when (status.tone) {
        ShelfStatus.Tone.TONE_QUIET -> HomeTone.HOME_TONE_QUIET
        ShelfStatus.Tone.TONE_ATTENTION -> HomeTone.HOME_TONE_ATTENTION
        ShelfStatus.Tone.TONE_URGENT -> HomeTone.HOME_TONE_URGENT
        ShelfStatus.Tone.TONE_UNSPECIFIED -> HomeTone.HOME_TONE_UNSPECIFIED
    },
    copy = status.copy,
    action = status.action,
    destination = when (status.destination) {
        ShelfStatus.Destination.DESTINATION_NONE -> HomeStatus.Destination.DESTINATION_NONE
        ShelfStatus.Destination.DESTINATION_PHONE -> HomeStatus.Destination.DESTINATION_PHONE
        ShelfStatus.Destination.DESTINATION_NOTIFICATIONS -> HomeStatus.Destination.DESTINATION_NOTIFICATIONS
        ShelfStatus.Destination.DESTINATION_BACKUP -> HomeStatus.Destination.DESTINATION_BACKUP
        ShelfStatus.Destination.DESTINATION_UNSPECIFIED -> HomeStatus.Destination.DESTINATION_UNSPECIFIED
    },
)


/**
 * THE CALL LINK, HANDED OFF: `call_uri` is the event's own link (a meeting URL
 * or `tel:`), opened by whatever app on this phone answers it. Nothing joins
 * from here; with no app to answer, the button stays as it was.
 */
private fun openCall(context: Context, uri: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
    } catch (_: ActivityNotFoundException) {
        // No app on this phone opens the link.
    }
}
