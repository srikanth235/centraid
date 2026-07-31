/*
 * The gateway registry behind the sidebar's identity row (issues #599, #665).
 *
 * The owner's model is vault-first: EVERY noun they manage is a vault, and a
 * host is plumbing. So the sidebar switcher lists VAULTS ONLY — flattened
 * across every registered connection (`buildVaultRows`) — a vault's own
 * Settings page owns the one act an owner takes against a connection
 * (Disconnect, worded per-vault), and the host-framed plumbing (rename, test,
 * remove) lives in Gateway → Components' Connections section, the only surface
 * allowed to show a host as a host (`buildGatewayRows`).
 *
 * Both builders are pure (no `window`), so the merge/sort/status folding is
 * unit-testable; the rest wires `window.CentraidApi` and owns a module-level
 * cache for the whole renderer session, so a reopened popover paints instantly
 * (stale-while-revalidate) rather than showing a spinner.
 *
 * A gateway's reachability still comes from `listGatewayVaults` — it is the one
 * per-gateway call that proves the connection works end to end. The list it
 * returns is now KEPT rather than counted and dropped: it is exactly the set of
 * vault rows the flattened switcher needs, so the cross-gateway list costs no
 * extra fetch.
 */

/** Minimal shape of a gateway profile these rows need. */
export interface RegistryGateway {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: "local" | "remote";
}

/** One vault as a gateway reported it. Roles are NOT part of this: only the
 *  active gateway's member scopes carry a role (`GET /_vault/scopes` answers
 *  for the calling member on the gateway this client addresses). */
export interface RegistryVault {
  vaultId: string;
  name: string;
}

/** Why a gateway's probe didn't come back, plus `'loading'` for one still in
 *  flight. Mirrors `CentraidListGatewayVaultsResult`'s error union. */
export type GatewayProbeStatus =
  | "loading"
  | "unreachable"
  | "auth_failed"
  | "bad_response";

export type GatewayProbeOutcome =
  | { status: "loading" }
  | { status: "ready"; vaults: readonly RegistryVault[] }
  | { status: "error"; error: Exclude<GatewayProbeStatus, "loading"> };

/** Cached probe state for one gateway. `vaults` survives a later
 *  `'loading'`/`'error'` outcome so a background refresh failure never blanks
 *  out rows the owner already saw. */
export interface GatewayProbeEntry {
  vaults: readonly RegistryVault[] | undefined;
  status: "loading" | "ready" | "error";
  error?: Exclude<GatewayProbeStatus, "loading">;
}

export type GatewayProbeCache = Record<string, GatewayProbeEntry>;

/** User-facing transport chip. */
export type GatewayTransportBadge = "This Mac" | "iroh";

/** One gateway, as Settings → Gateways lists it and as the switcher's vault
 *  flattening reads it. */
export interface GatewayRow {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: "local" | "remote";
  transportBadge: GatewayTransportBadge;
  status: GatewayProbeStatus | "ready";
  /** Last known vault list, once a probe succeeded. */
  vaults: readonly RegistryVault[] | undefined;
  /** Known vault count, once a probe succeeded. */
  vaultCount: number | undefined;
  isActive: boolean;
  /** `'local'` is the primordial gateway — never removable (mirrors
   *  `removeGateway`'s own refusal). */
  canRemove: boolean;
}

/** Fold one probe outcome into the cache. Pure reducer. */
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
  // Every remote gateway is reached over iroh — the SSH admin channel and its
  // chip were deleted with the SSH connect method (issue #603).
  return gw.gatewayKind === "local" ? "This Mac" : "iroh";
}

/**
 * Merge the registered gateways with whatever their probes reported, active
 * gateway first and the rest alphabetical.
 */
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

// ── The flattened, vault-only switcher list (issue #665) ───────────────────

/** A vault the CALLING MEMBER holds a role in on the ACTIVE gateway — the one
 *  place a role is known, straight from `useMemberScopes`. */
export interface MemberVaultScope {
  id: string;
  label: string;
  role: string;
  isActive: boolean;
}

/** One row of the sidebar switcher. Either a vault (`vaultId` set) or, when a
 *  gateway has no vaults to show yet, a quiet stand-in for the gateway itself
 *  so a probing or unreachable gateway is visible rather than silently absent. */
