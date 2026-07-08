import type { JSX } from 'react';
import { cx, tileVisual } from '@centraid/ui-core';
import type { AppMetaResolved, TileVariant } from '@centraid/design-tokens';
import Icon from './Icon.js';

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
 * Home-grid app tile — a React port of the vanilla renderer's `cd-app-card`
 * composite (icon plate + name/blurb + footer). Desktop-specific (there is no
 * mobile twin for this exact composite; mobile's simpler launcher `<Tile>` is
 * the closest cousin). Emits the same `cd-app-card*` classes as the vanilla
 * builder, so it is styled by the global `styles.css` and renders identically
 * during coexistence. The icon plate's finish is computed through
 * ui-core's `tileVisual`, the one place desktop + mobile agree on tile paint.
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
      className={cx('cd-app-card', { 'cd-app-card--small': small })}
      data-testid="app-tile"
      data-kind="app"
      onClick={onOpen}
    >
      <div className="cd-app-card-head">
        <div
          className="cd-app-card-icon"
          style={{
            background: finish.background,
            boxShadow: finish.boxShadow,
            color: finish.glyphColor,
          }}
        >
          <Icon name={app.iconKey} size={24} strokeWidth={1.9} />
          {tone ? <span className="cd-app-card-icon-dot" data-tone={tone} /> : null}
        </div>
        <div className="cd-app-card-head-text">
          <div className="cd-app-card-name-row">
            <div className="cd-app-card-name">{app.name}</div>
            {tone ? (
              <span className="cd-status" data-tone={tone}>
                <span className="cd-status-dot" />
                {tone}
              </span>
            ) : null}
          </div>
          <div className="cd-app-card-desc">{app.desc || 'No description yet.'}</div>
        </div>
      </div>
      <div className="cd-app-card-foot">
        <span className="cd-disc-badge" data-kind="app">
          <span>App</span>
        </span>
        {stamp ? <span className="cd-app-card-foot-time">{stamp}</span> : null}
      </div>
    </button>
  );
}
