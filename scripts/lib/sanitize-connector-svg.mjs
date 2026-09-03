const FORBIDDEN_ELEMENT =
  /<(?:script|style|foreignObject|iframe|object|embed|image|audio|video|canvas|a|animate|animateMotion|animateTransform|set)\b/iu;
const EVENT_HANDLER = /\son[a-z][a-z0-9_-]*\s*=/iu;
const INLINE_STYLE = /\sstyle\s*=/iu;
const ACTIVE_SCHEME = /(?:javascript|vbscript|data|https?):/iu;
const EXTERNAL_HREF = /\s(?:href|xlink:href)\s*=\s*["'](?!#)/iu;
const XML_FEATURE = /<\?(?:xml)?|<!DOCTYPE|<!ENTITY/iu;

export function assertSafeConnectorSvg(svg, source = "SVG") {
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
