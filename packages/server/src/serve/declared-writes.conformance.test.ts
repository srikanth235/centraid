// DECLARED ⊇ OBSERVED, the half `scripts/lint-engine-conformance.mjs` cannot
// check (#883 D2): real actions over a real `serve()` gateway, every write the
// vault handle issues compared to the action's own manifest.
//
// ANTI-VACUITY IS PART OF THE GATE — a test that observed nothing would pass
// every action in the product, so corpus size, app spread and the
// observed-entity floor are asserted before any verdict is read.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers";

import { describe, expect, onTestFinished, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { listVaultEntities } from "@centraid/vault";

import { unrefTimer } from "../lib/unref-timer.js";
import {
  conformDeclaredWrites,
  engineCascadeEntities,
  entityForPhysical,
  partyRepointEntities,
  polyRefCascadeEntities,
  writeTargetOf,
} from "./declared-writes.js";
import { serve } from "./serve.js";

const BLUEPRINTS = path.resolve(
  import.meta.dirname,
  "../../../blueprints/apps"
);

interface ManifestAction {
  name: string;
  writes?: string[];
}

function declaredWritesOf(appId: string, action: string): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(BLUEPRINTS, appId, "app.json"), "utf8")
  ) as { actions?: ManifestAction[] };
  const entry = (manifest.actions ?? []).find((each) => each.name === action);
  if (!entry)
    throw new Error(
      `no action "${action}" in ${appId}/app.json — corpus drift`
    );
  if (!Array.isArray(entry.writes))
    throw new Error(`${appId}/${action} declares no writes: array`);
  return entry.writes;
}

// The SQL is the ground truth: the handler's rows, the engine's cascades, and
// anything a future change adds without telling anyone.
function watchWrites(db: DatabaseSync): {
  reset: () => void;
  tables: () => Set<string>;
  restore: () => void;
} {
  const original = db.prepare.bind(db);
  let tables = new Set<string>();
  Object.defineProperty(db, "prepare", {
    configurable: true,
    value: ((sql: string) => {
      const target = writeTargetOf(sql);
      if (target) tables.add(target);
      return original(sql);
    }) as typeof db.prepare,
  });
  return {
    reset: () => {
      tables = new Set<string>();
    },
    tables: () => tables,
    restore: () => {
      Object.defineProperty(db, "prepare", {
        configurable: true,
        value: original,
      });
    },
  };
}

interface CorpusAction {
  app: string;
  action: string;
  input: (state: Record<string, string>) => Record<string, unknown>;
  remember?: (output: Record<string, unknown>) => Record<string, string>;
  // Named per action, never applied globally: a blanket union would exempt
  // most of the product.
  cascades?: Array<"poly-refs" | "party-repoint">;
}

// A CHAINED corpus, not a bag of calls: each action consumes an id the one
// before it minted, so the multi-table cases are reached with real inputs.
const CORPUS: CorpusAction[] = [
  {
    app: "notes",
    action: "create-notebook",
    input: () => ({ name: "Conformance" }),
    remember: (output) => ({ notebook: String(output.notebook_id ?? "") }),
  },
  {
    app: "notes",
    action: "create-note",
    input: (state) => ({
      title: "Declared writes",
      body_text: "the manifest says what the command does",
      format: "markdown",
      notebook_id: state.notebook!,
    }),
    remember: (output) => ({ note: String(output.note_id ?? "") }),
  },
  {
    app: "notes",
    action: "edit-note",
    input: (state) => ({
      note_id: state.note!,
      body_text: "edited, so the content spine mints a second item",
    }),
  },
  {
    app: "notes",
    action: "add-tag",
    input: (state) => ({ note_id: state.note!, label: "conformance" }),
  },
  {
    app: "notes",
    action: "delete-note",
    input: (state) => ({ note_id: state.note! }),
  },
  {
    app: "tasks",
    action: "add",
    input: () => ({ title: "Prove the declaration" }),
    remember: (output) => ({ task: String(output.task_id ?? "") }),
  },
  {
    app: "tasks",
    action: "set-status",
    input: (state) => ({ task_id: state.task!, status: "completed" }),
  },
  {
    app: "people",
    action: "add-person",
    input: () => ({ display_name: "Priya Conformance", cadence_days: 30 }),
    remember: (output) => ({ party: String(output.party_id ?? "") }),
  },

  {
    app: "docs",
    action: "create-folder",
    input: () => ({ name: "Receipts" }),
  },
];

