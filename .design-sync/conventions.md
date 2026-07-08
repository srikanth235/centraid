# Centraid Blueprint Kit — building with these components

These are Centraid's "blueprint kit" — the UI substrate of a **personal-data-vault** product (the recurring surfaces are receipts/consent cards, cross-reference chips, letter avatars, and small data charts). They are **native Web Components** (custom elements): you use them by writing their tag directly in your markup — `<kit-avatar>`, `<kit-bar-chart>`, `<kit-toast>`, … There is **no React wrapper, no `import`, and no `window.*` global** to reach for; the element is defined by the component's own script, which the design system injects for you.

## Setup — no provider, just the stylesheet

There is **no provider or context to wrap**. The elements render standalone and are styled entirely by the design system's global `styles.css`, which every design already receives. Two attributes on a root element control the look:

- **Theme**: `data-theme="<name>"` on an ancestor. Default (unset) = light. Available: `dark`, `notion-light`, `notion-dark`, `airtable-light`, `airtable-dark`, `github-light`, `github-dark`, `solarized-light`, `solarized-dark`, `nord`, `monokai`.
- **Density**: `data-density="comfy" | "regular" | "compact"` (default regular).

The base font is **Geist** (set on `:root`); mono is **JetBrains Mono**, display is **Space Grotesk**.

## The styling idiom: attributes + CSS variables (NOT utility classes)

There is **no utility-class vocabulary** here. Two rules:

1. **Carry the design language through element attributes/properties**, not markup. Tone/variant attributes are how you vary appearance: `<kit-toast tone="accent|danger">`, `<kit-meter tone="warn|danger">`, `<kit-avatar name shape="rounded">`. Rich data passes as a **JSON attribute** (or a JS property): `<kit-bar-chart items='[{"label":"Rent","value":1650},{"label":"Dining","value":214,"muted":true}]'>`, `<kit-line-chart points='[{"x":0,"y":3},{"x":1,"y":5}]'>`, `<kit-reference-strip refs='[…]'>` reacts to each ref's `status` (`live|trashed|missing|denied`). Never hand-roll a lookalike with raw divs — use the real element.

2. **For your own layout glue around the components, style with the DS's CSS variables** — never invent hex colors, radii, or spacing. They all re-resolve per `data-theme`, so using them keeps your layout theme-correct for free:

   - Accent: `--accent` (brand teal #3EC8B4), `--accent-deep`, `--accent-soft`; states `--danger`, `--warn`, `--success`
   - Surfaces: `--bg-app` (page), `--surface` (cards), `--surface-2` (sunken)
   - Text: `--text`, `--muted`; hairlines `--line`, `--line-strong`
   - Radius: `--r-xs|sm|md|lg|xl` (2–14px), or the alias `--radius`
   - Spacing scale: `--d-1`…`--d-7` (4·8·12·16·24·32·48px at regular density)
   - App-icon palette hues: `--c-teal|amber|indigo|forest|ochre|rose|slate|violet`
   - Fonts: `--sans`, `--mono`, `--display`

## The components

| Tag | What it is | Key attributes |
| --- | --- | --- |
| `<kit-avatar>` | Letter/photo avatar, stable hashed hue | `name`, `size`, `shape="rounded"`, `src` |
| `<kit-meter>` | Slim proportion bar | `ratio` (0–1), `tone="warn\|danger"` |
| `<kit-line-chart>` | Trend line + area + last-point dot | `points` (JSON `[{x,y}]`), `width`, `height`, `label` |
| `<kit-bar-chart>` | Vertical bars with tick labels | `items` (JSON `[{label,value,muted?}]`), `width`, `height`, `label` |
| `<kit-skeleton>` | Shimmer loading rows | `rows`, `variant="line\|title\|row\|circle"`, `width` |
| `<kit-toast>` | Outcome toast bubble | `text`, `tone="accent\|danger"`, `undo-label` |
| `<kit-mention-chip>` | Inline @-mention chip | `card` (JSON `{type,title,status}`) |
| `<kit-reference-strip>` | Cross-reference tiles | `refs` (JSON `[{link_id,card,selector?}]`), `empty-text` |

## Where the truth lives

Read these before styling — they beat any summary here:

- **Styles**: `styles.css` → it `@import`s `_ds_bundle.css`, which holds the token/theme variable blocks **and** the real component CSS (the `.kit-*` classes). Grep it for a variable's definition or a component's exact selectors.
- **The components themselves**: `components/elements.js` — the real, product-shipped custom-element definitions (each `<kit-*>` and its attributes). This is the single source of truth; there is no separate wrapper to consult or keep in sync.
- **Live previews**: `previews/<tag>.html` — a rendered example of each element.

## One idiomatic example

A small "spend summary" panel — real components for the content, DS variables for your own layout glue:

```html
<section
  style="
    background: var(--surface); color: var(--text);
    border: 1px solid var(--line); border-radius: var(--r-lg);
    padding: var(--d-4); display: flex; flex-direction: column; gap: var(--d-3);
    font-family: var(--sans);
  "
>
  <kit-bar-chart
    label="Spend by category"
    items='[{"label":"Groceries","value":412},{"label":"Rent","value":1650},{"label":"Transit","value":88},{"label":"Dining","value":214,"muted":true}]'
  ></kit-bar-chart>
  <div style="font-size: 13px; color: var(--muted)">Budget used this month</div>
  <kit-meter ratio="0.72" tone="warn"></kit-meter>
</section>
```

**Excluded on purpose**: the live "Ask your vault" assistant and the vault-fetching @-mention *picker* are runtime controllers wired to the product's SSE/vault surfaces — they are **not** in this component library (only the presentational `<kit-mention-chip>` and `<kit-reference-strip>` are). Build those flows against the live product, not here.
