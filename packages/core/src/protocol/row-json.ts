// THE JSON TYPE CONTRACT FOR A LOG ROW (#996, ruling R5).
//
// The gateway captures a commit with SQLite's session extension and decodes it
// to JSON row images. Three SQLite builds have to read those images — the
// gateway's 3.50, the browser's 3.53 and the phone's 3.49 — and only one of
// them can call `applyChangeset` at all, which is why the wire is JSON and not
// the changeset the gateway captured.
//
// JSON IS LOSSY FOR SQLITE UNLESS YOU SAY SO. Three values a photo vault
// actually holds do not survive `JSON.stringify` of a row:
//
//   - A BLOB. JSON1 has no byte string, and the old change log's trigger
//     reduced blobs to NULL — a silent hole that only failed later, in a
//     filter over a column nobody had looked at.
//   - A 64-BIT INTEGER. `Number` loses precision past 2^53−1, and a vault that
//     stores byte counts and epoch-nanosecond timestamps reaches that.
//   - THE DIFFERENCE BETWEEN "NULL" AND "NOT IN THIS IMAGE". An UPDATE
//     changeset omits every column the statement did not touch; a reader that
//     cannot tell an omitted column from a NULL one writes NULLs over live
//     data. The decoder reconstructs the FULL image precisely so this never
//     arises on the wire — and the encoding still distinguishes the two,
//     because a contract that relies on a producer never making the mistake is
//     not a contract.
//
// So: `null` is SQL NULL, an absent KEY is an absent column, a JSON string is
// TEXT, a JSON number is REAL or a small INTEGER, and the two wide types get
// one-key objects. TEXT can never collide with them — a TEXT value encodes as
// a JSON string, never as an object.

/** A SQLite value on the wire. */
export type WireValue =
  | null
  | string
  | number
  | boolean
  | { readonly i: string }
  | { readonly b64: string };

/** One row image: column name → value. An absent key is an absent column. */
export type WireRowImage = Readonly<Record<string, WireValue>>;

/** Beyond this a JSON number silently loses integer precision. */
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// BASE64 BY HAND, because this package is dependency-free and runs on all
// three seats: `Buffer` is Node's, and `btoa`/`atob` take a binary STRING,
// which is a second lossy hop for bytes above 0x7f. The alphabet is 65
// characters and the loop is eight lines — cheaper than the platform check.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : B64[c & 63]!;
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/u, "");
  const bytes = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0;
  let acc = 0;
  let out = 0;
  for (const character of clean) {
    const value = B64.indexOf(character);
    if (value < 0) throw new TypeError("replica log: malformed base64 blob");
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (acc >> bits) & 0xff;
    }
  }
  return bytes;
}

/**
 * Encode one column value. `bigint` and `Uint8Array` are what `node:sqlite`
 * hands back for INTEGER-beyond-2^53 and BLOB respectively.
 */
export function encodeWireValue(value: unknown): WireValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    // Small enough to be exact as a number: keep it a number, so the common
    // case costs no bytes and no branch on the applier.
    return value <= SAFE && value >= -SAFE
      ? Number(value)
      : { i: value.toString(10) };
  }
  if (value instanceof Uint8Array) {
    return { b64: toBase64(value) };
  }
  throw new TypeError(
    `replica log: unencodable SQLite value of type ${typeof value}`
  );
}

/** Decode one column value back to something `node:sqlite` will bind. */
export function decodeWireValue(
  value: WireValue
): null | string | number | bigint | Uint8Array {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if ("i" in value) return BigInt(value.i);
  return fromBase64(value.b64);
}

export function encodeWireRow(
  row: Readonly<Record<string, unknown>>
): WireRowImage {
  const out: Record<string, WireValue> = {};
  for (const [column, value] of Object.entries(row))
    out[column] = encodeWireValue(value);
  return out;
}

export function decodeWireRow(
  image: WireRowImage
): Record<string, null | string | number | bigint | Uint8Array> {
  const out: Record<string, null | string | number | bigint | Uint8Array> = {};
  for (const [column, value] of Object.entries(image))
    out[column] = decodeWireValue(value);
  return out;
}

/**
 * The statement a seat applies an insert/update row image with (R5).
 *
 * `INSERT … ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`: REPLACE DELETES
 * the conflicting row and then inserts, and it fires the delete triggers only
 * under `recursive_triggers` — so on a seat, whose only retained triggers are
 * the FTS sync ones, REPLACE desynchronises the search index against the data
 * it indexes and nothing reports it.
 *
 * `ON CONFLICT DO UPDATE` is SQLite 3.24; the oldest seat is 3.49
 * (`SEAT_SQLITE_FLOOR`), so this is inside the floor by a wide margin.
 */
export function applyRowSql(
  table: string,
  columns: readonly string[],
  primaryKey: readonly string[]
): string {
  if (columns.length === 0)
    throw new Error(`replica apply: ${table} row image has no columns`);
  if (primaryKey.length === 0)
    throw new Error(`replica apply: ${table} has no declared primary key`);
  const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  const assignable = columns.filter((column) => !primaryKey.includes(column));
  const setClause =
    assignable.length > 0
      ? assignable
          .map((column) => `${quoted(column)} = excluded.${quoted(column)}`)
          .join(", ")
      : // A row that is nothing but its key still has to land; DO NOTHING is
        // the correct no-op, and it is not the same statement as DO UPDATE
        // with an empty SET, which is a syntax error.
        null;
  return (
    `INSERT INTO ${quoted(table)} (${columns.map(quoted).join(", ")})\n` +
    `VALUES (${columns.map(() => "?").join(", ")})\n` +
    `ON CONFLICT (${primaryKey.map(quoted).join(", ")}) DO ` +
    (setClause === null ? "NOTHING" : `UPDATE SET ${setClause}`)
  );
}

/** The statement a seat applies a delete row with. */
export function deleteRowSql(
  table: string,
  primaryKey: readonly string[]
): string {
  if (primaryKey.length === 0)
    throw new Error(`replica apply: ${table} has no declared primary key`);
  const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;
  return (
    `DELETE FROM ${quoted(table)} WHERE ` +
    primaryKey.map((column) => `${quoted(column)} = ?`).join(" AND ")
  );
}
