// Small shared presentational bits used across Sidebar/HeaderBar/the three
// canvas views/EventDrawer. Pure functions of props — no app state.
import { snippetSegments } from '../format.js';

// A trusted static SVG string rendered inline, with no wrapper box in the
// layout (`display:contents`) — see icons.js for the glyph strings.
export function Icon({ svg }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** A calendar-color dot — the one recurring "which calendar" affordance. */
export function CalDot({ color }) {
  return <span className="ag-dot" style={{ background: color ?? 'var(--_accent)' }} />;
}

// The vault FTS hit snippet (`⟦hit⟧`-marked) as JSX `<mark>` spans.
export function Snippet({ snippet, className = 'ag-row-note' }) {
  const segments = snippetSegments(snippet);
  return (
    <div className={className}>
      {segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}
    </div>
  );
}
