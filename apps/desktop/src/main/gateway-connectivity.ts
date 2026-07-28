/*
 * GATEWAY_TEST_CONNECTION (issue #382) — the ConnectFlow "handshake ladder".
 * Wires `handshakeGateway` (version-handshake.ts) and
 * `fetchGatewayVaults`/`foldVaultsResponse` (gateway-vaults-core.ts) through
 * the pure fold functions in `gateway-connectivity-core.ts`. Never throws —
 * every failure is a failed stage with a human-actionable detail, per the
 * frozen IPC contract. (Issue #603 deleted the `ssh` ladder with the rest of
 * the SSH-connect feature; only ticket + known-gateway remain.)
 */

import {
  assembleReport,
  buildTicketReport,
  foldUrlIdentityStages,
  foldVaultsStageFromHttp,
  reachGuardFailureStages,
  stage,
  type ConnectivityReport,
} from "./gateway-connectivity-core.js";
import { resolveGateway } from "./gateway-store.js";
import { fetchGatewayVaults } from "./gateway-vaults-core.js";
import { handshakeGateway } from "./version-handshake.js";

export type { ConnectivityReport } from "./gateway-connectivity-core.js";

export type TestConnectionInput =
  | { kind: "ticket"; ticket: string }
  | { kind: "gateway"; gatewayId: string };

/** Run the known-gateway ladder against its local iroh proxy. */
async function testUrl(
  url: string,
  token: string | undefined
): Promise<ConnectivityReport> {
  const handshake = await handshakeGateway(url, token);
  const identity = foldUrlIdentityStages(handshake);
  const authStage = identity.stages.find((st) => st.id === "auth");

  // Only attempt the vaults read once reach + auth both passed — identify
  // failing (a version mismatch) doesn't block browsing vaults, but an
  // unreachable host or a rejected token does.
  if (authStage?.status !== "pass") {
    return assembleReport(
      [...identity.stages, stage("vaults", "List vaults", "skip")],
      {
        ...(identity.gateway ? { gateway: identity.gateway } : {}),
        ...(identity.errorCode ? { error: identity.errorCode } : {}),
      }
    );
  }

  const vaultsResult = await fetchGatewayVaults(url, token);
  const folded = foldVaultsStageFromHttp(vaultsResult);
  return assembleReport([...identity.stages, folded.stage], {
    ...(identity.gateway ? { gateway: identity.gateway } : {}),
    ...(folded.vaults ? { vaults: folded.vaults } : {}),
    ...(identity.errorCode
      ? { error: identity.errorCode }
      : folded.errorCode
        ? { error: folded.errorCode }
        : {}),
  });
}

export async function testGatewayConnection(
  input: TestConnectionInput
): Promise<ConnectivityReport> {
  try {
    switch (input.kind) {
      case "ticket":
        return buildTicketReport(input.ticket);

      case "gateway": {
        const resolved = await resolveGateway(input.gatewayId);
        if (!resolved || !resolved.url) {
          return assembleReport(
            reachGuardFailureStages("Unknown or unreachable gateway."),
            {
              error: "unknown_gateway",
            }
          );
        }
        return await testUrl(resolved.url, resolved.token || undefined);
      }

      default:
        return assembleReport([], { error: "bad_input" });
    }
  } catch (err) {
    // Belt-and-suspenders: the contract promises this never throws even if
    // something upstream (a store read, a malformed input) does.
    return assembleReport([], {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
