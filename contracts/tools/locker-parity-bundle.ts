// THE LOCKER PARITY BUNDLE'S SHAPE, and the canonicalisation that makes two
// runs of the generator agree byte for byte (#1020, wave 4 lane Locker).
//
// Split from `export-locker-parity.ts` at the repository's 625-line ceiling,
// the same way Photos' is: this half is the DATA — what a case, a row set and
// the bundle are, plus the epoch, the table list and the canonicaliser — and
// that file is the RUN.
//
// ============================================================================
// THE ONE THING THIS FILE EXISTS FOR: A SEALED CELL IS NOT REPRODUCIBLE.
// ============================================================================
//
// Every `lk1:` cell is AES-256-GCM with a **fresh random 96-bit nonce per
// value** (`packages/vault/src/gateway/locker-key-plane.ts:25`), and the key id
// is a UUIDv7 minted off the clock. So two runs of the generator over the same
// script produce different bytes for the same secret, and a fixture that
// carried them would fail `git diff --exit-code` on every regeneration.
//
// What a port actually has to reproduce is not *which* ciphertext — it is
// **that the cell is ciphertext, under the generation the row names**. So a
// sealed cell canonicalises to [`SEALED_CELL`] and a key id to [`KEY_ID`],
// both of which say what was there. Dropping them to `null` would have lost
// the distinction between "a sealed cell" and "no secret", which is exactly
// the distinction `has_totp`, `sealed: true` and `has_private_key` are built
// on — three of Locker's own payload fields.
//
// The same rule and the same reason as Photos' BLOB-to-`null`, one step less
// lossy because here the *presence* is load-bearing.

import type { DatabaseSync } from "node:sqlite";

import { writeReceipt } from "../../packages/vault/src/gateway/evidence.js";
import type { ReceiptInput } from "../../packages/vault/src/gateway/evidence.js";

export const LOCKER_PARITY_DIR = "contracts/apps/locker";

/**
 * The instant the whole run is stamped at. Frozen, and in the far future for
 * the reason Tally's and Photos' generators record: the vault has TWO clocks,
 * and a v0 condition comparing `purge_at` against SQLite's own `now` cannot be
 * held still by a JS proxy. `locker.restore_item`'s precondition is exactly
 * such a comparison (`ITEM_TRASHED_SQL` in
 * `packages/vault/src/commands/locker.ts`, which binds `:ctx_now`), and the
 * trash/restore pair is one of the cases this fixture exists to pin — so at a
 * past epoch it could not be fixtured at all.
 *
 * The Rust port took the other road (its condition reads `ctx.now`), so the
 * same fixture is reproducible at any instant. The epoch stays in 2099 while
 * v0 is the oracle.
 */
export const PARITY_EPOCH = "2099-06-01T09:00:00.000Z";

/** A cell sealed under the MEMBER KEY. See this file's header. */
export const SEALED_CELL = "«lk1»";

/**
 * A cell sealed under the VAULT DEK — and the finding this token exists for.
 *
 * v0's `locker-key-plane.ts` mints `K` and stamps `key_id` on every Locker
 * write, and the **actual sealing on a command write is still the DEK's**:
 * `packages/vault/src/gateway/execution.ts:177`-`:189` calls
 * `stampLockerKeyOnWrite` (which writes the id and nothing else) and then the
 * `SEALED_COLUMNS` sweep, so `locker.add_item` leaves `sealed:v1:…` in
 * `locker_item.password`. Verified by running the real v0 gateway: a login
 * added through the real command comes back `sealed:v1:Z53i…` with a
 * `locker_key.key_id` beside it.
 *
 * So the `lk1:` plane in v0 is the **seat's** half only, and a v0 Locker
 * secret is recoverable with the vault DEK alone. That is consistent with
 * SECURITY.md's v0 storage premise and it is a sharper statement of what wave
 * 4 changes than the census had: the port is the first place where the member
 * key is the *only* thing that opens a Locker cell.
 *
 * The fixture therefore records WHICH form each cell is in, rather than
 * throwing on one of them — because the difference between the two tokens is
 * the custody change, and a fixture that hid it would hide the thing this lane
 * is about.
 */
