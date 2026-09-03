import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
  GatewayClientError,
} from "./gateway-client-core.js";

export interface GatewayOwnerVault {
  vaultId: string;
  vaultName?: string;
}

export interface GatewayOwner {
  ownerId: string;
  label: string;
  createdAt: string;
  vaults: GatewayOwnerVault[];
  deviceCount: number;
}

export async function listGatewayOwners(): Promise<GatewayOwner[]> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(baseUrl, "/centraid/_gateway/owners", {
      method: "GET",
      headers: authHeaders(token),
    });
    const out = await readJson<{ owners: GatewayOwner[] }>(res, "list owners");
    return out.owners ?? [];
  } catch (error) {
    if (error instanceof GatewayClientError && error.code === "not_found")
      return [];
    throw error;
  }
}

export async function renameGatewayOwner(
  ownerId: string,
  label: string
): Promise<GatewayOwner> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/owners/${enc(ownerId)}`,
    {
      method: "PATCH",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ label }),
    }
  );
  return (await readJson<{ owner: GatewayOwner }>(res, "rename owner")).owner;
}
