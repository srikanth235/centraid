#!/usr/bin/env node
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const generated = path.join(root, "src/generated");
const sourcePath = path.join(generated, "centraid_web_iroh.js");
const wasmPath = path.join(generated, "centraid_web_iroh_bg.wasm");
const publicDir = path.join(root, "public");
const outputPath = path.join(publicDir, "centraid-worker-iroh.js");
const outputWasmPath = path.join(publicDir, "centraid-worker-iroh.wasm");

const source = readFileSync(sourcePath, "utf8");
const classic = source
  .replace(
    /^(?<indent>[ \t]*)module_or_path = new URL\((?<quote>["'])centraid_web_iroh_bg\.wasm\k<quote>,\s*import\.meta\.url\s*\);[ \t]*$/mu,
    "$<indent>module_or_path = new URL('/centraid-worker-iroh.wasm' + self.location.search, self.location.origin);"
  )
  .replace(
    "export { initSync, __wbg_init as default };",
    "self.CentraidIrohWorkerBindings = Object.freeze({ BrowserEndpoint, initWasm: __wbg_init });"
  )
  .replace(/^export (?=(?:class|function) )/gmu, "");

if (
  classic === source ||
  classic.includes("import.meta.url") ||
  /^export /gmu.test(classic) ||
  !classic.includes("self.CentraidIrohWorkerBindings")
) {
  throw new Error(
    "build-iroh-worker: wasm-bindgen output shape changed; update the classic-worker adapter"
  );
}

writeFileSync(outputPath, classic);
copyFileSync(wasmPath, outputWasmPath);
process.stdout.write("[web] emitted public/centraid-worker-iroh.{js,wasm}\n");
