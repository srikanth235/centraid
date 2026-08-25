/*
 * The gateway registry behind the sidebar's identity row (#599, #665).
 *
 * Vault-first: the switcher lists VAULTS ONLY (`buildVaultRows`), and
 * Connections is the only surface allowed to show a host as a host. Keep both
 * builders pure — no `window` — so the folding stays testable.
 */

export interface RegistryGateway {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: "local" | "remote";
}

export interface RegistryVault {
  vaultId: string;
  name: string;
}

export type GatewayProbeStatus =
  | "loading"
  | "unreachable"
  | "auth_failed"
  | "bad_response";

export type GatewayProbeOutcome =
  | { status: "loading" }
  | { status: "ready"; vaults: readonly RegistryVault[] }
  | { status: "error"; error: Exclude<GatewayProbeStatus, "loading"> };

/** `vaults` survives a later `loading`/`error`: a refresh failure must never
 *  blank rows the owner already saw. */
export interface GatewayProbeEntry {
  vaults: readonly RegistryVault[] | undefined;
  status: "loading" | "ready" | "error";
  error?: Exclude<GatewayProbeStatus, "loading">;
}

export type GatewayProbeCache = Record<string, GatewayProbeEntry>;

export type GatewayTransportBadge = "This Mac" | "iroh";

export interface GatewayRow {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: "local" | "remote";
  transportBadge: GatewayTransportBadge;
  status: GatewayProbeStatus | "ready";
  vaults: readonly RegistryVault[] | undefined;
  vaultCount: number | undefined;
  isActive: boolean;
  canRemove: boolean;
}

export function applyProbeOutcome(
  cache: GatewayProbeCache,
  gatewayId: string,
  outcome: GatewayProbeOutcome
): GatewayProbeCache {
  const prev = cache[gatewayId];
  let next: GatewayProbeEntry;
  if (outcome.status === "loading") {
    next = { vaults: prev?.vaults, status: "loading" };
  } else if (outcome.status === "ready") {
    next = { vaults: outcome.vaults, status: "ready" };
  } else {
    next = {
      vaults: prev?.vaults,
      status: "error",
      error: outcome.error,
    };
  }
  return { ...cache, [gatewayId]: next };
}

function transportBadgeFor(gw: RegistryGateway): GatewayTransportBadge {
  // iroh is the only remote transport (#603).
  return gw.gatewayKind === "local" ? "This Mac" : "iroh";
}

export function buildGatewayRows(
  gateways: readonly RegistryGateway[],
  cache: GatewayProbeCache,
  activeGatewayId: string
): GatewayRow[] {
  const rows = gateways.map((gw): GatewayRow => {
    const entry = cache[gw.gatewayId];
    return {
      canRemove: gw.gatewayKind !== "local",
      gatewayId: gw.gatewayId,
      gatewayKind: gw.gatewayKind,
      gatewayLabel: gw.gatewayLabel,
      isActive: gw.gatewayId === activeGatewayId,
      vaultCount: entry?.vaults?.length,
      vaults: entry?.vaults,
      status:
        entry?.status === "ready"
          ? "ready"
          : entry?.status === "error"
            ? (entry.error ?? "unreachable")
            : "loading",
      transportBadge: transportBadgeFor(gw),
    };
  });
  return [...rows].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.gatewayLabel.localeCompare(b.gatewayLabel);
  });
}

export interface OwnerVaultScope {
  id: string;
  label: string;
  isActive: boolean;
}

export interface SwitcherVaultRow {
  key: string;
  gatewayId: string;
  gatewayLabel: string;
  vaultId: string | undefined;
  label: string;
  subtitle: string;
  status: "ready" | "loading" | "error";
  /** False behind an unreachable gateway: render inert, never fake a click. */
  selectable: boolean;
  isActive: boolean;
}

export function gatewayStatusCopy(row: GatewayRow): string {
  switch (row.status) {
    case "loading":
      return "Checking…";
    case "auth_failed":
      return "Sign-in required";
    case "bad_response":
      return "Unexpected response";
    case "unreachable":
      return "Offline";
    case "ready":
      return "No vaults";
  }
}

/** The primitive drops the whole connection, so every vault that host serves
 *  goes too: NAME the siblings. "Gateway" must never appear. */
export function disconnectConfirmCopy(
  vaultName: string,
  siblingNames: readonly string[]
): string {
  if (siblingNames.length === 0)
    return `Disconnect ${JSON.stringify(vaultName)} from this device? Your vault stays intact on its host.`;
  const total = siblingNames.length + 1;
  const listed =
    siblingNames.length === 1
      ? JSON.stringify(siblingNames[0])
      : `${siblingNames
          .slice(0, -1)
          .map((name) => JSON.stringify(name))
          .join(", ")} and ${JSON.stringify(siblingNames.at(-1))}`;
  const count =
    total === 2 ? "both" : total === 3 ? "all three" : `all ${total}`;
  return `${JSON.stringify(vaultName)} shares its connection with ${listed} — disconnecting removes ${count} from this device. The vaults themselves stay intact on their host.`;
}

