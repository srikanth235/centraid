import { fmtBytes } from "@centraid/design/elements";

// Storage (v4 handoff §12). EVERY NUMBER HERE IS READ, NEVER INVENTED, from
// two sources the screen names apart: the whole-library ROLLUP (#711,
// `blob.custody_rollup`, silent until the sweep has run) and the LOADED
// WINDOW, which alone can speak about the trash. No backup-policy block and no
// "Back up now" — neither is readable or writable through this seat's grant.
// No filled control either: the app bar owns the view's one filled ink (§18).
import { assetBytes } from "../format.ts";
import { custodyHealth, freeUpIsOfferable } from "../storage-model.ts";
import type { CustodyFacts, Totals } from "../storage-model.ts";
import type { Asset } from "../types.ts";
import { STORAGE_COPY } from "../view-copy.ts";

import styles from "./Storage.module.css";

export interface StorageFacts {
  shown: number;
  truncated: boolean;
  bytes: number;
  /** Rows with no recorded size — the reason `bytes` is a floor, not a total. */
  unsized: number;
  trashCount: number;
  trashBytes: number;
}

export function storageFacts(
  assets: readonly Asset[],
  trash: readonly Asset[],
  truncated: boolean
): StorageFacts {
  let bytes = 0;
  let unsized = 0;
  for (const asset of assets) {
    const size = assetBytes(asset);
    if (size == null) unsized += 1;
    else bytes += size;
  }
  let trashBytes = 0;
  for (const asset of trash) trashBytes += assetBytes(asset) ?? 0;
  return {
    shown: assets.length,
    truncated,
    bytes,
    unsized,
    trashCount: trash.length,
    trashBytes,
  };
}

function Head({
  label,
  meta,
  pending,
}: {
  label: string;
  meta?: string;
  pending?: boolean;
}) {
  return (
    <h2 className={styles.head}>
      <span className={styles.headLabel}>{label}</span>
      {meta ? (
        <span
          className={`${styles.headMeta} ${pending ? styles.pending : ""}`.trim()}
        >
          {meta}
        </span>
      ) : null}
    </h2>
  );
}

function Row({
  label,
  totals,
  pending,
}: {
  label: string;
  totals: Totals;
  pending?: boolean;
}) {
  return (
    <div className={styles.row}>
      <dt className={styles.rowLabel}>{label}</dt>
      <dd
        className={`${styles.rowValue} ${pending ? styles.pending : ""}`.trim()}
      >
        {totals.count} · {fmtBytes(totals.bytes, "—")}
      </dd>
    </div>
  );
}

/** Severity order, worst last: a reader scanning down ends on what needs them. */
const CUSTODY_ORDER = [
  "replicated",
  "remote-only",
  "pending-offsite",
  "local-only",
  "missing",
] as const;

/** `unknown` and `held` take no number and are handled before this is called. */
function healthCount(
  custody: CustodyFacts,
  health: "missing" | "only-here" | "waiting"
): number {
  if (health === "missing") return custody.missing.count;
  if (health === "only-here") return custody.onlyHere.count;
  return custody.waiting.count;
}

/** `null` is a THIRD state, not a zero: the read has not landed, and a member
 *  would read a count of nothing as a finding. */
