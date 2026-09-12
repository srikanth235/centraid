// Forbidden constructs the public-site token gate scans for (#1018).

export type ForbiddenRule = {
  label: string;
  pattern: RegExp;
  hint: string;
  allow?: (value: string) => boolean;
};

export const FORBIDDEN: ForbiddenRule[] = [
  {
    // The whole reason the sites looked like another product.
    label: "a font CDN",
    pattern: /fonts\.(?:googleapis|gstatic)\.com/giu,
    hint: "the bundled face is served from this origin — see assets/centraid-tokens.css",
  },
  {
    label: "a retired site theme name",
    pattern:
      /['"](?:paper|night)['"]\s*(?::|===|==)|data-theme=['"](?:paper|night)['"]/giu,
    hint: "the product's themes are `light` and `dark`; the migration in DocsLayout/docs.js is the only place the old names may appear",
  },
  {
    // A face is a token now. `inherit`, `var(--font-sans)` and
    // `var(--font-code)` are the whole vocabulary. The allowed set is tested
    // on the CAPTURED value rather than inside the pattern: a negative
    // lookahead after `\s*` is defeated by backtracking onto zero whitespace,
    // which passes every declaration it was meant to catch.
    label: "a literal font family",
    pattern: /font-family\s*:\s*(?<value>[^;}]+)/giu,
    allow: (value: string) =>
      /^(?:inherit|var\(\s*--font-(?:sans|code)\s*\))$/u.test(value.trim()),
    hint: "use var(--font-sans), or var(--font-code) for a command, path or literal",
  },
];

/**
 * What the report may not carry, on top of the three above.
 *
 * The colour rule is report-only rather than shared. The two sites paint some
 * of their marks in inline SVG inside `index.html`, where a `fill` has to name
 * a colour literally because a social card is rasterized by a renderer with no
 * stylesheet; the report draws no artwork at all — its one SVG is a sparkline
 * whose stroke is a token — so here a literal is always the defect it looks
 * like. Six and eight digits only: `#839` in this tree is an issue number, and
 * a gate that reds on every citation is a gate someone turns off.
 */
export const REPORT_FORBIDDEN: ForbiddenRule[] = [
  ...FORBIDDEN,
  {
    label: "a colour literal",
    pattern: /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/gu,
    hint: "name a token: a status takes a --st-* rung, everything else takes the role it means",
  },
  {
    // The face the report shipped for two years, and the one name that proves
    // this migration did not half-land.
    label: "a withdrawn face",
    pattern: /\bInter\b\s*,/gu,
    hint: "the one bundled face is Instrument Sans, reached through var(--font-sans)",
  },
];
