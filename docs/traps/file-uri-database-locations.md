# Trap — a SQLite directory handed to expo-sqlite as a PATH

**Area:** `apps/mobile/src/lib/replica/expo-sqlite-driver.ts`, `apps/mobile/src/lib/replica/expo-seat-driver.ts`, `apps/mobile/src/lib/upload/legacy-db-location.ts`.

## The footgun

`openDatabaseSync(name, options, directory)` joins `directory` with `name` and hands the string to the native module. On iOS that string is resolved with `URL(string:)`. **A plain filesystem path has no scheme**, so it parses as an opaque URL and `toFilePath()` returns its `absoluteString` — the percent-ENCODED text.

The app's durable directory is under `Library/Application Support`, which contains a space. So a path passed raw opens

```
…/Library/Application%20Support/CentraidReplica/<name>
```

a **real, different directory** that iOS then creates. Nothing errors. You get a second, empty database one directory over from the one every other API (`expo-file-system`, the native storage module, the sizer) uses.

Symptoms, both seen in production:

- the seat answered `no such table` on a phone holding a complete copy (#996);
- the durable upload queue was invisible to whichever entry point had opened the other spelling, so queued uploads sat forever (#1014, R19).

## The rule

Pass a **file URI**, always, and build it by construction rather than trusting the platform's leniency:

```ts
options.location === undefined
  ? undefined
  : encodeURI(pathToFileUri(options.location));
```

`pathToFileUri` (`apps/mobile/modules/centraid-storage`) prefixes `file://`; `encodeURI` escapes the space. iOS decodes it back to the real path and Android's `Uri.path` does the same.

## When you fix one of these

The file at the encoded spelling is real data. A source-of-truth ledger — the upload queue holds unreplicated bytes a member is still waiting on — must be **moved**, not abandoned: `planLegacyDatabaseMove` names the file and its WAL sidecars, and refuses when a database already exists at the correct path (overwriting it would lose newer rows). A derived store may simply be rebuilt.

## How to check

`grep -rn "openDatabaseSync" apps/mobile/src` — every call's third argument must be a `file://` URI, or `undefined`.
