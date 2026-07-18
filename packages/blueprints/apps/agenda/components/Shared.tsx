// Small shared presentational bits used across Sidebar/HeaderBar/the three
// canvas views/EventDrawer. Pure functions of props — no app state.
//
// CSS note: `ag-dot` stays a GLOBAL class in app.css — it is also built as a
// plain-string class by app.tsx's "+N more" popover glue (kit `h()`), so it is
// not moved into a module.
import { snippetSegments } from '../format.ts';

// A trusted static SVG string rendered inline, with no wrapper box in the
// layout (`display:contents`) — see icons.ts for the glyph strings.
export function Icon({ svg }: { svg: string }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** A calendar-color dot — the one recurring "which calendar" affordance. */
export function CalDot({ color }: { color?: string | null }) {
  return <span className="ag-dot" style={{ background: color ?? 'var(--_accent)' }} />;
}

// The vault FTS hit snippet (`⟦hit⟧`-marked) as JSX `<mark>` spans.
export function Snippet({
  snippet,
  className = 'ag-row-note',
}: {
  snippet?: string | null;
  className?: string;
}) {
  const segments = snippetSegments(snippet);
  return (
    <div className={className}>
      {segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}
    </div>
  );
}
