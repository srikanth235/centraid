/*
 * The STAGED-IMPORT surface of the owner consent plane (#712 P18,
 * extracted from ./gateway-client-vault.ts — the same seam
 * `gateway-client-atlas.ts` was cut along).
 *
 * THE SEAM. Its parent adapter answers questions ABOUT the mounted vault —
 * status, list, apps, grants, parked writes, connections, enrichment policy —
 * each a single stateless owner act. Everything here belongs instead to one
 * multi-step WORKFLOW with a lifecycle of its own: a dropped file is staged
 * into a draft batch, the draft's rows are reviewed, and the batch is then
 * published or discarded. The portable export rides along because it is the
 * same door in the other direction (`/_vault/imports/export`) and shares this
 * module's one non-JSON response shape.
 *
 * Same route prefix, same credential, same `readJson` error grammar as the
 * parent; re-exported through `gateway-client.ts`'s barrel, so no caller
 * changes with the move.
 */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

/** One staged import batch as the shell lists it (#290). */
export interface VaultImportBatch {
  batchId: string;
  status: "draft" | "published" | "discarded";
  createdAt: string;
  resolvedAt: string | null;
  summary: Record<string, number>;
  kind: string | null;
  label: string | null;
}

/** One staged row for review. */
export interface VaultImportRow {
  seq: number;
  entityType: string;
  externalId: string;
  disposition: "create" | "update" | "skip" | "merge-candidate";
  note: string | null;
  publishedEntityId: string | null;
  mapping: string;
}

/** Stage a dropped file into a reviewable draft batch. */
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

/**
 * Download the verified all-data portable bundle.
 *
 * With a passphrase the bundle carries a password-wrapped custody kit and its
 * sealed cells can be restored elsewhere (#630); without one it is
 * ciphertext-only and an import of its secrets is refused. The passphrase goes
 * in a POST body, never a query string.
 */
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

/** Batches, newest first. */
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

/** The staged rows of one batch, for review. */
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
