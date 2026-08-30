/*
 * The enumeration source for this tier (#890 W3).
 *
 * Every suite here iterates the apps a state is DESIGNED for, read off
 * `packages/blueprints/apps/<id>/app.json` at run time rather than from a list
 * typed into a test. A hand-kept list is how a ninth bundled app, or an app
 * that newly declares a state, escapes the grid silently: the suite stays green
 * because it never knew to look. Reading the manifests makes the manifest the
 * only place the grid can be widened, and `assertEveryDesignedStateIsAccounted`
 * turns a widened manifest into a red suite rather than a quiet gap.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** The app-state vocabulary, as `tests/matrix.json#appStates.states` declares it. */
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

/**
 * Every bundled app manifest, by directory scan. `_shared` and `automations`
 * carry no `app.json`, so the scan needs no denylist to skip them — which is
 * the point: a denylist would need editing for each new sibling folder.
 */
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

/** The app ids whose shipped manifest declares `state` designed, sorted. */
export async function appsDesigning(state: AppState): Promise<string[]> {
  return (await loadAppManifests())
    .filter((manifest) => manifest.states.designed.includes(state))
    .map((manifest) => manifest.id);
}

/**
 * Manifest states this tier has never heard of. A manifest that invents a
 * state — or the vocabulary gaining an eighth entry — must break the suites
 * loudly rather than silently narrowing every enumeration below it.
 */
export async function unknownDesignedStates(): Promise<string[]> {
  const seen = new Set<string>();
  for (const manifest of await loadAppManifests()) {
    for (const state of manifest.states.designed)
      if (!isAppState(state)) seen.add(`${manifest.id}:${state}`);
  }
  return [...seen].sort();
}
