# issue-22 — Soften dark theme + remove redundant hero "New app" button

GitHub issue: [#22](https://github.com/srikanth235/centraid/issues/22)

## Checklist

- [x] Dark-theme surface tokens lifted
- [x] Relative ordering (`bgSunken < bgApp < bg < bgElev`) preserved
- [x] `deviceWall` gradient endpoints lifted
- [x] Removed redundant "+ New app" hero button
- [x] `npm run build`

## What changed

**Dark-theme surface tokens lifted (`packages/design-tokens/themes.ts`).** The home view previously rendered against `bg: #0d1014` with deeper layers at `bgApp: #060709` and `bgSunken: #090b0e` — effectively pitch black, which looked harsh next to the white-ink type. New values:

| Token | Before | After |
|---|---|---|
| `bg` (page) | `#0d1014` | `#1a1d23` |
| `bgApp` (deepest) | `#060709` | `#13161b` |
| `bgSunken` | `#090b0e` | `#15181d` |
| `bgElev` (cards/modals) | `#161a20` | `#252931` |
| `bezel` (phone frame) | `#050608` | `#0a0c10` |
| `bezelInner` | `#14181F` | `#181b21` |

`deviceWall` gradient endpoints lifted to `#1d2027 → #15181d` so the framed device surface stays subtly darker than the page bg. Relative ordering (`bgSunken < bgApp < bg < bgElev`) preserved so existing component CSS still reads correctly. Light theme untouched.

**Removed redundant "+ New app" hero button (`apps/desktop/src/renderer/app.ts`).** The purple primary CTA in the home hero block duplicated the dashed "New app" tile in the apps grid below it. Dropped the button (and its surrounding `home-hero-actions` wrapper) — the tile remains the single entry point for `openNewAppSheet`. No behavior change elsewhere; the modal flow is unchanged.

**Stub `.env.example` added.** Unrelated to the UI change but required to clear the `required-docs` governance check that was blocking this commit. Mirrors the single key (`OPENCLAW_GATEWAY_TOKEN=`) present in the local `.env`.

## Out of scope

- Light-theme tokens — already in a comfortable range; not touched.
- Mobile theme values — RN side reads from the same theme object but the screenshot reviewed was the desktop home view; verify on mobile only if regressions surface.
- The dashed "New app" tile in the apps grid — kept intentionally as the single primary entry point for the new-app flow.
- Broader hero copy / typography review — left for a follow-up.

## Verification

- `cd packages/design-tokens && npm run build` — clean (token CSS regenerated).
- Visual check on the desktop home view: page background is a soft charcoal (`#1a1d23`) rather than near-black; app tiles, modals, and the device wall preserve their relative elevation; "+ New app" hero button is gone and the dashed tile still opens the new-app sheet.
- Light theme unchanged (no edits to `lightTheme`).