describe("declared-writes.conformance", () => {
  test("every bundled action drives only the vault tables its manifest declares", async () => {
    const dataDir = await tempDir("declared-writes-");
    const token = "declared-writes-token";
    const handle = await serve({
      paths: { vaultDir: path.join(dataDir, "vault") },
      token,
    });
    onTestFinished(async () => {
      await handle.close().catch(() => undefined);
    });
    const plane = handle.vaults.get(handle.vaults.defaultVaultId());
    if (!plane)
      throw new Error("the auto-founded Personal vault is not mounted");

    const entities = listVaultEntities(plane.db.vault);
    const always = engineCascadeEntities();
    const conditional = {
      "poly-refs": polyRefCascadeEntities(entities),
      "party-repoint": partyRepointEntities(plane.db.vault, entities),
    } as const;
    const cascadeFor = (entry: CorpusAction): Set<string> =>
      new Set([
        ...always,
        ...(entry.cascades ?? []).flatMap((name) => [...conditional[name]]),
      ]);
    const watcher = watchWrites(plane.db.vault);
    onTestFinished(() => watcher.restore());

    // One DISCARDED dispatch first: a freshly mounted plane's boot writes are
    // the plane's, not any action's, and an exemption list would be dishonest.
    await fetch(`${handle.url}/centraid/tasks/actions/add`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: { title: "warm-up, not measured" } }),
    });

    const state: Record<string, string> = {};
    const covered: Array<{
      app: string;
      action: string;
      declared: string[];
      observed: string[];
      cascade: Set<string>;
      cascades?: CorpusAction["cascades"];
    }> = [];

    for (const entry of CORPUS) {
      watcher.reset();
      // Serial: each action consumes the previous ids, and the watcher is
      // per-action.
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(
        `${handle.url}/centraid/${entry.app}/actions/${entry.action}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ input: entry.input(state) }),
        }
      );
      expect(response.status, `${entry.app}/${entry.action} status`).toBe(200);
      // oxlint-disable-next-line no-await-in-loop
      const body = (await response.json()) as {
        status?: string;
        reason?: string;
        output?: Record<string, unknown>;
      };
      expect(
        body.status,
        `${entry.app}/${entry.action}: ${body.reason ?? "no reason given"}`
      ).toBe("executed");
      Object.assign(state, entry.remember?.(body.output ?? {}) ?? {});

      const observed = [...watcher.tables()]
        .map((table) => entityForPhysical(table, entities))
        .filter((entity): entity is string => entity !== undefined);
      covered.push({
        app: entry.app,
        action: entry.action,
        declared: declaredWritesOf(entry.app, entry.action),
        observed,
        cascade: cascadeFor(entry),
        ...(entry.cascades ? { cascades: entry.cascades } : {}),
      });
    }

    // Anti-vacuity, before any verdict is read.
    expect(covered).toHaveLength(CORPUS.length);
    expect(
      new Set(covered.map((entry) => entry.app)).size
    ).toBeGreaterThanOrEqual(4);
    const observedTotal = new Set(covered.flatMap((entry) => entry.observed))
      .size;
    expect(
      observedTotal,
      "the write watcher observed almost nothing — the SQL parse or the corpus has gone vacuous"
    ).toBeGreaterThanOrEqual(8);
    expect(
      covered.some((entry) => entry.observed.length >= 3),
      "no action in the corpus wrote three tables — the multi-table cases are not being reached"
    ).toBe(true);
    // An ALWAYS set that swallowed the conditional cascades is worse than one
    // that went empty.
    expect(always.has("consent.receipt")).toBe(true);
    expect(always.has("consent.app")).toBe(true);
    expect(always.has("core.link")).toBe(false);
    expect(always.has("schedule.task")).toBe(false);
    expect(conditional["poly-refs"].has("core.link")).toBe(true);
    expect(conditional["poly-refs"].has("core.tag")).toBe(true);
    expect(
      conditional["party-repoint"].size,
      "the core_party foreign-key walk found nothing — the merge cascade set has gone vacuous"
    ).toBeGreaterThanOrEqual(10);
    // `core.merge_party` PARKS for owner confirmation by design, so an
    // unattended corpus cannot drive it: shape only, until it is reachable.
    expect(conditional["party-repoint"].has("people.profile")).toBe(true);

    const failures = covered
      .map((entry) => ({
        entry,
        verdict: conformDeclaredWrites({
          declared: entry.declared,
          observed: entry.observed,
          engineCascade: entry.cascade,
        }),
      }))
      .filter(({ verdict }) => verdict.undeclared.length > 0)
      .map(
        ({ entry, verdict }) =>
          `${entry.app}/${entry.action} wrote ${verdict.undeclared.join(", ")} ` +
          `without declaring it (declared: ${entry.declared.join(", ") || "nothing"})`
      );
    expect(failures).toStrictEqual([]);
  });

  test("the _changes event names the action's declared tables end to end", async () => {
    // D2's other half (#883): the declaration has to REACH the surface, or
    // every listener hears "something moved" and re-derives the whole app.
    const dataDir = await tempDir("declared-writes-sse-");
    const token = "declared-writes-sse-token";
    const handle = await serve({
      paths: { vaultDir: path.join(dataDir, "vault") },
      token,
    });
    onTestFinished(async () => {
      await handle.close().catch(() => undefined);
    });

    const controller = new AbortController();
    onTestFinished(() => controller.abort());
    const stream = await fetch(`${handle.url}/centraid/tasks/_changes`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
      },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const tablesSeen = new Promise<string[]>((resolve, reject) => {
      let buffer = "";
      const pump = async (): Promise<void> => {
        for (;;) {
          // Sequential by construction: one chunk at a time off one socket.
          // oxlint-disable-next-line no-await-in-loop
          const chunk = await reader.read();
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          for (const line of buffer.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const payload = JSON.parse(line.slice(5).trim()) as {
                tables?: string[];
              };
              if (Array.isArray(payload.tables) && payload.tables.length > 0) {
                resolve(payload.tables);
                return;
              }
            } catch {
              // Not the frame we are waiting for.
            }
          }
        }
      };
      const timer = setTimeout(
        () => reject(new Error("no _changes frame carried a table list")),
        15_000
      );
      unrefTimer(timer);
      void pump().catch(reject);
    });

    const acted = await fetch(`${handle.url}/centraid/tasks/actions/add`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: { title: "carry the declaration" } }),
    });
    expect(acted.status).toBe(200);

    await expect(tablesSeen).resolves.toStrictEqual(
      declaredWritesOf("tasks", "add")
    );
  });

  test("an undeclared write goes red — the gate can fail", () => {
    // SABOTAGE, over a real observation: take the first corpus action's shape
    // and remove one entity from its declaration. The comparison must name it.
    const cascade = new Set(["consent.receipt", "core.link"]);
    const honest = conformDeclaredWrites({
      declared: ["knowledge.note", "core.content_item"],
      observed: ["knowledge.note", "core.content_item", "consent.receipt"],
      engineCascade: cascade,
    });
    expect(honest.undeclared).toStrictEqual([]);

    const sabotaged = conformDeclaredWrites({
      declared: ["knowledge.note"],
      observed: ["knowledge.note", "core.content_item", "consent.receipt"],
      engineCascade: cascade,
    });
    expect(sabotaged.undeclared).toStrictEqual(["core.content_item"]);

    // The engine cascade is not a hiding place, however the union grows.
    expect(
      conformDeclaredWrites({
        declared: [],
        observed: ["knowledge.note"],
        engineCascade: cascade,
      }).undeclared
    ).toStrictEqual(["knowledge.note"]);
  });

  test("the SQL write parse sees writes and only writes", () => {
    expect(writeTargetOf("INSERT INTO knowledge_note (a) VALUES (1)")).toBe(
      "knowledge_note"
    );
    expect(
      writeTargetOf('INSERT OR REPLACE INTO "core_tag" (a) VALUES (1)')
    ).toBe("core_tag");
    expect(writeTargetOf("UPDATE core_document SET title = ?")).toBe(
      "core_document"
    );
    expect(writeTargetOf("DELETE FROM core_link WHERE from_id = ?")).toBe(
      "core_link"
    );
    expect(writeTargetOf("  update  core_party  set kind = ?")).toBe(
      "core_party"
    );
    expect(writeTargetOf("SELECT * FROM knowledge_note")).toBeUndefined();
    expect(writeTargetOf("PRAGMA table_info('core_party')")).toBeUndefined();
    expect(writeTargetOf("BEGIN IMMEDIATE")).toBeUndefined();
  });
});
