// Small shared presentational bits used across Sidebar/Board/Row/Detail.
// Pure functions of props — no app state.
import { snippetSegments } from "../format.ts";

// A trusted static SVG string rendered inline, with no wrapper box in the
// layout (`display:contents`) — see icons.ts for the glyph strings.
export function Icon({ svg }: { svg: string }) {
  return (
    <i
      style={{ display: "contents" }}
      // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// The vault FTS hit snippet (`⟦hit⟧`-marked) as JSX `<mark>` spans — the
// React analogue of the element layer's `snippetInto()`, which mutates a container's DOM
// directly and must never target a React-owned node.
export function Snippet({
  snippet,
  className,
}: {
  snippet: string;
  className?: string;
}) {
  const segments = snippetSegments(snippet);
  return (
    <div className={className}>
      {segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}
    </div>
  );
}
