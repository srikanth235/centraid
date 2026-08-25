import { listVaults } from "../../../gateway-client.js";
import type {
  ConnectFlowResult,
  ConnectFlowState,
  ConnectTestInput,
  ConnectivityReport,
  LocalVaultsResult,
} from "./connectFlow-core.js";
import { connectGateway } from "./gatewayModals.js";

// Impure ConnectFlow IO (#382). `ConnectFlowBridge` is declared here; the renderer does not own centraid-api.d.ts.

const PERSONAL_VAULT_NAME = "Personal";

export interface ConnectFlowBridge {
  testGatewayConnection: (
    input: ConnectTestInput
  ) => Promise<ConnectivityReport>;
}

function bridge(): ConnectFlowBridge {
  return window.CentraidApi as unknown as ConnectFlowBridge;
}

/** Never throws — missing bridge or reject both fold to failed `reach`. */
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

/** Do not fold unreachable into an empty list — the vault step would auto-commit a create (#603). */
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

export async function connectFreshLocalGateway(): Promise<ConnectFlowResult> {
  await ensureLocalGatewayActive();
  const loaded = await loadLocalVaults();
  if (!loaded.ok) throw new Error(loaded.message);
  // `personal` is written at founding; name match is fallback for pre-marker dirs.
  const personal =
    loaded.vaults.find((v) => v.personal) ??
    loaded.vaults.find((v) => v.name === PERSONAL_VAULT_NAME) ??
    null;
  // Reinstall may find no personal vault; oldest remaining is the entry.
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
    vaultId: target.vaultId,
  };
}

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
  // Always the explicit call: first run defers starting the local gateway
  // until this act (#603). Skipping when id already matches leaves it unstarted.
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
    vaultIds: result.vaultIds,
  };
}
