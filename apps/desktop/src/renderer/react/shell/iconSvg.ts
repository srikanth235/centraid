import { icons } from '@centraid/design-tokens';

// Build a design-token icon as an SVG string — for the imperative body-portal
// overlays (toast/confirm/template-preview) that manipulate the DOM directly
// and can't use the <Icon> component. Emits the identical shape Icon.tsx and
// the vanilla `Icon[name]()` wrapper produce, so a string-built glyph is
// pixel-equal to a component-rendered one.
export function iconSvg(name: string, size = 20, strokeWidth = 1.5): string {
  const paths = icons[name as keyof typeof icons];
  if (!paths) return '';
  const inner = paths
    .map((p) =>
      p.fill === 'currentColor'
        ? `<path d="${p.d}" fill="currentColor" stroke="none"/>`
        : `<path d="${p.d}"/>`,
    )
    .join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
