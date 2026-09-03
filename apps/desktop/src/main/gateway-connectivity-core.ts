/*
 * Pure core for GATEWAY_TEST_CONNECTION (#382) — the ConnectFlow handshake
 * ladder. Raw signals fold into `ConnectivityStage`s here;
 * `gateway-connectivity.ts` owns the network calls, folding in sequence,
 * skipping stages once one fails. Same electron-free split as
 * `gateway-pairing-core.ts`.
 */
import {
  decodePairingTicket,
  isTicketExpired,
} from "./gateway-pairing-core.js";
import type { PairingTicketPayload } from "./gateway-pairing-core.js";
import type { ListGatewayVaultsResult } from "./gateway-vaults-core.js";
import type { HandshakeResult } from "./version-handshake.js";

export type ConnectivityStageId =
  | "reach"
  | "identify"
  | "auth"
  | "vaults"
  | "decode";

export type ConnectivityStageStatus = "pass" | "fail" | "skip";

export interface ConnectivityStage {
  id: ConnectivityStageId;
  label: string;
  status: ConnectivityStageStatus;
  detail?: string;
}

export interface ConnectivityGatewayInfo {
  version: string;
  protocolVersion: number;
  minSupportedProtocol: number;
  instanceId: string;
  compatible: boolean;
}

export interface ConnectivityVaultEntry {
  vaultId: string;
  name: string;
  color?: string;
  icon?: string;
}

export interface ConnectivityTicketInfo {
  vaultName: string;
  expiresAt: string;
  gatewayEndpointId: string;
}

export interface ConnectivityReport {
  ok: boolean;
  stages: ConnectivityStage[];
  gateway?: ConnectivityGatewayInfo;
  vaults?: ConnectivityVaultEntry[];
  ticket?: ConnectivityTicketInfo;
  error?: string;
}

export function stage(
  id: ConnectivityStageId,
  label: string,
  status: ConnectivityStageStatus,
  detail?: string
): ConnectivityStage {
  return { id, label, status, ...(detail ? { detail } : {}) };
}

const STAGE_LABEL: Record<ConnectivityStageId, string> = {
  reach: "Reach gateway",
  identify: "Identify gateway",
  auth: "Check credentials",
  vaults: "List vaults",
  decode: "Decode ticket",
};

function s(
  id: ConnectivityStageId,
  status: ConnectivityStageStatus,
  detail?: string
): ConnectivityStage {
  return stage(id, STAGE_LABEL[id], status, detail);
}

export function assembleReport(
  stages: ConnectivityStage[],
  extra: {
    gateway?: ConnectivityGatewayInfo;
    vaults?: ConnectivityVaultEntry[];
    ticket?: ConnectivityTicketInfo;
    error?: string;
  } = {}
): ConnectivityReport {
  const ok = stages.length > 0 && stages.every((st) => st.status !== "fail");
  return {
    ok,
    stages,
    ...(extra.gateway ? { gateway: extra.gateway } : {}),
    ...(extra.vaults ? { vaults: extra.vaults } : {}),
    ...(extra.ticket ? { ticket: extra.ticket } : {}),
    ...(!ok && extra.error ? { error: extra.error } : {}),
  };
}

// ── url / gateway kind: reach → identify → auth ─────────────────────────
/**
 * Fold a `handshakeGateway` result into reach/identify/auth. It collapses all
 * non-2xx into `reason: 'unreachable'` but its `detail` still carries
 * `HTTP <status>` when a response DID arrive — the thread pulled here to split
 * no-response (reach) from 401/403 (auth) from other bad responses (identify).
 * Exceptions never match `HTTP <digits>` → true reach-failure.
 */
export function foldUrlIdentityStages(handshake: HandshakeResult): {
  stages: ConnectivityStage[];
  gateway?: ConnectivityGatewayInfo;
  errorCode?: string;
} {
  if (handshake.ok) {
    return {
      stages: [s("reach", "pass"), s("identify", "pass"), s("auth", "pass")],
      gateway: {
        version: handshake.info.version,
        protocolVersion: handshake.info.protocolVersion,
        minSupportedProtocol: handshake.info.minSupportedProtocol,
        instanceId: handshake.info.instanceId ?? "",
        compatible: true,
      },
    };
  }

  const statusMatch = /^HTTP (?<status>\d+)$/u.exec(handshake.detail);
  const status =
    statusMatch?.groups?.status === undefined
      ? undefined
      : Number(statusMatch.groups.status);

  if (status === undefined) {
    if (handshake.reason === "unreachable") {
      return {
        stages: [
          s("reach", "fail", handshake.detail),
          s("identify", "skip"),
          s("auth", "skip"),
        ],
        errorCode: "unreachable",
      };
    }
    return {
      stages: [
        s("reach", "pass"),
        s("identify", "fail", handshake.detail),
        s("auth", "pass"),
      ],
      errorCode: handshake.reason,
    };
  }
  if (status === 401 || status === 403) {
    return {
      stages: [
        s("reach", "pass"),
        s("identify", "skip"),
        s("auth", "fail", "Gateway rejected the bearer token."),
      ],
      errorCode: "auth_failed",
    };
  }
  return {
    stages: [
      s("reach", "pass"),
      s("identify", "fail", handshake.detail),
      s("auth", "pass"),
    ],
    errorCode: "unreachable",
  };
}

export function foldVaultsStageFromHttp(result: ListGatewayVaultsResult): {
  stage: ConnectivityStage;
  vaults?: ConnectivityVaultEntry[];
  errorCode?: string;
} {
  if (!result.ok) {
    const detail =
      result.error === "auth_failed"
        ? "Gateway rejected the bearer token."
        : result.error === "bad_response"
          ? "Gateway returned an unexpected response."
          : "Could not reach the gateway.";
    return { stage: s("vaults", "fail", detail), errorCode: result.error };
  }
  return {
    stage: s("vaults", "pass"),
    vaults: result.vaults.map((v) => ({
      vaultId: v.vaultId,
      name: v.name,
      ...(v.color ? { color: v.color } : {}),
      ...(v.icon ? { icon: v.icon } : {}),
    })),
  };
}

export function reachGuardFailureStages(message: string): ConnectivityStage[] {
  return [
    s("reach", "fail", message),
    s("identify", "skip"),
    s("auth", "skip"),
  ];
}

export function buildTicketReport(
  rawTicket: string,
  now = Date.now()
): ConnectivityReport {
  const payload: PairingTicketPayload | undefined =
    decodePairingTicket(rawTicket);
  if (!payload) {
    return assembleReport(
      [s("decode", "fail", "That pairing code is not valid.")],
      {
        error: "invalid_ticket",
      }
    );
  }
  if (isTicketExpired(payload, now)) {
    return assembleReport(
      [s("decode", "fail", "This pairing code has expired.")],
      {
        error: "ticket_expired",
      }
    );
  }
  return assembleReport([s("decode", "pass")], {
    ticket: {
      vaultName: payload.vaultName,
      expiresAt: new Date(payload.exp).toISOString(),
      gatewayEndpointId: payload.gw,
    },
  });
}
