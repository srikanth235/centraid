// Icon glyphs — plain string constants, no JSX. Split out so every component
// that needs a glyph (Sidebar, ExpenseModal) imports from one place instead
// of re-declaring the markup. Same shape as tasks/icons.ts and notes/icons.ts.
// Everything else in the shell (brand mark, hamburger, close, plus, etc.) is
// static inline SVG in index.html and never re-renders, so it stays there.

export const I: Record<string, string> = {
  dashboard:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></svg>',
  activity:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 6 4-14 2 8h6"/></svg>',
  // A clean inline checkmark for an included split row — no emoji, matches
  // the prototype's solid-fill toggle box.
  check:
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 6"/></svg>',
};
