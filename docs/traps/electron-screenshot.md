# Trap: Electron and Playwright screenshot capture

## What goes wrong

Agents (or tools) call `capturePage` / Playwright screenshots and get a blank image, a frame captured before first paint, or a tool error that the model ignores. "It looks fine" claims become false.

## Mechanisms

| Path | Notes |
| --- | --- |
| Playwright e2e | `apps/desktop/tests/e2e` — `screenshot: 'only-on-failure'` in config; use test fixtures, not ad-hoc sleeps. |
| Live agent e2e scripts | Older `e2e-live/*.mjs` flows write PNGs under an out dir — many are orphaned (L4); prefer Playwright owners. |

## How agents get it wrong

1. **Capturing before first paint** — flash of wrong theme or an empty document.
2. **Assuming headless CI has GPU** — may need the project's Playwright/Electron launch flags; do not invent new headless flags without checking existing config.
3. **Full-window screenshots as proof of app UI** — shell chrome dominates; assert on the app's own selectors instead.
4. **Committing large PNGs** to the repo as "evidence" — keep artifacts in CI uploads / local out dirs, not git.

## Checklist

- [ ] Prefer Playwright assertions on selectors over manual screenshot interpretation
- [ ] On failure, open the failure screenshot path from the test reporter before rewriting product code

## Related

- `apps/desktop/tests/e2e/playwright.config.ts`
- [TESTING.md](../../TESTING.md)
