import { readFileSync } from "node:fs";

const pinned = readFileSync(".node-version", "utf8").trim();
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const running = process.version.replace(/^v/u, "");

const failures = [];
if (!/^\d+\.\d+\.\d+$/u.test(pinned)) {
  failures.push(`.node-version must be an exact semver, got ${pinned}`);
}
if (manifest.engines?.node !== pinned) {
  failures.push(
    `package.json engines.node must equal .node-version (${pinned}), got ${manifest.engines?.node ?? "missing"}`
  );
}
if (running !== pinned) {
  failures.push(
    `Node ${pinned} is required, but this command is running under ${running}`
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`node-version: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`node-version: ${pinned}`);
}
