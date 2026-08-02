import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const workspaceRoot = new URL("../../../", import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@centraid/vault")
      return {
        url: new URL("packages/vault/src/index.ts", workspaceRoot).href,
        shortCircuit: true,
      };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.endsWith(".js")) {
        const candidate = new URL(
          specifier.replace(/\.js$/u, ".ts"),
          context.parentURL
        );
        if (existsSync(fileURLToPath(candidate)))
          return { url: candidate.href, shortCircuit: true };
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".ts")) return nextLoad(url, context);
    return {
      format: "module",
      source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), {
        mode: "transform",
        sourceUrl: url,
      }),
      shortCircuit: true,
    };
  },
});

const keepAlive = setInterval(() => undefined, 60_000);
void import("./kill-mid-write-child.ts").catch((error) => {
  clearInterval(keepAlive);
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exitCode = 1;
});
