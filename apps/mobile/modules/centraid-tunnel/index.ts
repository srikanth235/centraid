// JS surface for the CentraidTunnel Expo local module (issue #263).
//
// The native side owns an iroh endpoint (device identity = an ed25519 secret
// key supplied from JS as base64), handles one-time pairing with the desktop,
// and runs a localhost HTTP proxy that forwards every WebView request over
// the tunnel. Wire protocol reference: packages/tunnel/src/protocol.ts —
// the native implementations stay byte-for-byte in lockstep with it.
//
// When the native module is absent (Expo Go, web) this degrades gracefully:
// isTunnelAvailable() returns false and the async functions reject with a
// clear error instead of crashing at import time.

import { NativeModule, requireOptionalNativeModule } from 'expo-modules-core';

export type TunnelState = 'stopped' | 'starting' | 'running' | 'error';

export interface TunnelStatus {
  state: TunnelState;
  port?: number;
  error?: string;
}

export interface TunnelPairResult {
  ok: boolean;
  deviceId?: string;
  desktopName?: string;
  error?: string;
}

export interface TunnelPairArgs {
  /** iroh EndpointTicket from the desktop's "Connect phone" QR payload. */
  ticket: string;
  /** One-time pairing code from the same QR payload. */
  code: string;
  deviceName: string;
  platform: string;
  /** Base64 of the device's 32-byte ed25519 secret key. */
  secretKeyB64: string;
}

export interface TunnelStartArgs {
  ticket: string;
  secretKeyB64: string;
}

type CentraidTunnelEvents = {
  onStatusChange(status: TunnelStatus): void;
};

declare class CentraidTunnelNativeModule extends NativeModule<CentraidTunnelEvents> {
  generateSecretKey(): Promise<string>;
  pairWithDesktop(args: TunnelPairArgs): Promise<TunnelPairResult>;
  startTunnel(args: TunnelStartArgs): Promise<{ port: number }>;
  stopTunnel(): Promise<void>;
  getTunnelStatus(): Promise<TunnelStatus>;
}

const native = requireOptionalNativeModule<CentraidTunnelNativeModule>('CentraidTunnel');

function requireTunnel(): CentraidTunnelNativeModule {
  if (!native) {
    throw new Error(
      'CentraidTunnel native module is unavailable — it requires a dev build ' +
        '(bunx expo prebuild, then expo run:ios / run:android); Expo Go cannot load it.',
    );
  }
  return native;
}

/** False in Expo Go / on web, where local native modules cannot load. */
export function isTunnelAvailable(): boolean {
  return native != null;
}

/** Base64 of 32 random bytes — the device's ed25519 secret key seed. */
export async function generateSecretKey(): Promise<string> {
  return requireTunnel().generateSecretKey();
}

/**
 * Dial the desktop's ticket on `centraid/pair/1` and present the one-time
 * code. Transport failures resolve as `{ ok: false, error }` — same shape
 * as a desktop-side rejection — so callers handle one error path.
 */
export async function pairWithDesktop(args: TunnelPairArgs): Promise<TunnelPairResult> {
  return requireTunnel().pairWithDesktop(args);
}

/**
 * Bind the localhost proxy (127.0.0.1, ephemeral port) and lazily dial the
 * desktop on `centraid/tunnel/1`. Idempotent while running: returns the
 * already-bound port.
 */
export async function startTunnel(args: TunnelStartArgs): Promise<{ port: number }> {
  return requireTunnel().startTunnel(args);
}

export async function stopTunnel(): Promise<void> {
  return requireTunnel().stopTunnel();
}

export async function getTunnelStatus(): Promise<TunnelStatus> {
  return requireTunnel().getTunnelStatus();
}

/** Fires on every state transition. No-op subscription when native is absent. */
export function addTunnelStatusListener(cb: (status: TunnelStatus) => void): { remove(): void } {
  if (!native) return { remove: () => {} };
  const subscription = native.addListener('onStatusChange', cb);
  return { remove: () => subscription.remove() };
}