export const DEK_SEALED_CELL = "«sealed:v1»";

/**
 * A receipt's hash-chain digest, which is a SHA-256 over ids the bootstrap
 * minted — so it is unreproducible even after the ids are tokenised, because
 * the hash was taken before that.
 *
 * What a port reproduces about the chain is its **shape**: one row per event,
 * `seq` contiguous, each row's `prev` the one before it. The digest itself is
 * `crates/vault::audit::verify_receipt_chain`'s business and is proven there
 * over a live vault, not here over a file.
 */
export const RECEIPT_HASH = "«hash»";

/**
 * The digest of the receipt at chain position `seq`.
 *
 * **And the reason it is not just [`RECEIPT_HASH`]:** `access_receipt.hash` is
 * `UNIQUE`, so a bundle that tokenised forty-nine digests to one string cannot
 * be REPLAYED — `crates/apps/kit::open_contract_vault` inserts the rows into
 * the committed schema and the second one fails the constraint. A fixture that
 * cannot be loaded is not a fixture, and the Rust parity comparison found this
 * the first time it built a vault from the file.
 *
 * `seq` is the chain POSITION and is stable across runs, so the token is
 * reproducible AND unique — which is the pair the column needs. What a port
 * reproduces about the chain is still its shape (one row per event, `seq`
 * contiguous, each digest distinct); the digest itself is
 * `crates/vault::audit::verify_receipt_chain`'s business, proven there over a
 * live vault rather than here over a file.
 */
export function receiptHash(seq: unknown): string {
  const position = typeof seq === "number" ? seq : Number(seq);
  return Number.isFinite(position)
    ? `«hash:${String(position).padStart(4, "0")}»`
    : RECEIPT_HASH;
}

/**
 * A command answer that IS the plaintext, elided rather than tokenised.
 *
 * `locker.export`'s v0 output is every secret in the locker in the clear —
 * that is what the command is. A fixture carrying it would be every test
 * password in the repository, so the case records that it ran, how many items
 * it covered, and nothing else. The port's own answer carries no plaintext at
 * all (D-1020-L7), which is why the shape difference is recorded in
 * `contracts/apps/locker/manifest.json` rather than compared here.
 */
export const ELIDED_PLAINTEXT = "«plaintext-elided»";

/** What a member-key generation id canonicalises to. */
export const KEY_ID = "«key»";

/**
 * The vault DEK's own fingerprint, and the finding it cost to find.
 *
 * `core_vault.settings_json` carries `seal_key.fingerprint` — `sha256:` over
 * the data key the bootstrap minted — and the digest is **truncated to 32 hex
 * characters**, which is exactly the shape of a dashless UUID. So
 * `tally-parity-canonical.ts`'s id regex claims it, hands it an `id-NNNN`
 * token, and — because the tokens are numbered in the ids' own sort order — a
 * random digest that sorts first in one run and last in the next **shifts the
 * token of every other id in the bundle**. Two runs then differ in 658 lines
 * over a single cell.
 *
 * That is why it is tokenised HERE, before the id pass can see it: the
 * `sha256:` prefix is a word boundary the id regex respects, so the token
 * survives it. What a port has to reproduce about this cell is that the vault
 * records a fingerprint of the key it sealed under — not which key.
 */
export const SEAL_FINGERPRINT = "«fingerprint»";

/**
 * The tables the eight Locker queries read, in the order the item pane reads
 * them.
 *
 * Derived from the STATEMENTS, not from the manifest's `vault.scopes`: the
 * manifest declares reach and the statements are what ran. `access_receipt` is
 * on the list because `queries/access.ts` reads it — it is in the audit band
 * and not the replica, which is why that query is online-only and why its rows
 * belong in a fixture a port has to reproduce.
 */
