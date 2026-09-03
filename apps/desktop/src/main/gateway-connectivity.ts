import {
  assembleReport,
  buildTicketReport,
  foldUrlIdentityStages,
  foldVaultsStageFromHttp,
  reachGuardFailureStages,
  stage,
} from "./gateway-connectivity-core.js";
import type { ConnectivityReport } from "./gateway-connectivity-core.js";
import { resolveGateway } from "./gateway-store.js";
import { fetchGatewayVaults } from "./gateway-vaults-core.js";
import { handshakeGateway } from "./version-handshake.js";

export type { ConnectivityReport } from "./gateway-connectivity-core.js";

export type TestConnectionInput =
  | { kind: "ticket"; ticket: string }
  | { kind: "gateway"; gatewayId: string };

async function testUrl(
  url: string,
  token: string | undefined
): Promise<ConnectivityReport> {
  const handshake = await handshakeGateway(url, token);
  const identity = foldUrlIdentityStages(handshake);
  const authStage = identity.stages.find((st) => st.id === "auth");

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
  } catch (error) {
    return assembleReport([], {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
