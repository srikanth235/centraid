/*
 * The Companion's own lint (#1020 wave 4 lane extension).
 *
 * Two checks the repository-wide lint cannot make, because both are about this
 * tree's relationship to files outside it:
 *
 * 1. **the manifests agree with `contracts/extension/ids.json`** — the extension
 *    id is a release artifact (D-1020-X5), and a manifest whose id drifts from
 *    the register is a host manifest that admits the wrong extension or none;
 * 2. **every method the popup and content script can send is one of the
 *    eighteen** — a `chrome.runtime.sendMessage({type: …})` with a name the table
 *    does not carry is a button that silently does nothing.
 *
 * `bun run --cwd extension lint`. Exits non-zero with the finding; the gate runs
 * it as part of `extension-unit`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(root, "..");
const findings = [];

const ids = JSON.parse(
  readFileSync(path.join(repo, "contracts/extension/ids.json"), "utf8")
);
const firefox = JSON.parse(
  readFileSync(path.join(root, "static/manifest.firefox.json"), "utf8")
);
const registered = ids.browsers.find(
  (row) => row.browser === "firefox" && row.channel === "amo"
);
const declared = firefox.browser_specific_settings?.gecko?.id;
if (registered?.id !== declared) {
  findings.push(
    `contracts/extension/ids.json says the Firefox id is ${registered?.id} and the manifest declares ${declared}`
  );
}
if (ids.host !== "dev.centraid.host") {
  findings.push(`the id register names host ${ids.host}`);
}

const methods = new Set(
  JSON.parse(
    readFileSync(path.join(repo, "contracts/extension/methods.json"), "utf8")
  ).methods.map((row) => row.name)
);

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const at = path.join(dir, entry);
    if (statSync(at).isDirectory()) found.push(...walk(at));
    else if (at.endsWith(".ts") && !at.endsWith(".test.ts")) found.push(at);
  }
  return found;
}

for (const file of walk(path.join(root, "src"))) {
  const text = readFileSync(file, "utf8");
  for (const found of text.matchAll(/\btype:\s*"(?<method>[a-z:-]+)"/gu)) {
    const name = found.groups?.["method"] ?? "";
    // Only names that look like a Companion method are judged; a `type: "json"`
    // import assertion is not one.
    if (!/[:-]/u.test(name) && !methods.has(name)) continue;
    if (!methods.has(name)) {
      findings.push(
        `${path.relative(repo, file)} sends \`${name}\`, which is not one of the eighteen`
      );
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings)
    process.stderr.write(`extension lint: ${finding}\n`);
  process.exit(1);
}
process.stdout.write(
  "extension lint: the manifests and the method table agree\n"
);