export const LOCKER_PARITY_TABLES = [
  "core_vault",
  "core_party",
  "core_concept_scheme",
  "core_concept",
  "core_tag",
  "core_entity_revision",
  "core_attachment",
  "core_content_item",
  "core_content_representation",
  "knowledge_annotation",
  "locker_key",
  "locker_item",
  "locker_item_alias",
  "locker_item_field",
  "locker_item_address",
  "locker_item_passkey",
  "access_receipt",
] as const;

/**
 * The columns whose value is a sealed cell, by table.
 *
 * The same registry `LOCKER_ENCRYPTED_COLUMNS` states, restated here because
 * this file must not import the gateway's key plane: a generator that pulled
 * in `locker-key-plane.ts` would pull in the key store, and a tool that can
 * read a key is a tool that will.
 */
export const SEALED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  locker_item: ["password", "otp_seed", "card_number", "cvv", "content"],
  locker_item_field: ["value_sealed"],
  locker_item_passkey: ["private_key"],
};

/** One table's rows, as data. */
export interface TableRows {
  table: string;
  columns: string[];
  rows: (string | number | null)[][];
}

/** One query, at one named input, and what v0 answered. */
export interface QueryCase {
  query: string;
  input: Record<string, unknown>;
  output: unknown;
  /**
   * Why this case is here, in one clause. Not decoration: eight queries at
   * twenty-two inputs is a list a reader cannot navigate without it, and a
   * case whose reason nobody could state is a case nobody should trust.
   */
  why: string;
}

/** One command, its input, and how the gateway answered. */
export interface CommandCase {
  command: string;
  input: Record<string, unknown>;
  status: string;
  output: unknown;
  reason?: string;
}

export interface LockerParityBundle {
  rows: TableRows[];
  queries: QueryCase[];
  commands: CommandCase[];
  scenarios: unknown;
}

/**
 * Canonical JSON: object keys sorted, so two runs of the generator produce the
 * same bytes and `git diff --exit-code` means what it says.
 */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).toSorted(
    ([left], [right]) => left.localeCompare(right)
  );
  return Object.fromEntries(
    entries.map(([key, item]) => [key, sortDeep(item)])
  );
}

/** Is this string a `lk1:` cell? The structural test, not a prefix test. */
export function isSealed(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("lk1:")) return false;
  const body = value.slice(4);
  return body.length >= 40 && body.length % 4 === 0;
}

/** Is this string a `sealed:v1:` cell? The same structural test. */
export function isDekSealed(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("sealed:v1:"))
    return false;
  const body = value.slice(10);
  return body.length >= 38 && body.length % 4 === 0;
}

/**
 * Replace every unreproducible value with the token that says what it was.
 *
 * Three classes, and each one is a different kind of unreproducible:
 *
 * 1. **A sealed cell** — a fresh nonce per value. → [`SEALED_CELL`].
 * 2. **A key generation id** — a UUIDv7 off the clock. → [`KEY_ID`].
 * 3. **Ids the vault minted** — also UUIDv7. These are NOT tokenised: they are
 *    compared *relationally*, because an id appearing in two places is the
 *    fixture's own statement that a join holds. The generator instead runs on
 *    a **seeded id source** so they are reproducible (the same choice Tally's
 *    generator made, `contracts/tools/tally-parity-canonical.ts`).
 */
