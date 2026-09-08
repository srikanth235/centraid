/*
 * The golden pair for a subscription (#929): two gateways in one process, one
 * link between them, and one seeded example of every offerable subject type.
 * Kept beside the suite so the suite stays under the file cap.
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createGateway,
  createShareGrant,
  nowIso,
  registerDocumentCommands,
  registerTallyCommands,
  uuidv7,
} from "@centraid/vault";
import type { Credential, ScopeSpec } from "@centraid/vault";

import type { PeerReplicaPullOutcome } from "../routes/peer-replica-route.js";
import { seedPhoto, transportTo } from "./peer-give.test-fixtures.js";
import type { Side } from "./peer-give.test-fixtures.js";
import type { PeerDial } from "./peer-link-client.js";
import { pullShareShape } from "./share-subscriber.js";

export const DOCS_FOLDER_SCHEME_URI = "https://centraid.dev/schemes/folders";

export interface SeededSubject {
  subjectType:
    | "core.collection"
    | "core.content_item"
    | "core.document"
    | "docs.folder"
    | "media.asset"
    | "tally.group";
  subjectId: string;
  /** What the audience must be able to read back, and from where. */
  probe: { table: string; column: string };
}

function addParty(side: Side, name: string): string {
  const partyId = uuidv7();
  const now = nowIso();
  side.vault.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, created_at, updated_at)
       VALUES (?, 'person', ?, ?, ?, ?)`
    )
    .run(partyId, name, name, now, now);
  return partyId;
}

/** The link is what makes a party reachable; the binding is what names where. */
export function bindPartyToVault(
  side: Side,
  partyId: string,
  vaultId: string
): void {
  side.vault.vault
    .prepare(
      `INSERT INTO share_party_vault_binding
         (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
       VALUES (?, ?, ?, NULL, ?, NULL)`
    )
    .run(uuidv7(), partyId, vaultId, nowIso());
}

function seedAlbum(side: Side, assetId: string, contentId: string): string {
  const albumId = uuidv7();
  side.vault.vault
    .prepare(
      `INSERT INTO core_collection
         (collection_id, owner_party_id, name, cover_content_id,
          parent_collection_id, sort_order, created_at)
       VALUES (?, ?, 'Trip', ?, NULL, 0, ?)`
    )
    .run(albumId, side.ownerPartyId, contentId, nowIso());
  side.vault.vault
    .prepare(
      `INSERT INTO core_collection_entry
         (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.asset', ?, 0, ?)`
    )
    .run(uuidv7(), albumId, assetId, nowIso());
  return albumId;
}

