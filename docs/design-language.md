# Centraid design language

The canonical prose statement of how Centraid looks and why. This is a rulebook: everything below is binding on shell, blueprint apps, and mobile unless a line says otherwise. Mechanics (where a token lives, how emitters run, how agents get it wrong) are in [traps/design-tokens.md](traps/design-tokens.md) and [../packages/client/src/react/CSS-CONVENTIONS.md](../packages/client/src/react/CSS-CONVENTIONS.md).

## Point of view: "field notebook"

Calm, instrument-grade, personal. The product is a place someone keeps their own life's data, so the chrome recedes and the data reads.

- **Neutrals do the work.** Colour is not how hierarchy is expressed; type, spacing, and hairlines are.
- **A single per-app accent, and it is structural.** The accent marks state, selection, and the one primary action per surface. It is never decoration, never a second brand, never a gradient.
- **Hairline borders and soft depth.** One-pixel `--line` separates; `--shadow-*` lifts sparingly. No heavy strokes, no drop-shadow stacks.
- **Hard-edged geometry.** "Centraid is an instrument, not a pillow" (`packages/design/src/radii.ts`). Components sit at 6–14px; only sheets and modals soften past that.
- **Motion is confirmation, not entertainment.** Under 200ms, one easing curve, and it can always be switched off.

## The platform analogy

`packages/design` is one package with two layers, and the whole system reads as a small operating system:

| Layer | Analogy | What it is |
| --- | --- | --- |
| Token contract (`src/contract.ts`, `src/*`) | **The OS** | The only public vocabulary of semantic names. Emitters choose values per surface; nobody invents a second spelling for a role. |
| Kit (`kit/kit.css`, `kit/elements.js`) | **The system UI framework** | The served component substrate — `.kit-*` classes and `<kit-*>` custom elements. It holds **no design decisions of its own** (#672): every colour, hairline, radius, and face in it is a contract token. |
| `toBlueprintCss()` | **The app SDK** | What a sandboxed blueprint app is handed. Apps compose against these names; they do not see the shell's emit. |

`toCss()` is the shell's own emit (desktop + web). `toBlueprintCss()` is the app surface's emit **and** the source mobile lowers from (`apps/mobile/scripts/generate-theme.ts` → `src/kit/theme/tokens.generated.ts`). One source, three lowerings.

## Typography

- **Roles, not families.** The contract names `sans`, `display`, `mono`, `serif` plus a semantic scale (`body`, `bodyStrong`, `title`, `display`, `small`, `tiny`, `mono`). Surfaces bind roles to faces; they never introduce a new role.
- **Web and desktop use system stacks** — `system-ui` / `ui-monospace` chains, no webfont family first (#468 K11). The chrome never blocks on a network font fetch.
- **Mobile maps the same roles to loaded platform faces** (`apps/mobile/src/kit/theme/index.ts`), because RN cannot combine `fontFamily` with `fontWeight` reliably; each (role, weight) pair becomes its own family name. See the #686 entry in [decisions.md](decisions.md).
- **Two weights across the chrome** — 400 and 500/600. No bold. The single exception is `marketingType` (`display-1` at 700), which is web-only and lives outside the chrome.
- **`--t-*` are `font` shorthands, not sizes.** Write `font: var(--t-body)`. Setting `font-size: var(--t-body)` silently drops everything. A shorthand also resets `font-family` — override the family before the shorthand, never after.
- **Mono is the signature.** Metadata, counts, dates, and eyebrows are mono; prose is not.
- **No `font-family` in app CSS.** UI grounding forbids arbitrary families; token stacks own type.

## Colour

- **Tokens only.** No hex, `rgb()`, or `hsl()` literal in client, kit, or app CSS. If a value has no token, the value belongs in `packages/design/src` and the name in `src/contract.ts`.
- **Contrast is measured, not eyeballed.** Ink roles descend `--text` → `--text-soft` → `--text-faint` → `--text-ghost`; `--text-inv` is _inverse_ ink (for use on filled/accent surfaces), not "invalid".
- **One structural accent per app**, exposed as `--accent` (shell) / `--accent` + `--_accent` (blueprint), with derived `--accent-soft` / `--accent-deep` / `--accent-text`. Derive with `accentRamp()`; do not hand-pick a tint.
- **`--app-hue` is the identity knob.** Blueprint neutrals are `hsl(var(--app-hue) …)`, so an app expresses itself by moving one number, not by redefining a palette. Default 171.
- **Exactly two themes, `light` and `dark`, and a registry key must equal its `kind`.** There is one dark ramp, anchored on `--bg-l`. Appearance prefs are inline overrides that only write when the owner chose a value.
- **Semantic states** are `--danger` / `--warning` / `--success`. They are not accents and are never used for emphasis.

## Spacing

- **`--sp-1…--sp-7` = 4 · 8 · 12 · 16 · 24 · 32 · 48px**, emitted identically by `toCss()` and `toBlueprintCss()` from `src/density.ts`, and typed for mobile as `spacing`.
- **These are the only rungs.** A gutter that is not on the scale is a bug, not a nuance. Introduced repo-wide by #686 so app surfaces stop hardcoding px literals.
- The scale is fixed. There is no density switch on the token layer.

## Motion

- **One curve:** `--ease: cubic-bezier(.2,.7,.3,1)`.
- **Standard transitions ≤200ms.** Anything longer needs a reason a member could name.
- **Every animation has a `prefers-reduced-motion: reduce` branch** that removes movement (not just shortens it). The kit does this per component; new components do the same.
- Motion animates state changes and entrances. Nothing loops, nothing draws attention to itself while idle.

## What apps may and may not do

**May:**

- Set `--app-hue` and `--accent` to claim an identity.
- Compose kit classes/elements and add app-local layout glue styled with contract vars.
- Override the documented optional tokens listed in the `kit.css` header contract.

**May not:**

- Hardcode colours, radii, spacing, or font stacks.
- Declare a new `--name` in app CSS or `kit.css` — new names go in `src/contract.ts`.
- Set `font-family`, or restyle another component's internals across a module/kit boundary.
- Edit a generated `tokens.css` / `tokens.generated.ts` snapshot instead of regenerating.
- Deep-import `@centraid/design/src/...` — use the barrel.
- Fork the shell token set into an app surface (or vice versa); CSP and the theme bridge assume the blueprint contract.

## Related

- [traps/design-tokens.md](traps/design-tokens.md) — source of truth, the two layers, and how agents get it wrong
- [../packages/client/src/react/CSS-CONVENTIONS.md](../packages/client/src/react/CSS-CONVENTIONS.md) — renderer CSS-Modules rules
- `packages/design/src/contract.ts` — the enforced token vocabulary
- `packages/gateway/src/skills/ui-grounding.ts` — how this contract reaches app-authoring agents
