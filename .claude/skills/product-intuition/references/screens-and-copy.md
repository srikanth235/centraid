# Screens and copy

These are the behavioural contracts for Centraid's native screens. The visual source is the committed [mockups](../../../../design/mockups/README.md), including the Design rules and Decisions boards. Shared values come from [design/tokens.toml](../../../../design/tokens.toml); `cargo xtask design` generates the native resources, catalogue, kit words and dark mockups. A visual or UX change begins with the light mockup and updates it in the same PR as the implementation. Dark mockups are generated, never hand-edited.

Rust owns what a screen shows, says, enables and does. SwiftUI and Compose draw the same behaviour, words and selector ids using each platform's primitives. They do not need identical pixels. A missing label, state, identity key or destination is a gap in Rust's view state, never a product decision for a shell to reproduce.

## Rooms

A room owns its header, back control, search, read states, status host, selection and gutters. The app supplies content, words and actions. Reuse the native kit's room instead of hand-rolling its frame.

| Room | Owns | Examples |
| --- | --- | --- |
| `HomeRoom` | Vault identity and backup line, the Home search key, app widgets, the shell band, one status line | Home |
| `AppPlace` | App title, at most two trailing header keys, the app band, search and filter presentation, read states and one status line | Reminders, Photos library, Docs Browse |
| `PushedPage` | A back control to the named parent carried by the core's `PlaceRef`, content and one status line; no app band | Person, event, album, settings sub-page |
| `EditorRoom` | Editing content, close/done or explicit save as the core requires, save state and one status line; no band | Note or document editor |
| `SheetRoom` | Native grabber and detents, a title naming the thing, choices or confirmation, at most one primary action and one status line | New reminder, pick date, confirm deletion |
| `SystemPlace` | Grouped settings sections and rows; a root keeps the shell band, a sub-page has its real back target | Settings, Backup |
| `StageRoom` | Full-bleed media, no band or ordinary header, the media's own controls and one close action reached both by a visible key and a swipe down | Photo lightbox, slideshow, video |

Content pushes; decisions use a sheet. A page the member reads has a real back target, and a choice does not become a new navigation destination. An editor's exit must respect its actual save behaviour: close is done only when autosave can preserve the content. A stage with no caller-provided chrome still supplies a visible close key.

## Navigation

There is one way Home: the Home key in the band. Back chevrons appear only on pages the member drilled into. The band holds that key, up to four places and a search key where search exists. More holds secondary destinations and actions, including Trash, Import and Export; search and sort do not become More rows. The shell places are Home, Chat and Backup, and the installed apps are reached through Home's widgets.

The header has at most two trailing keys: a glass tool key and the app's filled accent `+` when it creates things, or Select where appropriate. Filter is always the funnel. The core supplies the filter groups, checked choices, sorting, available views and whether a filter is active. The active filter is signalled by its checked state and filled funnel, not by a count or a red dot. Clear filters is first when needed. Sorting or changing the view alone does not signal an active filter. A scope, such as a notebook or Money's month, is the title's second line rather than another filter strip.

An open search field takes the band's place above the keyboard. Closing it dismisses the keyboard and restores the band. A searchable pushed page without a band can carry the search key at its trailing foot. A selection bar replaces the band rather than adding a second floating bar. A view of the same collection, such as Photos' Years, Months and All, uses the existing band space.

Selector ids are the same on both platforms. Shared search uses `band-search`, `search-corrected` and `search-ask-about`; filter controls use `<app>-filter-menu` and `<app>-filter-<section>-<option>`. The core provides routes; a native view does not invent a screen id or destination.

## Status and loading

`StatusLine` is the single feedback channel for a screen: one persistent line, updated in place, with at most one inline text action. It sits directly above the band, or at the foot of a pushed page, sheet or editor. The import line uses that same seat. An import shows progress, then its outcome and any next action; its close control becomes available when the work is done.

Do not stack feedback, show a toast, auto-dismiss an outcome, or signal a new event with a red dot. Counts in a smart-list card describe the collection; they are not a second feedback channel. A status outcome names the thing, such as “Photo deleted”; a state is one clause. Refusals describe what happened and what the member can do, with no exception string.

Keep the four read states distinct:

- **Loading:** a static skeleton for content whose shape is known. Use determinate progress with counts when work is measurable. A kit spinner is only for work with no content shape or known count, such as a save beginning.
- **Data:** the actual current result, with a paging action when more exists.
- **Empty:** a successful read with nothing to show, one sentence and at most one useful action. Where the phone already holds data, offer its import at the point of use.
- **Denied or failed:** the reason and an actionable repair. A refused permission, failed read or missing bytes never becomes an empty-state claim.

A decoding failure stays loading or becomes a stated failure; it never claims an empty vault. Recessive states use their own leaf tokens, not an opacity applied to a container. Loading skeletons do not shimmer. Reduce Motion suppresses unnecessary movement. A success haptic follows the completed write rather than the initiating tap.

## Search

Search reads the vault's one index, never a native substring engine. Closing search clears the term, results, correction and Ask row. Changed terms and stale answers cannot leave old annotations over new results. A trashed entity does not appear, and no secret is indexed.

When the core corrects a term to words the vault contains and those words add results, show its “Including results for ‘…’” line beside the open field. Do not show a correction over an exact answer, a correction that added nothing or a result for another term.

Draw an “Ask about ‘…’” row only when the core supplies `SearchAsk` for the current, nonblank, permitted search. It is especially the way forward from no matches. A tap opens Chat with the supplied question and app scope; Home's search is unscoped. The row is a single action beneath the answer, not another empty-state sentence or a nested button. **Locker never offers Ask:** the search term itself can be a secret.

