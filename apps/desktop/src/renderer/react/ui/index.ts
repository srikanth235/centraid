// Desktop React DOM component library — the shell's presentational primitives.
// Mirrors the mobile RN component API over @centraid/design-tokens (the one
// shared cross-runtime package) + the local `cx`/`tile-visual` helpers.
// className-based: styled by the renderer's global styles.css during the
// vanilla→React migration (issue #325), so a React component and a leftover
// vanilla one render pixel-identically. Lived in `@centraid/desktop-ui` +
// `@centraid/ui-core` until both were folded here (single consumer, no mobile
// reuse of the logic) — design-tokens stays the sole shared UI package.

export { default as Icon } from './Icon.js';
export type { IconProps } from './Icon.js';

export { default as Button } from './Button.js';
export type { ButtonProps, ButtonVariant } from './Button.js';

export { default as Logo } from './Logo.js';
export type { LogoProps } from './Logo.js';

export { default as AppCard } from './AppCard.js';
export type { AppCardProps, AppCardTone } from './AppCard.js';

export { default as Gallery } from './Gallery.js';
