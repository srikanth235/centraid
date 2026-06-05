# issue-221 — Automations: high-fidelity DS v0.5 upgrade (six surfaces + A/B directions)

GitHub issue: [#221](https://github.com/srikanth235/centraid/issues/221)

The Automations feature already existed at v1 fidelity (routes, gateway IPC,
SSE streaming). This brings all six surfaces up to the high-fidelity design
spec. Per-automation colour is **identity only** — it tints the glyph tile,
trigger-hero rail, and status dots; the single electric-blue `--accent` stays
the only action accent for every CTA/active state. Status is always icon +
label. Identity colour + status are derived deterministically from the
automation id, so there is no manifest or backend change.

## Checklist

- [x] Glyph set + identity/status primitives
- [x] Overview — health strip, identity rows, states
- [x] Detail — trigger hero
- [x] Run viewer Direction A
- [x] Templates gallery
- [x] Builder — diff ribbon, Code tab, agent progress strip
- [x] Direction B
- [x] Legacy removal

## What changed

### Glyph set + identity/status primitives

Added 18 Lucide-style glyphs to `@centraid/design-tokens` `icons.ts` (Clock,
Webhook, Power, AlertTriangle, AlertCircle, CheckCircle, Loader, Filter,
Braces, Gauge, Bell, Key, Cpu, Plug, Sliders, Beaker, ChevronRight, Stop),
which flow to `window.Icon` and type the `IconName` union for desktop + mobile.
Extracted the pure derivation (`hueForId` / `glyphForId` / `auStatusForRow`)
into a testable `automation-identity.ts` module with unit tests; `app.ts`
wraps it in DOM builders `autoGlyphTile`, `auStatusPill` (icon + label status
pill: active/paused/draft/running/success/failed), and `triggerBadge`. CSS adds
a `[data-hue] → --au-hue` map kept strictly decorative.

### Overview — health strip, identity rows, states

`buildAutomationsOverview` gains a 4-tile **health strip** (Active / Paused /
Drafts / Need attention), rows using the identity glyph tile + trigger badge +
integration dots + icon+label status pill + an identity rail, and a recent-runs
feed with success/fail icons. `renderAutomations` adds a loading skeleton and a
distinct error state with Retry alongside the empty state.

### Detail — trigger hero

`buildAutomationView` gains the **trigger hero**: a 3px identity rail, a
hue-tinted icon, a display-font schedule headline, the raw cron in a mono chip
with **next-3-runs** pills, and a webhook variant showing the endpoint URL with
copy + "secret minted server-side" and a `provisioning…` state. The enable
toggle is `role="switch"` with the draft → Enabling… → active lifecycle, spec
toasts, and revert-on-error.

### Run viewer Direction A

`buildRunView` renders a vertical **timeline** rail (status circles +
connectors) of node cards (collapsed status·name·dur·tokens → expanded JSON
args/output, agent response, or red error box) plus a sticky KPI sidebar
(trigger, outcome, model, tokens, cost, duration, run id). The existing live
SSE streaming loop is reused unchanged; in-flight nodes pulse and agent text
streams with a caret.

### Templates gallery

`buildTemplatesGallery` adds live **search**, a trigger segmented filter
(All/Cron/Webhook), integration filter chips, a right-side **preview drawer**
("what it does" steps + connects + Use-template), and a no-results state with
clear-filters / start-from-scratch.

### Builder — diff ribbon, Code tab, agent progress strip

The automation builder Config view flashes a **diff ribbon** on the section the
latest chat turn changed (snapshot-compared in `refreshAutomationRow`), a
read-only **Code tab** renders `automation.json`, and a single determinate
per-turn **agent progress strip** (4 dots + live verb + mono filename +
sub-line + cancel) replaces the old "Thinking…" row. Enable/disable toast copy
was aligned to the spec.

### Direction B

Run viewer Direction B is a single-column **transcript log** (Timeline ⇄ Log
toggle, persisted): a mono KPI line then one row per event with a timestamp
gutter and inline payloads. Builder Direction B is a vertical **flow/pipeline**
"Flow" tab — Trigger → Agent → Connected → Outcome derived from the manifest.

### Legacy removal

Removed the orphaned chat-thread run-viewer code + CSS the Direction-A timeline
replaced (`cd-au-thread/msg/node/work/step-head…/reply-card/fail-box/trig-card`
— ~210 CSS lines), and simplified `runTriggerLabel` to drop its dead icon.
Verified zero dangling references.

## Out of scope

- No backend / `automation.json` manifest change — identity colour, glyph, and
  the draft/active/paused distinction are derived from the automation id.
- The webhook hero shows the hook path (`/_centraid-hook/<id>`); the full
  origin would need a gateway lookup not available synchronously in the renderer.
- Glyphs are authored to match the spec's icon list (the design-project
  `auto-icons.jsx` was not fetchable), not copied verbatim.

## Verification

- Full monorepo `bun run typecheck` (17/17) and `bun run lint` (0 errors, 336
  files) green; `oxfmt` clean; `bun run test` green incl. the new
  `automation-identity` unit tests (hueForId determinism + auStatusForRow).
- Drove the real Electron renderer (Playwright `_electron` + a mock gateway,
  `scripts/screenshot-automations.mjs`) to capture every surface in dark + light:
  overview health strip, detail trigger hero, run-viewer Direction-A timeline,
  run-viewer Direction-B transcript log, templates gallery + preview drawer, and
  the builder Direction-B vertical flow/pipeline. The legacy removal was
  re-verified against a fresh build with no run-viewer regression.
