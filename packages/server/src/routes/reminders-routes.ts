import type { IncomingMessage, ServerResponse } from "node:http";

import { ROUTES } from "@centraid/core/protocol";
import { nowIso } from "@centraid/vault";

import { buildDailyBrief } from "../brief/daily-brief.js";
import { computeDueReminders } from "../reminders/due-reminders.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { PairingTicketStore } from "../serve/pairing-store.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { sendError, sendJson } from "./route-helpers.js";

const DUE_PATH = "/centraid/_reminders/due";
const BRIEF_PATH = ROUTES.briefToday;

export function makeRemindersRouteHandler(
  vaults: VaultRegistry,
  devicePairing?: {
    tickets: PairingTicketStore;
    enrollments: EnrollmentStore;
  }
): RouteHandler {
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
          buildDailyBrief(
            vaults.current().gateway,
            vaults.current().ownerCredential,
            { date, from, to, timeZone }
          )
        );
      }
      const pendingInvitations = devicePairing
        ? devicePairing.tickets.listActive().map((ticket) => {
            const owner = devicePairing.enrollments.owners.get(ticket.ownerId);
            return {
              ticketId: ticket.ticketId,
              ownerLabel: owner?.label ?? ticket.ownerId,
              createdAt: ticket.createdAt,
              expiresAt: ticket.expiresAt,
            };
          })
        : [];
      const reminders = computeDueReminders(
        vaults.current().gateway,
        vaults.current().ownerCredential,
        nowIso(),
        undefined,
        pendingInvitations
      );
      return sendJson(res, 200, { reminders });
    } catch (error) {
      return sendError(res, error);
    }
  };
}
