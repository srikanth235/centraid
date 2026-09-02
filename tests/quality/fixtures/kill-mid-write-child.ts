import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

import { ConversationStore } from "../../../packages/server/src/engine/conversation/store.js";
import { buildGateway } from "../../../packages/server/src/serve/build-gateway.js";

const [root, faultPoint, mode = "crash"] = process.argv.slice(2);
if (!root || !faultPoint) throw new Error("root and fault point required");

const gateway = await buildGateway({
  paths: { vaultDir: path.join(root, "vault") },
});
// Recovery only inspects the reopened vault/journal planes. Mounting code
// hosts, schedulers, catalogs, and HTTP routes adds no crash-safety coverage
// and can starve this 30-second fault test while the PR gate runs four lanes.
if (mode !== "recover") await gateway.start("http://127.0.0.1");
const vaultId = gateway.vaults.defaultVaultId();
const plane = gateway.vaults.get(vaultId)!;
const db = plane.db;

const conversationId = `quality-${faultPoint}`;

// Cross-cutting durability invariant: after a clean restart no durable-write
// path may leave a `.tmp` behind. The WAL-shipper state write, the CAS blob
// landing, and every write-then-rename seam stage through a `.tmp` sibling
// and rename it into place; a crash that fsynced the tmp but died before the
// rename (or whose catch never ran) would strand one. The ingress spool is
// `<session>.part` under os.tmpdir(), not `.tmp` under the vault root, so it
// is not a false positive here.
function collectStrayTemps(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tmp")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

if (mode === "recover") {
  const integrity = {
    vault: db.vault.prepare("PRAGMA integrity_check").get(),
    journal: db.audit.prepare("PRAGMA integrity_check").get(),
  };
  const strayTemps = collectStrayTemps(root);
  let observation: unknown;
  if (faultPoint === "journal-after-append") {
    observation = db.audit
      .prepare(
        `SELECT count(DISTINCT t.id) AS turns, count(i.id) AS items
           FROM turns t JOIN items i ON i.turn_id = t.id
          WHERE t.conversation_id = ?`
      )
      .get(conversationId);
  } else if (faultPoint === "blob-after-stage") {
    observation = db.vault
      .prepare(
        `SELECT count(*) AS sessions, max(received_bytes) AS received,
                min(state) AS state
           FROM blob_ingress_session
          WHERE expected_size = 7`
      )
      .get();
  } else if (faultPoint === "wal-before-checkpoint") {
    observation = db.vault
      .prepare(
        "SELECT count(*) AS items FROM locker_item WHERE title = 'checkpoint canary'"
      )
      .get();
  } else if (faultPoint === "automation-after-claim") {
    const store = new ConversationStore(() => db.audit);
    observation = {
      conversations: (
        db.audit
          .prepare("SELECT count(*) AS n FROM conversations WHERE id = ?")
          .get(conversationId) as { n: number }
      ).n,
      duplicateClaimAccepted: store.acquireTurnLock(
        conversationId,
        "duplicate-runner"
      ),
    };
  }
  process.stdout.write(
    `QUALITY_RECOVERY ${JSON.stringify({ integrity, observation, strayTemps })}\n`
  );
  await gateway.stop();
  process.exit(0);
}

if (faultPoint === "journal-after-append") {
  const session = gateway.conversationHistoryStore.createSession(
    "_assistant",
    "quality crash append"
  );
  // Stable id lets recovery query the exact acknowledged append.
  db.audit
    .prepare("UPDATE conversations SET id = ? WHERE id = ?")
    .run(conversationId, session.id);
  gateway.conversationHistoryStore.recordTurn("_assistant", {
    conversationId,
    userMessage: "acknowledged journal input",
    nodes: [],
    finalText: "acknowledged journal output",
    harnessObservation: { kind: "codex", sessionId: "quality-crash" },
    startedAt: 1,
    endedAt: 2,
    ok: true,
  });
} else if (faultPoint === "blob-after-stage") {
  const begin = await db.blobTransfers.beginIngress({
    expectedSize: 7,
    expectedSha256: createHash("sha256").update("staged!").digest("hex"),
    resumable: true,
    stagedBy: plane.boot.deviceId,
  });
  if (begin.mode !== "spool")
    throw new Error(`expected spool ingress, got ${begin.mode}`);
  await db.blobTransfers.appendIngress(
    begin.sessionId,
    0,
    Buffer.from("staged!")
  );
} else if (faultPoint === "wal-before-checkpoint") {
  const result = await plane.invoke(plane.ownerCredential, {
    command: "locker.add_item",
    input: { type: "note", title: "checkpoint canary", content: "durable" },
    purpose: "dpv:ServiceProvision",
  });
  if (result.status !== "executed")
    throw new Error(`checkpoint canary was not acknowledged: ${result.status}`);
  // The named seam is immediately before the production checkpoint call.
} else if (faultPoint === "automation-after-claim") {
  const store = new ConversationStore(() => db.audit);
  store.createConversation({
    id: conversationId,
    kind: "automation",
    userId: plane.boot.ownerPartyId,
    appId: "quality",
    automationId: "quality/crash",
  });
  if (!store.acquireTurnLock(conversationId, "first-runner"))
    throw new Error("automation run was not claimed");
} else {
  throw new Error(`unknown fault point ${faultPoint}`);
}

process.stdout.write(`FAULT_READY ${faultPoint}\n`);
process.kill(process.pid, "SIGSTOP");

// Reached only if a broken harness resumes instead of SIGKILLing. The WAL
// seam's operation deliberately sits after the stop so the parent proves it
// did not run while the acknowledged write before it survives.
if (faultPoint === "wal-before-checkpoint")
  plane.gateway.checkpoint(plane.ownerCredential);
