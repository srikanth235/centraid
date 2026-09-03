export function rewriteWorkspaceDependencies(packageJson, versionByName) {
  const out = structuredClone(packageJson);
  const rewrote = [];
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const block = out[field];
    if (!block || typeof block !== "object") continue;
    for (const [name, range] of Object.entries(block)) {
      if (typeof range !== "string") continue;
      if (!range.startsWith("workspace:")) continue;
      const ver = versionByName[name];
      if (!ver) {
        throw new Error(
          `No published version for workspace dep ${name} (while packing ${out.name})`
        );
      }
      block[name] = ver;
      rewrote.push(`${field}:${name}`);
    }
  }
  delete out.devDependencies;
  if (out.scripts && typeof out.scripts === "object") {
    const scripts = /** @type {Record<string, string>} */ (out.scripts);
    for (const key of ["prepack", "prepare", "prepublishOnly", "prepublish"]) {
      delete scripts[key];
    }
  }
  out.private = false;
  if (!out.publishConfig || typeof out.publishConfig !== "object") {
    out.publishConfig = { access: "public" };
  } else {
    out.publishConfig.access = "public";
  }
  return { packageJson: out, rewrote };
}

export function topologicalPublishOrder(packageDirs, loadPkg) {
  const dirs = [...packageDirs];
  const byName = new Map();
  for (const dir of dirs) {
    const p = loadPkg(dir);
    byName.set(p.name, dir);
  }
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
        need.add(/** @type {string} */ (byName.get(depName)));
      }
    }
    deps.set(dir, need);
  }
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

export function parseInstallArgs(argv) {
  const out = {
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

export function defaultInstallPrefix(home) {
  return `${home.replace(/\/$/u, "")}/.centraid`;
}

export function buildNpmInstallArgs(opts) {
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

export function formatPostInstallMessage(opts) {
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

export function minNodeMajorFromEngines(enginesNode) {
  if (!enginesNode) return 22;
  const major = enginesNode.match(/(?<major>\d+)/u)?.groups?.major;
  return major ? Number(major) : 22;
}

export function nodeVersionSatisfies(nodeVersion, minMajor) {
  const major = nodeVersion.replace(/^v/u, "").match(/^(?<major>\d+)/u)
    ?.groups?.major;
  if (!major) return false;
  return Number(major) >= minMajor;
}
