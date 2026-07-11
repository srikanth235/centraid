/*
 * `GET /centraid/_reminders/due` — every task/event reminder whose fire
 * time has arrived (`schedule_task.remind_before_min` / `core_event`'s
 * `schedule_event_ext.reminders_json`), computed live against the request
 * time. Stateless on purpose (see reminders/due-reminders.ts) — the desktop
 * main process's poller owns "have I already surfaced this one" bookkeeping,
 * the same split gateway-monitor.ts already uses for the downtime alert.
 * Behind the host bearer check like every non-public route.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { nowIso } from '@centraid/vault';
import { computeDueReminders } from '../reminders/due-reminders.js';
import { sendError, sendJson } from './route-helpers.js';

const DUE_PATH = '/centraid/_reminders/due';

export function makeRemindersRouteHandler(vaults: VaultRegistry): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== DUE_PATH) return false;
    if ((req.method ?? 'GET') !== 'GET') {
      return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
    }
    try {
      const reminders = computeDueReminders(vaults.current().db, nowIso());
      return sendJson(res, 200, { reminders });
    } catch (err) {
      return sendError(res, err);
    }
  };
}
