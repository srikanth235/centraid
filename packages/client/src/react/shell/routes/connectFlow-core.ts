/*
 * Pure state machine for ConnectFlow (issue #382) — the wizard shared by
 * onboarding step 2 ("Where does your data live?") and the switcher's
 * "Add gateway" action. Three top-level methods:
 *
 *   - `local`  — the embedded gateway on this Mac. Nothing to configure or
 *     test (it's always reachable); the flow skips straight to picking or
 *     creating a vault on it.
 *   - `gateway` — an existing gateway elsewhere, reached ONLY by a pairing
 *     ticket (iroh discovery by default, or the "Connect by URL" advanced
 *     panel redeeming the same ticket over HTTP for the `direct` transport
 *     tier). The manual URL + admin-token paste was retired in issue #505
 *     phase 7 together with the shared gateway-wide bearer — every gateway is
 *     added through the pairing ceremony, which mints a per-device token.
 *   - `ssh`    — drive a remote `centraid-gateway` CLI over SSH (issue #382
 *     design doc "SSH support (v0 scope = admin channel)").
 *
 * Steps: method → details → test → vault → committing → done | error.
 * `local` skips `details`/`test` (nothing to fill in, nothing to probe) and
 * goes straight to `vault`. Every transition here is a synchronous reducer
 * over an explicit event — no `window.CentraidApi`, no timers, no DOM. The
 * impure IO (testGatewayConnection / redeemGatewayPairing / addGateway /
 * sshConnectGateway / listVaults) lives in `connectFlowIO.ts` and feeds
 * results back in as events, mirroring the flatVaultSwitcher-core.ts /
 * flatVaultSwitcherRegistry.ts split.
 */

export type ConnectMethod = 'local' | 'gateway' | 'ssh';
export type ConnectStep = 'method' | 'details' | 'test' | 'vault' | 'committing' | 'done' | 'error';

/** One stage of the "handshake ladder" — mirrors the design doc's
 *  `ConnectivityReport.stages[]` contract (GATEWAY_TEST_CONNECTION output). */
export interface ConnectivityStage {
  id: 'reach' | 'identify' | 'auth' | 'vaults' | 'ssh' | 'cli' | 'daemon' | 'decode';
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
  gateway?: { version: string; schemaEpoch: number; instanceId: string; compatible: boolean };
  vaults?: ConnectivityVaultPreview[];
  ticket?: { vaultName: string; expiresAt: string; gatewayEndpointId: string };
  error?: string;
}

/** The input union GATEWAY_TEST_CONNECTION accepts (design doc). */
export type ConnectTestInput =
  | { kind: 'ticket'; ticket: string }
  | { kind: 'ssh'; destination: string; dataDir?: string }
  | { kind: 'gateway'; gatewayId: string };

export type VaultChoice = { kind: 'existing'; vaultId: string } | { kind: 'create' };

export interface ConnectFlowResult {
  gatewayId: string;
  vaultId: string;
  displayLabel: string;
}

export interface ConnectFlowState {
  step: ConnectStep;
  method: ConnectMethod | null;

  // "gateway" method details — a pairing ticket, optionally redeemed over an
  // explicit URL (the `direct` transport tier) via the advanced panel.
  ticket: string;
  label: string;
  advancedOpen: boolean;
  url: string;
  /** Explicit consent for a durable replica, intent queue, and media cache. */
  rememberDevice: boolean;

  // "ssh" method details.
  sshDestination: string;
  sshDataDir: string;

  // test step.
  testing: boolean;
  report: ConnectivityReport | null;
  testError: string | null;

  // vault step. `newVaultName` backs `vaultChoice.kind === 'create'`.
  vaultChoice: VaultChoice | null;
  newVaultName: string;

  // commit step.
  committing: boolean;
  commitError: string | null;
  result: ConnectFlowResult | null;
}

export function createInitialConnectFlowState(): ConnectFlowState {
  return {
    advancedOpen: false,
    commitError: null,
    committing: false,
    label: '',
    method: null,
    newVaultName: '',
    report: null,
    result: null,
    rememberDevice: false,
    sshDataDir: '',
    sshDestination: '',
    step: 'method',
    testError: null,
    testing: false,
    ticket: '',
    url: '',
    vaultChoice: null,
  };
}

export type ConnectFlowTextField =
  | 'ticket'
  | 'label'
  | 'url'
  | 'sshDestination'
  | 'sshDataDir'
  | 'newVaultName';

export type ConnectFlowEvent =
  | { type: 'selectMethod'; method: ConnectMethod }
  | { type: 'back' }
  | { type: 'setField'; field: ConnectFlowTextField; value: string }
  | { type: 'setAdvancedOpen'; open: boolean }
  | { type: 'setRememberDevice'; value: boolean }
  | { type: 'startTest' }
  | { type: 'testSettled'; report: ConnectivityReport }
  | { type: 'localVaultsLoaded'; vaults: ConnectivityVaultPreview[] }
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
      };
    }
    case 'setField':
      return { ...state, [event.field]: event.value };
    case 'setAdvancedOpen':
      return { ...state, advancedOpen: event.open };
    case 'setRememberDevice':
      return { ...state, rememberDevice: event.value };
    case 'startTest':
      return { ...state, report: null, step: 'test', testError: null, testing: true };
    case 'testSettled':
      return { ...state, report: event.report, testing: false };
    case 'localVaultsLoaded':
      return {
        ...state,
        report: { ok: true, stages: [], vaults: event.vaults },
      };
    case 'continueToVault': {
      const options = state.report?.vaults ?? [];
      const defaultChoice: VaultChoice | null =
        options.length > 0
          ? { kind: 'existing', vaultId: options[0]!.vaultId }
          : canCreateVaultFor(state)
            ? { kind: 'create' }
            : null;
      return { ...state, step: 'vault', vaultChoice: state.vaultChoice ?? defaultChoice };
    }
    case 'selectVault':
      return { ...state, vaultChoice: event.choice };
    case 'commit':
      return { ...state, commitError: null, committing: true, step: 'committing' };
    case 'commitSettled':
      return { ...state, committing: false, result: event.result, step: 'done' };
    case 'commitFailed':
      return { ...state, commitError: event.error, committing: false, step: 'error' };
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
  if (state.method === 'ssh') {
    if (!state.sshDestination.trim()) return null;
    return {
      dataDir: state.sshDataDir.trim() || undefined,
      destination: state.sshDestination.trim(),
      kind: 'ssh',
    };
  }
  return null;
}

export function canStartTest(state: ConnectFlowState): boolean {
  return buildTestInput(state) !== null;
}

/** Whether the current method can create a brand-new vault as part of this
 *  flow (design doc step C): local and SSH admin the vault lifecycle
 *  directly; a ticket's vault is fixed by the ticket payload. */
export function canCreateVaultFor(state: ConnectFlowState): boolean {
  return state.method === 'local' || state.method === 'ssh';
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
    if (!state.vaultChoice) return false;
    return state.vaultChoice.kind === 'existing' || state.newVaultName.trim().length > 0;
  }
  if (state.method === 'gateway') {
    return state.ticket.trim().length > 0;
  }
  if (state.method === 'ssh') {
    if (!state.sshDestination.trim() || !state.vaultChoice) return false;
    if (state.vaultChoice.kind === 'create' && !state.newVaultName.trim()) return false;
    return true;
  }
  return false;
}
