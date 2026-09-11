/**
 * Pure helpers for gateway npm pack / install target resolution (issue #509).
 * No network, no filesystem side effects — unit-tested entry points for install + pack.
 */

/**
 * Rewrite workspace:* (and catalog: ignored) deps to concrete semver versions.
 * @param {Record<string, unknown>} packageJson Parsed package.json object.
 * @param {Record<string, string>} versionByName Map of package name → version (e.g. "@centraid/core/protocol" → "0.1.0").
 * @returns {{ packageJson: Record<string, unknown>; rewrote: string[] }} Cloned package.json ready for registry pack.
 */
export function rewriteWorkspaceDependencies(
  packageJson: Record<string, unknown>,
  versionByName: Record<string, string>
): { packageJson: Record<string, unknown>; rewrote: string[] } {
  const out = structuredClone(packageJson);
  /** @type {string[]} */
  const rewrote = [];
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const block = out[field];
    if (!block || typeof block !== "object") continue;
    for (const [name, range] of Object.entries(
      block as Record<string, string>
    )) {
      if (typeof range !== "string") continue;
      if (!range.startsWith("workspace:")) continue;
      const ver = versionByName[name];
      if (!ver) {
        throw new Error(
          `No published version for workspace dep ${name} (while packing ${out.name})`
        );
      }
      (block as Record<string, string>)[name] = ver;
      rewrote.push(`${field}:${name}`);
    }
  }
  // Registry consumers never need monorepo-only workspace/catalog devDeps.
  delete out.devDependencies;
  // Pack already copies built `files`; lifecycle scripts that re-build in the
  // staging tree break pack (tsc not on PATH). Consumers install prebuilt dist.
  if (out.scripts && typeof out.scripts === "object") {
    const scripts = out.scripts as Record<string, string>;
    for (const key of ["prepack", "prepare", "prepublishOnly", "prepublish"]) {
      delete scripts[key];
    }
  }
  out.private = false;
  if (!out.publishConfig || typeof out.publishConfig !== "object") {
    out.publishConfig = { access: "public" };
  } else {
    (out.publishConfig as Record<string, unknown>).access = "public";
  }
  return { packageJson: out, rewrote };
}

/**
 * @param {string[]} packageDirs Ordered package directory basenames under packages/.
 * @param {(dir: string) => { name: string; version: string; dependencies?: Record<string, string> }} loadPkg Loader for each package dir name/version/deps.
 * @returns {string[]} Package dirs in dependency order (deps first).
 */
