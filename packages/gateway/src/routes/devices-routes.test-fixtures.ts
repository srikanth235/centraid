/*
 * Shared harness for the `/centraid/_gateway/devices` route tests.
 *
 * The roster/revocation tests and the invitation-minting tests (issue #599)
 * live in sibling files but drive one real gateway.db, so the wiring is here
 * rather than copied twice. Each test file owns its own `afterEach(cleanup)`.
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { vi } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { PairingTicketStore } from "../serve/pairing-store.js";
import { WebControlSessionStore } from "../serve/web-session-store.js";
import { makeDevicesRouteHandler } from "./devices-routes.js";
import type { DevicesRouteDeps } from "./devices-routes.js";

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];

export async function cleanupHarnesses(): Promise<void> {
  for (const server of servers.splice(0)) server.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
}

export interface DevicesHarness {
  base: string;
  enrollments: EnrollmentStore;
  tickets: PairingTicketStore;
  sessions: WebControlSessionStore;
  onEndpointRevoked: ReturnType<typeof vi.fn>;
}

export async function harness(
  overrides: Partial<
    Pick<
      DevicesRouteDeps,
      | "endpointTicket"
      | "defaultVaultId"
      | "vaultName"
      | "canMintPairingTicket"
      | "vaultIds"
      | "mintVaultForPerson"
    >
  > = {}
): Promise<DevicesHarness> {
  const dir = await tempDir("devices-routes-");
  dirs.push(dir);
  const database = GatewayDatabase.open(dir);
  databases.push(database);
  const enrollments = EnrollmentStore.open(database);
  const tickets = PairingTicketStore.open(database);
  const sessions = WebControlSessionStore.open(database);
  const onEndpointRevoked = vi.fn();
  const handler = makeDevicesRouteHandler({
    enrollments,
    tickets,
    vaultName: (vaultId) => (vaultId === "vault-a" ? "Personal" : undefined),
    endpointTicket: () => "endpoint-ticket",
    onEndpointRevoked,
    ...overrides,
  });
  const server = http.createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    enrollments,
    tickets,
    sessions,
    onEndpointRevoked,
  };
}

export function deviceHeaders(endpointId: string): Record<string, string> {
  return {
    [AUTHED_DEVICE_HEADER]: endpointId,
    "content-type": "application/json",
  };
}
