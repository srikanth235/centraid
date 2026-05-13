# issue-30 — Builder redesign v2

GitHub issue: [#30](https://github.com/srikanth235/centraid/issues/30)

## Checklist

- [x] Lead chip row with `✨ Try` label so suggestions read as contextual follow-ups
- [x] Demote `Open folder` from labeled pill to icon-only utility (matches Attach)
- [x] Restyle prompt-starters as transparent hairline pills with hover lift
- [ ] Add change-card affordance to tool groups when files are written
- [ ] Add Tablet device option to mobile/desktop toggle
- [ ] Move Preview / Code / Cloud tabs from window titlebar into right-pane toolbar
- [ ] Consolidate sync indicators into one canonical header status

## What changed

**Lead chip row with `✨ Try` label so suggestions read as contextual follow-ups.** The four hardcoded prompt-starters (`Improve the layout`, `Add saved data`, `Polish the visual style`, `Prepare to publish`) used to float as a row of solid pills above the input — visually disconnected from any conversation context, reading as empty-state filler that never went away. They now lead with a small monospace `✨ Try` label (new `.prompt-starters-label` rule, paired with a new inline `SparkleIcon` glyph) so the row reads as a suggested-follow-ups affordance.

**Demote `Open folder` from labeled pill to icon-only utility (matches Attach).** The input footer used to render `[Attach +] [Open folder]   [Send →]` — three buttons of different shapes and weights competing for attention next to the primary Send action. `Open folder` is now an icon-only pill (new inline `FolderOpenIcon`) sitting next to `Attach`, so the footer reads as `[attach] [open folder]   [send]` — one verb (Send) with two unobtrusive utilities.

**Restyle prompt-starters as transparent hairline pills with hover lift.** `.prompt-starter` was a solid `var(--bg-elev)` pill with a 1px border. It's now a transparent hairline pill (`0.5px solid var(--line)`, no fill) that picks up a subtle ink-mix background only on hover — matches the new follow-up framing where the chips should feel suggested rather than primary. New `.input-pill-icon` modifier handles the square 28×28 sizing for the demoted Open-folder + Attach buttons.

## Out of scope

- Wiring suggestions to be turn-aware (currently the same four hardcoded chips). Adding context-aware follow-ups requires plumbing through the agent harness — separate piece of work.

## Verification

- `bun run typecheck` clean for `@centraid/desktop` after each commit.
- Manual verification deferred until the full redesign lands — see in-progress checklist above.
