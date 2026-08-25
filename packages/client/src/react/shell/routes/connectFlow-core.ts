// Pure state machine for ConnectFlow (#382); `local` skips details/test. A
// remote gateway is reached ONLY by a pairing ticket — no URL pairing, no
// per-device bearer (#555). Impure IO is in `connectFlowIO.ts`.

export type ConnectMethod = "local" | "gateway";
export type ConnectStep =
  | "method"
  | "details"
  | "test"
  | "vault"
  | "committing"
  | "done"
  | "error";

export interface ConnectivityStage {
  id: "reach" | "identify" | "auth" | "vaults" | "decode";
  label: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

export interface ConnectivityVaultPreview {
  vaultId: string;
  name: string;
  color?: string;
  icon?: string;
  personal?: boolean;
}

/** GATEWAY_TEST_CONNECTION never rejects — always this shape. */
export interface ConnectivityReport {
  ok: boolean;
  stages: ConnectivityStage[];
  gateway?: {
    version: string;
    protocolVersion: number;
    instanceId: string;
    compatible: boolean;
  };
  vaults?: ConnectivityVaultPreview[];
  ticket?: { vaultName: string; expiresAt: string; gatewayEndpointId: string };
  error?: string;
}

export type ConnectTestInput =
  | { kind: "ticket"; ticket: string }
  | { kind: "gateway"; gatewayId: string };

export type VaultChoice =
  | { kind: "existing"; vaultId: string }
  | { kind: "create" };

export interface ConnectFlowResult {
  gatewayId: string;
  vaultId: string;
  /** Every vault the ticket enrolled; `vaultId` is the initial focus. */
  vaultIds?: string[];
  displayLabel: string;
}

/** A transport failure is NOT an empty registry (#603). */
export type LocalVaultsResult =
  | { ok: true; vaults: ConnectivityVaultPreview[] }
  | { ok: false; message: string };

export interface ConnectFlowState {
  step: ConnectStep;
  method: ConnectMethod | null;

  ticket: string;
  label: string;
  /** Defaults ON and is never asked during pairing; Settings owns the toggle. */
  rememberDevice: boolean;

  testing: boolean;
  report: ConnectivityReport | null;
  testError: string | null;

  vaultChoice: VaultChoice | null;
  newVaultName: string;
  /** Never set for an empty but successfully-read registry. */
  vaultsError: string | null;

