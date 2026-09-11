#!/usr/bin/env node
/**
 * W6.2 — supply-chain artifact CLI (umbrella #842).
 *
 * Subcommands:
 *   sbom               write a deterministic CycloneDX 1.6 BOM of bun.lock
 *   verify-sbom        re-check a BOM against the lockfile as it is now
 *   provenance         write an in-toto/SLSA v1 statement over real artifacts
 *   manifest           write (and, when enrolled, sign) the release manifest
 *                      the desktop updater verifies
 *   verify             the release gate: BOM + provenance + signature together
 *
 * Every timestamp is derived from the commit, never from the wall clock, so two
 * runs of the same commit produce byte-identical documents.
 *
 * Exit codes: 0 pass (or a LOUDLY-cited guarded skip), 1 fail.
 */

import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  buildProvenance,
  buildReleaseManifest,
  buildSbom,
  parseBunLock,
  RELEASE_METADATA_FILES,
  sha256Hex,
  sha512Base64,
  signDocument,
  verifyDocument,
  verifyProvenance,
  verifySbom,
} from "./supply-chain-core.ts";

const root = path.resolve(import.meta.dirname, "../..");

/** Parse `--flag value` pairs. Unknown flags are an error, not a silent ignore. */
function parseArgs(
  argv: string[],
  allowed: string[]
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--"))
      fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.includes(key))
      fail(`unknown flag --${key} (expected one of ${allowed.join(", ")})`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function flagString(
  options: Record<string, string | boolean>,
  key: string
): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function fail(message: string): never {
  console.error(`supply-chain: ${message}`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A guarded skip: exits 0, but says exactly what is missing and what would
 * unblock it. Never used for a state where the input WAS available.
 */
function skip(what: string, unblock: string): never {
  console.warn(`supply-chain: SKIPPED — ${what}`);
  console.warn(`supply-chain: unblock by ${unblock}`);
  process.exit(0);
}

/** Commit time as ISO-8601. The one source of "now" this tool accepts. */
function commitTimestamp(explicit: unknown) {
  if (typeof explicit === "string") return explicit;
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined && epoch !== "" && Number.isFinite(Number(epoch)))
    return new Date(Number(epoch) * 1000).toISOString();
  const git = spawnSync("git", ["log", "-1", "--format=%cI"], {
    cwd: root,
    encoding: "utf8",
  });
  const value = git.status === 0 ? git.stdout.trim() : "";
  if (value === "")
    fail(
      "no timestamp: pass --timestamp, set SOURCE_DATE_EPOCH, or run inside a git checkout"
    );
  return new Date(value).toISOString();
}

function commitSha() {
  const env = process.env.GITHUB_SHA;
  if (env !== undefined && env !== "") return env;
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return git.status === 0 ? git.stdout.trim() : "unknown";
}

function lockfilePackages() {
  const lockfile = path.join(root, "bun.lock");
  if (!existsSync(lockfile)) fail("bun.lock not found");
  const { packages, errors } = parseBunLock(readFileSync(lockfile, "utf8"));
  for (const error of errors) fail(error);
  return packages;
}

/** Every shippable regular file in a directory, sorted, with its real digests. */
function artifactDigests(dir: string) {
  if (!existsSync(dir)) fail(`artifact directory not found: ${dir}`);
  const names = readdirSync(dir)
    .filter((name) => !RELEASE_METADATA_FILES.has(name))
    .filter((name) => statSync(path.join(dir, name)).isFile())
    .sort();
  if (names.length === 0) fail(`artifact directory is empty: ${dir}`);
  return names.map((name) => {
    const bytes = readFileSync(path.join(dir, name));
    return { name, sha256: sha256Hex(bytes), sha512: sha512Base64(bytes) };
  });
}

function writeJson(target: string, document: unknown) {
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  console.info(`supply-chain: wrote ${path.relative(root, target)}`);
}

/** Load the release signing key from the environment (base64 raw 32-byte seed). */
function signingKey() {
  const seed = process.env.CENTRAID_RELEASE_SIGNING_KEY;
  if (seed === undefined || seed === "") return null;
  const raw = Buffer.from(seed, "base64");
  if (raw.byteLength !== 32)
    fail(
      "CENTRAID_RELEASE_SIGNING_KEY is set but is not 32 base64-decoded bytes — refusing to guess"
    );
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      raw,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(12)
    .toString("base64");
  return { privateKey, publicKey };
}

const COMMANDS = {
  sbom(args: string[]) {
    const options = parseArgs(args, ["out", "timestamp"]);
    const pkg: unknown = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8")
    );
    if (
      !isRecord(pkg) ||
      typeof pkg.name !== "string" ||
      typeof pkg.version !== "string"
    ) {
      fail("root package.json is missing name/version");
    }
    const bom = buildSbom({
      packages: lockfilePackages(),
      component: { name: pkg.name, version: pkg.version },
      timestamp: commitTimestamp(flagString(options, "timestamp")),
    });
    const out = flagString(options, "out") ?? "artifacts/sbom.cdx.json";
    writeJson(path.resolve(root, out), bom);
    const components = Array.isArray(bom.components) ? bom.components : [];
    console.info(
      `supply-chain: ${components.length} components, serial ${String(bom.serialNumber)}`
    );
  },

  "verify-sbom"(args: string[]) {
    const options = parseArgs(args, ["sbom"]);
    const target = path.resolve(
      root,
      flagString(options, "sbom") ?? "artifacts/sbom.cdx.json"
    );
    if (!existsSync(target))
      fail(`no BOM at ${target} — run \`supply-chain.mjs sbom\` first`);
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (!isRecord(parsed)) fail(`BOM at ${target} is not an object`);
    const result = verifySbom(parsed, lockfilePackages());
    for (const id of result.missing.slice(0, 10))
      console.error(`  missing from BOM: ${id}`);
    for (const id of result.extra.slice(0, 10))
      console.error(`  stale in BOM: ${id}`);
    if (!result.ok) fail(result.errors.join("; "));
    console.info("supply-chain: BOM matches the lockfile");
  },

  provenance(args: string[]) {
    const options = parseArgs(args, [
      "artifacts",
      "out",
      "builder",
      "timestamp",
    ]);
    const artifacts = flagString(options, "artifacts");
    if (artifacts === undefined) fail("provenance needs --artifacts <dir>");
    const subjects = artifactDigests(path.resolve(root, artifacts));
    const statement = buildProvenance({
      subjects,
      builderId: flagString(options, "builder") ?? defaultBuilderId(),
      buildType: "https://github.com/srikanth235/centraid/build/desktop@v1",
      sourceUri: "https://github.com/srikanth235/centraid",
      sourceDigest: commitSha(),
      startedOn: commitTimestamp(flagString(options, "timestamp")),
    });
    writeJson(
      path.resolve(
        root,
        flagString(options, "out") ?? "artifacts/provenance.intoto.json"
      ),
      statement
    );
  },

  "verify-provenance"(args: string[]) {
    const options = parseArgs(args, ["statement", "artifacts", "builder"]);
    const artifacts = flagString(options, "artifacts");
    if (artifacts === undefined)
      fail("verify-provenance needs --artifacts <dir>");
    const target = path.resolve(
      root,
      flagString(options, "statement") ?? "artifacts/provenance.intoto.json"
    );
    if (!existsSync(target)) fail(`no provenance statement at ${target}`);
    const actual = Object.fromEntries(
      artifactDigests(path.resolve(root, artifacts)).map((a) => [
        a.name,
        a.sha256,
      ])
    );
    const builder = flagString(options, "builder");
    const expected = builder === undefined ? {} : { builderId: builder };
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (!isRecord(parsed))
      fail(`provenance statement at ${target} is not an object`);
    const result = verifyProvenance(parsed, actual, expected);
    for (const reason of result.reasons) console.error(`  ${reason}`);
    if (!result.ok)
      fail(
        `provenance does not describe these artifacts (${result.reasons.length} problem(s))`
      );
    console.info(
      `supply-chain: provenance covers ${Object.keys(actual).length} artifact(s)`
    );
  },

  manifest(args: string[]) {
    const options = parseArgs(args, ["artifacts", "version", "out"]);
    const artifacts = flagString(options, "artifacts");
    if (artifacts === undefined) fail("manifest needs --artifacts <dir>");
    const version = flagString(options, "version");
    if (version === undefined) fail("manifest needs --version <x.y.z>");
    const outDir = path.resolve(
      root,
      flagString(options, "out") ?? path.resolve(root, artifacts)
    );
    const manifest = buildReleaseManifest(
      version,
      artifactDigests(path.resolve(root, artifacts))
    );
    writeJson(path.join(outDir, "centraid-release-manifest.json"), manifest);
    const key = signingKey();
    if (key === null)
      skip(
        "CENTRAID_RELEASE_SIGNING_KEY is not set, so the manifest is UNSIGNED and the shipped updater will refuse it (no-trust-anchor)",
        "generating an Ed25519 release key, storing its raw seed as the CENTRAID_RELEASE_SIGNING_KEY secret in the `release` environment, and enrolling the public half in TRUSTED_RELEASE_KEYS (apps/desktop/src/main/update-signature-gate.ts)"
      );
    const envelope = signDocument(manifest, key.privateKey, key.publicKey);
    const check = verifyDocument(manifest, envelope, key.publicKey);
    // Sign-then-verify with the same material: a signer that emits bytes nobody
    // ever checked is how an unverifiable release ships looking green.
    if (!check.ok)
      fail(
        `self-verification of the freshly signed manifest failed: ${check.reason}`
      );
    writeJson(
      path.join(outDir, "centraid-release-manifest.sig.json"),
      envelope
    );
    console.info(`supply-chain: signed with keyId ${envelope.keyId}`);
  },

  verify(args: string[]) {
    const options = parseArgs(args, [
      "artifacts",
      "version",
      "sbom",
      "statement",
      "public-key",
    ]);
    const artifacts = flagString(options, "artifacts");
    if (artifacts === undefined) fail("verify needs --artifacts <dir>");
    const dir = path.resolve(root, artifacts);
    const sbom = flagString(options, "sbom");
    COMMANDS["verify-sbom"](sbom === undefined ? [] : ["--sbom", sbom]);
    const statement = flagString(options, "statement");
    COMMANDS["verify-provenance"](
      statement === undefined
        ? ["--artifacts", artifacts]
        : ["--artifacts", artifacts, "--statement", statement]
    );
    const manifestPath = path.join(dir, "centraid-release-manifest.json");
    const signaturePath = path.join(dir, "centraid-release-manifest.sig.json");
    const publicKey =
      flagString(options, "public-key") ??
      process.env.CENTRAID_RELEASE_PUBLIC_KEY;
    if (typeof publicKey !== "string" || publicKey === "") {
      if (existsSync(signaturePath))
        // The signature IS here; refusing to check it would be the vacuous pass
        // this gate exists to prevent.
        fail(
          "a signed manifest is present but no public key was supplied — pass --public-key or set CENTRAID_RELEASE_PUBLIC_KEY"
        );
      skip(
        "no release public key is enrolled and the artifacts carry no manifest signature",
        "enrolling a release key (see `manifest`'s unblock note) so this lane checks a real signature"
      );
    }
    if (!existsSync(manifestPath) || !existsSync(signaturePath))
      fail(
        "a release public key is enrolled but the artifacts carry no signed manifest — the signing step did not run"
      );
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    const envelope: unknown = JSON.parse(readFileSync(signaturePath, "utf8"));
    const result = verifyDocument(manifest, envelope, publicKey);
    if (!result.ok) fail(`release manifest signature: ${result.reason}`);
    // A validly-signed manifest for the WRONG version is exactly the replay the
    // updater refuses at install time; catch it here rather than shipping it.
    const wantedVersion = flagString(options, "version");
    const manifestVersion =
      isRecord(manifest) && typeof manifest.version === "string"
        ? manifest.version
        : undefined;
    if (wantedVersion !== undefined && manifestVersion !== wantedVersion)
      fail(
        `release manifest is signed but vouches for ${String(manifestVersion)}, not ${wantedVersion}`
      );
    console.info("supply-chain: release manifest signature verified");
  },
};

/** GitHub's SLSA-recommended builder id, or a local marker outside Actions. */
function defaultBuilderId() {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const workflow = process.env.GITHUB_WORKFLOW_REF;
  if (server && repo && workflow) return `${server}/${workflow}`;
  return "local://unattested-developer-build";
}

const [command, ...rest] = process.argv.slice(2);
const handler =
  command !== undefined && Object.hasOwn(COMMANDS, command)
    ? COMMANDS[command as keyof typeof COMMANDS]
    : undefined;
if (handler === undefined) {
  console.error(
    `usage: supply-chain.mjs <${Object.keys(COMMANDS).join("|")}> [flags]`
  );
  process.exit(1);
}
handler(rest);
