/*
 * The LOCAL-disk half of the storage surface (#544). GET .../storage/local
 * serves usage + limit evaluation (`?refresh=1` re-walks inline); GET|PUT
 * .../storage/limits manages the owner's warn-only limits. Other paths return
 * `false`; optional deps answer 503 when absent, never 404.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { LocalUsageScanner } from "../serve/local-usage.js";
import {
  DEFAULT_STORAGE_LIMITS,
  StorageLimitsError,
  evaluateStorageLimit,
} from "../serve/storage-limits.js";
import type {
  StorageLimits,
  StorageLimitsPatch,
  StorageLimitsStore,
} from "../serve/storage-limits.js";
import { readJson, sendError, sendJson } from "./route-helpers.js";

const LOCAL_PATH = "/centraid/_gateway/storage/local";
const LIMITS_PATH = "/centraid/_gateway/storage/limits";

export interface StorageLocalRouteDeps {
  /** Local component accounting — absent on a gateway built without it. */
  localUsage?: LocalUsageScanner;
  /** The owner's disk budget + ledger limit. */
  storageLimits?: StorageLimitsStore;
}

async function currentLimits(
  deps: StorageLocalRouteDeps
): Promise<StorageLimits> {
  return deps.storageLimits
    ? await deps.storageLimits.load()
    : { ...DEFAULT_STORAGE_LIMITS };
}

async function handleLocal(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: StorageLocalRouteDeps
): Promise<boolean> {
  if ((req.method ?? "GET") !== "GET") {
    return sendJson(res, 405, {
      error: "method_not_allowed",
      message: "GET only",
    });
  }
  if (!deps.localUsage) {
    return sendJson(res, 503, {
      error: "local_usage_unavailable",
      message: "this gateway was built without local disk accounting",
    });
  }
  try {
    const force = url.searchParams.get("refresh") === "1";
    const report = await deps.localUsage.report({ force });
    const limits = await currentLimits(deps);
    return sendJson(res, 200, {
      ...report,
      limits,
      limit: evaluateStorageLimit(report.totalBytes, limits),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function handleLimits(
  req: IncomingMessage,
  res: ServerResponse,
  deps: StorageLocalRouteDeps
): Promise<boolean> {
  const method = req.method ?? "GET";
  if (method === "GET") {
    try {
      return sendJson(res, 200, { limits: await currentLimits(deps) });
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (method !== "PUT" && method !== "PATCH") {
    return sendJson(res, 405, {
      error: "method_not_allowed",
      message: "GET or PUT",
    });
  }
  if (!deps.storageLimits) {
    return sendJson(res, 503, {
      error: "storage_limits_unavailable",
      message:
        "this gateway has no storage state directory to persist limits in",
    });
  }
  try {
    const body = (await readJson(req)) as StorageLimitsPatch;
    return sendJson(res, 200, {
      limits: await deps.storageLimits.update(body),
    });
  } catch (error) {
    if (error instanceof StorageLimitsError) {
      return sendJson(res, 400, { error: error.code, message: error.message });
    }
    return sendError(res, error);
  }
}

/** `false` when the path belongs to another storage handler. */
export async function tryStorageLocalRoutes(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: StorageLocalRouteDeps
): Promise<boolean> {
  if (url.pathname === LOCAL_PATH) return handleLocal(url, req, res, deps);
  if (url.pathname === LIMITS_PATH) return handleLimits(req, res, deps);
  return false;
}
