import { readFileSync } from "node:fs";

// Two different claims live here and they deserve different verdicts (#668).
//
//   Repo consistency — `.node-version` is exact semver and `engines.node`
//   agrees with it. A fact about files in the tree: deterministic, identical
//   on every machine, and a genuine gate.
//
//   Runtime match — the Node executing this command IS the pinned one. A fact
//   about the machine. CI satisfies it by construction (setup-node reads
//   `.node-version`), so it never fires there; locally it fires for everyone
//   whose version manager defaults to anything else, which is most people most
//   of the time.
//
// Fusing them made the second one fatal. It sat third in `check:pr`, so a
// developer on Node 22 had every push rejected before a single real gate ran —
// and a gate that only ever fails for a reason unrelated to your diff is the
// one that teaches people to pass --no-verify. It now warns locally and stays
// fatal under CI, where a mismatch means the workflow is genuinely misconfigured.

const pinned = readFileSync(".node-version", "utf8").trim();
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const running = process.version.replace(/^v/u, "");
const isCI = process.env.CI === "true" || process.env.CI === "1";

const failures = [];
if (!/^\d+\.\d+\.\d+$/u.test(pinned)) {
  failures.push(`.node-version must be an exact semver, got ${pinned}`);
}
if (manifest.engines?.node !== pinned) {
  failures.push(
    `package.json engines.node must equal .node-version (${pinned}), got ${manifest.engines?.node ?? "missing"}`
  );
}

const mismatch =
  running === pinned
    ? null
    : `Node ${pinned} is required, but this command is running under ${running}`;
if (mismatch && isCI) failures.push(mismatch);

if (failures.length > 0) {
  for (const failure of failures) console.error(`node-version: ${failure}`);
  process.exitCode = 1;
} else if (mismatch) {
  console.warn(
    `node-version: ${mismatch} — CI runs the pinned version; ` +
      `match it locally with \`nvm use\` if you hit a toolchain difference`
  );
} else {
  console.log(`node-version: ${pinned}`);
}
