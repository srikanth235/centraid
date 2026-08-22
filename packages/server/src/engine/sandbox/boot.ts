/**
 * Loader-safe entry point for the handler sandbox.
 *
 * A worker runner cannot simply `import { installWorkerSandbox } from
 * "../sandbox/install.js"`. Worker threads here boot under Node's native type
 * stripping, which loads a `.ts` file handed to it directly but does NOT map a
 * `./sibling.js` specifier onto `./sibling.ts` the way the compiled build does.
 * Under `dist/` the `.js` files exist and the plain specifier resolves; running
 * from `src/` it does not, and the runner dies at import — which is exactly how
 * this file came to exist.
 *
 * So: this module has ZERO relative imports. Runners load it by absolute path,
 * it decides whether the sandbox is compiled, installs a `.js`→`.ts` sibling
 * fallback when it is not, and only then pulls the rest of the sandbox in.
 *
 * The fallback is a resolution-failure fallback, never an override: a specifier
 * Node resolves on its own is returned untouched.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { SandboxHandle } from "./install.js";
import type { SandboxPolicy } from "./policy.js";

const SANDBOX_DIR = import.meta.dirname;

let siblingFallbackInstalled = false;

/** Map an unresolvable `./x.js` onto `./x.ts` when running from source. */
function enableTsSiblingResolution(): void {
  if (siblingFallbackInstalled) return;
  siblingFallbackInstalled = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const parent = context.parentURL;
        if (
          parent === undefined ||
          !specifier.startsWith(".") ||
          !specifier.endsWith(".js")
        ) {
          throw error;
        }
        const candidate = new URL(`${specifier.slice(0, -3)}.ts`, parent);
        if (!existsSync(fileURLToPath(candidate))) throw error;
        // `module-typescript`, not `module`: this hook supplies no transformed
        // source, so Node must still run its own type stripping. Declaring
        // plain `module` skips the strip and the file fails to parse.
        return {
          url: candidate.href,
          format: "module-typescript",
          shortCircuit: true,
        };
      }
    },
  });
}

/** Absolute URL of a sandbox module, compiled `.js` preferred over `.ts`. */
function sandboxModuleUrl(base: string): string {
  const js = path.join(SANDBOX_DIR, `${base}.js`);
  if (existsSync(js)) return pathToFileURL(js).href;
  enableTsSiblingResolution();
  return pathToFileURL(path.join(SANDBOX_DIR, `${base}.ts`)).href;
}

export interface SandboxBoot {
  installWorkerSandbox: (policy: SandboxPolicy) => SandboxHandle;
  appHandlerPolicy: () => SandboxPolicy;
  appSeedPolicy: (appDir: string) => SandboxPolicy;
  automationHandlerPolicy: () => SandboxPolicy;
  mediaTranscodePolicy: (readRoots: readonly string[]) => SandboxPolicy;
  modelRuntimePolicy: (readRoots: readonly string[]) => SandboxPolicy;
}

/**
 * Load the sandbox. Deliberately NOT wrapped in a try/catch: if the sandbox
 * cannot be loaded, the handler must not run. Failing the run is the correct
 * outcome — a caught error here would silently execute untrusted code with no
 * containment, which is the one failure mode this whole slice exists to
 * prevent.
 */
export async function loadSandbox(): Promise<SandboxBoot> {
  const install = (await import(sandboxModuleUrl("install"))) as {
    installWorkerSandbox: SandboxBoot["installWorkerSandbox"];
  };
  const policy = (await import(sandboxModuleUrl("policy"))) as {
    appHandlerPolicy: SandboxBoot["appHandlerPolicy"];
    appSeedPolicy: SandboxBoot["appSeedPolicy"];
    automationHandlerPolicy: SandboxBoot["automationHandlerPolicy"];
    mediaTranscodePolicy: SandboxBoot["mediaTranscodePolicy"];
    modelRuntimePolicy: SandboxBoot["modelRuntimePolicy"];
  };
  return {
    installWorkerSandbox: install.installWorkerSandbox,
    appHandlerPolicy: policy.appHandlerPolicy,
    appSeedPolicy: policy.appSeedPolicy,
    automationHandlerPolicy: policy.automationHandlerPolicy,
    mediaTranscodePolicy: policy.mediaTranscodePolicy,
    modelRuntimePolicy: policy.modelRuntimePolicy,
  };
}
