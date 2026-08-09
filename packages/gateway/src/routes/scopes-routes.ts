/*
 * `/centraid/_vault/scopes` — the cross-vault "where may I work" plane
 * (issue #599 Phase 4; ownership since #726).
 *
 * An owner owns one or more vaults (`vault_owners`), and a client needs ONE
 * answer to "which vaults may I switch between, and is this app there?" so a
 * scope switcher can render without N round-trips.
 *
 * WHY THIS IS A GATEWAY-PLANE ROUTE. This listing spans vaults, so it is
 * mounted BESIDE the per-request `runWithVaultContext` scope in
 * `build-gateway.ts` — after the device identity is proved, before the
 * ambient single-vault scope is entered. The `x-centraid-vault` header is
 * irrelevant here and is deliberately ignored; nothing in this file reads
 * the ambient vault.
 *
 * ORDER is registry order (`VaultRegistry.list()`): the gateway's DEFAULT
 * vault — the owner's personal one, by the durable `personal` marker — first,
 * then the remainder oldest-first (ids are UUIDv7, so lexicographic order IS
 * creation order). Filtering to the caller's owned vaults preserves the
 * order, so the caller's primary vault comes first among their rows without
 * a second lookup. `GET /_vault/vaults` reads the same registry listing, so
 * a client that degrades to it sees the identical order.
 *
 * AUTHORIZATION is ownership, no roles (#726): the acting OWNER's vaults,
 * never the device's. Host custody (L0, the landlord with shell access) sees
 * every mounted vault. A vault the caller does not own simply DOES NOT
 * APPEAR: the listing must never leak the gateway's vault topology, so there
 * is no "forbidden" row, only absence.
 *
 * `canWrite` keeps its exact client/blueprint shape with a new source: a
 * vault you own is writable. It stays a per-row wire field — not a constant
 * clients derive — because later phases put lent (read-only) scopes in this
 * same list.
 *
 * `installed` is reported only when the request names an app (`?app=<id>`);
 * with no app named the field is omitted entirely, because "not asked" and
 * "not installed" are different answers.
 *
 * BORROWED SCOPES (#726 P4 item 6). A live edge lent TO one of the caller's
 * OWN vaults now appears here too, `canWrite: false`, alongside the owned
 * rows — the audience's own devices reach it through the SAME replica-scope
 * plane, no second mechanism. Each carries a `borrowed` sub-object naming
 * who it is from and how it is reaching (`reachState`/`reason`, mirroring
 * `borrowed_edges.state`/`.reason`); it is never silently dropped from the
 * list, even a `parked` one — a scope you cannot currently reach is still a
 * scope you know about.
 *
 * MOUNT POLICY. A native device caps how many scopes it mounts as replica
 * shapes at once (`MAX_MOUNTED_NATIVE_SCOPES`); this gateway — not the
 * client — now decides who gets a slot, so two clients never disagree about
 * it and a client with no opinion of its own still gets an honest answer:
 *   - an OWNED vault always wins a slot. It is never denied one — the
 *     policy exists to ration what is scarce among things the caller does
 *     not already have a durable claim to.
 *   - a BORROWED scope competes for whatever is left, MOST RECENTLY ACTIVE
 *     FIRST (`borrowed_edges.updated_at` — every successful sync bumps it,
 *     D8), because a share nobody has actually looked at recently is the
 *     worst use of a slot someone else could use.
 *   - a borrowed scope that loses the race still appears in the list with
 *     `borrowed.mounted: false` — a STATE, never a silent absence. A future
 *     surface can render "too many shares" honestly instead of the scope
 *     just not being there.
 * An owned row carries no `mounted` field at all: mounted is not a
 * question for a scope the policy never denies.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { BorrowedEdgeSummary } from "../serve/lend-audience.js";
import { sendJson } from "./route-helpers.js";

export const SCOPES_PATH = "/centraid/_vault/scopes";

/**
 * The native mount cap this route's policy rations (#726 P4 item 6). Mirrors
 * `apps/mobile/src/lib/replica/offline-budgets.ts`'s `MAX_MOUNTED_NATIVE_SCOPES`
 * and the web `useAppScopes.ts`'s `MAX_MOUNTED_SCOPES` — both currently 4.
 * Kept as its OWN constant rather than imported: this route cannot depend on
 * a client package. The three copies are pinned to agree by
 * `scopes-routes.test.ts`'s "mount cap constants" suite, which source-scans
 * the other two files the same way `packages/tunnel/src/alpn-parity.test.ts`
 * pins the Rust relay's ALPN constants — a cross-package import from this
 * gateway route would invert the dependency direction, but a TEST reading
 * the other files' text has no such constraint.
 */
