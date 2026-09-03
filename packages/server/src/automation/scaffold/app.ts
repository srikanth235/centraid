import { promises as fs } from "node:fs";
import type * as TypeImport_g9tn66 from "node:fs";
import path from "node:path";

import {
  HANDLER_FILE,
  MANIFEST_FILE,
  ManifestError,
  parseManifest,
} from "../manifest/manifest.js";
import type { Manifest, Trigger } from "../manifest/manifest.js";
import { formatRef, isValidId } from "../manifest/ref.js";

export const APP_AUTOMATIONS_SUBDIR = "automations";

export interface Row {
  readonly id: string;
  readonly dir: string;
  readonly name: string;
  readonly triggers: readonly Trigger[];
  readonly enabled: boolean;
  readonly ownerApp: string;
  readonly ref: string;
  readonly manifest: Manifest;
}

export interface AppError {
  readonly id: string;
  readonly error: string;
  readonly code?: string;
}

export interface ListAppsResult {
  readonly rows: Row[];
  readonly errors: AppError[];
}

function rowFrom(
  id: string,
  dir: string,
  manifest: Manifest,
  ownerApp: string
): Row {
  return {
    id,
    dir,
    name: manifest.name,
    triggers: manifest.triggers,
    enabled: manifest.enabled,
    ownerApp,
    ref: formatRef(ownerApp, id),
    manifest,
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}

export function manifestPath(automationDir: string): string {
  return path.join(automationDir, MANIFEST_FILE);
}

export function handlerPath(automationDir: string): string {
  return path.join(automationDir, HANDLER_FILE);
}

export async function readAppAt(
  dir: string,
  ownerApp: string
): Promise<Row | undefined> {
  const id = path.basename(dir);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  let manifest: Manifest;
  try {
    manifest = parseManifest(raw);
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new ManifestError(
        error.code,
        `${ownerApp}/${id}: ${error.message}`
      );
    }
    throw error;
  }
  return rowFrom(id, dir, manifest, ownerApp);
}

export async function readAppOwned(
  appsDir: string,
  appId: string,
  automationId: string
): Promise<Row | undefined> {
  if (!isValidId(automationId)) return undefined;
  const codeDir = path.join(appsDir, appId);
  return readAppAt(
    path.join(codeDir, APP_AUTOMATIONS_SUBDIR, automationId),
    appId
  );
}

export async function list(appsDir: string): Promise<ListAppsResult> {
  let appEntries: TypeImport_g9tn66.Dirent[];
  try {
    appEntries = await fs.readdir(appsDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return { rows: [], errors: [] };
    throw error;
  }
  const results = await Promise.all(
    appEntries
      .filter(
        (app) =>
          app.isDirectory() &&
          !app.name.startsWith(".") &&
          !app.name.startsWith("_")
      )
      .map(async (app): Promise<ListAppsResult> => {
        const codeDir = path.join(appsDir, app.name);
        const autoRoot = path.join(codeDir, APP_AUTOMATIONS_SUBDIR);
        let autoEntries: TypeImport_g9tn66.Dirent[];
        try {
          autoEntries = await fs.readdir(autoRoot, { withFileTypes: true });
        } catch (error) {
          if (isEnoent(error)) return { rows: [], errors: [] };
          throw error;
        }
        const entries = await Promise.all(
          autoEntries
            .filter(
              (entry) =>
                entry.isDirectory() &&
                !entry.name.startsWith(".") &&
                !entry.name.startsWith("_")
            )
            .map(async (entry): Promise<{ row?: Row; error?: AppError }> => {
              try {
                return {
                  row: await readAppAt(
                    path.join(autoRoot, entry.name),
                    app.name
                  ),
                };
              } catch (error) {
                return {
                  error: {
                    id: `${app.name}/${entry.name}`,
                    error:
                      error instanceof Error ? error.message : String(error),
                    ...(error instanceof ManifestError
                      ? { code: error.code }
                      : {}),
                  },
                };
              }
            })
        );
        return {
          rows: entries.flatMap((entry) => (entry.row ? [entry.row] : [])),
          errors: entries.flatMap((entry) =>
            entry.error ? [entry.error] : []
          ),
        };
      })
  );
  const rows = results.flatMap((result) => result.rows);
  const errors = results.flatMap((result) => result.errors);
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { rows, errors };
}

export async function writeManifestAt(
  dir: string,
  manifest: Manifest
): Promise<void> {
  await fs.writeFile(
    path.join(dir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n"
  );
}
