// Storage — what the bytes cost and where they are (v4 handoff §12).
//
// EVERY NUMBER HERE IS READ, NEVER INVENTED. Two sources, and the screen is
// explicit about which is speaking:
//
//   * the ROLLUP (issue #711) — `blob.custody_rollup`, computed by the
//     gateway's standing blob sweep over the WHOLE library and read by
//     queries/storage.ts. It answers where the originals are and how much of
//     the local tier is provably safe to release. Until the sweep has run
//     there is nothing to report, and this screen will not guess.
//   * the LOADED WINDOW — the rows this app happens to hold. It is the only
//     thing that can speak about the trash, and it says which window it means,
//     with its exact size; rows with no recorded size are counted and named,
//     so a total smaller than the truth is never presented as the truth.
//
// WHAT IS NOT HERE, AND WHY. The prototype's Storage tab also carries a backup
// POLICY block (Wi-Fi only, metered, roaming, charging) and a "Back up now"
// control. Both belong to the origin seat's upload queue — radios and a
// transfer engine this seat has neither of — and neither is readable nor
// writable through this app's granted surface. A switch that reported nothing
// and moved nothing would be a lie with a hit target, so the block is absent
// rather than decorative.
//
// NO FILLED ELEMENT LIVES HERE. The frame's app bar already carries the one
// filled ink control in the view (§18), so the single action on this screen —
// the way to the trash, which is the only thing on this seat that actually
// frees bytes — is an outlined control.
import { assetBytes } from "../format.ts";
import { fmtBytes } from "../kit.ts";
import { custodyHealth, freeUpIsOfferable } from "../storage-model.ts";
import type { CustodyFacts, Totals } from "../storage-model.ts";
import type { Asset } from "../types.ts";
import { STORAGE_COPY } from "../view-copy.ts";

import styles from "./Storage.module.css";

/** The screen's window-scoped numbers, derived from the loaded rows alone. */
export interface StorageFacts {
  /** How many photographs these numbers cover. */
  shown: number;
  /** Older photographs exist beyond the loaded window. */
  truncated: boolean;
  /** Bytes across the rows that recorded a size. */
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

/**
 * A section head, with the numbers it introduces in its META slot (proto
 * 4357/4364/4371 — `sectionBlock(label, meta)`).
 *
 * The two big `.figure` displays this replaced were not in the prototype at
 * all, and they were the wrong object for the screen: Storage answers "is it
 * safe, and what would freeing space cost me?", and a 31px total answers
 * neither. Every number on this screen now sits where it belongs — beside the
 * row or the section it describes, in the numeric register.
 */
function Head({ label, meta }: { label: string; meta?: string }) {
  return (
    <h2 className={styles.head}>
      <span className={styles.headLabel}>{label}</span>
      {meta ? <span className={styles.headMeta}>{meta}</span> : null}
    </h2>
  );
}

/** One ruled row: what it is on the leading edge, its count on the trailing. */
function Row({ label, totals }: { label: string; totals: Totals }) {
  return (
    <div className={styles.row}>
      <dt className={styles.rowLabel}>{label}</dt>
      <dd className={styles.rowValue}>
        {totals.count} · {fmtBytes(totals.bytes, "—")}
      </dd>
    </div>
  );
}

/** The custody buckets in severity order, worst last — a reader scanning down
 *  ends on the thing that needs them, not on the thing that is fine. */
const CUSTODY_ORDER = [
  "replicated",
  "remote-only",
  "pending-offsite",
  "local-only",
  "missing",
] as const;

/**
 * The count the health sentence is about. Each verdict names exactly one
 * bucket, so the sentence and the number can never drift apart; `unknown` and
 * `held` take no number at all and are handled before this is called.
 */
function healthCount(
  custody: CustodyFacts,
  health: "missing" | "only-here" | "waiting"
): number {
  if (health === "missing") return custody.missing.count;
  if (health === "only-here") return custody.onlyHere.count;
  return custody.waiting.count;
}

/**
 * Backup health: one verdict, one sentence, both derived from the rollup.
 *
 * `null` is a THIRD state, not a zero: the read has not landed. Saying
 * "nobody has counted your originals" then would be an answer this screen does
 * not have yet, and the member would read it as a finding.
 */
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
      <Head
        label={STORAGE_COPY.healthHead}
        meta={STORAGE_COPY.healthMeta[health]}
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

/** Where the originals are — the whole library, not the loaded window. */
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
            />
          )
        )}
      </dl>
    </>
  );
}

/**
 * The free-up statement. It describes a release that is possible, not a
 * control that performs one — see the file header. The unproven remainder is
 * printed BESIDE the offer, because "what is not on the table" is the part a
 * reader needs in order to trust the part that is.
 */
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
  /** The whole-library rollup, or null until the read lands. */
  custody: CustodyFacts | null;
  onOpenTrash: () => void;
}) {
  return (
    <div className={styles.view}>
      <p className={styles.lede}>{STORAGE_COPY.lede}</p>

      <Health custody={custody} />

      {/* Both of these are statements ABOUT the counted library. With nothing
          counted they would be statements about nothing, so they are absent
          rather than zeroed — the health block above has already said why. */}
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
