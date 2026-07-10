// Toolbar region: the type filter chips (#typeChips root). The title/subtitle
// and sort label are plain text nodes the orchestrator writes directly (never
// React-owned), so this file only carries the one componentized piece.

const TYPE_CHIPS = [
  ['all', 'All'],
  ['pdf', 'PDFs'],
  ['image', 'Images'],
  ['doc', 'Docs'],
  ['sheet', 'Sheets'],
];

export function TypeChips({ type, onSelect }) {
  return (
    <>
      {TYPE_CHIPS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="kit-chip quiet"
          aria-pressed={String(type === key)}
          onClick={() => onSelect(key)}
        >
          {label}
        </button>
      ))}
    </>
  );
}
