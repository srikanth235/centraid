# issue-223 — Desktop UI refinements: home app gallery, run-viewer transcript log, delete action

GitHub issue: [#223](https://github.com/srikanth235/centraid/issues/223)

Screenshot-driven polish on the home and Automations surfaces, following the
high-fidelity Automations redesign in #221. All of it is renderer-only and
driven by real manifest / run data — no backend, schema, or `automation.json`
change. The single electric-blue `--accent` stays the only action accent; the
per-app/per-automation hues remain identity-only.

## Checklist

- [x] Home — Apps gallery layout
- [x] Home — Automations section + Recent runs rail
- [x] Discover — All/Apps/Automations filter
- [x] Automation detail — header, trigger hero, rail
- [x] Run viewer — transcript log (Direction B)
- [x] Delete automation action

## What changed

### Home — Apps gallery layout

`renderAppCard` is restructured to the apps-gallery spec: a horizontal header
(large glyph plate left, name over blurb right) above a top-divided footer strip
with the status pill · timestamp on the left and the hover-revealed star on the
right. The glyph plate renders large and prominent (24px glyph in a ~52px
rounded tile, was 16px in 36px). The home grid (`cd-apps-grid--small`) drops
from six columns to a roomy three-up; `cd-app-card-head` / `-head-text` and a
`cd-app-card-foot-meta` group carry the new structure.

### Home — Automations section + Recent runs rail

`buildHomeAutomations` renders the two-column section (identity rows left,
Recent-runs rail right) with an active / needs-attention status summary, and
`buildHomeHero` / `buildHomeApps` compose the hero (date eyebrow + heading +
composer + suggestion chips) and the Apps section. The legacy tabbed discovery
shelf was removed.

### Discover — All/Apps/Automations filter

`renderDiscoverAsync` loads app and automation templates together and adds an
All · Apps · Automations segmented filter with counts, category grouping, and a
unified wide `renderDiscoverTemplateCard` (kind badge + trigger badge +
integration dots). The dead `renderTemplateCard` / `buildShelfTile` were
removed.

### Automation detail — header, trigger hero, rail

`buildAutomationView` gains the one-line description subtitle, an accent
CRON SCHEDULE / WEBHOOK eyebrow, a braces-prefixed cron chip, a NEXT 3 RUNS pill
row, an Active pill + Enabled toggle, run-history All/Cron/Webhook/Manual
filters, and a right rail with Last-30-days KPIs + Behavior + Tools — all from
real manifest fields.

### Run viewer — transcript log (Direction B)

`buildRunTranscript` is rebuilt to the spec: a boxed KPI strip
(Trigger · Tokens · Cost · Duration · Outcome), an elevated transcript panel, an
elapsed-time (`mm:ss.t`) gutter, a play-prefixed trigger row, STEP / TOOL /
AGENT rows with a quiet inline kind prefix and collapsible `{}` args / out
chips, agent replies that stream live, and a settled `Run finished · <summary>`
footer. The shared run header subtitle now reads `Today, 6:00:02 PM · <model>`.

### Delete automation action

A destructive delete button on the automation detail header — quiet ghost-icon
by default, danger-tinted on hover — confirms via `openConfirm`, calls the
existing gateway `DELETE /_automations`, then toasts and returns to the list;
errors re-enable and surface the cause.

## Out of scope

- No backend / manifest / schema change; every value is read from real
  manifest + run data.
- The run viewer keeps its `timeline` default and the A/B toggle; the agent
  "thinking" line in the run-log mock is not rendered — run nodes carry no
  separate reasoning field.
- Which glyph + colour each home app uses comes from per-app stored metadata,
  not the renderer.

## Verification

- `bun run typecheck` (17/17) and `bun run lint` (0 errors, 336 files) green;
  `oxfmt` clean on the touched TypeScript; `bun run build --filter=@centraid/desktop`
  green (8/8).
- Drove the real Electron renderer (Playwright `_electron`, seeded
  `home.userApps`) to capture the home Apps section and confirm the three-up
  horizontal gallery with enlarged glyph plates and the divided footer strip
  render as specified.