export function canonicaliseCell(
  table: string,
  column: string,
  cell: unknown,
  row: Readonly<Record<string, unknown>> = {}
): string | number | null {
  if (cell instanceof Uint8Array) return null;
  if (table === "access_receipt" && column === "hash" && cell != null) {
    // Keyed by the row's own chain position, because the column is UNIQUE and
    // the bundle has to REPLAY. See [`receiptHash`].
    return receiptHash(row.seq);
  }
  if (column === "key_id" && typeof cell === "string" && cell.length > 0) {
    return KEY_ID;
  }
  if (column.endsWith("_json") && typeof cell === "string" && cell.length > 0) {
    // A JSON DOCUMENT IN A COLUMN HIDES EVERY RULE ABOVE FROM ITSELF.
    // `core_entity_revision.snapshot_json` is the whole written row, sealed
    // cells and key id included, and `core_vault.settings_json` holds the DEK
    // fingerprint — none of which `SEALED_COLUMNS` can see, because the column
    // here is `snapshot_json`, not `password`. So the document is walked.
    return canonicaliseEmbeddedJson(cell);
  }
  if (SEALED_COLUMNS[table]?.includes(column) && cell != null) {
    // WHICH KEY SEALED IT IS RECORDED, because that is the custody change.
    if (isSealed(cell)) return SEALED_CELL;
    if (isDekSealed(cell)) return DEK_SEALED_CELL;
    // A cell that is NEITHER is the bug this fixture exists to catch: a
    // plaintext in a sealed column. The generator throws rather than writing
    // a secret into a repository.
    throw new Error(
      `${table}.${column} holds a value that is neither lk1: nor sealed:v1: ciphertext — a plaintext in a sealed column is the bug this fixture exists to catch`
    );
  }
  return (cell ?? null) as string | number | null;
}

/**
 * Is this string the vault DEK's truncated fingerprint? See
 * [`SEAL_FINGERPRINT`].
 */
export function isSealFingerprint(value: unknown): boolean {
  return typeof value === "string" && /^sha256:[0-9a-f]{32,64}$/u.test(value);
}

/**
 * The same three rules, applied INSIDE a JSON-valued column, and re-stringified
 * so the cell stays a string the way the database holds it.
 *
 * A cell that does not parse is left alone rather than guessed at: a `_json`
 * column holding something else is a finding about the writer, and a
 * canonicaliser that swallowed it would hide it.
 */
function canonicaliseEmbeddedJson(cell: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cell);
  } catch {
    return cell;
  }
  return JSON.stringify(canonicaliseDocument(parsed));
}

function canonicaliseDocument(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicaliseDocument);
  if (value === null || typeof value !== "object") {
    if (isSealed(value)) return SEALED_CELL;
    if (isDekSealed(value)) return DEK_SEALED_CELL;
    if (isSealFingerprint(value)) return SEAL_FINGERPRINT;
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      key === "key_id" && typeof item === "string" && item.length > 0
        ? KEY_ID
        : canonicaliseDocument(item),
    ])
  );
}

/**
 * `locker.export`'s answer is every secret in the clear, so the items are
 * replaced by their count. Everything else passes through.
 */
function elideExportPlaintext(command: string, output: unknown): unknown {
  if (
    command !== "locker.export" ||
    output === null ||
    typeof output !== "object"
  ) {
    return output;
  }
  const answer = output as Record<string, unknown>;
  const items = Array.isArray(answer.items) ? answer.items.length : 0;
  return {
    exported_at: answer.exported_at ?? null,
    item_count: answer.item_count ?? null,
    items: ELIDED_PLAINTEXT,
    items_elided: items,
  };
}

/** The same pass over a query's answer, which may nest. */
export function canonicaliseAnswer(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicaliseAnswer);
  if (value === null || typeof value !== "object") {
    if (isSealed(value)) return SEALED_CELL;
    if (isDekSealed(value)) return DEK_SEALED_CELL;
    if (isSealFingerprint(value)) return SEAL_FINGERPRINT;
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      key === "key_id" && typeof item === "string" && item.length > 0
        ? KEY_ID
        : canonicaliseAnswer(item),
    ])
  );
}

