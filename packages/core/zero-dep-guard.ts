export type PackageManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type ZeroDepVerdict = { ok: true } | { ok: false; reason: string };

function namedDeps(
  bag: Record<string, string> | undefined,
  label: string
): string[] {
  if (!bag) return [];
  return Object.keys(bag).map((name) => `${label}:${name}`);
}

export function assertZeroRuntimeDeps(
  manifest: PackageManifest
): ZeroDepVerdict {
  const found = [
    ...namedDeps(manifest.dependencies, "dependencies"),
    ...namedDeps(manifest.optionalDependencies, "optionalDependencies"),
    ...namedDeps(manifest.peerDependencies, "peerDependencies"),
  ];
  if (found.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `${manifest.name ?? "package"} must stay zero-runtime-dep; found ${found.join(", ")}`,
  };
}
