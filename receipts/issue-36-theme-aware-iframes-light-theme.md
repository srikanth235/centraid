# issue-36 — Theme-aware iframes + full-bleed app view + Notion/Linear light theme

GitHub issue: [#36](https://github.com/srikanth235/centraid/issues/36)

## Checklist

- [x] Theme bridge in mini-app templates
- [x] `broadcastThemeToFrames()` in shell
- [x] User apps mount full-bleed
- [x] Dark-shade slider locked read-only at `5`
- [x] Light theme retuned along Notion/Linear lines
- [x] `.cd-main` unified
- [x] Builder preview iframe theme propagation
- [x] Builder sidebar apps list
- [x] Home tiles opaque in light mode
- [x] `bun run --filter @centraid/desktop typecheck`
- [x] `bun run format`

## What changed

**Theme bridge in mini-app templates.** Each mini-app template now ships a small external `theme-bridge.js` (CSP-allowed, inline scripts blocked by the gateway's `script-src 'self'`). The bridge reads `#theme=…&bgL=…` from the URL hash on first paint, then subscribes to `postMessage` for live updates. The shell-side `broadcastThemeToFrames()` (in `apps/desktop/src/renderer/app.ts`) finds every iframe tagged `data-centraid-app` and posts the current theme whenever `applyPrefs()` runs. Same pattern wired into the builder preview iframe (`apps/desktop/src/renderer/builder.ts:makePreviewFrame`) so the live preview retunes alongside the shell.

**`broadcastThemeToFrames()` in shell.** Wired in `applyPrefs()`; finds every iframe tagged `data-centraid-app` and posts the current theme.

**User apps mount full-bleed.** `mountUserApp` (`apps/desktop/src/renderer/app.ts`) now drops the redundant `<h1>Journal / Built with Centraid</h1>` header and the rounded card wrapper. The iframe fills the main pane edge-to-edge via a new `.app-view-fullbleed` modifier on `.app-body-inner` that uses `:has()` to neutralize the parent `.app-body`'s padding/overflow/max-width.

**Dark-shade slider locked read-only at `5`.** `DEFAULT_PREFS.bgL` set to `5` and overridden at load (`bgL: 5` after `Store.get`) so the value can't drift from storage. `makeSliderRow` accepts an optional `{ disabled: true }`; the shade row is rendered disabled and its `onChange` is a no-op. Slider gets a `:disabled` opacity + `not-allowed` cursor.

**Light theme retuned along Notion/Linear lines.** `packages/design-tokens/themes.ts`:

| Token | Before | After |
|---|---|---|
| `bg` (canvas) | `#e8e9ec` | `#FCFCFC` |
| `bgApp` | `#fafbfc` | `#FFFFFF` |
| `bgElev` (cards) | `#f3f4f6` | `#FFFFFF` |
| `bgSunken` | `#dcdee2` | `#F0F1F3` |
| `ink` | `#141820` | `#1F1F23` |
| `line` | `rgba(20,24,32,0.10)` | `rgba(31,31,35,0.07)` |
| `lineStrong` | `rgba(20,24,32,0.18)` | `rgba(31,31,35,0.13)` |
| `sidebarBg` | `rgba(255,255,255,0.65)` (blur 28px) | `#F4F5F7` (no blur) |
| `sidebarDivider` | `0.5px solid rgba(20,24,32,0.08)` | `1px solid rgba(31,31,35,0.08)` |
| Shadows | `0.06–0.18` alpha | `0.04–0.10` alpha |

Hierarchy now comes from 1–2% lightness steps + a clear sidebar/canvas divider, not from gradient banding or hard borders.

**`.cd-main` unified.** Removed the `.has-wall` special case — every `.cd-main` gets the same background, so the chrome titlebar (which lives inside `.cd-main`) is a continuation of the content below it. Dark mode uses the existing vertical gradient (`hsl(222 13% L−2%) → hsl(222 14% L−6%)`); light mode is flat `var(--bg)`. Topbar gets a single `0.5px solid var(--line-strong)` bottom border as the only structural divider; sidebar topbar has none.

**Iframe templates aligned with the shell.** Hue unified to `222` (was `225`) so the iframe canvas is an exact continuation of the shell gradient. Light defaults `--bg: #FCFCFC`, `--line: rgba(31,31,35,0.07)` so the iframe blends with the new light shell. `body { min-height: 100vh }` so the gradient covers the full iframe viewport (previously it only painted as tall as content).

**Builder preview iframe theme propagation.** `makePreviewFrame` reads `data-theme` + `--bg-l` off the shell's `<html>` and appends `theme=…&bgL=…` as the URL hash, postMessages on `load`, and tags itself `data-centraid-app` so `broadcastThemeToFrames()` includes it.

**Builder sidebar apps list.** Reads `home.userApps` from `Store`; clicking an app calls `handleExit()` then `window.Centraid.openApp(id)` so the route history stays consistent.

**Home tiles opaque in light mode.** `.cd-app-card` is opaque `var(--bg-elev)` with a soft `var(--shadow-sm)`; the old `color-mix(...70%, transparent)` + backdrop-blur treatment is scoped to `:root[data-theme='dark'] .cd-app-card` where the gradient canvas behind benefits from the glass effect. Hover bumps to `shadow-md` + 1px lift in light.

**Tooling housekeeping.** Removed an unused `fileIcon()` helper in `builder.ts` flagged by oxlint; cleaned up `catch (_) {}` to bare `catch {}` and `setAttribute('data-centraid-app', '1')` to `frame.dataset.centraidApp = '1'` per the unicorn rules enforced by the pre-commit hook.

## Files touched

- `apps/desktop/src/renderer/app.ts`
- `apps/desktop/src/renderer/builder.ts`
- `apps/desktop/src/renderer/styles.css`
- `packages/design-tokens/themes.ts`
- `packages/app-templates/{journal,todos,hydrate}/app.css`
- `packages/app-templates/{journal,todos,hydrate}/index.html`
- `packages/app-templates/{journal,todos,hydrate}/theme-bridge.js` (new)
- `packages/app-templates/manifest.json`

## Verification

- `bun run --filter @centraid/design-tokens build` — passes.
- `bun run --filter @centraid/desktop typecheck` — passes.
- `bun run format` — clean (oxfmt across all touched files).
- Manual: Electron app launched against a live journal/todos clone served by the openclaw gateway. Verified end-to-end:
  - Toggling `data-theme` in Settings retunes the running iframe live (postMessage).
  - First-load paint matches the active theme (URL hash carries `theme=` and `bgL=`).
  - Journal/Todos canvas fills the main pane edge-to-edge, no shell-side title, no card border.
  - Dark-shade slider in Settings shows as disabled at `5` and refuses interaction.
  - Light theme: home and Journal view both read near-white; topbar boundary is a soft hairline; sidebar reads as a distinct quiet surface (~3% darker than canvas).
  - Builder: preview iframe paints in dark mode; clicking an app in the builder sidebar exits and opens that app.

## Out of scope

- Persisting the appearance pref to disk via Store (the `bgL: 5` override happens at boot — if a future change wants to expose the slider again, remove the override and re-enable the `onChange`).
- Migrating the sidebar `border-right` to a CSS variable for the divider stroke width (still hardcoded `1px`).
- Builder sidebar's `drafts` array — left empty; drafts in the builder are typically *the app being edited*, so surfacing them inline would just be noise. Revisit if multiple draft management lands.
- Light-mode "lift" for the chat-pane in the builder — currently keeps its own `var(--bg)` + right hairline, which reads as a distinct quiet surface; intentional, not a regression.
- Iframe theme propagation for any non-Centraid embedded preview (e.g. external URLs) — only applies to the gateway-served templates that ship `theme-bridge.js`.
