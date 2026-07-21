# issue-493 — macOS tray icon should be a monochrome template, not full color

The desktop menu-bar (tray) icon loaded the full-color 1024×1024 app `icon.png`
resized to 16px and never flagged it a template image, so macOS rendered it in
color instead of tinting it to the bar like every other status item (and like
the Codex / Claude marks). This ships a black-on-transparent template of the
Centraid mark for the macOS tray and fixes a latent packaging bug that left the
tray asset out of built apps entirely.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-5ac9baf3-ae7-1784640187-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #493 | claude-opus-4-8 | 363 | 1875317 | 49419269 | 291009 | 2166689 | 43.7074 | 655 | 2285317 | 68655928 | 458151 | fix(desktop): macOS tray uses a monochrome template icon, not the color app icon |
| claude-code-5ac9baf3-ae7-1784640551-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #493 | claude-opus-4-8 | 21 | 25305 | 4004157 | 11451 | 36777 | 2.4466 | 676 | 2310622 | 72660085 | 469602 | fix(desktop): macOS tray uses a monochrome template icon, not the color app icon |
| claude-code-5ac9baf3-ae7-1784640602-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #493 | claude-opus-4-8 | 6 | 2001 | 1014906 | 1974 | 3981 | 0.5693 | 682 | 2312623 | 73674991 | 471576 | fix(desktop): macOS tray uses a monochrome template icon, not the color app icon |
| claude-code-5ac9baf3-ae7-1784640667-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #493 | claude-opus-4-8 | 14 | 10662 | 2382854 | 3650 | 14326 | 1.3494 | 696 | 2323285 | 76057845 | 475226 | fix(desktop): macOS tray uses a monochrome template icon, not the color app icon |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Checklist

- [x] On macOS the tray loads a black-on-transparent template image and calls setTemplateImage(true) so the OS tints it to the bar.
- [x] Windows/Linux keep the full-color icon because their trays are not auto-tinted.
- [x] The tray assets are added to the electron-builder files list so a packaged app bundles them.

## What changed

**`assets/tray-icon-template.svg`** (new) — the Centraid mark (orbit ring + 3
satellites + hub) in pure black on transparent, bolded and beaded onto the ring
so it stays legible at 16px. Rendered with `sharp` to
**`apps/desktop/iconTemplate.png`** (16×16) + **`iconTemplate@2x.png`** (32×32).

**`apps/desktop/src/main/app-chrome.ts`** — `installTray` now delegates to a new
`loadTrayImage`. On macOS the tray loads a black-on-transparent template image
and calls setTemplateImage(true) so the OS tints it to the bar. It auto-picks
the `@2x` sibling, and the color icon is no longer resized on that path.
Windows/Linux keep the full-color icon because their trays are not auto-tinted.
That path still resizes `icon.png` to 16px.

**`apps/desktop/electron-builder.yml`** — the tray assets are added to the
electron-builder files list so a packaged app bundles them. Previously `files:`
packed only `dist/**` + `package.json`, so the root `icon.png` (loaded at
runtime via `../icon.png` from `dist/main.js`) was never bundled — the menu-bar
icon would have been empty in a built DMG. `icon.png`, `iconTemplate.png`, and
`iconTemplate@2x.png` are now listed.

## Decisions

- **Bolded / beaded the mark rather than reusing `app-icon.svg` geometry
  verbatim.** The full-color mark has a thin 4.5px ring stroke that vanishes at
  16px; the template uses a thicker stroke and solid dots so it reads in the bar.
- **macOS-only template; color icon retained elsewhere.** `setTemplateImage`
  only means something on macOS; a black-on-transparent icon on a Windows/Linux
  tray would be wrong, so those platforms keep the color icon.
- **Fixed the `files:` packaging gap in the same change.** It's a pre-existing
  latent bug, but without it the new template (and the existing color icon)
  never reach a packaged build, so the tray fix would be untestable in a DMG.

## Out of scope

- Live menu-bar screenshot verification in a running desktop build — validated
  by render + composite preview here; a real-app run is recommended before
  release.
- A dock/app-icon change — this only touches the tray (status item).

## Verification

Render the template and confirm valid transparent PNGs at both scales:

```sh
bun -e '
import sharp from "sharp";
import { readFile } from "node:fs/promises";
const svg = await readFile("assets/tray-icon-template.svg");
for (const [px, out] of [[16,"apps/desktop/iconTemplate.png"],[32,"apps/desktop/iconTemplate@2x.png"]]) {
  await sharp(svg,{density:384}).resize(px,px).png().toFile(out);
  const m = await sharp(out).metadata();
  console.log(out, m.width+"x"+m.height, "alpha="+m.hasAlpha);
}'
```

Typecheck the desktop main process:

```sh
bunx turbo run typecheck --filter=@centraid/desktop
```

## Steering

**PASS.** No steering events recorded; the `### Steering` table is empty.

**Evidence:** (1) Every human-steering event is recorded as a row — none were identified in the transcript (the user's messages were the initial request, answers to the agent's own questions, and sequential new asks, none of which redirect or correct mid-task), so the table is correctly empty. (2) No non-steering message is recorded as a steering event — the table has no rows.

## Audit

**PASS.** Verification completed:

1. **`## What changed` faithful to staged diff**: All four deliverables match precisely. `assets/tray-icon-template.svg` is pure black on transparent; both PNG renderings are staged as binary files; `app-chrome.ts` adds `loadTrayImage()` with full macOS platform check (`process.platform === 'darwin'`), template load, and `setTemplateImage(true)` call; Windows/Linux fallthrough preserves color icon; `electron-builder.yml` adds the three tray assets to the `files:` list with explanatory comment.

2. **Checklist items realized in diff**:
   - [x] macOS template with `setTemplateImage(true)` — realized in `loadTrayImage()` lines 121–124 (platform check, template load, flag call)
   - [x] Windows/Linux keep color icon — realized in lines 125–128 (fallthrough and conditional resize)
   - [x] Tray assets added to electron-builder — realized in `electron-builder.yml` (icon.png, iconTemplate.png, iconTemplate@2x.png listed)

3. **Checklist mirrors issue #493**: All fix points from the issue are addressed — macOS template image, black-on-transparent mark, `setTemplateImage(true)` call, platform-specific handling, and the latent `electron-builder.yml` packaging gap.

Verdict: work is complete and correctly documented.
