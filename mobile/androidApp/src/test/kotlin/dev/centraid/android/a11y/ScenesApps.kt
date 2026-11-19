package dev.centraid.android.a11y

import centraid.core.v1.AgendaBandTab
import centraid.core.v1.AgendaChrome
import centraid.core.v1.AgendaDestination
import centraid.core.v1.AgendaHomeData
import centraid.core.v1.AgendaHomeState
import centraid.core.v1.AgendaMoreRow
import centraid.core.v1.AgendaTodo
import centraid.core.v1.AgendaToolbar
import centraid.core.v1.BackupHomeData
import centraid.core.v1.BackupHomeState
import centraid.core.v1.BackupLine
import centraid.core.v1.BackupRuleChoice
import centraid.core.v1.DocsAction
import centraid.core.v1.DocsActionList
import centraid.core.v1.DocsBandTab
import centraid.core.v1.DocsDestination
import centraid.core.v1.DocsDriveChrome
import centraid.core.v1.DocsDriveData
import centraid.core.v1.DocsDriveState
import centraid.core.v1.DocsRowView
import centraid.core.v1.DocsSearchField
import centraid.core.v1.DocsSheet
import centraid.core.v1.HealthBandTab
import centraid.core.v1.HealthDestination
import centraid.core.v1.HealthHomeChrome
import centraid.core.v1.HealthHomeData
import centraid.core.v1.HealthHomeState
import centraid.core.v1.HealthMoreRow
import centraid.core.v1.HealthTodayData
import centraid.core.v1.MoneyBandTab
import centraid.core.v1.MoneyHomeChrome
import centraid.core.v1.MoneyHomeData
import centraid.core.v1.MoneyHomeState
import centraid.core.v1.MoneyMoreRow
import centraid.core.v1.MoneySpendingData
import centraid.core.v1.PageState
import centraid.core.v1.PeopleAvatar
import centraid.core.v1.PeopleBandTab
import centraid.core.v1.PeopleDestination
import centraid.core.v1.PeopleHomeChrome
import centraid.core.v1.PeopleHomeState
import centraid.core.v1.PeopleMoreRow
import centraid.core.v1.PeopleRosterData
import centraid.core.v1.PeopleRow
import centraid.core.v1.PeopleSearchState
import centraid.core.v1.PeopleSection
import centraid.core.v1.PhotosDestination
import centraid.core.v1.PhotosHomeBandTab
import centraid.core.v1.PhotosHomeChrome
import centraid.core.v1.PhotosHomeState
import centraid.core.v1.PhotosMoreRow
import centraid.core.v1.PhotosMoreSheet
import centraid.core.v1.Route
import centraid.core.v1.SettingsAppearance
import centraid.core.v1.SettingsChoice
import centraid.core.v1.SettingsData
import centraid.core.v1.SettingsRow
import centraid.core.v1.SettingsSection
import centraid.core.v1.SettingsState
import centraid.core.v1.TodoCheck
import centraid.core.v1.TodoChrome
import centraid.core.v1.TodoQuickAdd
import centraid.core.v1.TodoRow
import centraid.core.v1.TodoRowGroup
import centraid.core.v1.TodoView
import dev.centraid.android.screens.AgendaHomeScreen
import dev.centraid.android.screens.SettingsScreen
import dev.centraid.android.screens.backup.BackupHomeScreen
import dev.centraid.android.screens.docs.DocsDriveScreen
import dev.centraid.android.screens.health.HealthHomeScreen
import dev.centraid.android.screens.money.MoneyHomeScreen
import dev.centraid.android.screens.people.PeopleHomeScreen
import dev.centraid.android.screens.photos.PhotosHomeScreen

private fun route(screen: String) = Route(screen = screen)

