import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const APP_STATES = [
  "dayone",
  "pending",
  "offline",
  "stale",
  "conflict",
  "parked",
  "denied",
] as const;

export type AppState = (typeof APP_STATES)[number];

export const BLUEPRINT_APPS_DIR = path.resolve(
  import.meta.dirname,
  "../../../packages/blueprints/apps"
);

export interface AppManifest {
  id: string;
  actions: { name: string }[];
  states: { designed: string[]; excluded: string[] };
}

function isAppState(value: string): value is AppState {
  return (APP_STATES as readonly string[]).includes(value);
}

export async function loadAppManifests(): Promise<AppManifest[]> {
  const entries = await readdir(BLUEPRINT_APPS_DIR, { withFileTypes: true });
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const file = path.join(BLUEPRINT_APPS_DIR, entry.name, "app.json");
        const raw = await readFile(file, "utf8").catch(() => undefined);
        if (raw === undefined) return undefined;
        const manifest = JSON.parse(raw) as Partial<AppManifest>;
        if (typeof manifest.id !== "string" || !manifest.states)
          return undefined;
        return {
          id: manifest.id,
          actions: manifest.actions ?? [],
          states: {
            designed: manifest.states.designed ?? [],
            excluded: manifest.states.excluded ?? [],
          },
        } satisfies AppManifest;
      })
  );
  return manifests
    .filter((manifest): manifest is AppManifest => manifest !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function appsDesigning(state: AppState): Promise<string[]> {
  return (await loadAppManifests())
    .filter((manifest) => manifest.states.designed.includes(state))
    .map((manifest) => manifest.id);
}

export async function unknownDesignedStates(): Promise<string[]> {
  const seen = new Set<string>();
  for (const manifest of await loadAppManifests()) {
    for (const state of manifest.states.designed)
      if (!isAppState(state)) seen.add(`${manifest.id}:${state}`);
  }
  return [...seen].sort();
}
