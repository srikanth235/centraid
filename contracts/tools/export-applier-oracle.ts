// Generate the ORACLE fixture from v0's own capture path (#1020, D-1020-D1-11).
//
// The ORACLE gate is "the Rust log produces the same rows v0's log produces for
// the same statements". That is only a real gate if v0's answer is the FIXTURE
// rather than a transcription of it, so this script:
//
//   1. founds a fresh v0 vault with v0's own `openVaultDb` + `bootstrapVault`,
//   2. records the log watermark the bootstrap left,
//   3. runs each scripted commit through v0's `withReplicaCommit`, and
//   4. dumps the `replica_log` rows ABOVE that watermark.
//
// Regenerate with:
//
//   node --experimental-strip-types contracts/tools/export-applier-oracle.ts \
//     > contracts/applier/oracle.json
//   bun run format
//
// NODE, NOT BUN, and not a preference (#1020, D-1020-D1-16): v0's vault package
// is built on `node:sqlite`, and Bun does not provide that module at all
// (`error: No such built-in module: node:sqlite`). v0's own freezer is invoked
// as `node scripts/golden-vault/build.mjs` for the same reason. Type
// annotations are stripped rather than compiled, so there is no build step.
//
// WHAT IS NOT IN THE FIXTURE, and why. `seq`, `epoch` and `committed_at` are
// per-file facts: a seq is a position in ONE log, the epoch is a random uuid,
// and the timestamp is whenever the generator ran. Comparing them would compare
// the two runs rather than the two DECODERS. What is compared is the decode:
// the table, the op, the key, the image, the prior and the three flags.
//
// It is invoked by PATH rather than through a `bun run` script because this is
// v1 tooling living under `contracts/`, not part of v0's package scripts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

/** One scripted commit: a label, a producer, and the statements to run. */
interface ScriptedCommit {
  readonly label: string;
  readonly producer: string;
  readonly statements: readonly string[];
}

/**
 * THE SCRIPT. Chosen so that each commit exercises one distinction the census
 * names as a seam, because a fixture that only inserts rows proves only that
 * inserts work:
 *
 * - `insert` — the base case, and the read-back that makes an image full.
 * - `update-one-column` — the delta prior: `prior_json` holds only `title`.
 * - `update-two-columns` — a wider delta, so "only the touched columns" is a
 *   claim about a set and not about one name.
 * - `delete` — the positional OLD image, and `prior: null` rather than `{}`.
 * - `two-statements-one-row` — the session's collapse to one row per key, with
 *   the END state as the image.
 * - `local-lane` — a `replica_intent_outcome` row: key only, no image,
 *   `local = 1`.
 * - `boundary-and-text` — an integer AT `Number.MAX_SAFE_INTEGER`, which is the
 *   largest v0's producer can carry, and a TEXT value that looks exactly like
 *   the wide `{"i":"…"}` form, so the two encodings cannot be confused.
 *   Deliberately AT the boundary and not past it: v0's read-back cannot decode
 *   an INTEGER above 2^53 at all (see `$note` in the fixture), so a value past
 *   it has no oracle row to compare against. The Rust side's own wide-integer
 *   test is `crates/vault/tests/log_plane.rs`.
 *
 * Every id is fixed AND EVERY UPDATE SETS `updated_at` EXPLICITLY, so the
 * fixture is stable across runs and the only thing that varies is what v0's
 * decoder says about it. The explicit timestamp is load-bearing: the touch
 * trigger is `updated_at = CASE WHEN NEW.updated_at = OLD.updated_at THEN
 * strftime('now') ELSE NEW.updated_at END`, so a statement that leaves it alone
 * gets the wall clock and the fixture is different on every run.
 */
