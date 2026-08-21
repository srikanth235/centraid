/*
 * Connector/enricher suites extend the repository-owned automation handler
 * harness with published-module loading and cursor rails specific to pulls.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { createAutomationHandlerHarness } from "@centraid/test-kit/automation-handler-harness";
import type {
  AutomationHandlerHarness,
  AutomationHandlerHarnessOptions,
} from "@centraid/test-kit/automation-handler-harness";

export {
  bytesContent,
  json,
  selectRows,
  textContent,
} from "@centraid/test-kit/automation-handler-harness";

export type {
  AutomationHandlerHarness as Harness,
  AutomationHandlerHarnessOptions as HarnessOptions,
  ContentReply,
  DelegateCall,
  FetchCall,
  FetchReply,
  InvokeOutcome,
  InvokeRecord,
  ReadRequest,
  VaultRow,
} from "@centraid/test-kit/automation-handler-harness";

export function createHarness(
  options: AutomationHandlerHarnessOptions = {}
): AutomationHandlerHarness {
  return createAutomationHandlerHarness({
    ...options,
    invoke:
      options.invoke ??
      ((_request, invocation) => ({
        status: "executed",
        output: { item_id: `item-${invocation}`, status: "staged" },
      })),
  });
}

// Same observable semantics as `cursorManager` in
// packages/server/src/automation/worker/runner.ts: provider cursors are live opaque
// tokens; high-water cursors only move upward and refuse type changes.
export interface CursorHarness {
  cursor: {
    provider: (key: string) => {
      readonly current: unknown;
      set: (value: unknown) => void;
      clear: () => void;
    };
    highWater: (key: string) => {
      readonly current: unknown;
      observe: (candidate: unknown) => void;
    };
  };
  updates: Map<string, unknown>;
}

export function cursorHarness(
  initial: Record<string, unknown> = {}
): CursorHarness {
  const updates = new Map<string, unknown>();
  return {
    cursor: {
      provider(key: string) {
        let value = initial[key];
        return {
          get current(): unknown {
            return value;
          },
          set(next: unknown): void {
            value = next;
            updates.set(key, next);
          },
          clear(): void {
            value = null;
            updates.set(key, null);
          },
        };
      },
      highWater(key: string) {
        const initialValue = initial[key];
        let value: string | number | undefined =
          typeof initialValue === "string" || typeof initialValue === "number"
            ? initialValue
            : undefined;
        return {
          get current(): unknown {
            return value;
          },
          observe(candidate: unknown): void {
            if (candidate === null || candidate === undefined) return;
            if (
              typeof candidate !== "string" &&
              typeof candidate !== "number"
            ) {
              throw new TypeError(
                `high-water cursor "${key}" got a non-scalar`
              );
            }
            if (value !== undefined && typeof candidate !== typeof value) {
              throw new TypeError(
                `high-water cursor "${key}" changed value type`
              );
            }
            if (value === undefined || candidate > value) value = candidate;
            updates.set(key, value);
          },
        };
      },
    },
    updates,
  };
}

const TREE_ROOT = import.meta.dirname;
let freshLoads = 0;

export interface PullSpec {
  protocol: string;
  principal: (args: { ctx: Record<string, unknown> }) => Promise<string>;
  pull: (args: {
    ctx: Record<string, unknown>;
    cursor: CursorHarness["cursor"];
    log: AutomationHandlerHarness["log"];
  }) => Promise<{ rows: Record<string, unknown>[]; summary?: string }>;
}

export type EnricherHandler = (args: {
  ctx: Record<string, unknown>;
  log: AutomationHandlerHarness["log"];
}) => Promise<unknown>;

async function loadModule(
  id: string,
  fresh: boolean
): Promise<Record<string, unknown>> {
  const handler = path.join(TREE_ROOT, id, "automations", id, "handler.js");
  let cacheKey = `suite=${id}`;
  if (fresh) {
    freshLoads += 1;
    cacheKey = `fresh=${freshLoads}`;
  }
  const url = `${pathToFileURL(handler).href}?${cacheKey}`;
  return (await import(url)) as Record<string, unknown>;
}

export async function loadPull(
  id: string,
  options: { fresh?: boolean } = {}
): Promise<PullSpec> {
  const mod = await loadModule(id, options.fresh === true);
  return mod.default as PullSpec;
}

export async function loadEnricher(
  id: string,
  options: { fresh?: boolean } = {}
): Promise<EnricherHandler> {
  const mod = await loadModule(id, options.fresh === true);
  return mod.default as EnricherHandler;
}
