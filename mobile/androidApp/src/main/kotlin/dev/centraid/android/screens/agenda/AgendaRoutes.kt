package dev.centraid.android.screens.agenda

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import centraid.core.v1.AgendaDestination
import centraid.core.v1.LockerWallEvent
import centraid.core.v1.DocsDriveEvent
import centraid.core.v1.DocsFollowed
import centraid.core.v1.DocsPermission
import centraid.core.v1.NavEvent
import centraid.core.v1.NavPopToRoot
import centraid.core.v1.NavPopped
import centraid.core.v1.NavPush
import centraid.core.v1.Route
import centraid.core.v1.ScreenEvent
import dev.centraid.android.kit.AndroidHealth
import dev.centraid.android.kit.AndroidPhoneFollow
import dev.centraid.android.kit.PerformScreenEffects
import dev.centraid.android.kit.TrashScreen
import dev.centraid.android.screens.AgendaHomeScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.health.HealthConnectScreen
import dev.centraid.android.screens.health.HealthHomeScreen
import dev.centraid.android.screens.health.HealthMetricScreen
import dev.centraid.android.screens.health.HealthRationale
import dev.centraid.android.screens.health.HealthWorkoutScreen
import dev.centraid.android.screens.docs.DocsDocumentScreen
import dev.centraid.android.screens.docs.DocsDriveScreen
import dev.centraid.android.screens.docs.DocsEditorScreen
import dev.centraid.android.screens.docs.DocsFiles
import dev.centraid.android.screens.docs.DocsVersionsScreen
import dev.centraid.android.screens.docs.rememberDocsPickers
import dev.centraid.shared.nav.DocsEntry
import dev.centraid.shared.nav.HealthEntry
import dev.centraid.android.screens.RouteNav
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
import dev.centraid.core.CentraidCore
import dev.centraid.core.Screens
import dev.centraid.shared.nav.AgendaEntry
import dev.centraid.shared.nav.AppIds
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.LockerEntry
import dev.centraid.shared.nav.MoneyEntry
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.nav.PeopleEntry
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.phone.PhoneSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.Locale
import java.util.TimeZone

/**
 * AGENDA'S ROUTES, OVER THE SCREEN RUNTIME (#1135; #1046, #1128). Agenda's
 * screens are Rust's (`crates/screens/src/agenda`): its home (Day, Schedule,
 * Waiting, To-do), an event, the editor, the to-do pages and the trash are
 * `ViewState`s this file draws and `ScreenEvent`s it sends. It decides nothing
 * a person sees and picks no route.
 *
 * INTERIM HOSTING (the shell lane replaces it). The KMP [NavStack] still drives
 * Home, the other apps and the back stack, and every Agenda page is ONE
 * destination, [Destination.RustScreen], carrying the `Route` Rust built. This
 * keeps the two stacks level: an entry arriving on the KMP stack is pushed to
 * Rust (`NavPush`, tab `agenda`) and the instance it opened is remembered; an
 * entry that leaves it — a back gesture, a header's back, a `dismissed` or
 * `finished` view, Home — is popped in Rust (`NavPopped`). [reconcile] makes
 * that one comparison, after every move of the stack, so no screen has to
 * remember to tell Rust it went. Rust sends `Appeared` itself.
 *
 * ONE [Screens] PER VAULT CORE, built when the session's core is first seen and
 * again if the foreground vault changes; its effects are performed by
 * [PerformScreenEffects], composed from [Global] so a late answer (a calendar
 * read that outlives its page) is still performed.
 */
