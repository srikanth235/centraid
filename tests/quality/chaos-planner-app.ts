/**
 * The real app-engine backend both chaos lanes dispatch through (#842 W3).
 *
 * WHY THE REAL DISPATCHER AND NOT A DIRECT `plane.invoke`. Exactly-once under
 * a retried intent is not a property of the vault alone: the app-engine
 * dispatcher derives a DETERMINISTIC, intent-bound invocation id per call
 * (`bindIntentToVaultBridge` in `packages/server/src/engine/handlers/
 * dispatcher.ts`) and that id is what `replayInvocation` recognises. A rig
 * that called the vault directly with a fresh invocation id would double-apply
 * every retry — and would be measuring its own shortcut, not the product.
 * Both chaos lanes therefore run a real registered app through the real
 * dispatcher, in a real worker.
 *
 * NOTE ON THE RUNTIME: the worker loads its module graph through the esbuild
 * loader hook the app-engine worker registers, which is a NODE hook. Run these
 * lanes with `node node_modules/vitest/vitest.mjs` (what `bun run
 * test:qualities` does), not with `bunx vitest` — under the bun runtime the
 * handler worker cannot resolve its own graph and every dispatch reports
 * HANDLER_ERROR. That is a property of the harness, not of this rig.
 */

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

/**
 * What the gateway's backend does with the next dispatch.
 *
 * - `healthy` runs the action.
 * - `dying` runs the action and THEN throws — the dangerous half of a gateway
 *   crash, where the canonical command committed and the outcome row never
 *   did. A retry that re-executed would double-write.
 * - `degraded` returns the product's own non-terminal `retryable`, which is
 *   what a backend that is up but cannot serve looks like.
 */
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

/** Grant the planner app the one scope its action needs. */
export function approvePlanner(plane: VaultPlane): void {
  plane.approveGrant(PLANNER_APP_ID, {
    purpose: "dpv:ServiceProvision",
    scopes: [{ schema: "schedule", verbs: "act" }],
  });
}

/**
 * `currentPlane` is a thunk so the composition lane can restart the vault
 * plane underneath a live dispatcher — a restarted gateway must not need a
 * rebuilt app registry to keep serving.
 */
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
    // The crash lands AFTER the canonical commit and BEFORE the outcome row.
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
