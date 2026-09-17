# Trap: Electron and Playwright screenshot capture

## What goes wrong

Agents (or tools) call `capturePage` / Playwright screenshots and get a blank image, a frame captured before first paint, or a tool error that the model ignores. "It looks fine" claims become false.

## Mechanisms

| Path | Notes |
| --- | --- |
| Playwright e2e | `desktop/e2e` (`*.e2e.ts`, `fixture.mjs`) — the config keeps a trace on failure (`trace: "retain-on-failure"`) and takes no screenshots by default; use the fixtures, not ad-hoc sleeps. Run under `cargo xtask gate --profile nightly` (`desktop-e2e`) or `xvfb-run -a` locally ([desktop/README.md](../../desktop/README.md#running-it)). |
| Companion e2e | `extension/e2e` — headed Chromium, same trace-on-failure setting. |

## How agents get it wrong

1. **Capturing before first paint** — flash of wrong theme or an empty document.
2. **Assuming a headless display** — Electron has no real headless mode and the Companion needs a headed Chromium; CI uses `xvfb-run -a`. Do not invent new headless flags without checking the existing config.
3. **Full-window screenshots as proof of app UI** — shell chrome dominates; assert on the app's own selectors instead.
4. **Committing large PNGs** to the repo as "evidence" — keep artifacts in CI uploads / local out dirs, not git.

## Checklist

- [ ] Prefer Playwright assertions on selectors over manual screenshot interpretation
- [ ] On failure, open the retained trace with `node_modules/.bin/playwright show-trace <trace.zip>` before rewriting product code

## Related

- `desktop/e2e/playwright.config.ts`
- `extension/e2e/playwright.config.ts`
- [TESTING.md](../../TESTING.md)
