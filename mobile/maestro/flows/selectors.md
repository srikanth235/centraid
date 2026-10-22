# Selectors, per screen

One string per control, set with `Modifier.testTag` in Compose and `.accessibilityIdentifier` in SwiftUI — **the same string on both**, which is what lets one flow file drive two platforms. On Android a test tag reaches Maestro's `id:` as a resource id because `MainActivity` sets `testTagsAsResourceId` once on the root content (#1128, Q-1128-2).

| Id | Screen | What renders it |
| --- | --- | --- |
| `home-grid` | Home | the springboard grid |
| `home-status` | Home | the health ribbon |
| `home-day-one` | Home | the first-run page |
| `home-first-moves` | Home | the first-moves band |
| `home-failure` | Home | the failed-read sentence (no grid) |
| `home-tile-<appId>` | Home | one springboard tile, keyed on the app id — every launchable app has one (Tasks has none: it folded into Agenda, whose tile also carries today's due tasks, #1128), an empty app drawing what to do (R-ONBOARD-11) |
| `home-vault-switch` | Home | the vault lockup, which IS the switch |
| `home-search-open` | Home | the framed search key at the lockup's trailing edge — opens Home's search (R-CHROME-6) |
| `home-appearance` | Home | the framed appearance key right of search — flips light and dark (R-CHROME-7) |
| `home-search-field` | Home search | the field (it takes focus on open) |
| `home-search-cancel` | Home search | Cancel: back to Home, the field cleared |
| `home-search-recent-<term>` | Home search | one of this session's recent searches, while the field is empty |
| `home-search-group-<appId>` | Home search | one app's group head: hue dot, the app's name, its count; a task hit is grouped under `agenda` (the app it opens in, #1128, R-1128-7), so there is no `home-search-group-tasks` |
| `home-search-row-<entity>-<id>` | Home search | one hit (`entity` is the index's, e.g. `schedule.task`); a tap opens it in its app |
| `search-corrected` | any open search field (every app's search slot, Photos' included, Home search) | the line under the field, "Including results for “…”", drawn only when the core corrected a typo in the term ([#1097](https://github.com/srikanth235/centraid/issues/1097)); absent for an exact answer |
| `photos-search-no-match` | Photos search | the no-match block (the kit empty state: "No results", then one body line, "Nothing matches “…”." and the line saying everywhere search looked), drawn when a query reached no photograph and no door; the Ask row under it is `search-ask-about` on iOS; the words are `PHOTOS_SEARCH_NO_RESULTS`, `PHOTOS_SEARCH_NO_MATCH_QUERY` and `PHOTOS_SEARCH_NO_MATCH_SCOPE`, finished by the machine in `SearchHits.empty` ([#1097](https://github.com/srikanth235/centraid/issues/1097), R-1097-27) |
| `search-ask-about` | Home search, and the search of Notes, People, Docs, Agenda (tasks included), Photos and Money | the Ask row at the foot of the answer, matched or not, "Ask about “…”": switches to the Chat tab, scoped to the app searched from (Home: every app), and sends the question — **iOS only**; Android has no Chat tab, so it draws no row. **Never in Locker's search** ([#1097](https://github.com/srikanth235/centraid/issues/1097), R-1097-29) |
| `search-container-<entity>-<id>` | Home search (inside the app's group, before its rows) and Notes', Agenda's and Docs' own search results | one container whose NAME matched — a notebook or album (`core.collection`), a project (`schedule.project`), or a Docs folder (`core.concept`) ([#1097](https://github.com/srikanth235/centraid/issues/1097)); a tap opens it in its app (the notebook's notes, the project's list, the group's ledger, the folder's page, the album's shelf) |
| `agenda-search-open` | Agenda | the framed search bar under the title, closed; opens Agenda's search (the field is `agenda-search`) |
| `agenda-search` | Agenda | Agenda's search field once open; it finds events, tasks and projects: the projects whose name matched as `search-container-schedule.project-<id>` rows first (#1128, Q-1128-1), then the tasks as one group, then the event days |
| `agenda-band-<key>` | Agenda | one band place, keyed on the machine's key: `day`, `schedule`, `waiting`, `todo`, `more` ([#1128](https://github.com/srikanth235/centraid/issues/1128), R-1128-1); `agenda-band-home` is the home capsule |
| `agenda-list` | Agenda (Day, Schedule, Waiting, search) | the scrolling list of day sections |
| `agenda-todo-list` | Agenda (To-do) | the To-do list: the Inbox's groups, then the projects by area, then "New project" |
| `agenda-task-row-<taskId>` | Agenda (Day, Schedule, To-do, Overdue, a search's task hits) | one task row; a tap opens the task, a long press offers "Move to project" |
| `agenda-task-row-check-<taskId>` | the same | the row's round box: checks the task off in place, and the status line (`agenda-status-action`, "Undo") takes it back |
| `agenda-task-row-file-<taskId>` | the same | the long-press menu's "Move to project" (iOS) |
| `agenda-new-event` / `agenda-add-task` | Agenda | the header Plus: "Add" on Day, Schedule and Waiting, "Add task" on To-do (it opens the quick-add bar) |
| `agenda-quick-add` | Agenda (To-do) | the quick-add bar's field, drawn only after `agenda-add-task`; Add is `agenda-quick-add-verb`, and appears once there are words |
| `agenda-project-<projectId>` | Agenda (To-do) | one project row; a tap pushes the project's page (`tasks-project`) |
| `agenda-new-project` | Agenda (To-do) | the foot-of-list verb that opens the new-project sheet, whose field is `tasks-new-project-field` |
| `agenda-more-<key>` | Agenda's More sheet | one row: `calendar-<id>`, `anytime`, `logbook`, `reminders`, `trash`, `reads` |
| `agenda-status-action` | Agenda | the status line's Undo (after a check-off, a filing or a refused write) |
| `agenda-notice-verb` | Agenda (Day on today) | the absence notice's verb |
| `tasks-title-field` | a task's page | the title field, the page's mark that it is open; its Done closes it |
| `tasks-list` / `tasks-project` | Tasks pages (pushed from Agenda's More and To-do) | a list page (Anytime, Logbook, Reminders) and a project page; their back control reads "Agenda" |
| `home-search-group-chat` | Home search (iOS only) | the head of the Chats group: the member's own conversations, last among the groups, drawn only where the shell has a Chat tab ([#1097](https://github.com/srikanth235/centraid/issues/1097), R-1097-24); its rows are `home-search-row-chat.thread-<id>`, and a tap opens that thread in the Chat tab |
| `chat-drawer` | Chat | the header's menu control, which opens the drawer of past chats |
| `chat-drawer-panel` | Chat | the drawer itself |
| `chat-drawer-new` | Chat | the drawer's New chat |
| `chat-drawer-search-open` | Chat drawer | the search opener, field-shaped, while the drawer's search is closed |
| `chat-drawer-search-field` | Chat drawer | the shared search field once open (it takes focus); the "Including results for “…”" line under it is `search-corrected` |
| `chat-drawer-search-close` | Chat drawer | the field's close key: the term and its answer go, the plain list is back |
| `chat-drawer-list` | Chat drawer | the list of chats (the plain list, or the chats a search found) |
| `chat-thread-row` | Chat drawer | one chat in the list |
| `chat-drawer-empty` | Chat drawer | the one line when the list is empty: "No chats yet.", or "No chats match “…”." over a search that found none |
| `chat-drawer-delete-all` | Chat drawer | "Delete all chats", offered over the plain list and never over search results |
| `chat-message-user`, `chat-message-answer` | Chat | the member's message and the assistant's answer in the open thread |
| `home-band` | Home | the floating band plate |
| `home-band-<placeId>` | Home | one band destination (`home`, `notifs`, `stats`, `data`) |
| `home-band-backup` | Home | the band's Backup tab — opens the Backup screen |
| `home-backup-status` | Home | the lockup's second line: the backup's status, the door to the Backup tab ([#1080](https://github.com/srikanth235/centraid/issues/1080), R-ONBOARD-11) |
| `backup-screen` | Backup | the Backup screen itself |
| `backup-now` | Backup | "Back up now", dimmed and disabled when the machine's `back_up_now_enabled` is false |
| `backup-progress` | Backup | the progress sentence while a run is under way |
| `backup-notice` | Backup | what the last act did, or why it could not (one clause, never a toast) |
| `backup-background-notice` | Backup | why the phone will not wake Centraid in the background, when it will not |
| `backup-key-line` | Backup | where the recovery key is — a warning while it is on this phone alone with no saved copy |
| `backup-show-key` | Backup | "Show recovery key": runs the owner check, then opens words.show (no screen before the check) |
| `backup-key-sync` | Backup | "Keep my key off …" / "Save my key in …": moves the key into or out of the keychain |
| `backup-include-videos` | Backup | the include-videos switch |
| `backup-rule-<stored>` | Backup | one transfer-rule choice, keyed on the stored word |
| `backup-add-destination` | Backup | the add-a-gateway control, which opens pairing |
| `backup-forget-<gatewayId>` | Backup | one gateway's Forget |
| `backup-battery` | Backup | the battery-optimisation remedy — **Android only**; iOS has no such setting |
| `home-band-chat` | Home | the band's Chat tab (the second place, after Home) |
| `import-banner` | every route, at the foot above the band | an import's status line: progress and outcome (`import-sentence`), its one action (`import-action`, "Open People" after a made vault's imports) and its close key (`import-close`) |
| `home-vault-sheet` | Home | the vault switcher sheet |
| `vault-row-<vaultId>` | Home | one switcher row (and `vault-forget-<vaultId>`, its **Delete**) |
| `vault-rename-<vaultId>` | Home | one switcher row's Rename (a swipe on iOS, also in the row's long-press menu; a button on Android), and `vault-rename-field` / `vault-rename-save` in its dialog |
| `vault-found-button` | Home | the vault switcher's "Make a vault" (R-ONBOARD-11) |
| `vault-restore-button` | Home | the vault switcher's "Restore my vaults" |
| `first-launch` | First launch | the deck (and `first-launch-skip`, `first-launch-<id>` for its actions) |
| `chat` | Chat | the tab's root |
| `chat-field` | Chat | the composer's text field (ready phase only) |
| `chat-send` | Chat | Send, which becomes `chat-stop` while a turn runs |
| `chat-stop` | Chat | Stop, while a turn runs |
| `chat-download` | Chat | "Download model", in the model step |
| `chat-model-note` | Chat | the model step's one sentence |
| `chat-empty` | Chat | the empty thread's one line |
| `chat-suggestion-<n>` | Chat | the n-th suggested question, from 0 |
| `chat-card-<n>` | Chat | the n-th row-card under an answer, from 0 |
| `chat-pending` | Chat | the lines of the confirm card under an answer that proposes a write, read as one element |
| `chat-pending-confirm` | Chat | its Confirm (outlined in `net` when the card asks twice) |
| `chat-pending-cancel` | Chat | its Cancel |
| `chat-pending-settled` | Chat | the one clause that says how the card ended ("Done.", "Not done.") |
| `chat-new` | Chat | the header's New chat |
| `kit-empty-import` | any app | the import from where the phone holds the data ("Import contacts" on People), in place of the empty state's action |
| `kit-empty` | any app | the empty state itself (its sentence) |
| `kit-empty-action` | any app | the empty state's one action ("Add a document"), when there is no import |
| `words-shown` | words.make / words.show | the recovery key's 24 cells, read as one grid (each cell is `words-word-<n>`) |
| `words-save-copy` | words.make / words.show | "Save a copy" — the share sheet with the key as one line |
| `words-make-primary` | words.make | the sheet's primary ("I've saved it", "Done") |
| `locker-more-access` | Locker | the More sheet's Access history row — pushes the whole Locker's access history ([Q-1047-21](../../../docs/decisions.md#locker)); **iOS**. Android draws every More row as `sheet-option-<key>`, here `sheet-option-access` |
| `locker-access-lede` | Locker Access history | the one-line lede under the title ("Every unlock, reveal, copy and export, newest first.") |
| `locker-access` | Locker Access history | the list of receipts — **Android only** (an iOS container id would leak onto its rows) |
| `locker-field-access:<receiptId>-value` | Locker Access history, and an item's own Access history | one receipt's day and minute, the value of the item page's history row (`<receiptId>` is the receipt's); **iOS**. Android tags the row `locker-field-access:<receiptId>` and its value `locker-value-access:<receiptId>`. A receipt never carries a value, so these hold a time and never a secret |
| `health-band-<tab>` | Health | one band tab (`today`, `trends`, `workouts`, `more`, the label lowercased); `health-band` is the plate (#1129) |
| `health-connect-open` | Health | the not-connected empty state's one action, which pushes Connect |
| `health-hero`, `health-metric-<key>`, `health-trend-<key>` | Health | Today's steps card, a Today metric line and a Trends row, each the tap to its metric page (`<key>` is `steps`, `sleep_min`, …) |
| `health-today-foot` | Health | Today's foot: where the numbers were read from |
| `health-workout-<activityId>` | Health | one workout row (Today and Workouts) |
| `health-chip-<kind>`, `health-chip-all` | Health | a Workouts kind chip, and All |
| `health-range`, `health-metric-range` | Health, a metric | the segmented range (Trends; Week · Month · Year) |
| `health-more-<key>`, `health-reads`, `health-reads-close` | Health | a More row (`reads`, `choose`, `stop`), the "What Health may read" sheet and its close |
| `health-metric-page`, `health-workout-page` | a metric, a workout | the pushed page's scroll |
| `health-connect-page`, `health-choice-<key>`, `health-connect`, `health-connect-status` | Connect | the page, one type's switch, the one Ink button ("Connect Apple Health"), the status line |
| `kit-pushed-back` | any pushed page (iOS) | the kit's back control, named for the parent |
| `BackButton` | any pushed page (iOS) | the navigation bar's back — UIKit's own id; Maestro's `back` is Android's system key and does nothing on iOS |

Home, its Settings and vault sheets, the Backup screen, the first-launch deck and Chat set tags; the Backup screen's ids are written in both shells and selected by no flow yet. The iOS shell runs on a simulator against the real `HomeMachine` through `HomeBridge`, so the iOS half of each id renders; the Android half is compiled and unobserved, because no machine here has an Android emulator.

**A CONTAINER'S ID LEAKS ONTO ITS CHILDREN ON iOS.** `.accessibilityIdentifier` on a plain `VStack`/`HStack` is handed down to every child that is not an element of its own, over the child's own id — every Home tile read `home-grid`, and the empty state's buttons read `kit-empty`. A container that carries an id and has selectable children marks itself `.accessibilityElement(children: .contain)` first (`TileGrid`, `KitEmpty`). The Docs band's buttons all still read `docs-band`; no flow selects them yet.

**Run on the iOS simulator (2026-10-13):** `first-launch.yaml`, `onboarding.yaml` and `home.yaml` pass. The two fresh-install flows launch with `permissions: all: deny` — Maestro grants every permission by default, and a made vault imports what it is granted — and need `xcrun simctl keychain <udid> reset` first. `home.yaml` runs on the vault `onboarding.yaml` leaves. `chat.yaml` and Android are not yet run.
