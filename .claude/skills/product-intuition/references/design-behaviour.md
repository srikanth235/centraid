# Design behaviour

How screens behave and what they say. Values (colours, type sizes, radii, spacing, motion durations, glass recipes) are not here: they live in the mockups in `design/mockups/` (the rules board is `DesignRules.dc.html`, the open decisions `Decisions.dc.html`) and in `design/tokens.toml`. Parity between the shells is the same behaviour, words and selector ids, never the same pixels.

## Rooms

A mobile screen is one of seven rooms, and nothing else. The room owns the header, the back control, search, the empty/loading/error states, the status host, selection and the gutter; the app supplies content and copy. A screen that hand-rolls any of those is a finding, not a variant.

| Room | Anatomy | Examples |
| --- | --- | --- |
| `HomeRoom` | the vault lockup, a search key at its trailing edge (every app), the appearance key, widgets and app tiles, one status line, one trailing verb (Settings) | Home |
| `AppPlace` | the platform navigation bar (back to Home, the app's name, at most two trailing items), no row of chips under it, the app band floating at the foot | Photos grid, Agenda |
| `PushedPage` | `PlaceHeader`, back to the named parent (a computed `PlaceRef`, never a string), at most one trailing action; a "…" key that opens the platform menu counts as that action | album, contact, document, settings sub-page |
| `EditorRoom` | full screen, autosave, close = done, band hidden, status line hosted inside | note, document, expense, event |
| `SheetRoom` | grabber, title carrying the noun, at most one ink button, status line hosted inside | confirm delete, pick date, add to album |
| `SystemPlace` | `PlaceHeader` + `SectionBlock` / `RowsBlock` only; a place root draws the Home band, a sub-page keeps its back key | Settings, Backup |
| `StageRoom` | full-bleed media ground, no header and no band, the caller's own floating chrome, one close act reached by a control and by a swipe down | photo lightbox, slideshow, video |

`StageRoom` takes none of the room furniture on purpose: one piece of media has nothing to be empty of, nothing to search, no list to select from. What it owes is a way out, so a stage that brings no chrome gets the room's own close key. **The Photos viewer is a light page, not a stage** (only its slideshow is one): it opens photo-only on the page's own ground, with no black letterbox and the details closed every time; (i) or a swipe up opens the details and the photograph shrinks up (an M3 bottom sheet on Android), (i) or a swipe down closes them before a swipe down closes the viewer; the floating bar is the page's last row, so it never covers the details.

The shell's places are not apps. `ShellModel.Tab` is `home`, `chat` and `backup`; Chat and Backup have no tile and no catalogue row. **Chat** follows `HomeRoom`'s frame: the shell band at its foot, hidden only while the composer has focus, one filled ink element (Send, Stop while a turn runs). Its status line ("Looking in Tasks…") sits just above the composer while a turn runs, and a card in an answer pushes the real row's route over the shell so back returns to the chat. Chat is iOS only until Android ships it. **Chat opens to a ready conversation**; its header holds the title, one **Chats** key (the clock) that pushes the Chats page (a chevron back, the threads newest first, search by the foot's key, no band under it) and, only inside a saved chat, the New chat pencil. There is no drawer and no New chat button.

Six rulings sit behind the rooms and are not re-decided per screen: trash, casing, editors, push-versus-sheet, the band under a selection, and where Settings is reachable from.

## App roots

**One way home.** The band holds the Home key, up to four places and the search key. Back chevrons appear only on pages you drill into. A swipe in from the leading edge of an app root (the trailing edge in right-to-left) is the Home key too: on iOS the root states it itself, since hiding the back chevron also puts the system swipe away; on Android it is the system back gesture, which pops the root. **Under the title an app root draws at most the subtitle and one control row** (a view picker leading, its stepper trailing): the period or scope and its count are the subtitle ("November 2026 · 8 events"), never also a heading or a second line in the content. The shell band lists Home, Chat and Backup, never an installed app; every app is a tile on Home. A locked Locker keeps the whole band (Home and the plate of its places, dimmed with none lit, no search): a tap on a place starts the unlock and lands there once it opens.