  committing: boolean;
  commitError: string | null;
  result: ConnectFlowResult | null;
}

/** `method` pre-selects and lands on its first real step (#603). */
export function createInitialConnectFlowState(
  method: ConnectMethod | null = null
): ConnectFlowState {
  const base: ConnectFlowState = {
    commitError: null,
    committing: false,
    label: "",
    method: null,
    newVaultName: "",
    report: null,
    result: null,
    rememberDevice: true,
    step: "method",
    testError: null,
    testing: false,
    ticket: "",
    vaultChoice: null,
    vaultsError: null,
  };
  return method
    ? connectFlowReducer(base, { method, type: "selectMethod" })
    : base;
}

export type ConnectFlowTextField = "ticket" | "label" | "newVaultName";

export type ConnectFlowEvent =
  | { type: "selectMethod"; method: ConnectMethod }
  | { type: "back" }
  | { type: "setField"; field: ConnectFlowTextField; value: string }
  | { type: "setRememberDevice"; value: boolean }
  | { type: "startTest" }
  | { type: "testSettled"; report: ConnectivityReport }
  | { type: "localVaultsLoaded"; result: LocalVaultsResult }
  | { type: "continueToVault" }
  | { type: "selectVault"; choice: VaultChoice }
  | { type: "commit" }
  | { type: "commitSettled"; result: ConnectFlowResult }
  | { type: "commitFailed"; error: string }
  | { type: "reset" };

const STEP_ORDER: readonly ConnectStep[] = [
  "method",
  "details",
  "test",
  "vault",
];

export function connectFlowReducer(
  state: ConnectFlowState,
  event: ConnectFlowEvent
): ConnectFlowState {
  switch (event.type) {
    case "selectMethod": {
      const base = { ...createInitialConnectFlowState(), method: event.method };
      // `local` is always reachable: nothing to fill in or probe.
      return { ...base, step: event.method === "local" ? "vault" : "details" };
    }
    case "back": {
      if (state.step === "error") {
        return { ...state, commitError: null, step: "vault" };
      }
      const idx = STEP_ORDER.indexOf(state.step);
      if (idx <= 0) {
        return { ...createInitialConnectFlowState() };
      }
      // Local skips `details`/`test` in both directions.
      const prevIdx =
        state.method === "local" && STEP_ORDER[idx] === "vault" ? 0 : idx - 1;
      const prev = STEP_ORDER[prevIdx] ?? "method";
      return {
        ...state,
        method: prev === "method" ? null : state.method,
        report: prev === "test" ? state.report : null,
        step: prev,
        testError: null,
        vaultChoice: null,
        vaultsError: null,
      };
    }
    case "setField":
      return { ...state, [event.field]: event.value };
    case "setRememberDevice":
      return { ...state, rememberDevice: event.value };
    case "startTest":
      return {
        ...state,
        report: null,
        step: "test",
        testError: null,
        testing: true,
      };
    case "testSettled":
      return { ...state, report: event.report, testing: false };
    case "localVaultsLoaded":
      // A failed read still settles `report`; `vaultsError` says it went badly.
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
    case "continueToVault": {
      const options = state.report?.vaults ?? [];
      const defaultChoice: VaultChoice | null =
        options.length > 0
          ? { kind: "existing", vaultId: options[0]!.vaultId }
          : canCreateVaultFor(state)
            ? { kind: "create" }
            : null;
      return {
        ...state,
        step: "vault",
        vaultChoice: state.vaultChoice ?? defaultChoice,
      };
    }
    case "selectVault":
      return { ...state, vaultChoice: event.choice };
    case "commit":
      return {
        ...state,
        commitError: null,
        committing: true,
        step: "committing",
      };
    case "commitSettled":
      return {
        ...state,
        committing: false,
        result: event.result,
        step: "done",
      };
    case "commitFailed":
      return {
        ...state,
        commitError: event.error,
        committing: false,
        step: "error",
      };
    case "reset":
      return createInitialConnectFlowState();
    default:
      return state;
  }
}

export function buildTestInput(
  state: ConnectFlowState
): ConnectTestInput | null {
  if (state.method === "gateway") {
    if (!state.ticket.trim()) return null;
    return { kind: "ticket", ticket: state.ticket.trim() };
  }
  return null;
}

export function canStartTest(state: ConnectFlowState): boolean {
  return buildTestInput(state) !== null;
}

/** Only `local`: a ticket's initial vault is fixed by its payload. */
export function canCreateVaultFor(state: ConnectFlowState): boolean {
  return state.method === "local";
}

export interface ConnectVaultCapability {
  /** Ticket mode only: a locked, non-selectable row. */
  locked: { vaultName: string } | null;
  options: ConnectivityVaultPreview[];
  canCreate: boolean;
}

export function vaultCapability(
  state: ConnectFlowState
): ConnectVaultCapability {
  if (state.method === "gateway") {
    return {
      canCreate: false,
      locked: state.report?.ticket
        ? { vaultName: state.report.ticket.vaultName }
        : null,
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
  if (state.method === "local") {
    if (state.vaultsError || !state.vaultChoice) return false;
    return (
      state.vaultChoice.kind === "existing" ||
      state.newVaultName.trim().length > 0
    );
  }
  if (state.method === "gateway") {
    if (state.ticket.trim().length === 0) return false;
    // An enrollment naming no vault must not proceed (#603).
    if (state.step === "vault" && state.report) return hasUsableVault(state);
    return true;
  }
  return false;
}

function hasUsableVault(state: ConnectFlowState): boolean {
  const cap = vaultCapability(state);
  return cap.locked !== null || cap.options.length > 0 || cap.canCreate;
}