export const MAX_MOUNTED_NATIVE_SCOPES = 4;

/** The registry facts one scope row is rendered from (structurally `VaultInfo`). */
export interface ScopeVault {
  vaultId: string;
  name: string;
  /** The durable founding marker (`core_vault.settings_json.personal`). */
  personal?: boolean;
  color?: string;
  icon?: string;
}

/** How a mounted borrowed scope is currently reaching this gateway — mirrors
 *  `borrowed_edges.state`, minus 'dropped' (a dropped edge is not a scope). */
export type BorrowedReachState = "offered" | "established" | "parked";

/** The lend-specific facts a BORROWED scope row carries, absent for an
 *  owned vault (#726 P4 item 6). */
export interface ScopeBorrowedInfo {
  edgeId: string;
  /** The lender's vault; `ScopeRow.vaultId` is the edge-scoped replica id. */
  originVaultId: string;
  /** Who it is lent BY — the origin vault's label at link time. */
  holderLabel: string;
  itemType: string;
  reachState: BorrowedReachState;
  /** Set only when `reachState` is 'parked' — says WHY (budget vs. unreachable). */
  reason: string | null;
  /**
   * Whether the gateway's mount policy gave this scope one of the device's
   * limited native replica slots. `false` is a STATE the row still carries —
   * a scope that lost the race is a surfaced fact, never a silent absence.
   */
  mounted: boolean;
}

/** One vault (or lent scope) the caller may work in. */
export interface ScopeRow {
  vaultId: string;
  /** The vault's own name — display only, never a key. */
  label: string;
  /**
   * Whether this is the owner's OWN vault — the durable founding marker
   * (issue #711 item H). Always present, so an app can derive its "somewhere
   * other than my own" marker as exactly `personal === false` and never from
   * `label`, which the owner is free to rename.
   */
  personal: boolean;
  color?: string;
  icon?: string;
  /** Ownership-sourced writability (#726): a vault you own is writable. A
   *  borrowed scope is writable only when its edge carries `read+act`
   *  (#726 P5) — a plain read edge lends, it never delegates. */
  canWrite: boolean;
  /** Present only when the request named an app. */
  installed?: boolean;
  /** Present only for a LENT scope — absent for an owned vault, which the
   *  mount policy never denies a slot (#726 P4 item 6). */
  borrowed?: ScopeBorrowedInfo;
}

/** The whole answer: the caller's scopes. */
export interface ScopesBody {
  scopes: ScopeRow[];
}

export interface ScopesRouteDeps {
  enrollments: EnrollmentStore;
  /** Every MOUNTED vault in registry listing order — default vault first. */
  listVaults: () => readonly ScopeVault[];
  /** The app ids installed in one mounted vault, or undefined when unknown. */
  installedApps: (vaultId: string) => ReadonlySet<string> | undefined;
  /**
   * Auto-mount seam (see below): install + grant a BUNDLED app in an explicit
   * vault, resolving to whether it is installed there afterwards. Returns
   * false — never throws — for a non-bundled id or a failed install.
   */
  ensureAppInstalled?: (vaultId: string, appId: string) => Promise<boolean>;
  /** Direct host-custody request (authenticated bearer, never iroh-forwarded). */
  isHostCustody?: (req: IncomingMessage) => boolean;
  /**
   * Live (non-dropped) edges lent TO any of these vaults (#726 P4 item 6).
   * Absent on a build with no lend plane wired — the listing then carries
   * owned scopes only, exactly as it did before this phase.
   */
  borrowedScopes?: (
    audienceVaultIds: readonly string[]
  ) => readonly BorrowedEdgeSummary[];
}

