import { entityKindLabel } from '../lib/kinds';

export type ReferenceStatus = 'live' | 'trashed' | 'missing' | 'denied';

export interface ReferenceCard {
  /** Entity type, e.g. `core.party`. */
  type: string;
  /** Display title. */
  title?: string;
  /** Optional secondary line (shown only when live). */
  subtitle?: string;
  /** Whether the referenced entity is still reachable. */
  status: ReferenceStatus;
}

export interface ReferenceItem {
  /** The link's id. */
  link_id: string;
  /** The resolved card for the linked entity. */
  card: ReferenceCard;
  /** Present when the reference is anchored to a span of text. */
  selector?: unknown;
}

export interface ReferenceStripProps {
  /** The references to render as tiles. */
  refs: ReferenceItem[];
  /** link_ids anchored inline in text — flips the flag to "in text". */
  inlineIds?: string[];
  /** When set, each tile gets a remove (×) button. */
  onRemove?: (ref: ReferenceItem) => void;
  /** Shown when there are no references. */
  emptyText?: string;
}

/** A strip of cross-reference tiles — entities linked to the current item. */
export function ReferenceStrip({ refs, inlineIds = [], onRemove, emptyText }: ReferenceStripProps) {
  if (!refs.length && emptyText) {
    return (
      <div className="kit-ref-strip">
        <p className="kit-ref-empty">{emptyText}</p>
      </div>
    );
  }
  const inline = new Set(inlineIds);
  return (
    <div className="kit-ref-strip">
      {refs.map((ref) => {
        const { card, link_id, selector } = ref;
        const gone = card.status !== 'live';
        const isInline = inline.has(link_id);
        let title = card.title || '';
        if (card.status === 'missing') title = 'removed from the vault';
        else if (card.status === 'denied') title = 'access not granted';
        else if (card.status === 'trashed') title = `${card.title || ''} (in trash)`;
        return (
          <div key={link_id} className={`kit-ref-tile${gone ? ' is-gone' : ''}`}>
            <span className="kit-ref-kind">{entityKindLabel(card.type)}</span>
            {selector ? (
              <span
                className={`kit-ref-flag${isInline ? ' is-inline' : ''}`}
                title={isInline ? 'Anchored in the text' : 'Listed in the strip'}
              >
                {isInline ? 'in text' : 'in strip'}
              </span>
            ) : null}
            <span className="kit-ref-title">{title}</span>
            {card.subtitle && card.status === 'live' ? (
              <span className="kit-ref-sub">{card.subtitle}</span>
            ) : null}
            {onRemove ? (
              <button
                type="button"
                className="kit-ref-remove"
                title="Remove reference"
                aria-label={`Remove reference to ${card.title || 'item'}`}
                onClick={() => onRemove(ref)}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
