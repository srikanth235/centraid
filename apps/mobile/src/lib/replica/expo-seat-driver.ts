import { openDatabaseSync } from "expo-sqlite";
import type { SQLiteBindValue, SQLiteDatabase } from "expo-sqlite";

import type {
  SeatBindValue,
  SeatSqliteDriver,
} from "@centraid/client/replica/native";

import { keyPragma } from "./expo-sqlite-driver";
import { asReplicaStorageError } from "./replica-storage-error";

/**
 * THE PHONE'S SEAT DRIVER (#996 wave 3).
 *
 * The seat holds `vault.db` whole, so its bind union carries two types the old
 * store's never did — `Uint8Array` and `bigint` — and expo-sqlite takes exactly
 * one of them. `SQLiteBindValue` is `string | number | null | boolean |
 * Uint8Array | ArrayBuffer`: blobs cross the bridge fine, and a `bigint` does
 * not cross it at all. Numbers arrive on the native side as a Double
 * (`SQLiteModule.kt:401-405`, `SQLiteModule.swift:629-647`), so even a `number`
 * could not carry an integer past 2^53 — which is precisely the value
 * `row-json.ts`'s `{i: "…"}` encoding exists to preserve.
 *
 * So the wide integer is bound as its DECIMAL DIGITS and the placeholder that
 * takes it is wrapped in `CAST(? AS INTEGER)`. SQLite's CAST of a text integer
 * is exact for the whole 64-bit range, it is older than the 3.49 floor by
 * twenty releases, and it is confined to the one placeholder that needs it —
 * wrapping every placeholder would change the affinity of every other column.
 */
export class ExpoSeatDriver implements SeatSqliteDriver {
  private constructor(private readonly db: SQLiteDatabase) {}

  static open(options: {
    name: string;
    location?: string;
    key?: string;
    /**
     * expo caches connections by database NAME, so the second handle on one
     * seat file — the background task's — must ask for its own or it shares
     * the foreground's and closes it (`SQLiteOpenOptions.useNewConnection`).
     */
    useNewConnection?: boolean;
  }): ExpoSeatDriver {
    try {
      const db = openDatabaseSync(
        options.name,
        options.useNewConnection === true ? { useNewConnection: true } : {},
        options.location
      );
      // The key is the first statement on the handle, before any PRAGMA the
      // seat's own open block runs — those are writes.
      if (options.key !== undefined) db.execSync(keyPragma(options.key));
      return new ExpoSeatDriver(db);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  run(sql: string, bind: readonly SeatBindValue[] = []): void {
    const [source, params] = bindWideIntegers(sql, bind);
    try {
      this.db.runSync(source, params);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  all<T extends object>(sql: string, bind: readonly SeatBindValue[] = []): T[] {
    const [source, params] = bindWideIntegers(sql, bind);
    try {
      return this.db.getAllSync<T>(source, params);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  exec(sql: string): void {
    try {
      this.db.execSync(sql);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  close(): void {
    this.db.closeSync();
  }
}

/**
 * Rewrite the placeholders that take a `bigint`, and only those.
 *
 * The scan has to know where a `?` is NOT a placeholder — inside a string
 * literal, a quoted or bracketed identifier, or a comment — because the seat's
 * DDL and the FTS rebuild both carry all four. Miscounting there would wrap the
 * wrong placeholder, which is a silently wrong VALUE rather than an error.
 */
export function bindWideIntegers(
  sql: string,
  bind: readonly SeatBindValue[]
): [string, SQLiteBindValue[]] {
  if (!bind.some((value) => typeof value === "bigint"))
    return [sql, bind as SQLiteBindValue[]];

  const params: SQLiteBindValue[] = [];
  let out = "";
  let index = 0;
  let cursor = 0;
  while (cursor < sql.length) {
    const char = sql[cursor];
    const next = sql[cursor + 1];
    const skipTo = closingIndex(sql, cursor);
    if (skipTo !== null) {
      out += sql.slice(cursor, skipTo);
      cursor = skipTo;
      continue;
    }
    if (char === "?") {
      // A numbered or named parameter (`?1`, `:x`, `$x`, `@x`) would make
      // position and ordinal disagree; the seat emits neither, and guessing is
      // how the wrong column gets the wide integer.
      if (next !== undefined && /[0-9]/u.test(next))
        throw new Error(
          "seat driver: numbered SQL parameters are not supported alongside 64-bit integer binds"
        );
      const value = bind[index];
      index += 1;
      if (typeof value === "bigint") {
        out += "CAST(? AS INTEGER)";
        params.push(value.toString());
      } else {
        out += "?";
        params.push(value as SQLiteBindValue);
      }
      cursor += 1;
      continue;
    }
    out += char;
    cursor += 1;
  }
  if (index !== bind.length)
    throw new Error(
      `seat driver: ${String(bind.length)} bind values for ${String(index)} placeholders`
    );
  return [out, params];
}

/** The index just past a literal, quoted identifier or comment opening at `at`, or null. */
function closingIndex(sql: string, at: number): number | null {
  const char = sql[at];
  const next = sql[at + 1];
  if (char === "-" && next === "-") {
    const end = sql.indexOf("\n", at);
    return end === -1 ? sql.length : end + 1;
  }
  if (char === "/" && next === "*") {
    const end = sql.indexOf("*/", at + 2);
    return end === -1 ? sql.length : end + 2;
  }
  const closer =
    char === "'"
      ? "'"
      : char === '"'
        ? '"'
        : char === "`"
          ? "`"
          : char === "["
            ? "]"
            : null;
  if (closer === null) return null;
  let cursor = at + 1;
  while (cursor < sql.length) {
    if (sql[cursor] !== closer) {
      cursor += 1;
      continue;
    }
    // Doubling is SQLite's only escape inside a quoted token; `]` has none.
    if (closer !== "]" && sql[cursor + 1] === closer) {
      cursor += 2;
      continue;
    }
    return cursor + 1;
  }
  return sql.length;
}
