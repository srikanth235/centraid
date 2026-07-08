// @centraid/desktop-ui — React DOM component library for the Centraid desktop
// shell. Mirrors the mobile RN component API over @centraid/design-tokens +
// @centraid/ui-core. className-based: styled by the desktop's global
// styles.css during the vanilla→React migration (issue #325), so a React
// component and a leftover vanilla one render pixel-identically.

export { default as Icon } from './Icon.js';
export type { IconProps } from './Icon.js';

export { default as Button } from './Button.js';
export type { ButtonProps, ButtonVariant } from './Button.js';

export { default as Logo } from './Logo.js';
export type { LogoProps } from './Logo.js';

export { default as AppCard } from './AppCard.js';
export type { AppCardProps, AppCardTone } from './AppCard.js';

export { default as Gallery } from './preview/Gallery.js';
