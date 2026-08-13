// Toolbar region: the free-form tag chips. The title/subtitle and sort label
// are plain text nodes the orchestrator writes directly (never React-owned),
// so this file only carries the one componentized piece.
import shared from "./shared.module.css";

// THE TYPE CHIPS ARE GONE. §4.2 makes Type one of the filter row's four
// properties, and this row of chips was a second control for the same axis —
// two places to say "only PDFs", which could disagree and which made the
// toolbar the fourth surface competing with the strip, the band and the
// breadcrumb. The pill in `components/FilterRow.tsx` is the one control now.
// Tags are NOT one of §4.2's axes, so their chips stay here.

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
