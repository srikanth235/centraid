/*
 * Pure core for GATEWAY_TEST_CONNECTION (issue #382) — the ConnectFlow
 * "handshake ladder". Every raw signal (a fetch outcome, an ssh-host
 * result, a decoded ticket) is folded into `ConnectivityStage`s here;
 * `gateway-connectivity.ts` owns the actual network/ssh calls and threads
 * their results through these fold functions in sequence, skipping later
 * stages once an earlier one fails (the "ladder" never runs a step whose
 * precondition didn't pass). Same "electron-free pure core" split as
 * `gateway-pairing-core.ts` / `ssh-host-core.ts`.
 */

import {
  decodePairingTicket,
  isTicketExpired,
  type PairingTicketPayload,
} from './gateway-pairing-core.js';
import type { HandshakeResult } from './version-handshake.js';
import type { ListGatewayVaultsResult } from './gateway-vaults-core.js';
import type { SshCommandResult, SshFailureCode } from './ssh-host.js';

export type ConnectivityStageId =
  | 'reach'
  | 'identify'
  | 'auth'
  | 'vaults'
  | 'ssh'
  | 'cli'
  | 'daemon'
  | 'decode';

export type ConnectivityStageStatus = 'pass' | 'fail' | 'skip';

export interface ConnectivityStage {
  id: ConnectivityStageId;
  label: string;
  status: ConnectivityStageStatus;
  detail?: string;
}

export interface ConnectivityGatewayInfo {
  version: string;
  schemaEpoch: number;
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
  /** Stable code for the FIRST failing stage — absent when `ok`. */
  error?: string;
}

export function stage(
  id: ConnectivityStageId,
  label: string,
  status: ConnectivityStageStatus,
  detail?: string,
): ConnectivityStage {
  return { id, label, status, ...(detail ? { detail } : {}) };
}

const STAGE_LABEL: Record<ConnectivityStageId, string> = {
  reach: 'Reach gateway',
  identify: 'Identify gateway',
  auth: 'Check credentials',
  vaults: 'List vaults',
  ssh: 'Reach host',
  cli: 'centraid-gateway CLI',
  daemon: 'Daemon status',
  decode: 'Decode ticket',
};

function s(
  id: ConnectivityStageId,
  status: ConnectivityStageStatus,
  detail?: string,
): ConnectivityStage {
  return stage(id, STAGE_LABEL[id], status, detail);
}

/** Assemble the final report: `ok` iff no stage failed; `error` carries the
 *  caller-supplied code for the first failure (undefined when `ok`). */
