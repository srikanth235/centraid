// Conformance between the DECLARED container routing table and the REAL
// registered command schemas (#750, #929). The defect this test exists for:
// routing decided by string heuristics over the command name and a
// hand-maintained list of container-id keys lets a renamed input key silently
// bypass the shared-container refusal — a member's write lands private and the
// origin never sees it. Here the table is data, and this test walks the
// command registry every command pack actually installs.

import { afterEach, describe, expect, test } from "vitest";

import { registerAttachmentCommands } from "../commands/attachments.js";
import { registerDocumentCommands } from "../commands/documents.js";
import { registerEnrichCommands } from "../commands/enrich.js";
import { registerKnowledgeCommands } from "../commands/knowledge.js";
import { registerLockerCommands } from "../commands/locker.js";
import { registerMediaCommands } from "../commands/media.js";
import { registerOutboxCommands } from "../commands/outbox.js";
import { registerTallyCommands } from "../commands/tally.js";
import { createGateway } from "../gateway/gateway.js";
import type { ShareableItemType } from "./closure.js";
import {
  CONTAINER_COMMAND_ROUTES,
  containerRoutesForCommand,
  isContainerCommandActable,
} from "./container-routing.js";
import type { ContainerRouteResolution } from "./container-routing.js";
import { closeOpenVaults, household } from "./placement-fixture.js";

/**
 * THE CONFORMANCE VOCABULARY, deliberately a SECOND declaration: derived
 * from the route table it checks, it would prove nothing. Kept here because
 * this test is its only reader — a new command that grows a
 * `group_id` cannot quietly skip the rail. Scoped by owner schema on purpose:
 * `locker.save_item` and `outbox.decide` also carry `item_id`.
 */
interface ContainerKey {
  ownerSchema: string;
  inputKey: string;
  containerType: ShareableItemType;
  resolution: ContainerRouteResolution;
}

const CONTAINER_KEYS: readonly ContainerKey[] = [
  {
    ownerSchema: "tally",
    inputKey: "group_id",
    containerType: "tally.group",
    resolution: "container",
  },
  {
    ownerSchema: "tally",
    inputKey: "expense_id",
    containerType: "tally.group",
    resolution: "tally-expense",
  },
  {
    ownerSchema: "core",
    inputKey: "document_id",
    containerType: "docs.folder",
    resolution: "folder-document",
  },
  {
    ownerSchema: "core",
    inputKey: "document_id",
    containerType: "core.document",
    resolution: "container",
  },
  {
    ownerSchema: "core",
    inputKey: "folder_id",
    containerType: "docs.folder",
    resolution: "folder-descendant",
  },
  {
    ownerSchema: "core",
    inputKey: "parent_folder_id",
    containerType: "docs.folder",
    resolution: "folder-descendant",
  },
  {
    ownerSchema: "core",
    inputKey: "content_id",
    containerType: "core.content_item",
    resolution: "container",
  },
  {
    ownerSchema: "knowledge",
    inputKey: "content_id",
    containerType: "core.content_item",
    resolution: "container",
  },
  {
    ownerSchema: "media",
    inputKey: "album_id",
    containerType: "core.collection",
    resolution: "container",
  },
  {
    ownerSchema: "media",
    inputKey: "asset_id",
    containerType: "media.asset",
    resolution: "container",
  },
  {
    ownerSchema: "enrich",
    inputKey: "asset_id",
    containerType: "media.asset",
    resolution: "container",
  },
  {
    ownerSchema: "locker",
    inputKey: "item_id",
    containerType: "locker.item",
    resolution: "container",
  },
];

interface RegisteredCommand {
  name: string;
  ownerSchema: string;
  inputKeys: Set<string>;
}

/** Read back from `agent_command`, the registry the gateway authorizes
 *  against. */
function registeredCommands(): Map<string, RegisteredCommand> {
  const { origin } = household();
  const gateway = createGateway(origin);
  registerAttachmentCommands(gateway);
  registerDocumentCommands(gateway);
  registerEnrichCommands(gateway);
  registerKnowledgeCommands(gateway);
  registerLockerCommands(gateway);
  registerMediaCommands(gateway);
  registerOutboxCommands(gateway);
  registerTallyCommands(gateway);
  const rows = origin.vault
    .prepare("SELECT name, owner_schema, input_schema_json FROM agent_command")
    .all() as {
    name: string;
    owner_schema: string;
    input_schema_json: string;
  }[];
  return new Map(
    rows.map((row) => {
      const schema = JSON.parse(row.input_schema_json) as {
        properties?: Record<string, unknown>;
      };
      return [
        row.name,
        {
          name: row.name,
          ownerSchema: row.owner_schema,
          inputKeys: new Set(Object.keys(schema.properties ?? {})),
        },
      ];
    })
  );
}

describe("Commons routing conformance", () => {
  afterEach(closeOpenVaults);

  test("every declared route names a real command and a real input key", () => {
    const commands = registeredCommands();
    const drift: string[] = [];
    for (const declared of CONTAINER_COMMAND_ROUTES) {
      const command = commands.get(declared.command);
      if (!command) {
        drift.push(`${declared.command}: no such registered command`);
        continue;
      }
      if (command.ownerSchema !== declared.ownerSchema)
        drift.push(
          `${declared.command}: declared under schema ${declared.ownerSchema}, registered under ${command.ownerSchema}`
        );
      if (!command.inputKeys.has(declared.inputKey))
        drift.push(
          `${declared.command}: routes on input key ${declared.inputKey}, which its schema does not declare`
        );
    }
    expect(drift).toStrictEqual([]);
  });

  test("every command that can address a shareable container is routed", () => {
    const commands = registeredCommands();
    const missing: string[] = [];
    for (const command of commands.values())
      for (const key of CONTAINER_KEYS) {
        if (
          key.ownerSchema !== command.ownerSchema ||
          !command.inputKeys.has(key.inputKey)
        )
          continue;
        const routed = containerRoutesForCommand(command.name).some(
          (declared) =>
            declared.inputKey === key.inputKey &&
            declared.containerType === key.containerType
        );
        if (!routed)
          missing.push(
            `${command.name} writes ${key.containerType} through ${key.inputKey} but declares no commons route`
          );
      }
    expect(missing).toStrictEqual([]);
  });

  test("no route invents a container key outside the declared vocabulary", () => {
    const vocabulary = new Set(
      CONTAINER_KEYS.map(
        (key) =>
          `${key.ownerSchema}|${key.inputKey}|${key.containerType}|${key.resolution}`
      )
    );
    const invented = CONTAINER_COMMAND_ROUTES.filter(
      (declared) =>
        !vocabulary.has(
          `${declared.ownerSchema}|${declared.inputKey}|${declared.containerType}|${declared.resolution}`
        )
    ).map((declared) => `${declared.command}/${declared.inputKey}`);
    expect(invented).toStrictEqual([]);
  });

  test("actability is a declared subset of routing, never a name pattern", () => {
    // A container's declared write surface never includes a command that
    // deletes the shared root, and routing a command is not declaring it.
    expect(isContainerCommandActable("docs.folder", "core.delete_folder")).toBe(
      false
    );
    expect(containerRoutesForCommand("core.delete_folder")).not.toStrictEqual(
      []
    );
    expect(isContainerCommandActable("media.asset", "media.update_asset")).toBe(
      false
    );
    expect(isContainerCommandActable("tally.group", "tally.add_expense")).toBe(
      true
    );
    // Deleting a child document does not delete the docs.folder root, so it
    // stays declared for the folder that survives it.
    expect(
      isContainerCommandActable("docs.folder", "core.trash_document")
    ).toBe(true);
  });
});
