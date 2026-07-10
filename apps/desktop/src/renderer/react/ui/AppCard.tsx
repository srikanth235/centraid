import type { JSX } from 'react';
import { cx } from './cx.js';
import { tileVisual } from './tile-visual.js';
import type { AppMetaResolved, TileVariant } from '@centraid/design-tokens';
import Icon from './Icon.js';
import KindBadge from './KindBadge.js';
import StatusPill from './StatusPill.js';
import styles from './AppCard.module.css';

export type AppCardTone = 'new' | 'draft' | null;

export interface AppCardProps {
  app: AppMetaResolved;
  /** Tile finish — follows the user's `tileVariant` preference. */
  variant?: TileVariant;
  /** Corner state: a freshly-created app ("new") or an unpublished draft. */
  tone?: AppCardTone;
  /** Footer timestamp text, e.g. "2h ago" or "saved". */
  stamp?: string;
  small?: boolean;
  onOpen?: () => void;
}

/**
 * Home-grid app tile — icon plate + name/blurb + footer, styled by the
 * co-located `AppCard.module.css` (shared with the Home shelf and Discover
 * grid, which compose richer tiles from the same module). Desktop-specific
 * (there is no mobile twin for this exact composite; mobile's simpler
 * launcher `<Tile>` is the closest cousin). The icon plate's finish is
 * computed through `tileVisual`, the one place desktop + mobile agree on
 * tile paint.
 */
export default function AppCard({
  app,
  variant = 'solid',
  tone = null,
  stamp,
  small = false,
  onOpen,
}: AppCardProps): JSX.Element {
  const { finish } = tileVisual(app, variant);
  return (
    <button
      type="button"
      className={cx(styles.card, small && styles.small)}
      data-testid="app-tile"
      data-kind="app"
      onClick={onOpen}
    >
      <div className={styles.head}>
        <div
          className={styles.icon}
          style={{
            background: finish.background,
            boxShadow: finish.boxShadow,
            color: finish.glyphColor,
          }}
        >
          <Icon name={app.iconKey} size={24} strokeWidth={1.9} />
          {tone ? <span className={styles.iconDot} data-tone={tone} /> : null}
        </div>
        <div className={styles.headText}>
          <div className={styles.nameRow}>
            <div className={styles.name}>{app.name}</div>
            {tone ? <StatusPill tone={tone}>{tone}</StatusPill> : null}
          </div>
          <div className={styles.desc}>{app.desc || 'No description yet.'}</div>
        </div>
      </div>
      <div className={styles.foot}>
        <KindBadge kind="app">
          <span>App</span>
        </KindBadge>
        {stamp ? <span className={styles.footTime}>{stamp}</span> : null}
      </div>
    </button>
  );
}
