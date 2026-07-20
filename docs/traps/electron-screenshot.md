# Trap: Electron screenshot / preview capture

## What goes wrong

Agents (or tools) call `capturePage` / Playwright screenshots and get a blank image, the whole shell instead of the app iframe, or a tool error that the model ignores. Builder "preview looks fine" claims become false.

## Mechanisms

| Path | Notes |
| --- | --- |
| Builder preview tool | Desktop main clips `webContents.capturePage` to `iframe[data-centraid-app]` — iframe must be visible (Preview tab). |
| Playwright e2e | `apps/desktop/tests/e2e` — `screenshot: 'only-on-failure'` in config; use test fixtures, not ad-hoc sleeps. |
| Live agent e2e scripts | Older `e2e-live/*.mjs` flows write PNGs under an out dir — many are orphaned (L4); prefer Playwright owners. |

## How agents get it wrong

1. **Screenshot while Use tab / no preview iframe** — clip rect empty; tool should error ("Preview iframe not visible").
2. **Capturing before first paint / theme-bridge** — flash of wrong theme or empty document.
3. **Assuming headless CI has GPU** — may need the project's Playwright/Electron launch flags; do not invent new headless flags without checking existing config.
4. **Full-window screenshots as proof of blueprint UI** — shell chrome dominates; assert inside the frame or use the clipped tool.
5. **Committing large PNGs** to the repo as "evidence" — keep artifacts in CI uploads / local out dirs, not git.

## Checklist

- [ ] Preview tab focused for builder capture tools
- [ ] Prefer Playwright assertions on selectors over manual screenshot interpretation
- [ ] On failure, open the failure screenshot path from the test reporter before rewriting product code

## Related

- `apps/desktop/tests/e2e/playwright.config.ts`
- [TESTING.md](../../TESTING.md)
