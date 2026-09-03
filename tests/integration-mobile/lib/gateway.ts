import { createServer } from "node:http";
import path from "node:path";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { appActionPath } from "../../../packages/core/src/protocol/index.js";
import { serve } from "../../../packages/server/src/serve/serve.js";
import type { GatewayServeHandle } from "../../../packages/server/src/serve/serve.js";
import { assertVaultTreeHealthy } from "../../../packages/vault/src/doctor.js";

export interface ActionOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface MobileGateway {
  readonly url: string;
  readonly token: string;
  readonly vaultId: string;
  readonly dataDir: string;
  readonly handle: GatewayServeHandle;
  callAction: (
    appId: string,
    action: string,
    input: Record<string, unknown>
  ) => Promise<ActionOutcome>;
  close: () => Promise<void>;
}

export async function bootMobileGateway(
  prefix: string
): Promise<MobileGateway> {
  const dataDir = await tempDir(`mobile-integration-${prefix}-`);
  const token = `${prefix}-token`;
  const handle = await serve({
    paths: { vaultDir: path.join(dataDir, "vault") },
    token,
  });
  const vaultId = handle.vaults.defaultVaultId();
  return {
    url: handle.url,
    token,
    vaultId,
    dataDir,
    handle,
    callAction: async (appId, action, input) => {
      const response = await fetch(
        `${handle.url}${appActionPath(appId, action)}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ input }),
        }
      );
      const text = await response.text();
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object")
          body = parsed as Record<string, unknown>;
      } catch {
        body = { raw: text };
      }
      return { status: response.status, body };
    },
    close: async () => {
      await handle.close();
      assertVaultTreeHealthy(dataDir);
    },
  };
}

export async function deadLoopbackUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (port === 0) throw new Error("could not reserve a loopback port");
  return `http://127.0.0.1:${port}`;
}
