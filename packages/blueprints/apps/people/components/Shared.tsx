// Small shared presentational bits used across Sidebar/Grid/List/Details/
// Journal/Activity. Pure functions of props — no app state.

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

export function Checkbox({
  cls,
  selected,
  onClick,
  label,
  checkSvg,
}: {
  cls: string;
  selected: boolean;
  onClick: () => void;
  label: string;
  checkSvg: string;
}) {
  return (
    <button
      type="button"
      className={cls}
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
    >
      {selected ? <Icon svg={checkSvg} /> : null}
    </button>
  );
}

// The vault FTS hit snippet (`⟦hit⟧`-marked) as JSX `<mark>` spans — the
// React analogue of the element layer's `snippetInto()`, which mutates a container's DOM
// directly and must never target a React-owned node.
export function Snippet({
  snippet,
  className,
}: {
  snippet?: string | null;
  className?: string;
}) {
  const parts = String(snippet ?? "").split(/[⟦⟧]/u);
  return (
    <div className={className}>
      {parts.map((part, i) =>
        part ? i % 2 === 1 ? <mark key={i}>{part}</mark> : part : null
      )}
    </div>
  );
}
