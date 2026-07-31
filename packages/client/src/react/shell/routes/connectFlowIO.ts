import { listVaults } from "../../../gateway-client.js";
import type {
  ConnectFlowResult,
  ConnectFlowState,
  ConnectTestInput,
  ConnectivityReport,
  LocalVaultsResult,
} from "./connectFlow-core.js";
import { connectGateway } from "./gatewayModals.js";

/*
 * Impure IO for ConnectFlow (issue #382) — mirrors the
 * gatewayRegistry.ts pure-core / impure-glue split: every
 * `window.CentraidApi` call and error-shape decision lives here, so
 * `connectFlow-core.ts` and the component stay pure/presentational.
 *
 * `testGatewayConnection` is an IPC method the host bridge supplies. This
 * renderer half doesn't own centraid-api.d.ts, so the contract is declared
 * locally as `ConnectFlowBridge` and reconciled by the integration typecheck.
 */

/** The vault a fresh gateway auto-founds for its owner (issue #603). Its peer
 *  is "Shared", which is the default for everyone the owner invites. */
const PERSONAL_VAULT_NAME = "Personal";

export interface ConnectFlowBridge {
  testGatewayConnection: (
    input: ConnectTestInput
  ) => Promise<ConnectivityReport>;
}

function bridge(): ConnectFlowBridge {
  return window.CentraidApi as unknown as ConnectFlowBridge;
}

/** Run the connectivity test for the current details. Never throws — a
 *  bridge that's missing (older build, unwired test double) or a rejecting
 *  call both fold to a single failed 'reach' stage, same posture as
 *  `redeemGatewayPairing`'s `{ok:false}` contract. */
export async function runConnectivityTest(
  input: ConnectTestInput
): Promise<ConnectivityReport> {
  try {
    const b = bridge();
    if (typeof b.testGatewayConnection !== "function") {
      return {
        error: "unavailable",
        ok: false,
        stages: [{ id: "reach", label: "Reach the host", status: "fail" }],
      };
    }
    return await b.testGatewayConnection(input);
  } catch (error) {
    return {
      error: "unreachable",
      ok: false,
      stages: [
        {
          detail: error instanceof Error ? error.message : String(error),
          id: "reach",
          label: "Reach the host",
          status: "fail",
        },
      ],
    };
  }
}

/**
 * The local gateway's existing vaults, shaped like a ConnectivityReport's
 * `vaults[]` so the vault step's rendering stays method-agnostic.
 *
 * The catch is a typed translation, not a swallow (issue #603 W4): an
 * unreachable gateway used to fold into an empty list, which the vault step
 * then rendered as "this gateway has no vaults" and the onboarding host
 * auto-committed a create against. The caller now sees WHY the list is empty.
 */
export async function loadLocalVaults(): Promise<LocalVaultsResult> {
  try {
    const vaults = await listVaults();
    if (!vaults) {
      return {
        ok: false,
        message: "This connection does not serve a vault list.",
      };
    }
    return {
      ok: true,
      vaults: vaults.map((v) => ({
        color: v.color,
        icon: v.icon,
        name: v.name,
        ...(v.personal ? { personal: true } : {}),
        vaultId: v.vaultId,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      message: `Couldn't read the vaults on this connection: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * First run's "Start fresh on this Mac" commit (issue #603). The embedded
 * gateway founds "Shared" + "Personal" at construction, so there is no
 * ceremony and no vault to create here — this only makes the local gateway
 * active and addresses the owner's own vault. Throws with a user-facing
 * message the onboarding host renders inline.
 */
export async function connectFreshLocalGateway(): Promise<ConnectFlowResult> {
  await ensureLocalGatewayActive();
  const loaded = await loadLocalVaults();
  if (!loaded.ok) throw new Error(loaded.message);
  // The `personal` marker is written INTO the vault at founding, so it still
  // identifies the owner's vault after the fresh path renames it to their
  // display name. The name match is the fallback for data dirs founded before
  // the marker existed (v0: no migrations).
  const personal =
    loaded.vaults.find((v) => v.personal) ??
    loaded.vaults.find((v) => v.name === PERSONAL_VAULT_NAME) ??
    null;
  // Reinstalling over existing data may find no personal vault at all (it was
  // erased). Landing on the oldest vault is still the right place to enter,
  // but it is "Shared", so it must NOT be flagged renamable (issue #603 C10:
  // the fallback used to rename everyone's shared vault).
  const target = personal ?? loaded.vaults[0] ?? null;
  if (!target) {
    throw new Error(
      "This Mac has no vaults yet — restart Centraid and try again."
    );
  }
  await window.CentraidApi.setActiveVault({ vaultId: target.vaultId });
  return {
    displayLabel: "This Mac",
    gatewayId: "local",
    ownerVault: personal !== null,
    vaultId: target.vaultId,
  };
}

/**
 * Commit the flow (design doc step D). Throws with a user-facing message on
 * failure — the component catches it and dispatches `commitFailed`.
 */
export async function commitConnectFlow(
  state: ConnectFlowState
): Promise<ConnectFlowResult> {
  if (state.method === "local") {
    return commitLocal(state);
  }
  if (state.method === "gateway") {
    return commitGateway(state);
  }
  throw new Error("No connection method selected.");
}

async function ensureLocalGatewayActive(): Promise<void> {
  // Always the explicit call, even when 'local' is already the active id (it
  // is the virgin-install default): on a true first run the desktop DEFERS
  // starting the local gateway until this deliberate act (issue #603 — no
  // keychain prompt before the user chooses), and `setActiveGateway` is what
  // lifts that deferral. Skipping it when the id already matches would leave
  // the gateway unstarted and every follow-up read hanging on an empty URL.
  await window.CentraidApi.setActiveGateway({ id: "local" });
}

async function commitLocal(
  state: ConnectFlowState
): Promise<ConnectFlowResult> {
  if (!state.vaultChoice) throw new Error("Pick or create a vault first.");
  await ensureLocalGatewayActive();
  if (state.vaultChoice.kind === "create") {
    const create = window.CentraidApi.createVault;
    if (typeof create !== "function") {
      throw new Error(
        "This host cannot create vaults — use the desktop app or the centraid-gateway CLI."
      );
    }
    const name = state.newVaultName.trim();
    const created = await create({ name: name || undefined });
    await window.CentraidApi.setActiveVault({ vaultId: created.vaultId });
    return {
      displayLabel: "This Mac",
      gatewayId: "local",
      vaultId: created.vaultId,
    };
  }
  const { vaultId } = state.vaultChoice;
  await window.CentraidApi.setActiveVault({ vaultId });
  return { displayLabel: "This Mac", gatewayId: "local", vaultId };
}

async function commitGateway(
  state: ConnectFlowState
): Promise<ConnectFlowResult> {
  const label = state.label.trim() || undefined;
  const result = await connectGateway({
    kind: "ticket",
    label,
    rememberDevice: state.rememberDevice,
    ticket: state.ticket.trim(),
  });
  if (!result.ok) throw new Error(result.message);
  return {
    displayLabel: result.label,
    gatewayId: result.gatewayId,
    vaultId: result.vaultId ?? "",
  };
}
