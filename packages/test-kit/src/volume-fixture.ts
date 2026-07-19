import { createHash } from 'node:crypto';

export interface VolumeFixtureOptions {
  parties?: number;
  photos?: number;
  replicaRows?: number;
  conversations?: number;
  turnsPerConversation?: number;
  blobBytes?: number;
  seed?: number;
}

export interface SyntheticParty {
  id: string;
  displayName: string;
}

export interface SyntheticPhoto {
  id: string;
  ownerId: string;
  capturedAt: number;
  sha256: string;
  bytes: number;
}

export interface SyntheticBlob {
  sha256: string;
  bytes: number;
  custody: 'local' | 'replicated' | 'pending';
}

export interface SyntheticConversation {
  id: string;
  ownerId: string;
  createdAt: number;
  turns: Array<{ id: string; at: number; text: string }>;
}

export interface SyntheticReplicaRow {
  shapeId: string;
  entity: string;
  rowId: string;
  values: Record<string, unknown>;
}

export interface VolumeFixture {
  parties: SyntheticParty[];
  photos: SyntheticPhoto[];
  blobs: SyntheticBlob[];
  conversations: SyntheticConversation[];
  replicaRows: SyntheticReplicaRow[];
  seed: number;
}

function deterministicSha(seed: number, index: number): string {
  return createHash('sha256').update(`${seed}:blob:${index}`).digest('hex');
}

/** Deterministic, allocation-bounded source data for perf and scale lanes. */
export function generateVolumeFixture(options: VolumeFixtureOptions = {}): VolumeFixture {
  const seed = options.seed ?? 458;
  const partyCount = options.parties ?? 100;
  const photoCount = options.photos ?? 1_000;
  const replicaRowCount = options.replicaRows ?? photoCount;
  const conversationCount = options.conversations ?? 100;
  const turnsPerConversation = options.turnsPerConversation ?? 20;
  const blobBytes = options.blobBytes ?? 256 * 1024;
  const epoch = 1_700_000_000_000 + seed * 1_000;

  const parties = Array.from({ length: partyCount }, (_, index) => ({
    id: `party-${seed}-${index}`,
    displayName: `Synthetic person ${index}`,
  }));
  const ownerFor = (index: number): string =>
    parties[index % Math.max(parties.length, 1)]?.id ?? 'owner';
  const photos = Array.from({ length: photoCount }, (_, index) => ({
    id: `photo-${seed}-${index}`,
    ownerId: ownerFor(index),
    capturedAt: epoch + index * 60_000,
    sha256: deterministicSha(seed, index),
    bytes: blobBytes + (index % 17) * 1_024,
  }));
  const conversations = Array.from({ length: conversationCount }, (_, index) => ({
    id: `conversation-${seed}-${index}`,
    ownerId: ownerFor(index),
    createdAt: epoch + index * 3_600_000,
    turns: Array.from({ length: turnsPerConversation }, (__, turn) => ({
      id: `turn-${seed}-${index}-${turn}`,
      at: epoch + index * 3_600_000 + turn * 60_000,
      text: `Synthetic conversation ${index}, turn ${turn}`,
    })),
  }));
  const blobs = photos.map((photo, index) => ({
    sha256: photo.sha256,
    bytes: photo.bytes,
    custody: (['local', 'replicated', 'pending'] as const)[index % 3]!,
  }));
  const replicaRows = Array.from({ length: replicaRowCount }, (_, index) => ({
    shapeId: 'shape-photos',
    entity: 'core.content_item',
    rowId: `photo-${seed}-${index}`,
    values: {
      content_id: `photo-${seed}-${index}`,
      title: `Synthetic ${index}`,
      captured_at: epoch + index * 60_000,
      sha256: deterministicSha(seed, index),
    },
  }));
  return { parties, photos, blobs, conversations, replicaRows, seed };
}
