function authHeaders(gatewayToken) {
  return gatewayToken ? { authorization: `Bearer ${gatewayToken}` } : {};
}

export async function demoStatus(gatewayUrl, gatewayToken = "") {
  const base = gatewayUrl.replace(/\/+$/u, "");
  const response = await fetch(`${base}/centraid/_vault/demo`, {
    headers: authHeaders(gatewayToken),
  });
  const status = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(status?.apps))
    throw new Error(
      `gateway refused demo status (${status?.error ?? response.status})`
    );
  return status.apps;
}

export async function seedDemo(appId, gatewayUrl, gatewayToken = "") {
  if (!gatewayUrl)
    throw new Error("a gateway URL is required to seed demo data");
  const base = gatewayUrl.replace(/\/+$/u, "");
  const apps = await demoStatus(base, gatewayToken);
  const current = apps.find((app) => app?.appId === appId);
  if (!current?.seedable)
    throw new Error(`gateway does not ship the ${appId} demo scenario`);
  if (Number(current.rows) > 0)
    return { appId, rows: Number(current.rows), seeded: false };

  const response = await fetch(
    `${base}/centraid/_vault/demo/${encodeURIComponent(appId)}`,
    { headers: authHeaders(gatewayToken), method: "POST" }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `gateway refused ${appId} demo seed (${result?.error ?? response.status})`
    );
  return { appId, rows: result.rows ?? 0, seeded: true };
}

export async function purgeDemo(appId, gatewayUrl, gatewayToken = "") {
  if (!gatewayUrl)
    throw new Error("a gateway URL is required to purge demo data");
  const base = gatewayUrl.replace(/\/+$/u, "");
  const response = await fetch(
    `${base}/centraid/_vault/demo/${encodeURIComponent(appId)}`,
    { headers: authHeaders(gatewayToken), method: "DELETE" }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `gateway refused ${appId} demo purge (${result?.error ?? response.status})`
    );
  return { appId, purged: result.purged ?? 0 };
}

export const ALWAYS_EARNS_GRID = ["locker"];
