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
import centraid.core.v1.ChatEvent
import centraid.core.v1.DocsDriveEvent
import centraid.core.v1.DocsPermission
import centraid.core.v1.HomeEvent
import centraid.core.v1.HomeScheme
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
import dev.centraid.android.kit.AndroidHealth
import dev.centraid.android.kit.TrashScreen
import dev.centraid.android.screens.agenda.AgendaEditorScreen
import dev.centraid.android.screens.agenda.AgendaEventScreen
import dev.centraid.android.screens.agenda.TodoCatchUpScreen
import dev.centraid.android.screens.agenda.TodoDetailScreen
import dev.centraid.android.screens.agenda.TodoListScreen
import dev.centraid.android.screens.agenda.TodoProjectScreen
import dev.centraid.android.screens.backup.BackupHomeScreen
import dev.centraid.android.screens.chat.ChatScreen
import dev.centraid.android.screens.pairing.PairLaptopPage
import dev.centraid.android.screens.words.VaultWordsScreen
import dev.centraid.android.screens.words.WordsEnterPage
import dev.centraid.android.screens.words.WordsShowScreen
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
import dev.centraid.core.Screens
import dev.centraid.android.backup.MediaStoreDeleter
import androidx.compose.runtime.CompositionLocalProvider
import dev.centraid.android.kit.HostScreenEffects
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.LocalShellLine
import dev.centraid.android.kit.ShellBanner
import dev.centraid.android.session.AppSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * THE ONE NAVIGATION ROOT, OVER THE SCREEN RUNTIME (#1135). Every screen on this phone — Home, its
 * search, every app's pages, the chat, the backup and the 24 words — is a `ViewState` this file
 * draws and a `ScreenEvent` it sends. Rust holds the route stack of every tab: Home is the `home`
 * tab's root and an app opens as a page pushed on it, the chat and the backup are tabs of their
 * own, and the band selects among them. This file keeps no stack: it draws `Screens.navigation`,
 * reports a pop (`NavPopped`) and pushes the route a row carried (`NavPush`). It names no
 * destination beyond mapping which `ViewState` arm Rust sent to the composable that draws it.
 *
 * ONE [Screens] FOR THE PROCESS ([AppSession]): the shelf in Rust switches the vault in front by
 * closing and reopening the tabs' roots, so the runtime never changes under this root. The
 * effects are performed by the session ([dev.centraid.android.session.ShellEffects]); this root
 * hands it the activity's half ([HostScreenEffects]) while it is composed.
 *
 * The phone imports' services are the roots of hidden tabs (`imports-*`): never drawn, never in
 * the band, and never "the tab the member is in".
 */
internal class RustRoot(
    private val health: AndroidHealth,
    private val deleter: MediaStoreDeleter,
) {
    private var session: AppSession.Open? = null
    private var scope: CoroutineScope? = null

    /** The runtime, or null before the session opened. Read by composition. */
    private var screens: Screens? by mutableStateOf(null)

    private val docsFiles = DocsFiles(core = { session?.core })

    /** The app whose page the member last had open: the chat's scope while it has nothing to lose. */
    private var lastApp: String = ""

    fun attach(open: AppSession.Open, scope: CoroutineScope) {
        this.session = open
        this.scope = scope
        screens = open.screens
    }

    fun detach() {
        session = null
        screens = null
    }

    // -- navigation: Rust's, reported ------------------------------------------

    /** The tab the member is in: the one Rust has selected (never a hidden service's), else Home's. */
    private fun activeTab(): String {
        val nav = screens?.navigation?.value ?: return TAB
        return nav.selected_tab.takeIf { selected -> !selected.startsWith(HIDDEN) && nav.tabs.any { it.tab == selected } } ?: TAB
    }

    /** The tab whose stack holds `instance`. */
    private fun tabOf(instance: Long): String =
        screens?.navigation?.value?.tabs?.firstOrNull { tab -> tab.entries.any { it.instance == instance } }?.tab ?: TAB

    /** Push the route a row, a tile or the search key carried, on the stack the member is in. */
    fun push(route: Route) {
        val runtime = screens ?: return
        val tab = activeTab()
        scope?.launch { runtime.navigate(NavEvent(push = NavPush(tab = tab, route = route))) }
    }

    /** Tell Home's root something the phone asked for; Home answers with the route to push. */
    private fun tellHome(event: HomeEvent) {
        val runtime = screens ?: return
        scope?.launch {
            val root = runtime.navigation.value?.tabs?.firstOrNull { it.tab == TAB }?.entries?.firstOrNull()?.instance ?: return@launch
            runtime.send(root, ScreenEvent(home = event))
        }
    }

    private fun pop(instance: Long) {
        val runtime = screens ?: return
        val tab = tabOf(instance)
        scope?.launch { runtime.navigate(NavEvent(popped = NavPopped(tab = tab, instance = instance))) }
    }

    /** Back to the tab's root: every page above it goes. */
    private fun popToRoot() {
        val runtime = screens ?: return
        val tab = activeTab()
        scope?.launch { runtime.navigate(NavEvent(pop_to_root = NavPopToRoot(tab = tab))) }
    }

    private fun select(tab: String) {
        val runtime = screens ?: return
        scope?.launch { runtime.navigate(NavEvent(select_tab = NavSelectTab(tab = tab))) }
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
     * THE TOP OF RUST'S STACK, and the platform work around it. A made vault's imports say what came
     * in as the one status line above the band (`imports.made`'s view), until the member closes it or
     * takes its action.
     */
    @Composable
    fun Content(phoneDark: Boolean) {
        val runtime = screens
        val views = runtime?.views?.collectAsState()?.value.orEmpty()
        val navigation = runtime?.navigation?.collectAsState()?.value
        val madeRoot = navigation?.tabs?.firstOrNull { it.tab == MADE_TAB }?.entries?.firstOrNull()?.instance
        val made = madeRoot?.let { views[it]?.imports_made }
        var closed by remember { mutableStateOf("") }
        val sentence = made?.summary.orEmpty().takeIf { it != closed }.orEmpty()
        val line: (@Composable () -> Unit)? = if (sentence.isEmpty()) {
            null
        } else {
            {
                ShellBanner(
                    sentence = sentence,
                    actionLabel = made?.open_label.orEmpty(),
                    closeLabel = if (made?.running == true) "" else KitWords.DISMISS,
                    tag = "imports-made",
                    onAct = {
                        closed = sentence
                        made?.open_route?.let(::push)
                    },
                    onClose = { closed = sentence },
                )
            }
        }
        CompositionLocalProvider(LocalShellLine provides line) { Body(phoneDark) }
    }

    @Composable
    private fun Body(phoneDark: Boolean) {
        val runtime = screens
        if (runtime == null) {
            Box(Modifier.fillMaxSize().background(centraidColor("bg")))
            return
        }
        Globals(runtime)
        val navigation by runtime.navigation.collectAsState()
        val views by runtime.views.collectAsState()
        // THE TAB THE MEMBER IS IN: Rust's selection. Home's stack is the default and the floor.
        val tab = activeTab().let { selected -> if (navigation?.tabs.orEmpty().any { it.tab == selected }) selected else TAB }
        val inChat = tab == CHAT_TAB
        val entries = navigation?.tabs?.firstOrNull { it.tab == tab }?.entries.orEmpty()
        val top = entries.lastOrNull()
        val root = entries.firstOrNull()
        if (top == null || root == null) {
            Box(Modifier.fillMaxSize().background(centraidColor("bg")))
            return
        }
        // THE APP THE MEMBER LAST HAD OPEN scopes the chat while it has nothing to lose.
        if (!inChat) {
            top.route?.screen?.substringBefore('.')?.takeIf { it in CHAT_SCOPES }?.let { lastApp = it }
        }
        // BACK IS RUST'S STACK, AND A BAND IS NOT A STEP IN IT. DISABLED AT A TAB'S ROOT, so the
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
        val homeRoot = runtime.navigation.value?.tabs?.firstOrNull { it.tab == TAB }?.entries?.firstOrNull()?.instance
        LaunchedEffect(homeRoot, phoneDark) {
            val target = homeRoot ?: return@LaunchedEffect
            runtime.send(
                target,
                ScreenEvent(home = HomeEvent(phone_scheme_told = HomeEvent.PhoneSchemeTold(dark = phoneDark))),
            )
        }
        // HOME IS ON SCREEN AGAIN after a cover was popped: the Locker's state and any tile may have
        // moved without a table changing.
        val atRoot = top.instance == root.instance && !inChat
        var cover by remember { mutableStateOf(false) }
        LaunchedEffect(atRoot) {
            if (atRoot && cover) {
                homeRoot?.let { runtime.send(it, ScreenEvent(home = HomeEvent(shown = HomeEvent.Shown()))) }
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
                onEvent = { event -> scope?.launch { runtime.send(top.instance, ScreenEvent(home = event)) } },
                onOpen = ::push,
                onSelectTab = ::select,
            )
            return
        }
        if (top.instance == root.instance) {
            // ANOTHER TAB'S ROOT (the chat, the backup), over the band: a place Rust owns, drawn like Home's.
            androidx.compose.foundation.layout.Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f)) { Page(runtime, view, top.instance) }
                Band(navigation?.band, ::select)
            }
            return
        }
        Page(runtime, view, top.instance)
    }

    /**
     * WHAT THE SHELL DOES WHEREVER THE MEMBER IS: the activity's half of the effects, the app's
     * foreground and background reported (the Locker relocks on leaving; the pass service decides
     * whether coming back is worth a pass), and a request from outside the app (Health Connect's
     * "what this app reads").
     */
    @Composable
    private fun Globals(runtime: Screens) {
        val open = session ?: return
        // A REQUEST FROM OUTSIDE THE APP (Health Connect's "what this app reads"): Home answers it.
        if (HealthRationale.requested) {
            LaunchedEffect(Unit) {
                HealthRationale.requested = false
                tellHome(HomeEvent(entry_asked = HomeEvent.EntryAsked(entry = HomeEvent.EntryAsked.Entry.ENTRY_HEALTH_CONNECT)))
            }
        }
        val pickers = rememberDocsPickers(docsFiles)
        HostScreenEffects(open, pickers, health, deleter, openRoute = ::push)
        val owner = LocalLifecycleOwner.current
        DisposableEffect(owner, runtime) {
            val observer = LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_STOP -> scope?.launch { open.foreground(false) }
                    Lifecycle.Event.ON_START -> scope?.launch { open.foreground(true) }
                    else -> Unit
                }
            }
            owner.lifecycle.addObserver(observer)
            onDispose { owner.lifecycle.removeObserver(observer) }
        }
    }

    /** The vault's name, from Home's bar, for the chat's header. */
    private fun vaultName(runtime: Screens): String {
        val nav = runtime.navigation.value ?: return ""
        val root = nav.tabs.firstOrNull { it.tab == TAB }?.entries?.firstOrNull()?.instance ?: return ""
        return runtime.views.value[root]?.home?.bar?.vault?.name.orEmpty()
    }

    /** The shell's first words to a chat instance: where models live, the vault's name and the scope. */
    private fun openChat(runtime: Screens, instance: Long, app: String, chosen: Boolean, context: Context) {
        scope?.launch {
            runtime.send(
                instance,
                ScreenEvent(
                    chat = ChatEvent(
                        opened = ChatEvent.Opened(
                            app = app,
                            vault_name = vaultName(runtime),
                            scope_chosen = chosen,
                            models_dir = java.io.File(context.filesDir, "models").path,
                        ),
                    ),
                ),
            )
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
        val pairLaptop = view.pair_laptop
        val backupHome = view.backup_home
        val wordsMake = view.words_make
        val wordsEnter = view.words_enter
        val wordsShow = view.words_show

        // THE SCREEN IS DONE (a cancel committed, the editor saved or left, the task deleted): its page goes.
        val done = event?.dismissed == true || editor?.dismissed == true || detail?.finished == true ||
            doc?.dismissed == true || peoplePerson?.done == true || healthConnect?.finished == true ||
            lockerItem?.finished == true || lockerEditor?.finished == true || lockerLock?.finished == true ||
            moneyTarget?.finished == true || moneyImport?.finished == true ||
            wordsMake?.finished == true || wordsEnter?.finished == true || wordsShow?.finished == true
        LaunchedEffect(done) {
            if (done) back()
        }

        val photosHome = view.photos_home
        val photosLightbox = view.photos_lightbox
        val photosEditor = view.photos_editor
        val photosDuplicates = view.photos_duplicates
        val photosReview = view.photos_duplicate_review
        val homeSearch = view.home_search
        val chat = view.chat

        when {
            // THE CHAT (#1135, lane I): the tab's root, or a `chat.ask` / `chat.thread` page. The
            // shell's first event tells it where models live; a tab root also gets the scope of
            // the app the member last had open each time it is shown.
            chat != null -> {
                val atTabRoot = navigationRootIs(runtime, instance)
                LaunchedEffect(instance, if (atTabRoot) lastApp else "") {
                    openChat(runtime, instance, if (atTabRoot) lastApp else "", false, context)
                }
                ChatScreen(
                    state = chat,
                    onEvent = { event -> send(ScreenEvent(chat = event)) },
                    onOpenRoute = open,
                    // A SCOPE CHOSEN from the composer's menu starts a new chat in it.
                    onScope = { chosen -> openChat(runtime, instance, chosen, true, context) },
                )
            }
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
                onWords = { wordsRoute(view)?.let(open) },
                onHome = toHome,
            )
            lockerItem != null -> LockerItemScreen(
                state = lockerItem,
                onEvent = { send(ScreenEvent(locker_item = it)) },
                sendWall = sendWall,
                onOpen = open,
                onWords = { wordsRoute(view)?.let(open) },
                onBack = back,
            )
            lockerEditor != null -> LockerEditorScreen(
                state = lockerEditor,
                onEvent = { send(ScreenEvent(locker_editor = it)) },
                sendWall = sendWall,
                onWords = { wordsRoute(view)?.let(open) },
                onClose = back,
            )
            lockerExport != null -> LockerExportScreen(
                state = lockerExport,
                onEvent = { send(ScreenEvent(locker_export = it)) },
                sendWall = sendWall,
                onWords = { wordsRoute(view)?.let(open) },
                onBack = back,
            )
            lockerImport != null -> LockerImportScreen(
                state = lockerImport,
                onEvent = { send(ScreenEvent(locker_import = it)) },
                sendWall = sendWall,
                onWords = { wordsRoute(view)?.let(open) },
                onBack = back,
            )
            lockerLock != null -> LockerLockPage(
                state = lockerLock,
                send = sendWall,
                onWords = { wordsRoute(view)?.let(open) },
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
                // WHAT THE OS LETS DOCS OFFER, reported as state.
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
            // THE VAULT PLUMBING (#1135, lane H2): the backup, the 24 words and pairing a gateway.
            backupHome != null -> BackupHomeScreen(
                state = backupHome,
                onEvent = { send(ScreenEvent(backup_home = it)) },
                // The rule is written, and the pass service told, by the Backup screen in Rust.
                onOpen = open,
            )
            wordsMake != null -> VaultWordsScreen(
                state = wordsMake,
                onEvent = { send(ScreenEvent(words_make = it)) },
            )
            wordsEnter != null -> WordsEnterPage(
                state = wordsEnter,
                onEvent = { send(ScreenEvent(words_enter = it)) },
            )
            wordsShow != null -> WordsShowScreen(
                state = wordsShow,
                onEvent = { send(ScreenEvent(words_show = it)) },
            )
            // PAIRING A GATEWAY: scan or paste its code (`ScanCode` is the effects performer's).
            pairLaptop != null -> PairLaptopPage(
                state = pairLaptop,
                onEvent = { send(ScreenEvent(pair_laptop = it)) },
                onDone = back,
            )
        }
    }

    /** Whether `instance` is the root of the chat tab (the tab, not a `chat.ask` page above it). */
    private fun navigationRootIs(runtime: Screens, instance: Long): Boolean =
        runtime.navigation.value?.tabs?.firstOrNull { it.tab == CHAT_TAB }?.entries?.firstOrNull()?.instance == instance

    /** What the OS lets Docs' Add sheet offer (the files picker, the camera), reported once per page. */
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
        }
    }

    private companion object {
        /** Rust's one tab for every page this root draws: Home is its root and an app opens on it. */
        const val TAB = "home"

        /** The made vault's imports: its view is the one status line. */
        const val MADE_TAB = "imports-made"

        /** The hidden tabs the phone imports' services are the roots of: never drawn, never selected here. */
        const val HIDDEN = "imports-"

        /** The chat's tab in Rust's runtime (`chat::TAB`); its root is `chat.home`. */
        const val CHAT_TAB = "chat"

        /** The apps a chat can be scoped to (`chat::scopable_apps`), by the prefix of their screens. */
        val CHAT_SCOPES = setOf("agenda", "docs", "health", "locker", "money", "notes", "people", "photos")
    }
}

/** The page a Locker wall's words control opens, Rust's (`LockerWall.words_route`). */
private fun wordsRoute(view: centraid.core.v1.ViewState): Route? = listOfNotNull(
    view.locker_home?.wall,
    view.locker_item?.wall,
    view.locker_editor?.wall,
    view.locker_export?.wall,
    view.locker_import?.wall,
    view.locker_lock?.wall,
).firstNotNullOfOrNull { it.words_route }

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
