import { entityKindLabel } from '../lib/kinds';

export interface MentionCard {
  /** Entity type, e.g. `core.party`. */
  type: string;
  /** Display title. */
  title?: string;
  /** Reachability of the linked entity. */
  status?: 'live' | 'trashed' | 'missing' | 'denied';
}

export interface MentionChipProps {
  /** The resolved card for the mentioned entity. */
  card: MentionCard;
}

/** An inline @-mention chip — a resolved anchor to a vault entity. */
export function MentionChip({ card }: MentionChipProps) {
  const gone = card.status === 'missing' || card.status === 'trashed';
  const label = gone ? 'removed from the vault' : card.title || '';
  return (
    <span
      className={`kit-mention-chip${gone ? ' ref-gone' : ''}`}
      title={`${entityKindLabel(card.type)} — linked reference`}
    >
      {label}
    </span>
  );
}
