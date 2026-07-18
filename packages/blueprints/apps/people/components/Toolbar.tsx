// Toolbar region: the status filter chips (#statusChips root). The title/
// subtitle, view-toggle pressed state and sort label are plain text/attribute
// writes the orchestrator makes directly (never React-owned), same as Docs.
// No CSS module: the chips ride kit.css `.kit-chip.quiet` (global strings).
import type { ChipKey } from '../types.ts';

const CHIP_DEFS: Array<[ChipKey, string]> = [
  ['all', 'All'],
  ['overdue', 'Overdue'],
  ['due', 'Due soon'],
  ['ok', 'On track'],
];

export function StatusChips({
  chip,
  onSelect,
}: {
  chip: ChipKey;
  onSelect: (key: ChipKey) => void;
}) {
  return (
    <>
      {CHIP_DEFS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="kit-chip quiet"
          aria-pressed={chip === key}
          onClick={() => onSelect(key)}
        >
          {label}
        </button>
      ))}
    </>
  );
}
