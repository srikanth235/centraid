/*
 * Pure state machine for ConnectFlow (issue #382) — the wizard shared by
 * onboarding's ticket path and the switcher's "Add gateway" action. Two
 * top-level methods:
 *
 *   - `local`  — the embedded gateway on this Mac. Nothing to configure or
 *     test (it's always reachable); the flow skips straight to picking or
 *     creating a vault on it.
 *   - `gateway` — an existing gateway elsewhere, reached ONLY by a pairing
 *     ticket over iroh. URL pairing and per-device bearers were retired in
 *     issue #555; the QUIC identity is the enrollment credential.
 *
 * The third method, `ssh`, was deleted in issue #603: driving a remote
 * `centraid-gateway` CLI over SSH was an admin channel, not an onboarding
 * path, and a pair ticket now covers every remote connect.
 *
 * Steps: method → details → test → vault → committing → done | error.
 * `local` skips `details`/`test` (nothing to fill in, nothing to probe) and
 * goes straight to `vault`. Every transition here is a synchronous reducer
 * over an explicit event — no `window.CentraidApi`, no timers, no DOM. The
 * impure IO (testGatewayConnection / redeemGatewayPairing / addGateway /
 * listVaults) lives in `connectFlowIO.ts` and feeds results back in as
 * events, mirroring the gatewayRegistry.ts pure-core / impure-glue split.
 */

export type ConnectMethod = 'local' | 'gateway';
export type ConnectStep = 'method' | 'details' | 'test' | 'vault' | 'committing' | 'done' | 'error';

/** One stage of the "handshake ladder" — mirrors the design doc's
 *  `ConnectivityReport.stages[]` contract (GATEWAY_TEST_CONNECTION output). */
export interface ConnectivityStage {
  id: 'reach' | 'identify' | 'auth' | 'vaults' | 'decode';
  label: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

export interface ConnectivityVaultPreview {
  vaultId: string;
  name: string;
  color?: string;
  icon?: string;
}

/** Mirrors the design doc's `ConnectivityReport` (GATEWAY_TEST_CONNECTION
 *  output) — never a rejection, always this shape. */
export interface ConnectivityReport {
  ok: boolean;
  stages: ConnectivityStage[];
  gateway?: {
    version: string;
    schemaEpoch: number;
    instanceId: string;
    compatible: boolean;
  };
  vaults?: ConnectivityVaultPreview[];
  ticket?: { vaultName: string; expiresAt: string; gatewayEndpointId: string };
  error?: string;
}

/** The input union GATEWAY_TEST_CONNECTION accepts (design doc). */
export type ConnectTestInput =
  | { kind: 'ticket'; ticket: string }
  | { kind: 'gateway'; gatewayId: string };

export type VaultChoice = { kind: 'existing'; vaultId: string } | { kind: 'create' };

export interface ConnectFlowResult {
  gatewayId: string;
  vaultId: string;
  displayLabel: string;
}

/** Outcome of reading the local gateway's vaults (issue #603 W4). A transport
 *  failure is NOT an empty registry — the vault step renders them differently,
 *  so the two cases stay distinguishable all the way to the UI. */
export type LocalVaultsResult =
  | { ok: true; vaults: ConnectivityVaultPreview[] }
  | { ok: false; message: string };

export interface ConnectFlowState {
  step: ConnectStep;
  method: ConnectMethod | null;

  // "gateway" method details — one iroh pairing ticket.
  ticket: string;
  label: string;
  /** Explicit consent for a durable replica, intent queue, and media cache. */
  rememberDevice: boolean;

  // test step.
  testing: boolean;
  report: ConnectivityReport | null;
  testError: string | null;

  // vault step. `newVaultName` backs `vaultChoice.kind === 'create'`.
  vaultChoice: VaultChoice | null;
  newVaultName: string;
  /** Why the local vault list could not be read. Never set for an empty but
   *  successfully-read registry. */
  vaultsError: string | null;

