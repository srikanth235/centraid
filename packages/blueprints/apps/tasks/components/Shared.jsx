// Small shared presentational bits used across Sidebar/Board/Row/Detail.
// Pure functions of props — no app state.
import { snippetSegments } from '../format.js';

// A trusted static SVG string rendered inline, with no wrapper box in the
// layout (`display:contents`) — see icons.js for the glyph strings.
export function Icon({ svg }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

// The vault FTS hit snippet (`⟦hit⟧`-marked) as JSX `<mark>` spans — the
// React analogue of kit.js's `snippetInto()`, which mutates a container's DOM
// directly and must never target a React-owned node.
export function Snippet({ snippet, className = 'tk-row-note' }) {
  const segments = snippetSegments(snippet);
  return (
    <div className={className}>
      {segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}
    </div>
  );
}
