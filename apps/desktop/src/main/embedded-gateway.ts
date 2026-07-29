import {
  assistOAuthFromEnvironment,
  createWasmImagePreviewCodec,
  serve,
} from "@centraid/gateway";
import type { GatewayPaths, GatewayServeHandle } from "@centraid/gateway";
import type { KeyStore } from "@centraid/vault";

export interface DesktopEmbeddedGatewayOptions {
  dataDir: string;
  paths: GatewayPaths;
  keyStore: KeyStore;
  token: string;
  ownerEndpointId: string;
  remoteTemplatesUrl?: string;
  sessionIdFor?: (appId: string) => string;
  logTag?: string;
}

/**
 * The one Electron-embedded gateway construction path. Keeping the serve
 * options here lets layout parity exercise the exact path the desktop uses.
 */
export async function startDesktopEmbeddedGateway(
  options: DesktopEmbeddedGatewayOptions
): Promise<GatewayServeHandle> {
  return serve({
    assistOAuth: assistOAuthFromEnvironment(process.env),
    previewCodec: createWasmImagePreviewCodec(),
    paths: {
      ...options.paths,
      dataDir: options.dataDir,
      ...(options.remoteTemplatesUrl
        ? { remoteTemplatesUrl: options.remoteTemplatesUrl }
        : {}),
    },
    keyStore: options.keyStore,
    token: options.token,
    hostDeviceEndpointId: options.ownerEndpointId,
    // No founding options (issue #603): the gateway founds its own Shared +
    // Personal vaults synchronously when it sees a fresh data dir, and the
    // founding-ticket plane is gone entirely.
    ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
    ...(options.logTag ? { logTag: options.logTag } : {}),
  });
}
