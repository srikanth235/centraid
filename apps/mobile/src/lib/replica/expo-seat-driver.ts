import { bundledExtensions, openDatabaseSync } from "expo-sqlite";
import type { SQLiteBindValue, SQLiteDatabase } from "expo-sqlite";

import type {
  SeatBindValue,
  SeatSqliteDriver,
} from "@centraid/client/replica/native";

import { pathToFileUri } from "../../../modules/centraid-storage";
import { keyPragma } from "./expo-sqlite-driver";
import { ReplicaFts5UnavailableError } from "./replica-fts5-error";
import { ReplicaSqliteVecUnavailableError } from "./replica-sqlite-vec-error";
import { ReplicaSqliteVecVersionError } from "./replica-sqlite-vec-version-error";
import {
  asReplicaStorageError,
  isReplicaStorageFullError,
} from "./replica-storage-error";
import { EXPECTED_SQLITE_VEC_VERSION } from "./sqlite-vec-version";

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
    let handle: SQLiteDatabase;
    try {
      const db = openDatabaseSync(
        options.name,
        options.useNewConnection === true ? { useNewConnection: true } : {},
        // A URI, NOT A PATH, and the seat's copy depends on it (#996 follow-up).
        //
        // expo-sqlite joins this directory with the name and hands the string
        // to the native module, which resolves it with `URL(string:)` on iOS.
        // A plain path is not a URL: it parses SCHEMELESS, so `toFilePath()`
        // returns `absoluteString` — the percent-ENCODED string — and the seat
        // opened `Library/Application%20Support/CentraidReplica/…`, a second
        // empty file one directory over from the one the bootstrap installs
        // through expo-file-system. Every handler's SQL then answered
        // `no such table`, on a phone holding a complete copy.
        //
        // `file://` makes it a file URL on both hosts: iOS decodes it back to
        // the real path, and Android's `Uri.path` does the same. The space is
        // encoded here rather than left raw so the string is a valid URL by
        // construction instead of by the platform's leniency.
        options.location === undefined
          ? undefined
          : encodeURI(pathToFileUri(options.location))
      );
      // The key is the first statement on the handle, before any PRAGMA the
      // seat's own open block runs — those are writes.
      if (options.key !== undefined) db.execSync(keyPragma(options.key));
      handle = db;
    } catch (error) {
      throw asReplicaStorageError(error);
    }
    // THE EXTENSION IS PER-CONNECTION, NOT PER-BUILD (#1011).
    // `withSQLiteVecExtension: true` only puts `vec.framework` in the bundle
    // and its path in `bundledExtensions`; expo-sqlite loads NOTHING on its
    // own, so every handle that wants `vec0` has to ask, once, right here.
    // Without this call `vec_version()` is `no such function` on a phone whose
    // build is perfectly correct — which is how the capability probe below
    // came to condemn every shell this repo ships.
    loadBundledSqliteVec(handle);
    // OUTSIDE the storage-error wrapper on purpose: a missing extension is a
    // BUILD fault with a named fix, and `asReplicaStorageError` would flatten
    // it into the taxonomy the disk-full path uses.
    assertSeatCapabilities(handle);
    return new ExpoSeatDriver(handle);
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
 * Ask this handle to load the sqlite-vec the build bundled.
 *
 * Silent on failure BY DESIGN: whether the extension is actually usable is
 * `assertSeatCapabilities`'s question, asked of `vec0` and `vec_version()`
 * immediately after, and it names the fix. A loader that threw its own error
 * here would answer that question with a different, worse sentence.
 */
function loadBundledSqliteVec(db: SQLiteDatabase): void {
  const extension = bundledExtensions["sqlite-vec"];
  if (!extension) return;
  try {
    db.loadExtensionSync(extension.libPath, extension.entryPoint);
  } catch {
    /* the probe below decides */
  }
}

/**
 * THE TWO EXTENSIONS A SEAT CANNOT OPEN WITHOUT, PROBED TOGETHER.
 *
 * Offline search on the phone is two lanes over this one file: keyword
 * through the snapshot's fts5 shadow tables, and people / similar faces
 * through `vec_distance_cosine` over the face vectors replicated in
 * `enrich_embedding`. Neither extension is auto-loaded by a flag alone — the
 * build has to have compiled it in (`enableFTS`, `withSQLiteVecExtension` in
 * `apps/mobile/app.config.ts`, plus the iOS framework the shell script
 * builds) — and a shell that missed one opens perfectly well and then answers
 * `no such module` from inside a member's search.
 *
 * fts5 is the harder failure of the two: the sanitised snapshot's only
 * surviving triggers are its FTS sync triggers, so a build without it cannot
 * even open the file. Both are asked here anyway, at open, in the same shape,
 * because "which half of search is missing" is not a question to answer from
 * a crash report.
 *
 * The probes are `temp.` tables: nothing is written to the seat file, so this
 * runs identically against a fresh copy and one that is mid-catch-up.
 */
function assertSeatCapabilities(db: SQLiteDatabase): void {
  try {
    db.execSync(
      "CREATE VIRTUAL TABLE IF NOT EXISTS temp.__fts5_probe USING fts5(x)"
    );
    db.execSync("DROP TABLE IF EXISTS temp.__fts5_probe");
  } catch (error) {
    if (isReplicaStorageFullError(error)) throw asReplicaStorageError(error);
    throw new ReplicaFts5UnavailableError();
  }
  let version: string;
  try {
    // The vector width is NOT pinned here. The gateway decides what dimension
    // a face vector has (SFace was 128, ArcFace is 512) and the phone stores
    // whatever replicates; `float[1]` is a probe table, discarded before any
    // real vector is touched, and every real query carries the row's own
    // `dim` the way `packages/vault/src/enrich/similarity.ts` does.
    db.execSync(
      "CREATE VIRTUAL TABLE IF NOT EXISTS temp.__sqlite_vec_probe USING vec0(x float[1])"
    );
    db.execSync("DROP TABLE IF EXISTS temp.__sqlite_vec_probe");
    version = String(
      db.getFirstSync<{ version: string }>("SELECT vec_version() AS version")
        ?.version ?? ""
    );
  } catch (error) {
    if (isReplicaStorageFullError(error)) throw asReplicaStorageError(error);
    throw new ReplicaSqliteVecUnavailableError();
  }
  if (version !== EXPECTED_SQLITE_VEC_VERSION)
    throw new ReplicaSqliteVecVersionError(version);
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
