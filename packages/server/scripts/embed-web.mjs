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
