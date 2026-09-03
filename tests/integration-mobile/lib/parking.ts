import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { BLUEPRINT_APPS_DIR } from "./manifests.js";

const VAULT_COMMANDS_DIR = path.resolve(
  import.meta.dirname,
  "../../../packages/vault/src/commands"
);

const COMMAND_NAME = /name:\s*"(?<name>[a-z_]+\.[a-z_]+)"/gu;
const CONFIRM_FLAG = /\n {2}confirm: true,/gu;
const HANDLER_COMMAND = /command:\s*"(?<name>[a-z_]+\.[a-z_]+)"/gu;

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

export async function parkableCommandsOf(appId: string): Promise<string[]> {
  const [parking, used] = await Promise.all([
    parkingCommands(),
    commandsUsedBy(appId),
  ]);
  return [...used].filter((command) => parking.has(command)).sort();
}
