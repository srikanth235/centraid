// Pairing state + tunnel lifecycle for the phone ↔ gateway link (issue #263).
//
// Two ticket shapes, one Settings entry point:
//
// 1. Desktop "Connect phone" QR — JSON `{v:1, kind:'centraid-pair', ticket, code}`
//    redeemed over `centraid/pair/1` (pairWithDesktop).
// 2. Headless VPS ticket — base64url JSON `{v:1, kind:'centraid-gw-pair', gw, t, s, …}`
//    from `centraid-gateway pair` / `pair --qr`, redeemed over `centraid/gw-pair/1`
//    (pairWithGateway). Only `gw`, a refreshable EndpointTicket address hint,
//    is stored; one-time `t`/`s` capabilities are discarded.
//
// The phone never holds a gateway bearer. From then on `ensureTunnelStarted()`
// runs a localhost HTTP proxy — everything (documents, module imports, SSE)
// rides the iroh tunnel; the gateway/desktop attaches auth on its side.
//
// The phone can pair with several gateways: each pairing is recorded as a
// (gateway, vault) VaultLink in lib/vaults, and this module operates on the ACTIVE
// VaultLink's projected slot (LINK_* keys). `pair()` adds a VaultLink, `switchVaultLink()`
// re-points the active slot (restarting the tunnel when the gateway changes),
// and `forgetVaultLink()`/`unpair()` drop one. The device secret key is device-wide
// — one EndpointId enrolls with every desktop — so it is never per-vault.

import { Platform } from "react-native";

import {
  addTunnelStatusListener,
  generateSecretKey,
  getTunnelStatus as getTunnelStatusImpl,
  isTunnelAvailable as isTunnelAvailableImpl,
  pairWithDesktop,
  pairWithGateway,
  startTunnel,
  stopTunnel,
} from "../../modules/centraid-tunnel";
import type { TunnelStatus } from "../../modules/centraid-tunnel";
import { Store } from "../storage";
import { normalizePairedVaults } from "./phone-link-core";
import { parsePairingInput } from "./phone-link-parse";
import { getSecure, hydrateSecure, setSecure } from "./secure-storage";
import {
  LINK_DESKTOP_NAME_KEY,
  LINK_DEVICE_ID_KEY,
  LINK_SECRET_KEY,
  LINK_ENDPOINT_HINT_KEY,
  addVaultLink,
  getActiveVaultLink,
  hydrateVaultLinks,
  listVaultLinks,
  removeVaultLink,
  setActiveVaultLink,
} from "./vault-links";
import type { VaultLink } from "./vault-links";

// The active-slot keys now live in their new owner, lib/vault-links (the Vaults
// registry projects the active (gateway, vault) tuple into them); imported above
// for this module's own tunnel/link reads.

export class PhoneLinkError extends Error {
  constructor(
    public readonly kind:
      | "invalid_qr"
      | "module_unavailable"
      | "pair_failed"
      | "tunnel_failed",
    message: string
  ) {
    super(message);
    this.name = "PhoneLinkError";
  }
}

/** Pull link prefs into Store + secrets into secure storage. Idempotent. */
export async function hydratePhoneLink(): Promise<void> {
  // Hydrate the registry first: it folds any pre-registry install into a VaultLink
  // and projects the active VaultLink into the LINK_* slot keys read below.
  await hydrateVaultLinks();
  await Promise.all([
    hydrateSecure(LINK_ENDPOINT_HINT_KEY, ""),
    Store.hydrate<string>(LINK_DESKTOP_NAME_KEY, ""),
    Store.hydrate<string>(LINK_DEVICE_ID_KEY, ""),
    hydrateSecure(LINK_SECRET_KEY, ""),
  ]);
}

export function isPaired(): boolean {
  return Boolean(
    getSecure(LINK_ENDPOINT_HINT_KEY, "") && getSecure(LINK_SECRET_KEY, "")
  );
}

export function getDesktopName(): string {
  return Store.get<string>(LINK_DESKTOP_NAME_KEY, "");
}

/**
 * Pair from a scanned QR payload or a pasted ticket. Accepts desktop
 * `centraid-pair` JSON and headless `centraid-gw-pair` one-liners.
 */
