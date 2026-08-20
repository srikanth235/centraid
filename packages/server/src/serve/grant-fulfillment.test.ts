import { mkdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import {
  bootstrapVault,
  blobUriFor,
  createShareGrant,
  listFulfillment,
  nowIso,
  openVaultDb,
  revokeShareGrant,
  uuidv7,
} from "@centraid/vault";
import type { BootstrapResult, VaultDb } from "@centraid/vault";

import {
  createGrantRefreshDoorbell,
  fulfillGrantsForSubject,
  propagateGrantRemoval,
  refreshGrantsAfterCommit,
} from "./grant-fulfillment.js";

const ORIGIN_VAULT = "vlt_priya";
const AUDIENCE_VAULT = "vlt_ravi";

const open: VaultDb[] = [];

interface Side {
  vault: VaultDb;
  boot: BootstrapResult;
}

function makeVault(root: string, name: string, vaultId: string): Side {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const vault = openVaultDb({ dir });
  open.push(vault);
  return { vault, boot: bootstrapVault(vault, { ownerName: name, vaultId }) };
}

/** One document, the smallest whole subject a grant can carry. */
function seedDocument(side: Side, title: string, body: string): string {
  const now = nowIso();
  const blob = side.vault.blobs.ingestSync(Buffer.from(body));
  const contentId = uuidv7();
  side.vault.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'text/plain', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`
    )
    .run(
      contentId,
      blobUriFor(blob.sha256),
      blob.sha256,
      blob.byteSize,
      title,
      side.boot.ownerPartyId,
      side.boot.deviceId,
      now
    );
  const documentId = uuidv7();
  side.vault.vault
    .prepare(
      `INSERT INTO core_document
         (document_id, title, current_content_id, created_at, updated_at,
          deleted_at, purge_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`
    )
    .run(documentId, title, contentId, now, now);
  return documentId;
}

function audienceTitles(side: Side): string[] {
  return (
    side.vault.vault
      .prepare("SELECT title FROM core_document ORDER BY title")
      .all() as { title: string }[]
  ).map((row) => row.title);
}

describe("serve/grant-fulfillment", () => {
  afterEach(() => {
    while (open.length > 0) open.pop()?.close();
  });

  test("a subject's grants are fulfilled, then their removal propagated", () => {
    const root = tempDirSync("centraid-grant-fulfillment-");
    const priya = makeVault(root, "priya", ORIGIN_VAULT);
    const ravi = makeVault(root, "ravi", AUDIENCE_VAULT);
    const now = nowIso();
    const raviParty = uuidv7();
    priya.vault.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, created_at, updated_at,
            ontology_version)
         VALUES (?, 'person', 'Ravi', 'Ravi', ?, ?, '1.4')`
      )
      .run(raviParty, now, now);
    priya.vault.vault
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES (?, ?, ?, NULL, ?, NULL)`
      )
      .run(uuidv7(), raviParty, AUDIENCE_VAULT, now);
    const documentId = seedDocument(priya, "Trip plan", "day one");

    const mounted = new Map<string, VaultDb>([
      [ORIGIN_VAULT, priya.vault],
      [AUDIENCE_VAULT, ravi.vault],
    ]);
    const host = { vaultFor: (vaultId: string) => mounted.get(vaultId) };

    const grant = createShareGrant(priya.vault.vault, {
      audience: { kind: "party", id: raviParty },
      subjectType: "core.document",
      subjectId: documentId,
      capability: "view",
      grantedAt: now,
      grantedBy: priya.boot.ownerPartyId,
    });

    const delivered = fulfillGrantsForSubject({
      host,
      originVaultId: ORIGIN_VAULT,
      subjectType: "core.document",
      subjectId: documentId,
      now,
    });
    if (delivered.origin !== "mounted") throw new Error("origin is mounted");
    expect(delivered.reports).toHaveLength(1);
    expect(delivered.reports[0]).toMatchObject({
      grantId: grant.grantId,
      outcome: "fulfilled",
    });
    expect(audienceTitles(ravi)).toStrictEqual(["Trip plan"]);
    expect(listFulfillment(priya.vault.vault, grant.grantId)).toMatchObject([
      { peerVaultId: AUDIENCE_VAULT, state: "delivered" },
    ]);

    // The subject moves on; the audience replica follows on the next pass.
    const later = "2026-08-19T15:00:00.000Z";
    priya.vault.vault
      .prepare("UPDATE core_document SET title = ? WHERE document_id = ?")
      .run("Trip plan (final)", documentId);
    fulfillGrantsForSubject({
      host,
      originVaultId: ORIGIN_VAULT,
      subjectType: "core.document",
      subjectId: documentId,
      now: later,
    });
    expect(audienceTitles(ravi)).toStrictEqual(["Trip plan (final)"]);

    const revokedAt = "2026-08-19T16:00:00.000Z";
    revokeShareGrant(priya.vault.vault, { grantId: grant.grantId, revokedAt });
    const removal = propagateGrantRemoval({
      host,
      originVaultId: ORIGIN_VAULT,
      grantId: grant.grantId,
      now: revokedAt,
    });
    expect(removal).toMatchObject({ outcome: "propagated" });
    expect(audienceTitles(ravi)).toStrictEqual([]);
    expect(listFulfillment(priya.vault.vault, grant.grantId)).toMatchObject([
      { peerVaultId: AUDIENCE_VAULT, state: "removed" },
    ]);
  });

  test("a grant that cannot be kept is reported, not thrown, and never stalls the rest", () => {
    const root = tempDirSync("centraid-grant-fulfillment-ceiling-");
    const priya = makeVault(root, "priya", ORIGIN_VAULT);
    const ravi = makeVault(root, "ravi", AUDIENCE_VAULT);
    const now = nowIso();
    const warnings: string[] = [];
    const raviParty = uuidv7();
    const nilaParty = uuidv7();
    const addParty = priya.vault.vault.prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, created_at, updated_at,
          ontology_version)
       VALUES (?, 'person', ?, ?, ?, ?, '1.4')`
    );
    addParty.run(raviParty, "Ravi", "Ravi", now, now);
    addParty.run(nilaParty, "Nila", "Nila", now, now);
    priya.vault.vault
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES (?, ?, ?, NULL, ?, NULL)`
      )
      .run(uuidv7(), raviParty, AUDIENCE_VAULT, now);
    const documentId = seedDocument(priya, "Trip plan", "day one");
    const mounted = new Map<string, VaultDb>([
      [ORIGIN_VAULT, priya.vault],
      [AUDIENCE_VAULT, ravi.vault],
    ]);
    const host = {
      vaultFor: (vaultId: string) => mounted.get(vaultId),
      logger: { warn: (message: string) => warnings.push(message) },
    };

    // Nila's grant is over its ceiling; Ravi's is not. Nila's failure is hers.
    const overCeiling = createShareGrant(priya.vault.vault, {
      audience: { kind: "party", id: nilaParty },
      subjectType: "core.document",
      subjectId: documentId,
      capability: "view",
      grantedAt: now,
      grantedBy: priya.boot.ownerPartyId,
      maxSizeBytes: 8,
    });
    const healthy = createShareGrant(priya.vault.vault, {
      audience: { kind: "party", id: raviParty },
      subjectType: "core.document",
      subjectId: documentId,
      capability: "view",
      grantedAt: now,
      grantedBy: priya.boot.ownerPartyId,
    });

    const pass = fulfillGrantsForSubject({
      host,
      originVaultId: ORIGIN_VAULT,
      subjectType: "core.document",
      subjectId: documentId,
      now,
    });
    if (pass.origin !== "mounted") throw new Error("origin is mounted");
    const reports = pass.reports;
    expect(
      reports.find((report) => report.grantId === overCeiling.grantId)
    ).toMatchObject({ outcome: "failed" });
    expect(
      reports.find((report) => report.grantId === healthy.grantId)
    ).toMatchObject({ outcome: "fulfilled" });
    expect(warnings).toHaveLength(1);
    expect(audienceTitles(ravi)).toStrictEqual(["Trip plan"]);
  });

  test("the commit doorbell re-projects live grants without being told the subject", () => {
    const root = tempDirSync("centraid-grant-doorbell-");
    const priya = makeVault(root, "priya", ORIGIN_VAULT);
    const ravi = makeVault(root, "ravi", AUDIENCE_VAULT);
    const now = nowIso();
    const raviParty = uuidv7();
    priya.vault.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, created_at, updated_at,
            ontology_version)
         VALUES (?, 'person', 'Ravi', 'Ravi', ?, ?, '1.4')`
      )
      .run(raviParty, now, now);
    priya.vault.vault
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES (?, ?, ?, NULL, ?, NULL)`
      )
      .run(uuidv7(), raviParty, AUDIENCE_VAULT, now);
    const documentId = seedDocument(priya, "Trip plan", "day one");
    const mounted = new Map<string, VaultDb>([
      [ORIGIN_VAULT, priya.vault],
      [AUDIENCE_VAULT, ravi.vault],
    ]);
    const host = { vaultFor: (vaultId: string) => mounted.get(vaultId) };
    createShareGrant(priya.vault.vault, {
      audience: { kind: "party", id: raviParty },
      subjectType: "core.document",
      subjectId: documentId,
      capability: "view",
      grantedAt: now,
      grantedBy: priya.boot.ownerPartyId,
    });

    // The doorbell carries a vault id and nothing else — exactly what the
    // gateway's post-commit hint has — and the audience still follows.
    const doorbell = createGrantRefreshDoorbell({ host });
    doorbell.ring(ORIGIN_VAULT);
    expect(audienceTitles(ravi)).toStrictEqual(["Trip plan"]);
    priya.vault.vault
      .prepare("UPDATE core_document SET title = ? WHERE document_id = ?")
      .run("Trip plan (final)", documentId);
    // Inside the coalescing window the ring only marks work pending, so the
    // direct pass is what proves the edit follows; the window's trailing pass
    // is the same call on a timer.
    expect(
      refreshGrantsAfterCommit({ host, originVaultId: ORIGIN_VAULT, now })
        .origin
    ).toBe("mounted");
    expect(audienceTitles(ravi)).toStrictEqual(["Trip plan (final)"]);
    doorbell.stop();
  });

  test("an unmounted origin vault is a fact about the host, never an empty pass", () => {
    const host = { vaultFor: () => undefined };
    // The distinction this asserts is the whole point: `unmounted` must never
    // arrive as "no grants over this subject", which is what an empty list
    // would say.
    expect(
      fulfillGrantsForSubject({
        host,
        originVaultId: ORIGIN_VAULT,
        subjectType: "core.document",
        subjectId: uuidv7(),
        now: nowIso(),
      })
    ).toStrictEqual({
      origin: "unmounted",
      reason: `origin vault ${ORIGIN_VAULT} is not mounted on this host`,
    });
    expect(
      refreshGrantsAfterCommit({
        host,
        originVaultId: ORIGIN_VAULT,
        now: nowIso(),
      })
    ).toMatchObject({ origin: "unmounted" });
    expect(
      propagateGrantRemoval({
        host,
        originVaultId: ORIGIN_VAULT,
        grantId: uuidv7(),
        now: nowIso(),
      })
    ).toMatchObject({ outcome: "failed" });
  });
});
