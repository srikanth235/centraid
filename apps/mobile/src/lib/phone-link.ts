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

export async function hydratePhoneLink(): Promise<void> {
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

    await stopTunnel().catch(() => {});
    await addVaultLink({
      gatewayId: result.gatewayId,
      desktopName,
      deviceId,
      vaultId: "",
      endpointHint: parsed.ticket,
    });
    return { desktopName, deviceId };
  }

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
  await stopTunnel().catch(() => {});
  const gatewayId = result.gatewayId;
  if (!gatewayId) {
    throw new PhoneLinkError(
      "pair_failed",
      "Gateway did not return its EndpointId."
    );
  }
  const desktopName =
    result.gatewayName || result.vaultName || parsed.vaultName || "Gateway";
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

export async function unpair(): Promise<void> {
  await hydrateVaultLinks();
  const active = getActiveVaultLink();
  if (isTunnelAvailableImpl()) {
    if (active && isLastVaultLinkForGateway(active))
      await revokePushRegistration().catch(() => undefined);
    await stopTunnel().catch(() => {});
  }
  if (active) await removeVaultLink(active.id);
}

export async function switchVaultLink(
  id: string
): Promise<VaultLink | undefined> {
  await hydrateVaultLinks();
  const prev = getActiveVaultLink();
  if (prev?.id === id) return prev;
  const next = await setActiveVaultLink(id);
  if (!next) return undefined;
  if (isTunnelAvailableImpl() && prev && prev.gatewayId !== next.gatewayId) {
    await stopTunnel().catch(() => {});
  }
  return next;
}

export async function forgetVaultLink(id: string): Promise<void> {
  await hydrateVaultLinks();
  const active = getActiveVaultLink();
  const removed = listVaultLinks().find((vault) => vault.id === id);
  const wasActive = active?.id === id;
  if (wasActive && isTunnelAvailableImpl()) {
    if (removed && isLastVaultLinkForGateway(removed))
      await revokePushRegistration().catch(() => undefined);
    await stopTunnel().catch(() => {});
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

let startInFlight: Promise<{ baseUrl: string } | undefined> | undefined;

export async function ensureTunnelStarted(): Promise<
  { baseUrl: string } | undefined
> {
  if (startInFlight) return startInFlight;
  startInFlight = (async () => {
    await hydratePhoneLink();
    if (!isPaired() || !isTunnelAvailableImpl()) {
      console.error(
        `[centraid] replica: no tunnel — paired=${isPaired()} native=${isTunnelAvailableImpl()}`
      );
      return undefined;
    }
    const status = await getTunnelStatusImpl();
    if (status.state === "running" && status.port) {
      console.error(`[centraid] replica: tunnel reused on port ${status.port}`);
      return { baseUrl: `http://127.0.0.1:${status.port}` };
    }
    try {
      const { port } = await startTunnel({
        secretKeyB64: getSecure(LINK_SECRET_KEY, ""),
        ticket: getSecure(LINK_ENDPOINT_HINT_KEY, ""),
      });
      console.error(
        `[centraid] replica: tunnel started on port ${port} from ${status.state}`
      );
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

export function subscribeTunnelStatus(cb: (status: TunnelStatus) => void): {
  remove: () => void;
} {
  if (!isTunnelAvailableImpl()) {
    return {
      remove: () => {},
    };
  }
  return addTunnelStatusListener(cb);
}

export {
  getTunnelStatus,
  isTunnelAvailable,
} from "../../modules/centraid-tunnel";
export type { TunnelStatus } from "../../modules/centraid-tunnel";
