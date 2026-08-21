# Issue 841 - The public site renders in the product's design, and says what the product is

## Checklist

- [x] Generate the token sheet per surface from `packages/design` and gate its freshness by bytes
- [x] Drop the Google Fonts link from both surfaces
- [x] Rewrite the landing sheet, the docs shell and the ontology sheet onto the tokens
- [x] Move both sites onto the product's theme contract
- [x] Map the ontology diagram's colour-coding onto the app-identity hue axis
- [x] Add `lint:site-tokens` to `check:push`
- [x] Record the ruling, the page-scale steps and the new lowering row in the docs
- [x] Retire the builder-era positioning from the landing page
- [x] Lead the landing page on the eight system apps and the incumbents they stand in for
- [x] Cut the automations chapter and the backup claims, which v0 does not ship
- [x] Put data ownership, not software ownership, at the centre of the message

## What changed

**The lowering.** `scripts/site-tokens.mjs` is new: it composes `toCss()` (unmodified), `toFontFaceCss('fonts')`, and a site layer, and writes `centraid-tokens.css` plus `assets/fonts/*.woff2` plus `assets/centraid-mark.svg` into both `scripts/home-site/public/assets` and `scripts/docs-site/public/assets`. `bun run site:tokens` writes; `bun run lint:site-tokens` (bare invocation) checks. Both are in `package.json`, and the check joins `check:push`. The output is committed rather than built because neither site has a build step that could produce it — Astro and `assemble.mjs` both copy `public/` verbatim — so `oxfmt.config.ts` excludes the generated sheet the same way it excludes the repo's other generator output with a byte-exactness assertion elsewhere.

The site layer is the only thing the emitter adds beyond `toCss()`. It carries `color-scheme` per theme, the reading measures, three section-rhythm steps built as multiples of `--sp-6`, and `--t-hero-size` / `--t-chapter-size` built as multiples of `--t-display-size`. Nothing in it introduces a colour, a face, a radius or a duration.

**The mark.** Both sites drew their own `centraid-mark.svg` — a white orbit on a `#3EC8B4` teal tile, the brand hue the v8 flip retired and which `packages/design/src/css-properties.test.ts` and `design-md.test.ts` have asserted against for releases. The emitter now copies `apps/web/public/centraid.svg`, the icon the PWA actually ships, so the two cannot disagree again.

**The landing page.** `scripts/home-site/public/index.html` loses the Google Fonts preconnect and stylesheet, gains the token sheet and two `.woff2` preloads, and its `<style>` block is rewritten: `--t-reading` body, the ink ramp for emphasis inside headings (`em` is no longer italic and no longer a hue), `--accent-fill` / `--text-inv` on the one primary button, `--net` outlined on the destructive control in the consent artifact, `--link` underlined on prose links, `--font-code` on commands and paths and `--font-sans` everywhere else, product radii, and `--dur-1` / `--dur-2` on the two curves. The oversized outlined display numeral, the `tilt-l` / `tilt-r` card rotations, the hard offset shadows, the grain overlay and the translate-on-hover are gone. `<html>` carries no `data-theme` until the visitor chooses one; the `<head>` script migrates a stored `paper` / `night`.

**The docs shell.** `scripts/docs-site/public/assets/docs.css` is rewritten on the same terms, keeping every selector and the layout. `--paper` / `--card` / `--display` / `--body` / `--font-mono` / `--amber` / the `--night-*` sub-palette are gone; the file declares only the shell's own geometry (`--rail-w`, `--shell-*`, `--col-pad`, `--max`). Headings run h1 `--t-chapter-size` → h2 `--t-display` → h3 `--t-title`. Cards, artifacts and terminals are `--bg-elev` on a hairline at `--r-lg` with no shadow; the search popover and mobile sheet keep `--shadow-lg` / `--shadow-md`, which is what those tokens exist for. `DocsLayout.astro` drops the font CDN, links the token sheet before `docs.css`, preloads the two faces, and its `theme-color` metas take the product's `--bg` per theme. `docs.js` toggles `light` / `dark`.

**The dark bands.** A chapter page's full-bleed `.dark` band now paints on `--stage` / `--on-stage` / `--on-stage-soft` / `--stage-line` / `--stage-sunken` — the product's one ground that does not follow the theme. Every `section.dark` rule in `docs.css` is scoped `body:not(.ontology-page)`. That scoping used to be per-rule, which is how `section.dark h3` ended up painting `--on-stage` onto the ontology page's page-coloured bands.