export async function pair(
  qrPayloadString: string,
  deviceName: string
): Promise<{ desktopName: string; deviceId: string; vaultIds?: string[] }> {
  const parsed = parsePairingInput(qrPayloadString);
  if (!parsed) {
    throw new PhoneLinkError(
      "invalid_qr",
      "That is not a Centraid pairing code. Scan the desktop QR, or paste a ticket from `centraid-gateway pair`."
    );
  }
  if (parsed.kind === "centraid-gw-pair" && parsed.exp <= Date.now()) {
    throw new PhoneLinkError(
      "invalid_qr",
      "This pairing ticket has expired — mint a new one on the gateway."
    );
  }
  if (!isTunnelAvailableImpl()) {
    throw new PhoneLinkError(
      "module_unavailable",
      "Pairing needs the native tunnel module — use a development build, not Expo Go."
    );
  }
  await hydratePhoneLink();
  let secretKeyB64 = getSecure(LINK_SECRET_KEY, "");
  if (!secretKeyB64) {
    secretKeyB64 = await generateSecretKey();
    await setSecure(LINK_SECRET_KEY, secretKeyB64);
  }

  if (parsed.kind === "centraid-pair") {
    const result = await pairWithDesktop({
      code: parsed.code,
      deviceName,
      platform: Platform.OS,
      secretKeyB64,
      ticket: parsed.ticket,
    });
    if (!result.ok || !result.deviceId || !result.gatewayId) {
      throw new PhoneLinkError(
        "pair_failed",
        result.error ?? "Desktop did not return its durable gateway EndpointId."
      );
    }
    const desktopName = result.desktopName ?? "";
    const deviceId = result.deviceId;
    // A new pairing may target a DIFFERENT gateway than the running tunnel. Stop
    // it so the re-init (driven by the active-vault change) dials the gateway we
    // just paired with rather than reusing the old proxy.
    await stopTunnel().catch(() => {
      /* not running */
    });
    // Record this desktop as the active VaultLink; addVaultLink projects the active
    // LINK_* slot (endpoint hint + names). vaultId starts empty and is filled by
    // ReplicaProvider's bootstrap probe.
    await addVaultLink({
      gatewayId: result.gatewayId,
      desktopName,
      deviceId,
      vaultId: "",
      endpointHint: parsed.ticket,
    });
    return { desktopName, deviceId };
  }

  // Headless gateway ticket.
  const result = await pairWithGateway({
    ticket: parsed.gw,
    ticketId: parsed.t,
    secret: parsed.s,
    deviceName,
    platform: Platform.OS,
    secretKeyB64,
  });
  if (!result.ok) {
    throw new PhoneLinkError(
      "pair_failed",
      result.error ?? "Pairing was refused by the gateway."
    );
  }
  // The tunnel dials the gateway EndpointTicket (`gw`) embedded in the pairing
  // token. A new pairing may target a DIFFERENT gateway than the running tunnel,
  // so stop it — the re-init (driven by the active-vault change) dials the
  // gateway we just paired with rather than reusing the old proxy.
  await stopTunnel().catch(() => {
    /* not running */
  });
  const gatewayId = result.gatewayId;
  if (!gatewayId) {
    throw new PhoneLinkError(
      "pair_failed",
      "Gateway did not return its EndpointId."
    );
  }
  const desktopName =
    result.vaultName || result.gatewayName || parsed.vaultName || "Gateway";
  const deviceId =
    result.enrollmentId || result.gatewayId || result.deviceId || "gateway";
  const returnedVaults = normalizePairedVaults(result);
  const returnedVaultIds = returnedVaults.map((vault) => vault.vaultId);
  const primaryVaultId = returnedVaultIds[0];
  if (!primaryVaultId) {
    throw new PhoneLinkError(
      "pair_failed",
      "Gateway did not return an enrolled vault."
    );
  }
  const metadata = new Map(
    returnedVaults.map((vault) => [vault.vaultId, vault] as const)
  );
  // EndpointId is durable identity. `gw` is only a refreshable dial hint; a
  // relay change updates it in-place because addVaultLink keys on EndpointId.
  // The first grant remains active after all grants are recorded, preserving
  // the ticket's primary-vault landing behavior.
  // `addVaultLink` updates one shared registry projection, so these writes
  // intentionally stay ordered even though the response is a batch.
  const links = await returnedVaultIds.reduce<Promise<VaultLink[]>>(
    async (previous, vaultId) => {
      const prior = await previous;
      const grant = metadata.get(vaultId);
      const link = await addVaultLink({
        gatewayId,
        desktopName,
        deviceId: grant?.enrollmentId ?? deviceId,
        vaultId,
        ...(grant?.vaultName
          ? { vaultName: grant.vaultName }
          : vaultId === primaryVaultId
            ? { vaultName: parsed.vaultName }
            : {}),
        endpointHint: parsed.gw,
      });
      return [...prior, link];
    },
    Promise.resolve([])
  );
  const primaryLink = links[0];
  if (primaryLink) await setActiveVaultLink(primaryLink.id);
  return { desktopName, deviceId, vaultIds: returnedVaultIds };
}

/**
 * Forget the ACTIVE desktop/gateway link (Settings' "Unpair"). Stops the tunnel
 * and removes the active VaultLink, falling back to another VaultLink if one remains.
 * Keeps the device secret key so a future re-pair presents the same EndpointId
 * (the peer can also revoke it by name).
 */
