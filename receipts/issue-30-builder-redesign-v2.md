# issue-30 — Builder redesign v2

GitHub issue: [#30](https://github.com/srikanth235/centraid/issues/30)

## Checklist

- [x] Lead chip row with `✨ Try` label so suggestions read as contextual follow-ups
- [x] Demote `Open folder` from labeled pill to icon-only utility (matches Attach)
- [x] Restyle prompt-starters as transparent hairline pills with hover lift
- [x] Add change-card affordance to tool groups when files are written
- [x] Add Tablet device option to mobile/desktop toggle
- [x] Move Preview / Code / Cloud tabs from window titlebar into right-pane toolbar
- [x] Consolidate sync indicators into one canonical header status
- [x] Drop the `Editing existing project` divider (mockup absorbed it into the header)
- [x] Replace inline description subtitle with `● Live · v3 · edited 14h ago` status row

## What changed

**Lead chip row with `✨ Try` label so suggestions read as contextual follow-ups.** The four hardcoded prompt-starters (`Improve the layout`, `Add saved data`, `Polish the visual style`, `Prepare to publish`) used to float as a row of solid pills above the input — visually disconnected from any conversation context, reading as empty-state filler that never went away. They now lead with a small monospace `✨ Try` label (new `.prompt-starters-label` rule, paired with a new inline `SparkleIcon` glyph) so the row reads as a suggested-follow-ups affordance.

**Demote `Open folder` from labeled pill to icon-only utility (matches Attach).** The input footer used to render `[Attach +] [Open folder]   [Send →]` — three buttons of different shapes and weights competing for attention next to the primary Send action. `Open folder` is now an icon-only pill (new inline `FolderOpenIcon`) sitting next to `Attach`, so the footer reads as `[attach] [open folder]   [send]` — one verb (Send) with two unobtrusive utilities.

**Restyle prompt-starters as transparent hairline pills with hover lift.** `.prompt-starter` was a solid `var(--bg-elev)` pill with a 1px border. It's now a transparent hairline pill (`0.5px solid var(--line)`, no fill) that picks up a subtle ink-mix background only on hover — matches the new follow-up framing where the chips should feel suggested rather than primary. New `.input-pill-icon` modifier handles the square 28×28 sizing for the demoted Open-folder + Attach buttons.

**Add change-card affordance to tool groups when files are written.** Tool-group pills used to show only a verb summary (`Reading ×3, Writing`) and you had to expand the row-by-row list to see *what* the agent actually changed. The renderer now scans each group's calls for completed file-writing operations (`write` / `edit` / `multi_edit` with `state === 'ok'`) and, when there's at least one, renders an inline `.tg-change-card` below the pill. The card shows the file count (`2 files updated`), up to three basenames in monospace, and a `+N more` overflow when there are more — clicking the card toggles the group like the pill does. Driven by an accent-tinted card with a small `FileEditIcon` glyph in a square chip, so it reads as a confident "here's what shipped" affordance rather than a status row.

**Add Tablet device option to mobile/desktop toggle.** The URL bar's device segment used to be a binary mobile/desktop pair. Tablet was the missing middle — iPad-class viewports (~820pt) map well to the gateway-served preview iframes. `DeviceKey` now includes `'tablet'`, the URL bar group renders a third button between mobile and desktop, `refreshTopbarToggles` syncs its `data-active`, and `renderPreview` paints `.preview-card-tablet` when selected. The `has-phone` dotted-grid backdrop now applies for both mobile and tablet (only desktop gets the plain flex-stretched stage); new `.preview-card.preview-card-tablet` rule caps the max-width at 820px with the same `var(--shadow-md)` lift as mobile.

**Move Preview / Code / Cloud tabs from window titlebar into right-pane toolbar.** The mode tabs and URL bar used to sit in the window titlebar / app-strip — the same chrome that runs across the entire window — even though they only control what appears in the right pane. The tabs now live in a new `.right-pane-toolbar` directly above the surface they control: `[Preview] [Code] [Cloud]   ⋯   [device pill] [URL] [open] [reload]`. The titlebar keeps Share + Publish (project-level actions); the app-strip keeps history + sidebar toggles. The right pane became a flex column hosting the persistent toolbar (built once on mount) and a renderable `.right-pane-content` sub-element, so `renderRight()` clears only the content while the toolbar stays put across mode switches. The `.preview-pane.has-phone` dotted backdrop is now scoped to `.right-pane-content` so the wall paints only behind the device frame, not behind the toolbar above it.

**Consolidate sync indicators into one canonical header status.** The pane used to communicate "what is the builder doing" through three competing signals: a `Thinking…` pulse row in the chat, a `Building & publishing…` chat status row, and a coloured kind-dot in the URL bar (`live` / `local` / `none`). Those fight for attention and don't roll up into a single read. A single status row now sits in the cd-app-strip directly under the project name (see next item) — a 6px dot + monospace label that derives from `generating`, `publishing`, and `lastPublishedVersionId`. Four states — `idle-draft` (grey · `Draft`), `editing` (accent pulse · `Editing`), `publishing` (accent pulse · `Publishing`), and `idle-live` (green · `Live`). `refreshSyncStatus()` recomputes the state; `renderChat()` calls it for free (covers every `generating` flip), and explicit calls in `handlePublish()` + `bootstrap()` cover `publishing` and `lastPublishedVersionId` flips. The chat-side `Thinking…` pulse stays as a per-message affordance — the header signal is the always-on rollup.

**Drop the `Editing existing project` divider (mockup absorbed it into the header).** The chat used to seed itself with a `kind: 'divider', text: 'Editing existing project'` row on first load — a redundant caption above the starter line, since the project context already lives in the header (icon + name + sync state + version + edit time). The seed is now an empty array; the chat hydrates from real persisted history.

**Replace inline description subtitle with `● Live · v3 · edited 14h ago` status row.** The cd-app-strip subtitle was an editable contenteditable bound to `app.json#description` (default text `Built with Centraid.` / `Add a description…`). The mockup designed a much more functional read-only status row at that slot, fusing sync state + version count + relative edit time into one line. `projSubtitleEl` is now a read-only `.cd-app-strip-status` row containing a coloured dot + monospace text. `paintStatus()` composes the text from `publishing` / `generating` / `lastPublishedVersionId` + new `appVersionCount` (from `versions.versions.length`) + new `appLastEditedAt` (parsed from the active version ID's embedded timestamp via `parseVersionTime`). Edit time updates live: every successful file-write tool execution stamps `appLastEditedAt = Date.now()` so the relative time rolls back to "just now" as the agent works. The standalone `.cd-sync` chip introduced earlier is removed — its signal merged into the dot here. Description data still rides on app.json; only the inline editor is gone (future work: add a settings affordance for editing it).

## Out of scope

- Wiring suggestions to be turn-aware (currently the same four hardcoded chips). Adding context-aware follow-ups requires plumbing through the agent harness — separate piece of work.

## Verification

- `bun run typecheck` clean for `@centraid/desktop` after each commit.
- Manual verification deferred until the full redesign lands — see in-progress checklist above.
