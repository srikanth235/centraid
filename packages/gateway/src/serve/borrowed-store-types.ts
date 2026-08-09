/*
 * A few borrowed-store types shared between `borrowed-store.ts` and
 * `borrowed-changes.ts` (#726 P5) — split out to a types-only module so
 * neither file needs to import the other.
 */

export interface BorrowedEntitySchema {
  entity: string;
  primaryKey: string;
  columns: string[];
  hasUnavailableFields?: boolean;
}

export interface BorrowedCursor {
  epoch: string;
  seq: number;
}

export interface BorrowedShape {
  shapeId: string;
  edgeId: string;
  originVaultId: string;
  appId: string;
  purpose: string;
  schemaEpoch: string;
  leaseExpiresAt: string;
  cursor?: BorrowedCursor;
}

export interface BorrowedShapeRow {
  shape_id: string;
  app_id: string;
  purpose: string;
  origin_vault_id: string;
  edge_id: string;
  schema_epoch: string;
  lease_expires_at: string;
  cursor_epoch: string | null;
  cursor_seq: number | null;
}

export function borrowedShapeOf(row: BorrowedShapeRow): BorrowedShape {
  return {
    shapeId: row.shape_id,
    edgeId: row.edge_id,
    originVaultId: row.origin_vault_id,
    appId: row.app_id,
    purpose: row.purpose,
    schemaEpoch: row.schema_epoch,
    leaseExpiresAt: row.lease_expires_at,
    ...(row.cursor_epoch !== null && row.cursor_seq !== null
      ? { cursor: { epoch: row.cursor_epoch, seq: row.cursor_seq } }
      : {}),
  };
}