internal class AgendaRoutes(
    private val phone: AndroidPhoneFollow,
    private val health: AndroidHealth,
    private val openWords: () -> Unit = {},
) : AppRoutes {
    private var session: HomeSession? = null
    private var scope: CoroutineScope? = null

    /** The runtime for the core it was built on, or null before there is one. Read by composition. */
    private var screens: Screens? by mutableStateOf(null)
    private var core: CentraidCore? = null
    private var attached: Job? = null

    /** Rust's agenda stack above its root, one per KMP entry, in order. Read by composition. */
    private val opened = mutableStateListOf<Opened>()
    private val gate = Mutex()
    private var lockNav: RouteNav? = null

    /** A KMP entry and the screen instance Rust opened for it. */
    private class Opened(val entry: Destination.RustScreen, val instance: Long)

    private val docsFiles = DocsFiles()

    override fun handles(destination: Destination): Boolean =
        destination is Destination.RustScreen && PREFIXES.any { destination.route.screen.startsWith(it) }

    // ENTERING AGENDA FROM HOME: its home route, on today (`AgendaEntry`, which the shell lane removes).
    override fun opens(moveId: String): Destination? = when (moveId) {
        AppIds.AGENDA -> AgendaEntry.home(AgendaDestination.AGENDA_DESTINATION_DAY, "")
        AppIds.DOCS -> DocsEntry.home()
        AppIds.PEOPLE -> PeopleEntry.home()
        AppIds.HEALTH -> HealthEntry.home()
        // LOCKER'S TILE: its home, whose wall asks the owner check as it appears.
        AppIds.LOCKER -> LockerEntry.home()
        // MONEY'S TILE: its home, on Spending.
        AppIds.MONEY -> MoneyEntry.home()
        else -> null
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        this.session = session
        this.scope = scope
        docsFiles.attach(session)
        ensureScreens()
    }

    @Composable
    override fun Global(nav: RouteNav) {
        // EVERY MOVE OF THE STACK is compared with what Rust holds.
        val stack = nav.stack
        LaunchedEffect(stack) {
            nav.scope.launch {
                gate.withLock {
                    val runtime = ensureScreens() ?: return@withLock
                    reconcile(runtime, nav.stack)
                }
            }
        }
        // A REQUEST FROM OUTSIDE THE APP (Health Connect's "what this app reads"): the Connect page.
        if (HealthRationale.requested) {
            LaunchedEffect(Unit) {
                HealthRationale.requested = false
                nav.push(HealthEntry.connect())
            }
        }
        val runtime = screens
        if (runtime != null) {
            // AN UNLOCK IS WHEN A VAULT'S OWN KEY CAN BE FILED, and when Home's tile learns the Locker is open.
            val pickers = rememberDocsPickers(docsFiles, onFollowed = { phone.requested(PhoneSource.FILES) })
            PerformScreenEffects(
                runtime,
                phone,
                onAnnounce = { topic ->
                    if (topic == "locker.unlocked") session?.let { LockerEntry.unlocked(it) }
                },
                docs = pickers,
                health = health,
                openRoute = { route -> nav.push(Destination.RustScreen(route)) },
            )
            // THE APP LEAVING THE FOREGROUND RELOCKS THE LOCKER: the core does it, every open screen hears it.
            val owner = LocalLifecycleOwner.current
            DisposableEffect(owner, runtime) {
                val observer = LifecycleEventObserver { _, event ->
                    when (event) {
                        Lifecycle.Event.ON_STOP -> {
                            LockerEntry.setOpen(false)
                            nav.scope.launch { runtime.lifecycle(foreground = false) }
                        }
                        Lifecycle.Event.ON_START -> nav.scope.launch { runtime.lifecycle(foreground = true) }
                        else -> Unit
                    }
                }
                owner.lifecycle.addObserver(observer)
                onDispose { owner.lifecycle.removeObserver(observer) }
            }
        }
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        lockNav = nav
        val entry = destination as? Destination.RustScreen ?: return
        val runtime = screens ?: return
        val instance = opened.firstOrNull { it.entry === entry }?.instance ?: return
        RustHost(runtime, instance, entry, nav)
    }

    /** The 24 words' sheet closed: every Locker wall re-reads whether this core holds keys (a re-key just landed). */
    fun foregrounded() {
        val runtime = screens ?: return
        scope?.launch { runtime.lifecycle(foreground = true) }
    }

    /** The runtime for the foreground vault's core; a new one when the core changed. */
    private fun ensureScreens(): Screens? {
        val live = session?.shelf?.core() ?: return screens
        if (live === core) return screens
        val home = scope ?: return null
        attached?.cancel()
        opened.clear()
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
            // ENTERING LOCKER FROM HOME'S TILE AND CHAT'S KEY SLOT: the one place a lock page is pushed.
            LockerEntry.install()
            LockerEntry.pushLock = { home.launch { lockNav?.push(LockerEntry.lock()) } }
        }
        return next
    }

    /**
     * MAKE RUST'S AGENDA STACK THE KMP STACK'S: the entries both hold, in order,
     * stay; the first that Rust holds and the stack no longer does is popped
     * (with everything above it); each entry the stack holds and Rust does not
     * is pushed. Entries are compared by identity, so the same route pushed twice
     * is two pages.
     */
    private suspend fun reconcile(runtime: Screens, stack: NavStack) {
        val wanted = stack.entries
            .filterIsInstance<Destination.RustScreen>()
            .filter { entry -> PREFIXES.any { entry.route.screen.startsWith(it) } }
        var kept = 0
        while (kept < opened.size && kept < wanted.size && opened[kept].entry === wanted[kept]) kept++
        if (opened.size > kept) {
            runtime.navigate(NavEvent(popped = NavPopped(tab = TAB, instance = opened[kept].instance)))
            while (opened.size > kept) opened.removeAt(opened.lastIndex)
        }
        for (entry in wanted.drop(kept)) {
            runtime.navigate(NavEvent(push = NavPush(tab = TAB, route = entry.route)))
            val top = runtime.navigation.value?.tabs?.firstOrNull { it.tab == TAB }?.entries?.lastOrNull() ?: return
            opened.add(Opened(entry, top.instance))
        }
    }

    /**
     * ONE PAGE: the top of the stack's view state, drawn by which `ViewState` arm Rust
     * sent. A row's route is pushed; a view that is `dismissed` or `finished` is popped.
     */
    @Composable
    private fun RustHost(runtime: Screens, instance: Long, entry: Destination.RustScreen, nav: RouteNav) {
        val context = LocalContext.current
        val views by runtime.views.collectAsState()
        val view = views[instance] ?: return
        val send: (ScreenEvent) -> Unit = { event -> nav.scope.launch { runtime.send(instance, event) } }
        val open: (Route) -> Unit = { route -> nav.push(Destination.RustScreen(route)) }
        val back = { nav.pop() }

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
        val sendWall: (LockerWallEvent) -> Unit = { event -> send(ScreenEvent(locker_wall = event)) }
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
            if (done && nav.stack.current === entry) nav.pop()
        }

        when {
            home != null -> AgendaHomeScreen(
                state = home,
                onEvent = { send(ScreenEvent(agenda_home = it)) },
                onOpen = open,
                onHome = { nav.home() },
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
                onHome = { nav.home() },
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
                onHome = { nav.home() },
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
                    onHome = { nav.home() },
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
                onHome = { nav.home() },
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
                onHome = { nav.home() },
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
                onHome = { nav.home() },
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
        /**
         * Rust's one tab for the pages this host draws, and the prefixes their screen names carry:
         * Agenda's, Docs', Notes', People's and Health's (#1135). Every Rust-owned app's pages ride this stack until the
         * shell lane replaces the KMP one.
         */
        const val TAB = "agenda"
        val PREFIXES = listOf("agenda.", "docs.", "notes.", "people.", "health.", "locker.", "money.")
    }
}

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
