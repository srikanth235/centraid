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
import { NoticeStore } from "./notices.js";
import { SHARE_RECEIVED_NOTICE_KIND } from "./share-notices.js";

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
           (party_id, kind, display_name, sort_name, created_at, updated_at)
         VALUES (?, 'person', 'Ravi', 'Ravi', ?, ?)`
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
         (party_id, kind, display_name, sort_name, created_at, updated_at)
       VALUES (?, 'person', ?, ?, ?, ?)`
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

    // Nila's grant is over its ceiling, Ravi's is not.
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
           (party_id, kind, display_name, sort_name, created_at, updated_at)
         VALUES (?, 'person', 'Ravi', 'Ravi', ?, ?)`
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

    // A vault id and nothing else, exactly as the post-commit hint carries.
    const doorbell = createGrantRefreshDoorbell({ host });
    doorbell.ring(ORIGIN_VAULT);
    expect(audienceTitles(ravi)).toStrictEqual(["Trip plan"]);
    priya.vault.vault
      .prepare("UPDATE core_document SET title = ? WHERE document_id = ?")
      .run("Trip plan (final)", documentId);
    // Inside the coalescing window a ring only marks work pending, so the
    // direct pass is what proves the edit follows.
    expect(
      refreshGrantsAfterCommit({ host, originVaultId: ORIGIN_VAULT, now })
        .origin
    ).toBe("mounted");
    expect(audienceTitles(ravi)).toStrictEqual(["Trip plan (final)"]);
    doorbell.stop();
  });

  test("an unmounted origin vault is a fact about the host, never an empty pass", () => {
    const host = { vaultFor: () => undefined };
    // `unmounted` must never arrive as "no grants here" — an empty list.
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

  /** Priya, Ravi, one shared document, this host holding both vaults. */
  function sharedWorld(): {
    priya: Side;
    ravi: Side;
    raviParty: string;
    documentId: string;
    grantId: string;
    host: { vaultFor: (vaultId: string) => VaultDb | undefined };
    now: string;
  } {
    const root = tempDirSync("centraid-grant-delivery-");
    const priya = makeVault(root, "priya", ORIGIN_VAULT);
    const ravi = makeVault(root, "ravi", AUDIENCE_VAULT);
    const now = nowIso();
    const raviParty = uuidv7();
    priya.vault.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, created_at, updated_at)
         VALUES (?, 'person', 'Ravi', 'Ravi', ?, ?)`
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
    const grant = createShareGrant(priya.vault.vault, {
      audience: { kind: "party", id: raviParty },
      subjectType: "core.document",
      subjectId: documentId,
      capability: "view",
      grantedAt: now,
      grantedBy: priya.boot.ownerPartyId,
    });
    return {
      priya,
      ravi,
      raviParty,
      documentId,
      grantId: grant.grantId,
      host: { vaultFor: (vaultId: string) => mounted.get(vaultId) },
      now,
    };
  }

  /** Every statement the loop compiles against the ORIGIN vault. */
  function countStatements(db: VaultDb): {
    value: () => number;
    restore: () => void;
  } {
    let count = 0;
    const original = db.vault.prepare.bind(db.vault);
    Object.defineProperty(db.vault, "prepare", {
      configurable: true,
      value: ((sql: string) => {
        count += 1;
        return original(sql);
      }) as VaultDb["vault"]["prepare"],
    });
    return {
      value: () => count,
      restore: () =>
        Object.defineProperty(db.vault, "prepare", {
          configurable: true,
          value: original,
        }),
    };
  }

  test("a commit that touches no granted subject costs the delivery loop nothing", () => {
    // Ruling V-delivery: the loop is doorbell-FILTERED. Delete the `touched`
    // hint below (or pass `undefined`) and this fails with a non-zero count —
    // the demonstrated red for the filter.
    const world = sharedWorld();
    refreshGrantsAfterCommit({
      host: world.host,
      originVaultId: ORIGIN_VAULT,
      now: world.now,
      touched: ["share.authority"],
    });
    expect(audienceTitles(world.ravi)).toStrictEqual(["Trip plan"]);

    const counter = countStatements(world.priya.vault);
    try {
      const pass = refreshGrantsAfterCommit({
        host: world.host,
        originVaultId: ORIGIN_VAULT,
        now: world.now,
        // A task is in no share closure, so no grant can have moved.
        touched: ["schedule.task"],
      });
      expect(pass).toStrictEqual({ origin: "mounted", reports: [] });
      expect(counter.value()).toBe(0);
    } finally {
      counter.restore();
    }

    // The filter is a skip, never a stop.
    world.priya.vault.vault
      .prepare("UPDATE core_document SET title = ? WHERE document_id = ?")
      .run("Trip plan (final)", world.documentId);
    refreshGrantsAfterCommit({
      host: world.host,
      originVaultId: ORIGIN_VAULT,
      now: world.now,
      touched: ["core.document"],
    });
    expect(audienceTitles(world.ravi)).toStrictEqual(["Trip plan (final)"]);
  });

  test("an unchanged pass re-projects nothing, and the audience is told once", () => {
    const world = sharedWorld();
    const pass = () =>
      refreshGrantsAfterCommit({
        host: world.host,
        originVaultId: ORIGIN_VAULT,
        now: world.now,
        touched: ["share.authority"],
      });
    pass();

    // Ruling V-notice: fires ONCE per grant, at its first delivery — never per
    // item, never as membership grows.
    const notices = new NoticeStore(world.ravi.vault.vault);
    const card = notices.getBySource(SHARE_RECEIVED_NOTICE_KIND, world.grantId);
    expect(card).toMatchObject({
      headline: "priya shared a document with you",
      count: 1,
      readAt: null,
    });
    notices.markRead(card!.noticeId);

    pass();
    pass();
    const after = notices.getBySource(
      SHARE_RECEIVED_NOTICE_KIND,
      world.grantId
    );
    // A second put bumps `count` and clears `read_at`, resurfacing a read card.
    expect(after).toMatchObject({ count: 1 });
    expect(after?.readAt).toBeTypeOf("string");
  });

  test("a revoked answer's removal is carried by the loop, not by the gesture", () => {
    const world = sharedWorld();
    refreshGrantsAfterCommit({
      host: world.host,
      originVaultId: ORIGIN_VAULT,
      now: world.now,
      touched: ["share.authority"],
    });
    expect(audienceTitles(world.ravi)).toStrictEqual(["Trip plan"]);

    revokeShareGrant(world.priya.vault.vault, {
      grantId: world.grantId,
      revokedAt: "2031-01-01T00:00:00.000Z",
    });
    // Nothing else asked: the plane moved, and the loop owns removal.
    refreshGrantsAfterCommit({
      host: world.host,
      originVaultId: ORIGIN_VAULT,
      now: "2031-01-01T00:00:00.000Z",
      touched: ["share.authority"],
    });
    expect(audienceTitles(world.ravi)).toStrictEqual([]);
    expect(
      listFulfillment(world.priya.vault.vault, world.grantId)
    ).toMatchObject([{ state: "removed" }]);
  });
});