/** The rest of the roots (Calendar, Reminders, People, Docs, Money, Health, Photos, Settings, Backup) and their sheets. */
internal object ScenesApps {
    // --- Reminders (the Agenda root on its to-do place) --------------------------------------------------------
    val reminders = AgendaHomeState(
        destination = AgendaDestination.AGENDA_DESTINATION_TODO,
        app_key = "reminders",
        band = listOf(
            AgendaBandTab(key = "today", label = "Today", icon_key = "Today", current = true),
            AgendaBandTab(key = "scheduled", label = "Scheduled", icon_key = "Calendar"),
            AgendaBandTab(key = "all", label = "All", icon_key = "List"),
        ),
        chrome = AgendaChrome(tasks = TodoChrome(new_reminder = "New reminder", quick_add_placeholder = "New reminder")),
        data_ = AgendaHomeData(
            today = "2026-11-19",
            todo = AgendaTodo(
                count_label = "2 reminders",
                groups = listOf(
                    TodoRowGroup(
                        key = "today", title = "Today",
                        rows = listOf(
                            TodoRow(task_id = "t1", title = "Call the dentist", due_label = "Today 5 pm", check = TodoCheck.TODO_CHECK_OPEN, check_label = "Mark done: Call the dentist", accessibility_label = "Call the dentist, due today 5 pm", route = route("todo.detail")),
                            TodoRow(task_id = "t2", title = "Pay the rent", due_label = "Today", overdue = true, check = TodoCheck.TODO_CHECK_OPEN, check_label = "Mark done: Pay the rent", accessibility_label = "Pay the rent, overdue", route = route("todo.detail")),
                        ),
                    ),
                ),
            ),
        ),
        add_label = "New reminder",
        add_opens_quick_add = true,
        quick_add = TodoQuickAdd(shown = true, drawn = true, add_label = "Add", title = ""),
        page = PageState(),
    ).labelled()

    val remindersMore = reminders.copy(
        sheet = AgendaHomeState.Sheet.SHEET_MORE,
        more_rows = listOf(
            AgendaMoreRow(key = "reads", label = "What Reminders may read", icon_key = "Eye"),
            AgendaMoreRow(key = "trash", label = "Trash", icon_key = "Trash", route = route("trash")),
        ),
    ).labelled()

    // --- Calendar ---------------------------------------------------------------------------------------------
    val calendar = AgendaHomeState(
        destination = AgendaDestination.AGENDA_DESTINATION_SCHEDULE,
        app_key = "calendar",
        band = listOf(
            AgendaBandTab(key = "schedule", label = "Schedule", icon_key = "List", current = true),
            AgendaBandTab(key = "day", label = "Day", icon_key = "Day"),
            AgendaBandTab(key = "month", label = "Month", icon_key = "Calendar"),
        ),
        chrome = AgendaChrome(title = "Calendar", new_event = "New event"),
        toolbar = AgendaToolbar(shown = true, range_label = "November 2026", month_label = "November"),
        data_ = AgendaHomeData(today = "2026-11-19"),
        add_label = "New event",
        new_event = route("agenda.editor"),
        page = PageState(),
    ).labelled()

    val calendarMore = calendar.copy(
        sheet = AgendaHomeState.Sheet.SHEET_MORE,
        more_rows = listOf(
            AgendaMoreRow(key = "calendar-1", label = "Personal", toggle = true, on = true, section = "Calendars", hue_key = "blue", spoken = "Personal calendar, shown"),
            AgendaMoreRow(key = "trash", label = "Trash", icon_key = "Trash", route = route("trash")),
        ),
    ).labelled()

    // --- People ------------------------------------------------------------------------------------------------
    private fun person(id: String, name: String) = PeopleRow(
        party_id = id, name = name, avatar = PeopleAvatar(initials = name.take(1), hue_key = "blue"), role = "Friend",
        accessibility_label = "$name, Friend", star_label = "Star $name", route = route("people.person"),
    )

    val people = PeopleHomeState(
        destination = PeopleDestination.PEOPLE_DESTINATION_PEOPLE,
        title = "People",
        band = listOf(
            PeopleBandTab(key = "people", label = "People", icon_key = "People", current = true),
            PeopleBandTab(key = "touch", label = "Keep in touch", icon_key = "Heart"),
        ),
        chrome = PeopleHomeChrome(),
        roster = PeopleRosterData(
            sections = listOf(PeopleSection(key = "a", title = "A", rows = listOf(person("p1", "Asha"), person("p2", "Arjun")))),
        ),
        search = PeopleSearchState(),
        add_person = route("people.editor"),
        page = PageState(),
    ).labelled()

    val peopleMore = people.copy(
        sheet = PeopleHomeState.Sheet.SHEET_MORE,
        more_rows = listOf(
            PeopleMoreRow(key = "lists", label = "Lists", icon_key = "List", route = route("people.lists")),
            PeopleMoreRow(key = "trash", label = "Trash", icon_key = "Trash", route = route("trash")),
        ),
    ).labelled()

