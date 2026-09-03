import type { ReactNode } from "react";

export interface SegmentedOption {
  key: string;
  label: string;
  pressed: boolean;
  select: () => void;
}

export interface SegmentedProps {
  label: string;
  options: readonly SegmentedOption[];
}

export function Segmented({ label, options }: SegmentedProps): ReactNode {
  return (
    <fieldset className="kit-seg" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className="kit-seg-option"
          aria-pressed={option.pressed}
          onClick={() => option.select()}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
