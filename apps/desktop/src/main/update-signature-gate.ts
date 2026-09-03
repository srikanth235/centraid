/* Fetch half of updater signature custody (#842); the decision is in
 * update-signature-core.ts. */
import {
  describeUpdateVerdict,
  resolveUpdateTrust,
} from "./update-signature-core.js";
import type {
  ReleaseArtifact,
  TrustedReleaseKey,
  UpdateTrustVerdict,
} from "./update-signature-core.js";

/**
 * BLOCKED-EXTERNAL (#842): empty while the desktop lane ships unsigned
 * scaffolding, so every packaged update refuses with `no-trust-anchor`.
 */
export const TRUSTED_RELEASE_KEYS: readonly TrustedReleaseKey[] = [];

export const RELEASE_MANIFEST_FILE = "centraid-release-manifest.json";
export const RELEASE_SIGNATURE_FILE = "centraid-release-manifest.sig.json";

/** A constant so a compromised feed cannot redirect it. */
export const RELEASE_ASSET_BASE =
  "https://github.com/srikanth235/centraid/releases/download";

export const MAX_MANIFEST_BYTES = 512 * 1024;

export type FetchText = (
  url: string
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export function releaseAssetUrl(
  version: string,
  file: string,
  base = RELEASE_ASSET_BASE
): string {
  return `${base}/v${encodeURIComponent(version)}/${encodeURIComponent(file)}`;
}

async function fetchAsset(
  fetchText: FetchText,
  url: string
): Promise<string | null> {
  let response: Awaited<ReturnType<FetchText>>;
  try {
    response = await fetchText(url);
  } catch {
    // Transport failure is a refusal, never a throw.
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

export async function fetchUpdateTrust(
  input: UpdateTrustFetchInput
): Promise<UpdateTrustVerdict> {
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
    fetchAsset(
      input.fetchText,
      releaseAssetUrl(input.version, RELEASE_MANIFEST_FILE, input.assetBase)
    ),
    fetchAsset(
      input.fetchText,
      releaseAssetUrl(input.version, RELEASE_SIGNATURE_FILE, input.assetBase)
    ),
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

export async function admitDownloadedUpdate(
  input: UpdateTrustFetchInput
): Promise<boolean> {
  const verdict = await fetchUpdateTrust(input);
  const line = describeUpdateVerdict(verdict, input.version);
  if (verdict.trusted) console.info(`[updater] ${line}`);
  else console.error(`[updater] ${line}`);
  return verdict.trusted;
}

export function artifactFromUpdateInfo(info: unknown): ReleaseArtifact | null {
  if (typeof info !== "object" || info === null) return null;
  const files = (info as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const first = files[0] as { url?: unknown; sha512?: unknown };
  if (typeof first.url !== "string" || typeof first.sha512 !== "string")
    return null;
  // Bare filename: a mirror prefix must not change matching.
  const name = first.url.split("/").pop() ?? first.url;
  return { name, sha512: first.sha512 };
}
