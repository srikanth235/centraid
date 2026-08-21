// Embed the @centraid/web PWA build into the gateway's publishable dist
// (`dist/web`), so the standalone `centraid-gateway` daemon can serve it
// (cli.ts `bundledWebRoot`). Locating the package via module resolution —
// not a `../../apps/web` relative path — keeps the dependency edge stated
// exactly once, in package.json: turbo orders the builds off the devDep,
// and knip proves the devDep is consumed by parsing this import specifier.
import { cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webPkg = require.resolve("@centraid/web/package.json");
const webDist = path.join(path.dirname(webPkg), "dist");
const target = fileURLToPath(new URL("../dist/web", import.meta.url));
const staging = mkdtempSync(path.join(path.dirname(target), ".web-embed-"));

try {
  // check:push runs affected test and typecheck graphs concurrently. Both can
  // build the gateway, so publish a complete snapshot atomically and accept
  // an equivalent snapshot that won the race instead of copying into a shared
  // directory while another build is removing it.
  cpSync(webDist, staging, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  try {
    renameSync(staging, target);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")
    ) {
      throw error;
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
