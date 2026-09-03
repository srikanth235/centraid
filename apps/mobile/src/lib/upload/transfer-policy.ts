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

const MAX_DECODE_ROUNDS = 10;

const SEPARATORS = /[/\\]/u;

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
    if (next === current) return true;
    current = next;
  }
  return false;
}

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