function Health({ custody }: { custody: CustodyFacts | null }) {
  if (!custody) {
    return (
      <>
        <Head label={STORAGE_COPY.healthHead} />
        <p className={styles.note}>{STORAGE_COPY.healthPending}</p>
      </>
    );
  }
  const health = custodyHealth(custody);
  return (
    <>
      {/* `waiting` is queued, not wrong — `--seam` is that role (#765). */}
      <Head
        label={STORAGE_COPY.healthHead}
        meta={STORAGE_COPY.healthMeta[health]}
        pending={health === "waiting"}
      />
      <p className={styles.note}>
        {health === "unknown" || health === "held"
          ? STORAGE_COPY.healthLine[health]
          : STORAGE_COPY.healthLine[health](healthCount(custody, health))}
      </p>
      {custody.checkedAt ? (
        <p className={styles.note}>
          {STORAGE_COPY.checkedAt(
            new Date(custody.checkedAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          )}
        </p>
      ) : null}
      {custody.unread.length > 0 ? (
        <p className={styles.note}>
          {STORAGE_COPY.unreadScopes(custody.unread)}
        </p>
      ) : null}
      {custody.uncounted.length > 0 ? (
        <p className={styles.note}>
          {STORAGE_COPY.uncountedScopes(custody.uncounted)}
        </p>
      ) : null}
    </>
  );
}

/** The whole library, not the loaded window. */
function WhereTheOriginalsAre({ custody }: { custody: CustodyFacts }) {
  const totalsOf: Record<(typeof CUSTODY_ORDER)[number], Totals> = {
    replicated: custody.backedUp,
    "remote-only": custody.elsewhere,
    "pending-offsite": custody.waiting,
    "local-only": custody.onlyHere,
    missing: custody.missing,
  };
  return (
    <>
      <Head
        label={STORAGE_COPY.custodyHead}
        meta={STORAGE_COPY.libraryMeta(
          custody.library.count,
          fmtBytes(custody.library.bytes, "—")
        )}
      />
      <dl className={styles.rows}>
        {CUSTODY_ORDER.filter((bucket) => totalsOf[bucket].count > 0).map(
          (bucket) => (
            <Row
              key={bucket}
              label={STORAGE_COPY.custodyRow[bucket]}
              totals={totalsOf[bucket]}
              pending={bucket === "pending-offsite"}
            />
          )
        )}
      </dl>
    </>
  );
}

/** A statement, not a control: the unproven remainder prints beside the offer. */
function FreeUp({ custody }: { custody: CustodyFacts }) {
  return (
    <>
      <Head label={STORAGE_COPY.freeUpHead} />
      {freeUpIsOfferable(custody) ? (
        <>
          <p className={styles.claim}>
            {STORAGE_COPY.freeUpTitle(fmtBytes(custody.freeable.bytes, "—"))}
          </p>
          <p className={styles.note}>
            {STORAGE_COPY.freeUpBody(custody.freeable.count)}
          </p>
          <p className={styles.note}>{STORAGE_COPY.freeUpWhere}</p>
        </>
      ) : (
        <p className={styles.note}>{STORAGE_COPY.freeUpNothing}</p>
      )}
      {custody.unproven.count > 0 ? (
        <p className={styles.note}>
          {STORAGE_COPY.freeUpUnproven(
            custody.unproven.count,
            fmtBytes(custody.unproven.bytes, "—")
          )}
        </p>
      ) : null}
    </>
  );
}

export function StorageView({
  facts,
  custody,
  onOpenTrash,
}: {
  facts: StorageFacts;
  custody: CustodyFacts | null;
  onOpenTrash: () => void;
}) {
  return (
    <div className={styles.view}>
      <p className={styles.lede}>{STORAGE_COPY.lede}</p>

      <Health custody={custody} />

      {/* Absent rather than zeroed: with nothing counted these say nothing. */}
      {custody?.known ? (
        <>
          <WhereTheOriginalsAre custody={custody} />
          <FreeUp custody={custody} />
        </>
      ) : null}

      <Head
        label={STORAGE_COPY.spaceHead}
        meta={STORAGE_COPY.spaceMeta(facts.shown, fmtBytes(facts.bytes, "—"))}
      />
      <p className={styles.note}>
        {facts.truncated
          ? STORAGE_COPY.windowNote(facts.shown)
          : STORAGE_COPY.wholeNote}
      </p>
      {facts.unsized > 0 ? (
        <p className={styles.note}>
          <span className={styles.num}>{facts.unsized}</span>{" "}
          {facts.unsized === 1 ? "photograph has" : "photographs have"} no
          recorded size. {STORAGE_COPY.sizeAbsent}
        </p>
      ) : null}

      <Head
        label={STORAGE_COPY.trashHead}
        {...(facts.trashCount > 0
          ? {
              meta: STORAGE_COPY.spaceMeta(
                facts.trashCount,
                fmtBytes(facts.trashBytes, "an unrecorded size")
              ),
            }
          : {})}
      />
      {facts.trashCount === 0 ? (
        <p className={styles.note}>{STORAGE_COPY.trashEmpty}</p>
      ) : (
        <>
          <p className={styles.note}>
            <span className={styles.num}>{facts.trashCount}</span>{" "}
            {facts.trashCount === 1 ? "photograph is" : "photographs are"} in
            the trash, holding{" "}
            <span className={styles.num}>
              {fmtBytes(facts.trashBytes, "an unrecorded size")}
            </span>
            . {STORAGE_COPY.trashNote}
          </p>
          <button type="button" className="kit-btn" onClick={onOpenTrash}>
            Open the trash
          </button>
        </>
      )}
    </div>
  );
}