export function assembleReport(
  stages: ConnectivityStage[],
  extra: {
    gateway?: ConnectivityGatewayInfo;
    vaults?: ConnectivityVaultEntry[];
    ticket?: ConnectivityTicketInfo;
    error?: string;
  } = {},
): ConnectivityReport {
  const ok = stages.length > 0 && stages.every((st) => st.status !== 'fail');
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
 * Fold a `handshakeGateway` result into the reach/identify/auth trio.
 * `handshakeGateway` itself collapses every non-2xx response into
 * `reason: 'unreachable'` (see its doc comment), but its `detail` string
 * still carries `HTTP <status>` for a response that DID arrive — that's the
 * one thread we pull on to split "never got a response" (reach fails) from
 * "got a 401/403" (auth fails) from "got some other bad response" (identify
 * fails, host is up). A genuine network exception's detail is the raw error
 * message and never matches `HTTP <digits>`, so it falls into the true
 * reach-failure branch.
 */
export function foldUrlIdentityStages(handshake: HandshakeResult): {
  stages: ConnectivityStage[];
  gateway?: ConnectivityGatewayInfo;
  errorCode?: string;
} {
  if (handshake.ok) {
    return {
      stages: [s('reach', 'pass'), s('identify', 'pass'), s('auth', 'pass')],
      gateway: {
        version: handshake.info.version,
        schemaEpoch: handshake.info.schemaEpoch,
        instanceId: handshake.info.instanceId ?? '',
        compatible: true,
      },
    };
  }

  const statusMatch = /^HTTP (\d+)$/.exec(handshake.detail);
  const status = statusMatch?.[1] !== undefined ? Number(statusMatch[1]) : undefined;

  if (status === undefined) {
    // No HTTP response reached us at all (or the body wasn't even parseable
    // JSON — `malformed` with no HTTP-status detail reads the same way here).
    if (handshake.reason === 'unreachable') {
      return {
        stages: [s('reach', 'fail', handshake.detail), s('identify', 'skip'), s('auth', 'skip')],
        errorCode: 'unreachable',
      };
    }
    return {
      stages: [s('reach', 'pass'), s('identify', 'fail', handshake.detail), s('auth', 'pass')],
      errorCode: handshake.reason,
    };
  }
  if (status === 401 || status === 403) {
    return {
      stages: [
        s('reach', 'pass'),
        s('identify', 'skip'),
        s('auth', 'fail', 'Gateway rejected the bearer token.'),
      ],
      errorCode: 'auth_failed',
    };
  }
  return {
    stages: [s('reach', 'pass'), s('identify', 'fail', handshake.detail), s('auth', 'pass')],
    errorCode: 'unreachable',
  };
}

/** The `vaults` stage — shared by `url`/`gateway`/`ssh` kinds. */
export function foldVaultsStageFromHttp(result: ListGatewayVaultsResult): {
  stage: ConnectivityStage;
  vaults?: ConnectivityVaultEntry[];
  errorCode?: string;
} {
  if (!result.ok) {
    const detail =
      result.error === 'auth_failed'
        ? 'Gateway rejected the bearer token.'
        : result.error === 'bad_response'
          ? 'Gateway returned an unexpected response.'
          : 'Could not reach the gateway.';
    return { stage: s('vaults', 'fail', detail), errorCode: result.error };
  }
  return {
    stage: s('vaults', 'pass'),
    vaults: result.vaults.map((v) => ({
      vaultId: v.vaultId,
      name: v.name,
      ...(v.color ? { color: v.color } : {}),
      ...(v.icon ? { icon: v.icon } : {}),
    })),
  };
}

/** A `reach` failure that never got as far as a fetch at all — the
 *  `assertDirectUrlAllowed` guardrail rejecting a plain-http-to-public-host
 *  URL before any network call is made. */
export function reachGuardFailureStages(message: string): ConnectivityStage[] {
  return [s('reach', 'fail', message), s('identify', 'skip'), s('auth', 'skip')];
}

// ── ticket kind: decode only ────────────────────────────────────────────

/**
 * Pure client-side ticket decode + expiry check — no dial, per the design
 * doc ("the redemption itself is the live test"). `gatewayEndpointId` is
 * the ticket's raw iroh EndpointTicket string (`payload.gw`), not a parsed
 * EndpointId: decoding that requires the iroh native binding, which this
 * client-side-only check has no other reason to load, and the raw ticket
 * string already serves the same practical purpose (a stable per-gateway
 * identifier — it's exactly what `findReusableProfile` dedupes profiles on).
 */
export function buildTicketReport(rawTicket: string, now = Date.now()): ConnectivityReport {
  const payload: PairingTicketPayload | undefined = decodePairingTicket(rawTicket);
  if (!payload) {
    return assembleReport([s('decode', 'fail', 'That pairing code is not valid.')], {
      error: 'invalid_ticket',
    });
  }
  if (isTicketExpired(payload, now)) {
    return assembleReport([s('decode', 'fail', 'This pairing code has expired.')], {
      error: 'ticket_expired',
    });
  }
  return assembleReport([s('decode', 'pass')], {
    ticket: {
      vaultName: payload.vaultName,
      expiresAt: new Date(payload.exp).toISOString(),
      gatewayEndpointId: payload.gw,
    },
  });
}

// ── ssh kind: ssh → cli → daemon → vaults ───────────────────────────────

/** Fold `sshVersion`'s result into the ssh-reachable + cli-present pair —
 *  one ssh round trip answers both ("command not found" still proves the
 *  HOST was reachable; only the remote CLI is missing). */
export function foldSshVersionStages(result: SshCommandResult<string>): {
  ssh: ConnectivityStage;
  cli: ConnectivityStage;
  errorCode?: string;
} {
  if (result.ok) {
    return { ssh: s('ssh', 'pass'), cli: s('cli', 'pass', result.value) };
  }
  if (result.error === 'cli_not_found') {
    return {
      ssh: s('ssh', 'pass'),
      cli: s('cli', 'fail', result.message),
      errorCode: result.error,
    };
  }
  return {
    ssh: s('ssh', 'fail', result.message),
    cli: s('cli', 'skip'),
    errorCode: result.error,
  };
}

export function foldSshStatusStage(result: SshCommandResult<Record<string, unknown>>): {
  stage: ConnectivityStage;
  errorCode?: string;
} {
  if (result.ok) return { stage: s('daemon', 'pass') };
  return { stage: s('daemon', 'fail', result.message), errorCode: result.error };
}

export function foldSshVaultsStage(
  result: SshCommandResult<{ vaults: Array<Record<string, unknown>> }>,
): { stage: ConnectivityStage; vaults?: ConnectivityVaultEntry[]; errorCode?: string } {
  if (!result.ok) return { stage: s('vaults', 'fail', result.message), errorCode: result.error };
  const vaults: ConnectivityVaultEntry[] = [];
  for (const row of result.value.vaults) {
    if (typeof row.vaultId === 'string' && typeof row.name === 'string') {
      vaults.push({
        vaultId: row.vaultId,
        name: row.name,
        ...(typeof row.color === 'string' ? { color: row.color } : {}),
        ...(typeof row.icon === 'string' ? { icon: row.icon } : {}),
      });
    }
  }
  return { stage: s('vaults', 'pass'), vaults };
}

/** `ssh`/`cli`/`daemon` stages that never ran because an earlier one in the
 *  ladder already failed (used by the orchestrator to fill in `skip`s
 *  without re-deriving the label/id boilerplate). */
export function skippedSshStage(id: 'ssh' | 'cli' | 'daemon' | 'vaults'): ConnectivityStage {
  return s(id, 'skip');
}

export type { SshFailureCode };
