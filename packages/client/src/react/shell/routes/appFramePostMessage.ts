/**
 * Concrete `targetOrigin` for shell → app-iframe `postMessage`.
 *
 * Prefer the frame's http(s) origin when known. Opaque app documents
 * (`data:` / `blob:`, Iroh sandboxed docs without allow-same-origin) have a
 * null origin and require `"*"` per the HTML postMessage rules.
 */
export function appFramePostMessageOrigin(
  frame: Pick<HTMLIFrameElement, "src">
): string {
  const src = frame.src;
  if (!src || src === "about:blank") {
    // Frame not navigated yet — no foreign origin to target; keep delivery
    // scoped to the shell origin so a premature message cannot go to "*".
    return window.location.origin;
  }
  try {
    const url = new URL(src, window.location.href);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.origin;
    }
  } catch {
    /* fall through to opaque handling */
  }
  // data:/blob: (opaque document) — must use wildcard targetOrigin
  return "*";
}
