export interface BackgroundTransferScope {
  gatewayBaseUrl: string;
  fetchImpl?: typeof fetch;
}

function hasQuery(url: URL, name: string): boolean {
  const wanted = name.toLowerCase();
  return [...url.searchParams.keys()].some(
    (key) => key.toLowerCase() === wanted
  );
}

/**
 * How many decoding rounds a path may need before it stops changing. Each round
 * strictly shortens the string, so a legitimate key stabilises in one or two;
 * the bound exists so a crafted path cannot spin here, and exceeding it is a
 * refusal rather than a pass (see `pathScope`).
 */
const MAX_DECODE_ROUNDS = 10;

/** Path separators, for segment splitting. */
const SEPARATORS = /[/\\]/u;

/**
 * Is this path inside the authorized namespace, at EVERY decoding of it?
 *
 * WHY THIS IS NOT A `startsWith`. `new URL()` resolves a LITERAL `../` before we
 * ever see the path, which is what made the original prefix test look sound —
 * but it leaves `%2e%2e%2f` exactly as written, so that test accepted
 * `…/tmp/blobs/%2e%2e%2f%2e%2e%2fblobs/sha256/<secret>` and would have handed a
 * native background PUT a destination outside the namespace the gateway
 * authorized. Whether the far side treats that as traversal depends on the S3
 * implementation, which is precisely why the app must not be the layer that
 * gambles on it.
 *
 * Every intermediate form is checked, not just the last, because we do not know
 * how many times the far side unescapes — and a path that is in scope when fully
 * decoded but escapes at some intermediate depth is exactly as dangerous.
 *
 * BOTH SEPARATORS. Segments split on `/` and `\`: `..%5c..%5c` decodes to
 * `..\..\`, which a `/`-only split never sees as a `..` segment at all. That was
 * a real hole in the first version of this fix, found by an audit rather than by
 * the tests that shipped with it.
 *
 * A THROWN DECODE IS NOT AUTOMATICALLY A REFUSAL, and the round it happens on is
 * what distinguishes the two cases. On round 0 the URL as minted carries a
 * malformed escape (`%zz`) and is refused. On a later round we have already
 * decoded successfully at least once, so the `%` we choked on came from a
 * legitimately encoded literal — a key containing `%` is minted as `%25`,
 * decodes once to `100%done`, and cannot decode again. Treating that as
 * malformed, as the first version of this fix did, rejects valid presigned
 * uploads and blames the wrong thing in the error.
 */
function pathInScope(pathname: string, prefix: string): boolean {
  let current = pathname;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    if (!current.startsWith(prefix)) return false;
    if (current.split(SEPARATORS).includes("..")) return false;
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return round > 0;
    }
    // Stable: the form just checked is the final one.
    if (next === current) return true;
    current = next;
  }
  // Never stabilised inside the bound. Refuse rather than guess.
  return false;
}

/**
 * Resolve the current provider allowlist from the trusted gateway, then pin a
 * native background PUT to that exact S3 temporary-object namespace.
 */
export async function assertGatewayMintedUploadUrl(
  candidate: string,
  scope: BackgroundTransferScope
): Promise<URL> {
  const fetchImpl = scope.fetchImpl ?? fetch;
  const settingsUrl = new URL(
    "/centraid/_vault/blob-store",
    scope.gatewayBaseUrl
  );
  const response = await fetchImpl(settingsUrl, {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`gateway transfer policy unavailable (${response.status})`);
  const payload = (await response.json()) as {
    blob_store?: {
      kind?: unknown;
      endpoint?: unknown;
      allowedUploadPrefix?: unknown;
    };
  };
  const store = payload.blob_store;
  if (
    store?.kind !== "s3" ||
    typeof store.endpoint !== "string" ||
    typeof store.allowedUploadPrefix !== "string"
  ) {
    throw new Error("gateway has no active S3 transfer allowlist");
  }
  const target = new URL(candidate);
  const endpoint = new URL(store.endpoint);
  if (target.origin !== endpoint.origin)
    throw new Error("upload origin is not the active provider");
  // `origin` deliberately omits userinfo, so an origin match says nothing about
  // credentials riding along. Accepting them would attach whatever an attacker
  // put in the URL to a request the user's device makes to the real provider.
  if (target.username !== "" || target.password !== "")
    throw new Error("upload URL carries embedded credentials");
  if (
    target.protocol !== "https:" &&
    !(
      target.protocol === "http:" &&
      (target.hostname === "127.0.0.1" || target.hostname === "localhost")
    )
  ) {
    throw new Error("upload transport is not HTTPS");
  }
  // Checked at every decoding depth, on both separators — see `pathInScope`.
  if (!pathInScope(target.pathname, store.allowedUploadPrefix))
    throw new Error("upload path is outside blob transfer scope");
  if (
    !hasQuery(target, "X-Amz-Signature") ||
    !hasQuery(target, "X-Amz-Expires")
  ) {
    throw new Error("upload URL is not a gateway-presigned capability");
  }
  return target;
}
