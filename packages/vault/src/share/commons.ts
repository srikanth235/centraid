// governance: allow-repo-hygiene file-size-limit (#731) the grant compiler, signed command rail, and scrub transaction form one Commons integrity boundary; splitting their shared control projections would make authorization and cleanup drift independently
// Circle-backed commons (#731): vault-resident consent compiled onto the
// existing projection primitive — NOT a scheduler and not a second replication
// engine. Callers append one ordered command, execute it through the ordinary
// invoke path at the steward, then reconcile the declared closure into each
// member vault.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";
import { uuidv7 } from "../ids.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { vaultIdentityPublicKey } from "../schema/vault-identity.js";
import { placeBlob } from "./blobs.js";
import type { BlobPlacement } from "./blobs.js";
import type {
  ShareableItemType,
  WireClosure,
  ProjectedItem,
} from "./closure.js";
import { isShareableItemType } from "./closure.js";
import type { CommonsOpChainFields } from "./commons-chain.js";
import {
  attestCommonsCheckpointState,
  chainColumns,
  commonsGenesisHash,
  insertChainedCommonsOp,
} from "./commons-chain.js";
import {
  commonsTailBlobs,
  commonsTailIsContiguous,
  isCommonsReplayError,
  readCommonsTail,
  replayCommonsTail,
  replicaInvocationKey,
  stageCommonsTailBlobs,
} from "./commons-replay.js";
import type { CommonsReplicaExecutor } from "./commons-replay.js";
import {
  COMMONS_CONTAINER_KEYS,
  commonsRoutesForCommand,
  isCommonsCommandActable,
} from "./commons-routing.js";
import type { CommonsCommandRoute } from "./commons-routing.js";
import type { CommonsMemberSignature } from "./commons-signature.js";
import { verifyCommonsIntent } from "./commons-signature.js";
import type { ShareVaultRef } from "./placement.js";
import { unshareFromVault } from "./placement.js";
import { projectShareClosure } from "./project-closure.js";
import { readShareClosure } from "./read-closure.js";

export type CommonsCapability = "read" | "read+write";
export type CommonsDeparturePolicy =
  | "remove-member-only"
  | "retain-ledger-history";

export interface CommonsMemberInput {
  partyId: string;
  displayName?: string;
  vaultId?: string;
  /** Pinned Ed25519 public key when the member vault is linked remotely. */
  vaultPublicKey?: string;
  capability: CommonsCapability;
  /** Invitation without this seat stays pending and compiles no data. */
  vault?: ShareVaultRef;
  /** Host-only replica executor for command-tail replay (#750). Never
   * serialized, never reachable from member or app code. */
  applyCommand?: CommonsReplicaExecutor;
}

export interface CreateCommonsGrantInput {
  origin: DatabaseSync;
  ownerPartyId: string;
  ownerVaultId?: string;
  ownerVault?: ShareVaultRef;
  circleId?: string;
  circleName?: string;
  containerType: ShareableItemType;
  containerId: string;
  members: readonly CommonsMemberInput[];
  departurePolicy?: CommonsDeparturePolicy;
  maxSizeBytes?: number;
  implicit?: boolean;
  now: string;
}

export interface CommonsGrantRecord {
  grantId: string;
  circleId: string;
  containerType: ShareableItemType;
  containerId: string;
  stewardPartyId: string;
  departurePolicy: CommonsDeparturePolicy;
  lastSequence: number;
  checkpointSequence: number;
  maxSizeBytes?: number;
  revokedAt?: string;
}

export function ensureCommonsParty(
  db: DatabaseSync,
  member: Pick<CommonsMemberInput, "partyId" | "displayName" | "vault">,
  now: string
): void {
  if (
    db
      .prepare("SELECT 1 AS n FROM core_party WHERE party_id = ?")
      .get(member.partyId)
  )
    return;
  const mounted = member.vault?.vault
    .prepare("SELECT display_name FROM core_party WHERE party_id = ?")
    .get(member.partyId) as { display_name: string } | undefined;
  const displayName =
    member.displayName ??
    mounted?.display_name ??
    `Invited member ${member.partyId.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, birth_date,
        avatar_content_id, created_at, updated_at, ontology_version)
     VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?, '1.4')`
  ).run(member.partyId, displayName, displayName, now, now);
}

function sqlValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  )
    return value;
  throw new Error("commons projection received a non-SQL row value");
}