  // commit step.
  committing: boolean;
  commitError: string | null;
  result: ConnectFlowResult | null;
}

/**
 * `method` pre-selects a method and lands on its first real step — used when
 * the host already made the choice (onboarding's ticket path, issue #603) and
 * a one-card method grid would just be a redundant click.
 */
export function createInitialConnectFlowState(
  method: ConnectMethod | null = null,
): ConnectFlowState {
  const base: ConnectFlowState = {
    commitError: null,
    committing: false,
    label: '',
    method: null,
    newVaultName: '',
    report: null,
    result: null,
    rememberDevice: false,
    step: 'method',
    testError: null,
    testing: false,
    ticket: '',
    vaultChoice: null,
    vaultsError: null,
  };
  return method ? connectFlowReducer(base, { method, type: 'selectMethod' }) : base;
}

export type ConnectFlowTextField = 'ticket' | 'label' | 'newVaultName';

export type ConnectFlowEvent =
  | { type: 'selectMethod'; method: ConnectMethod }
  | { type: 'back' }
  | { type: 'setField'; field: ConnectFlowTextField; value: string }
  | { type: 'setRememberDevice'; value: boolean }
  | { type: 'startTest' }
  | { type: 'testSettled'; report: ConnectivityReport }
  | { type: 'localVaultsLoaded'; result: LocalVaultsResult }
  | { type: 'continueToVault' }
  | { type: 'selectVault'; choice: VaultChoice }
  | { type: 'commit' }
  | { type: 'commitSettled'; result: ConnectFlowResult }
  | { type: 'commitFailed'; error: string }
  | { type: 'reset' };

const STEP_ORDER: readonly ConnectStep[] = ['method', 'details', 'test', 'vault'];

export function connectFlowReducer(
  state: ConnectFlowState,
  event: ConnectFlowEvent,
): ConnectFlowState {
  switch (event.type) {
    case 'selectMethod': {
      const base = { ...createInitialConnectFlowState(), method: event.method };
      // `local` has nothing to fill in or probe — the embedded gateway is
      // always reachable — so it skips straight to picking/creating a vault.
      return { ...base, step: event.method === 'local' ? 'vault' : 'details' };
    }
    case 'back': {
      if (state.step === 'error') {
        return { ...state, commitError: null, step: 'vault' };
      }
      const idx = STEP_ORDER.indexOf(state.step);
      if (idx <= 0) {
        return { ...createInitialConnectFlowState() };
      }
      // Local skips `details`/`test` in both directions.
      const prevIdx = state.method === 'local' && STEP_ORDER[idx] === 'vault' ? 0 : idx - 1;
      const prev = STEP_ORDER[prevIdx] ?? 'method';
      return {
        ...state,
        method: prev === 'method' ? null : state.method,
        report: prev === 'test' ? state.report : null,
        step: prev,
        testError: null,
        vaultChoice: null,
        vaultsError: null,
      };
    }
    case 'setField':
      return { ...state, [event.field]: event.value };
    case 'setRememberDevice':
      return { ...state, rememberDevice: event.value };
    case 'startTest':
      return {
        ...state,
        report: null,
        step: 'test',
        testError: null,
        testing: true,
      };
    case 'testSettled':
      return { ...state, report: event.report, testing: false };
    case 'localVaultsLoaded':
      // A failed read still settles `report` so the step leaves its loading
      // state — `vaultsError` is what tells the UI it settled UNHAPPILY.
      return event.result.ok
        ? {
            ...state,
            report: { ok: true, stages: [], vaults: event.result.vaults },
            vaultsError: null,
          }
        : {
            ...state,
            report: { ok: false, stages: [], vaults: [] },
            vaultsError: event.result.message,
          };
    case 'continueToVault': {
      const options = state.report?.vaults ?? [];
      const defaultChoice: VaultChoice | null =
        options.length > 0
          ? { kind: 'existing', vaultId: options[0]!.vaultId }
          : canCreateVaultFor(state)
            ? { kind: 'create' }
            : null;
      return {
        ...state,
        step: 'vault',
        vaultChoice: state.vaultChoice ?? defaultChoice,
      };
    }
    case 'selectVault':
      return { ...state, vaultChoice: event.choice };
    case 'commit':
      return {
        ...state,
        commitError: null,
        committing: true,
        step: 'committing',
      };
    case 'commitSettled':
      return {
        ...state,
        committing: false,
        result: event.result,
        step: 'done',
      };
    case 'commitFailed':
      return {
        ...state,
        commitError: event.error,
        committing: false,
        step: 'error',
      };
    case 'reset':
      return createInitialConnectFlowState();
    default:
      return state;
  }
}

/** Input for GATEWAY_TEST_CONNECTION given the current details, or `null`
 *  when nothing testable has been supplied yet (`local` never has one). */
export function buildTestInput(state: ConnectFlowState): ConnectTestInput | null {
  if (state.method === 'gateway') {
    if (!state.ticket.trim()) return null;
    return { kind: 'ticket', ticket: state.ticket.trim() };
  }
  return null;
}

export function canStartTest(state: ConnectFlowState): boolean {
  return buildTestInput(state) !== null;
}

/** Whether the current method can create a brand-new vault as part of this
 *  flow (design doc step C): the desktop admins its own embedded gateway's
 *  vault lifecycle; a ticket's vault is fixed by the ticket payload. */
export function canCreateVaultFor(state: ConnectFlowState): boolean {
  return state.method === 'local';
}

export interface ConnectVaultCapability {
  /** Set only for a ticket-mode "Existing gateway" connect — the vault is
   *  fixed by the ticket payload, shown as a locked, non-selectable row. */
  locked: { vaultName: string } | null;
  options: ConnectivityVaultPreview[];
  canCreate: boolean;
}

export function vaultCapability(state: ConnectFlowState): ConnectVaultCapability {
  if (state.method === 'gateway') {
    return {
      canCreate: false,
      locked: state.report?.ticket ? { vaultName: state.report.ticket.vaultName } : null,
      options: [],
    };
  }
  return {
    canCreate: canCreateVaultFor(state),
    locked: null,
    options: state.report?.vaults ?? [],
  };
}

export function canCommitConnectFlow(state: ConnectFlowState): boolean {
  if (state.method === 'local') {
    if (state.vaultsError || !state.vaultChoice) return false;
    return state.vaultChoice.kind === 'existing' || state.newVaultName.trim().length > 0;
  }
  if (state.method === 'gateway') {
    return state.ticket.trim().length > 0;
  }
  return false;
}