const SCRIPT: readonly ScriptedCommit[] = [
  {
    label: "insert",
    producer: "oracle.insert",
    statements: [
      `INSERT INTO core_party (party_id, kind, display_name, sort_name, created_at, updated_at)
       VALUES ('oracle-party-1', 'person', 'Ada Lovelace', 'Lovelace, Ada',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ],
  },
  {
    label: "update-one-column",
    producer: "oracle.update",
    statements: [
      `UPDATE core_party SET display_name = 'Ada King',
              updated_at = '2026-01-02T00:00:00.000Z'
        WHERE party_id = 'oracle-party-1'`,
    ],
  },
  {
    label: "update-two-columns",
    producer: "oracle.update",
    statements: [
      `UPDATE core_party SET display_name = 'Augusta Ada King',
              sort_name = 'King, Augusta Ada',
              updated_at = '2026-01-03T00:00:00.000Z'
        WHERE party_id = 'oracle-party-1'`,
    ],
  },
  {
    label: "two-statements-one-row",
    producer: "oracle.collapse",
    statements: [
      `UPDATE core_party SET display_name = 'first',
              updated_at = '2026-01-04T00:00:00.000Z'
        WHERE party_id = 'oracle-party-1'`,
      `UPDATE core_party SET display_name = 'second',
              updated_at = '2026-01-05T00:00:00.000Z'
        WHERE party_id = 'oracle-party-1'`,
    ],
  },
  {
    label: "boundary-and-text",
    producer: "oracle.boundary",
    statements: [
      `INSERT INTO core_content_item
         (content_id, content_uri, sha256, byte_size, created_at, updated_at)
       VALUES ('oracle-content-1', '{"i":"7"}',
               '0000000000000000000000000000000000000000000000000000000000000abc',
               9007199254740991,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ],
  },
  {
    label: "local-lane",
    producer: "oracle.local",
    statements: [
      `INSERT INTO replica_intent_outcome
         (intent_id, device_id, app_id, action, payload_hash, status, created_at, updated_at)
       VALUES ('oracle-intent-1', 'oracle-device-1', 'tally', 'tally.add_expense',
               'deadbeef', 'queued',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ],
  },
  {
    label: "delete",
    producer: "oracle.delete",
    statements: [`DELETE FROM core_party WHERE party_id = 'oracle-party-1'`],
  },
];

interface LogRowDump {
  readonly commitIndex: number;
  readonly commitLabel: string;
  readonly table: string;
  readonly op: string;
  readonly pk: unknown;
  readonly row: unknown;
  readonly prior: unknown;
  readonly indirect: boolean;
  readonly local: boolean;
  readonly deferred: boolean;
  readonly producer: string;
}

async function main(): Promise<void> {
  const { openVaultDb, bootstrapVault, withReplicaCommit, replicaLogState } =
    (await import(path.join(root, "packages/vault/dist/index.js"))) as {
      openVaultDb: (options: { dir: string }) => {
        vault: import("node:sqlite").DatabaseSync;
        close: () => void;
      };
      bootstrapVault: (
        db: unknown,
        options: { vaultName: string; ownerName: string }
      ) => unknown;
      withReplicaCommit: <T>(
        vault: unknown,
        body: () => T,
        options?: { producer?: string; notify?: boolean }
      ) => T;
      replicaLogState: (vault: unknown) => { watermark: { seq: number } };
    };

  const work = mkdtempSync(path.join(tmpdir(), "centraid-oracle-"));
  const db = openVaultDb({ dir: work });
  const rows: LogRowDump[] = [];
  try {
    bootstrapVault(db, { vaultName: "Oracle", ownerName: "Oracle Owner" });
    // EVERYTHING THE BOOTSTRAP WROTE IS BELOW THIS. The fixture is about the
    // scripted commits, and a bootstrap's rows are v0's founding path — which
    // v1 does not reproduce statement for statement and does not claim to.
    const floor = replicaLogState(db.vault).watermark.seq;

    for (const commit of SCRIPT) {
      withReplicaCommit(
        db.vault,
        () => {
          for (const statement of commit.statements) db.vault.exec(statement);
        },
        { producer: commit.producer, notify: false }
      );
    }

    const dumped = db.vault
      .prepare(
        `SELECT seq, commit_seq, "table", op, pk_json, row_json, prior_json,
                indirect, local, deferred, producer
           FROM replica_log WHERE seq > ? ORDER BY seq`
      )
      .all(floor) as {
      seq: number;
      commit_seq: number;
      table: string;
      op: string;
      pk_json: string;
      row_json: string | null;
      prior_json: string | null;
      indirect: number;
      local: number;
      deferred: number;
      producer: string;
    }[];

    // Commit positions are renumbered from 0 in the order they appear, so the
    // fixture says "the third scripted commit" rather than "commit 47" — the
    // absolute number depends on how many commits the bootstrap took.
    const order: number[] = [];
    for (const row of dumped)
      if (!order.includes(row.commit_seq)) order.push(row.commit_seq);

    for (const row of dumped) {
      const commitIndex = order.indexOf(row.commit_seq);
      rows.push({
        commitIndex,
        commitLabel: SCRIPT[commitIndex]?.label ?? "(unscripted)",
        table: row.table,
        op: row.op,
        pk: JSON.parse(row.pk_json),
        row: row.row_json === null ? null : JSON.parse(row.row_json),
        prior: row.prior_json === null ? null : JSON.parse(row.prior_json),
        indirect: row.indirect === 1,
        local: row.local === 1,
        deferred: row.deferred === 1,
        producer: row.producer,
      });
    }
  } finally {
    db.close();
    rmSync(work, { force: true, recursive: true });
  }

  const exported = {
    schema: "centraid-applier-oracle/1",
    $generatedBy: "bun contracts/tools/export-applier-oracle.ts",
    $note:
      "v0's own `withReplicaCommit` decoded these statements into these rows " +
      "(#1020, D-1020-D1-11). `seq`, `epoch` and `committed_at` are omitted: " +
      "they are per-file facts and comparing them would compare the two RUNS " +
      "rather than the two decoders. Volatile row columns (`updated_at`, " +
      "`row_version`) are kept — v0's touch trigger sets them from the " +
      "statement's own values here, and the Rust side runs the same trigger. " +
      "NO VALUE ABOVE 2^53 IS IN THE SCRIPT: v0's decode reads the row back " +
      "with a statement that never calls `setReadBigInts(true)`, so any commit " +
      "writing an INTEGER above `Number.MAX_SAFE_INTEGER` into a replicated " +
      "table throws ERR_OUT_OF_RANGE at capture and rolls back whole — v0 " +
      "cannot produce the `{i}` form its own wire contract defines. Reported " +
      "as a finding under #1020; v1 has no such limit.",
    script: SCRIPT,
    rows,
  };
  process.stdout.write(`${JSON.stringify(exported, null, 2)}\n`);
}

await main();
