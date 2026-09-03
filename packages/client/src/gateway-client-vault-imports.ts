import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

export interface VaultImportBatch {
  batchId: string;
  status: "draft" | "published" | "discarded";
  createdAt: string;
  resolvedAt: string | null;
  summary: Record<string, number>;
  kind: string | null;
  label: string | null;
}

export interface VaultImportRow {
  seq: number;
  entityType: string;
  externalId: string;
  disposition: "create" | "update" | "skip" | "merge-candidate";
  note: string | null;
  publishedEntityId: string | null;
  mapping: string;
}

export async function vaultImportStage(input: {
  filename?: string;
  text?: string;
  base64?: string;
  directoryName?: string;
  files?: { path: string; text: string }[];
  accountName?: string;
  currency?: string;
}): Promise<{
  batchId: string;
  kind: string;
  staged: Record<string, number>;
  total: number;
  unrouted: string[];
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/imports", {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(input),
  });
  return readJson(res, "stage import");
}

export async function vaultPortableExport(passphrase?: string): Promise<{
  blob: Blob;
  filename: string;
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/imports/export", {
    method: passphrase ? "POST" : "GET",
    headers: passphrase
      ? authHeaders(token, "application/json")
      : authHeaders(token),
    ...(passphrase ? { body: JSON.stringify({ passphrase }) } : {}),
  });
  if (!res.ok) {
    await readJson(res, "export portable vault");
    throw new Error("portable export failed");
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename =
    /filename="(?<filename>[^"]+)"/u.exec(disposition)?.groups?.filename ??
    "centraid-vault.zip";
  return { blob: await res.blob(), filename };
}

export async function vaultImportsList(): Promise<VaultImportBatch[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/imports", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ batches: VaultImportBatch[] }>(
    res,
    "list imports"
  );
  return body.batches;
}

export async function vaultImportRows(
  batchId: string
): Promise<VaultImportRow[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/imports/${enc(batchId)}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const body = await readJson<{ rows: VaultImportRow[] }>(
    res,
    "read import batch"
  );
  return body.rows;
}

/** Publish a reviewed draft batch. */
export async function vaultImportPublish(batchId: string): Promise<{
  created: number;
  updated: number;
  skipped: number;
  failed: unknown[];
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/imports/${enc(batchId)}/publish`,
    {
      method: "POST",
      headers: authHeaders(token),
    }
  );
  return readJson(res, "publish import");
}

export async function vaultImportDiscard(
  batchId: string
): Promise<{ receiptId: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/imports/${enc(batchId)}/discard`,
    {
      method: "POST",
      headers: authHeaders(token),
    }
  );
  return readJson(res, "discard import");
}
