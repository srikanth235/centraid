// READING A SESSION CHANGESET, BECAUSE node:sqlite WILL NOT (#996, ruling R5).
//
// `node:sqlite` exposes `session.changeset()` and `db.applyChangeset()` and
// nothing between them: there is no `sqlite3changeset_start` iterator, so the
// only way to see what a commit touched is to parse the v1 wire format the
// session extension writes. That is a documented, stable format (session.c),
// and this parser was cross-checked against known three-statement changesets
// on 3.50.2 and 3.51.2, byte-identical on both.
//
// WHAT THE FORMAT COSTS AND WHY IT IS STILL RIGHT. On a 10k-row UPDATE commit
// the JS parse is 380 ms against 30 ms for the statement itself — an artifact
// of the missing native iterator, not of the design. The alternative is to
// have every writer tell the log what it wrote, which is the mechanism #996
// deleted: a change log that depends on writers remembering is a change log
// that is wrong exactly where a writer forgot.
//
// WHAT THE PARSER DOES NOT DECIDE. It reports what the session emitted, not
// what the log should say. Two of those distinctions are load-bearing and are
// resolved one layer up, in `decodeChangeset`:
//   - A PK-CHANGING UPDATE is never an update on the wire; the session emits
//     DELETE(old) + INSERT(new), including for an INTEGER PRIMARY KEY alias.
//   - AN UPDATE'S `newRec` OMITS EVERY UNTOUCHED COLUMN, so the values here
//     are never a row image. The full image is read from the database, by the
//     changeset's own primary-key flags, inside the capturing transaction.

/** Byte tags for the three change kinds, from session.c. */
const OPS: Readonly<Record<number, ChangesetOp>> = {
  9: "delete",
  18: "insert",
  23: "update",
};

export type ChangesetOp = "insert" | "update" | "delete";

export type ChangesetValue =
  | { readonly kind: "absent" }
  | { readonly kind: "null" }
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "real"; readonly value: number }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "blob"; readonly value: Uint8Array };

export interface ChangesetChange {
  readonly table: string;
  /** Column count the session declared for this table. */
  readonly columnCount: number;
  /** Per-column: is this column part of the table's primary key? */
  readonly primaryKeyFlags: readonly boolean[];
  readonly op: ChangesetOp;
  /** True when a trigger or a foreign-key cascade produced the change. */
  readonly indirect: boolean;
  /** Present for update and delete. */
  readonly oldValues: readonly ChangesetValue[] | null;
  /** Present for update and insert. */
  readonly newValues: readonly ChangesetValue[] | null;
}

/** SQLite's 32-bit varint: seven bits per byte, high bit continues, five max. */
function readVarint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    const byte = bytes[at + index]!;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value >>> 0, index + 1];
  }
  return [((value << 8) | bytes[at + 4]!) >>> 0, 5];
}

function readValue(
  bytes: Uint8Array,
  view: DataView,
  at: number
): [ChangesetValue, number] {
  const tag = bytes[at]!;
  let cursor = at + 1;
  if (tag === 0) return [{ kind: "absent" }, cursor];
  if (tag === 5) return [{ kind: "null" }, cursor];
  if (tag === 1) {
    // BigInt, not Number: a rowid or a byte count past 2^53 is exactly the
    // value a naive read corrupts without saying so.
    return [
      { kind: "int", value: view.getBigInt64(cursor, false) },
      cursor + 8,
    ];
  }
  if (tag === 2) {
    return [
      { kind: "real", value: view.getFloat64(cursor, false) },
      cursor + 8,
    ];
  }
  if (tag === 3 || tag === 4) {
    const [length, width] = readVarint(bytes, cursor);
    cursor += width;
    const raw = bytes.subarray(cursor, cursor + length);
    return [
      tag === 3
        ? { kind: "text", value: new TextDecoder().decode(raw) }
        : { kind: "blob", value: raw.slice() },
      cursor + length,
    ];
  }
  throw new Error(`replica changeset: unknown value tag ${tag} at byte ${at}`);
}

/** Parse one changeset into its changes, in the order the session wrote them. */
export function parseChangeset(input: Uint8Array): ChangesetChange[] {
  const bytes = input;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const changes: ChangesetChange[] = [];
  let cursor = 0;
  let table: {
    name: string;
    columnCount: number;
    primaryKeyFlags: boolean[];
  } | null = null;
  while (cursor < bytes.length) {
    const tag = bytes[cursor]!;
    if (tag === 0x54) {
      // 'T': a table header — name, column count, and the primary-key flags
      // this parser's callers read the key by.
      cursor += 1;
      const [columnCount, width] = readVarint(bytes, cursor);
      cursor += width;
      const primaryKeyFlags = [
        ...bytes.subarray(cursor, cursor + columnCount),
      ].map((flag) => flag !== 0);
      cursor += columnCount;
      let end = cursor;
      while (bytes[end] !== 0) end += 1;
      table = {
        name: new TextDecoder().decode(bytes.subarray(cursor, end)),
        columnCount,
        primaryKeyFlags,
      };
      cursor = end + 1;
      continue;
    }
    const op = OPS[tag];
    if (!op || !table) {
      throw new Error(
        `replica changeset: unknown record tag ${tag} at byte ${cursor}`
      );
    }
    cursor += 1;
    const indirect = bytes[cursor] !== 0;
    cursor += 1;
    const readRecord = (): ChangesetValue[] => {
      const record: ChangesetValue[] = [];
      for (let index = 0; index < table!.columnCount; index += 1) {
        const [value, next] = readValue(bytes, view, cursor);
        record.push(value);
        cursor = next;
      }
      return record;
    };
    const oldValues = op === "insert" ? null : readRecord();
    const newValues = op === "delete" ? null : readRecord();
    changes.push({
      table: table.name,
      columnCount: table.columnCount,
      primaryKeyFlags: table.primaryKeyFlags,
      op,
      indirect,
      oldValues,
      newValues,
    });
  }
  return changes;
}

/** The bindable form of one parsed value; `absent` never reaches a bind. */
export function changesetValueToBindable(
  value: ChangesetValue
): null | string | number | bigint | Uint8Array {
  switch (value.kind) {
    case "absent":
      throw new Error("replica changeset: an absent column cannot be bound");
    case "null":
      return null;
    case "int":
      // node:sqlite binds a bigint fine, but a small one is cheaper as a
      // number and compares equal in SQLite either way.
      return value.value >= BigInt(Number.MIN_SAFE_INTEGER) &&
        value.value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value.value)
        : value.value;
    case "real":
      return value.value;
    case "text":
      return value.value;
    case "blob":
      return value.value;
  }
}
