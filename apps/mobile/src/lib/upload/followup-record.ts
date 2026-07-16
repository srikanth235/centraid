import type { UploadItem } from './store';

export interface UploadDerivativeFollowup {
  variant: 'thumb' | 'preview' | 'poster';
  uri: string;
  mediaType: 'image/jpeg';
}

export interface NewUploadFollowup {
  itemId: string;
  shape: string;
  action: string;
  input: Record<string, unknown>;
  derivatives?: UploadDerivativeFollowup[];
}

export interface UploadFollowup extends NewUploadFollowup {
  followupId: number;
  intentId: string;
}

export type UploadFollowupFactory = (item: UploadItem) => Omit<NewUploadFollowup, 'itemId'>;

export interface PersistedUploadFollowupRow {
  followup_id: number;
  item_id: string;
  intent_id: string;
  shape: string;
  action: string;
  input_json: string;
  derivatives_json: string | null;
}

export function toUploadFollowup(row: PersistedUploadFollowupRow): UploadFollowup {
  return {
    followupId: row.followup_id,
    itemId: row.item_id,
    intentId: row.intent_id,
    shape: row.shape,
    action: row.action,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    ...(row.derivatives_json === null
      ? {}
      : { derivatives: JSON.parse(row.derivatives_json) as UploadDerivativeFollowup[] }),
  };
}

/** Stable FNV-1a/64 identifier; the replica outbox also verifies payload equality. */
export function stableFollowupIntentId(
  itemId: string,
  shape: string,
  action: string,
  inputJson: string,
): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${itemId}\0${shape}\0${action}\0${inputJson}`)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `upload-followup-${itemId}-${hash.toString(16).padStart(16, '0')}`;
}
