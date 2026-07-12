# Centraid Blueprint Kit — native Web Components

These are Centraid's blueprint-kit UI primitives, shipped as **native custom elements** — plain `customElements.define()` classes, no runtime dependency underneath. Use a component by writing its tag directly — `<kit-avatar>`, `<kit-bar-chart>`, `<kit-toast>`, … There is no React wrapper and no import: the elements are defined by `components/elements.js`, which is the same file the product ships.

## Setup

Load the two shared files once, then write the tags:

```html
<link rel="stylesheet" href="styles/bundle.css" />
<script type="module" src="components/elements.js"></script>

<kit-bar-chart items='[{"label":"Rent","value":1650},{"label":"Dining","value":214,"muted":true}]'></kit-bar-chart>
```

- **Theme**: `data-theme="dark | notion-light | github-dark | nord | …"` on an ancestor (default = light).
- **Density**: `data-density="comfy | regular | compact"` (default regular).

## Styling idiom — attributes + CSS variables (no utility classes)

Vary appearance through **element attributes**: `<kit-toast tone="accent|danger">`, `<kit-meter tone="warn|danger|ok">`, `<kit-avatar shape="rounded">`. Pass rich data as **JSON attributes**: `items='[…]'`, `points='[…]'`, `refs='[…]'`, `card='{…}'` — the elements' default attribute converter parses them.

For your own layout glue, style with the DS variables (they re-resolve per `data-theme`): surfaces `--bg-app`/`--surface`/`--surface-2`; text `--text`/`--muted`; lines `--line`/`--line-strong`; accent `--accent`/`--danger`/`--warn`/`--success`; radius `--r-xs…xl`; spacing `--d-1…d-7`; fonts `--sans`/`--mono`/`--display`.

## Components

| Tag | What it is | Key attributes |
| --- | --- | --- |
| `<kit-avatar>` | Letter/photo avatar, stable hashed hue | `name`, `size`, `shape="rounded"`, `src`, `color`, `initials` |
| `<kit-meter>` | Slim proportion bar | `ratio` (0–1), `tone="warn\|danger\|ok"` |
| `<kit-line-chart>` | Trend line + area + last-point dot | `points` (JSON `[{x,y}]`), `width`, `height`, `label` |
| `<kit-bar-chart>` | Vertical bars with tick labels | `items` (JSON `[{label,value,muted?}]`), `width`, `height`, `label` |
| `<kit-skeleton>` | Shimmer loading rows | `rows`, `variant="line\|title\|row\|circle"`, `width` |
| `<kit-toast>` | Outcome toast bubble | `text`, `tone="accent\|danger"`, `undo-label` |
| `<kit-mention-chip>` | Inline @-mention chip | `card` (JSON `{type,title,status}`) |
| `<kit-reference-strip>` | Cross-reference tiles | `refs` (JSON `[{link_id,card,selector?}]`), `empty-text` |

## Where the truth lives

- `styles/bundle.css` — the whole style layer (tokens + fonts + bridge + the `.kit-*` classes).
- `components/elements.js` — the real, product-shipped custom-element definitions.
- `previews/<tag>.html` — a rendered example of each element.

**Excluded on purpose**: the live "Ask your vault" assistant and the vault-fetching @-mention *picker* are runtime controllers wired to the product's SSE/vault surfaces — only the presentational `<kit-mention-chip>` / `<kit-reference-strip>` are here.
