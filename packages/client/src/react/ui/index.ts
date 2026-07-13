// Desktop React DOM component library — the shell's presentational primitives.
// Mirrors the mobile RN component API over @centraid/design-tokens (the one
// shared cross-runtime package) + the local `cx`/`tile-visual` helpers.
// Each component owns a co-located `*.module.css`; there are no global
// component classes. Lived in `@centraid/desktop-ui` + `@centraid/ui-core`
// until both were folded here (single consumer, no mobile reuse of the
// logic) — design-tokens stays the sole shared UI package.

export { default as Icon } from './Icon.js';
export type { IconProps } from './Icon.js';

export { default as Button, IconButton } from './Button.js';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button.js';

export { default as StatusPill } from './StatusPill.js';
export type { StatusPillProps, StatusTone } from './StatusPill.js';

export { default as KindBadge } from './KindBadge.js';
export type { KindBadgeProps } from './KindBadge.js';

export { default as Logo } from './Logo.js';
export type { LogoProps } from './Logo.js';

export { default as AppCard } from './AppCard.js';
export type { AppCardProps, AppCardTone } from './AppCard.js';

export { default as Gallery } from './Gallery.js';