export function railStatus(row: GatewayRow): "ready" | "loading" | "error" {
  if (row.status === "ready") return "ready";
  if (row.status === "loading") return "loading";
  return "error";
}

/** Active gateway's vaults come from the owner's scope registry, others from
 *  their last probe. Subtitle the gateway only when several. */
export function buildVaultRows(
  rows: readonly GatewayRow[],
  scopes: readonly OwnerVaultScope[],
  activeGatewayId: string
): SwitcherVaultRow[] {
  // A host with no gateway list still knows its vaults: never empty the
  // switcher over a missing inventory.
  if (rows.length === 0)
    return scopes.map((scope) => ({
      gatewayId: activeGatewayId,
      gatewayLabel: "",
      isActive: scope.isActive,
      key: `${activeGatewayId}:${scope.id}`,
      label: scope.label,
      selectable: true,
      status: "ready" as const,
      subtitle: "Vault",
      vaultId: scope.id,
    }));
  const multi = rows.length > 1;
  // The web host reports `activeGatewayId: 'web'` but lists its connection
  // under an EndpointId; without this fallback the active mark disappears.
  const activeRow =
    rows.find((row) => row.isActive) ??
    (rows.length === 1 ? rows[0] : undefined);
  const out: SwitcherVaultRow[] = [];
  for (const row of rows) {
    const state = railStatus(row);
    const isActiveGateway = row === activeRow;
    const known: Array<{ vaultId: string; name: string }> =
      isActiveGateway && scopes.length > 0
        ? scopes.map((scope) => ({ vaultId: scope.id, name: scope.label }))
        : [...(row.vaults ?? [])];
    if (known.length === 0) {
      out.push({
        gatewayId: row.gatewayId,
        gatewayLabel: row.gatewayLabel,
        isActive: false,
        key: row.gatewayId,
        label: row.gatewayLabel,
        selectable: false,
        status: state,
        subtitle: gatewayStatusCopy(row),
        vaultId: undefined,
      });
      continue;
    }
    for (const vault of known) {
      const context = multi ? [row.gatewayLabel] : [];
      const lead = state === "error" ? [gatewayStatusCopy(row)] : [];
      out.push({
        gatewayId: row.gatewayId,
        gatewayLabel: row.gatewayLabel,
        isActive:
          isActiveGateway &&
          (scopes.find((scope) => scope.id === vault.vaultId)?.isActive ??
            false),
        key: `${row.gatewayId}:${vault.vaultId}`,
        label: vault.name,
        selectable: state !== "error",
        status: state,
        subtitle: [...lead, ...context].join(" · ") || "Vault",
        vaultId: vault.vaultId,
      });
    }
  }
  return out;
}

let cache: GatewayProbeCache = {};
let lastGateways: RegistryGateway[] = [];

type ProfileShape = {
  id: string;
  label: string;
  kind: "local" | "remote";
};

function toRegistryGateway(p: ProfileShape): RegistryGateway {
  return {
    gatewayId: p.id,
    gatewayKind: p.kind,
    gatewayLabel: p.label,
  };
}

export async function countGateways(): Promise<number> {
  const profiles =
    (await window.CentraidApi.listGateways?.().catch(() => [])) ?? [];
  lastGateways = profiles.map(toRegistryGateway);
  return lastGateways.length;
}

export function getCachedGatewayRows(activeGatewayId: string): GatewayRow[] {
  return buildGatewayRows(lastGateways, cache, activeGatewayId);
}

async function probeOneGateway(gatewayId: string): Promise<void> {
  cache = applyProbeOutcome(cache, gatewayId, { status: "loading" });
  try {
    const result = await window.CentraidApi.listGatewayVaults({ gatewayId });
    cache = applyProbeOutcome(
      cache,
      gatewayId,
      result.ok
        ? {
            status: "ready",
            vaults: result.vaults.map((vault) => ({
              name: vault.name,
              vaultId: vault.vaultId,
            })),
          }
        : { status: "error", error: result.error }
    );
  } catch {
    cache = applyProbeOutcome(cache, gatewayId, {
      status: "error",
      error: "unreachable",
    });
  }
}

/** Calls `onUpdate` as each probe settles: the popover must not block. */
export async function openGatewayRegistry(
  activeGatewayId: string,
  onUpdate: (rows: GatewayRow[]) => void
): Promise<GatewayRow[]> {
  await countGateways();
  const gateways = lastGateways;
  void Promise.all(
    gateways.map(async (gw) => {
      await probeOneGateway(gw.gatewayId);
      onUpdate(buildGatewayRows(gateways, cache, activeGatewayId));
    })
  );
  return buildGatewayRows(gateways, cache, activeGatewayId);
}
