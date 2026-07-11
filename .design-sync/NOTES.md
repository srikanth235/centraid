# design-sync notes — Centraid Blueprint Kit

## What this design system is (read first)

Centraid's product UI is a **native Web Component kit** (`packages/blueprints/kit/`): `elements.js` defines `<kit-*>` custom elements with `customElements.define()` — dependency-free vanilla (no runtime bundle underneath; Lit was fully removed from the kit) — styled by `kit.css` (the `.kit-*` class system), plus a **token package** (`@centraid/design-tokens`, TS objects → CSS vars via `toCss()`).

claude.ai/design ingests native custom elements **directly** — the Design System pane lists a `<kit-*>` element as a real component and generated designs embed the tag verbatim. So this sync points straight at the kit's **real component files**; there is **no React wrapper package and no compile step** (issue #327 replaced both).

- `.design-sync/ds-src/` is the sync staging area. Committed source is just `build.mjs` (the generator), `styles/bridge.css` + `styles/fonts.css`, the fonts, and `package.json`. Everything else (`components/`, `previews/`, `manifest.json`, derived `styles/*.css`) is **build output** (gitignored).
- `buildCmd` = `node .design-sync/ds-src/build.mjs`. It (1) regenerates `styles/tokens.css` from the built `@centraid/design-tokens`, (2) copies `kit.css` verbatim, (3) concatenates `tokens + fonts + bridge + kit.css` into `styles/bundle.css` (the `cssEntry`), (4) copies the REAL `kit/elements.js` into `components/`, (5) writes one `@dsCard` preview HTML per component into `previews/` and a `manifest.json` (tag → source + preview). **`@centraid/design-tokens` and `kit.css` must be built/present first** — run `turbo build` (or at least build design-tokens) if `packages/design-tokens/dist/` is stale.
- `config.json` (`shape: "web-components"`) names the manifest, the component source, the previews dir, and the `cssEntry`. There is no `runtime` field — `elements.js` has no runtime dependency to point at. The actual push is a separate credentialed step: run the `/design-sync` skill, which reads `config.json` and drives the `DesignSync` tool against the pinned `projectId`.

## No more wrappers (issue #327)

The old sync authored a React wrapper package (`ds-src/src/components/*.tsx`) that duplicated each component's exact DOM/classes and was `tsc`-compiled — with a standing **wrapper-drift risk** (if `kit.js`/`kit.css` changed their DOM, the wrappers silently went stale). That is **gone**. The sync now ships `elements.js` itself, so the component the design system renders IS the component the product ships — nothing to keep in sync by hand.

Adding/changing a component is a one-file edit in `kit/elements.js` plus (optionally) an entry in `build.mjs`'s `COMPONENTS` list to give it a preview card. No wrapper, no `.tsx`, no `tsc`.

## The CSS bridge (still needed — a naming adapter, not a wrapper)

`kit.css` reads **app-level** vars (`--surface`, `--text`, `--muted`, `--accent`, `--radius`, `--mono`, …) that the blueprint apps define per-app. `@centraid/design-tokens` emits **different** names (`--bg`, `--ink`, `--accent`, `--line`, `--r-*`, `--d-*`). `styles/bridge.css` maps the former onto the latter. **Without the bridge, every component renders unstyled.**

Note (issue #327): moving the components to native custom elements did **not** remove the need for the bridge. The elements render in the **light DOM** and read the same app-level var names `kit.css` always read; those custom properties inherit into the element unchanged. Shadow-DOM encapsulation would not have closed the design-tokens↔app-var **naming** gap — that gap is what the bridge exists for — so the bridge stays. If a new component reads a var the bridge doesn't map, add it to `bridge.css`.

## Fonts

Brand families **Geist / JetBrains Mono / Space Grotesk** are self-hosted woff2 (latin subset, OFL) in `ds-src/fonts/`, wired via `styles/fonts.css` (committed). They're OSS variable fonts, so per-weight files may be byte-identical — expected, not an error. If `[FONT_MISSING]` ever fires, re-fetch from Google Fonts CSS2 API into `ds-src/fonts/` and update `fonts.css`.

## Component set

8 **presentational** custom elements: `<kit-avatar>`, `<kit-meter>`, `<kit-line-chart>`, `<kit-bar-chart>`, `<kit-skeleton>`, `<kit-toast>`, `<kit-mention-chip>`, `<kit-reference-strip>`. The kit's **live-network controllers** are deliberately excluded (they can't render statically and are wired to the product's SSE/vault surfaces): the "Ask your vault" assistant and the vault-fetching @-mention *picker*. Unlike the old sync, they are **not** shipped as static React shells — a static shell would have re-introduced exactly the DOM duplication this migration removed. Only the presentational chip/strip that a resolved reference degrades to are in the set.

## Preview cards

Each `previews/<tag>.html` starts with a first-line `<!-- @dsCard group="…" name="…" subtitle="…" width height -->` marker (the Design System pane's card index). The preview links `styles/bundle.css` and loads `components/elements.js`, then embeds the real `<kit-*>` tag with example attributes. Rich props pass as **JSON attributes** (`items='[…]'`, `points='[…]'`, `refs='[…]'`, `card='{…}'`) — the elements' default array/object converter parses them, so the previews are pure declarative HTML with no per-card script.

## Re-sync risks (what can silently go stale)

- **Token names**: the bridge hard-codes `@centraid/design-tokens` var names (`--bg-elev`, `--ink`, `--r-lg`, `--c-amber`). If the tokens package renames vars, the bridge breaks silently (components render half-styled). Re-check `bridge.css` against `packages/design-tokens/src/css.ts` after any tokens change.
- **Excluded controllers**: if the product later wants the live Ask/@-mention behaviors in the DS, they'd need a different (non-static) treatment — they're not here by design.
- **Fonts**: self-hosted copies won't track upstream font updates; fine for a brand pin.

## Wrapper-drift risk — RETIRED

The former top re-sync risk ("if `kit.js`/`kit.css` change their DOM or class names, the hand-written wrappers won't auto-update") no longer exists: there are no wrappers. `kit.css` and `elements.js` are copied fresh every build, so both style and DOM/behaviour changes flow through automatically.