function seedDocument(side: Side): { documentId: string; contentId: string } {
  const now = nowIso();
  const bytes = Buffer.from(`document-${crypto.randomUUID()}`);
  const stored = side.vault.blobs.ingestSync(bytes);
  const contentId = uuidv7();
  side.vault.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'text/markdown', ?, ?, ?, 'Plan', NULL, NULL, NULL, NULL, NULL, ?)`
    )
    .run(
      contentId,
      `blob:sha256:${stored.sha256}`,
      stored.sha256,
      stored.byteSize,
      now
    );
  const documentId = uuidv7();
  side.vault.vault
    .prepare(
      `INSERT INTO core_document
         (document_id, title, current_content_id, created_at, updated_at,
          deleted_at, purge_at)
       VALUES (?, 'Plan', ?, ?, ?, NULL, NULL)`
    )
    .run(documentId, contentId, now, now);
  return { documentId, contentId };
}

function seedDocsFolder(side: Side, documentId: string): string {
  const schemeId = uuidv7();
  const rootId = uuidv7();
  const folderId = uuidv7();
  side.vault.vault
    .prepare(
      `INSERT INTO core_concept_scheme
         (scheme_id, uri, title, publisher, version, created_at)
       VALUES (?, ?, 'Folders', NULL, '1', ?)`
    )
    .run(schemeId, DOCS_FOLDER_SCHEME_URI, nowIso());
  const concept = side.vault.vault.prepare(
    `INSERT INTO core_concept
       (concept_id, scheme_id, notation, pref_label, alt_labels_json,
        broader_concept_id, definition, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)`
  );
  concept.run(rootId, schemeId, "root", "Root", null, nowIso());
  concept.run(folderId, schemeId, "plans", "Plans", rootId, nowIso());
  side.vault.vault
    .prepare(
      `INSERT INTO core_tag
         (tag_id, target_type, target_id, concept_id, tagged_by_party_id, tagged_at)
       VALUES (?, 'core.document', ?, ?, ?, ?)`
    )
    .run(uuidv7(), documentId, folderId, side.ownerPartyId, nowIso());
  return folderId;
}

function seedTallyGroup(side: Side, memberPartyId: string): string {
  const gateway = createGateway(side.vault);
  registerTallyCommands(gateway);
  const credential: Credential = {
    kind: "device",
    deviceId: side.ownerCredential.deviceId,
    deviceKey: side.ownerCredential.deviceKey,
  };
  const created = gateway.invoke(credential, {
    command: "tally.create_group",
    input: { name: "Trip", icon: "🧳", member_ids: [memberPartyId] },
  });
  if (created.status !== "executed")
    throw new Error(`tally.create_group: ${JSON.stringify(created)}`);
  return (created.output as { group_id: string }).group_id;
}

/** One of every offerable subject type, all in the origin vault. */
export function seedEverySubject(
  side: Side,
  memberPartyId: string
): SeededSubject[] {
  const photo = seedPhoto(side, "share");
  const contentId = side.vault.vault
    .prepare("SELECT content_id FROM media_asset WHERE asset_id = ?")
    .get(photo.assetId) as { content_id: string };
  const albumId = seedAlbum(side, photo.assetId, contentId.content_id);
  const document = seedDocument(side);
  const folderId = seedDocsFolder(side, document.documentId);
  const groupId = seedTallyGroup(side, memberPartyId);
  return [
    {
      subjectType: "media.asset",
      subjectId: photo.assetId,
      probe: { table: "media_asset", column: "asset_id" },
    },
    {
      subjectType: "core.content_item",
      subjectId: contentId.content_id,
      probe: { table: "core_content_item", column: "content_id" },
    },
    {
      subjectType: "core.collection",
      subjectId: albumId,
      probe: { table: "core_collection", column: "collection_id" },
    },
    {
      subjectType: "core.document",
      subjectId: document.documentId,
      probe: { table: "core_document", column: "document_id" },
    },
    {
      subjectType: "docs.folder",
      subjectId: folderId,
      probe: { table: "core_concept", column: "concept_id" },
    },
    {
      subjectType: "tally.group",
      subjectId: groupId,
      probe: { table: "tally_group", column: "group_id" },
    },
  ];
}

export function grantEach(
  origin: Side,
  subjects: readonly SeededSubject[],
  audiencePartyId: string
): Map<string, string> {
  const grants = new Map<string, string>();
  for (const subject of subjects) {
    const grant = createShareGrant(origin.vault.vault, {
      audience: { kind: "party", id: audiencePartyId },
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      capability: "view",
      grantedAt: nowIso(),
      grantedBy: origin.ownerPartyId,
    });
    grants.set(subject.subjectType, grant.grantId);
  }
  return grants;
}

/**
 * The two halves of the wire, tied together. The AUDIENCE's `changes` door
 * pulls the shape back from the origin, so the notice carries no rows and the
 * seat only ever holds what it asked for.
 */
export function wireGoldenPair(
  origin: Side,
  audience: Side
): { toOrigin: PeerDial; toAudience: PeerDial } {
  const originGateway = createGateway(origin.vault);
  registerTallyCommands(originGateway);
  registerDocumentCommands(originGateway);
  const originCredential: Credential = {
    kind: "device",
    deviceId: origin.ownerCredential.deviceId,
    deviceKey: origin.ownerCredential.deviceKey,
  };
  const toOrigin: PeerDial = {
    request: transportTo(origin, audience.endpointId, {
      gatewayFor: (vaultId) =>
        vaultId === origin.vaultId ? originGateway : undefined,
      credentialFor: (vaultId) =>
        vaultId === origin.vaultId ? originCredential : undefined,
    }),
    endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
  };
  const pullShape = async (input: {
    originVaultId: string;
    audienceVaultId: string;
    shapeId: string;
    seat: typeof audience.vault;
  }): Promise<PeerReplicaPullOutcome> =>
    pullShareShape({
      dial: toOrigin,
      route: { endpointId: origin.endpointId, relayHints: [] },
      originVaultId: input.originVaultId,
      audienceVaultId: input.audienceVaultId,
      shapeId: input.shapeId,
      seat: input.seat,
      now: nowIso,
    });
  const toAudience: PeerDial = {
    request: transportTo(audience, origin.endpointId, { pullShape }),
    endpointTicketFor: (endpointId) => `ticket-for-${endpointId}`,
  };
  return { toOrigin, toAudience };
}

export function addAudienceParty(origin: Side, audience: Side): string {
  const partyId = addParty(origin, audience.label);
  bindPartyToVault(origin, partyId, audience.vaultId);
  return partyId;
}

export function addLocalParty(side: Side, name: string): string {
  return addParty(side, name);
}

/**
 * A blueprint query's `ctx.vault`, over a REAL vault (#929). The app is
 * enrolled and granted its shipped manifest scopes, and every read goes
 * through the gateway that clamps to them — so a scope the manifest forgot to
 * declare fails here exactly as it would on a member's machine.
 */
export function appQueryCtx(
  side: Side,
  appId: string
): { ctx: { vault: VaultApiish } } {
  const manifest = JSON.parse(
    readFileSync(
      path.resolve(
        import.meta.dirname,
        `../../../blueprints/apps/${appId}/app.json`
      ),
      "utf8"
    )
  ) as { vault: { scopes: ScopeSpec[] } };
  const credential: Credential = {
    kind: "device",
    deviceId: side.ownerCredential.deviceId,
    deviceKey: side.ownerCredential.deviceKey,
    surface: appId,
    scopeClamp: manifest.vault.scopes,
  };
  const read = async (request: Record<string, unknown>): Promise<unknown> =>
    side.gateway.read(credential, request as never);
  return {
    ctx: {
      vault: {
        read,
        search: async (request: Record<string, unknown>) =>
          side.gateway.search(credential, request as never),
      },
    },
  };
}

interface VaultApiish {
  read: (request: Record<string, unknown>) => Promise<unknown>;
  search: (request: Record<string, unknown>) => Promise<unknown>;
}
