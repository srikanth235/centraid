// Small shared presentational bits used across Sidebar/Wall/Card/Editor.
// Pure functions of props — no app state. Mirrors tasks/components/Shared.jsx.
import type { ReactNode } from '../react-core.min.js';
import { highlightSegments, snippetSegments } from '../format.ts';

// A trusted static SVG string rendered inline, with no wrapper box in the
// layout (`display:contents`) — see icons.ts for the glyph strings.
export function Icon({ svg }: { svg: string }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** `text` with every case-insensitive occurrence of `term` wrapped in
 * `<mark>` — the search-highlight voice for card titles/previews. */
export function Highlighted({ text, term }: { text: string; term: string }): ReactNode {
  const segments = highlightSegments(text, term);
  return segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text));
}

/** The vault FTS hit snippet (`⟦hit⟧`-marked) as `<mark>` spans. */
export function Snippet({ snippet }: { snippet: string }): ReactNode {
  const segments = snippetSegments(snippet);
  return segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text));
}
