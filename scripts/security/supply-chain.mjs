#!/usr/bin/env node

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
} from "./supply-chain-core.mjs";

const root = path.resolve(import.meta.dirname, "../..");

function parseArgs(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
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

function fail(message) {
  console.error(`supply-chain: ${message}`);
  process.exit(1);
}

function skip(what, unblock) {
  console.warn(`supply-chain: SKIPPED — ${what}`);
  console.warn(`supply-chain: unblock by ${unblock}`);
  process.exit(0);
}

function commitTimestamp(explicit) {
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

function artifactDigests(dir) {
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

function writeJson(target, document) {
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
  console.info(`supply-chain: wrote ${path.relative(root, target)}`);
}

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
  sbom(args) {
    const options = parseArgs(args, ["out", "timestamp"]);
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8")
    );
    const bom = buildSbom({
      packages: lockfilePackages(),
      component: { name: pkg.name, version: pkg.version },
      timestamp: commitTimestamp(options.timestamp),
    });
    writeJson(
      path.resolve(root, options.out ?? "artifacts/sbom.cdx.json"),
      bom
    );
    console.info(
      `supply-chain: ${bom.components.length} components, serial ${bom.serialNumber}`
    );
  },

  "verify-sbom"(args) {
    const options = parseArgs(args, ["sbom"]);
    const target = path.resolve(
      root,
      options.sbom ?? "artifacts/sbom.cdx.json"
    );
    if (!existsSync(target))
      fail(`no BOM at ${target} — run \`supply-chain.mjs sbom\` first`);
    const result = verifySbom(
      JSON.parse(readFileSync(target, "utf8")),
      lockfilePackages()
    );
    for (const id of result.missing.slice(0, 10))
      console.error(`  missing from BOM: ${id}`);
    for (const id of result.extra.slice(0, 10))
      console.error(`  stale in BOM: ${id}`);
    if (!result.ok) fail(result.errors.join("; "));
    console.info("supply-chain: BOM matches the lockfile");
  },

  provenance(args) {
    const options = parseArgs(args, [
      "artifacts",
      "out",
      "builder",
      "timestamp",
    ]);
    if (options.artifacts === undefined)
      fail("provenance needs --artifacts <dir>");
    const subjects = artifactDigests(path.resolve(root, options.artifacts));
    const statement = buildProvenance({
      subjects,
      builderId: options.builder ?? defaultBuilderId(),
      buildType: "https://github.com/srikanth235/centraid/build/desktop@v1",
      sourceUri: "https://github.com/srikanth235/centraid",
      sourceDigest: commitSha(),
      startedOn: commitTimestamp(options.timestamp),
    });
    writeJson(
      path.resolve(root, options.out ?? "artifacts/provenance.intoto.json"),
      statement
    );
  },

  "verify-provenance"(args) {
    const options = parseArgs(args, ["statement", "artifacts", "builder"]);
    if (options.artifacts === undefined)
      fail("verify-provenance needs --artifacts <dir>");
    const target = path.resolve(
      root,
      options.statement ?? "artifacts/provenance.intoto.json"
    );
    if (!existsSync(target)) fail(`no provenance statement at ${target}`);
    const actual = Object.fromEntries(
      artifactDigests(path.resolve(root, options.artifacts)).map((a) => [
        a.name,
        a.sha256,
      ])
    );
    const expected =
      options.builder === undefined ? {} : { builderId: options.builder };
    const result = verifyProvenance(
      JSON.parse(readFileSync(target, "utf8")),
      actual,
      expected
    );
    for (const reason of result.reasons) console.error(`  ${reason}`);
    if (!result.ok)
      fail(
        `provenance does not describe these artifacts (${result.reasons.length} problem(s))`
      );
    console.info(
      `supply-chain: provenance covers ${Object.keys(actual).length} artifact(s)`
    );
  },

  manifest(args) {
    const options = parseArgs(args, ["artifacts", "version", "out"]);
    if (options.artifacts === undefined)
      fail("manifest needs --artifacts <dir>");
    if (typeof options.version !== "string")
      fail("manifest needs --version <x.y.z>");
    const outDir = path.resolve(
      root,
      options.out ?? path.resolve(root, options.artifacts)
    );
    const manifest = buildReleaseManifest(
      options.version,
      artifactDigests(path.resolve(root, options.artifacts))
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

  verify(args) {
    const options = parseArgs(args, [
      "artifacts",
      "version",
      "sbom",
      "statement",
      "public-key",
    ]);
    if (options.artifacts === undefined) fail("verify needs --artifacts <dir>");
    const dir = path.resolve(root, options.artifacts);
    COMMANDS["verify-sbom"](
      options.sbom === undefined ? [] : ["--sbom", options.sbom]
    );
    COMMANDS["verify-provenance"](
      options.statement === undefined
        ? ["--artifacts", options.artifacts]
        : ["--artifacts", options.artifacts, "--statement", options.statement]
    );
    const manifestPath = path.join(dir, "centraid-release-manifest.json");
    const signaturePath = path.join(dir, "centraid-release-manifest.sig.json");
    const publicKey =
      options["public-key"] ?? process.env.CENTRAID_RELEASE_PUBLIC_KEY;
    if (typeof publicKey !== "string" || publicKey === "") {
      if (existsSync(signaturePath))
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
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const result = verifyDocument(
      manifest,
      JSON.parse(readFileSync(signaturePath, "utf8")),
      publicKey
    );
    if (!result.ok) fail(`release manifest signature: ${result.reason}`);
    if (
      typeof options.version === "string" &&
      manifest.version !== options.version
    )
      fail(
        `release manifest is signed but vouches for ${manifest.version}, not ${options.version}`
      );
    console.info("supply-chain: release manifest signature verified");
  },
};

function defaultBuilderId() {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const workflow = process.env.GITHUB_WORKFLOW_REF;
  if (server && repo && workflow) return `${server}/${workflow}`;
  return "local://unattested-developer-build";
}

const [command, ...rest] = process.argv.slice(2);
if (command === undefined || !Object.hasOwn(COMMANDS, command)) {
  console.error(
    `usage: supply-chain.mjs <${Object.keys(COMMANDS).join("|")}> [flags]`
  );
  process.exit(1);
}
COMMANDS[command](rest);
