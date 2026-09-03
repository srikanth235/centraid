/**
 * THE SHAPE of the golden year-3 artifact (#927 P4): its declared
 * distributions, its profile type, the SQLite seams the seeder writes through,
 * and the search needles it plants.
 *
 * Types and constants only — no statements, no I/O. It exists so that
 * `year3-vault.ts` (identity, profile, content-addressed cache) and
 * `year3-distributions.ts` (the distribution seeding) can both depend on the
 * vocabulary without depending on each other; a cycle between those two is
 * what this module was extracted to break. Everything here is re-exported by
 * `./year3-vault`, which stays the one public subpath.
 */
import type { SQLInputValue } from "node:sqlite";

/**
 * THE GOLDEN YEAR-3 DISTRIBUTIONS (#927 P4).
 *
 * A count is not a distribution. `parties: 5_000` says how many rows exist; it
 * says nothing about whether any note body crosses the previous 64 KiB default
 * (or the entity's declared ceiling), whether anyone has been granted anything, or whether the audit band
 * holds enough history for a retention or "last used" query to have an answer.
 * Every field here is DECLARED, not measured — the fixture states the shape of
 * the owner's third year, and the rigs measure against it. Changing a number
 * here changes what "year-3 volume" means repo-wide, so it moves with
 * `tests/experience-budgets/README.md`'s year-3 table and a version bump.
 */
export interface Year3Distributions {
  /** `knowledge_note` rows. README year-3 table: Notes = 1,000. */
  readonly notes: number;
  /**
   * Share of note bodies whose canonical `core_content_item.content_uri`
   * exceeds the previous default text ceiling (64 KiB). The content entity now
   * declares a 1 MiB ceiling, so these rows preserve the before/after corpus
   * shape while riding eagerly in the current replica.
   */
  readonly longNoteShare: number;
  readonly longNoteMinBytes: number;
  readonly longNoteMaxBytes: number;
  /** Automations with durable ledger state. README year-3 table: 200. */
  readonly automations: number;
  /**
   * Calendar days carrying one `core_event` each, from `multiYearStart`:
   * 2023 + 2024 (leap) + 2025. `large-vault.scale.test.ts` reads exactly the
   * 2025 window off this, which is why it is a DAY count rather than a row
   * count — a year of it has to be a year.
   */
  readonly eventDays: number;
  /**
   * Vaults mounted on one gateway. README year-3 table: 5 — the auto-founded
   * `Personal` vault plus four a household adds (#603). ONE FILE per vault
   * (#916), so this is five directories, not five tables.
   */
  readonly mountedVaults: number;
  /**
   * People holding a LIVE `share_party_vault_binding` and a standing
   * `share_authority` row — the audience side of every share journey.
   */
  readonly grantees: number;
  /** Of those grantees, how many are reached through a circle principal. */
  readonly granteeCircles: number;
  /** Days of `access_receipt` history, ending at the fixture's last day. */
  readonly receiptDays: number;
  /**
   * Rows a phone's replica holds after a full bootstrap. README year-3 table:
   * 50,000.
   *
   * Seeded as `schedule.task` rows, because that is the shape the two rigs
   * that own this dimension (`replica-bootstrap`, `replica-reconnect`) walk
   * through the gateway's bootstrap route, and it is the ceiling
   * `year3-replica.ts` builds the phone's file up to. The daily-path corpus
   * alone does not reach 50,000 mirrorable rows, and padding it with photos
   * nobody declared would be inventing a number.
   */
  readonly replicaRows: number;
  /**
   * Photo assets on the DAILY-USE path, as distinct from the 90,000 the
   * library holds in total (`year3VaultProfile().photos`). README year-3
   * table: 10,000.
   */
  readonly dailyPathPhotos: number;
}

export interface Year3VaultProfile {
  readonly seed: number;
  readonly generatedAt: string;
  readonly parties: number;
  readonly photos: number;
  readonly conversations: number;
  readonly turnsPerConversation: number;
  readonly multiYearStart: string;
  readonly sealedSentinels: Readonly<Record<string, string>>;
  readonly parkedActions: readonly string[];
  /**
   * Present ONLY on the golden artifact (`goldenYear3Profile`). The plain
   * `year3VaultProfile()` deliberately leaves it undefined so the rigs that
   * spread it for one axis — `photos-timeline`, `restore-10gib` — keep seeding
   * exactly what they seeded before; a rig opts into the full year-3
   * distribution by mounting the golden vault, never by accident.
   */
  readonly distributions?: Year3Distributions;
}

export const YEAR3_DISTRIBUTIONS: Year3Distributions = {
  notes: 1_000,
  longNoteShare: 0.03,
  longNoteMinBytes: 64 * 1_024 + 1,
  longNoteMaxBytes: 256 * 1_024,
  automations: 200,
  eventDays: 365 + 366 + 365,
  mountedVaults: 5,
  grantees: 12,
  granteeCircles: 1,
  receiptDays: 365,
  replicaRows: 50_000,
  dailyPathPhotos: 10_000,
};

/**
 * Needles the golden vault plants so a rig can prove a search reaches ONE row
 * at year-3 volume without seeding its own corpus beside the fixture. Both are
 * nonsense tokens: they cannot collide with generated text.
 */
export const YEAR3_CONTACT_NEEDLE = "NeedleContact";
export const YEAR3_NOTE_NEEDLE = "needlebrief";
/**
 * Index of the note whose body carries {@link YEAR3_NOTE_NEEDLE}, taken modulo
 * the seeded count — a shrunken fixture still plants exactly one needle, which
 * is what lets the kit's own suite assert the property at unit-test volume.
 */
export const YEAR3_NOTE_NEEDLE_INDEX = 777;
/** Index of the party whose display name is {@link YEAR3_CONTACT_NEEDLE}; modulo as above. */
export const YEAR3_CONTACT_NEEDLE_INDEX = 4_321;

interface Statement {
  get: (...values: SQLInputValue[]) => unknown;
  run: (...values: SQLInputValue[]) => unknown;
}

export interface Year3Sqlite {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
}

export interface Year3VaultTarget {
  /** The ONE file (#916): ontology, audit and ledger bands share this handle. */
  readonly vault: Year3Sqlite;
  readonly sealCell: (
    entity: string,
    column: string,
    rowId: string,
    plaintext: string
  ) => string;
}

export interface Year3SeedCounts {
  readonly parties: number;
  readonly photos: number;
  readonly conversations: number;
  readonly turnsPerConversation: number;
  /**
   * Opt-in. Absent = the version-1 axes only, which is what every caller that
   * passes a hand-written count object (the quality lane, `import-routes`, the
   * perf rig) wants: a handful of rows, not a year of receipts.
   */
  readonly distributions?: Year3Distributions;
}
