/**
 * Read a document body on both app render paths.
 *
 * Served apps own a same-origin gateway document, so their content URI is
 * directly fetchable. Bundled apps are inline in the desktop/PWA shell and
 * must instead use the shell's authenticated blob primitive: resolving the
 * relative URI against `file://` or the PWA origin reaches the wrong server,
 * while turning it into a `blob:` URL and fetching again is refused by the
 * shell CSP. The primitive returns the text from its already-authorized
 * response, keeping CSP unchanged.
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