export function topologicalPublishOrder(
  packageDirs: string[],
  loadPkg: (dir: string) => {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  }
): string[] {
  const dirs = [...packageDirs];
  const byName = new Map();
  for (const dir of dirs) {
    const p = loadPkg(dir);
    byName.set(p.name, dir);
  }
  /** @type {Map<string, Set<string>>} */
  const deps = new Map();
  for (const dir of dirs) {
    const p = loadPkg(dir);
    const need = new Set();
    for (const [depName, range] of Object.entries(p.dependencies || {})) {
      if (!byName.has(depName)) continue;
      if (
        typeof range === "string" &&
        (range.startsWith("workspace:") || byName.has(depName))
      ) {
        need.add(byName.get(depName) as string);
      }
    }
    deps.set(dir, need);
  }
  /** @type {string[]} */
  const ordered = [];
  const remaining = new Set(dirs);
  while (remaining.size) {
    let progressed = false;
    const remainingList = Array.from(remaining);
    for (const dir of remainingList) {
      const need = deps.get(dir) ?? new Set();
      let ok = true;
      for (const d of need) {
        if (remaining.has(d)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      ordered.push(dir);
      remaining.delete(dir);
      progressed = true;
    }
    if (!progressed) {
      throw new Error(
        `Cycle or missing dep in publish set: ${[...remaining].join(", ")}`
      );
    }
  }
  return ordered;
}

/**
 * Parse install-gateway CLI argv (flags only; no process mutation).
 * @param {string[]} argv Process argv slice after node/script (or bash-forwarded args).
 * @returns {{
 *   help: boolean;
 *   dryRun: boolean;
 *   prefix: string | null;
 *   version: string;
 *   fromPackDir: string | null;
 *   withService: boolean;
 *   global: boolean;
 * }} Parsed install flags.
 */
export interface InstallArgs {
  help: boolean;
  dryRun: boolean;
  prefix: string | null;
  version: string;
  fromPackDir: string | null;
  withService: boolean;
  global: boolean;
}

export function parseInstallArgs(argv: string[]): InstallArgs {
  /** @type {ReturnType<typeof parseInstallArgs>} */
  const out: InstallArgs = {
    help: false,
    dryRun: false,
    prefix: null,
    version: "latest",
    fromPackDir: null,
    withService: false,
    global: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--with-service") out.withService = true;
    else if (a === "--global") out.global = true;
    else if (a === "--no-global") out.global = false;
    else if (a === "--prefix") {
      const v = argv[++i];
      if (!v || v.startsWith("--"))
        throw new Error("Missing value for --prefix");
      out.prefix = v;
      out.global = false;
    } else if (a === "--version") {
      const v = argv[++i];
      if (!v || v.startsWith("--"))
        throw new Error("Missing value for --version");
      out.version = v;
    } else if (a === "--from-pack-dir") {
      const v = argv[++i];
      if (!v || v.startsWith("--"))
        throw new Error("Missing value for --from-pack-dir");
      out.fromPackDir = v;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      throw new Error(`Unexpected argument: ${a}`);
    }
  }
  return out;
}

/**
 * Resolve default install prefix (OpenClaw-like local prefix).
 * @param {string} home HOME directory.
 * @returns {string} Default install prefix path.
 */
export function defaultInstallPrefix(home: string): string {
  return `${home.replace(/\/$/u, "")}/.centraid`;
}

/**
 * Build the npm install argument list for gateway.
 * @param {{
 *   version: string;
 *   fromPackDir: string | null;
 *   packFiles?: string[];
 *   gatewayPackage?: string;
 * }} opts Install target options (registry version or local pack paths).
 * @returns {string[]} Args after `npm install` (excluding npm itself and --prefix/-g).
 */
export function buildNpmInstallArgs(opts: {
  version: string;
  fromPackDir: string | null;
  packFiles?: string[];
  gatewayPackage?: string;
}): string[] {
  const gatewayPackage = opts.gatewayPackage ?? "@centraid/server";
  if (opts.fromPackDir) {
    const files = opts.packFiles ?? [];
    if (files.length === 0) {
      throw new Error(`No pack tarballs found under ${opts.fromPackDir}`);
    }
    return [...files];
  }
  return [`${gatewayPackage}@${opts.version}`];
}

/**
 * Human next-steps after install (never claims silent service install).
 * @param {{ bin: string; prefix: string | null; withService: boolean }} opts Binary name, optional prefix, service hint flag.
 * @returns {string} User-facing next-steps text.
 */
export function formatPostInstallMessage(opts: {
  bin: string;
  prefix: string | null;
  withService: boolean;
}): string {
  const lines = [
    `Installed ${opts.bin}.`,
    "",
    "Start the gateway (example):",
    `  ${opts.bin} serve --data-dir ~/.local/share/centraid/gateway --host 127.0.0.1 --port 8787`,
    "",
    "Print the admin token:",
    `  ${opts.bin} print-token --data-dir ~/.local/share/centraid/gateway`,
    "",
  ];
  if (opts.withService) {
    lines.push(
      "OS service (opt-in; H5 — never silent):",
      `  ${opts.bin} service install --data-dir ~/.local/share/centraid/gateway`,
      ""
    );
  } else {
    lines.push(
      "Optional OS service (default off):",
      `  ${opts.bin} service install --data-dir ~/.local/share/centraid/gateway`,
      ""
    );
  }
  if (opts.prefix) {
    lines.push(`Binary prefix: ${opts.prefix}/bin — add to PATH if needed.`);
  }
  return lines.join("\n");
}

/**
 * Minimum Node major from engines field like ">=22.5".
 * @param {string | undefined} enginesNode engines.node field value.
 * @returns {number} Minimum major version number.
 */
export function minNodeMajorFromEngines(
  enginesNode: string | undefined
): number {
  if (!enginesNode) return 22;
  const major = enginesNode.match(/(?<major>\d+)/u)?.groups?.major;
  return major ? Number(major) : 22;
}

/**
 * @param {string} nodeVersion e.g. "v22.23.1".
 * @param {number} minMajor Required major version.
 * @returns {boolean} True when nodeVersion major is >= minMajor.
 */
export function nodeVersionSatisfies(
  nodeVersion: string,
  minMajor: number
): boolean {
  const major = nodeVersion.replace(/^v/u, "").match(/^(?<major>\d+)/u)
    ?.groups?.major;
  if (!major) return false;
  return Number(major) >= minMajor;
}
