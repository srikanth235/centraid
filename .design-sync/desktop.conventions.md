# Centraid Desktop Shell — building with these components

These are the **host-shell primitives** of Centraid, a personal-data-vault
desktop app (Electron renderer). The recurring surfaces are the home app-grid,
the command chrome, and the assistant. Import everything from
`window.CentraidShell`: `Icon`, `Button`, `Logo`, `AppCard`.

## Setup — no provider, just the stylesheet

There is **no provider or context to wrap**. Components render standalone and
are styled entirely by the design system's global `styles.css` (it `@import`s
the fonts and `_ds_bundle.css`, which carries the token blocks **and** the real
`.cd-*` component rules). Every design already receives that closure. Two
attributes on an ancestor control the look:

- **Theme**: `data-theme="<name>"` — default (unset) = light. Available: `dark`,
  `notion-light`, `notion-dark`, `airtable-light`, `airtable-dark`,
  `github-light`, `github-dark`, `solarized-light`, `solarized-dark`, `nord`,
  `monokai`.
- **Density**: `data-density="comfy" | "regular" | "compact"` (default regular).

Base font is **Geist**; mono is **JetBrains Mono**; display is **Space Grotesk**.

## The styling idiom: props + CSS variables (NOT utility classes)

There is **no utility-class vocabulary** here. Two rules:

1. **Carry the design language through component props**, never hand-rolled
   markup: `<Button variant="primary|soft|ghost" icon="<IconName>">`,
   `<AppCard variant="solid|gradient|glassy|flat" tone="new|draft" small>`,
   `<Icon name="<IconName>" size color>`. Compose the real component; never
   fake a lookalike with raw divs. `Icon` `name` is one of the shared set
   (`Home`, `Search`, `Compass`, `Sparkle`, `Bolt`, `Plus`, `Check`, `Pencil`,
   `Trash`, `Send`, `Star`, `Bell`, `Settings`, `History`, `Folder`, `Code`,
   `Command`, `Share`, … — see `Icon.d.ts` for the full union).

2. **For your own layout glue, style with the DS's CSS variables** — never
   invent hex/radii/spacing. They re-resolve per `data-theme`:
   - Accent: `--accent` (brand teal #3EC8B4), `--accent-deep`, `--accent-light`,
     `--accent-violet`
   - Surfaces: `--bg-app` (page), `--bg-elev` (cards), `--bg-sunken`, `--bg-wall`
   - Text: `--ink`, `--ink-2`, `--ink-3`, `--ink-4`, `--ink-inv`; hairlines
     `--line`, `--line-strong`
   - States: `--danger`, `--success`
   - Radius: `--r-xs|sm|md|lg|xl` (2–14px)
   - Spacing scale: `--d-1`…`--d-7` (4·8·12·16·24·32·48px at regular density)
   - Type presets: `--t-title`, `--t-body`, `--t-small`, `--t-tiny`, `--t-mono`
     (shorthand `font:` values); families `--font-sans`, `--font-mono`,
     `--font-display`

(This DS does **not** define `--surface`, `--muted`, or `--warn` — use
`--bg-elev`, `--ink-3`, and `--danger` respectively.)

## Where the truth lives

Read these before styling — they beat any summary here:

- **Styles**: `styles.css` → `@import "./_ds_bundle.css"` holds the token/theme
  variable blocks **and** the `.cd-*` component selectors. Grep it for a
  variable's definition or a component's exact classes.
- **Per-component API**: `components/general/<Name>/<Name>.d.ts` (the
  `<Name>Props` contract) and `<Name>.prompt.md` (usage).

## One idiomatic build snippet

A home app-grid — real components for the content, DS variables for your own
layout glue:

```tsx
const { AppCard, Button } = window.CentraidShell;

function Home() {
  const apps = [
    { id: 'todos', name: 'Todos', colorKey: 'violet', iconKey: 'Todo', desc: 'Capture and clear small things.', color: '#7C5BD9' },
    { id: 'focus', name: 'Focus', colorKey: 'teal', iconKey: 'Pomodoro', desc: '25-minute work blocks with breaks.', color: '#2EA098' },
  ];
  return (
    <section style={{
      background: 'var(--bg-app)', color: 'var(--ink)', fontFamily: 'var(--font-sans)',
      padding: 'var(--d-5)', display: 'flex', flexDirection: 'column', gap: 'var(--d-4)',
    }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ font: 'var(--t-title)' }}>Your apps</span>
        <Button label="New app" variant="primary" icon="Plus" />
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--d-4)' }}>
        {apps.map((a) => <AppCard key={a.id} app={a} stamp="2h ago" />)}
      </div>
    </section>
  );
}
```
