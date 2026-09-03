import { promises as fs } from "node:fs";
import type * as TypeImport_g9tn66 from "node:fs";
import path from "node:path";

import * as automation from "@centraid/server/automation";
import { ManifestError, parseAppManifest } from "@centraid/server/engine";

import { fileExists } from "./routes/route-helpers.js";

function findFirstInOrder<T, R>(
  values: readonly T[],
  check: (value: T) => R | PromiseLike<R | undefined>
): Promise<R | undefined> {
  const visit = async (index: number): Promise<R | undefined> => {
    const value = values[index];
    if (value === undefined) return undefined;
    const found = await check(value);
    return found === undefined ? visit(index + 1) : found;
  };
  return visit(0);
}

export async function validateManifestAt(
  appDir: string,
  options: { releaseManagedModelBundle?: boolean } = {}
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(appDir, "app.json"), "utf8");
  } catch {
    return "app.json is missing";
  }
  let manifest;
  try {
    manifest = parseAppManifest(raw);
  } catch (error) {
    if (error instanceof ManifestError) {
      return `app.json invalid (${error.code})${error.path ? ` at ${error.path}` : ""}: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
  }
  const actionError = await findFirstInOrder(
    manifest.actions,
    async (action) =>
      (await fileExists(path.join(appDir, "actions", `${action.name}.js`)))
        ? undefined
        : `app.json declares action "${action.name}" but actions/${action.name}.js does not exist`
  );
  if (actionError) return actionError;
  const queryError = await findFirstInOrder(manifest.queries, async (query) =>
    (await fileExists(path.join(appDir, "queries", `${query.name}.js`)))
      ? undefined
      : `app.json declares query "${query.name}" but queries/${query.name}.js does not exist`
  );
  if (queryError) return queryError;
  if (manifest.kind === "automation") {
    const manifestError = await validateAutomationManifestsAt(appDir);
    if (manifestError) return manifestError;
    const handlerError = options.releaseManagedModelBundle
      ? undefined
      : await lintAutomationHandlersAt(appDir);
    if (handlerError) return handlerError;
  }
  return undefined;
}

async function validateAutomationManifestsAt(
  appDir: string
): Promise<string | undefined> {
  const automationsDir = path.join(appDir, "automations");
  let ids: TypeImport_g9tn66.Dirent[];
  try {
    ids = await fs.readdir(automationsDir, { withFileTypes: true });
  } catch {
    return undefined; // no automations/ dir — nothing to validate
  }
  return findFirstInOrder(
    ids.filter((ent) => ent.isDirectory()),
    async (ent) => {
      const rel = `automations/${ent.name}/${automation.MANIFEST_FILE}`;
      let raw: string;
      try {
        raw = await fs.readFile(path.join(appDir, rel), "utf8");
      } catch {
        return undefined; // manifest absent — nothing to validate here
      }
      try {
        automation.parseManifest(raw);
      } catch (error) {
        if (error instanceof automation.ManifestError) {
          return `${rel} invalid (${error.code})${error.field ? ` at ${error.field}` : ""}: ${error.message}`;
        }
        return error instanceof Error ? error.message : String(error);
      }
      return undefined;
    }
  );
}

async function lintAutomationHandlersAt(
  appDir: string
): Promise<string | undefined> {
  const automationsDir = path.join(appDir, "automations");
  let ids: TypeImport_g9tn66.Dirent[];
  try {
    ids = await fs.readdir(automationsDir, { withFileTypes: true });
  } catch {
    return undefined; // no automations/ dir — nothing to lint
  }
  return findFirstInOrder(
    ids.filter((ent) => ent.isDirectory()),
    async (ent) => {
      const rel = `automations/${ent.name}/${automation.HANDLER_FILE}`;
      let source: string;
      try {
        source = await fs.readFile(path.join(appDir, rel), "utf8");
      } catch {
        return undefined; // handler absent — manifest validation handles structural gaps
      }
      const findings = automation.lintHandlerSource(source);
      const error = automation.formatHandlerLintError(findings, rel);
      return error || undefined;
    }
  );
}
