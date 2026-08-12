import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  COMMONS_COMMAND_ROUTES,
  COMMONS_COMMANDS,
  commonsCommandsFor,
} from "./actable.js";

interface BlueprintManifest {
  actions: Array<{
    name: string;
    input?: { properties?: Record<string, unknown> };
  }>;
}

function blueprintCommandSchemas(): Map<string, ReadonlySet<string>> {
  const schemas = new Map<string, ReadonlySet<string>>();
  for (const app of ["docs", "tally"] as const) {
    const appRoot = new URL(
      `../../../blueprints/apps/${app}/`,
      import.meta.url
    );
    const manifest = JSON.parse(
      readFileSync(new URL("app.json", appRoot), "utf8")
    ) as BlueprintManifest;
    const actions = new Map(
      manifest.actions.map((action) => [action.name, action])
    );
    const actionDir = new URL("actions/", appRoot);
    for (const file of readdirSync(actionDir).filter((name) =>
      name.endsWith(".ts")
    )) {
      const source = readFileSync(new URL(file, actionDir), "utf8");
      const command = /command:\s*"(?<command>[^"]+)"/u.exec(source)?.groups
        ?.command;
      if (!command) continue;
      const actionName = path.basename(file, ".ts");
      const action = actions.get(actionName);
      if (!action)
        throw new Error(`${app} action ${actionName} has no blueprint schema`);
      schemas.set(
        command,
        new Set(Object.keys(action.input?.properties ?? {}))
      );
    }
  }
  return schemas;
}

describe("Commons command declarations", () => {
  test("every exported capability names a production command handler", () => {
    const productionCommands = [
      readFileSync(
        new URL("../commands/documents.ts", import.meta.url),
        "utf8"
      ),
      readFileSync(new URL("../commands/tally.ts", import.meta.url), "utf8"),
    ].join("\n");
    for (const [containerType, commands] of COMMONS_COMMANDS) {
      expect(commonsCommandsFor(containerType)).toStrictEqual(
        [...commands].toSorted()
      );
      for (const command of commands)
        expect(productionCommands).toContain(`name: "${command}"`);
    }
  });

  test("every declared route key is backed by its blueprint command schema", () => {
    const schemas = blueprintCommandSchemas();
    for (const route of COMMONS_COMMAND_ROUTES) {
      const routeKeys = [...route.containerIdKeys, ...route.childIdKeys];
      for (const command of route.commands) {
        const schemaKeys = schemas.get(command);
        expect(
          schemaKeys,
          `${command} must have a blueprint action schema`
        ).toBeDefined();
        expect(
          routeKeys.some((key) => schemaKeys!.has(key)),
          `${command} must expose one of ${routeKeys.join(", ")} in its blueprint schema`
        ).toBe(true);
      }
    }
  });
});