/**
 * Canonicalise the whole bundle, once, on the way out.
 *
 * TWO PASSES, AND TALLY'S IS THE SECOND. This file's own pass replaces the
 * unreproducible **crypto** — a nonce per sealed cell, a key generation id.
 * `contracts/tools/tally-parity-canonical.ts`'s `canonicaliser()` replaces the
 * unreproducible **identity**: a UUIDv7 the bootstrap minted, a host instant
 * outside the frozen year. Reused rather than reimplemented, because the
 * order-of-assignment bug its own header records ("the tokens are assigned in
 * the ids' OWN SORT ORDER") is a bug worth inheriting the fix for, not
 * rediscovering.
 *
 * The passes run in this order for a reason: the id pass would otherwise
 * rewrite the hex inside a base64 ciphertext body and produce a token nobody
 * can trace.
 */
export function canonicaliseBundle(
  bundle: LockerParityBundle,
  identity: <T>(value: T) => T
): LockerParityBundle {
  return identity({
    rows: bundle.rows,
    queries: bundle.queries.map((entry) => ({
      ...entry,
      output: canonicaliseAnswer(entry.output),
    })),
    commands: bundle.commands.map((entry) => ({
      ...entry,
      output: elideExportPlaintext(
        entry.command,
        canonicaliseAnswer(entry.output)
      ),
    })),
    scenarios: canonicaliseAnswer(bundle.scenarios),
  });
}

/**
 * THE ACCESS HISTORY HAS NO WRITER LEFT IN v0, so the fixture plants one.
 *
 * `queries/access.ts` reads `access_receipt` behind
 * `object_type IN ('locker.item','locker.auth')` — and **no v0 product path
 * writes either value any more.** The gateway's reveal door refuses
 * `ref.schema === "locker"` outright (`gateway/gateway.ts:781`, #996 rulings
 * R13/W6-D2), which was the only writer of a `locker.item` reveal; the unlock
 * that wrote `locker.auth` moved to the seat with the key. Every other receipt
 * the corpus produces is the command gate's `agent.command`, which this
 * query's wall correctly excludes.
 *
 * So without these three rows all three `access` cases answer `entries: []`,
 * and the comparison would be green for the wrong reason — green against a
 * port that never implemented the query at all.
 *
 * They are planted through v0's own `writeReceipt`, so the hash chain and
 * `seq` stay valid, in exactly the three shapes v0's own suite uses
 * (`queries-reveal-access.test.ts:102`-`:131`): a DENIED unlock, a bare UI
 * reveal, and a fill carrying its page origin. That is all three `kind` arms
 * and both `decision` values, which is what a port's fold has to reproduce.
 *
 * This is the generator constructing an oracle state no command can reach —
 * the same move Photos' generator makes when it runs v0's own sweeps before
 * the compared read. It is not a fixture edit and it changes no v0 behaviour.
 *
 * The separate question of whether the query should work at all is a FINDING,
 * recorded in `contracts/apps/locker/manifest.json`'s `accessFinding` and
 * asserted by `crates/apps/locker/tests/parity.rs`: `access_receipt` is not
 * one of the vault's catalog entities, so the paged door refuses the read and
 * v0's own catch arm turns that into an empty screen.
 */
export function plantLockerAccessReceipts(
  audit: DatabaseSync,
  itemId: string,
  tick: () => void
): void {
  const planted: ReceiptInput[] = [
    {
      authorityId: null,
      invocationId: null,
      action: "authenticate locker.unlock",
      objectType: "locker.auth",
      objectId: null,
      decision: "deny",
      detail: { failing: "wrong passphrase" },
    },
    {
      authorityId: null,
      invocationId: null,
      action: "reveal",
      objectType: "locker.item",
      objectId: itemId,
      decision: "allow",
      detail: { columns: ["password"] },
    },
    {
      authorityId: null,
      invocationId: null,
      action: "reveal",
      objectType: "locker.item",
      objectId: itemId,
      decision: "allow",
      detail: {
        columns: ["password"],
        context: { kind: "fill", origin: "https://www.bank.example" },
      },
    },
  ];
  for (const receipt of planted) {
    writeReceipt(audit, receipt);
    // Time moves between receipts, or the ordering claim over them says
    // nothing — even though the canonicaliser flattens the column anyway.
    tick();
  }
}
