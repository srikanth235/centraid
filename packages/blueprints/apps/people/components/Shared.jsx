// Small shared presentational bits used across Sidebar/Grid/List/Details/
// Journal/Activity. Pure functions of props — no app state.

// A trusted static SVG string rendered inline, with no wrapper box in the
// layout (`display:contents`) — see icons.js for the glyph strings.
export function Icon({ svg }) {
  return <i style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Checkbox({ cls, selected, onClick, label, checkSvg }) {
  return (
    <button type="button" className={cls} aria-pressed={String(selected)} aria-label={label} onClick={onClick}>
      {selected ? <Icon svg={checkSvg} /> : null}
    </button>
  );
}

// The vault FTS hit snippet (`⟦hit⟧`-marked) as JSX `<mark>` spans — the
// React analogue of kit.js's `snippetInto()`, which mutates a container's DOM
// directly and must never target a React-owned node.
export function Snippet({ snippet, className }) {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  return (
    <div className={className}>
      {parts.map((part, i) => (!part ? null : i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}
    </div>
  );
}
