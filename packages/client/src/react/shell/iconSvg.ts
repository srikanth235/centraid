import { icons } from "@centraid/design";

export function iconSvg(name: string, size = 20, strokeWidth = 1.5): string {
  const paths = icons[name as keyof typeof icons];
  if (!paths) return "";
  const inner = paths
    .map((p) =>
      p.fill === "currentColor"
        ? `<path d="${p.d}" fill="currentColor" stroke="none"/>`
        : `<path d="${p.d}"/>`
    )
    .join("");
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