export interface SwitcherVaultRow {
  /** Stable list key — a gateway's stand-in row uses the gateway id alone. */
  key: string;
  gatewayId: string;
  gatewayLabel: string;
  /** Undefined on a gateway stand-in row. */
  vaultId: string | undefined;
  label: string;
  subtitle: string;
  /** Drives the row's status rail — the same three-way fold the gateway rows
   *  use, so there is one status vocabulary across both surfaces. */
  status: "ready" | "loading" | "error";
  /** False for stand-ins and for vaults behind an unreachable gateway: the row
   *  renders visibly inert instead of pretending a click would work. */
  selectable: boolean;
  isActive: boolean;
}

/** Why a gateway's rows look the way they do, in the owner's words. */
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
      // Stand-in row for a reachable host that currently has no vaults —
      // `connectionSummary` names the vaults when any exist, so this path only
      // surfaces when the list is empty.
      return "No vaults";
  }
}

/**
 * Confirm copy for disconnecting a vault from THIS DEVICE (issue #665).
 *
 * The underlying primitive drops the whole connection, so every vault the same
 * host serves goes with it — the copy has to say so, and it says so by NAMING
 * the siblings rather than by explaining transport. "Gateway" never appears:
 * the owner manages vaults, and the consequence they need is "which of my
 * vaults leave this device, and do they survive elsewhere" (they do).
 */
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

/** Three-way fold of a probe status, shared by both surfaces' status rails. */
export function railStatus(row: GatewayRow): "ready" | "loading" | "error" {
  if (row.status === "ready") return "ready";
  if (row.status === "loading") return "loading";
  return "error";
}

/**
 * Flatten every registered gateway's vaults into ONE list (issue #665).
 *
 * The active gateway's vaults come from the member's scope registry, because
 * that is the only source that carries a role; every other gateway contributes
 * whatever its `listGatewayVaults` probe last returned. The gateway is named
 * only as quiet subtitle context, and only when more than one is registered —
 * with a single gateway there is nothing to disambiguate.
 */
export function buildVaultRows(
  rows: readonly GatewayRow[],
  scopes: readonly MemberVaultScope[],
  activeGatewayId: string
): SwitcherVaultRow[] {
  // A host that exposes no gateway list at all (stubbed bridges, an older web
  // host) still knows the vaults it is connected to — list those rather than
  // rendering an empty switcher because the transport inventory is missing.
  if (rows.length === 0)
    return scopes.map((scope) => ({
      gatewayId: activeGatewayId,
      gatewayLabel: "",
      isActive: scope.isActive,
      key: `${activeGatewayId}:${scope.id}`,
      label: scope.label,
      selectable: true,
      status: "ready" as const,
      subtitle: `${scope.role} vault`,
      vaultId: scope.id,
    }));
  const multi = rows.length > 1;
  // Which row is the one this client is actually talking to. Normally the id
  // match, but the web host reports `activeGatewayId: 'web'` while listing its
  // single connection under its EndpointId — with one gateway registered there
  // is nothing else it could be, and getting this wrong would drop the roles
  // and the active check mark.
  const activeRow =
    rows.find((row) => row.isActive) ??
    (rows.length === 1 ? rows[0] : undefined);
  const out: SwitcherVaultRow[] = [];
  for (const row of rows) {
    const state = railStatus(row);
    const isActiveGateway = row === activeRow;
    const known: Array<{ vaultId: string; name: string; role?: string }> =
      isActiveGateway && scopes.length > 0
        ? scopes.map((scope) => ({
            vaultId: scope.id,
            name: scope.label,
            role: scope.role,
          }))
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
      const lead =
        state === "error"
          ? [gatewayStatusCopy(row)]
          : vault.role
            ? [`${vault.role} vault`]
            : [];
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

// ── Impure glue ────────────────────────────────────────────────────────────

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

/** Refresh the gateways this client knows about. Resolves `0` when the host
 * exposes no gateway list; the combined switcher itself remains available. */
export async function countGateways(): Promise<number> {
  const profiles =
    (await window.CentraidApi.listGateways?.().catch(() => [])) ?? [];
  lastGateways = profiles.map(toRegistryGateway);
  return lastGateways.length;
}

/** Cache-only rows for the instant first paint, before any probe lands. */
export function getCachedGatewayRows(activeGatewayId: string): GatewayRow[] {
  return buildGatewayRows(lastGateways, cache, activeGatewayId);
}

/** Probe one gateway into the shared cache. Never throws — folds any rejection
 *  to the same `'unreachable'` outcome `listGatewayVaults` reports itself. */
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
            // Kept, not counted-and-dropped: this IS the switcher's row set.
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

/**
 * Refresh the gateway list, return the rows for the first paint, and kick off a
 * concurrent per-gateway probe — invoking `onUpdate` with freshly merged rows as
 * each settles, so the popover fills in progressively instead of blocking.
 */
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
