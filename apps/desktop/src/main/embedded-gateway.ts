import {
  assistOAuthFromEnvironment,
  createWasmImagePreviewCodec,
  isDirectHostRequest,
  serve,
  type GatewayPaths,
  type GatewayServeHandle,
} from '@centraid/gateway';
import type { KeyStore } from '@centraid/vault';

export interface DesktopEmbeddedGatewayOptions {
  dataDir: string;
  paths: GatewayPaths;
  keyStore: KeyStore;
  token: string;
  ownerEndpointId: string;
  remoteTemplatesUrl?: string;
  initVaultName?: string;
  sessionIdFor?: (appId: string) => string;
  logTag?: string;
}

/**
 * The one Electron-embedded gateway construction path. Keeping the serve
 * options here lets layout parity exercise the exact path the desktop uses.
 */
export async function startDesktopEmbeddedGateway(
  options: DesktopEmbeddedGatewayOptions,
): Promise<GatewayServeHandle> {
  return serve({
    assistOAuth: assistOAuthFromEnvironment(process.env),
    previewCodec: createWasmImagePreviewCodec(),
    paths: {
      ...options.paths,
      dataDir: options.dataDir,
      ...(options.remoteTemplatesUrl ? { remoteTemplatesUrl: options.remoteTemplatesUrl } : {}),
    },
    keyStore: options.keyStore,
    token: options.token,
    hostDeviceEndpointId: options.ownerEndpointId,
    // The desktop runs a phone tunnel against this same loopback listener
    // (issue #568 item B), so the founding gate must be the hardened
    // predicate rather than `buildGateway`'s bare-loopback fallback.
    canMintFoundingTicket: isDirectHostRequest,
    ...(options.initVaultName ? { initVaultName: options.initVaultName } : {}),
    ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
    ...(options.logTag ? { logTag: options.logTag } : {}),
  });
}
