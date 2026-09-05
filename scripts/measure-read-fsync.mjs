/*
 * WHAT A GATEWAY READ COSTS IN FSYNCS (#922 B1). A read that appends an
 * `access.receipt` is a WRITER, and under `synchronous=FULL` each of those
 * commits on its own. This measures that, by principal and with the reads
 * batched, so a claim about read cost is a number rather than an argument.
 *
 * Usage, from the repo root, after `bun run --cwd packages/vault build`:
 *
 *   strace -f -c -e trace=fsync,fdatasync \
 *     node scripts/measure-read-fsync.mjs . FULL agent 50
 *
 * Modes: `idle` (no reads — the bootstrap baseline to subtract), `owner`
 * (owner-direct, which writes no allow receipt), `agent` (a receipting
 * principal), `agent-batch` (the same reads inside `Gateway.readBatch`).
 * Prints the receipt count and re-hashes the whole chain, so a mode that
 * dropped or reordered a receipt cannot read as a win.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repo = path.resolve(process.argv[2] ?? ".");
const profile = process.argv[3] ?? "FULL";
const mode = process.argv[4] ?? "owner"; // owner | agent | agent-batch | idle
const N = Number(process.argv[5] ?? 50);

const V = await import(
  pathToFileURL(path.join(repo, "packages/vault/dist/index.js")).href
);
const E = await import(
  pathToFileURL(path.join(repo, "packages/vault/dist/gateway/evidence.js")).href
);
const dir = mkdtempSync(path.join(tmpdir(), "b2-fsync-"));
const db = V.openVaultDb({ dir, synchronous: profile });
const boot = V.bootstrapVault(db, { ownerName: "Priya" });
const gw = V.createGateway(db);

const owner = {
  kind: "device",
  deviceId: boot.deviceId,
  deviceKey: boot.deviceKey,
};
let cred = owner;
if (mode.startsWith("agent")) {
  const agent = V.enrollAgent(db, { name: "scanner", modelRef: "probe" });
  V.recordAutomationAnswers(db.vault, {
    principalId: "scanner",
    ownerPartyId: boot.ownerPartyId,
    subjects: V.automationSubjectsOf([{ schema: "core", verbs: "read" }]),
    decision: "granted",
    now: new Date().toISOString(),
  });
  cred = {
    kind: "agent",
    agentId: agent.agentId,
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };
}
const req = { entity: "core.party", limit: 1 };
// Warm: page cache, prepared statements, WAL header.
gw.read(cred, req);

process.stderr.write("MEASURE-START\n");
if (mode === "agent-batch")
  gw.readBatch(() => {
    for (let i = 0; i < N; i += 1) gw.read(cred, req);
  });
else if (mode !== "idle") for (let i = 0; i < N; i += 1) gw.read(cred, req);
process.stderr.write("MEASURE-END\n");
const rows = db.audit
  .prepare("SELECT * FROM access_receipt ORDER BY seq")
  .all();
let prev = null;
let chain = "ok";
for (const row of rows) {
  const expected = E.receiptHash({
    prevHash: prev,
    receiptId: row.receipt_id,
    seq: row.seq,
    authorityId: row.authority_id,
    invocationId: row.invocation_id,
    action: row.action,
    objectType: row.object_type,
    objectId: row.object_id,
    decision: row.decision,
    occurredAt: row.occurred_at,
    detailJson: row.detail_json,
  });
  if (expected !== row.hash) chain = `BROKEN at seq ${row.seq}`;
  prev = row.hash;
}
process.stderr.write(`receipts=${rows.length} chain=${chain}\n`);
db.close();