function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The mount policy (#726 P4 item 6): which EDGE ids win one of the slots
 * left over after every owned vault takes one (owned is never denied).
 * Ranked most-recently-active first (`updatedAt` — every successful sync
 * bumps it, D8): a share nobody has actually touched recently is the worst
 * use of a slot someone else could use.
 */
function mountedEdgeIds(
  ownedCount: number,
  borrowed: readonly BorrowedEdgeSummary[]
): ReadonlySet<string> {
  const remaining = Math.max(0, MAX_MOUNTED_NATIVE_SCOPES - ownedCount);
  const ranked = [...borrowed].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
  return new Set(ranked.slice(0, remaining).map((edge) => edge.edgeId));
}

function borrowedRow(edge: BorrowedEdgeSummary, mounted: boolean): ScopeRow {
  return {
    // One origin may lend several independent shapes. The device persistence
    // key is therefore the edge, never the origin vault id.
    vaultId: `borrowed:${edge.edgeId}`,
    label: edge.holderLabel,
    personal: false,
    // A read edge never delegates write; a read+act edge does (#726 P5) —
    // the same `verbs` the origin minted the grant with, mirrored here.
    canWrite: edge.verbs === "read+act",
    borrowed: {
      edgeId: edge.edgeId,
      originVaultId: edge.originVaultId,
      holderLabel: edge.holderLabel,
      itemType: edge.itemType,
      // The SQL that produced `edge` already excludes 'dropped'; the cast
      // documents that guarantee rather than re-deriving it here.
      reachState: edge.state as BorrowedReachState,
      reason: edge.reason,
      mounted,
    },
  };
}

export function makeScopesRouteHandler(deps: ScopesRouteDeps): RouteHandler {
  /**
   * The caller's reachable vaults. Host custody is above ownership rather
   * than inside it, so it is answered with every mounted vault.
   */
  const visibleFor = (
    ownerId: string | undefined,
    vaults: readonly ScopeVault[]
  ): ScopeVault[] => {
    if (ownerId === undefined) return [...vaults];
    // Intersect with what is MOUNTED: an owned vault this gateway no longer
    // carries is not a place the caller can work.
    const owned = new Set(deps.enrollments.owners.vaultsOwnedBy(ownerId));
    return vaults.filter((vault) => owned.has(vault.vaultId));
  };

  /**
   * "The app follows the person into a vault they own."
   * When the named app is already installed in at least one of the caller's
   * OTHER vaults, install it into the ones missing it. Fail-soft by
   * construction: a refused or failed install leaves `installed: false` for
   * that vault and never fails the listing.
   */
  const reconcileInstalls = async (
    appId: string,
    installed: Map<string, boolean>
  ): Promise<void> => {
    const ensure = deps.ensureAppInstalled;
    if (!ensure) return;
    if (![...installed.values()].some(Boolean)) return;
    const reconciled = await Promise.all(
      [...installed]
        .filter(([, present]) => !present)
        .map(async ([vaultId]) => {
          try {
            return [vaultId, await ensure(vaultId, appId)] as const;
          } catch {
            return [vaultId, false] as const;
          }
        })
    );
    for (const [vaultId, present] of reconciled)
      installed.set(vaultId, present);
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== SCOPES_PATH) return false;
    if ((req.method ?? "GET") !== "GET") {
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    const hostCustody = deps.isHostCustody?.(req) === true;
    const deviceKey = callerDeviceKey(req);
    // Host custody never resolves an owner: it sees every mounted vault.
    const owner =
      hostCustody || deviceKey === undefined
        ? undefined
        : deps.enrollments.ownerFor(deviceKey);
    if (!owner && !hostCustody) {
      return sendJson(res, 403, {
        error: "forbidden",
        message:
          "listing scopes requires a proved iroh device identity bound to an owner",
      });
    }

    const vaults = deps.listVaults();
    const visible = visibleFor(owner?.ownerId, vaults);

    const appId = url.searchParams.get("app") ?? undefined;
    let installed: Map<string, boolean> | undefined;
    if (appId !== undefined && appId.length > 0) {
      installed = new Map(
        visible.map((vault) => [
          vault.vaultId,
          deps.installedApps(vault.vaultId)?.has(appId) === true,
        ])
      );
      await reconcileInstalls(appId, installed);
    }

    const ownedScopes: ScopeRow[] = visible.map((vault) => ({
      vaultId: vault.vaultId,
      label: vault.name,
      personal: vault.personal === true,
      ...(vault.color === undefined ? {} : { color: vault.color }),
      ...(vault.icon === undefined ? {} : { icon: vault.icon }),
      // Every row here is owned by the caller (or host custody), so it is
      // writable — sourced from the visibility filter above, never derived
      // by clients.
      canWrite: true,
      ...(installed
        ? { installed: installed.get(vault.vaultId) === true }
        : {}),
    }));

    // Borrowed scopes (#726 P4 item 6): live edges lent TO any vault this
    // caller can see. Host custody's `visible` is every mounted vault, so it
    // sees every borrowed edge reaching this gateway — the same "above
    // ownership, not inside it" posture the vault listing already has.
    const borrowedEdges =
      deps.borrowedScopes?.(visible.map((vault) => vault.vaultId)) ?? [];
    const mounted = mountedEdgeIds(ownedScopes.length, borrowedEdges);
    const borrowedRows = borrowedEdges.map((edge) =>
      borrowedRow(edge, mounted.has(edge.edgeId))
    );

    const scopes: ScopeRow[] = [...ownedScopes, ...borrowedRows];
    const body: ScopesBody = { scopes };
    return sendJson(res, 200, body);
  };
}