**The ontology sheet.** `src/content/ontology-style.css` keeps its structure and loses its palette. Its private names now alias product tokens, and its two diagram colours resolve to app identity hues: `--core` = `--c-indigo`, `--ext` = `--c-ochre`, each with the solved `--c-*-text` rung for type and a `color-mix` wash for grounds. Every hue-as-a-fill under a text-bearing surface became a wash with a hue border; the one pressed control (`.ctlbtn`) takes the ink fill, because a hue is never permitted on a control. Its bands follow the theme (`--bg-app`) rather than pinning a stage. Weights collapse to 400/600, radii to `--r-*`, transitions to `--dur-1`/`--dur-2`, dashed hairlines to solid, and the hero's two radial gradients and four box-shadow glows are gone. The file now contains zero raw colour literals.

**The content fragments.** Nine `.ghost` display glyphs and four `tilt-*` classes removed from `src/content/*.html`; inline styles naming `--ink-3`, `--amber`, `--body`, `--night-2`, `--night-3`, `--nline`, `--indigo`, `--gold` and `--bone*` rewritten onto product tokens or dropped. `og-docs.svg` is redrawn in the product's light theme with the shipped mark.

**The landing message.** The page was still selling the framing [#799](https://github.com/srikanth235/centraid/issues/799) retired — a builder you describe apps to, with a `builder · docs` transcript artifact to prove it — and a chapter of automations that do not ship. Rewritten around what a visitor actually gets:

- **The thesis is data ownership.** The hero read "Your whole life, in software you actually own", which locates ownership in the software. It does not ship that way and it is not the claim: the person owns the record, and the apps are the replaceable part. The hero is now "Own your data. The apps only borrow it." — "borrow" being literal, since an app reaches the record through a scoped grant. The apps strip and the closing manifesto say the same thing from the other side: an app can be uninstalled, replaced or rewritten and the record does not move.
- **The eight apps lead.** A new `#apps` grid names each system app against the incumbent it stands in for, which is the doctrine [blueprint-seats.md](../docs/blueprint-seats.md) already states — a seat mimics the most popular incumbent so switching meets no new mental model. Naming Google Photos, Drive, Apple Notes, Calendar, Todoist, Contacts, 1Password and Splitwise on the page is that doctrine said out loud.
- **The chapters follow the record.** `one record` (one row projected into four rooms, per [#834](https://github.com/srikanth235/centraid/issues/834)'s projection doctrine) → `your vault` → `assistant` → `sharing` → `devices`. The old chapter 02 "your apps" and its transcript are deleted.
- **Sharing is a grant.** The new chapter states [#825](https://github.com/srikanth235/centraid/issues/825)'s model — a standing grant fulfilled vault to vault, revocation asking the other copy to go — and stops short of the household ceremony, since [#726](https://github.com/srikanth235/centraid/issues/726) P1 has not shipped.
- **Cut, not softened.** The automations chapter (briefing, mail and calendar import doors, the outbox) is gone entirely, as are the backup and recovery-kit claims in the install notes: out of scope for v0, so the site does not promise them.

The rewrite is copy and one token-only `.app-grid` block; it introduced no colour, face, radius or duration, and `lint:site-tokens` passes unchanged.

**The gate.** `lint:site-tokens` checks four things across every authored `.css` / `.html` / `.js` / `.astro` under `scripts/*-site`, with comments stripped first: the emitted assets match the emitter byte-for-byte and carry no orphan face; no fallback-less `var()` resolves to nothing (reusing `declaredCustomProps` / `unresolvedVarRefs` from `@centraid/design/css-vars`, the same helpers `packages/client` and `packages/blueprints` gate on); every `font-family` is `inherit`, `var(--font-sans)` or `var(--font-code)`; and no font-CDN reference or retired theme name survives. Following `scripts/lint-types.sh`, scanning zero files fails rather than passes.

**Crosswalk.** Each checked item against the files that carry it — which is also the full surface this change touches:

- _Generate the token sheet per surface from `packages/design` and gate its freshness by bytes_ — `scripts/site-tokens.mjs`, emitting `scripts/home-site/public/assets/centraid-tokens.css`, `scripts/docs-site/public/assets/centraid-tokens.css`, `scripts/home-site/public/assets/centraid-mark.svg`, `scripts/docs-site/public/assets/centraid-mark.svg`, and the eight vendored faces: `scripts/home-site/public/assets/fonts/instrument-sans-latin-400-normal.woff2`, `scripts/home-site/public/assets/fonts/instrument-sans-latin-600-normal.woff2`, `scripts/home-site/public/assets/fonts/instrument-sans-latin-ext-400-normal.woff2`, `scripts/home-site/public/assets/fonts/instrument-sans-latin-ext-600-normal.woff2`, `scripts/docs-site/public/assets/fonts/instrument-sans-latin-400-normal.woff2`, `scripts/docs-site/public/assets/fonts/instrument-sans-latin-600-normal.woff2`, `scripts/docs-site/public/assets/fonts/instrument-sans-latin-ext-400-normal.woff2`, `scripts/docs-site/public/assets/fonts/instrument-sans-latin-ext-600-normal.woff2`. `oxfmt.config.ts` excludes the generated sheet.
- _Drop the Google Fonts link from both surfaces_ — `scripts/home-site/public/index.html` and `scripts/docs-site/src/layouts/DocsLayout.astro`.
- _Rewrite the landing sheet, the docs shell and the ontology sheet onto the tokens_ — `scripts/home-site/public/index.html`, `scripts/docs-site/public/assets/docs.css`, `scripts/docs-site/src/content/ontology-style.css`, and the fragments they style: `scripts/docs-site/src/content/404.html`, `scripts/docs-site/src/content/apps.html`, `scripts/docs-site/src/content/backups.html`, `scripts/docs-site/src/content/data.html`, `scripts/docs-site/src/content/devices.html`, `scripts/docs-site/src/content/index.html`, `scripts/docs-site/src/content/learn.html`, `scripts/docs-site/src/content/ontology-body.html`, `scripts/docs-site/src/content/start.html`, `scripts/docs-site/src/content/understand.html`, plus `scripts/docs-site/public/assets/og-docs.svg` redrawn in the light theme.
- _Move both sites onto the product's theme contract_ — the `<head>` script in `scripts/home-site/public/index.html`, `scripts/docs-site/public/assets/docs.js`, and the `theme-color` metas in `scripts/docs-site/src/layouts/DocsLayout.astro`.
- _Map the ontology diagram's colour-coding onto the app-identity hue axis_ — `scripts/docs-site/src/content/ontology-style.css`.
- _Add `lint:site-tokens` to `check:push`_ — `package.json`.
- _Record the ruling, the page-scale steps and the new lowering row in the docs_ — `docs/decisions.md`, `docs/design-machinery.md`, `docs/design-divergences.md`, and `scripts/docs-site/README.md`.
- _Retire the builder-era positioning from the landing page_ — `scripts/home-site/public/index.html`; the docs route's own SEO title followed in `scripts/docs-site/src/pages/apps.astro`.
- _Lead the landing page on the eight system apps and the incumbents they stand in for_ — the `#apps` grid in `scripts/home-site/public/index.html`.
- _Cut the automations chapter and the backup claims, which v0 does not ship_ — `scripts/home-site/public/index.html`.
- _Put data ownership, not software ownership, at the centre of the message_ — the hero, the apps strip and the chapter rule in `scripts/home-site/public/index.html`.

## Out of scope

- **`lint:design-tokens` still does not cover `scripts/*-site`.** Its checked-in budget is empty and must stay empty. `ontology-style.css` still sizes in rem and carries per-diagram grid literals, so pointing the gate here today would mean recording debt to go green — the one thing that gate exists to prevent. `lint:site-tokens` fences what this change actually closed; the sheet's sizes are the remaining work. Registered in [design-divergences.md](../docs/design-divergences.md#the-public-web-surfaces).
- **The rest of the teal artwork.** `assets/logo.svg`, `assets/app-icon.svg`, `assets/app-icon-mac.svg` and `assets/splash.svg` still carry `#3EC8B4`. They feed desktop and mobile packaging, so flipping them has release consequences and belongs to its own issue. Named in the decisions ruling so it is not mistaken for finished.
- **`centraid-city`.** The `/city/` Three.js surface has its own canvas vocabulary and was not touched.
- **The docs site's own copy.** Only the landing page was rewritten. `scripts/docs-site/src/content/*.html` still carries builder-era sentences — the apps pillar's "you don't build one by describing it — not yet" — and `data.html` still documents `#automations`, which the landing page no longer links to. Routes and the rail model are unchanged there. Sweeping the pillars is a bigger read than a marketing pass and wants its own issue.
- **Automations and backup, as product.** Cutting them from the site says nothing about the roadmap; it says the page stopped claiming them for v0.

## Decisions

- **The site consumes `toCss()` verbatim rather than a fourth lowering.** A marketing-specific emitter would be a second editable registry, which is the thing `docs/design-machinery.md` forbids. What a page genuinely needs and a screen does not — a reading measure and a rhythm between sections — is a thin layer composed from tokens above it.
- **Committed generator output with a byte gate, not a build step.** `scripts/home-site/public` is copied verbatim by `assemble.mjs` and has no build. A build-time generation would leave the committed landing page broken when opened directly and would put a deploy-order risk where a freshness check does the job. This is the shape `packages/design`'s vendored `.woff2` files already use.
- **A hero above `--t-display`, composed from `--t-display-size`.** A scrolling page opens on a title carrying the whole page. Scaling the display role's own published size token keeps the face, the weight and the tracking, so it is the ramp stretched rather than a second scale — and it is emitted once, so a page cannot invent another.
- **Chapter bands take the stage; the ontology's do not.** `--stage` is the closest honest token for a ground that reads dark in both themes, and it carries exactly two contrast-solved ink rungs, so a band gets two and no third is invented. The ontology page is excluded because its whole vocabulary is hue, and a hue solved against the page reads wrong on near-black.
- **Emphasis inside a heading is an ink step.** `<em>` was italic serif in the accent hue. With one face and no shell colour, the ramp is the only channel left: the sentence sits at `--text-soft` and the emphasised phrase at `--text`.
- **The page names the incumbents.** Every other framing of a seat — "a photos app", "a password manager" — asks the visitor to imagine the product. "In place of Google Photos" is the fastest true sentence available, and it is the seat doctrine rather than a marketing liberty: the blueprint is built to mimic that incumbent.
- **Ownership is claimed for the record, not the software.** Everything the vault chapter promises — export is copying a directory, an app borrows through a grant you sign, a deleted app costs you nothing — is a statement about the data. A hero claiming owned software would have been the one sentence on the page the rest of the page contradicts.
- **The site tracks what ships, not what is planned.** The automations chapter was deleted rather than hedged. A landing page is read as a promise, and a hedge on a promise still reads as one.
- **The theme is absent until chosen.** The product's emitted sheet already answers `prefers-color-scheme` on `:root:not([data-theme])`. Stamping `data-theme` unconditionally, as both sites did, defeated that block and made "follow the system" unreachable. Legacy `paper` / `night` values are migrated on read so a returning visitor keeps their choice.

## Verification

```sh
bun run site:tokens && bun run lint:site-tokens
```

```sh
bun run docs:build
```

```sh
bun run docs:smoke
```

```sh
bun run docs:bundle
```

```sh
DOCS_SITE_BASE_PATH=/docs bun run docs:smoke
```

```sh
bun run format:check
```

```sh
bun run lint
```

```sh
bun run lint:design-tokens
```

```sh
bun run lint:css
```

```sh
bun run lint:hairline
```

```sh
bun run lint:motion-rule
```

The rewritten landing page was also rendered end to end in both themes with the scroll reveals forced open (headless Chromium over `scripts/home-site/public`): clean render, no failed requests and no page errors.

Rendered check over the assembled `dist/site` (headless Chromium, `/`, `/docs/`, `/docs/data/`, `/docs/ontology/`): every surface resolves `Instrument Sans` as its first family with the faces loaded, `--bg` `#FDFDFC`, `--text` and `--accent` `#141414`, `--link` `#2D4BA8` — the product's light theme — with no failed requests, no 4xx and no page errors. Light and dark were also captured for the landing page and the docs chapter, ontology and index routes.

## Audit

PASS - Each checklist item maps to a named file. The things this change does NOT do — pointing `lint:design-tokens` at the site, flipping the remaining teal artwork, and sweeping the docs pillars' own copy — are stated in Out of scope, and the first two are recorded in [decisions.md](../docs/decisions.md) and [design-divergences.md](../docs/design-divergences.md); none is disguised as complete. Every product claim the rewritten page makes was checked against the docs that own it — seats against [blueprint-seats.md](../docs/blueprint-seats.md), sharing against [#825](https://github.com/srikanth235/centraid/issues/825), projections against [#834](https://github.com/srikanth235/centraid/issues/834), positioning against [decisions.md](../docs/decisions.md) § Product positioning — and the claims that outran the product were cut rather than reworded. No gate, budget or allowlist was weakened: the new check is additive and the existing zero-debt budget is untouched.
