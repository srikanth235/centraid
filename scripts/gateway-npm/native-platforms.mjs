/**
 * First-party tunnel NAPI platform matrix for gateway npm packs (#511).
 *
 * Artifact name matches native-relay.ts / build-native.mjs:
 *   centraid-tunnel-native.${process.platform}-${process.arch}.node
 */

/** @typedef {{ id: string; platform: string; arch: string; required: boolean; runnerHint: string }} NativePlatform */

/**
 * Platforms we build and ship in the gateway npm graph.
 * `required: true` must be present before publish when CENTRAID_REQUIRE_MULTI_NATIVE=1.
 *
 * @type {NativePlatform[]}
 */
export const NATIVE_PLATFORMS = [
  {
    id: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    required: true,
    runnerHint: 'ubuntu-latest',
  },
  {
    id: 'linux-arm64',
    platform: 'linux',
    arch: 'arm64',
    required: false,
    runnerHint: 'ubuntu-24.04-arm',
  },
  {
    id: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    required: true,
    runnerHint: 'macos-latest',
  },
  {
    id: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    required: false,
    runnerHint: 'macos-13',
  },
  {
    id: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    required: true,
    runnerHint: 'windows-latest',
  },
  {
    id: 'win32-arm64',
    platform: 'win32',
    arch: 'arm64',
    required: false,
    runnerHint: 'windows-11-arm',
  },
];

/**
 * @param {string} platform process.platform
 * @param {string} arch process.arch
 * @returns {string} Artifact basename (with .node)
 */
export function nativeArtifactName(platform, arch) {
  return `centraid-tunnel-native.${platform}-${arch}.node`;
}

/**
 * @param {string} id Platform id e.g. linux-x64
 * @returns {string} Artifact basename
 */
export function nativeArtifactNameForId(id) {
  const row = NATIVE_PLATFORMS.find((p) => p.id === id);
  if (!row) throw new Error(`Unknown native platform id: ${id}`);
  return nativeArtifactName(row.platform, row.arch);
}

/**
 * @returns {string[]} Required platform ids
 */
export function requiredNativePlatformIds() {
  return NATIVE_PLATFORMS.filter((p) => p.required).map((p) => p.id);
}

/**
 * Validate a directory of prebuilt `.node` files.
 * @param {string[]} basenames File basenames present under packages/tunnel/native/.
 * @param {{ requireAll?: boolean; requiredIds?: string[] }} [opts] Audit options (require all known platforms or a subset).
 * @returns {{ present: string[]; missingRequired: string[]; extra: string[] }} Present files, missing required names, and unexpected extras.
 */
export function auditNativeArtifacts(basenames, opts = {}) {
  const requireAll = opts.requireAll === true;
  const requiredIds = opts.requiredIds ?? requiredNativePlatformIds();
  const expected = new Set(
    (requireAll ? NATIVE_PLATFORMS.map((p) => p.id) : requiredIds).map((id) =>
      nativeArtifactNameForId(id),
    ),
  );
  const presentSet = new Set(basenames.filter((n) => n.endsWith('.node')));
  const present = [...presentSet].sort();
  const missingRequired = [...expected].filter((n) => !presentSet.has(n)).sort();
  const known = new Set(NATIVE_PLATFORMS.map((p) => nativeArtifactName(p.platform, p.arch)));
  const extra = present.filter((n) => !known.has(n)).sort();
  return { present, missingRequired, extra };
}

/**
 * Map a GitHub Actions matrix runner label to platform id when the host matches.
 * Used by CI scripts; pure for unit tests.
 * @param {{ os: string; arch: string }} host e.g. { os: 'Linux', arch: 'x64' } from process
 * @returns {string | null} Platform id or null if unsupported host
 */
export function hostToPlatformId(host) {
  const platform =
    host.os === 'Windows_NT' || host.os === 'win32'
      ? 'win32'
      : host.os === 'Darwin' || host.os === 'darwin'
        ? 'darwin'
        : host.os === 'Linux' || host.os === 'linux'
          ? 'linux'
          : null;
  if (!platform) return null;
  const arch = host.arch === 'x86_64' ? 'x64' : host.arch === 'aarch64' ? 'arm64' : host.arch;
  const id = `${platform}-${arch}`;
  return NATIVE_PLATFORMS.some((p) => p.id === id) ? id : null;
}
