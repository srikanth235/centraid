// Lightweight vault-blob authorizer (issue #505 Phase 4 / boot-size fix).
//
// `authorizeBlobUrl` used to live in `kit-inline.ts`, but that module is a
// barrel (`export * from '@centraid/blueprints/kit/kit.js'`) — importing ONE
// symbol from it dragged the entire served kit into whatever chunk the importer
// landed in. Because `inline-blob-images.ts` (eager via InlineAppRoute → App)
// imports `authorizeBlobUrl`, the full kit was being pulled into the shell's
// boot chunk, regressing initial-load JS. This function needs nothing from the
// kit — only the authed gateway client — so it lives here as its own leaf
// module. `kit-inline.ts` re-exports it, so the served-kit consumers are
// unchanged; `inline-blob-images.ts` imports it directly and stays kit-free.
import { auth, authHeaders, doFetch } from '../../gateway-client-core.js';

/** The vault blob route prefix every inline blob reference points at. */
export const BLOB_PREFIX = '/centraid/_vault/blobs';

/**
 * Fetch a `/_vault/blobs/…` pathname through the authed gateway client and hand
 * back a `blob:` object URL for it (or null if the fetch is refused). The caller
 * OWNS the returned URL's lifecycle and must `URL.revokeObjectURL` it. Shared by
 * `renderAttachments` (attachment strips) and `inline-blob-images` (the generic
 * grid/lightbox/cover authorizer), so both reach vault bytes the same way.
 * @public
 */
export async function authorizeBlobUrl(pathname: string): Promise<string | null> {
  try {
    const { baseUrl, token } = await auth();
    const res = await doFetch(baseUrl, pathname, { headers: authHeaders(token) });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}
