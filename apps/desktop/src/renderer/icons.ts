// Lucide-style line icons. Path data lives in @centraid/design-tokens
// (single source of truth across desktop + mobile). This file only wraps
// the path data into SVG strings the renderer can innerHTML.

(function () {
  const tokens = window.CentraidTokens;
  if (!tokens || !tokens.icons) {
    console.error('CentraidTokens.icons missing — preload.js may not be loaded.');
    window.Icon = window.Icon || ({} as typeof window.Icon);
    window.ICON_PALETTE = window.ICON_PALETTE || ({} as typeof window.ICON_PALETTE);
    return;
  }

  interface IconPath {
    d: string;
    fill?: 'currentColor';
  }

  const wrap = (
    paths: readonly IconPath[],
    opts: { size?: number; strokeWidth?: number } = {},
  ): string => {
    const { size = 20, strokeWidth = 1.5 } = opts;
    const inner = paths
      .map((p) => {
        const fillAttr = p.fill === 'currentColor' ? ' fill="currentColor" stroke="none"' : '';
        return `<path d="${p.d}"${fillAttr}/>`;
      })
      .join('');
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  };

  const Icon: Record<string, (opts?: { size?: number; strokeWidth?: number }) => string> = {};
  for (const [name, paths] of Object.entries(tokens.icons)) {
    Icon[name] = (opts) => wrap(paths, opts);
  }

  window.Icon = Icon as typeof window.Icon;
  window.ICON_PALETTE = tokens.palette;
})();
