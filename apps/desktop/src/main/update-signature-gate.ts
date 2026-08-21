/*
 * W6.1 — the fetch half of updater signature custody (umbrella #842).
 *
 * `update-signature-core.ts` decides; this module gets the manifest and the
 * detached signature in front of that decision, and owns the two operational
 * facts the pure core must not know: where release assets live, and which
 * release keys this build trusts.
 *
 * Network access is injected (`fetchText`) so every path here is unit-testable
 * without a socket; the production injection is `globalThis.fetch`.
 */

import {
  describeUpdateVerdict,
  resolveUpdateTrust,
  type ReleaseArtifact,
  type TrustedReleaseKey,
  type UpdateTrustVerdict,
} from "./update-signature-core.js";

/**
 * Release keys this build will accept an update from.
 *
 * BLOCKED-EXTERNAL (#842 W6.1): empty until a release signing key is generated
 * and its public half enrolled here in a reviewed commit. While it is empty
 * `resolveUpdateTrust` refuses every packaged update with `no-trust-anchor` —
 * which is the correct posture, not a gap: today's desktop lane ships
 * *unsigned scaffolding* (see `.github/workflows/lane-release-desktop.yml`,
 * which attaches installers to a GitHub Release only once a signing group is
 * enrolled), so there is no release an installer could legitimately trust.
 *
 * Unblock condition: generate an Ed25519 release key, store the private half in
 * the release environment as `CENTRAID_RELEASE_SIGNING_KEY`, and add its
 * `{ keyId, publicKey }` here. `keyIdFor()` in the core derives the id.
 */
export const TRUSTED_RELEASE_KEYS: readonly TrustedReleaseKey[] = [];

/** Asset names the release publishes alongside the installers. */
export const RELEASE_MANIFEST_FILE = "centraid-release-manifest.json";
export const RELEASE_SIGNATURE_FILE = "centraid-release-manifest.sig.json";

/** Default asset base. Kept a constant so a compromised feed cannot redirect it. */
export const RELEASE_ASSET_BASE = "https://github.com/srikanth235/centraid/releases/download";

/**
 * A manifest is a few KB. Anything larger is a resource-exhaustion attempt or a
 * wrong URL; either way it is not our manifest, so stop reading.
 */
export const MAX_MANIFEST_BYTES = 512 * 1024;

export type FetchText = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Where a given release asset lives for a version tag. */
export function releaseAssetUrl(version: string, file: string, base = RELEASE_ASSET_BASE): string {
  return `${base}/v${encodeURIComponent(version)}/${encodeURIComponent(file)}`;
}

/**
 * Fetch one asset as text, or null when it is absent, errored, or oversized.
 * Null is a *refusal input*, never a pass — the core turns it into
 * `missing-manifest` / `missing-signature`.
 */
async function fetchAsset(fetchText: FetchText, url: string): Promise<string | null> {
  let response: Awaited<ReturnType<FetchText>>;
  try {
    response = await fetchText(url);
  } catch {
    // Boundary: the release host is outside our trust and outside our control.
    // Any transport failure is "we could not establish trust", which is a
    // refusal, so there is nothing to rethrow into the updater event handler.
    return null;
  }
  if (!response.ok) return null;
  const text = await response.text();
  if (text.length > MAX_MANIFEST_BYTES) return null;
  return text;
}

export interface UpdateTrustFetchInput {
  packaged: boolean;
  version: string;
  artifact: ReleaseArtifact | null;
  fetchText: FetchText;
  trustedKeys?: readonly TrustedReleaseKey[];
  assetBase?: string;
}

/**
 * Gather the manifest + signature for `version` and return the trust verdict.
 *
 * Short-circuits before any network call when the answer cannot depend on it:
 * an unpackaged build is not fed by the release host at all, and a build with
 * no trust anchor would refuse whatever it downloaded.
 */
export async function fetchUpdateTrust(input: UpdateTrustFetchInput): Promise<UpdateTrustVerdict> {
  const trustedKeys = input.trustedKeys ?? TRUSTED_RELEASE_KEYS;
  if (!input.packaged || trustedKeys.length === 0)
    return resolveUpdateTrust({
      packaged: input.packaged,
      trustedKeys,
      version: input.version,
      artifact: input.artifact,
      manifestText: null,
      signatureText: null,
    });

  const [manifestText, signatureText] = await Promise.all([
    fetchAsset(input.fetchText, releaseAssetUrl(input.version, RELEASE_MANIFEST_FILE, input.assetBase)),
    fetchAsset(input.fetchText, releaseAssetUrl(input.version, RELEASE_SIGNATURE_FILE, input.assetBase)),
  ]);

  return resolveUpdateTrust({
    packaged: input.packaged,
    trustedKeys,
    version: input.version,
    artifact: input.artifact,
    manifestText,
    signatureText,
  });
}

/**
 * The updater's install gate. Returns true only for a positively-verified
 * update; logs the reason either way so a refusal is visible in the main-process
 * log (docs/logs.md) rather than looking like "the update never arrived".
 */
export async function admitDownloadedUpdate(input: UpdateTrustFetchInput): Promise<boolean> {
  const verdict = await fetchUpdateTrust(input);
  const line = describeUpdateVerdict(verdict, input.version);
  if (verdict.trusted) console.info(`[updater] ${line}`);
  else console.error(`[updater] ${line}`);
  return verdict.trusted;
}

/**
 * Pull the artifact name + digest out of electron-updater's `UpdateInfo`.
 * Returns null when the feed omitted them, which the core refuses on.
 */
export function artifactFromUpdateInfo(info: unknown): ReleaseArtifact | null {
  if (typeof info !== "object" || info === null) return null;
  const files = (info as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const first = files[0] as { url?: unknown; sha512?: unknown };
  if (typeof first.url !== "string" || typeof first.sha512 !== "string") return null;
  // The feed's `url` is a path relative to the release; the manifest keys on
  // the bare filename so a mirror prefix cannot change what matches.
  const name = first.url.split("/").pop() ?? first.url;
  return { name, sha512: first.sha512 };
}
