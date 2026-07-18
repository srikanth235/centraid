// Toolbar region: the type filter chips (#typeChips root). The title/subtitle
// and sort label are plain text nodes the orchestrator writes directly (never
// React-owned), so this file only carries the one componentized piece.
import shared from './shared.module.css';

const TYPE_CHIPS: ReadonlyArray<readonly [string, string]> = [
  ['all', 'All'],
  ['pdf', 'PDFs'],
  ['image', 'Images'],
  ['media', 'Media'],
  ['doc', 'Docs'],
  ['sheet', 'Sheets'],
];

export function TypeChips({ type, onSelect }: { type: string; onSelect: (key: string) => void }) {
  return (
    <>
      {TYPE_CHIPS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="kit-chip quiet"
          aria-pressed={type === key}
          onClick={() => onSelect(key)}
        >
          {label}
        </button>
      ))}
    </>
  );
}

// Free-form label chips (issue #352 phase 4) — same visual idiom as
// TypeChips above (kit.css's .kit-chip.quiet), one per distinct label across
// the whole loaded drive (never scoped to the current folder/nav, so
// switching tags never dead-ends on "no tags to pick from" — the same
// reasoning the photos app's own tag chips use). Renders nothing when the
// vault has no labels yet — an empty chip row, not a placeholder.
export function TagChips({
  tags,
  active,
  onSelect,
}: {
  tags: string[];
  active: string;
  onSelect: (key: string) => void;
}) {
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          className={`kit-chip quiet ${shared.tagChip}`}
          aria-pressed={active === tag}
          onClick={() => onSelect(tag)}
        >
          #{tag}
        </button>
      ))}
    </>
  );
}