| Slot | Holds | Never |
| --- | --- | --- |
| Header, trailing | at most two keys: a glass tool key (the filter menu) and a filled `+` in the app's accent; Select where the app makes nothing | a word, a third key, search, any other menu (a "…" that opens the platform menu is allowed on a pushed or stage page, never on an app root) |
| Header, filter | **the filter is always the funnel**: one button that opens the platform's own menu (SwiftUI `Menu`, Material `DropdownMenu`), in every app that filters or sorts: filters as checked options, a Type / Modified / Label style filter as a submenu, then the sort, then any view choice. Rust finishes the whole menu (`FilterMenu`) and says whether a filter is on (`filtering`): the funnel is then drawn solid, never a dot or a count, and "Clear filters" stands first. A sort or a view never lights it. Ids `<app>-filter-menu`, `<app>-filter-<section>-<option>`. A scope the page is in (a notebook, Money's month) is the title's second line (`HeaderSubtitle`), with a ✕ when it can be cleared | a chip row, a sort sheet, a second sort control, a filter in More |
| Band, trailing | the search key, id `band-search` on both shells; tapped, the field takes the band's place at the foot, focused and just over the keyboard, with a ✕ that closes search and brings the band back. An app with no search draws no key | a bar under the title, a More row, a header glyph, a place in the plate |
| Band, zoom | a view of the same things (Photos' Years · Months · All) is a segmented control in the band; away while selecting | a chip, a toggle in More, a second floating bar |
| Band, places | two to four places, then More | a filter |
| More | Trash, Import, Export, alternate views, "What X may read": machine rows | Search, Sort, a filter |

An app may have two homes: Agenda is one app with Calendar · Reminders · Invites · More, and Tasks is not an app of its own.

## Status line

State is reported on **one status line** and never a toast. It is a single persistent line docked at the foot of the place directly above its band, or at the foot of a pushed page, sheet or editor, which draw no band. It is a sentence in the small style (the refusal tone when refused), updated in place: no stacking, no overlay, no auto-dismiss animation, no dot, at most one inline text action. The shell's import line takes the same seat: progress, then outcome, one action, and a close key once the work is done. No badge counts, red dots, bounces or parallax.

A screen's load is a skeleton (`ReadStateView`). A spinner (`KitSpinner`, `StageSpinner`) exists only for work with no shape to draw (a save in flight, a transfer starting). Work whose count is known gets a determinate bar and exact counts: a local-first product always knows how long.

## Search and Ask about

Search says what it searched for, and offers the assistant when it found nothing ([#1097](https://github.com/srikanth235/centraid/issues/1097)).

| Moment | Draws | Never |
| --- | --- | --- |
| The core corrected a typo (the exact answer had fewer than three rows and a word a slip away added some) | one line directly over the open field (under it on Home's search page and the Chats page): "Including results for “sunscreen”" (`SEARCH_CORRECTED`, id `search-corrected`), drawn once per field component; the machine puts `SearchField.corrected` in state | a banner, a toast, a second row of results, the line over an exact answer or when the corrected words added no row, or over rows for a term since changed |
| Home's search, matched or not | the Ask row at the foot of the answer: “Ask about “zzqx”” (`SEARCH_ASK_ABOUT`, id `search-ask-about`). The shell switches to the Chat tab, unscoped, and sends "Find zzqx". The machine finishes the whole row (`SearchAsk`: label, question, scope) in `SearchField.ask_row`. Drawn only where the shell has a Chat tab (iOS today) | a second sentence, a button inside a row, an action in the empty state |
| An app's own search (Notes, People, Docs, Agenda including tasks, Photos, Money) | the same Ask row whenever the machine put one in `SearchField.ask_row`; it opens the chat scoped to the app searched from, with the typed text as the question. One `SearchAskRow` per shell. **Locker's search never offers it**: its term can itself be a secret | a second presentation, a row the view decides to add |
| A search matched the name of a notebook, album, project or Docs folder | one container row per match above that app's result rows: its kit glyph, the title and the kind in a soft word, id `search-container-<entity>-<id>`. One `SearchContainerRow` component per platform; the machine finishes the words, glyph and reference (`SearchContainer`), and a tap opens it through the shell's one row router. A matched container is an answer: the no-match sentence is not drawn over it | a second router, a row of the view's own, "nothing found" over a notebook that was found |

## Controls

**Chrome is the platform's; content is the kit's.** The navigation bar (back, title, trailing verb) and a sheet's grabber and detents are drawn by the platform, never by a screen. Everything under the bar is drawn from the kit, never hand-rolled.

| Control | Kit (iOS · Android) | Behaviour |
| --- | --- | --- |
| Ink button | `KitInkButton` · `InkButton` | the one thing to do: full width; destructive is the outlined state-red variant at the same width. At most one filled element per view |
| Outline button | `KitOutlineButton` · `OutlineButton` | a secondary verb: hugs its label, aligns with the leading edge of the text above it |
| Link | `KitLink` · `KitLink` | a verb that reads as words |
| Choice stack | `KitChoiceStack` · `ChoiceStack` | alternatives stacked vertically (an Ink button with Cancel or Not now) in one column sharing one full width |
| Icon key | `KitIconKey` · `IconKey` | 44 target |
| Chip | `KitChip` · `KitChip` | a filter or a choice among several; selected is never the accent |
| Segmented | `KitSegmented` · `KitSegmented` | one of two to four views |
| Stepper | `KitStepper` · `KitStepper` | previous / next, each key with its own id |
| Check · Switch | `KitCheckBox`, `.kitToggle()` · `KitCheckBox`, `kitSwitchColors()` | a check has four states: off, on, mixed (a dash: won't do) and partial (half filled: started) |

Width belongs to the control, not to the call: there is no per-call width switch. Rulings that hold for every control:

- **Destructive** confirms through `ConfirmSheet`, never an alert or a confirmation dialog.
- **Disabled** is drawn on the leaf, never a faded container, and a disabled verb is still drawn so the member sees what becomes possible.
- **Targets** are 44. A 34 target exists only inside a dense row, through the named constant (`targetMinFine`).
- **Radii and values** come from the generated tokens; a literal radius or colour is a finding.
- **Pressed is the one interaction state**, under the finger on the control's own rung: never a ripple, a scale or an opacity. A tappable row is a `Button`, never a tap gesture.
- **Haptics**: one selection tick when the lit tab of an app's band changes; nothing else buzzes. A success haptic fires when the write resolves, never at the tap.
- **Loading, empty and failure** go through `ReadStateView`; a bare spinner outside the kit is a finding, and an empty state with something to do carries its action.
- **A "…" key opens the platform's own menu** (SwiftUI `Menu`, Material `DropdownMenu`), never a sheet; Rust finishes the rows and their words. The Photos viewer's (Slideshow, Add to album, Adjust location, Download) is the model.
- **More and Reads** sheets are `OptionSheet`s; a `NavigationStack` inside a sheet is for a sheet that pushes. An `OptionSheet` takes the height of its rows (one fitting detent on iOS, the M3 modal sheet opened at content height on Android), is one surface (the rows stand on the sheet itself, grouped by hairlines with none under the last, no inner card on the sheet's ground) and, on iOS 26, sits on the system's own sheet background.

## Colour

**Colour has one job each.**

- An app's colour marks that app: its tile, its accent (the filled `+`, selected states in its own pages) and its content markers. Anything shown from another app uses that app's colour.
- State colours only mean state: red, amber and green appear in words and badges to say overdue, pending or done, never as decoration. An app colour is chosen so it never collides with a state that appears inside the app (Calendar red is out of Agenda because overdue is red; Money is not green because income is). Inside Health every metric wears the Health colour.
- The shell's colour (Welcome, Home, Chat, Backup) is its own and is not an app's.
- Lists, calendars and categories draw from one shared palette, only as dots, bars, tiles and big titles. There are no red, amber or green lists; an imported red list becomes raspberry.
- Colour is never the only channel: every app mark is told apart by silhouette alone.

The values are in `design/tokens.toml`; the reasoning per app is on the rules board `design/mockups/DesignRules.dc.html`.

## Accessibility

- Text is 4.5:1 or more and controls 3:1 or more, in light and dark, on every surface they land on.
- Glass turns solid under Reduce Transparency (and Increase Contrast on iOS), on any OS version. Android's plates are already opaque; high-contrast text is the one signal its band listens to.
- Cards reflow at large text sizes. Both shells follow the system text size up to the largest the system offers (iOS Dynamic Type up to `accessibility5`, Android font scale 2.0; owner ruling of 8 November), set once at the root, and layouts reflow from `xxxLarge` / 1.3 up; the band's labels hold their size at every setting. Components survive the largest permitted size, reduced motion, light and dark, VoiceOver and TalkBack, and RTL (leading and trailing, never left and right).
- Reduced motion is honoured everywhere: the slide or entry becomes the change.
- Text in a fixed-height container is line-clamped, never clipped. State is never expressed with container opacity. Icon-only controls carry a label; decorative glyphs say so.
- Targets and rows are 44 and the page margin is the token's; a band holds at most five destinations because a tab below 44 stops being a tap target.

## Wording

**Copy is signage, not conversation**: calm, concrete, specific, read at a glance. "Photo deleted" is the register; "Deleted" drops the noun and "Your photo has been successfully deleted." pads a fact. Copy lives in the Rust string catalogue, `crates/screens/src/strings`, and only there; the kit's fixed words (`strings/shared.rs`) are emitted into both shells' `Words` tables, and the assistant's turn sentences are `copy/chat.json`. **Every word on a board exists in the core's strings**, or is added there in the PR that builds the screen. `scripts/lint-copy.mjs` enforces the rest.

Members read _backup device_; code and docs say _gateway_.

| Surface | Budget |
| --- | --- |
| Button, action, menu row | 1–2 words, verb first |
| Status line, outcome | a fragment ("Photo deleted"), never "successfully" |
| Status line, state | one clause |
| Empty state | one sentence and at most one action; no feature explanation. Where the phone holds the data, its import is the one action. The glyph on its wash is the app's own, except a trash's, which wears the Trash glyph (`EmptyState.icon_key`) |
| Banner (offline, degraded) | one sentence: the state, plus one action or one consequence |
| Error | what happened and what to do, about 12 words or fewer; no apology, no "Please try again." |
| Settings label + description | the label carries the meaning; the description is one sentence or absent |
| Placeholder | a short noun phrase |
| Consent, destructive confirm, security or privacy disclosure | full sentences: the one home for reassurance |

- **Banned everywhere**: "please", "successfully", "simply", "in order to", "you can", "we're sorry".
- **Defensive reassurance** (a fact followed by what was not lost, deleted or sent) belongs only where the risk decision is made, and a disclosure keeps its full sentence there. A status line, empty state or shelf header repeating the promise is noise.
- **One noun per thing**, the same on every seat; a short form may drop words from the full name, never swap one in. A vault is never the actor.

| Say | Never |
| --- | --- |
| backup device | gateway, laptop, machine, NAS, server |
| recovery key | 24 words, seed, phrase, passphrase |
| QR code (button "Scan QR code"), pairing code | square, payload |
| this phone | this device |
| photo | photograph |
| backed up | synced, sealed, drained, copied to the gateway |
| Try again | Retry |

A literal command the member types stays as written (`centraid-gateway pair`), and where the member types the key, "the 24 words of your recovery key" is fine. Internals are not copy: never seal/unseal, receipt, ledger, drain, "derived", "at rest" or `core.*`. Do not hard-code counts that rot ("Eight apps").

Hard caps in words, by key suffix (a `{placeholder}` is one word): `_LABEL`, `_ACTION`, `_PRIMARY`, `_SECONDARY`, `_BUTTON` 4; `_NOTE`, `_DETAIL`, `_LEDE`, `_STATUS`, `_HINT` 12; `_BODY`, `_LEAD`, `_NOTICE` and errors 25; `_TITLE` 6. A `·` never joins two thoughts in one string; it survives only between short metadata facts ("Edited · 3 days ago").

Worked pairs ([#805](https://github.com/srikanth235/centraid/issues/805)): "Photos Memories empty state" went from three sentences to "Your own photos, noticed — a year behind a day, a trip, a burst."; a write failure went from "<title>: Please try again." to "<title>. Try again." Audit everything, churn nothing: a string already inside its budget is left alone.
