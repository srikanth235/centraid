// `tileVisual` — the cross-runtime app-tile view-model.
//
// A tile is drawn from three things: a resolved app's identity color, the
// finish variant, and the glyph. `tileFinish` (design-tokens) already turns
// (color, variant) into platform-agnostic paint values; this wraps it into
// the exact shape a *tile component* consumes so the desktop DOM `Tile.tsx`
// and the mobile RN `Tile.tsx` compute their pixels from one place instead of
// each reaching into design-tokens differently. This is the kind of thing
// ui-core exists to hold: shared view logic, no rendering.

import { tileFinish } from '@centraid/design-tokens';
import type { AppMetaResolved, IconName, TileFinish, TileVariant } from '@centraid/design-tokens';

export interface TileVisual {
  /** Display label. */
  name: string;
  /** Glyph to draw inside the icon disc. */
  iconKey: IconName;
  /** Resolved paint values (background, glyph color, shadow, …). */
  finish: TileFinish;
}

export function tileVisual(app: AppMetaResolved, variant: TileVariant = 'solid'): TileVisual {
  return {
    finish: tileFinish(app.color, variant),
    iconKey: app.iconKey,
    name: app.name,
  };
}
