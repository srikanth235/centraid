// A DOM-builder matching the renderer's ambient `ElHelper` signature — handed to
// the vanilla host subsystems React still delegates to (window.AppChat, and the
// builder). Mirrors the vanilla `el` in app.ts/chrome.ts (class / style / on*
// handlers / trustedHtml / plain attrs + string|node children), so those
// subsystems build DOM exactly as before while React owns the surrounding shell.
export function el(
  tag: string,
  attrs: ElAttrs = {},
  children: ElChild | ElChild[] = [],
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class' && typeof v === 'string') {
      node.className = v;
    } else if (k === 'style' && typeof v === 'object' && v !== null) {
      Object.assign(node.style, v as Partial<CSSStyleDeclaration>);
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'trustedHtml' && typeof v === 'string') {
      node.innerHTML = v;
    } else if (v != null && typeof v !== 'function') {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c == null || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}