export async function unpair(): Promise<void> {
  await hydrateVaultLinks();
  const active = getActiveVaultLink();
  if (isTunnelAvailableImpl()) {
    if (active && isLastVaultLinkForGateway(active))
      await revokePushRegistration().catch(() => undefined);
    await stopTunnel().catch(() => {
      /* already stopped */
    });
  }
  if (active) await removeVaultLink(active.id);
}

/**
 * Make a saved VaultLink active. Re-points the active slot to its (gateway, vault)
 * tuple; when the gateway differs from the current one, stops the tunnel so the
 * next `ensureTunnelStarted` dials the new gateway (a same-gateway vault switch
 * keeps the tunnel up and only changes the vault header + replica key). The
 * replica re-keys off the active-vault change; returns the now-active VaultLink.
 */
export async function switchVaultLink(
  id: string
): Promise<VaultLink | undefined> {
  await hydrateVaultLinks();
  const prev = getActiveVaultLink();
  if (prev?.id === id) return prev;
  const next = await setActiveVaultLink(id);
  if (!next) return undefined;
  if (isTunnelAvailableImpl() && prev && prev.gatewayId !== next.gatewayId) {
    await stopTunnel().catch(() => {
      /* not running */
    });
  }
  return next;
}

/**
 * Forget one VaultLink by id (the switcher's "Remove from this phone"). The vault
 * stays on the gateway — this only drops the local tuple + its ticket. When the
 * forgotten VaultLink is active, the tunnel is stopped so the fallback VaultLink (if
 * any) can re-connect cleanly.
 */
export async function forgetVaultLink(id: string): Promise<void> {
  await hydrateVaultLinks();
  const active = getActiveVaultLink();
  const removed = listVaultLinks().find((vault) => vault.id === id);
  const wasActive = active?.id === id;
  if (wasActive && isTunnelAvailableImpl()) {
    if (removed && isLastVaultLinkForGateway(removed))
      await revokePushRegistration().catch(() => undefined);
    await stopTunnel().catch(() => {
      /* not running */
    });
  }
  await removeVaultLink(id);
}

function isLastVaultLinkForGateway(vault: VaultLink): boolean {
  return !listVaultLinks().some(
    (candidate) =>
      candidate.id !== vault.id && candidate.gatewayId === vault.gatewayId
  );
}

async function revokePushRegistration(): Promise<void> {
  const tunnel = await ensureTunnelStarted();
  if (!tunnel) return;
  await fetch(
    new URL("/centraid/_gateway/push/registrations", tunnel.baseUrl),
    { method: "DELETE" }
  );
}

// Deduplicate concurrent starts (Home + AppDetail can race on mount).
let startInFlight: Promise<{ baseUrl: string } | undefined> | undefined;

/**
 * Reset a proxy whose listener is still running but whose peer connection is
 * no longer usable. The native status only describes the localhost listener,
 * so a compatibility retry must stop it before the next mount asks it to dial.
 */
export async function restartTunnel(): Promise<void> {
  // Do not race a start that another foreground consumer already requested.
  await startInFlight?.catch(() => undefined);
  // The next resolveGatewayBase call binds a replacement native transport; its
  // first request must not inherit the connection that this stop just closed.
  await stopTunnel().catch(() => {
    /* already stopped or unavailable */
  });
}

/**
 * Start (or reuse) the localhost tunnel proxy for the paired peer.
 * Resolves the base URL every WebView + RN fetch should use. Returns
 * `undefined` when unpaired or when the native module is unavailable
 * (Expo Go); throws PhoneLinkError when a start attempt fails.
 */
export async function ensureTunnelStarted(): Promise<
  { baseUrl: string } | undefined
> {
  if (startInFlight) return startInFlight;
  startInFlight = (async () => {
    await hydratePhoneLink();
    if (!isPaired() || !isTunnelAvailableImpl()) return undefined;
    const status = await getTunnelStatusImpl();
    if (status.state === "running" && status.port) {
      return { baseUrl: `http://127.0.0.1:${status.port}` };
    }
    try {
      const { port } = await startTunnel({
        secretKeyB64: getSecure(LINK_SECRET_KEY, ""),
        ticket: getSecure(LINK_ENDPOINT_HINT_KEY, ""),
      });
      return { baseUrl: `http://127.0.0.1:${port}` };
    } catch (error) {
      throw new PhoneLinkError(
        "tunnel_failed",
        `Could not reach your gateway: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  })();
  try {
    return await startInFlight;
  } finally {
    startInFlight = undefined;
  }
}

/** Status subscription passthrough — no-op remover when the module is unavailable. */
export function subscribeTunnelStatus(cb: (status: TunnelStatus) => void): {
  remove: () => void;
} {
  if (!isTunnelAvailableImpl()) {
    return {
      remove: () => {
        /* noop */
      },
    };
  }
  return addTunnelStatusListener(cb);
}

export {
  getTunnelStatus,
  isTunnelAvailable,
} from "../../modules/centraid-tunnel";
export type { TunnelStatus } from "../../modules/centraid-tunnel";