export function readCommonsGrant(
  db: DatabaseSync,
  grantId: string
): CommonsGrantRecord {
  const row = db
    .prepare(
      `SELECT grant_id, circle_id, container_type, container_id,
              steward_party_id, departure_policy, last_sequence,
              checkpoint_sequence, max_size_bytes, revoked_at
         FROM share_circle_grant WHERE grant_id = ?`
    )
    .get(grantId) as
    | {
        grant_id: string;
        circle_id: string;
        container_type: string;
        container_id: string;
        steward_party_id: string;
        departure_policy: CommonsDeparturePolicy;
        last_sequence: number;
        checkpoint_sequence: number;
        max_size_bytes: number | null;
        revoked_at: string | null;
      }
    | undefined;
  if (!row || !isShareableItemType(row.container_type))
    throw new Error(`commons grant ${grantId} is not available`);
  return {
    grantId: row.grant_id,
    circleId: row.circle_id,
    containerType: row.container_type,
    containerId: row.container_id,
    stewardPartyId: row.steward_party_id,
    departurePolicy: row.departure_policy,
    lastSequence: row.last_sequence,
    checkpointSequence: row.checkpoint_sequence,
    ...(row.max_size_bytes === null
      ? {}
      : { maxSizeBytes: row.max_size_bytes }),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

export function createCommonsGrant(
  input: CreateCommonsGrantInput
): CommonsGrantRecord {
  const containerCircle =
    input.containerType === "tally.group"
      ? (
          input.origin
            .prepare("SELECT circle_id FROM tally_group WHERE group_id = ?")
            .get(input.containerId) as { circle_id: string } | undefined
        )?.circle_id
      : undefined;
  const circleId = input.circleId ?? containerCircle ?? uuidv7();
  const grantId = uuidv7();
  const needsCircle =
    input.circleId === undefined && containerCircle === undefined;
  const implicit = input.implicit ?? needsCircle;
  input.origin.exec("BEGIN IMMEDIATE");
  try {
    if (needsCircle) {
      input.origin
        .prepare(
          `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
           VALUES (?, ?, ?, 'custom')`
        )
        .run(
          circleId,
          input.ownerPartyId,
          input.circleName ??
            `share:${input.containerType}:${input.containerId}`
        );
    }
    const selectedCircle = input.origin
      .prepare("SELECT owner_party_id FROM social_circle WHERE circle_id = ?")
      .get(circleId) as { owner_party_id: string } | undefined;
    if (!selectedCircle)
      throw new Error(`commons circle ${circleId} is not available`);
    // Named audiences are reusable, but only by their authority. A projected
    // circle in a member seat must never become a new grant's control plane.
    if (selectedCircle.owner_party_id !== input.ownerPartyId)
      throw new Error("commons requires an owner-controlled circle");
    if (
      input.origin
        .prepare(
          `SELECT 1 AS n FROM core_share_origin
            WHERE item_type = 'social.circle' AND item_id = ?
              AND shared_by LIKE 'commons:%'`
        )
        .get(circleId)
    )
      throw new Error("a projected Commons circle cannot control a new grant");
    const members = new Map<string, CommonsMemberInput>([
      [
        input.ownerPartyId,
        {
          partyId: input.ownerPartyId,
          capability: "read+write",
          ...(input.ownerVaultId
            ? { vaultId: input.ownerVaultId, vault: input.ownerVault }
            : {}),
        },
      ],
    ]);
    for (const member of input.members) members.set(member.partyId, member);
    if (!needsCircle) {
      const stored = input.origin
        .prepare(
          `SELECT party_id, capability FROM social_circle_member
            WHERE circle_id = ? ORDER BY party_id`
        )
        .all(circleId) as {
        party_id: string;
        capability: CommonsCapability;
      }[];
      if (
        stored.length !== members.size ||
        stored.some(
          (row) => members.get(row.party_id)?.capability !== row.capability
        )
      )
        throw new Error(
          "a named Commons circle requires its exact stored roster and capabilities"
        );
    }
    for (const member of members.values()) {
      ensureCommonsParty(input.origin, member, input.now);
      if (needsCircle)
        input.origin
          .prepare(
            `INSERT INTO social_circle_member
             (member_id, circle_id, party_id, added_at, capability)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(circle_id, party_id) DO UPDATE SET
             capability = excluded.capability`
          )
          .run(
            uuidv7(),
            circleId,
            member.partyId,
            input.now,
            member.capability
          );
      if (member.vaultId) {
        const publicKey =
          member.vaultPublicKey ??
          (member.vault?.identitySeed
            ? vaultIdentityPublicKey(member.vault.identitySeed).toString(
                "base64"
              )
            : null);
        input.origin
          .prepare(
            `INSERT INTO share_party_vault_binding
               (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
             VALUES (?, ?, ?, ?, ?, NULL)
             ON CONFLICT(party_id, vault_id) DO UPDATE SET
               vault_public_key = COALESCE(excluded.vault_public_key, vault_public_key),
               revoked_at = NULL`
          )
          .run(uuidv7(), member.partyId, member.vaultId, publicKey, input.now);
      }
    }
    input.origin
      .prepare(
        `INSERT INTO share_circle_grant
           (grant_id, circle_id, container_type, container_id, plane,
            departure_policy, implicit_circle, steward_party_id, created_at,
            chain_head_sequence, chain_head_hash, max_size_bytes)
         VALUES (?, ?, ?, ?, 'commons', ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        grantId,
        circleId,
        input.containerType,
        input.containerId,
        input.departurePolicy ??
          (input.containerType === "tally.group"
            ? "retain-ledger-history"
            : "remove-member-only"),
        implicit ? 1 : 0,
        input.ownerPartyId,
        input.now,
        commonsGenesisHash(grantId),
        input.maxSizeBytes ?? null
      );
    const memberState = input.origin.prepare(
      `INSERT INTO share_commons_member_state
         (grant_id, party_id, status, accepted_at)
       VALUES (?, ?, ?, ?)`
    );
    const circleMembers = input.origin
      .prepare("SELECT party_id FROM social_circle_member WHERE circle_id = ?")
      .all(circleId) as { party_id: string }[];
    for (const row of circleMembers) {
      const requested = members.get(row.party_id);
      const current =
        row.party_id === input.ownerPartyId || requested?.vaultId !== undefined;
      memberState.run(
        grantId,
        row.party_id,
        current ? "current" : "invited",
        current ? input.now : null
      );
    }
    input.origin.exec("COMMIT");
  } catch (error) {
    input.origin.exec("ROLLBACK");
    throw error;
  }
  return readCommonsGrant(input.origin, grantId);
}

/** Commons carries source domain rows and source blobs, never another seat's
 * model output; each seat's projection-ingest hooks enqueue its own. */
export function commonsClosure(
  origin: DatabaseSync,
  originVaultId: string,
  grant: CommonsGrantRecord
): WireClosure {
  const closure = readShareClosure(origin, {
    originVaultId,
    itemType: grant.containerType,
    itemIds: [grant.containerId],
    crossOwner: true,
  });
  const domainShas = new Set(
    closure.rows.contentItems.map((row) => row.sha256)
  );
  return {
    ...closure,
    rows: { ...closure.rows, derivatives: [] },
    blobs: closure.blobs.filter((blob) => domainShas.has(blob.sha256)),
  };
}

/** The honest full-copy footprint shown before acceptance. Domain rows are
 * their exact UTF-8 wire representation; content bytes count once per sha. */
export function commonsClosureSizeBytes(closure: WireClosure): number {
  const blobSizes = new Map<string, number>();
  for (const blob of closure.blobs) blobSizes.set(blob.sha256, blob.size);
  return (
    Buffer.byteLength(JSON.stringify(closure), "utf8") +
    [...blobSizes.values()].reduce((sum, size) => sum + size, 0)
  );
}

/** Fail-closed ceiling when a grant declares no maximum: without one a member
 * could grow the co-owned closure without bound (#731). Four gibibytes is
 * generous for a shared album/folder/ledger yet finite. */
export const COMMONS_DEFAULT_MAX_SIZE_BYTES = 4 * 1024 * 1024 * 1024;

/** Verbose ops retained past the checkpoint before a lagging member must
 * re-bootstrap from the snapshot, so one laggard cannot stall compaction. */
export const COMMONS_OP_RETENTION_FLOOR = 256;

/** Ops between stored checkpoints (#750 invariant 7). The full closure is
 * serialized onto the grant row only when a checkpoint is CUT, never on every
 * compile, so one write does not rewrite `checkpoint_json` for the commons. */
export const COMMONS_CHECKPOINT_INTERVAL = 32;

/** Store the full closure + sequence on the grant row and attest it. The ONLY
 * writer of `checkpoint_json` outside a projected control frame (#750). */
export function checkpointCommonsState(input: {
  steward: ShareVaultRef;
  stewardVaultId: string;
  grantId: string;
  /** Thunked on purpose: building the closure is the O(commons size) walk this
   * design exists to avoid, so it must not run when no checkpoint is due. */
  closure: () => WireClosure;
  now: string;
  force?: boolean;
}): boolean {
  const grant = readCommonsGrant(input.steward.vault, input.grantId);
  const stored = input.steward.vault
    .prepare(
      "SELECT checkpoint_json IS NOT NULL AS held FROM share_circle_grant WHERE grant_id = ?"
    )
    .get(input.grantId) as { held: number } | undefined;
  const due =
    input.force === true ||
    stored?.held !== 1 ||
    grant.lastSequence - grant.checkpointSequence >=
      COMMONS_CHECKPOINT_INTERVAL;
  if (!due) return false;
  const closure = input.closure();
  input.steward.vault
    .prepare(
      `UPDATE share_circle_grant
          SET checkpoint_sequence = last_sequence, checkpoint_json = ?
        WHERE grant_id = ?`
    )
    .run(JSON.stringify(closure), input.grantId);
  attestCommonsCheckpointState({
    steward: input.steward,
    stewardVaultId: input.stewardVaultId,
    grantId: input.grantId,
    sequence: grant.lastSequence,
    closure,
  });
  return true;
}

export class CommonsMaxSizeError extends Error {
  constructor(
    readonly currentSizeBytes: number,
    readonly maxSizeBytes: number
  ) {
    super(
      `commons closure is ${currentSizeBytes} bytes, above its ${maxSizeBytes} byte maximum`
    );
    this.name = "CommonsMaxSizeError";
  }
}

/** Call before appending/committing the operation, so a write crossing the
 * declared ceiling rolls the domain row and journal back too. */
export function assertCommonsWithinMax(
  steward: DatabaseSync,
  stewardVaultId: string,
  grantId: string
): number {
  const grant = readCommonsGrant(steward, grantId);
  const sizeBytes = commonsClosureSizeBytes(
    commonsClosure(steward, stewardVaultId, grant)
  );
  const ceiling = grant.maxSizeBytes ?? COMMONS_DEFAULT_MAX_SIZE_BYTES;
  if (sizeBytes > ceiling) throw new CommonsMaxSizeError(sizeBytes, ceiling);
  return sizeBytes;
}

export interface CompileCommonsInput {
  steward: ShareVaultRef;
  stewardVaultId: string;
  grantId: string;
  seats: readonly CommonsMemberInput[];
  now: string;
  /** Skip command-tail replay and re-project every seat from the closure —
   * for crash-repair fan-out and restore, never for ordinary compiles. */
  forceFullProjection?: boolean;
}

export interface CompiledCommonsSeat {
  partyId: string;
  vaultId?: string;
  status: "current" | "invited";
  projected?: readonly ProjectedItem[];
  blobs?: readonly BlobPlacement[];
}

export function acknowledgeCommonsSeatCursor(input: {
  steward: DatabaseSync;
  grantId: string;
  memberVaultId: string;
  sequence: number;
  now: string;
}): void {
  input.steward
    .prepare(
      `INSERT INTO share_commons_cursor
         (grant_id, member_vault_id, sequence, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(grant_id, member_vault_id) DO UPDATE SET
         sequence = MAX(sequence, excluded.sequence),
         updated_at = excluded.updated_at`
    )
    .run(input.grantId, input.memberVaultId, input.sequence, input.now);
}

/** Bound the verbose op log at the minimum current member acknowledgement. A
 * complete checkpoint covers every pruned sequence, and signed replay decisions
 * move into the compact nonce ledger before their command rows leave. */
export function compactCommonsOperations(
  steward: DatabaseSync,
  grantId: string,
  force = false
): number {
  const verboseCount = (
    steward
      .prepare("SELECT COUNT(*) AS n FROM share_commons_op WHERE grant_id = ?")
      .get(grantId) as { n: number }
  ).n;
  // A checkpoint every command would churn the compact ledgers; mount/tests may
  // force an immediate pass when proving recovery semantics.
  if (!force && verboseCount < 32) return 0;
  const grant = readCommonsGrant(steward, grantId);
  const expected = steward
    .prepare(
      `SELECT COUNT(DISTINCT b.vault_id) AS n
         FROM share_commons_member_state s
         JOIN share_party_vault_binding b
           ON b.party_id = s.party_id AND b.revoked_at IS NULL
        WHERE s.grant_id = ? AND s.status = 'current'`
    )
    .get(grantId) as { n: number };
  const cursors = steward
    .prepare(
      `SELECT COUNT(DISTINCT c.member_vault_id) AS n,
              MIN(c.sequence) AS minimum
         FROM share_commons_cursor c
         JOIN share_party_vault_binding b
           ON b.vault_id = c.member_vault_id AND b.revoked_at IS NULL
         JOIN share_commons_member_state s
           ON s.grant_id = c.grant_id AND s.party_id = b.party_id
          AND s.status = 'current'
        WHERE c.grant_id = ?`
    )
    .get(grantId) as { n: number; minimum: number | null };
  // Prune verbose ops only to a point every replica can still recover from: the
  // checkpoint covers everything pruned, so a too-far-behind member
  // re-bootstraps instead of tailing. A current member that never established a
  // cursor must NOT pin the tail forever (the old all-members-advanced gate
  // stalled here); advanced members hold the tail back to their slowest cursor
  // but never past the bounded floor.
  const laggards = expected.n > 0 && cursors.n < expected.n;
  const advancedFloor =
    cursors.n === 0 ? grant.checkpointSequence : (cursors.minimum ?? 0);
  const retentionFloor = grant.lastSequence - COMMONS_OP_RETENTION_FLOOR;
  const through = Math.min(
    grant.checkpointSequence,
    laggards ? Math.max(advancedFloor, retentionFloor) : advancedFloor
  );
  if (through <= 0) return 0;
  steward
    .prepare(
      `INSERT INTO share_commons_receipt
         (grant_id, sequence, kind, actor_party_id, outcome, reason, created_at)
       SELECT grant_id, sequence, kind, actor_party_id, outcome, reason, created_at
         FROM share_commons_op
        WHERE grant_id = ? AND sequence <= ?
       ON CONFLICT(grant_id, sequence) DO NOTHING`
    )
    .run(grantId, through);
  steward
    .prepare(
      `INSERT INTO share_commons_replay
         (grant_id, signing_vault_id, signature_nonce, sequence, outcome, reason)
       SELECT grant_id, signing_vault_id, signature_nonce, sequence, outcome, reason
         FROM share_commons_op
        WHERE grant_id = ? AND sequence <= ?
          AND signing_vault_id IS NOT NULL AND signature_nonce IS NOT NULL
       ON CONFLICT(grant_id, signing_vault_id, signature_nonce) DO NOTHING`
    )
    .run(grantId, through);
  return Number(
    steward
      .prepare(
        "DELETE FROM share_commons_op WHERE grant_id = ? AND sequence <= ?"
      )
      .run(grantId, through).changes
  );
}

function projectRoster(
  audience: DatabaseSync,
  source: DatabaseSync,
  grant: CommonsGrantRecord,
  now: string
): void {
  if (audience === source) {
    audience
      .prepare(
        `INSERT INTO share_commons_cursor (grant_id, member_vault_id, sequence, updated_at)
         VALUES (?, (SELECT vault_id FROM core_vault LIMIT 1), ?, ?)
         ON CONFLICT(grant_id, member_vault_id) DO UPDATE SET
           sequence = excluded.sequence, updated_at = excluded.updated_at`
      )
      .run(grant.grantId, grant.lastSequence, now);
    return;
  }
  const circle = source
    .prepare("SELECT * FROM social_circle WHERE circle_id = ?")
    .get(grant.circleId) as Record<string, unknown>;
  const members = source
    .prepare(
      "SELECT * FROM social_circle_member WHERE circle_id = ? ORDER BY added_at, member_id"
    )
    .all(grant.circleId) as Record<string, unknown>[];
  const partyIds = new Set([
    String(circle["owner_party_id"]),
    ...members.map((member) => String(member["party_id"])),
  ]);
  for (const partyId of partyIds) {
    const party = source
      .prepare("SELECT * FROM core_party WHERE party_id = ?")
      .get(partyId) as Record<string, unknown> | undefined;
    if (!party) continue;
    audience
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, birth_date,
            avatar_content_id, created_at, updated_at, ontology_version)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT(party_id) DO UPDATE SET
           kind = excluded.kind, display_name = excluded.display_name,
           sort_name = excluded.sort_name, birth_date = excluded.birth_date,
           updated_at = excluded.updated_at,
           ontology_version = excluded.ontology_version`
      )
      .run(
        sqlValue(party["party_id"]),
        sqlValue(party["kind"]),
        sqlValue(party["display_name"]),
        sqlValue(party["sort_name"]),
        sqlValue(party["birth_date"]),
        sqlValue(party["created_at"]),
        sqlValue(party["updated_at"]),
        sqlValue(party["ontology_version"])
      );
  }
  audience
    .prepare(
      `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(circle_id) DO UPDATE SET name = excluded.name, kind = excluded.kind`
    )
    .run(
      sqlValue(circle["circle_id"]),
      sqlValue(circle["owner_party_id"]),
      sqlValue(circle["name"]),
      sqlValue(circle["kind"])
    );
  const sourceVault = source
    .prepare("SELECT vault_id FROM core_vault LIMIT 1")
    .get() as { vault_id: string } | undefined;
  if (!sourceVault)
    throw new Error("commons source vault identity is unavailable");
  audience
    .prepare(
      `INSERT INTO core_share_origin
         (item_type, item_id, origin_vault_id, origin_item_id,
          shared_by, shared_at)
       VALUES ('social.circle', ?, ?, ?, ?, ?)
       ON CONFLICT(item_type, item_id) DO UPDATE SET
         origin_vault_id = excluded.origin_vault_id,
         origin_item_id = excluded.origin_item_id,
         shared_by = excluded.shared_by,
         shared_at = excluded.shared_at`
    )
    .run(
      grant.circleId,
      sourceVault.vault_id,
      grant.circleId,
      `commons:${grant.grantId}`,
      Date.parse(now)
    );
  audience
    .prepare("DELETE FROM social_circle_member WHERE circle_id = ?")
    .run(grant.circleId);
  for (const member of members) {
    audience
      .prepare(
        `INSERT INTO social_circle_member
           (member_id, circle_id, party_id, added_at, capability)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        sqlValue(member["member_id"]),
        sqlValue(member["circle_id"]),
        sqlValue(member["party_id"]),
        sqlValue(member["added_at"]),
        sqlValue(member["capability"])
      );
  }
  const sourceGrant = source
    .prepare("SELECT * FROM share_circle_grant WHERE grant_id = ?")
    .get(grant.grantId) as Record<string, unknown>;
  audience
    .prepare(
      `INSERT INTO share_circle_grant
         (grant_id, circle_id, container_type, container_id, plane,
          departure_policy, implicit_circle, steward_party_id, created_at,
          revoked_at, last_sequence, checkpoint_sequence, checkpoint_json,
          chain_head_sequence, chain_head_hash, max_size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(grant_id) DO UPDATE SET
         circle_id = excluded.circle_id,
         container_type = excluded.container_type,
         container_id = excluded.container_id,
         plane = excluded.plane,
         departure_policy = excluded.departure_policy,
         implicit_circle = excluded.implicit_circle,
         steward_party_id = excluded.steward_party_id,
         created_at = excluded.created_at,
         revoked_at = excluded.revoked_at,
         last_sequence = excluded.last_sequence,
         checkpoint_sequence = excluded.checkpoint_sequence,
         checkpoint_json = excluded.checkpoint_json,
         chain_head_sequence = excluded.chain_head_sequence,
         chain_head_hash = excluded.chain_head_hash,
         max_size_bytes = excluded.max_size_bytes`
    )
    .run(
      sqlValue(sourceGrant["grant_id"]),
      sqlValue(sourceGrant["circle_id"]),
      sqlValue(sourceGrant["container_type"]),
      sqlValue(sourceGrant["container_id"]),
      sqlValue(sourceGrant["plane"]),
      sqlValue(sourceGrant["departure_policy"]),
      sqlValue(sourceGrant["implicit_circle"]),
      sqlValue(sourceGrant["steward_party_id"]),
      sqlValue(sourceGrant["created_at"]),
      sqlValue(sourceGrant["revoked_at"]),
      sqlValue(sourceGrant["last_sequence"]),
      sqlValue(sourceGrant["checkpoint_sequence"]),
      sqlValue(sourceGrant["checkpoint_json"]),
      sqlValue(sourceGrant["chain_head_sequence"]),
      sqlValue(sourceGrant["chain_head_hash"]),
      sqlValue(sourceGrant["max_size_bytes"])
    );
  audience
    .prepare("DELETE FROM share_commons_member_state WHERE grant_id = ?")
    .run(grant.grantId);
  const states = source
    .prepare(
      "SELECT * FROM share_commons_member_state WHERE grant_id = ? ORDER BY party_id"
    )
    .all(grant.grantId) as Record<string, unknown>[];
  const insertState = audience.prepare(
    `INSERT INTO share_commons_member_state
       (grant_id, party_id, status, accepted_at) VALUES (?, ?, ?, ?)`
  );
  for (const state of states)
    insertState.run(
      sqlValue(state["grant_id"]),
      sqlValue(state["party_id"]),
      sqlValue(state["status"]),
      sqlValue(state["accepted_at"])
    );
  audience
    .prepare(
      "DELETE FROM share_party_vault_binding WHERE party_id IN (SELECT party_id FROM social_circle_member WHERE circle_id = ?)"
    )
    .run(grant.circleId);
  const bindings = source
    .prepare(
      `SELECT * FROM share_party_vault_binding
        WHERE party_id IN (SELECT party_id FROM social_circle_member WHERE circle_id = ?)`
    )
    .all(grant.circleId) as Record<string, unknown>[];
  const insertBinding = audience.prepare(
    `INSERT INTO share_party_vault_binding
       (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const binding of bindings)
    insertBinding.run(
      sqlValue(binding["binding_id"]),
      sqlValue(binding["party_id"]),
      sqlValue(binding["vault_id"]),
      sqlValue(binding["vault_public_key"]),
      sqlValue(binding["linked_at"]),
      sqlValue(binding["revoked_at"])
    );
  audience
    .prepare("DELETE FROM share_commons_receipt WHERE grant_id = ?")
    .run(grant.grantId);
  const receipts = source
    .prepare(
      `SELECT * FROM share_commons_receipt
        WHERE grant_id = ? ORDER BY sequence`
    )
    .all(grant.grantId) as Record<string, unknown>[];
  const insertReceipt = audience.prepare(
    `INSERT INTO share_commons_receipt
       (grant_id, sequence, kind, actor_party_id, outcome, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of receipts)
    insertReceipt.run(
      sqlValue(row["grant_id"]),
      sqlValue(row["sequence"]),
      sqlValue(row["kind"]),
      sqlValue(row["actor_party_id"]),
      sqlValue(row["outcome"]),
      sqlValue(row["reason"]),
      sqlValue(row["created_at"])
    );
  audience
    .prepare("DELETE FROM share_commons_replay WHERE grant_id = ?")
    .run(grant.grantId);
  const replay = source
    .prepare(
      `SELECT * FROM share_commons_replay
        WHERE grant_id = ? ORDER BY sequence, signing_vault_id, signature_nonce`
    )
    .all(grant.grantId) as Record<string, unknown>[];
  const insertReplay = audience.prepare(
    `INSERT INTO share_commons_replay
       (grant_id, signing_vault_id, signature_nonce, sequence, outcome, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const row of replay)
    insertReplay.run(
      sqlValue(row["grant_id"]),
      sqlValue(row["signing_vault_id"]),
      sqlValue(row["signature_nonce"]),
      sqlValue(row["sequence"]),
      sqlValue(row["outcome"]),
      sqlValue(row["reason"])
    );
  audience
    .prepare(
      "DELETE FROM share_commons_op WHERE grant_id = ? AND sequence <= ?"
    )
    .run(grant.grantId, grant.checkpointSequence);
  const operations = source
    .prepare(
      "SELECT * FROM share_commons_op WHERE grant_id = ? ORDER BY sequence"
    )
    .all(grant.grantId) as Record<string, unknown>[];
  const insertOperation = audience.prepare(
    `INSERT INTO share_commons_op
       (grant_id, sequence, op_id, kind, actor_party_id, command, input_json,
        member_signature, signing_vault_id, signature_nonce, outcome, reason,
        created_at, prev_hash, op_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(grant_id, sequence) DO UPDATE SET
       op_id = excluded.op_id, kind = excluded.kind,
       actor_party_id = excluded.actor_party_id, command = excluded.command,
       input_json = excluded.input_json,
       member_signature = excluded.member_signature,
       signing_vault_id = excluded.signing_vault_id,
       signature_nonce = excluded.signature_nonce,
       outcome = excluded.outcome, reason = excluded.reason,
       created_at = excluded.created_at, prev_hash = excluded.prev_hash,
       op_hash = excluded.op_hash`
  );
  for (const operation of operations)
    insertOperation.run(
      sqlValue(operation["grant_id"]),
      sqlValue(operation["sequence"]),
      sqlValue(operation["op_id"]),
      sqlValue(operation["kind"]),
      sqlValue(operation["actor_party_id"]),
      sqlValue(operation["command"]),
      sqlValue(operation["input_json"]),
      sqlValue(operation["member_signature"]),
      sqlValue(operation["signing_vault_id"]),
      sqlValue(operation["signature_nonce"]),
      sqlValue(operation["outcome"]),
      sqlValue(operation["reason"]),
      sqlValue(operation["created_at"]),
      ...chainColumns(operation)
    );
  audience
    .prepare(
      `INSERT INTO share_commons_cursor (grant_id, member_vault_id, sequence, updated_at)
       VALUES (?, (SELECT vault_id FROM core_vault LIMIT 1), ?, ?)
       ON CONFLICT(grant_id, member_vault_id) DO UPDATE SET
         sequence = excluded.sequence, updated_at = excluded.updated_at`
    )
    .run(grant.grantId, grant.lastSequence, now);
}

/** Idempotent. An invite with no vault is represented but receives no rows;
 * joining later is snapshot-at-current-sequence plus tail. */
export function compileCommons(
  input: CompileCommonsInput
): CompiledCommonsSeat[] {
  const grant = readCommonsGrant(input.steward.vault, input.grantId);
  if (grant.revokedAt)
    throw new Error(`commons grant ${input.grantId} is revoked`);
  // Lazy on purpose (#750 invariant 7): reading and projecting the whole
  // closure is the O(commons size) cost this compile exists to avoid, so the
  // declared-ceiling check rides inside the same thunk rather than forcing the
  // walk. The ceiling still fails closed on every WRITE — `executeCommonsCommand`
  // asserts it inside the command's own transaction.
  let loadedClosure: WireClosure | undefined;
  const closure = (): WireClosure => {
    if (!loadedClosure) {
      const walked = commonsClosure(
        input.steward.vault,
        input.stewardVaultId,
        grant
      );
      const sizeBytes = commonsClosureSizeBytes(walked);
      const ceiling = grant.maxSizeBytes ?? COMMONS_DEFAULT_MAX_SIZE_BYTES;
      if (sizeBytes > ceiling)
        throw new CommonsMaxSizeError(sizeBytes, ceiling);
      loadedClosure = walked;
    }
    return loadedClosure;
  };
  const results: CompiledCommonsSeat[] = [];
  for (const seat of input.seats) {
    if (!seat.vault || !seat.vaultId) {
      results.push({ partyId: seat.partyId, status: "invited" });
      continue;
    }
    if (seat.vault.vault === input.steward.vault) {
      projectRoster(seat.vault.vault, input.steward.vault, grant, input.now);
      // The current source becomes an ordinary member seat after a steward
      // transfer, so record the managed root here too: the successor must be
      // able to REPLACE this seat's changing snapshot, not merely dedupe it.
      seat.vault.vault
        .prepare(
          `INSERT INTO share_commons_lineage
             (grant_id, item_type, item_id, origin_item_id)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(grant_id, item_type, item_id) DO NOTHING`
        )
        .run(
          grant.grantId,
          grant.containerType,
          grant.containerId,
          grant.containerId
        );
      const successorVault = seat.vault.vault
        .prepare(
          `SELECT vault_id FROM share_party_vault_binding
            WHERE party_id = ? AND revoked_at IS NULL
            ORDER BY linked_at DESC LIMIT 1`
        )
        .get(grant.stewardPartyId) as { vault_id: string } | undefined;
      if (successorVault && successorVault.vault_id !== input.stewardVaultId) {
        // Mid-handoff the old steward is still the readable source for the
        // final snapshot, but ownership of later writes has moved. Marking the
        // root successor-managed lets the next compile replace it; ordinary
        // unshare still refuses authored roots.
        seat.vault.vault
          .prepare(
            `INSERT INTO core_share_origin
               (item_type, item_id, origin_vault_id, origin_item_id,
                shared_by, shared_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(item_type, item_id) DO UPDATE SET
               origin_vault_id = excluded.origin_vault_id,
               origin_item_id = excluded.origin_item_id,
               shared_by = excluded.shared_by,
               shared_at = excluded.shared_at`
          )
          .run(
            grant.containerType,
            grant.containerId,
            successorVault.vault_id,
            grant.containerId,
            `commons:${grant.grantId}`,
            Date.parse(input.now)
          );
      }
      results.push({
        partyId: seat.partyId,
        vaultId: seat.vaultId,
        status: "current",
        projected: [
          {
            itemType: grant.containerType,
            originItemId: grant.containerId,
            itemId: grant.containerId,
            deduped: true,
          },
        ],
        // The steward reads its own bytes; enumerating the closure just to say
        // so would force the walk the replay path exists to skip.
        blobs: [],
      });
      continue;
    }
    const retained = seat.vault.vault
      .prepare(
        `SELECT 1 AS n FROM share_commons_retained
          WHERE grant_id = ? AND item_type = ? AND item_id = ?`
      )
      .get(grant.grantId, grant.containerType, grant.containerId);
    if (retained) {
      // A retained root is now receiver-authored: keep control truth current,
      // but never re-project or re-lineage it on later steward writes.
      projectRoster(seat.vault.vault, input.steward.vault, grant, input.now);
      results.push({
        partyId: seat.partyId,
        vaultId: seat.vaultId,
        status: "current",
        projected: [
          {
            itemType: grant.containerType,
            originItemId: grant.containerId,
            itemId: grant.containerId,
            deduped: true,
          },
        ],
        blobs: [],
      });
      continue;
    }
    // The ordinary placement projector is idempotent for a ONE-TIME copy, so an
    // existing root means "already placed". A commons is a changing complete
    // closure, so replace this grant's prior projection first; lineage confines
    // the scrub to rows this grant introduced.
    const hasProjection = seat.vault.vault
      .prepare(
        "SELECT 1 AS n FROM share_commons_lineage WHERE grant_id = ? LIMIT 1"
      )
      .get(grant.grantId);
    // Command-tail replay (#750 invariant 7): a seat holding a projection whose
    // cursor sits on the retained op chain RE-EXECUTES the operations it missed
    // instead of receiving one. Its unchanged items and seat-local derived rows
    // (OCR/embeddings/FTS) are untouched and the steward never walks the
    // closure. ANY replay failure falls back to the full scrub + re-project
    // below, which stays the one destructive path.
    if (!input.forceFullProjection && hasProjection && seat.vaultId) {
      // The SEAT's own cursor row, never the steward's belief about it: a
      // member vault restored from an old backup carries its real, rewound
      // cursor, and replaying from the wrong anchor applies a command to state
      // it was never authored against.
      const cursor = seat.vault.vault
        .prepare(
          `SELECT sequence FROM share_commons_cursor
            WHERE grant_id = ? AND member_vault_id = ?`
        )
        .get(grant.grantId, seat.vaultId) as { sequence: number } | undefined;
      const fromSequence = cursor ? Number(cursor.sequence) : undefined;
      const tail =
        fromSequence === undefined
          ? []
          : readCommonsTail(input.steward.vault, grant.grantId, fromSequence);
      const replayable =
        seat.applyCommand !== undefined &&
        fromSequence !== undefined &&
        commonsTailIsContiguous({
          tail,
          fromSequence,
          headSequence: grant.lastSequence,
        });
      if (replayable) {
        // Bytes claimed by sha cannot be re-derived from a command's input the
        // way ids can, so they travel first. Placement is filesystem-idempotent
        // and independent of the domain rows, so it stays outside the
        // transaction below.
        const manifest = commonsTailBlobs(input.steward.vault, tail);
        const tailBlobs = manifest.map((entry) => ({
          sha256: entry.sha256,
          mode: placeBlob(
            input.steward.blobs.local,
            seat.vault!.blobs.local,
            entry.sha256
          ),
        }));
        const seatDb = seat.vault.vault;
        const nested = seatDb.isTransaction;
        seatDb.exec(
          nested ? "SAVEPOINT compile_commons_replay" : "BEGIN IMMEDIATE"
        );
        let applied = false;
        try {
          const replicaCommit = beginReplicaCommit(seatDb);
          stageCommonsTailBlobs(seatDb, manifest);
          replayCommonsTail({
            grantId: grant.grantId,
            tail,
            execute: seat.applyCommand!,
          });
          projectRoster(seatDb, input.steward.vault, grant, input.now);
          endReplicaCommit(seatDb, replicaCommit);
          seatDb.exec(nested ? "RELEASE compile_commons_replay" : "COMMIT");
          applied = true;
        } catch (error) {
          seatDb.exec(
            nested ? "ROLLBACK TO compile_commons_replay" : "ROLLBACK"
          );
          if (nested) seatDb.exec("RELEASE compile_commons_replay");
          if (!isCommonsReplayError(error)) throw error;
        }
        if (applied) {
          results.push({
            partyId: seat.partyId,
            vaultId: seat.vaultId,
            status: "current",
            projected: [
              {
                itemType: grant.containerType,
                originItemId: grant.containerId,
                itemId: grant.containerId,
                deduped: true,
              },
            ],
            blobs: tailBlobs,
          });
          continue;
        }
      }
    }
    // Filesystem-idempotent and independent of the domain rows, so it stays
    // outside the DB transaction below.
    const blobs = closure().blobs.map((entry) => ({
      sha256: entry.sha256,
      mode: placeBlob(
        input.steward.blobs.local,
        seat.vault!.blobs.local,
        entry.sha256
      ),
    }));
    // Scrub + re-project + roster + lineage are ONE atomic unit: a crash
    // between the destructive scrub and the re-projection must never leave the
    // commons deleted on disk. Savepoint when the caller already owns the seat
    // transaction, so BEGIN is never double-opened.
    const seatDb = seat.vault.vault;
    const nested = seatDb.isTransaction;
    seatDb.exec(nested ? "SAVEPOINT compile_commons_seat" : "BEGIN IMMEDIATE");
    let projection: ReturnType<typeof projectShareClosure>;
    try {
      if (hasProjection) {
        // The projected grant references the projected circle, so drop that
        // local roster snapshot first; `projectRoster` reinstates it.
        seatDb
          .prepare("DELETE FROM share_circle_grant WHERE grant_id = ?")
          .run(grant.grantId);
        removeCommonsFromSeat({
          seat: seat.vault,
          grantId: grant.grantId,
          preserveControlState: true,
        });
      }
      projection = projectShareClosure(seatDb, closure(), {
        sharedBy: `commons:${grant.grantId}`,
        now: () => Date.parse(input.now),
        keys:
          input.steward.sealKey && seat.vault.sealKey
            ? { origin: input.steward.sealKey, audience: seat.vault.sealKey }
            : undefined,
      });
      projectRoster(seatDb, input.steward.vault, grant, input.now);
      const lineage = seatDb.prepare(
        `INSERT INTO share_commons_lineage
           (grant_id, item_type, item_id, origin_item_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(grant_id, item_type, item_id) DO NOTHING`
      );
      for (const item of projection.items)
        lineage.run(
          grant.grantId,
          item.itemType,
          item.itemId,
          item.originItemId
        );
      seatDb.exec(nested ? "RELEASE compile_commons_seat" : "COMMIT");
    } catch (error) {
      seatDb.exec(nested ? "ROLLBACK TO compile_commons_seat" : "ROLLBACK");
      if (nested) seatDb.exec("RELEASE compile_commons_seat");
      throw error;
    }
    results.push({
      partyId: seat.partyId,
      vaultId: seat.vaultId,
      status: "current",
      projected: projection.items,
      blobs,
    });
  }
  for (const result of results)
    if (result.status === "current" && result.vaultId)
      acknowledgeCommonsSeatCursor({
        steward: input.steward.vault,
        grantId: grant.grantId,
        memberVaultId: result.vaultId,
        sequence: grant.lastSequence,
        now: input.now,
      });
  // The full closure lands on the grant row only when a checkpoint is DUE —
  // every COMMONS_CHECKPOINT_INTERVAL ops, or the first compile — never on
  // every command (#750 defect c). Between checkpoints the stored snapshot
  // stays put as the seat's proof anchor.
  checkpointCommonsState({
    steward: input.steward,
    stewardVaultId: input.stewardVaultId,
    grantId: grant.grantId,
    closure,
    now: input.now,
  });
  compactCommonsOperations(input.steward.vault, grant.grantId);
  return results;
}

export interface AppendCommonsOpInput {
  steward: DatabaseSync;
  grantId: string;
  actorPartyId: string;
  kind:
    | "command"
    | "member_added"
    | "member_joined"
    | "member_refused"
    | "member_removed"
    | "capability_changed"
    | "grant_revoked"
    | "steward_transferred"
    | "delete";
  command?: string;
  input?: unknown;
  memberSignature?: CommonsMemberSignature;
  outcome: "executed" | "refused";
  reason?: string;
  now: string;
}

/** Every append goes through the hash chain (#731): the op's fields and its
 * predecessor's hash decide its own, so no writer can slip in an unchained row. */
function chainFields(
  input: AppendCommonsOpInput,
  sequence: number
): CommonsOpChainFields {
  return {
    grantId: input.grantId,
    sequence,
    opId: uuidv7(),
    kind: input.kind,
    actorPartyId: input.actorPartyId,
    command: input.command ?? null,
    inputJson: input.input === undefined ? null : JSON.stringify(input.input),
    memberSignature: input.memberSignature
      ? JSON.stringify(input.memberSignature)
      : null,
    signingVaultId: input.memberSignature?.memberVaultId ?? null,
    signatureNonce: input.memberSignature?.nonce ?? null,
    outcome: input.outcome,
    reason: input.reason ?? null,
    createdAt: input.now,
  };
}

export function appendCommonsOperation(input: AppendCommonsOpInput): number {
  input.steward.exec("BEGIN IMMEDIATE");
  try {
    const grant = readCommonsGrant(input.steward, input.grantId);
    const sequence = grant.lastSequence + 1;
    insertChainedCommonsOp(input.steward, chainFields(input, sequence));
    input.steward.exec("COMMIT");
    return sequence;
  } catch (error) {
    input.steward.exec("ROLLBACK");
    throw error;
  }
}

export function appendCommonsOperationInTransaction(
  input: AppendCommonsOpInput
): number {
  if (!input.steward.isTransaction)
    throw new Error(
      "commons in-transaction append needs an active transaction"
    );
  const grant = readCommonsGrant(input.steward, input.grantId);
  const sequence = grant.lastSequence + 1;
  insertChainedCommonsOp(input.steward, chainFields(input, sequence));
  return sequence;
}

/** Mutate control state and sequence the matching control event in the same
 * log as member commands, atomically. */
export function mutateCommonsControl(
  input: AppendCommonsOpInput & {
    apply: (steward: DatabaseSync, grant: CommonsGrantRecord) => void;
  }
): number {
  input.steward.exec("BEGIN IMMEDIATE");
  try {
    const grant = readCommonsGrant(input.steward, input.grantId);
    const sequence = grant.lastSequence + 1;
    input.apply(input.steward, grant);
    insertChainedCommonsOp(input.steward, chainFields(input, sequence));
    input.steward.exec("COMMIT");
    return sequence;
  } catch (error) {
    input.steward.exec("ROLLBACK");
    throw error;
  }
}

export interface CommonsCommandDecision {
  accepted: boolean;
  reason?: string;
  sequence: number;
}

/** Deliberately does NOT apply the command allowlist: the normal app/automation
 * door must first recognize an undeclared in-container write so it can refuse,
 * rather than fall through to a private local mutation. */
export function commonsGrantForCommand(
  db: DatabaseSync,
  command: string,
  commandInput: Record<string, unknown>
): CommonsGrantRecord | undefined {
  for (const declared of commonsRoutesForCommand(command)) {
    const value = commandInput[declared.inputKey];
    if (typeof value !== "string" || !value) continue;
    const grantId = resolveCommonsContainer(db, declared, value);
    if (grantId) return readCommonsGrant(db, grantId);
  }
  return undefined;
}

/** Each resolution kind is a fixed query — the routing decision was made by
 * the table in `commons-routing.ts`, never by inspecting the command string. */
function resolveCommonsContainer(
  db: DatabaseSync,
  declared: CommonsCommandRoute,
  value: string
): string | undefined {
  const active = (
    containerType: ShareableItemType,
    containerId: string
  ): string | undefined =>
    (
      db
        .prepare(
          `SELECT grant_id FROM share_circle_grant
            WHERE plane = 'commons' AND container_type = ? AND container_id = ?
              AND revoked_at IS NULL`
        )
        .get(containerType, containerId) as { grant_id: string } | undefined
    )?.grant_id;
  if (declared.resolution === "container")
    return active(declared.containerType, value);
  if (declared.resolution === "tally-expense") {
    const row = db
      .prepare("SELECT group_id FROM tally_expense WHERE expense_id = ?")
      .get(value) as { group_id: string } | undefined;
    return row ? active(declared.containerType, row.group_id) : undefined;
  }
  if (declared.resolution === "folder-descendant") {
    const direct = active(declared.containerType, value);
    if (direct) return direct;
    return (
      db
        .prepare(
          `WITH RECURSIVE ancestors(concept_id) AS (
             SELECT ?
             UNION ALL
             SELECT c.broader_concept_id FROM core_concept c
             JOIN ancestors a ON c.concept_id = a.concept_id
             WHERE c.broader_concept_id IS NOT NULL
           )
           SELECT g.grant_id FROM share_circle_grant g
           JOIN ancestors a ON a.concept_id = g.container_id
           WHERE g.plane = 'commons' AND g.container_type = 'docs.folder'
             AND g.revoked_at IS NULL LIMIT 1`
        )
        .get(value) as { grant_id: string } | undefined
    )?.grant_id;
  }
  return (
    db
      .prepare(
        `WITH RECURSIVE folders(grant_id, concept_id) AS (
           SELECT grant_id, container_id FROM share_circle_grant
            WHERE plane = 'commons' AND container_type = 'docs.folder'
              AND revoked_at IS NULL
           UNION ALL
           SELECT f.grant_id, c.concept_id FROM core_concept c
           JOIN folders f ON c.broader_concept_id = f.concept_id
         )
         SELECT f.grant_id FROM folders f
         JOIN core_tag t ON t.concept_id = f.concept_id
         WHERE t.target_type = 'core.document' AND t.target_id = ?
         LIMIT 1`
      )
      .get(value) as { grant_id: string } | undefined
  )?.grant_id;
}

function docsFolderContains(input: {
  db: DatabaseSync;
  rootFolderId: string;
  folderId?: string;
  documentId?: string;
}): boolean {
  const row = input.db
    .prepare(
      `WITH RECURSIVE folders(concept_id) AS (
         SELECT ?
         UNION ALL
         SELECT c.concept_id FROM core_concept c
         JOIN folders f ON c.broader_concept_id = f.concept_id
       )
       SELECT 1 AS n FROM folders f
       WHERE (? IS NOT NULL AND f.concept_id = ?)
          OR (? IS NOT NULL AND EXISTS (
                SELECT 1 FROM core_tag t
                 WHERE t.concept_id = f.concept_id
                   AND t.target_type = 'core.document' AND t.target_id = ?
              ))
       LIMIT 1`
    )
    .get(
      input.rootFolderId,
      input.folderId ?? null,
      input.folderId ?? null,
      input.documentId ?? null,
      input.documentId ?? null
    );
  return Boolean(row);
}

/** Prefix on a `staleContextConflict` refusal (#731 goal 1): a distinct
 * classification callers pattern-match, instead of one refusal bucket. */
export const STALE_CONTEXT_REASON_PREFIX = "stale-context:";

/** Keys whose string value names a row this command reasons about, DERIVED
 * from the declared routing vocabulary (#750) rather than a second hand-kept
 * list that could drift. The container's own id key is filtered by VALUE below
 * instead: every op in a grant's log shares it, so matching on it would flag
 * nearly every pair of commands (#731 goal 1 anti-goal). */
const STALE_CONTEXT_ROW_KEYS = new Set(
  COMMONS_CONTAINER_KEYS.map((key) => key.inputKey)
);

/** Keys whose string value names a party this command depends on directly. */
const STALE_CONTEXT_PARTY_KEYS = new Set([
  "party_id",
  "partyId",
  "paid_by",
  "from_party",
  "to_party",
]);

/** Control ops naming a party added, removed, or recapabilitied.
 * `member_joined` is excluded: it records a vault linking to a membership that
 * was already current, so it never conflicts. */
const STALE_CONTEXT_ROSTER_KINDS = new Set([
  "member_added",
  "member_removed",
  "member_refused",
  "capability_changed",
]);

function collectStaleContextIds(
  value: unknown,
  containerId: string,
  rows: Set<string>,
  parties: Set<string>
): void {
  if (Array.isArray(value)) {
    for (const entry of value)
      collectStaleContextIds(entry, containerId, rows, parties);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>))
    if (typeof entry === "string" && entry !== containerId) {
      if (STALE_CONTEXT_ROW_KEYS.has(key)) rows.add(entry);
      else if (STALE_CONTEXT_PARTY_KEYS.has(key)) parties.add(entry);
    } else if (entry && typeof entry === "object")
      collectStaleContextIds(entry, containerId, rows, parties);
}

/** Every row/party a command's input concretely names. The SAME extraction runs
 * on the command being authorized and on each historical op's stored input —
 * that symmetry is what makes `staleContextConflict`'s overlap test mean
 * anything. The container's own id is never a signal. */
function staleContextTargets(
  containerId: string,
  value: unknown
): { rows: Set<string>; parties: Set<string> } {
  const rows = new Set<string>();
  const parties = new Set<string>();
  collectStaleContextIds(value, containerId, rows, parties);
  return { rows, parties };
}

/** Stale-context conflict scoping (#731 goal 1). A member composes against the
 * grant sequence they last observed (`basedOnSequence`); by the time it reaches
 * the steward the group may have moved on. Validation elsewhere asks whether the
 * command is still VALID; this asks whether the member's model has diverged.
 *
 * Do NOT refuse merely because something executed in between — an active commons
 * moves constantly and that would refuse almost everything (the explicit
 * anti-goal). Refuse only when an intervening EXECUTED op plausibly interacts
 * with what this command names: the same row id (by value, excluding the
 * container's own), or a roster/capability change to a party it references.
 *
 * Ops past compaction survive only as a coarse receipt (kind + outcome, no
 * input). A compacted ROSTER change conflicts conservatively — its partyId is
 * unrecoverable — while a compacted ordinary command does not, or the scoping
 * above would be defeated. The gap is narrow: compaction discards only ops every
 * current member's cursor has passed, and goal 2's expiry settles intents parked
 * long enough to fall behind the retention floor. */
function staleContextConflict(input: {
  steward: DatabaseSync;
  grant: CommonsGrantRecord;
  commandInput: unknown;
  basedOnSequence: number;
}): string | undefined {
  const { steward, grant, basedOnSequence } = input;
  if (basedOnSequence >= grant.lastSequence) return undefined;
  const target = staleContextTargets(grant.containerId, input.commandInput);
  if (target.rows.size === 0 && target.parties.size === 0) return undefined;
  const live = steward
    .prepare(
      `SELECT kind, command, input_json FROM share_commons_op
        WHERE grant_id = ? AND sequence > ? AND sequence <= ?
          AND outcome = 'executed' ORDER BY sequence`
    )
    .all(grant.grantId, basedOnSequence, grant.lastSequence) as {
    kind: string;
    command: string | null;
    input_json: string | null;
  }[];
  for (const op of live) {
    const opInput = op.input_json ? JSON.parse(op.input_json) : undefined;
    if (STALE_CONTEXT_ROSTER_KINDS.has(op.kind)) {
      const opTarget = staleContextTargets(grant.containerId, opInput);
      for (const partyId of opTarget.parties)
        if (target.parties.has(partyId))
          return `${STALE_CONTEXT_REASON_PREFIX} a member this command references changed after it was composed — please review`;
      continue;
    }
    if (op.kind !== "command" && op.kind !== "delete") continue;
    const opTarget = staleContextTargets(grant.containerId, opInput);
    for (const rowId of opTarget.rows)
      if (target.rows.has(rowId))
        return `${STALE_CONTEXT_REASON_PREFIX} ${op.command ?? "another command"} changed something this command depends on after it was composed — please review`;
  }
  const compactedRoster = steward
    .prepare(
      `SELECT 1 AS n FROM share_commons_receipt
        WHERE grant_id = ? AND sequence > ? AND sequence <= ?
          AND outcome = 'executed'
          AND kind IN ('member_added','member_removed','member_refused','capability_changed')
        LIMIT 1`
    )
    .get(grant.grantId, basedOnSequence, grant.lastSequence);
  if (compactedRoster)
    return `${STALE_CONTEXT_REASON_PREFIX} the group's membership changed after this was composed and the detail needed to confirm it is unrelated is no longer available — please review`;
  return undefined;
}

/**
 * The NAMED fault a re-minted member identity produces (#750). A member vault
 * that lost its seed and was re-created presents a different `vault_public_key`
 * than `share_party_vault_binding` pinned, so every command it signs fails
 * verification — and "invalid vault signature" is exactly the wrong story:
 * nothing is malformed and nobody is forging. The seat is a DIFFERENT vault
 * wearing a known id, and the only cure is re-invitation (rotation is deferred
 * — docs/decisions.md). Refusals carry this prefix so logs and receipts name the
 * real condition.
 */
export const COMMONS_MEMBER_IDENTITY_CHANGED =
  "commons_member_identity_changed";

/** In the refusal grammar the rail already uses (`<code>: <sentence>`). */
export function commonsMemberIdentityChangedReason(input: {
  memberVaultId: string;
}): string {
  return `${COMMONS_MEMBER_IDENTITY_CHANGED}: this member vault's identity key is not the one this commons pinned when it joined — its writes cannot be verified until it is re-invited (vault ${input.memberVaultId})`;
}

/** The identity key this commons PINNED for a member seat when it joined. */
function pinnedMemberVaultKey(
  steward: DatabaseSync,
  actorPartyId: string,
  memberVaultId: string
): { vaultId: string; publicKey: string | null } | undefined {
  const row = steward
    .prepare(
      `SELECT vault_id, vault_public_key FROM share_party_vault_binding
        WHERE party_id = ? AND vault_id = ? AND revoked_at IS NULL`
    )
    .get(actorPartyId, memberVaultId) as
    | { vault_id: string; vault_public_key: string | null }
    | undefined;
  return row
    ? { vaultId: row.vault_id, publicKey: row.vault_public_key }
    : undefined;
}

function commandRefuses(input: {
  steward: DatabaseSync;
  grant: CommonsGrantRecord;
  actorPartyId: string;
  command: string;
  commandInput: unknown;
  memberSignature?: CommonsMemberSignature;
  /** The member vault's CURRENT identity key as proven by the transport
   * (base64). Compared against the pinned binding so a re-mint is NAMED rather
   * than reported as a bad signature. */
  presentedVaultPublicKey?: string;
  basedOnSequence?: number;
}): string | undefined {
  const member = input.steward
    .prepare(
      `SELECT capability FROM social_circle_member
        WHERE circle_id = ? AND party_id = ?`
    )
    .get(input.grant.circleId, input.actorPartyId) as
    | { capability: CommonsCapability }
    | undefined;
  if (!member) return "the actor is not a member of this commons";
  if (member.capability !== "read+write")
    return "this commons is read-only for this member";
  // Identity is checked BEFORE what the command says: if the seat is not the
  // vault this commons pinned, nothing it sends can be attributed to it, and
  // the person deserves "re-invite this member" rather than whatever the
  // command would otherwise have been refused for (#750).
  if (input.presentedVaultPublicKey && input.memberSignature) {
    const pinned = pinnedMemberVaultKey(
      input.steward,
      input.actorPartyId,
      input.memberSignature.memberVaultId
    );
    if (pinned?.publicKey && pinned.publicKey !== input.presentedVaultPublicKey)
      return commonsMemberIdentityChangedReason({
        memberVaultId: pinned.vaultId,
      });
  }
  if (!isCommonsCommandActable(input.grant.containerType, input.command))
    return `command ${input.command} is not declared for ${input.grant.containerType}`;
  if (!input.commandInput || typeof input.commandInput !== "object")
    return "commons command input must be an object";
  const commandInput = input.commandInput as Record<string, unknown>;
  const containerKey =
    input.grant.containerType === "core.document"
      ? "document_id"
      : input.grant.containerType === "core.collection"
        ? "collection_id"
        : undefined;
  if (input.grant.containerType === "tally.group") {
    const explicitGroupId =
      typeof commandInput["group_id"] === "string"
        ? commandInput["group_id"]
        : undefined;
    const expenseGroup =
      !explicitGroupId && typeof commandInput["expense_id"] === "string"
        ? (
            input.steward
              .prepare(
                "SELECT group_id FROM tally_expense WHERE expense_id = ?"
              )
              .get(commandInput["expense_id"]) as
              | { group_id: string }
              | undefined
          )?.group_id
        : undefined;
    if ((explicitGroupId ?? expenseGroup) !== input.grant.containerId)
      return "command does not target this tally.group";
  }
  if (input.grant.containerType === "docs.folder") {
    const folderId =
      typeof commandInput["folder_id"] === "string"
        ? commandInput["folder_id"]
        : typeof commandInput["parent_folder_id"] === "string"
          ? commandInput["parent_folder_id"]
          : undefined;
    const documentId =
      typeof commandInput["document_id"] === "string"
        ? commandInput["document_id"]
        : undefined;
    if (
      (!folderId && !documentId) ||
      (folderId &&
        !docsFolderContains({
          db: input.steward,
          rootFolderId: input.grant.containerId,
          folderId,
        })) ||
      (documentId &&
        !docsFolderContains({
          db: input.steward,
          rootFolderId: input.grant.containerId,
          documentId,
        }))
    )
      return "command does not target this docs.folder";
  }
  if (containerKey && commandInput[containerKey] !== input.grant.containerId)
    return `command does not target this ${input.grant.containerType}`;
  if (input.actorPartyId !== input.grant.stewardPartyId) {
    if (!input.memberSignature)
      return "this member command is missing its vault signature";
    const binding = pinnedMemberVaultKey(
      input.steward,
      input.actorPartyId,
      input.memberSignature.memberVaultId
    );
    if (!binding?.publicKey)
      return "this member vault has no signing identity bound to the commons";
    if (
      !verifyCommonsIntent(
        Buffer.from(binding.publicKey, "base64"),
        {
          grantId: input.grant.grantId,
          actorPartyId: input.actorPartyId,
          command: input.command,
          commandInput: input.commandInput,
          memberVaultId: binding.vaultId,
        },
        input.memberSignature
      )
    )
      return "this member command has an invalid vault signature";
  }
  if (input.basedOnSequence !== undefined) {
    const stale = staleContextConflict({
      steward: input.steward,
      grant: input.grant,
      commandInput: input.commandInput,
      basedOnSequence: input.basedOnSequence,
    });
    if (stale) return stale;
  }
  return undefined;
}

function priorSignedDecision(input: {
  steward: DatabaseSync;
  grantId: string;
  command?: string;
  commandInput?: unknown;
  memberSignature?: CommonsMemberSignature;
}): CommonsCommandDecision | undefined {
  if (!input.memberSignature) return undefined;
  // Idempotency holds only when a reused nonce names the SAME command; a
  // different command/input under a replayed nonce is a collision, not a retry,
  // and must refuse explicitly instead of returning the earlier outcome.
  const op = input.steward
    .prepare(
      `SELECT sequence, command, input_json, outcome, reason
         FROM share_commons_op
        WHERE grant_id = ? AND signing_vault_id = ? AND signature_nonce = ?`
    )
    .get(
      input.grantId,
      input.memberSignature.memberVaultId,
      input.memberSignature.nonce
    ) as
    | {
        sequence: number;
        command: string | null;
        input_json: string | null;
        outcome: "executed" | "refused";
        reason: string | null;
      }
    | undefined;
  if (op) {
    if (
      input.command !== undefined &&
      (op.command !== input.command ||
        op.input_json !==
          (input.commandInput === undefined
            ? null
            : JSON.stringify(input.commandInput)))
    )
      return {
        accepted: false,
        reason:
          "commons signature nonce was reused for a different command or input",
        sequence: op.sequence,
      };
    return {
      accepted: op.outcome === "executed",
      ...(op.reason ? { reason: op.reason } : {}),
      sequence: op.sequence,
    };
  }
  // Past compaction only the compact replay decision survives, so command and
  // input can no longer be re-compared; the signature that minted this nonce
  // already bound it to one command.
  const replay = input.steward
    .prepare(
      `SELECT sequence, outcome, reason FROM share_commons_replay
        WHERE grant_id = ? AND signing_vault_id = ? AND signature_nonce = ?`
    )
    .get(
      input.grantId,
      input.memberSignature.memberVaultId,
      input.memberSignature.nonce
    ) as
    | {
        sequence: number;
        outcome: "executed" | "refused";
        reason: string | null;
      }
    | undefined;
  if (!replay) return undefined;
  return {
    accepted: replay.outcome === "executed",
    ...(replay.reason ? { reason: replay.reason } : {}),
    sequence: replay.sequence,
  };
}

export interface ExecuteCommonsCommandInput {
  steward: VaultDb;
  gateway: Gateway;
  credential: Credential;
  stewardVaultId: string;
  grantId: string;
  actorPartyId: string;
  command: string;
  commandInput: Record<string, unknown>;
  seats: readonly CommonsMemberInput[];
  memberSignature?: CommonsMemberSignature;
  presentedVaultPublicKey?: string;
  /** The grant sequence the actor had projected locally when this command was
   * composed (#731 goal 1). Optional: the stale-context check runs only when a
   * caller actually supplies it. */
  basedOnSequence?: number;
  invocationId?: string;
  intentId?: string;
  now: string;
}

export interface ExecuteCommonsCommandResult {
  decision: CommonsCommandDecision;
  outcome?: InvokeOutcome;
  seats?: CompiledCommonsSeat[];
}

/** A roster mutation changes EVERY active Commons backed by that circle, not
 * only the container the command arrived through. Reconcile each grant's consent
 * state and sequence the same control fact before the vault transaction commits. */
export function sequenceCommonsCircleCommandInTransaction(input: {
  steward: DatabaseSync;
  primaryGrantId: string;
  actorPartyId: string;
  command: string;
  commandInput: Record<string, unknown>;
  now: string;
}): string[] {
  if (
    input.command !== "tally.add_group_member" &&
    input.command !== "tally.remove_group_member"
  )
    return [];
  if (!input.steward.isTransaction)
    throw new Error("named-circle reconciliation requires a vault transaction");
  const partyId = input.commandInput["party_id"];
  if (typeof partyId !== "string" || !partyId)
    throw new Error("named-circle command requires party_id");
  const primary = readCommonsGrant(input.steward, input.primaryGrantId);
  const grants = input.steward
    .prepare(
      `SELECT grant_id, steward_party_id FROM share_circle_grant
        WHERE circle_id = ? AND plane = 'commons' AND revoked_at IS NULL
        ORDER BY grant_id`
    )
    .all(primary.circleId) as {
    grant_id: string;
    steward_party_id: string;
  }[];
  for (const grant of grants)
    if (grant.steward_party_id !== primary.stewardPartyId)
      throw new Error(
        "a shared named circle cannot change across different stewards"
      );
  const added = input.command === "tally.add_group_member";
  const member = input.steward
    .prepare(
      "SELECT capability FROM social_circle_member WHERE circle_id = ? AND party_id = ?"
    )
    .get(primary.circleId, partyId) as
    | { capability: CommonsCapability }
    | undefined;
  if (added && !member)
    throw new Error("named-circle member add did not materialize");
  if (!added && member)
    throw new Error("named-circle member removal did not materialize");
  for (const grant of grants) {
    if (added)
      input.steward
        .prepare(
          `INSERT INTO share_commons_member_state
             (grant_id, party_id, status, accepted_at)
           VALUES (?, ?, 'invited', NULL)
           ON CONFLICT(grant_id, party_id) DO NOTHING`
        )
        .run(grant.grant_id, partyId);
    else
      input.steward
        .prepare(
          `DELETE FROM share_commons_member_state
            WHERE grant_id = ? AND party_id = ?`
        )
        .run(grant.grant_id, partyId);
    appendCommonsOperationInTransaction({
      steward: input.steward,
      grantId: grant.grant_id,
      actorPartyId: input.actorPartyId,
      kind: added ? "member_added" : "member_removed",
      input: {
        partyId,
        ...(member ? { capability: member.capability } : {}),
      },
      outcome: "executed",
      now: input.now,
    });
  }
  return grants.map((grant) => grant.grant_id);
}

/** The one write rail: authorize at the steward, execute through the ordinary
 * command gateway, append the ordered outcome, reconcile into every joined vault. */
export function executeCommonsCommand(
  input: ExecuteCommonsCommandInput
): ExecuteCommonsCommandResult {
  const prior = priorSignedDecision({
    steward: input.steward.vault,
    grantId: input.grantId,
    command: input.command,
    commandInput: input.commandInput,
    ...(input.memberSignature
      ? { memberSignature: input.memberSignature }
      : {}),
  });
  if (prior) return { decision: prior };
  const grant = readCommonsGrant(input.steward.vault, input.grantId);
  // Fork guard (#731): only the vault that currently OWNS the grant may
  // authorize and sequence a write. After a steward transfer an intent still
  // addressed to the old steward would otherwise be appended to its orphaned
  // log — an acknowledged-then-lost write. Refuse without appending.
  const localOwner = input.steward.vault
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (localOwner?.owner_party_id !== grant.stewardPartyId)
    return {
      decision: {
        accepted: false,
        reason: "this vault is not the current steward for the commons",
        sequence: grant.lastSequence,
      },
    };
  const structuralReason = commandRefuses({
    steward: input.steward.vault,
    grant,
    actorPartyId: input.actorPartyId,
    command: input.command,
    commandInput: input.commandInput,
    ...(input.memberSignature
      ? { memberSignature: input.memberSignature }
      : {}),
    ...(input.presentedVaultPublicKey
      ? { presentedVaultPublicKey: input.presentedVaultPublicKey }
      : {}),
    ...(input.basedOnSequence === undefined
      ? {}
      : { basedOnSequence: input.basedOnSequence }),
  });
  if (structuralReason) {
    const sequence = appendCommonsOperation({
      steward: input.steward.vault,
      grantId: input.grantId,
      actorPartyId: input.actorPartyId,
      kind: input.command.includes("delete") ? "delete" : "command",
      command: input.command,
      input: input.commandInput,
      ...(input.memberSignature
        ? { memberSignature: input.memberSignature }
        : {}),
      outcome: "refused",
      reason: structuralReason,
      now: input.now,
    });
    return {
      decision: { accepted: false, reason: structuralReason, sequence },
    };
  }
  const executeAndSequence = () => {
    // Seeding the steward's own execution with the replica key is what lets
    // every member re-execute the operation and mint byte-identical row ids
    // (#750 invariant 7) — the whole reason catch-up can ship commands.
    const outcome = input.gateway.invokeCommonsCanonical(
      input.credential,
      {
        command: input.command,
        input: input.commandInput,
        purpose: "dpv:ServiceProvision",
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      },
      { idSeed: replicaInvocationKey(input.grantId, grant.lastSequence + 1) }
    );
    const executed =
      outcome.status === "executed" || outcome.status === "replayed";
    const reason = executed ? undefined : outcome.reason;
    if (executed)
      assertCommonsWithinMax(
        input.steward.vault,
        input.stewardVaultId,
        input.grantId
      );
    const append = input.steward.vault.isTransaction
      ? appendCommonsOperationInTransaction
      : appendCommonsOperation;
    const sequence = append({
      steward: input.steward.vault,
      grantId: input.grantId,
      actorPartyId: input.actorPartyId,
      kind: input.command.includes("delete") ? "delete" : "command",
      command: input.command,
      input: input.commandInput,
      ...(input.memberSignature
        ? { memberSignature: input.memberSignature }
        : {}),
      outcome: executed ? "executed" : "refused",
      ...(reason ? { reason } : {}),
      now: input.now,
    });
    const reconciledGrantIds = executed
      ? sequenceCommonsCircleCommandInTransaction({
          steward: input.steward.vault,
          primaryGrantId: input.grantId,
          actorPartyId: input.actorPartyId,
          command: input.command,
          commandInput: input.commandInput,
          now: input.now,
        })
      : [];
    if (executed)
      for (const reconciledGrantId of reconciledGrantIds)
        assertCommonsWithinMax(
          input.steward.vault,
          input.stewardVaultId,
          reconciledGrantId
        );
    return { outcome, executed, reason, sequence, reconciledGrantIds };
  };
  let sequenced: ReturnType<typeof executeAndSequence>;
  if (input.steward.vault.isTransaction) sequenced = executeAndSequence();
  else {
    const settled = input.gateway.invokeBatchSettled([executeAndSequence])[0];
    if (!settled)
      throw new Error("commons invocation batch returned no result");
    if (!settled.ok) {
      if (settled.error instanceof CommonsMaxSizeError) {
        return {
          decision: {
            accepted: false,
            reason: settled.error.message,
            sequence: readCommonsGrant(input.steward.vault, input.grantId)
              .lastSequence,
          },
        };
      }
      throw settled.error;
    }
    sequenced = settled.value;
  }
  const { outcome, executed, reason, sequence, reconciledGrantIds } = sequenced;
  if (!executed)
    return {
      decision: { accepted: false, ...(reason ? { reason } : {}), sequence },
      outcome,
    };
  const seats = compileCommons({
    steward: input.steward,
    stewardVaultId: input.stewardVaultId,
    grantId: input.grantId,
    seats: input.seats,
    now: input.now,
  });
  // Explicit Commons calls compile the addressed grant synchronously; sibling
  // grants changed by a reusable circle are picked up by the host's
  // reconciliation callback, their truth already durable in the same transaction.
  void reconciledGrantIds;
  if (input.intentId) {
    for (const seat of input.seats) {
      if (!seat.vault) continue;
      settleCommonsIntent({
        seat: seat.vault.vault,
        intentId: input.intentId,
        status: "executed",
        now: input.now,
      });
    }
  }
  return { decision: { accepted: true, sequence }, outcome, seats };
}

/** `expired`/`cancelled` are settled states like `denied` (#731 goal 2): once
 * reached, an intent never re-appears as pending/parked. */
export type CommonsIntentStatus =
  | "queued"
  | "parked"
  | "denied"
  | "executed"
  | "expired"
  | "cancelled";

/** How long a parked intent waits on an unreachable steward before settling as
 * `expired` (#731 goal 2). Two weeks is generous for a genuinely offline
 * steward while still bounding how far a member's model can drift; composing
 * again re-anchors `basedOnSequence` for goal 1. */
export const COMMONS_INTENT_PARK_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

export function queueCommonsIntent(input: {
  seat: DatabaseSync;
  intentId?: string;
  grantId: string;
  actorPartyId: string;
  command: string;
  commandInput: unknown;
  stewardLabel?: string;
  now: string;
}): string {
  // Opportunistic maintenance: a new submission is a natural moment to settle
  // this seat's long-parked intents, so they stop crowding the overlay even
  // without a dedicated background sweep (#731 goal 2).
  expireParkedCommonsIntents({ seat: input.seat, now: input.now });
  const intentId = input.intentId ?? uuidv7();
  // The sequence this seat has projected right now — live for the steward's own
  // seat, or whatever the last successful pull left for a member seat. Either
  // way this IS "the sequence the member had applied when the intent was
  // formed" (#731 goal 1), so no caller supplies it and it cannot be
  // stale-by-construction. A seat with no local grant row has no baseline; 0 is
  // the honest answer for an unobserved history — everything since looks stale.
  const localGrant = input.seat
    .prepare(`SELECT last_sequence FROM share_circle_grant WHERE grant_id = ?`)
    .get(input.grantId) as { last_sequence: number } | undefined;
  const basedOnSequence = localGrant?.last_sequence ?? 0;
  input.seat
    .prepare(
      `INSERT INTO share_commons_intent
         (intent_id, grant_id, actor_party_id, command, input_json,
          based_on_sequence, status, reason, steward_label, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, NULL)
       ON CONFLICT(intent_id) DO NOTHING`
    )
    .run(
      intentId,
      input.grantId,
      input.actorPartyId,
      input.command,
      JSON.stringify(input.commandInput),
      basedOnSequence,
      input.stewardLabel ?? null,
      input.now
    );
  return intentId;
}

/** Read back the baseline `queueCommonsIntent` recorded, so a caller holding
 * only the intentId can forward it as `basedOnSequence` without re-deriving it. */
export function readCommonsIntentBasedOnSequence(
  seat: DatabaseSync,
  intentId: string
): number | undefined {
  const row = seat
    .prepare(
      `SELECT based_on_sequence FROM share_commons_intent WHERE intent_id = ?`
    )
    .get(intentId) as { based_on_sequence: number } | undefined;
  return row?.based_on_sequence;
}

export function settleCommonsIntent(input: {
  seat: DatabaseSync;
  intentId: string;
  status: "parked" | "denied" | "executed";
  reason?: string;
  now: string;
}): void {
  input.seat
    .prepare(
      `UPDATE share_commons_intent
          SET status = ?, reason = ?, settled_at = ? WHERE intent_id = ?`
    )
    .run(input.status, input.reason ?? null, input.now, input.intentId);
}

/** Bounded life for a parked intent (#731 goal 2): settles every `parked`
 * intent older than the horizon to `expired`, so the peer sweep's
 * `status IN ('queued','parked')` retry leaves it alone. Idempotent. */
export function expireParkedCommonsIntents(input: {
  seat: DatabaseSync;
  now: string;
  horizonMs?: number;
}): number {
  const cutoff = new Date(
    Date.parse(input.now) - (input.horizonMs ?? COMMONS_INTENT_PARK_HORIZON_MS)
  ).toISOString();
  return Number(
    input.seat
      .prepare(
        `UPDATE share_commons_intent
            SET status = 'expired',
                reason = COALESCE(reason, 'this request parked past its review window and expired; resubmit to try again'),
                settled_at = ?
          WHERE status = 'parked' AND created_at <= ?`
      )
      .run(input.now, cutoff).changes
  );
}

/** Member-initiated cancel for an intent that has not yet executed (#731 goal
 * 2). A genuine race is possible, so the WHERE clause IS the guard, not a prior
 * read: cancelling only moves a still-open row to `cancelled`, and
 * `settleCommonsIntent`'s later unconditional update — the steward's real
 * answer — always wins, so a lost race resolves to the true outcome. The caller
 * reads the status back to tell "cancelled" from "lost the race". */
export function cancelCommonsIntent(input: {
  seat: DatabaseSync;
  intentId: string;
  now: string;
}): { status: CommonsIntentStatus; cancelled: boolean } {
  input.seat
    .prepare(
      `UPDATE share_commons_intent
          SET status = 'cancelled',
              reason = 'cancelled by the member before it executed',
              settled_at = ?
        WHERE intent_id = ? AND status IN ('queued','parked')`
    )
    .run(input.now, input.intentId);
  const row = input.seat
    .prepare(`SELECT status FROM share_commons_intent WHERE intent_id = ?`)
    .get(input.intentId) as { status: CommonsIntentStatus } | undefined;
  if (!row)
    throw new Error(`commons intent ${input.intentId} is not available`);
  return { status: row.status, cancelled: row.status === "cancelled" };
}

/** Receiver-owned "Save to my vault": promote the whole resident grant closure
 * containing the clicked root. Bootstrap/revoke work grant-wide, so a root-only
 * detach would later scrub descendants and leave a hollow folder or album. A
 * durable marker makes retries idempotent. */
export function retainCommonsItem(input: {
  seat: DatabaseSync;
  itemType: ShareableItemType;
  itemId: string;
  now: string;
}): { retained: boolean; grantIds: string[] } {
  const active = input.seat
    .prepare(
      `SELECT l.grant_id FROM share_commons_lineage l
       JOIN share_circle_grant g ON g.grant_id = l.grant_id
       WHERE l.item_type = ? AND l.item_id = ? AND g.revoked_at IS NULL
       ORDER BY l.grant_id`
    )
    .all(input.itemType, input.itemId) as { grant_id: string }[];
  if (active.length === 0) {
    const retained = input.seat
      .prepare(
        `SELECT grant_id FROM share_commons_retained
          WHERE item_type = ? AND item_id = ? ORDER BY grant_id`
      )
      .all(input.itemType, input.itemId) as { grant_id: string }[];
    if (retained.length === 0)
      throw new Error("item is not a resident Commons projection");
    return { retained: false, grantIds: retained.map((row) => row.grant_id) };
  }
  const provenance = input.seat
    .prepare(
      `SELECT shared_by FROM core_share_origin
        WHERE item_type = ? AND item_id = ?`
    )
    .get(input.itemType, input.itemId) as { shared_by: string } | undefined;
  if (!provenance)
    throw new Error("item provenance does not belong to this Commons");
  const grantIds = active
    .map((row) => row.grant_id)
    .filter((grantId) => provenance.shared_by === `commons:${grantId}`);
  if (grantIds.length === 0)
    throw new Error("item provenance does not belong to this Commons");
  const localVault = input.seat
    .prepare("SELECT vault_id FROM core_vault LIMIT 1")
    .get() as { vault_id: string } | undefined;
  if (!localVault) throw new Error("receiver vault identity is unavailable");
  const receiverCopy = readShareClosure(input.seat, {
    originVaultId: localVault.vault_id,
    itemType: input.itemType,
    itemIds: [input.itemId],
    crossOwner: true,
  });
  // Save is the receiver-side give gesture: re-run the shipped one-shot
  // projector first (dedup keeps physical ids). The transaction below remains
  // the only state-changing promotion.
  projectShareClosure(input.seat, receiverCopy, {
    sharedBy: provenance.shared_by,
    now: () => Date.parse(input.now),
  });
  input.seat.exec("BEGIN IMMEDIATE");
  try {
    const record = input.seat.prepare(
      `INSERT INTO share_commons_retained
         (grant_id, item_type, item_id, retained_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(grant_id, item_type, item_id) DO NOTHING`
    );
    for (const grantId of grantIds) {
      record.run(grantId, input.itemType, input.itemId, input.now);
      input.seat
        .prepare(
          `DELETE FROM core_share_origin
            WHERE shared_by = ? AND EXISTS (
              SELECT 1 FROM share_commons_lineage l
               WHERE l.grant_id = ?
                 AND l.item_type = core_share_origin.item_type
                 AND l.item_id = core_share_origin.item_id
            )`
        )
        .run(`commons:${grantId}`, grantId);
      input.seat
        .prepare("DELETE FROM share_commons_lineage WHERE grant_id = ?")
        .run(grantId);
    }
    input.seat.exec("COMMIT");
  } catch (error) {
    input.seat.exec("ROLLBACK");
    throw error;
  }
  return { retained: true, grantIds };
}

export function removeCommonsFromSeat(input: {
  seat: ShareVaultRef;
  grantId: string;
  /** Reconciliation replaces domain rows but keeps the local intent overlay. */
  preserveControlState?: boolean;
}): number {
  const localGrant = input.seat.vault
    .prepare(
      `SELECT circle_id, implicit_circle FROM share_circle_grant
        WHERE grant_id = ?`
    )
    .get(input.grantId) as
    | { circle_id: string; implicit_circle: number }
    | undefined;
  const rows = input.seat.vault
    .prepare(
      `SELECT item_type, item_id FROM share_commons_lineage WHERE grant_id = ?`
    )
    .all(input.grantId) as { item_type: ShareableItemType; item_id: string }[];
  // A changing Commons replaces the control row immediately after domain
  // removal. Drop it FIRST so a Tally container may delete its circle without
  // the old grant's FK pinning it; intents/cursors/op history remain.
  input.seat.vault
    .prepare("DELETE FROM share_circle_grant WHERE grant_id = ?")
    .run(input.grantId);
  if (localGrant) {
    const remainingCircleGrant = input.seat.vault
      .prepare(
        `SELECT grant_id FROM share_circle_grant
          WHERE circle_id = ? AND plane = 'commons' AND revoked_at IS NULL
          ORDER BY grant_id LIMIT 1`
      )
      .get(localGrant.circle_id) as { grant_id: string } | undefined;
    if (remainingCircleGrant)
      input.seat.vault
        .prepare(
          `UPDATE core_share_origin SET shared_by = ?
            WHERE item_type = 'social.circle' AND item_id = ?
              AND shared_by = ?`
        )
        .run(
          `commons:${remainingCircleGrant.grant_id}`,
          localGrant.circle_id,
          `commons:${input.grantId}`
        );
    else
      input.seat.vault
        .prepare(
          `DELETE FROM core_share_origin
            WHERE item_type = 'social.circle' AND item_id = ?
              AND shared_by = ?`
        )
        .run(localGrant.circle_id, `commons:${input.grantId}`);
  }
  input.seat.vault
    .prepare("DELETE FROM share_commons_lineage WHERE grant_id = ?")
    .run(input.grantId);
  let removed = 0;
  for (const row of rows) {
    const remaining = input.seat.vault
      .prepare(
        `SELECT l.grant_id FROM share_commons_lineage l
         JOIN share_circle_grant g ON g.grant_id = l.grant_id
         WHERE l.item_type = ? AND l.item_id = ? AND g.revoked_at IS NULL
         ORDER BY l.grant_id LIMIT 1`
      )
      .get(row.item_type, row.item_id) as { grant_id: string } | undefined;
    if (remaining) {
      // Physical rows are deduplicated across grants: revoking one grant removes
      // only its authorization edge, so keep the row and move its single
      // provenance slot onto another Commons that still authorizes it.
      input.seat.vault
        .prepare(
          `UPDATE core_share_origin SET shared_by = ?
            WHERE item_type = ? AND item_id = ?`
        )
        .run(`commons:${remaining.grant_id}`, row.item_type, row.item_id);
      continue;
    }
    const retained = input.seat.vault
      .prepare(
        `SELECT 1 AS n FROM share_commons_retained
          WHERE item_type = ? AND item_id = ? LIMIT 1`
      )
      .get(row.item_type, row.item_id);
    if (retained) continue;
    if (
      unshareFromVault({
        audience: input.seat,
        itemType: row.item_type,
        itemId: row.item_id,
      }).removed
    )
      removed += 1;
  }
  if (!input.preserveControlState) {
    input.seat.vault
      .prepare("DELETE FROM share_commons_intent WHERE grant_id = ?")
      .run(input.grantId);
    input.seat.vault
      .prepare("DELETE FROM share_commons_cursor WHERE grant_id = ?")
      .run(input.grantId);
    input.seat.vault
      .prepare("DELETE FROM share_circle_grant WHERE grant_id = ?")
      .run(input.grantId);
  }
  if (localGrant?.implicit_circle === 1) {
    const used = input.seat.vault
      .prepare(
        "SELECT 1 AS n FROM share_circle_grant WHERE circle_id = ? LIMIT 1"
      )
      .get(localGrant.circle_id);
    if (!used) {
      input.seat.vault
        .prepare("DELETE FROM social_circle_member WHERE circle_id = ?")
        .run(localGrant.circle_id);
      input.seat.vault
        .prepare("DELETE FROM social_circle WHERE circle_id = ?")
        .run(localGrant.circle_id);
    }
  }
  return removed;
}

export function transferCommonsSteward(input: {
  steward: DatabaseSync;
  grantId: string;
  actorPartyId: string;
  successorPartyId?: string;
  now: string;
}): string {
  const grant = readCommonsGrant(input.steward, input.grantId);
  const circle = input.steward
    .prepare("SELECT owner_party_id FROM social_circle WHERE circle_id = ?")
    .get(grant.circleId) as { owner_party_id: string };
  const candidates = input.steward
    .prepare(
      `SELECT m.party_id FROM social_circle_member m
       JOIN share_commons_member_state s
         ON s.grant_id = ? AND s.party_id = m.party_id AND s.status = 'current'
        WHERE m.circle_id = ? AND m.capability = 'read+write'
        ORDER BY m.added_at, m.member_id`
    )
    .all(grant.grantId, grant.circleId) as { party_id: string }[];
  if (
    input.successorPartyId !== undefined &&
    input.actorPartyId !== circle.owner_party_id
  )
    throw new Error("only the Commons founder may predesignate a successor");
  const successor =
    input.successorPartyId ??
    candidates.find((row) => row.party_id !== grant.stewardPartyId)?.party_id;
  if (!successor || !candidates.some((row) => row.party_id === successor))
    throw new Error("commons has no eligible successor steward");
  mutateCommonsControl({
    steward: input.steward,
    grantId: grant.grantId,
    actorPartyId: input.actorPartyId,
    kind: "steward_transferred",
    input: { from: grant.stewardPartyId, to: successor },
    outcome: "executed",
    now: input.now,
    apply: (db, current) => {
      const initiator = db
        .prepare(
          `SELECT 1 AS n FROM social_circle_member m
           JOIN share_commons_member_state s
             ON s.grant_id = ? AND s.party_id = m.party_id
            AND s.status = 'current'
           WHERE m.circle_id = ? AND m.party_id = ?
             AND m.capability = 'read+write'`
        )
        .get(current.grantId, current.circleId, input.actorPartyId);
      if (!initiator)
        throw new Error(
          "only a current read+write member may initiate stewardship transfer"
        );
      const changed = db
        .prepare(
          `UPDATE share_circle_grant SET steward_party_id = ?
            WHERE grant_id = ? AND last_sequence = ?`
        )
        .run(successor, current.grantId, current.lastSequence);
      if (changed.changes !== 1)
        throw new Error("commons stewardship changed concurrently");
    },
  });
  return successor;
}

export function commonsCurrentSize(
  origin: DatabaseSync,
  originVaultId: string,
  grantId: string
): number {
  const closure = commonsClosure(
    origin,
    originVaultId,
    readCommonsGrant(origin, grantId)
  );
  return commonsClosureSizeBytes(closure);
}
