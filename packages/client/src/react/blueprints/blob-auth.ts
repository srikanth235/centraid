// Lightweight vault-blob authorizer (issue #505 Phase 4 / boot-size fix).
//
// `authorizeBlobUrl` used to live in `kit-inline.ts`, but that module is a
// barrel (`export * from '@centraid/blueprints/kit/kit.js'`, resolved to the
// TypeScript source by the toolchain) — importing ONE
// symbol from it dragged the entire served kit into whatever chunk the importer
// landed in. Because `inline-blob-images.ts` (eager via InlineAppRoute → App)
// imports `authorizeBlobUrl`, the full kit was being pulled into the shell's
// boot chunk, regressing initial-load JS. This function needs nothing from the
// kit — only the authed gateway client — so it lives here as its own leaf
// module. `kit-inline.ts` re-exports it, so the served-kit consumers are
// unchanged; `inline-blob-images.ts` imports it directly and stays kit-free.
import {
  auth,
  authHeaders,
  doFetch,
  VAULT_HEADER,
} from "../../gateway-client-core.js";

/** The vault blob route prefix every inline blob reference points at. */
export const BLOB_PREFIX = "/centraid/_vault/blobs";

/** The DOM attribute an inline app stamps to say which scope owns these bytes. */
export const SCOPE_ATTR = "data-scope";

/**
 * Authorization headers for a blob request, addressed at ONE scope.
 *
 * A blob path carries a content id, and content ids are minted PER VAULT — the
 * same photo shared into an audience has the same sha in two vaults, and two
 * unrelated items can collide across vaults by design (issue #599). Without the
 * scope the request falls through to the shell's ambient focused vault, which
 * either 404s or, worse, renders the WRONG bytes. Every blob fetch on a
 * multi-scope surface therefore names its scope.
 * @public
 */
export function blobAuthHeaders(
  token: string | undefined,
  scope?: string
): Record<string, string> {
  return { ...authHeaders(token), ...(scope ? { [VAULT_HEADER]: scope } : {}) };
}

/**
 * Fetch a `/_vault/blobs/…` pathname through the authed gateway client and hand
 * back a `blob:` object URL for it (or null if the fetch is refused). The caller
 * OWNS the returned URL's lifecycle and must `URL.revokeObjectURL` it. Shared by
 * `renderAttachments` (attachment strips) and `inline-blob-images` (the generic
 * grid/lightbox/cover authorizer), so both reach vault bytes the same way.
 *
 * `scope` is the id of the mounted scope these bytes belong to; omitting it
 * addresses the shell's ambient scope, which is only correct on a single-scope
 * surface.
 * @public
 */
export async function authorizeBlobUrl(
  pathname: string,
  scope?: string
): Promise<string | null> {
  try {
    const { baseUrl, token } = await auth();
    const res = await doFetch(baseUrl, pathname, {
      headers: blobAuthHeaders(token, scope),
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}
