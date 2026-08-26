/**
 * Loader-safe sandbox entry: ZERO relative imports — type stripping doesn't
 * map `.js`→`.ts` outside `dist/`; installs a resolution-failure fallback
 * (never an override).
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { SandboxHandle } from "./install.js";
import type { SandboxPolicy } from "./policy.js";

const SANDBOX_DIR = import.meta.dirname;

let siblingFallbackInstalled = false;

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
        // `module` would skip Node's type stripping → parse failure.
        return {
          url: candidate.href,
          format: "module-typescript",
          shortCircuit: true,
        };
      }
    },
  });
}

/** Absolute URL of a sandbox module, compiled `.js` over `.ts`. */
function sandboxModuleUrl(base: string): string {
  const js = path.join(SANDBOX_DIR, `${base}.js`);
  if (existsSync(js)) return pathToFileURL(js).href;
  enableTsSiblingResolution();
  return pathToFileURL(path.join(SANDBOX_DIR, `${base}.ts`)).href;
}

export interface SandboxBoot {
  installWorkerSandbox: (
    policy: SandboxPolicy,
    options?: { redactLaunchArgs?: boolean }
  ) => SandboxHandle;
  appHandlerPolicy: () => SandboxPolicy;
  appSeedPolicy: (appDir: string) => SandboxPolicy;
  automationHandlerPolicy: () => SandboxPolicy;
  mediaTranscodePolicy: (readRoots: readonly string[]) => SandboxPolicy;
  modelRuntimePolicy: (readRoots: readonly string[]) => SandboxPolicy;
}

/*
 * No try/catch on purpose: if the sandbox can't load, the handler must not
 * run — catching would execute untrusted code uncontained.
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
