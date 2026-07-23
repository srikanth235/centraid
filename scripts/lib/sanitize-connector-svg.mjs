const FORBIDDEN_ELEMENT =
  /<(?:script|style|foreignObject|iframe|object|embed|image|audio|video|canvas|a|animate|animateMotion|animateTransform|set)\b/i;
const EVENT_HANDLER = /\son[a-z][a-z0-9_-]*\s*=/i;
const INLINE_STYLE = /\sstyle\s*=/i;
const ACTIVE_SCHEME = /(?:javascript|vbscript|data|https?):/i;
const EXTERNAL_HREF = /\s(?:href|xlink:href)\s*=\s*["'](?!#)/i;
const XML_FEATURE = /<\?(?:xml)?|<!DOCTYPE|<!ENTITY/i;

/**
 * Iconify is a build-time network input, not trusted source code. Reject any
 * markup capable of navigation, scripting, external resource loading, CSS,
 * or animation before it reaches React's dangerouslySetInnerHTML constant.
 */
export function assertSafeConnectorSvg(svg, source = 'SVG') {
  const refusal =
    XML_FEATURE.test(svg) ||
    FORBIDDEN_ELEMENT.test(svg) ||
    EVENT_HANDLER.test(svg) ||
    INLINE_STYLE.test(svg) ||
    ACTIVE_SCHEME.test(svg) ||
    EXTERNAL_HREF.test(svg);
  if (refusal) throw new Error(`Unsafe active SVG markup from ${source}`);
  return svg;
}
