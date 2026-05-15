// Default content templates emitted by `scaffoldProject`. Kept in their
// own module so `scaffold.ts` stays focused on the scaffolding logic
// rather than carrying long template literals inline.
//
// app.css is the per-app styling layer built on top of tokens.css. It
// ships utility classes (.head, .add-bar, .list, .row, .empty, etc.)
// matching the "Component primitives" block in the agent prompt — so a
// model that follows the prompt examples gets working UI immediately.
//
// Rules baked in here:
//   - No hex literals; every color is `var(--…)` from tokens.css.
//   - Hit targets ≥ 44px via min-height on inputs/buttons/circle.
//   - `:focus-visible` outlines preserved with `var(--accent)`.
//   - `prefers-reduced-motion` respected.
//   - Mobile-first with one breakpoint at 720px.
export const DEFAULT_APP_CSS = `* { box-sizing: border-box; }

body {
  margin: 0;
  padding: max(1rem, env(safe-area-inset-top)) 1rem env(safe-area-inset-bottom);
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}

main {
  max-width: 36rem;
  margin: 0 auto;
  padding: 0.5rem 0 2rem;
}

@media (min-width: 720px) {
  body { padding: 1.5rem 2rem; }
  main { max-width: 56rem; }
}

/* --- Page header --- */
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.head h1 {
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 0.1rem;
}
.muted { color: var(--ink-3); font-size: 0.85rem; margin: 0; }
.small { font-size: 0.8rem; }

/* --- Surface / card --- */
.surface {
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 1rem 1.125rem;
}

/* --- Inputs --- */
input[type='text'], input[type='search'], textarea {
  flex: 1;
  min-height: 2.75rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--bg-elev);
  color: var(--ink);
  font: inherit;
  font-size: 1rem;
  -webkit-appearance: none;
}
input:focus-visible, textarea:focus-visible {
  outline: none;
  border-color: var(--accent);
}

/* --- Buttons --- */
button { font: inherit; cursor: pointer; }
.primary {
  min-height: 2.75rem;
  padding: 0 1.125rem;
  border-radius: var(--r-md);
  border: none;
  background: var(--accent);
  color: var(--ink-inv, #fff);
  font-weight: 600;
  font-size: 0.9375rem;
  -webkit-tap-highlight-color: transparent;
}
.primary:disabled { opacity: 0.4; cursor: not-allowed; }
.primary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.ghost {
  min-height: 2.75rem;
  padding: 0 0.875rem;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink-2);
  font-weight: 500;
}
.ghost:hover { background: var(--bg-elev); }
.ghost:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.link {
  background: none; border: none; padding: 0;
  color: var(--accent); text-decoration: underline; font: inherit;
}

/* --- Bars (input + button paired) --- */
.add-bar { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; }

/* --- Lists --- */
.list { display: flex; flex-direction: column; gap: 0.25rem; }
.row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.625rem 0;
  border-bottom: 1px solid var(--line);
}
.row:last-child { border-bottom: none; }
.row-text { flex: 1; min-width: 0; font-size: 0.95rem; line-height: 1.35; word-break: break-word; }
.row[data-done='true'] .row-text { color: var(--ink-4); text-decoration: line-through; }

/* --- Circle toggle (used inside list rows) --- */
.circle {
  width: 1.75rem; height: 1.75rem;
  min-width: 1.75rem;
  border-radius: 50%;
  border: 1.5px solid var(--ink-4);
  background: transparent;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  color: var(--ink-inv, #fff);
  -webkit-tap-highlight-color: transparent;
}
.circle[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); }
.circle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* --- Quiet icon button (e.g. row delete) --- */
.del {
  background: transparent; border: none;
  width: 2.25rem; height: 2.25rem;
  border-radius: var(--r-sm);
  color: var(--ink-4);
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  -webkit-tap-highlight-color: transparent;
}
.del:hover { color: var(--ink-2); }
.del:active { color: var(--danger); }
.del:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* --- State triad --- */
.empty { color: var(--ink-3); font-size: 0.9rem; text-align: center; padding: 2rem 0; }
.loading { color: var(--ink-3); font-size: 0.9rem; text-align: center; padding: 1rem 0; }
.error {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
  border-radius: var(--r-md);
  padding: 0.625rem 0.875rem;
  font-size: 0.9rem;
}

/* --- Motion --- */
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
`;
