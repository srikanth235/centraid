import {
  assistOAuthFromEnvironment,
  createWasmImagePreviewCodec,
  serve,
} from "@centraid/server";
import type { GatewayPaths, GatewayServeHandle } from "@centraid/server";
import type { KeyStore } from "@centraid/vault";

export interface DesktopEmbeddedGatewayOptions {
  dataDir: string;
  paths: GatewayPaths;
  keyStore: KeyStore;
  token: string;
  ownerEndpointId: string;
  sessionIdFor?: (appId: string) => string;
  logTag?: string;
}

export async function startDesktopEmbeddedGateway(
  options: DesktopEmbeddedGatewayOptions
): Promise<GatewayServeHandle> {
  return serve({
    assistOAuth: assistOAuthFromEnvironment(process.env),
    previewCodec: createWasmImagePreviewCodec(),
    paths: {
      ...options.paths,
      dataDir: options.dataDir,
    },
    keyStore: options.keyStore,
    token: options.token,
    hostDeviceEndpointId: options.ownerEndpointId,
    ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
    ...(options.logTag ? { logTag: options.logTag } : {}),
  });
}
