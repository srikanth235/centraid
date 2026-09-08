/*
 * One real gateway process per test file (#890 W3).
 *
 * `serve()` is the shipped host: an auto-founded Personal vault, the eight
 * bundled system apps installed, and their manifest scopes granted at install
 * ("installing WAS the consent" — `vault-plane.ts#recordAppInstall`). That
 * last part is why nothing here approves a grant by hand: a hand-written scope
 * would prove the machinery while the shipped manifest drifted, and the replica
 * shape catalog these suites read is derived from the grants, not the manifest.
 */

import { createServer } from "node:http";
import path from "node:path";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { appActionPath } from "../../../packages/core/src/protocol/index.js";
import { serve } from "../../../packages/server/src/serve/serve.js";
import type { GatewayServeHandle } from "../../../packages/server/src/serve/serve.js";
import { assertVaultTreeHealthy } from "../../../packages/vault/src/doctor.js";

/** What a bundled app action answered, reduced to what these suites assert on. */
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
  /**
   * Call a bundled app action over the shipped HTTP surface, bypassing the
   * phone's outbox entirely. This is TWO real things at once: the online-only
   * door the product uses for Locker's secret-bearing writes
   * (docs/mobile-offline.md), and a second device writing to the same vault —
   * which is how these suites advance canonical state behind a cut phone.
   */
  callAction: (
    appId: string,
    action: string,
    input: Record<string, unknown>
  ) => Promise<ActionOutcome>;
  /** The gateway's own cursor for a shape set, read through the changes route. */
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
    // #892 Phase 3 — THE INVARIANT SWEEP AT TEARDOWN. These suites write through
    // the real command surface against a real vault, and until now nothing ever
    // asked whether the rows they left behind still referred to each other. FKs
    // catch what SQLite knows about; the polymorphic `(type, id)` pointers #441
    // had to sweep by hand are invisible to the engine, and an orphan there is
    // how deleted content resurfaces in search. Read-only, and strictly after the
    // gateway has closed, so this cannot change what any assertion saw.
    close: async () => {
      await handle.close();
      assertVaultTreeHealthy(dataDir);
    },
  };
}

/**
 * A loopback port with nothing behind it. Bind ephemeral, read the number, let
 * it go: a connection to it afterwards raises the platform's own
 * connection-refused error, which is the transport failure shape these suites
 * need. A boolean "offline" flag inside the fetcher would prove the flag.
 */
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
