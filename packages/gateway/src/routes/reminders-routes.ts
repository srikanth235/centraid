/*
 * `GET /centraid/_reminders/due` — every task/event reminder whose fire
 * time has arrived (`schedule_task.remind_before_min` / `core_event`'s
 * `schedule_event_ext.reminders_json`), computed live against the request
 * time. Stateless on purpose (see reminders/due-reminders.ts) — the desktop
 * main process's poller owns "have I already surfaced this one" bookkeeping,
 * the same split gateway-monitor.ts already uses for the downtime alert.
 * Behind the host bearer check like every non-public route.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "@centraid/protocol";
import { nowIso } from "@centraid/vault";

import { buildDailyBrief } from "../brief/daily-brief.js";
import { computeDueReminders } from "../reminders/due-reminders.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { sendError, sendJson } from "./route-helpers.js";

const DUE_PATH = "/centraid/_reminders/due";
const BRIEF_PATH = ROUTES.briefToday;

export function makeRemindersRouteHandler(vaults: VaultRegistry): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== DUE_PATH && url.pathname !== BRIEF_PATH) return false;
    if ((req.method ?? "GET") !== "GET") {
      return sendJson(res, 405, {
        error: "method_not_allowed",
        message: "GET only",
      });
    }
    try {
      if (url.pathname === BRIEF_PATH) {
        const date = url.searchParams.get("date");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const timeZone = url.searchParams.get("timeZone") ?? "UTC";
        if (!date || !from || !to) {
          return sendJson(res, 400, {
            error: "invalid_range",
            message: "date, from, and to are required",
          });
        }
        return sendJson(
          res,
          200,
          buildDailyBrief(vaults.current().db, {
            date,
            from,
            to,
            timeZone,
          })
        );
      }
      const reminders = computeDueReminders(vaults.current().db, nowIso());
      return sendJson(res, 200, { reminders });
    } catch (error) {
      return sendError(res, error);
    }
  };
}
