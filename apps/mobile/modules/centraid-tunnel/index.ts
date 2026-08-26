// JS surface for the CentraidTunnel Expo module (#263). Wire protocol:
// packages/tunnel/src/protocol.ts — stay byte-for-byte in lockstep.

import type { NativeModule } from "expo-modules-core";
import { requireOptionalNativeModule } from "expo-modules-core";

export type TunnelState = "stopped" | "starting" | "running" | "error";

export interface TunnelStatus {
  state: TunnelState;
  port?: number;
  error?: string;
}

export interface TunnelPairResult {
  ok: boolean;
  deviceId?: string;
  desktopName?: string;
  enrollmentId?: string;
  gatewayId?: string;
  gatewayName?: string;
  vaultId?: string;
  vaultName?: string;
  vaultIds?: string[];
  vaults?: TunnelPairVault[];
  error?: string;
}

export interface TunnelPairVault {
  vaultId: string;
  enrollmentId?: string;
  vaultName?: string;
  role?: "admin" | "write" | "read";
}

export interface TunnelPairArgs {
  /** From the desktop's "Connect phone" QR. */
  ticket: string;
  code: string;
  deviceName: string;
  platform: string;
  /** Base64 of the device's 32-byte ed25519 secret key. */
  secretKeyB64: string;
}

export interface TunnelGatewayPairArgs {
  /** Gateway EndpointTicket from a `centraid-gw-pair` token. */
  ticket: string;
  ticketId: string;
  secret: string;
  deviceName: string;
  platform: string;
  secretKeyB64: string;
}

export interface TunnelStartArgs {
  ticket: string;
  secretKeyB64: string;
}

type CentraidTunnelEvents = {
  onStatusChange: (status: TunnelStatus) => void;
};

declare class CentraidTunnelNativeModule extends NativeModule<CentraidTunnelEvents> {
  generateSecretKey(): Promise<string>;
  pairWithDesktop(args: TunnelPairArgs): Promise<TunnelPairResult>;
  pairWithGateway(args: TunnelGatewayPairArgs): Promise<TunnelPairResult>;
  startTunnel(args: TunnelStartArgs): Promise<{ port: number }>;
  stopTunnel(): Promise<void>;
  getTunnelStatus(): Promise<TunnelStatus>;
}

const native =
  requireOptionalNativeModule<CentraidTunnelNativeModule>("CentraidTunnel");

function requireTunnel(): CentraidTunnelNativeModule {
  if (!native) {
    throw new Error(
      "CentraidTunnel native module is unavailable — it requires a dev build " +
        "(bunx expo prebuild, then expo run:ios / run:android); Expo Go cannot load it."
    );
  }
  return native;
}

export function isTunnelAvailable(): boolean {
  return native != null;
}

export async function generateSecretKey(): Promise<string> {
  return requireTunnel().generateSecretKey();
}

/** Transport failures resolve as `{ ok: false, error }` — one error path. */
export async function pairWithDesktop(
  args: TunnelPairArgs
): Promise<TunnelPairResult> {
  return requireTunnel().pairWithDesktop(args);
}

export async function pairWithGateway(
  args: TunnelGatewayPairArgs
): Promise<TunnelPairResult> {
  return requireTunnel().pairWithGateway(args);
}

/** Idempotent while running: returns the already-bound port. */
export async function startTunnel(
  args: TunnelStartArgs
): Promise<{ port: number }> {
  return requireTunnel().startTunnel(args);
}

export async function stopTunnel(): Promise<void> {
  return requireTunnel().stopTunnel();
}

export async function getTunnelStatus(): Promise<TunnelStatus> {
  return requireTunnel().getTunnelStatus();
}

/** No-op subscription when native is absent. */
export function addTunnelStatusListener(cb: (status: TunnelStatus) => void): {
  remove: () => void;
} {
  if (!native) return { remove: () => {} };
  const subscription = native.addListener("onStatusChange", cb);
  return { remove: () => subscription.remove() };
}
