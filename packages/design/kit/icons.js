// Browser adapter for the shared icon registry.  The kit is served as a
// standalone asset, so it cannot import the TypeScript package at runtime;
// these path arrays mirror the named entries in src/icons.ts and are lowered
// by one serializer instead of embedding SVG documents at call sites.
const PATHS = {
  ChevronDown: ["M6 9l6 6 6-6"],
  History: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5M12 7v5l3 2"],
  Paperclip: [
    "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
  ],
};

export function kitIcon(name, size = 20, strokeWidth = 1.5) {
  const paths = (PATHS[name] || []).map((d) => `<path d="${d}"/>`).join("");
  return [
    "<",
    `svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`,
    paths,
    "</svg>",
  ].join("");
}
