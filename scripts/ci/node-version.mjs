import { readFileSync } from "node:fs";

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