    // --- Docs --------------------------------------------------------------------------------------------------
    val docs = DocsDriveState(
        destination = DocsDestination.DOCS_DESTINATION_ALL,
        layout = DocsDriveState.Layout.LAYOUT_LIST,
        band = listOf(
            DocsBandTab(key = "all", label = "All", icon_key = "Docs", current = true),
            DocsBandTab(key = "folders", label = "Folders", icon_key = "Folder"),
            DocsBandTab(key = "starred", label = "Starred", icon_key = "Star"),
        ),
        chrome = DocsDriveChrome(title = "Docs"),
        search = DocsSearchField(),
        data_ = DocsDriveData(
            mode = DocsDriveData.Mode.MODE_SHELF,
            rows = listOf(
                DocsRowView(document_id = "d1", title = "Lease agreement", kind_label = "PDF", kind_icon_key = "File", meta = "2 pages", accessibility_label = "Lease agreement, PDF, 2 pages", route = route("docs.document")),
                DocsRowView(document_id = "d2", title = "Meeting notes", kind_label = "Note", kind_icon_key = "File", meta = "Yesterday", accessibility_label = "Meeting notes, note, yesterday", route = route("docs.document")),
            ),
        ),
        page = PageState(),
    ).labelled()

    private fun docsActions(kind: DocsSheet.Kind, title: String, vararg rows: DocsAction) =
        docs.copy(
            sheet = DocsSheet(kind = kind, title = title, close_label = "Close", actions = DocsActionList(actions = rows.toList())),
        ).labelled()

    val docsMore = docsActions(
        DocsSheet.Kind.KIND_MORE, "More",
        DocsAction(key = "trash", label = "Trash", icon_key = "Trash", enabled = true, route = route("trash")),
        DocsAction(key = "export", label = "Export", icon_key = "Export", enabled = true),
    )

    val docsAdd = docsActions(
        DocsSheet.Kind.KIND_ADD, "Add",
        DocsAction(key = "scan", label = "Scan a document", icon_key = "Camera", enabled = true),
        DocsAction(key = "file", label = "Add a file", icon_key = "File", enabled = true),
        DocsAction(key = "folder", label = "New folder", icon_key = "Folder", enabled = true),
    )

    // --- Money -------------------------------------------------------------------------------------------------
    val money = MoneyHomeState(
        destination = MoneyHomeState.Destination.DESTINATION_SPENDING,
        band = listOf(
            MoneyBandTab(key = "spending", label = "Spending", icon_key = "Chart", current = true),
            MoneyBandTab(key = "activity", label = "Activity", icon_key = "List"),
            MoneyBandTab(key = "cashflow", label = "Cash flow", icon_key = "Flow"),
        ),
        chrome = MoneyHomeChrome(title = "Money", add_label = "Add a statement", import_route = route("money.import")),
        month = "November 2026",
        data_ = MoneyHomeData(today = "2026-11-19", month_label = "November 2026", spending = MoneySpendingData()),
        page = PageState(),
    ).labelled()

    val moneyMore = money.copy(
        sheet = MoneyHomeState.Sheet.SHEET_MORE,
        chrome = money.chrome!!.copy(
            more_rows = listOf(
                MoneyMoreRow(label = "Accounts", icon_key = "Bank", route = route("money.accounts")),
                MoneyMoreRow(label = "Categories", icon_key = "Tag", route = route("money.categories")),
            ),
        ),
    ).labelled()

    // --- Health ------------------------------------------------------------------------------------------------
    val health = HealthHomeState(
        destination = HealthDestination.HEALTH_DESTINATION_TODAY,
        band = listOf(
            HealthBandTab(key = "today", label = "Today", icon_key = "Heart", current = true),
            HealthBandTab(key = "trends", label = "Trends", icon_key = "Chart"),
            HealthBandTab(key = "workouts", label = "Workouts", icon_key = "Run"),
        ),
        chrome = HealthHomeChrome(title = "Health"),
        data_ = HealthHomeData(today = "Today", day_label = "19 November", today_data = HealthTodayData()),
        page = PageState(),
    ).labelled()

