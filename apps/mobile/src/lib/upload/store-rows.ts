// Row shapes and mappers for the upload queue's SQLite tables, split out of
// store.ts to keep that module under the governance line-cap. Pure functions
// over plain rows — no driver, no I/O.

import type { UploadItem, UploadItemState, UploadPart, UploadPartState } from './store';

export interface ItemRow {
  item_id: string;
  sha256: string;
  local_uri: string;
  media_type: string | null;
  filename: string | null;
  plaintext_size: number;
  sealed_size: number;
  frame_count: number;
  part_count: number;
  state: string;
  session_id: string | null;
  created_order: number;
  attempts: number;
  last_error: string | null;
  receipt_json: string | null;
}

export interface PartRow {
  part_number: number;
  state: string;
  etag: string | null;
}

export function toItem(row: ItemRow): UploadItem {
  return {
    itemId: row.item_id,
    sha256: row.sha256,
    localUri: row.local_uri,
    ...(row.media_type === null ? {} : { mediaType: row.media_type }),
    ...(row.filename === null ? {} : { filename: row.filename }),
    plaintextSize: row.plaintext_size,
    sealedSize: row.sealed_size,
    frameCount: row.frame_count,
    partCount: row.part_count,
    state: row.state as UploadItemState,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    createdOrder: row.created_order,
    attempts: row.attempts,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.receipt_json === null
      ? {}
      : { receipt: JSON.parse(row.receipt_json) as Record<string, unknown> }),
  };
}

export function toPart(row: PartRow): UploadPart {
  return {
    partNumber: row.part_number,
    state: row.state as UploadPartState,
    ...(row.etag === null ? {} : { etag: row.etag }),
  };
}
