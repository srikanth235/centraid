/**
 * Read a document body.
 *
 * An app is inline in the desktop/PWA shell (#799 left no second render path),
 * so it must use the shell's authenticated blob primitive rather than fetching
 * the content URI itself: resolving the relative URI against `file://` or the
 * PWA origin reaches the wrong server, while turning it into a `blob:` URL and
 * fetching again is refused by the shell CSP. The primitive returns the text
 * from its already-authorized response, keeping CSP unchanged. The direct-fetch
 * fallback below survives only for a host that exposes no primitive (tests, and
 * the harness fixtures that render an app outside the shell).
 */
export async function loadBlobText(uri: string): Promise<string> {
  const inlineLoader = window.centraid.blobText;
  if (inlineLoader && uri.startsWith("/centraid/_vault/blobs/")) {
    const text = await inlineLoader(uri);
    if (text === null) throw new Error("blob text unavailable");
    return text;
  }
  const response = await fetch(uri);
  if (!response.ok) throw new Error(String(response.status));
  return response.text();
}
