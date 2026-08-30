/*
 * Which apps can be parked at all, computed from the shipped sources (#890 W3).
 *
 * A park is the vault holding a command whose registry entry carries
 * `confirm: true` (`packages/vault/src/gateway/gateway.ts`: "risk never parks;
 * only `confirm: true` does"). Four bundled apps ship no action that reaches
 * one, so no arrangement at this tier can make a real gateway park their write.
 *
 * That fact is COMPUTED here rather than asserted in prose, because it is a
 * fact about the product that will change: the day one of those apps gains an
 * action routing to a confirm-required command, `parked.integration.test.ts`
 * turns red and the cell becomes coverable. A hand-written "we cannot do this"
 * comment would have gone stale silently instead.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { BLUEPRINT_APPS_DIR } from "./manifests.js";

const VAULT_COMMANDS_DIR = path.resolve(
  import.meta.dirname,
  "../../../packages/vault/src/commands"
);

/** `name: "schema.command"` in a command-registry entry. */
const COMMAND_NAME = /name:\s*"(?<name>[a-z_]+\.[a-z_]+)"/gu;
/** The registry's own confirmation flag, at its declaration indent. */
const CONFIRM_FLAG = /\n {2}confirm: true,/gu;
/** `command: "schema.command"` in an app's action handler. */
const HANDLER_COMMAND = /command:\s*"(?<name>[a-z_]+\.[a-z_]+)"/gu;

/**
 * Every vault command that parks for the owner. Read by walking the registry
 * sources and pairing each `confirm: true` with the command declaration it sits
 * inside — the same association a reader makes, and the only one available
 * without importing the whole vault package into this tier.
 */
export async function parkingCommands(): Promise<Set<string>> {
  const files = (await readdir(VAULT_COMMANDS_DIR)).filter(
    (file) => file.endsWith(".ts") && !file.includes(".test.")
  );
  const parking = new Set<string>();
  const sources = await Promise.all(
    files.map((file) => readFile(path.join(VAULT_COMMANDS_DIR, file), "utf8"))
  );
  for (const source of sources) {
    const declarations = [...source.matchAll(COMMAND_NAME)].map((match) => ({
      name: match.groups!.name!,
      index: match.index,
    }));
    for (const flag of source.matchAll(CONFIRM_FLAG)) {
      const owner = declarations.findLast(
        (declaration) => declaration.index < flag.index
      );
      if (owner) parking.add(owner.name);
    }
  }
  return parking;
}

/** Every vault command the app's shipped action handlers invoke. */
export async function commandsUsedBy(appId: string): Promise<Set<string>> {
  const dir = path.join(BLUEPRINT_APPS_DIR, appId, "actions");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".ts"));
  const sources = await Promise.all(
    files.map((file) => readFile(path.join(dir, file), "utf8"))
  );
  const used = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(HANDLER_COMMAND))
      used.add(match.groups!.name!);
  }
  return used;
}

/** The app's actions that park, if any. Empty means the state is unreachable. */
export async function parkableCommandsOf(appId: string): Promise<string[]> {
  const [parking, used] = await Promise.all([
    parkingCommands(),
    commandsUsedBy(appId),
  ]);
  return [...used].filter((command) => parking.has(command)).sort();
}
