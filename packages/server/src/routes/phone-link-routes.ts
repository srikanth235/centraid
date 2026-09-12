/*
 * THE DESKTOP VOUCHES FOR THE PHONE IT PAIRED (#1015, ruling R-NY-18).
 *
 * QR pairing writes the desktop's transport allowlist (`devices.json`) and
 * nothing else. That was survivable only while a tunnelled phone borrowed the
 * host's identity — which is the bug R-NY-18 closes. Once the phone is its own
 * principal, the pairing gesture has to CREATE that principal in the vault's
 * enrolment store, and the revoke gesture has to tombstone it, or a member who
 * removes a phone in Settings would leave every vault door open to it.
 *
 * WHY AN HTTP ROUTE AND NOT A CALL. The desktop's gateway is embedded in
 * Electron main on one run and a detached child process on the next; the only
 * seam that is the same in both is the loopback HTTP surface it already
 * speaks. The alternative — the gateway auto-admitting any EndpointId whose
 * forwarding stamp verifies — would make admission a side effect of traffic,
 * and "an enrollment is the ONLY admission" (#603) would stop being true.
 *
 * HOST CUSTODY IS THE WHOLE GATE, and it is the strongest one this gateway
 * has: a loopback request with the bearer that no forwarder touched. A
 * forwarded hop cannot reach it, which is what stops a paired phone enrolling
 * a second device of its own choosing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import { VaultOwnedError } from "../serve/enrollment-store.js";
import { readJson, sendJson } from "./route-helpers.js";

export interface PhoneLinkRouteDeps {
  readonly enrollments: EnrollmentStore;
  /** The host's own device row — the person a paired phone belongs to. */
  readonly hostEndpointId: () => string | undefined;
  readonly isHostCustody: (req: IncomingMessage) => boolean;
}

interface VouchBody {
  action?: unknown;
  endpointId?: unknown;
  label?: unknown;
  platform?: unknown;
}

export function makePhoneLinkRouteHandler(
  deps: PhoneLinkRouteDeps
): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    if ((req.method ?? "GET") !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    if (!deps.isHostCustody(req)) {
      return sendJson(res, 403, {
        error: "host_custody_required",
        message: "only this machine's own desktop may vouch for a phone",
      });
    }
    let body: VouchBody;
    try {
      body = (await readJson(req)) as VouchBody;
    } catch {
      return sendJson(res, 400, { error: "invalid_body" });
    }
    const endpointId =
      typeof body.endpointId === "string" ? body.endpointId.trim() : "";
    if (!endpointId) {
      return sendJson(res, 400, {
        error: "invalid_endpoint",
        message: "endpointId must be a non-empty string",
      });
    }
    const host = deps.hostEndpointId();
    if (host !== undefined && endpointId === host) {
      // Neither verb may address the host's own row: enrolling it is a no-op
      // that would relabel the desktop after a phone, and revoking it would
      // lock the member out of their own machine from the phone panel.
      return sendJson(res, 409, {
        error: "host_row_is_not_a_phone",
        message: "this EndpointId is the host's own device row",
      });
    }

    if (body.action === "revoke") {
      const revoked = deps.enrollments.revoke(endpointId);
      return sendJson(res, 200, {
        ok: true,
        action: "revoke",
        endpointId,
        revoked: revoked.length,
      });
    }
    if (body.action !== "enrol") {
      return sendJson(res, 400, {
        error: "invalid_action",
        message: 'action must be "enrol" or "revoke"',
      });
    }

    // The phone belongs to the person the HOST belongs to; it is never a new
    // household member. A gateway whose host row has no owner yet has nothing
    // to attach the phone to, and says so rather than inventing one.
    const owner = host ? deps.enrollments.ownerFor(host) : undefined;
    if (!owner) {
      return sendJson(res, 409, {
        error: "host_not_enrolled",
        message:
          "this gateway has no enrolled host device to attach a phone to",
      });
    }
    const label =
      typeof body.label === "string" && body.label.trim()
        ? body.label.trim()
        : `phone ${endpointId.slice(0, 10)}…`;
    try {
      // Re-pairing a phone the member previously revoked CLEARS the tombstone:
      // scanning the code again is the same admission gesture as the first
      // scan, made at the same desk, and refusing it would leave a phone the
      // member can pair but never use.
      const enrolled = deps.enrollments.enroll({
        endpointId,
        ownerId: owner.ownerId,
        label,
        ...(typeof body.platform === "string"
          ? { platform: body.platform }
          : {}),
      });
      return sendJson(res, 200, {
        ok: true,
        action: "enrol",
        endpointId,
        ownerId: enrolled.ownerId,
        vaultIds: deps.enrollments.vaultsFor(endpointId),
      });
    } catch (error) {
      if (error instanceof VaultOwnedError) {
        return sendJson(res, 409, {
          error: "vault_owned",
          message: error.message,
        });
      }
      return sendJson(res, 409, {
        error: "enrolment_refused",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