A notebook, album, project or folder whose name matched is a result. Draw the core's container row before the app's item rows, with its title, kind and shared icon, and open it through the same reference router used by a chat card. Include it in the result count; never show “nothing found” above a matched container.

## Accessibility

All system text sizes are supported, including iOS accessibility sizes and Android's larger font scales. Do not cap them at `xxxLarge` or 1.3. Cards and rows reflow, controls remain reachable, and important words are not clipped inside fixed-height boxes. At large sizes, use fewer columns or a vertical arrangement before sacrificing the label. Width changes layout, not the meaning of a type role.

Text meets at least 4.5:1 contrast on the actual surface beneath it; controls and meaningful graphics meet 3:1. App or list colours do not replace labels, symbols or state words. The list palette is for dots, bars, tiles and large titles, never small body text. Dark app and state text has its own value, distinct from the fill under white glyphs. Content colours, including photographs, document pages, list colours and the app mark, are preserved.

Floating controls use Liquid Glass on iOS 26, with a solid fallback before iOS 26 and under Reduce Transparency or Increase Contrast. Android uses Material 3 Expressive. Content cards and lists remain solid. Only floating controls cast shadows.

Give every icon-only control an accessible label and every interactive control its native role, state and adequate touch target. Use at least 44pt on iOS and the platform's 48dp touch target on Android. Decorative glyphs are hidden from accessibility. Do not replace a container's readable content with an accessibility label unless that container is itself an icon-only control. Tappable rows are buttons, not unlabeled tap gestures.

Test light and dark, the largest text sizes, Reduce Motion, Reduce Transparency or the platform equivalent, VoiceOver, TalkBack and right-to-left layout. Use leading/trailing and logical properties so the layout mirrors. Keep codes and numeric runs directionally isolated where needed. Request permissions at the moment they are needed and expose the Settings repair after denial.

## Controls

Native kit controls wrap each platform's primitives. A screen does not introduce another control vocabulary. Use the mockups for the visual roles: header keys, one primary pill, a tinted secondary action and text actions. The app's accent identifies its actions; shell actions use the shell accent. A star uses its app's colour, never amber. Red, amber and green in words and badges mean states only.

Use the kit's confirmation sheet for a destructive choice, with a title naming what will be removed and an action matching what the core really destroys. Trash is per app. Offer Empty trash or Delete forever only when the underlying command exists; otherwise offer restore without a false promise of permanent deletion.

Disabled actions remain visible when they teach what becomes possible. Give the explanation the core supplies, and apply disabled styling to the leaf. Pending writes use the actual pending state. A create ends its sitting after success so a second tap cannot create another item. Any failure that matters reaches the status host.

Use the native date/time picker and platform sheet chrome through the kit. A sheet contains a navigation stack only when it has actual sub-pages; wrapping an ordinary choice in one creates a second header. Icon paths come from the shared catalogue. Identity hue, initials, figure tone, date labels and money are computed once by Rust and arrive ready for the shell to look up or draw.

## Wording

Copy is calm, concrete, confident, short and in sentence case. One glance is the unit. Keep the noun that makes an outcome legible: “Photo deleted”, not “Deleted”. Cut filler rather than adding a second sentence to explain the first. Never show raw exception text or internal schema, transport or engine terms.

Screen copy lives in `crates/screens/src/strings`. Views draw finished strings from their state, and `cargo xtask design` exports the kit's fixed words from the Rust catalogues. Assistant turn sentences live in `copy/chat.json`. Every word invented by a mockup must exist in the core strings or be added in the PR that builds it.

| Surface | Budget |
| --- | --- |
| Button, action or menu row | One or two words, verb first |
| Status outcome | A fragment naming the thing |
| Status state | One clause |
| Empty state | One sentence and at most one action |
| Banner | One sentence: the state and an action or consequence |
| Error | What happened and what to do, about twelve words |
| Setting | A label carrying the meaning; one description sentence or none |
| Placeholder | A short noun phrase |
| Consent, destructive confirmation, security or privacy disclosure | Full sentences where the decision is made |

Reassurance belongs at the risk decision: a consent, destructive confirmation or security disclosure. Do not repeat what was not lost, sent or deleted on ordinary statuses, empty states or headers. Keep the full disclosure where the member actually decides.

Do not write “please”, “successfully”, “simply”, “in order to”, “you can” or “we're sorry”. These phrases label neither a fact nor an action. Do not hard-code counts that become stale, such as the number of apps.

| Say | Retired synonyms |
| --- | --- |
| backup device | gateway, laptop, machine, NAS, server |
| recovery key | seed, phrase, passphrase, your words, 24 words |
| QR code; Scan QR code; pairing code for its text form | square, payload |
| this phone | this device |
| photo | photograph |
| backed up | synced, sealed, drained, copied to the gateway |
| Try again | Retry |

Code and technical docs say gateway. A literal command stays exactly as typed, such as `centraid-gateway pair`. “The 24 words of your recovery key” is appropriate where those words are entered. A vault is not the actor: name the app or the action that was refused.

The copy lint's ceilings remain unchanged. Count a `{placeholder}` as one word: `_LABEL`, `_ACTION`, `_PRIMARY`, `_SECONDARY`, `_BUTTON` allow four; `_NOTE`, `_DETAIL`, `_LEDE`, `_STATUS`, `_HINT` twelve; `_BODY`, `_LEAD`, `_NOTICE`, `_FAILED`, `_ERROR`, `_REFUSED`, `_DENIED` twenty-five; `_TITLE` six. These are ceilings, not targets. A middle dot joins only short metadata facts, never two thoughts.

A destination, its rows and its spoken labels use the same noun; the screen title wins. A short form may omit words but does not substitute a synonym. Rename shared words at their Rust source. Identifiers are not copy: route ids, wire fields, file names and concept keys retain compatibility independently of the words a member reads.