    val healthMore = health.copy(
        sheet = HealthHomeState.Sheet.SHEET_MORE,
        more_rows = listOf(
            HealthMoreRow(key = "reads", label = "What Health may read", icon_key = "Eye"),
            HealthMoreRow(key = "stop", label = "Stop reading", icon_key = "Stop"),
        ),
    ).labelled()

    // --- Photos ------------------------------------------------------------------------------------------------
    val photos = PhotosHomeState(
        destination = PhotosDestination.PHOTOS_DESTINATION_LIBRARY,
        band = listOf(
            PhotosHomeBandTab(key = "library", label = "Library", icon_key = "Photos", current = true),
            PhotosHomeBandTab(key = "collections", label = "Collections", icon_key = "Albums"),
        ),
        chrome = PhotosHomeChrome(title = "Photos"),
    ).labelled()

    val photosMore = photos.copy(
        sheet = PhotosHomeState.Sheet.SHEET_MORE,
        more = PhotosMoreSheet(
            title = "More", close_label = "Close",
            rows = listOf(PhotosMoreRow(key = "trash", label = "Trash", icon_key = "Trash")),
        ),
    ).labelled()

    // --- Settings, Backup ----------------------------------------------------------------------------------------
    val settings = SettingsState(
        title = "Settings", back_label = "Back",
        data_ = SettingsData(
            appearance = SettingsAppearance(
                title = "Appearance",
                choices = listOf(SettingsChoice(id = "system", label = "System", selected = true), SettingsChoice(id = "light", label = "Light"), SettingsChoice(id = "dark", label = "Dark")),
            ),
            sections = listOf(
                SettingsSection(
                    key = "vault", title = "Vault",
                    rows = listOf(SettingsRow(id = "vaults", title = "Vaults", meta = "1", icon_key = "Vault", route = route("vaults"), pressable = true, accessibility_label = "Vaults, 1")),
                ),
            ),
            version_title = "Version", version = "1.0.0",
        ),
        page = PageState(),
    ).labelled()

    val backup = BackupHomeState(
        data_ = BackupHomeData(
            title = "Backup",
            line = BackupLine(sentence = "Backed up today", status = "Backed up", tone = BackupLine.Tone.TONE_QUIET, accessibility_label = "Backed up today"),
            back_up_now_label = "Back up now",
            back_up_now_enabled = true,
            rule_choices = listOf(BackupRuleChoice(stored = "wifi", sentence = "On Wi-Fi", picked = true), BackupRuleChoice(stored = "any", sentence = "On any network")),
            add_destination_label = "Add a laptop",
            add_destination = route("pair.laptop"),
            devices_heading = "Gateways",
        ),
        page = PageState(),
    ).labelled()

    val all: List<Scene> = listOf(
        Scene("reminders", "reminders") { AgendaHomeScreen(reminders, {}, {}, {}) },
        Scene("reminders.more", "reminders") { AgendaHomeScreen(remindersMore, {}, {}, {}) },
        Scene("calendar", "calendar") { AgendaHomeScreen(calendar, {}, {}, {}) },
        Scene("calendar.more", "calendar") { AgendaHomeScreen(calendarMore, {}, {}, {}) },
        Scene("people", "people") { PeopleHomeScreen(people, {}, {}, {}) },
        Scene("people.more", "people") { PeopleHomeScreen(peopleMore, {}, {}, {}) },
        Scene("docs", "docs") { DocsDriveScreen(docs, {}, {}, {}, {}) },
        Scene("docs.more", "docs") { DocsDriveScreen(docsMore, {}, {}, {}, {}) },
        Scene("docs.add", "docs") { DocsDriveScreen(docsAdd, {}, {}, {}, {}) },
        Scene("money", "money") { MoneyHomeScreen(money, {}, {}, {}) },
        Scene("money.more", "money") { MoneyHomeScreen(moneyMore, {}, {}, {}) },
        Scene("health", "health") { HealthHomeScreen(health, {}, {}, {}) },
        Scene("health.more", "health") { HealthHomeScreen(healthMore, {}, {}, {}) },
        Scene("photos", "photos") { PhotosHomeScreen(photos, {}, {}, {}) },
        Scene("photos.more", "photos") { PhotosHomeScreen(photosMore, {}, {}, {}) },
        Scene("settings", "settings") { SettingsScreen(settings, {}, {}, {}) },
        Scene("backup", "backup") { BackupHomeScreen(backup, {}, {}) },
    )
}
