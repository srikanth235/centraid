import {
  auth,
  authHeaders,
  doFetch,
  VAULT_HEADER,
} from "../../gateway-client-core.js";

export const BLOB_PREFIX = "/centraid/_vault/blobs";

export const SCOPE_ATTR = "data-scope";

/**
 * Address ONE scope. Content ids are per-vault (#599); omitting scope falls
 * through to the ambient vault and can render the wrong bytes.
 * @public
 */
export function blobAuthHeaders(
  token: string | undefined,
  scope?: string
): Record<string, string> {
  return { ...authHeaders(token), ...(scope ? { [VAULT_HEADER]: scope } : {}) };
}

async function authorizedBlobResponse(
  pathname: string,
  scope?: string
): Promise<Response | null> {
  try {
    const { baseUrl, token } = await auth();
    const res = await doFetch(baseUrl, pathname, {
      headers: blobAuthHeaders(token, scope),
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/**
 * Caller owns the returned `blob:` URL and must `URL.revokeObjectURL` it.
 * Omit `scope` only on a single-scope surface.
 * @public
 */
export async function authorizeBlobUrl(
  pathname: string,
  scope?: string
): Promise<string | null> {
  const res = await authorizedBlobResponse(pathname, scope);
  return res ? URL.createObjectURL(await res.blob()) : null;
}

/**
 * Return text directly — a second fetch of the object URL is blocked by CSP
 * (`connect-src` does not admit `blob:`).
 * @public
 */
export async function authorizeBlobText(
  pathname: string,
  scope?: string
): Promise<string | null> {
  const res = await authorizedBlobResponse(pathname, scope);
  return res ? res.text() : null;
}
