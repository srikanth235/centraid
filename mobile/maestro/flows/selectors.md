# Selectors, per screen

One string per control, set with `Modifier.testTag` in Compose and `.accessibilityIdentifier` in SwiftUI — **the same string on both**, which is what lets one flow file drive two platforms. On Android a test tag reaches Maestro's `id:` as a resource id because `MainActivity` sets `testTagsAsResourceId` once on the root content (#1128, Q-1128-2).

| Id | Screen | What renders it |
| --- | --- | --- |
| `home-grid` | Home | the springboard grid |
| `home-status` | Home | the health ribbon |
| `home-day-one` | Home | the first-run page |
| `home-first-moves` | Home | the first-moves band |
| `home-failure` | Home | the failed-read sentence (no grid) |
| `home-tile-<appId>` | Home | one springboard widget, keyed on the widget id (the app id, except Agenda's second, `reminders`) — every launchable app has one (Tasks has none: it folded into Agenda, whose tile also carries today's due tasks, #1128), an empty app drawing what to do (R-ONBOARD-11) |
| `home-vault-switch` | Home | the vault lockup, which IS the switch |
| `home-search-open` | Home | the framed search key at the lockup's trailing edge — opens Home's search (R-CHROME-6) |
| `home-settings-open` | Home | the framed settings key right of search: opens Settings, where the appearance is chosen (#1173; the appearance key retired into it) |
| `home-tile-reminders` | Home | the Reminders widget, Agenda's second: what is owed today; `home-tile-agenda` is the day (#1173) |
| `backup-over` | Backup | the "Back up over" row: the rule's short word, opening its three sentences |
| `backup-last-good` | Backup | "Last good backup …", drawn while the backup device has not answered |
| `backup-restore` | Backup | "Restore my vaults": Home's own restore |
| `home-search-field` | Home search | the field (it takes focus on open) |
| `home-search-cancel` | Home search | Cancel: back to Home, the field cleared |
| `home-search-recent-<term>` | Home search | one of this session's recent searches, while the field is empty |
| `home-search-group-<appId>` | Home search | one app's group head: hue dot, the app's name, its count; a task hit is grouped under `agenda` (the app it opens in, #1128, R-1128-7), so there is no `home-search-group-tasks` |
| `home-search-row-<entity>-<id>` | Home search | one hit (`entity` is the index's, e.g. `schedule.task`); a tap opens it in its app |
| `search-corrected` | any open search field (every app's search slot, Photos' included, Home search) | the line directly over the field at the foot (under it on Home's search page and Chat's drawer), "Including results for “…”", drawn only when the core corrected a typo in the term ([#1097](https://github.com/srikanth235/centraid/issues/1097)); absent for an exact answer |
| `photos-search-no-match` | Photos search | the no-match block (the kit empty state: "No results", then one body line, "Nothing matches “…”." and the line saying everywhere search looked), drawn when a query reached no photograph and no door; the Ask row under it is `search-ask-about` on iOS; the words are `PHOTOS_SEARCH_NO_RESULTS`, `PHOTOS_SEARCH_NO_MATCH_QUERY` and `PHOTOS_SEARCH_NO_MATCH_SCOPE`, finished by the machine in `SearchHits.empty` ([#1097](https://github.com/srikanth235/centraid/issues/1097), R-1097-27) |
| `search-ask-about` | Home search, and the search of Notes, People, Docs, Agenda (tasks included), Photos and Money | the Ask row at the foot of the answer, matched or not, "Ask about “…”": switches to the Chat tab, scoped to the app searched from (Home: every app), and sends the question — **iOS only**; Android has no Chat tab, so it draws no row. **Never in Locker's search** ([#1097](https://github.com/srikanth235/centraid/issues/1097), R-1097-29) |
| `search-container-<entity>-<id>` | Home search (inside the app's group, before its rows) and Notes', Agenda's and Docs' own search results | one container whose NAME matched — a notebook or album (`core.collection`), a project (`schedule.project`), or a Docs folder (`core.concept`) ([#1097](https://github.com/srikanth235/centraid/issues/1097)); a tap opens it in its app (the notebook's notes, the project's list, the group's ledger, the folder's page, the album's shelf) |
| `band-search` | every app with search: Notes, People, Docs (a folder page carries it alone at its foot), Agenda (tasks included), Photos, Money, Locker | the round search key at the trailing end of the app's band, the Home circle's twin; one id on both shells and in every app. It opens the search: the field takes the band's place at the foot, over the keyboard (`<app>-search`, with `<app>-search-field` and `<app>-search-close`; Money's page and Docs' folder page use `money-search` and `docs-search`), and the close key brings the band back. Photos' selection bar stands in the band's place and carries no key; an app with no search draws none |
| `<app>-filter-menu` | Photos, Notes, People, Docs, Money, Health, Locker (Agenda has none) | the header's funnel button, drawn solid while a filter is on; it opens the platform's own menu, built by Rust (`FilterMenu`). The menu's own items are `<app>-filter-<section>-<option>`; the system draws the checkmark, and the ids ARE visible to Maestro on iOS (`inspect_view_hierarchy`, selected items carry `selected=true`). Android's `DropdownMenu` tags the same ids |
| `<app>-filter-clear` | the same | "Clear filters", first in the menu while a filter is on (and absent otherwise) |
| `<app>-filter-<section>` | Docs (`type`, `modified`, `label`), Money (`account`, `category`) | a NESTED section's entry in the menu, which opens its options as a submenu (on Android the menu's content swaps for them under a back row, `<app>-filter-<section>-back`) |
| `photos-filter-show-<all\|favorites>` | Photos | the filter options, one checked |
| `notes-filter-show-pinned`, `notes-filter-show-tag-<conceptId>`, `notes-filter-sort-<updated\|created\|title>` | Notes | Pinned and each tag (several may be checked), and the sort (one checked) |
| `notes-editor-meta`, `notes-tool-checklist`, `notes-tool-link`, `notes-tool-tag`, `notes-tool-keyboard` | Notes editor | the line over the title ("Travel · Edited Wed 4 November", with a pin when pinned) and the toolbar's keys: checklist (Rust's `checklist_requested`), link (the powerbox), tag (focuses the add-tag field) and hide keyboard; Android draws the checklist, link and keyboard keys under the words and has no tag key ([#1173](https://github.com/srikanth235/centraid/issues/1173)) |
| `notes-check-<offset>`, `notes-chip-<offset>`, `notes-editor-status-action` | Notes editor | the rich body's marks, on both shells: `<offset>` is the UTF-16 offset in the body of the checklist line's `[ ]` (a tap is the core's `checklist_toggled`, Return and Undo included) or of a link chip's first character (`link_opened`; a resolved note opens by the chip's route). `notes-editor-status-action` is the one verb on the editing sentence ("Item checked", Undo: `status_acted`). The body field is `note-body-field` on iOS and `notes-body` on Android |
| `notes-menu-pin-<noteId>`, `notes-menu-file-<noteId>`, `notes-menu-trash-<noteId>` | Notes library (iOS) | a row's long-press menu: Pin or Unpin, File into notebook, Trash, each the row's own event; Android has the same three behind a swipe or long press as `row-action-pin-<noteId>`, `row-action-file-<noteId>`, `row-action-trash-<noteId>` and no visible `…` key on either shell (`notes-row-menu-<noteId>` is gone) |
| `people-filter-show-<all\|starred\|due>`, `people-filter-sort-<recent\|name>` | People | the roster's filter with its counts, and the order |
| `people-my-card`, `people-reconnect-line`, `people-index` | People (the roster) | the owner's own card above the list (a tap opens it), the pill "3 to reconnect · Dana is 26 days over" (a tap is the band's Touch), and the A to Z index at the trailing edge (every letter a stop; a drag along it scrolls). The list is A to Z under the Name order, which is the default, and the flat list under Recently added ([#1173](https://github.com/srikanth235/centraid/issues/1173)) |
| `people-person`, `people-person-hero-<message\|call\|mail\|log>`, `people-person-edit`, `people-person-menu` | People (a person) | the page, the hero's round keys (only the ones the person's data allows), Edit, and the glass key that holds `people-person-star`, `people-person-merge` and `people-person-trash` (none of the three on the owner's own card) |
| `people-vault`, `people-vault-<id>` | People (a person) | the "In your vault" card and one of its rows (an event, a task or a note from another app; a tap opens it in its app) |
| `docs-filter-<type\|modified\|label>-<option>`, `docs-filter-sort-<order>`, `docs-filter-view-<list\|grid>` | Docs | a submenu's options (`any` first), the six orders, the layout |
| `docs-label-chip-<label>` | Docs | a label chip over Recents, Browse and Starred (a dot in the label's colour and its word): a tap filters the shelf to it, again clears it; selected while it filters |
| `docs-bar-<share\|star\|unstar\|labels\|move\|trash\|restore\|purge>` | Docs | a key of a document's Quick Look bar |
| `docs-document-subtitle`, `docs-document-labels`, `docs-versions` | Docs | the page's second line ("Docs › Taxes 2025"), the info card's Labels row, and its row to the version history |
| `money-filter-<account\|category>-<all\|id>` | Money | the account and category options (`all`, then ids; `uncategorised` for no category) |
| `money-hero`, `money-needs-category` | Money | Activity's overview card (and Spending's spent figure), and the review banner / Spending's "No category" row: a tap lists the rows with no category in Activity |
| `money-bars-mode`, `money-bar-<n>`, `money-bars-caption`, `money-categories-more` | Money (Spending) | the Week / Day switch (`money-bars-mode-<week\|day>` on Android), a bar of the chart by index and the sentence under the selected one, and the "N more categories" row that opens the rest |
| `money-category-<id>`, `money-row-<txnId>` | Money | a category line on Spending (opens its target) and a transaction row (opens it). The month is the title's second line; the month stepper (`money-month-previous` / `money-month-next`) is gone |
| `health-filter-kind-<all\|conceptId>` | Health (Workouts) | the workout kind |
| `locker-filter-show-<all\|starred\|archived\|type>` | Locker | the shelf's filter with its counts |
| `locker-category-<all\|codes\|card\|wifi\|review\|trash>` | Locker | the landing's category cards (#1173); Trash pushes its page, Review switches to Review, the rest open that category's list |
| `locker-category-back` | Locker | the chevron above a category's list, back to the landing (Android also takes the system back) |
| `locker-item-action-change_password` (iOS), `locker-action-change_password` (Android) | Locker item | "Change password on website": opens the item's own address |
| `room-subtitle`, `room-subtitle-clear` | Notes (the notebook the library is scoped to, with its ✕ `room-subtitle-clear`), Money (the month, tappable: opens the month sheet) | the title's second line, which replaced the notebook and month chips |
| `photos-grain-<years\|months\|all>` | Photos | one segment of the zoom control in the band (Years · Months · All), between the folded place key and the search key; `photos-band-places` is that folded key, which brings the plate of places back |
| `agenda-search` | Agenda | Agenda's search field once open, at the foot in the band's place; it finds events, tasks and projects: the projects whose name matched as `search-container-schedule.project-<id>` rows first (#1128, Q-1128-1), then the tasks as one group, then the event days |
| `agenda-band-<key>` | Agenda | one band place, keyed on the machine's key: `calendar`, `reminders`, `invites`, `more` (#1173); `agenda-band-home` is the home capsule |
| `agenda-list` | Agenda (Day, Schedule, Waiting, search) | the scrolling list of day sections |
| `agenda-todo-list` | Agenda (To-do) | the To-do list: the Inbox's groups, then the projects by area, then "New project" |
| `agenda-task-row-<taskId>` | Agenda (Day, Schedule, To-do, Overdue, a search's task hits) | one task row; a tap opens the task, a long press offers "Move to project" |
| `agenda-task-row-check-<taskId>` | the same | the row's round box: checks the task off in place, and the status line (`agenda-status-action`, "Undo") takes it back |
| `agenda-task-row-file-<taskId>` | the same | the long-press menu's "Move to project" (iOS) |
| `agenda-new-event` / `agenda-add-task` | Agenda | the header Plus: "Add" on Day, Schedule and Waiting, "Add task" on To-do (it opens the quick-add bar) |
| `agenda-quick-add` | Agenda (To-do) | the quick-add bar's field, drawn only after `agenda-add-task`; Add is `agenda-quick-add-verb`, and appears once there are words |
| `agenda-project-<projectId>` | Agenda (To-do) | one project row; a tap pushes the project's page (`tasks-project`) |
| `agenda-new-project` | Agenda (To-do) | the foot-of-list verb that opens the new-list style sheet, whose field is `agenda-style-name` |
| `agenda-more-<key>` | Agenda's More sheet | one row: `calendar-<id>`, `new-calendar` (opens the new-calendar sheet, #1173), `anytime`, `logbook`, `reminders`, `trash`, `import-reminders` (iOS only, below), `reads` |
| `agenda-more-import-reminders` | Agenda's More sheet | **iOS only** (Android has no Reminders store, so its More draws no such row): opens the Import reminders option sheet (#1173) |
| `agenda-import-reminders-completed` | the Import reminders sheet | **iOS only**: the "Include completed reminders" switch, off by default; `selected`/on once flipped |
| `agenda-import-reminders-go` | the same | **iOS only**: the sheet's one ink button, "Import reminders": it asks the one reminders import to read the phone with the switch's option, and the outcome is said on the import status line (`import-banner`), never on the sheet |
| `agenda-calendar-edit-<calendarId>` | Agenda's More sheet | a calendar row's edit control: opens the style sheet on that calendar to rename it and change its colour and icon (#1173) |
| `agenda-style-name` / `agenda-style-submit` / `agenda-style-cancel` | Agenda's style sheet (a new list from "Add List", a list's "Edit List", a new or edited calendar) | the name field, Create or Save, and Cancel; the new list sheet's field is `agenda-style-name` too (it was `tasks-new-project-field`) |
| `agenda-style-color-<key>` / `agenda-style-icon-<key>` / `agenda-style-icon-none` | the same | one of the eight `[list]` swatches (`blue`, `mustard`, `violet`, `petrol`, `indigo`, `graphite`, `raspberry`, `orchid`), one icon of the grid (a `design/icons.toml` key such as `Gym`), and the row that clears the icon; the selected one carries `selected=true` |
| `tasks-project-edit` | a project page | the header verb "Edit List": opens the style sheet on the list |
| `agenda-status-action` | Agenda | the status line's Undo (after a check-off, a filing or a refused write) |
| `agenda-notice-verb` | Agenda (Day on today) | the absence notice's verb |
| `agenda-view-menu` | Agenda (Calendar) | the Calendar's view menu key (#1173); its rows are `agenda-view-<key>`: `day`, `week`, `month`, `list`, `year`, and on Month `agenda-month-style-grid` / `agenda-month-style-list` |
| `agenda-week-strip` | Agenda (Day, Week) | the week strip; a swipe changes week, and a day is `agenda-strip-day-<YYYY-MM-DD>` |
| `agenda-time-grid` | Agenda (Day, Week) | the hour grid; a long press on an empty slot opens the add sheet at that time |
| `agenda-grid-allday-<day>` | Agenda (Day, Week) | one day's all-day strip; a chip in it is `agenda-grid-chip-<key>` |
| `agenda-grid-block-<key>` | Agenda (Day, Week) | one timed block (`<day>\|<instance_key>` or `<day>\|task:<id>`); drag moves it, its foot resizes it; a task block's circle is `agenda-grid-block-check-<taskId>` |
| `agenda-now-line` | Agenda (Day, Week on today) | the now line |
| `agenda-today-button` | Agenda (Calendar) | the floating Today button, drawn away from today |
| `agenda-month-grid` | Agenda (Month) | the month; a cell is `agenda-month-cell-<YYYY-MM-DD>` |
| `agenda-year-grid` | Agenda (Year) | the twelve months; one is `agenda-year-month-<YYYY-MM>` |
| `agenda-quick-tool-<key>` | Agenda (To-do), a list page | the keyboard toolbar's `date`, `tag` and `flag` keys over the quick add; the date choices are `agenda-quick-due-<key>`, the tag field `agenda-quick-tag-field`, and what the next add carries `agenda-quick-staged` |
| `agenda-editor-notes` | the add sheet (task) | the task's notes field |
| `agenda-editor-list` | the add sheet (task) | the List row; a list in its sheet is `agenda-editor-list-<key>` (`inbox` or a project id) |
| `agenda-editor-more-details` | the add sheet (task) | the More details row; under it `agenda-editor-priority-<0..3>`, `agenda-editor-tag-field` and a tag chip `agenda-editor-tag-<text>` |
| `agenda-editor-location` / `agenda-editor-second-reminder` / `agenda-editor-availability` / `agenda-editor-zone` / `agenda-editor-travel` | the event editor | the Location, Second alert, Availability, Time zone and Travel time rows (#1173 wave 2); each opens its sheet. The second alert row is drawn only once the first alert is set, the zone row only on a timed event |
| `agenda-editor-url` | the add sheet and a task's editor | the task's address field, with what Save will write under it |
| `agenda-editor-place-search` / `agenda-editor-place-<id>` / `agenda-editor-place-clear` | the Location sheet | the place search field, one place of the vault (a `place` entity id), and "No location" (drawn while a place is chosen) |
| `agenda-editor-second-reminder-<key>` | the Second alert sheet | one alert choice (`none`, then the first alert's list) |
| `agenda-editor-availability-<busy\|free>` | the Availability sheet | Busy or Free |
| `agenda-editor-zone-search` / `agenda-editor-zone-<iana>` | the Time zone sheet | the zone search field, and one zone (an IANA id such as `Europe/Paris`, or `floating`) |
| `agenda-editor-travel-<minutes>` | the Travel time sheet | one choice, minutes as text (`0` is none) |
| `agenda-editor-custom-freq-<key>` | the Custom repeat sheet (the Repeat sheet's `custom` choice) | the frequency segments: `daily`, `weekly`, `monthly`, `yearly` |
| `agenda-editor-custom-interval` / `agenda-editor-custom-count` | the same | the "Every N" number field and the "After N times" number field |
| `agenda-editor-custom-weekday-<MO..SU>` | the same (weekly) | one weekday chip, any number picked |
| `agenda-editor-custom-month-mode-<date\|nth>` | the same (monthly) | "On day(s) of the month" or "On the" |
| `agenda-editor-custom-month-day-<1..31\|-1>` | the same (monthly by date) | one day of the month chip; `-1` is the last day |
| `agenda-editor-custom-ordinal-<n>` / `agenda-editor-custom-nth-weekday-<MO..SU>` | the same (monthly "On the") | first to fifth or last (`-1`), then the weekday |
| `agenda-editor-custom-end-<never\|on\|after>` | the same | how the rule ends; `agenda-editor-custom-until` is the date row that opens the day picker, drawn for "On a date" |
| `agenda-editor-custom-summary` / `agenda-editor-custom-error` | the same | the rule in words, re-derived on every change, and the sentence while the rule is not whole |
| `agenda-editor-custom-done` / `agenda-editor-custom-replace` | the same | Done, armed once the rule is whole; and, over a rule the sheet cannot represent (read only), the verb that starts a fresh one |
| `agenda-detail-link` / `agenda-detail-link-open` | a task's page | the task's address as stored, and its "Open link" verb (hands the address to the phone) |
| `agenda-detail-attachments` | a task's page | the attachments section; a tile is `agenda-detail-attachment-<id>` (a tap opens it) with its remove control `agenda-detail-attachment-remove-<id>` |
| `agenda-detail-attachment-add-photo` / `agenda-detail-attachment-add-file` / `agenda-detail-attachment-more` / `agenda-detail-attachment-status` | a task's page | Add photo, Add file, Show more, and the section's own status line |
| `agenda-event-attachments` | an event's page | the attachments section; a tile is `agenda-event-attachment-<id>` with its remove control `agenda-event-attachment-remove-<id>` |
| `agenda-event-attachment-add-photo` / `agenda-event-attachment-add-file` / `agenda-event-attachment-more` / `agenda-event-attachment-status` | an event's page | Add photo, Add file, Show more, and the section's own status line |
| `agenda-event-followed` / `agenda-event-followed-guest-<index>` | an event's page (a followed phone calendar) | the guests the phone's calendar holds, with their replies, and one guest by its position |
| `tasks-detail-group-<key>` | a task's page | the head of one grouped card, keyed on its first field (`when`, `project`, …); the Flag switch is `tasks-field-flag` |
| `row-action-<id>` / `row-menu-<id>` | any swipeable task row | the swipe's and the long press's Details, Flag and Delete (`details`, `flag`, `delete`) |
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
| `home-backup-status` | Home | the lockup's second line: the backup's status, the door to the Backup tab, or to pairing while no backup device is paired, "Not backed up. Pair a backup device." (#1173; [#1080](https://github.com/srikanth235/centraid/issues/1080), R-ONBOARD-11) |
| `pair-command` | Pairing | the terminal line with the command to run on the backup device (WAITING and FAILED) |
| `pair-safety-number` | Pairing | the safety number in its groups of 5, four to a row, once paired (a screen reader says the whole number) |
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
| `import-reminders` | made vault, under the import banner once its imports are over | the verb that reads the phone's Reminders and imports them as tasks — **iOS only**; Android has no Reminders store |
| `import-completed-toggle` | made vault, beside `import-reminders` | the chip that also brings completed reminders in (selected while on) — **iOS only**; Android has no Reminders store |
| `home-vault-sheet` | Home | the vault switcher sheet |
| `vault-row-<vaultId>` | Home | one switcher row (and `vault-forget-<vaultId>`, its **Delete**) |
| `vault-rename-<vaultId>` | Home | one switcher row's Rename (a swipe on iOS, also in the row's long-press menu; a button on Android), and `vault-rename-field` / `vault-rename-save` in its dialog |
| `vault-found-button` | Home | the vault switcher's "Make a vault" (R-ONBOARD-11) |
| `vault-restore-button` | Home | the vault switcher's "Restore my vaults" |
| `first-launch` | First launch | the welcome screen (`first-launch-title`, `first-launch-claim-<n>`, and `first-launch-primary` / `first-launch-secondary` for its two doors) |
| `chat` | Chat | the tab's root |
| `chat-field` | Chat | the composer's text field (ready phase only) |
| `chat-send` | Chat | Send, which becomes `chat-stop` while a turn runs |
| `chat-stop` | Chat | Stop, while a turn runs |
| `chat-download` | Chat | "Download model", in the model step |
| `chat-model-note` | Chat | the model step's one sentence |
| `chat-empty` | Chat | the empty thread's one line |
| `chat-suggestion-<n>` | Chat | the n-th suggested question, from 0: a row in the empty thread, a chip in `chat-suggestion-chips` above the composer once the thread has messages |
| `chat-suggestion-chips` | Chat | the chips' row above the composer in a live thread |
| `chat-card-<n>` | Chat | the n-th row-card under an answer, from 0 |
| `chat-pending` | Chat | the lines of the confirm card under an answer that proposes a write, read as one element |
| `chat-pending-confirm` | Chat | its confirm, worded by its verb ("Add reminder"; "Confirm" when the steps differ) (outlined in `net` when the card asks twice) |
| `chat-pending-cancel` | Chat | its Cancel |
| `chat-pending-settled` | Chat | the one clause that says how the card ended ("Done.", "Not done.") |
| `chat-new` | Chat | the header's New chat |
| `kit-empty-import` | any app | the import from where the phone holds the data ("Import contacts" on People), in place of the empty state's action |
| `kit-empty` | any app | the empty state itself (its sentence) |
| `kit-empty-action` | any app | the empty state's one action ("Add a document"), when there is no import |
| `words-shown` | words.make / words.show | the recovery key's 24 cells, read as one grid (each cell is `words-word-<n>`) |
| `words-save-copy` | words.make / words.show | "Save a copy" — the share sheet with the key as one line |
| `words-make-primary` | words.make | the sheet's primary ("I've saved it", "Done") |
| `words-make-secondary`, `words-enter-secondary`, `words-show-secondary` | words.make / words.enter / words.show | the round X at the top: the screen's own leave control (Cancel), spoken as its label |
| `words-held-found` | words.enter | the "Recovery key found" card of a held-key restore, with where it came from |
| `health-band-<tab>` | Health | one band tab (`today` (the Summary), `trends`, `workouts`, `more`); `health-band` is the plate (#1129) |
| `health-connect-open` | Health | the not-connected empty state's one action, which pushes Connect |
| `health-hero`, `health-metric-<key>`, `health-trend-<key>` | Health | The Summary's steps card, another pinned card and a Trends row, each the tap to its metric page (`<key>` is `steps`, `sleep_min`, …) |
| `health-highlight-<key>` | Health | one Highlights card on the Summary (`<key>` the metric), the tap to its page |
| `health-workout-<activityId>` | Health | one workout row (Today and Workouts) |
| `health-range`, `health-metric-range` | Health, a metric | the segmented range (Trends: 30 days · 90 days · Year; a metric: Week · Month · 6 months · Year) |
| `health-more-<key>`, `health-reads`, `health-reads-close` | Health | a More row (`reads`, `choose`, `stop`), the "What Health may read" sheet and its close |
| `health-metric-page`, `health-workout-page` | a metric, a workout | the pushed page's scroll |
| `health-metric-chart`, `health-metric-versus` | a metric | the bar chart (a finger on it scrubs) and the line against the typical |
| `health-connect-page`, `health-choice-<key>`, `health-connect`, `health-connect-status` | Connect | the page, one type's switch, the one Ink button ("Connect Apple Health"), the status line |
| `kit-pushed-back` | any pushed page (iOS) | the kit's back control, named for the parent |
| `BackButton` | any pushed page (iOS) | the navigation bar's back — UIKit's own id; Maestro's `back` is Android's system key and does nothing on iOS |

Home, its Settings and vault sheets, the Backup screen, the welcome screen and Chat set tags; the Backup screen's ids are written in both shells and selected by no flow yet. The iOS shell runs on a simulator against the real `HomeMachine` through `HomeBridge`, so the iOS half of each id renders; the Android half is compiled and unobserved, because no machine here has an Android emulator.

**A CONTAINER'S ID LEAKS ONTO ITS CHILDREN ON iOS.** `.accessibilityIdentifier` on a plain `VStack`/`HStack` is handed down to every child that is not an element of its own, over the child's own id — every Home tile read `home-grid`, and the empty state's buttons read `kit-empty`. A container that carries an id and has selectable children marks itself `.accessibilityElement(children: .contain)` first (`TileGrid`, `KitEmpty`). The Docs band's buttons all still read `docs-band`; no flow selects them yet.

**Run on the iOS simulator (2026-10-13):** `first-launch.yaml`, `onboarding.yaml` and `home.yaml` pass. The two fresh-install flows launch with `permissions: all: deny` — Maestro grants every permission by default, and a made vault imports what it is granted — and need `xcrun simctl keychain <udid> reset` first. `home.yaml` runs on the vault `onboarding.yaml` leaves. `chat.yaml` and Android are not yet run.
