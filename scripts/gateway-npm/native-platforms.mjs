export const NATIVE_PLATFORMS = [
  {
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    required: true,
    runnerHint: "ubuntu-latest",
  },
  {
    id: "linux-arm64",
    platform: "linux",
    arch: "arm64",
    required: false,
    runnerHint: "ubuntu-24.04-arm",
  },
  {
    id: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    required: true,
    runnerHint: "macos-latest",
  },
  {
    id: "darwin-x64",
    platform: "darwin",
    arch: "x64",
    required: false,
    runnerHint: "macos-15-intel",
  },
  {
    id: "win32-x64",
    platform: "win32",
    arch: "x64",
    required: true,
    runnerHint: "windows-latest",
  },
  {
    id: "win32-arm64",
    platform: "win32",
    arch: "arm64",
    required: false,
    runnerHint: "windows-11-arm",
  },
];

export function nativeArtifactName(platform, arch) {
  return `centraid-tunnel-native.${platform}-${arch}.node`;
}

export function nativeArtifactNameForId(id) {
  const row = NATIVE_PLATFORMS.find((p) => p.id === id);
  if (!row) throw new Error(`Unknown native platform id: ${id}`);
  return nativeArtifactName(row.platform, row.arch);
}

export function requiredNativePlatformIds() {
  return NATIVE_PLATFORMS.filter((p) => p.required).map((p) => p.id);
}

export function auditNativeArtifacts(basenames, opts = {}) {
  const requireAll = opts.requireAll === true;
  const requiredIds = opts.requiredIds ?? requiredNativePlatformIds();
  const expected = new Set(
    (requireAll ? NATIVE_PLATFORMS.map((p) => p.id) : requiredIds).map((id) =>
      nativeArtifactNameForId(id)
    )
  );
  const presentSet = new Set(basenames.filter((n) => n.endsWith(".node")));
  const present = [...presentSet].sort();
  const missingRequired = [...expected]
    .filter((n) => !presentSet.has(n))
    .sort();
  const known = new Set(
    NATIVE_PLATFORMS.map((p) => nativeArtifactName(p.platform, p.arch))
  );
  const extra = present.filter((n) => !known.has(n)).sort();
  return { present, missingRequired, extra };
}

export function hostToPlatformId(host) {
  const platform =
    host.os === "Windows_NT" || host.os === "win32"
      ? "win32"
      : host.os === "Darwin" || host.os === "darwin"
        ? "darwin"
        : host.os === "Linux" || host.os === "linux"
          ? "linux"
          : null;
  if (!platform) return null;
  const arch =
    host.arch === "x86_64"
      ? "x64"
      : host.arch === "aarch64"
        ? "arm64"
        : host.arch;
  const id = `${platform}-${arch}`;
  return NATIVE_PLATFORMS.some((p) => p.id === id) ? id : null;
}
