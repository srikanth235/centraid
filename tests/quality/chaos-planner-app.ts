import { promises as fs } from "node:fs";
import path from "node:path";

import {
  Dispatcher,
  Registry,
} from "../../packages/server/src/engine/index.js";
import type { ReplicaIntentDispatcher } from "../../packages/server/src/routes/replica-intent-route.js";
import { replicaDispatchOutcome } from "../../packages/server/src/serve/build-gateway.js";
import type { VaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import { tempDir } from "../../packages/test-kit/src/temp-dir.js";

export const PLANNER_APP_ID = "planner";

export type BackendMode = "healthy" | "dying" | "degraded";

export interface PlannerBackend {
  readonly dispatch: ReplicaIntentDispatcher;
  setMode: (mode: BackendMode) => void;
  cleanup: () => Promise<void>;
}

async function writePlannerApp(codeDir: string): Promise<void> {
  await fs.mkdir(path.join(codeDir, "actions"), { recursive: true });
  await fs.writeFile(
    path.join(codeDir, "app.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: PLANNER_APP_ID,
      name: "Planner",
      version: "0.1.0",
      actionSideEffect: "vault-write",
      actions: [
        {
          name: "add_task",
          confirmation: "none",
          input: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string" } },
            additionalProperties: false,
          },
          writes: ["schedule.task"],
        },
      ],
      queries: [],
    })
  );
  await fs.writeFile(
    path.join(codeDir, "actions", "add_task.js"),
    "export default async ({ body, ctx }) => ({ status: 200, body: await ctx.vault.invoke({ command: 'schedule.add_task', input: { title: body.title }, purpose: 'dpv:ServiceProvision' }) });\n"
  );
}

export function approvePlanner(plane: VaultPlane): void {
  plane.approveGrant(PLANNER_APP_ID, {
    purpose: "dpv:ServiceProvision",
    scopes: [{ schema: "schedule", verbs: "act" }],
  });
}

export async function openPlannerBackend(
  currentPlane: () => VaultPlane
): Promise<PlannerBackend> {
  const registryDir = await tempDir("chaos-planner-registry-");
  const codeDir = await tempDir("chaos-planner-code-");
  await writePlannerApp(codeDir);

  const registry = new Registry(registryDir);
  await registry.load();
  await registry.ensureUploaded(PLANNER_APP_ID);
  const dispatcher = new Dispatcher({
    registry,
    codeDirOverride: async () => codeDir,
    vaultFor: () => currentPlane().bridgeFor(PLANNER_APP_ID),
  });

  let mode: BackendMode = "healthy";
  const dispatch: ReplicaIntentDispatcher = async (body) => {
    if (mode === "degraded")
      return { status: "retryable", reason: "backend degraded" };
    const written = await dispatcher.write({
      app: body.appId,
      action: body.action,
      input: body.input,
      intentId: body.intentId,
    });
    if (mode === "dying")
      throw new Error("gateway died after the canonical commit (chaos)");
    return replicaDispatchOutcome(written);
  };

  return {
    dispatch,
    setMode: (next) => {
      mode = next;
    },
    cleanup: async () => {
      await Promise.all(
        [codeDir, registryDir].map((dir) =>
          fs.rm(dir, { recursive: true, force: true })
        )
      );
    },
  };
}
