# Centraid Blueprint Kit — building with these components

These components are React wrappers over Centraid's "blueprint kit" — the UI substrate of a **personal-data-vault** product (the recurring surfaces are the "Ask your vault" assistant, receipts/consent cards, cross-reference chips, and small data charts). Import everything from `window.CentraidKit`.

## Setup — no provider, just the stylesheet

There is **no provider or context to wrap**. Components render standalone and are styled entirely by the design system's global `styles.css`, which every design already receives. Two attributes on a root element control the look:

- **Theme**: `data-theme="<name>"` on an ancestor. Default (unset) = light. Available: `dark`, `notion-light`, `notion-dark`, `airtable-light`, `airtable-dark`, `github-light`, `github-dark`, `solarized-light`, `solarized-dark`, `nord`, `monokai`.
- **Density**: `data-density="comfy" | "regular" | "compact"` (default regular).

The base font is **Geist** (set on `:root`); mono is **JetBrains Mono**, display is **Space Grotesk**.

## The styling idiom: props + CSS variables (NOT utility classes)

There is **no utility-class vocabulary** here. Two rules:

1. **Carry the design language through component props**, not markup. Tone/role/variant props are how you vary appearance: `<Toast tone="accent|danger">`, `<Message role="user|ai">`, `<Meter tone="warn|danger">`, `<BarChart items={[{label,value,muted}]}>`, `<Avatar name shape="rounded">`, `<ReferenceStrip>` reacts to each ref's `status` (`live|trashed|missing|denied`). Never hand-roll a lookalike with raw divs — compose the real component.

2. **For your own layout glue around the components, style with the DS's CSS variables** — never invent hex colors, radii, or spacing. They all re-resolve per `data-theme`, so using them keeps your layout theme-correct for free:

   - Accent: `--accent` (brand teal #3EC8B4), `--accent-deep`, `--accent-soft`; states `--danger`, `--warn`, `--success`
   - Surfaces: `--bg-app` (page), `--surface` (cards), `--surface-2` (sunken)
   - Text: `--text`, `--muted`; hairlines `--line`, `--line-strong`
   - Radius: `--r-xs|sm|md|lg|xl` (2–14px), or the alias `--radius`
   - Spacing scale: `--d-1`…`--d-7` (4·8·12·16·24·32·48px at regular density)
   - App-icon palette hues: `--c-teal|amber|indigo|forest|ochre|rose|slate|violet`
   - Fonts: `--sans`, `--mono`, `--display`

## Where the truth lives

Read these before styling — they beat any summary here:

- **Styles**: `styles.css` → it `@import`s `_ds_bundle.css`, which holds the token/theme variable blocks **and** the real component CSS (the `.kit-*` classes). Grep it for a variable's definition or a component's exact selectors.
- **Per-component API + usage**: `components/general/<Name>/<Name>.prompt.md` (usage reference) and `<Name>.d.ts` (the props contract).

## One idiomatic example

A small "spend summary" panel — real components for the content, DS variables for your own layout glue:

```tsx
const { BarChart, Meter, Message } = window.CentraidKit;

function SpendSummary() {
  return (
    <section style={{
      background: 'var(--surface)', color: 'var(--text)',
      border: '1px solid var(--line)', borderRadius: 'var(--r-lg)',
      padding: 'var(--d-4)', display: 'flex', flexDirection: 'column', gap: 'var(--d-3)',
      fontFamily: 'var(--sans)',
    }}>
      <BarChart label="Spend by category" items={[
        { label: 'Groceries', value: 412 }, { label: 'Rent', value: 1650 },
        { label: 'Transit', value: 88 }, { label: 'Dining', value: 214, muted: true },
      ]} />
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>Budget used this month</div>
      <Meter ratio={0.72} tone="warn" />
      <Message role="ai">You're 72% through March's budget with 9 days left.</Message>
    </section>
  );
}
```

**Excluded on purpose**: the live Ask/mention *behaviors* (SSE streaming, the vault-fetching @-mention picker) are not in this library — `AskPanel` and `MentionPopover` ship as static shells you wire up yourself.
