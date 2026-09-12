//! THE TALLY AXIS OF YEAR-3 VOLUME (#1020, D-1020-D3-7).
//!
//! **The gap this fills.** v0's year-3 generator
//! (`packages/test-kit/src/year3-vault.ts`) writes one `social_circle` and one
//! `tally_group` and **no `tally_expense`, `tally_expense_split` or
//! `tally_settlement` rows at all** (#1020 apps §5.2). So Tally's stated
//! ceilings — the 2,000-expense window, the 8,000-split fan-out — have no
//! golden artifact behind them; the one number on record (188 ms) came from an
//! ad-hoc seeding in the #922 spike on a Node host over node-sqlite, which is
//! why #1020 calls the platform move a structural decision and not a measured
//! one. A ceiling nobody can seed is a ceiling nobody can hold.
//!
//! **What the generator promises.** Determinism by construction, in v0's own
//! style (`year3-vault.ts:33-40`): a date is `start + index days`, an id is
//! `prefix-000000` zero-padded to six, and every choice comes from one seeded
//! integer stream — no clock, no `rand`, no hashing of pointers. Two runs of
//! the same seed produce byte-identical rows, because "a fixture that is not
//! byte-reproducible is not an artifact"
//! (`packages/test-kit/src/year3-distributions.ts:267`).
//!
//! **A count is not a distribution** (`year3-shape.ts:18-25`): every field of
//! [`Year3TallyShape`] is *declared*, and changing one changes what year-3
//! Tally volume means repo-wide, so it moves with the journey ledger's year-3
//! table and a version bump.
//!
//! **Where the rows go, today and later.** Today the generator writes through
//! the connection it is handed, because `crates/vault`'s command path does not
//! exist yet (lane D1). The row *values* are the ones the commands produce —
//! resolved splits that sum to the amount, a full payer set including the
//! degenerate single-payer row, a group-scoped currency every expense in it
//! agrees with — so the same generator re-points at `Vault::invoke` without the
//! fixture changing.
//!
//! **It creates no tables.** The caller hands it a connection that already
//! carries the model, which in practice means
//! [`crate::contract_vault::open_contract_vault`] over
//! `contracts/schema/vault-ddl.sql`. A generator that created its own tables
//! would be a second copy of the schema, and the second copy is always the one
//! that is missing a column — this generator had exactly that bug, and the
//! year-3 measurement is what found it.

use rusqlite::Connection;

use crate::error::{KitError, KitResult};

/// The declared shape of year-3 Tally volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3TallyShape {
    /// The window `loadTally` reads in one page (`LEDGER_ROWS` in v0).
    pub expenses: usize,
    pub groups: usize,
    /// Parties other than the owner.
    pub parties: usize,
    /// Members seeded into each group, owner included.
    pub members_per_group: usize,
    /// Sharers on each expense, so splits are `expenses * this`.
    pub sharers_per_expense: usize,
    /// One expense in this many has two payers rather than one.
    pub multi_payer_every: usize,
    /// One expense in this many is trashed (`deleted_at IS NOT NULL`).
    pub trashed_every: usize,
    /// Settlements, spread over the groups.
    pub settlements: usize,
    /// Recurring templates.
    pub recurring: usize,
    /// The currencies groups cycle through.
    pub currencies: [&'static str; 3],
    /// The first day of the ledger; every later date is this plus N days.
    pub start: &'static str,
}

/// The year-3 Tally profile: 2,000 expenses over 40 groups, 200 parties and
/// three currencies, which is the volume Tally's ceiling is stated at.
pub const YEAR3_TALLY: Year3TallyShape = Year3TallyShape {
    expenses: 2_000,
    groups: 40,
    parties: 200,
    members_per_group: 6,
    // 4 sharers × 2,000 expenses is 8,000 split rows — exactly `LEDGER_FAN_OUT`
    // (1,000 × 8), so the profile sits ON the ceiling rather than under it.
    sharers_per_expense: 4,
    multi_payer_every: 7,
    trashed_every: 50,
    settlements: 300,
    recurring: 60,
    currencies: ["USD", "EUR", "JPY"],
    start: "2023-01-01",
};

/// v0's seed, so a Rust fixture and a TypeScript one can be compared at all
/// (`year3-vault.ts:20`).
pub const YEAR3_DEFAULT_SEED: u64 = 679_003;

/// What one run seeded, for the receipt and the journey ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3TallyCounts {
    pub parties: usize,
    pub groups: usize,
    pub expenses: usize,
    pub live_expenses: usize,
    pub splits: usize,
    pub payers: usize,
    pub settlements: usize,
    pub recurring: usize,
}

/// A seeded integer stream. Deliberately a named, tiny LCG rather than a crate:
/// the fixture's value is that its bytes never move, and a dependency that
/// changes its algorithm in a patch release would move them.
struct Seeded(u64);

impl Seeded {
    fn new(seed: u64) -> Self {
        // Odd, non-zero state; the constant is Knuth's MMIX multiplier.
        Self(seed.wrapping_mul(2).wrapping_add(1))
    }

    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        // The high bits of an LCG are the good ones.
        self.0 >> 16
    }

    fn upto(&mut self, bound: usize) -> usize {
        if bound == 0 {
            return 0;
        }
        usize::try_from(self.next() % bound as u64).expect("a bound is a usize")
    }
}

/// `prefix-000000`, zero-padded to six as v0 pads (`year3-vault.ts:38`).
fn id(prefix: &str, index: usize) -> String {
    format!("{prefix}-{index:06}")
}

/// `start + index days`, as a `YYYY-MM-DD` civil date.
///
/// Dates in this ledger are **lexicographic `YYYY-MM-DD` strings** and every
/// comparison in Tally is a string comparison (#1020, apps seam 5), so the
/// arithmetic happens here once and produces text everywhere else.
fn day(start: &str, index: usize) -> String {
    let (mut year, mut month, mut day) = parse_day(start);
    for _ in 0..index {
        let length = month_length(year, month);
        if day < length {
            day += 1;
        } else if month < 12 {
            day = 1;
            month += 1;
        } else {
            day = 1;
            month = 1;
            year += 1;
        }
    }
    format!("{year:04}-{month:02}-{day:02}")
}

fn parse_day(text: &str) -> (u32, u32, u32) {
    let mut parts = text.split('-');
    let year = parts
        .next()
        .and_then(|part| part.parse().ok())
        .unwrap_or(2023);
    let month = parts.next().and_then(|part| part.parse().ok()).unwrap_or(1);
    let day = parts.next().and_then(|part| part.parse().ok()).unwrap_or(1);
    (year, month, day)
}

const fn month_length(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        // The proleptic Gregorian rule, stated rather than assumed: the ledger
        // spans 2023-2026 and a leap year inside it must not shift every later
        // date by one.
        _ if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        _ => 28,
    }
}

/// The owner's party id in a generated fixture. Fixed, because the owner is the
/// one party every fold reads by name.
pub const YEAR3_OWNER_PARTY: &str = "party-000000";

/// The categories the DDL's CHECK admits, in a stable order.
const CATEGORIES: [&str; 9] = [
    "food",
    "groceries",
    "rent",
    "utilities",
    "transport",
    "fun",
    "travel",
    "shopping",
    "general",
];

const ICONS: [&str; 4] = ["🏠", "✈️", "🍽️", "🧾"];

/// Seed the Tally axis of year-3 volume into `connection`.
///
/// The whole run is one transaction, as v0's seeder is
/// (`year3-vault.ts:66`): a half-seeded ledger is not a smaller fixture, it is
/// a ledger whose balances do not reconcile.
pub fn year3_tally(
    connection: &Connection,
    shape: Year3TallyShape,
    seed: u64,
) -> KitResult<Year3TallyCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    connection.execute_batch("BEGIN IMMEDIATE").map_err(door)?;
    let counts = seed_ledger(connection, shape, seed);
    match counts {
        Ok(counts) => {
            connection.execute_batch("COMMIT").map_err(door)?;
            Ok(counts)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one generator, one reading order: parties, groups, the ledger, the \
              settlements. Splitting it would hide the id and date arithmetic \
              from the rows it keys, which is the only thing that has to agree."
)]
fn seed_ledger(
    connection: &Connection,
    shape: Year3TallyShape,
    seed: u64,
) -> KitResult<Year3TallyCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let mut random = Seeded::new(seed);
    let start = shape.start;
    let created = format!("{}T00:00:00.000Z", day(start, 0));

    // --- parties. Index 0 is the owner; the rest are friends on the roster.
    let mut insert_party = connection
        .prepare(
            "INSERT INTO core_party (party_id, kind, display_name, sort_name, created_at)
             VALUES (?, 'person', ?, ?, ?)",
        )
        .map_err(door)?;
    let mut insert_friend = connection
        .prepare("INSERT INTO tally_friend (friend_id, party_id, created_at) VALUES (?, ?, ?)")
        .map_err(door)?;
    for index in 0..=shape.parties {
        let party = id("party", index);
        let name = if index == 0 {
            "Owner".to_owned()
        } else {
            format!("Friend {index:04}")
        };
        insert_party
            .execute(rusqlite::params![party, name, name, created])
            .map_err(door)?;
        if index > 0 {
            insert_friend
                .execute(rusqlite::params![id("friend", index), party, created])
                .map_err(door)?;
        }
    }
    connection
        .execute(
            "INSERT INTO core_vault
               (vault_id, self_party_id, display_name, status, base_currency, settings_json,
                created_at)
             VALUES (?, ?, 'Year 3', 'active', ?, '{}', ?)",
            rusqlite::params![
                "vault-000000",
                YEAR3_OWNER_PARTY,
                shape.currencies[0],
                created
            ],
        )
        .map_err(door)?;

    // --- groups: a circle, its members, and the group that decorates it.
    let mut insert_circle = connection
        .prepare(
            "INSERT INTO social_circle (circle_id, owner_party_id, name, kind, created_at)
             VALUES (?, ?, ?, 'friends', ?)",
        )
        .map_err(door)?;
    let mut insert_member = connection
        .prepare(
            "INSERT INTO social_circle_member (member_id, circle_id, party_id, added_at)
             VALUES (?, ?, ?, ?)",
        )
        .map_err(door)?;
    let mut insert_group = connection
        .prepare(
            "INSERT INTO tally_group
               (group_id, circle_id, icon, color, simplify_opt_in, currency, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .map_err(door)?;
    // The owner is in every group, then `members_per_group - 1` friends drawn
    // in a rotation rather than at random, so a party's group count is even and
    // a fold over one group is never accidentally the whole roster.
    let mut members: Vec<Vec<String>> = Vec::with_capacity(shape.groups);
    for index in 0..shape.groups {
        let circle = id("circle", index);
        let group = id("group", index);
        insert_circle
            .execute(rusqlite::params![
                circle,
                YEAR3_OWNER_PARTY,
                format!("Group {index:04}"),
                created
            ])
            .map_err(door)?;
        let mut roster = vec![YEAR3_OWNER_PARTY.to_owned()];
        insert_member
            .execute(rusqlite::params![
                id("member", index * shape.members_per_group),
                circle,
                YEAR3_OWNER_PARTY,
                created
            ])
            .map_err(door)?;
        for seat in 1..shape.members_per_group {
            let which = 1 + (index * (shape.members_per_group - 1) + seat - 1) % shape.parties;
            let party = id("party", which);
            insert_member
                .execute(rusqlite::params![
                    id("member", index * shape.members_per_group + seat),
                    circle,
                    party,
                    created
                ])
                .map_err(door)?;
            roster.push(party);
        }
        insert_group
            .execute(rusqlite::params![
                group,
                circle,
                ICONS[index % ICONS.len()],
                "ink",
                i64::from(index % 3 == 0),
                shape.currencies[index % shape.currencies.len()],
                created,
                created
            ])
            .map_err(door)?;
        members.push(roster);
    }

    // --- the ledger. Splits are RESOLVED and sum to the amount, and every
    // expense writes its full payer set including the degenerate single-payer
    // row, because a fold that finds no payer rows is reading an expense the
    // vault never finished writing (#883, ruling O-payers).
    let mut insert_expense = connection
        .prepare(
            "INSERT INTO tally_expense
               (expense_id, group_id, description, amount_minor, currency, paid_by,
                split_method, spent_on, category, created_at, updated_at, deleted_at, purge_at)
             VALUES (?, ?, ?, ?, ?, ?, 'exact', ?, ?, ?, ?, ?, ?)",
        )
        .map_err(door)?;
    let mut insert_split = connection
        .prepare(
            "INSERT INTO tally_expense_split
               (expense_id, party_id, share_minor, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .map_err(door)?;
    let mut insert_payer = connection
        .prepare(
            "INSERT INTO tally_expense_payer
               (expense_id, party_id, paid_minor, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .map_err(door)?;
    let mut splits = 0usize;
    let mut payers = 0usize;
    let mut live = 0usize;
    for index in 0..shape.expenses {
        let expense = id("expense", index);
        let group_index = index % shape.groups;
        let roster = &members[group_index];
        let currency = shape.currencies[group_index % shape.currencies.len()];
        // 5.00 to 500.00 in the currency's own minor units; never zero, because
        // the DDL's CHECK refuses it.
        let amount = 500 + i64::try_from(random.upto(49_500)).expect("a bound is small");
        let spent_on = day(start, index % 1_095);
        let sharers = shape.sharers_per_expense.min(roster.len());
        let payer = roster[random.upto(roster.len())].clone();
        let trashed = index % shape.trashed_every == 0;
        let deleted_at = trashed.then(|| format!("{spent_on}T12:00:00.000Z"));
        let purge_at = deleted_at
            .as_ref()
            .map(|_| format!("{}T12:00:00.000Z", day(start, index % 1_095 + 30)));
        insert_expense
            .execute(rusqlite::params![
                expense,
                id("group", group_index),
                format!("Expense {index:06}"),
                amount,
                currency,
                payer,
                spent_on,
                CATEGORIES[index % CATEGORIES.len()],
                created,
                created,
                deleted_at,
                purge_at
            ])
            .map_err(door)?;
        if !trashed {
            live += 1;
        }
        // The odd penny goes to the PAYER, as `allocateWeighted` places it
        // (`split-model.ts:136-145`): floor per sharer, then the remainder
        // walks payer first.
        let each = amount / i64::try_from(sharers).expect("a small count");
        let mut remainder = amount - each * i64::try_from(sharers).expect("a small count");
        let order: Vec<&String> = std::iter::once(&payer)
            .chain(roster.iter().filter(|party| **party != payer))
            .take(sharers)
            .collect();
        for party in &order {
            let mut share = each;
            if remainder > 0 {
                share += 1;
                remainder -= 1;
            }
            insert_split
                .execute(rusqlite::params![expense, party, share, created, created])
                .map_err(door)?;
            splits += 1;
        }
        // Any remainder left over when the payer is not among the sharers goes
        // on the first sharer, so the splits still sum to the amount exactly.
        if remainder > 0 {
            connection
                .execute(
                    "UPDATE tally_expense_split SET share_minor = share_minor + ?
                      WHERE expense_id = ? AND party_id = ?",
                    rusqlite::params![remainder, expense, order[0]],
                )
                .map_err(door)?;
        }
        if index % shape.multi_payer_every == 0 && roster.len() > 1 {
            let other = roster
                .iter()
                .find(|party| **party != payer)
                .expect("the roster has a second member");
            let first = amount / 2;
            insert_payer
                .execute(rusqlite::params![expense, payer, first, created, created])
                .map_err(door)?;
            insert_payer
                .execute(rusqlite::params![
                    expense,
                    other,
                    amount - first,
                    created,
                    created
                ])
                .map_err(door)?;
            payers += 2;
        } else {
            insert_payer
                .execute(rusqlite::params![expense, payer, amount, created, created])
                .map_err(door)?;
            payers += 1;
        }
    }

    // --- settlements: real cash, in the group's currency.
    let mut insert_settlement = connection
        .prepare(
            "INSERT INTO tally_settlement
               (settlement_id, group_id, from_party, to_party, amount_minor, currency,
                paid_on, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .map_err(door)?;
    for index in 0..shape.settlements {
        let group_index = index % shape.groups;
        let roster = &members[group_index];
        let from = roster[1 + random.upto(roster.len() - 1)].clone();
        insert_settlement
            .execute(rusqlite::params![
                id("settlement", index),
                id("group", group_index),
                from,
                YEAR3_OWNER_PARTY,
                500 + i64::try_from(random.upto(9_500)).expect("a bound is small"),
                shape.currencies[group_index % shape.currencies.len()],
                day(start, index % 1_095),
                created,
                created
            ])
            .map_err(door)?;
    }

    // --- recurring templates, so the template dashboard has a window to read.
    let mut insert_template = connection
        .prepare(
            "INSERT INTO tally_recurring_expense
               (template_id, group_id, description, original_amount_minor, original_currency,
                settlement_currency, paid_by, category, rrule, anchor_start, tz, created_at,
                updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FREQ=MONTHLY', ?, 'Europe/London', ?, ?)",
        )
        .map_err(door)?;
    for index in 0..shape.recurring {
        let group_index = index % shape.groups;
        insert_template
            .execute(rusqlite::params![
                id("template", index),
                id("group", group_index),
                format!("Standing order {index:04}"),
                10_000,
                shape.currencies[group_index % shape.currencies.len()],
                shape.currencies[group_index % shape.currencies.len()],
                YEAR3_OWNER_PARTY,
                "rent",
                format!("{}T09:00:00", day(start, index)),
                created,
                created
            ])
            .map_err(door)?;
    }

    Ok(Year3TallyCounts {
        parties: shape.parties + 1,
        groups: shape.groups,
        expenses: shape.expenses,
        live_expenses: live,
        splits,
        payers,
        settlements: shape.settlements,
        recurring: shape.recurring,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small profile through the same statements, as v0's seeder allows
    /// (`year3-vault.ts:25-27`): scale lanes pass the full profile, PR tests
    /// pass small counts, and there is one code path.
    const SMALL: Year3TallyShape = Year3TallyShape {
        expenses: 60,
        groups: 4,
        parties: 12,
        settlements: 8,
        recurring: 3,
        ..YEAR3_TALLY
    };

    /// The committed schema, as every caller of the generator supplies it.
    fn seeded(shape: Year3TallyShape, seed: u64) -> (Connection, Year3TallyCounts) {
        let ddl = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../contracts/schema/vault-ddl.sql"),
        )
        .expect("the committed DDL is readable");
        let connection =
            crate::contract_vault::open_contract_vault(&ddl, "[]").expect("the model is created");
        let counts = year3_tally(&connection, shape, seed).expect("the ledger seeds");
        (connection, counts)
    }

    #[test]
    fn the_dates_walk_real_months_and_leap_years() {
        assert_eq!(day("2023-01-01", 0), "2023-01-01");
        assert_eq!(day("2023-01-31", 1), "2023-02-01");
        assert_eq!(day("2023-12-31", 1), "2024-01-01");
        // 2024 is a leap year: the 29th exists and the 30th is March.
        assert_eq!(day("2024-02-28", 1), "2024-02-29");
        assert_eq!(day("2024-02-28", 2), "2024-03-01");
        assert_eq!(day("2023-02-28", 1), "2023-03-01");
    }

    #[test]
    fn every_expense_splits_to_exactly_its_amount() {
        let (connection, _) = seeded(SMALL, YEAR3_DEFAULT_SEED);
        let mismatched: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tally_expense e
                  WHERE e.amount_minor <> (SELECT COALESCE(SUM(s.share_minor), 0)
                                             FROM tally_expense_split s
                                            WHERE s.expense_id = e.expense_id)",
                [],
                |row| row.get(0),
            )
            .expect("the reconciliation query runs");
        assert_eq!(
            mismatched, 0,
            "a split set that does not sum is a wrong number"
        );
    }

    #[test]
    fn every_expense_carries_a_payer_set_that_sums_to_its_amount() {
        let (connection, _) = seeded(SMALL, YEAR3_DEFAULT_SEED);
        let mismatched: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tally_expense e
                  WHERE e.amount_minor <> (SELECT COALESCE(SUM(p.paid_minor), 0)
                                             FROM tally_expense_payer p
                                            WHERE p.expense_id = e.expense_id)",
                [],
                |row| row.get(0),
            )
            .expect("the reconciliation query runs");
        assert_eq!(mismatched, 0);
    }

    #[test]
    fn every_expense_agrees_with_its_groups_currency() {
        let (connection, _) = seeded(SMALL, YEAR3_DEFAULT_SEED);
        let wrong: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tally_expense e
                   JOIN tally_group g ON g.group_id = e.group_id
                  WHERE e.currency <> g.currency",
                [],
                |row| row.get(0),
            )
            .expect("the currency query runs");
        assert_eq!(wrong, 0, "a group is one ledger in one money (#916 R1)");
    }

    #[test]
    fn the_same_seed_produces_the_same_bytes() {
        let read = |shape, seed| {
            let (connection, counts) = seeded(shape, seed);
            let rows: Vec<String> = connection
                .prepare(
                    "SELECT expense_id || '|' || amount_minor || '|' || paid_by || '|' || spent_on
                       FROM tally_expense ORDER BY expense_id",
                )
                .expect("the digest query prepares")
                .query_map([], |row| row.get::<_, String>(0))
                .expect("the digest query runs")
                .collect::<Result<Vec<String>, _>>()
                .expect("every row reads");
            (counts, rows)
        };
        let first = read(SMALL, YEAR3_DEFAULT_SEED);
        let again = read(SMALL, YEAR3_DEFAULT_SEED);
        assert_eq!(first, again);
        let other = read(SMALL, YEAR3_DEFAULT_SEED + 1);
        assert_ne!(first.1, other.1, "a different seed is a different ledger");
    }

    #[test]
    fn the_counts_are_the_declared_shape() {
        let (_, counts) = seeded(SMALL, YEAR3_DEFAULT_SEED);
        assert_eq!(counts.expenses, 60);
        assert_eq!(counts.splits, 60 * SMALL.sharers_per_expense);
        assert_eq!(counts.settlements, 8);
        assert_eq!(counts.live_expenses, 60 - (60 / SMALL.trashed_every + 1));
    }
}

// ===========================================================================
// THE PHOTOS AXIS (#1020, wave 4 lane Photos, D-1020-P6).
//
// Two generators, and they answer two different questions:
//
//   * [`photos_demo`] is v0's 551-line `seed.js` as a FIXTURE GENERATOR — the
//     same nineteen frames, the same album, the same eight face proposals, the
//     same sixteen located frames across nine places. It is what a demo vault
//     and every screenshot test reads.
//   * [`year3_photos`] is the VOLUME axis: 50,000 assets, the
//     `year3-50k-assets` row of `tests/journeys.json`, with a declared
//     near-duplicate family distribution so the clustering has something to
//     cluster.
//
// **THE `THUMB_EDGE` COUPLING IS EXPLICIT HERE** (census seam A3). v0's seed
// ships real PNGs beside itself and every one is <= 360 px on its long edge ON
// PURPOSE: that is the grid's `THUMB_EDGE` "known small" ceiling
// (`packages/blueprints/apps/photos/media.ts:16-28`), so a tile paints the
// original instead of probing a `?variant=thumb` derivative the gateway's
// preview backstop has not generated yet. Nothing on either side tested it. In
// the port the dimensions are an INPUT — [`SampleFrame`] — read from
// `contracts/apps/photos/sample/manifest.json`, and
// `THUMB_EDGE` is a named constant the caller checks them against.
// ===========================================================================

/// The grid's "known small" ceiling. **Not a resize target**: it is the edge at
/// or under which a tile paints the original.
pub const THUMB_EDGE: u32 = 360;

/// One shipped sample frame, as the committed manifest records it.
///
/// The generator takes these rather than reading the bytes itself, so the kit
/// holds no repository path and a caller can seed from a different roll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SampleFrame {
    pub file: &'static str,
    pub width: u32,
    pub height: u32,
    pub byte_size: i64,
    /// The bytes' own sha256, 64 hex characters.
    pub sha256: &'static str,
}

impl SampleFrame {
    #[must_use]
    pub const fn long_edge(&self) -> u32 {
        if self.width > self.height {
            self.width
        } else {
            self.height
        }
    }

    /// Whether the grid may paint this frame's original directly.
    #[must_use]
    pub const fn paints_as_thumb(&self) -> bool {
        self.long_edge() <= THUMB_EDGE
    }
}

/// One frame of the demo roll: everything the seed knows that is not bytes.
// No `Eq`: a video's duration is a REAL column and an f64 has no total
// equality. Comparing two frames by value would be comparing floats.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DemoFrame {
    pub file: &'static str,
    pub title: &'static str,
    /// Days relative to `now`, as v0's `at(day, hour, monthOffset)` computes.
    pub day: i64,
    pub hour: i64,
    pub month_offset: i64,
    pub kind: &'static str,
    /// `(lat, lng)` when the camera recorded one. **A frame deliberately left
    /// out of the table stays place-less**: a camera roll where every frame
    /// knows where it was is not a camera roll anyone has.
    pub place: Option<(f64, f64)>,
    pub phash: &'static str,
    pub thumbhash: &'static str,
    pub favorite: bool,
    /// The EXACT normalised boxes the frames were drawn with, staged as
    /// `media.face_region` proposals. This bypasses detection on purpose: #712
    /// changed the ANSWERING of proposals, not the finding of them.
    pub faces: &'static [(f64, f64, f64, f64, f64)],
    pub duration_s: Option<f64>,
}

/// Pacific daylight time — the whole roll is one American trip.
pub const DEMO_TZ_OFFSET_MIN: i64 = -420;

const HOME_BACKYARD: (f64, f64) = (37.4419, -122.143);
const EMBARCADERO: (f64, f64) = (37.7955, -122.3937);
const TALLAC_TRAILHEAD: (f64, f64) = (38.9186, -120.0836);
const WEST_SHORE_RIDGE: (f64, f64) = (39.0021, -120.1131);

/// THE ROLL, newest last. Ten landscapes, eight portraits, one video — the same
/// nineteen frames v0's seed writes, in the same order.
///
/// Three properties of the place table are deliberate rather than incidental,
/// because each one is a behaviour worth being able to see: several frames
/// SHARE a coordinate (so a place row's count goes above one and grouping can
/// be told from grouping being skipped), portraits share coordinates with
/// landscapes (so People and Places intersect on one asset), and the home
/// frames sit hundreds of kilometres from the trip (so the shelf shows a trip
/// AND a home rather than one undifferentiated blob).
pub const DEMO_ROLL: [DemoFrame; 19] = [
    DemoFrame {
        file: "downtown-blue-hour.png",
        title: "Downtown at blue hour",
        day: -13,
        hour: 20,
        month_offset: -24,
        kind: "photo",
        place: Some(EMBARCADERO),
        phash: "3727170f8b494d6e",
        thumbhash: "DPcFFYJIeHl1eHdweIdoeJeAfAeI",
        favorite: false,
        faces: &[],
        duration_s: None,
    },
    DemoFrame {
        file: "harbor-lights.png",
        title: "Harbor lights from the pier",
        day: -13,
        hour: 21,
        month_offset: -24,
        kind: "photo",
        place: Some(EMBARCADERO),
        phash: "935517099b3bb235",
        thumbhash: "TPcFDQJoiHJ4B3dXiHqHR4hwiQcn",
        favorite: false,
        faces: &[],
        duration_s: None,
    },
    DemoFrame {
        file: "cabin-window-morning.png",
        title: "First morning from the cabin window",
        day: -11,
        hour: 7,
        month_offset: -13,
        kind: "photo",
        place: Some((39.0682, -120.1268)),
        phash: "0f0f0f272b958f27",
        thumbhash: "XdcVFQJ3d4+HV4hXh4eHd4dwhwk3",
        favorite: false,
        faces: &[],
        duration_s: None,
    },
    DemoFrame {
        file: "trailhead-sign.png",
        title: "Trailhead before the climb",
        day: -9,
        hour: 9,
        month_offset: -8,
        kind: "photo",
        place: Some(TALLAC_TRAILHEAD),
        phash: "0f072f0d4d554149",
        thumbhash: "mOgNDQJoiI93R5dXd4h3h1iMgAeH",
        favorite: false,
        faces: &[],
        duration_s: None,
    },
    DemoFrame {
        file: "granite-switchback.png",
        title: "Granite switchbacks",
        day: -9,
        hour: 11,
        month_offset: -4,
        kind: "photo",
        place: Some((38.9067, -120.0917)),
        phash: "0f0f0f171f9f0f97",
        thumbhash: "G+cNLYZod3h/d3dzh1iId4iAhghY",
        favorite: false,
        faces: &[],
        duration_s: None,
    },
    DemoFrame {
        file: "sand-harbor-dawn.png",
        title: "Sand Harbor at dawn",
        day: -4,
        hour: 6,
        month_offset: 0,
        kind: "photo",
        place: Some((39.1979, -119.9308)),
        phash: "1f0f0f0e57334f25",
        thumbhash: "JNcJDYJYd3d/d4d0iCeIh5hwgAkn",
        favorite: false,
        faces: &[],
        duration_s: None,
    },
    DemoFrame {
        file: "truckee-river-bend.png",
        title: "Bend in the Truckee",
        day: -4,
        hour: 10,
        month_offset: 0,
        kind: "photo",
        place: Some((39.1682, -120.1429)),
        phash: "170f0f0b1b09071f",
        thumbhash: "m9cJFYQ3eIh/eXeGh0h3dKhwhApY",
        favorite: true,
        faces: &[],
        duration_s: None,
    },
    DemoFrame {
        file: "emerald-bay-overlook.png",
        title: "Emerald Bay overlook",
        day: -3,
        hour: 19,
        month_offset: 0,
        kind: "photo",
        place: Some((38.9542, -120.1094)),
        phash: "1f0f0f1337250d17",
        thumbhash: "UwcKDYJnd3iPd4dzh1iHhrdwc/hX",
        favorite: true,
        faces: &[],
        duration_s: None,
    },
    DemoFrame {
        file: "tahoe-dusk-ridge.png",
        title: "Dusk over the west shore",
        day: -3,
        hour: 20,
        month_offset: 0,
        kind: "photo",
        place: Some(WEST_SHORE_RIDGE),
        phash: "1d2b070f5b371e4b",
        thumbhash: "DAcKDYJod3d7h4hweHiIeJiAi2gH",
        favorite: false,
        faces: &[],
        duration_s: None,
    },
    DemoFrame {
        file: "backyard-last-light.png",
        title: "Last light in the backyard",
        day: -1,
        hour: 19,
        month_offset: 0,
        kind: "photo",
        place: Some(HOME_BACKYARD),
        phash: "0f170f0f0f4f4bc9",
        thumbhash: "GDgOJYhneHiIeHeAiKh3h3eAcVcI",
        favorite: false,
        faces: &[],
        duration_s: None,
    },
    // --- the portrait half (#712 test seeding) --------------------------------
    DemoFrame {
        file: "ana-kitchen-window.png",
        title: "Ana by the kitchen window",
        day: -12,
        hour: 9,
        month_offset: 0,
        kind: "photo",
        place: Some(HOME_BACKYARD),
        phash: "303878783ce480c0",
        thumbhash: "6QcKHQTqdn9pZme4V3x1Z3dvUvQF",
        favorite: false,
        faces: &[(0.3374, 0.1795, 0.4511, 0.4743, 0.94)],
        duration_s: None,
    },
    DemoFrame {
        file: "marco-workshop.png",
        title: "Marco in the workshop",
        day: -10,
        hour: 15,
        month_offset: 0,
        kind: "photo",
        place: None,
        phash: "0070706c70e88080",
        thumbhash: "oSgKDQTod496lmfIV3x1ZzeAdQSI",
        favorite: false,
        faces: &[(0.2778, 0.1769, 0.4667, 0.4907, 0.94)],
        duration_s: None,
    },
    DemoFrame {
        file: "ana-trailhead.png",
        title: "Ana at the trailhead",
        day: -8,
        hour: 11,
        month_offset: 0,
        kind: "photo",
        place: Some(TALLAC_TRAILHEAD),
        phash: "0070704454c88080",
        thumbhash: "pecJHQTXeH+KdmjXSIxlZ0iJgIAI",
        favorite: false,
        faces: &[(0.2478, 0.1909, 0.4822, 0.507, 0.94)],
        duration_s: None,
    },
    DemoFrame {
        file: "marco-harbor-wall.png",
        title: "Marco by the harbour wall",
        day: -6,
        hour: 17,
        month_offset: 0,
        kind: "photo",
        place: Some(EMBARCADERO),
        phash: "0030705064ec80c0",
        thumbhash: "IQgKHQjZd495lmfIV3tmaDaAZwN4",
        favorite: false,
        faces: &[(0.3191, 0.2058, 0.4433, 0.4661, 0.94)],
        duration_s: None,
    },
    DemoFrame {
        file: "ana-and-marco-table.png",
        title: "Ana and Marco at the table",
        day: -4,
        hour: 20,
        month_offset: 0,
        kind: "photo",
        place: Some(HOME_BACKYARD),
        phash: "0000ccccbcba30dc",
        thumbhash: "pCgODQKZp3+IuHe4d4lIWFDuBHRO",
        favorite: false,
        // TWO faces in one frame: the case that makes "confidence is a match
        // count deduped BY PHOTOGRAPH" observable.
        faces: &[
            (0.1326, 0.2868, 0.3422, 0.3598, 0.94),
            (0.5435, 0.2938, 0.35, 0.368, 0.94),
        ],
        duration_s: None,
    },
    DemoFrame {
        file: "ana-profile-doorway.png",
        // "Someone in the doorway": a LOW-confidence proposal, so the review
        // queue has one entry the detector was unsure about.
        title: "Someone in the doorway",
        day: -3,
        hour: 18,
        month_offset: 0,
        kind: "photo",
        place: None,
        phash: "0060e0a890100000",
        thumbhash: "IwgOFQSQd2iXd4iYaIl2eISfYOYJ",
        favorite: false,
        faces: &[(0.1978, 0.2485, 0.4044, 0.4252, 0.61)],
        duration_s: None,
    },
    DemoFrame {
        file: "ana-porch-evening.png",
        title: "Ana on the porch",
        day: -2,
        hour: 19,
        month_offset: 0,
        kind: "photo",
        place: Some(HOME_BACKYARD),
        phash: "007070544cec8086",
        thumbhash: "oygKNQaod496hoe3V3yUZ5h/hvlX",
        favorite: false,
        faces: &[(0.3046, 0.1807, 0.4278, 0.4498, 0.94)],
        duration_s: None,
    },
    DemoFrame {
        file: "empty-hallway.png",
        // A frame with NO faces, so "nothing to review here" has a case.
        title: "The hallway, no one in it",
        day: -1,
        hour: 13,
        month_offset: 0,
        kind: "photo",
        place: None,
        phash: "0030300c0c0c0000",
        thumbhash: "aAgKBQB3iI94d4iXd3iHiEd/dYA3",
        favorite: false,
        faces: &[],
        duration_s: None,
    },
    DemoFrame {
        file: "tahoe-pan.mp4",
        title: "Tahoe shoreline pan",
        day: -2,
        hour: 17,
        month_offset: 0,
        kind: "video",
        place: Some(WEST_SHORE_RIDGE),
        phash: "",
        thumbhash: "DAcKDYJod3d7h4hweHiIeJiAi2gH",
        favorite: false,
        faces: &[],
        duration_s: Some(12.0),
    },
];

/// Named so a confirmed proposal has someone to BE. Face review never invents a
/// person — the member picks one, so the roster has to exist first.
pub const DEMO_FACE_PEOPLE: [&str; 2] = ["Ana Ribeiro", "Marco Salas"];

/// The four frames that made the "where are we staying" shortlist.
pub const DEMO_ALBUM_TITLE: &str = "Tahoe scouting";
pub const DEMO_ALBUM_FILES: [&str; 4] = [
    "emerald-bay-overlook.png",
    "tahoe-dusk-ridge.png",
    "truckee-river-bend.png",
    "granite-switchback.png",
];
pub const DEMO_ALBUM_COVER: &str = "emerald-bay-overlook.png";

/// What a demo seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PhotosDemoCounts {
    pub assets: usize,
    pub places: usize,
    pub faces: usize,
    pub favorites: usize,
    pub album_members: usize,
    pub people: usize,
}

/// ~11 m identity precision, so burst photographs share one `core_place` while
/// the row keeps the precise coordinate (#352).
fn round_coord(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// v0's `at(day, hour, monthOffset)`, on a fixed reference day.
///
/// `now` is a `YYYY-MM-DD` civil date rather than an instant, because that is
/// all the arithmetic reads and an instant would invite a caller to pass a
/// clock. **A month offset is applied before the day offset**, as v0's
/// `setUTCMonth` then `setUTCDate` does.
fn demo_instant(now: &str, frame: &DemoFrame) -> String {
    let (year, month, _) = parse_day(now);
    let (_, _, day_of_month) = parse_day(now);
    let total = i64::from(year) * 12 + i64::from(month) - 1 + frame.month_offset;
    let (shifted_year, shifted_month) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the roll spans 2024-2026; the cast is exact for every year in it"
    )]
    let base = format!(
        "{:04}-{:02}-{:02}",
        shifted_year as u32, shifted_month as u32, day_of_month
    );
    // A negative day offset walks backwards, which `day` cannot do, so the
    // walk is done from a floor and the offset made positive once.
    let offset = usize::try_from(frame.day + 400).unwrap_or(0);
    let floored = day_before(&base, 400);
    format!("{}T{:02}:00:00.000Z", day(&floored, offset), frame.hour)
}

/// `date - count days`. The inverse of [`day`], written out for the same reason:
/// the fixture's dates must never move.
fn day_before(start: &str, count: usize) -> String {
    let (mut year, mut month, mut day_of_month) = parse_day(start);
    for _ in 0..count {
        if day_of_month > 1 {
            day_of_month -= 1;
        } else if month > 1 {
            month -= 1;
            day_of_month = month_length(year, month);
        } else {
            year -= 1;
            month = 12;
            day_of_month = 31;
        }
    }
    format!("{year:04}-{month:02}-{day_of_month:02}")
}

/// **v0's `photos/seed.js`, as a fixture generator** (D-1020-P6).
///
/// Writes the same rows the seed writes — nineteen assets, their content items,
/// their perceptual hashes, the nine places, the eight face proposals, the two
/// named people, the album and its cover — through the connection it is handed.
///
/// Two things it does NOT do, and both are the point of it being a fixture
/// generator rather than a port of the script:
///
/// * **it holds no bytes and no path.** The sample frames arrive as
///   [`SampleFrame`] facts from `contracts/apps/photos/sample/manifest.json`,
///   so the `THUMB_EDGE` coupling is a checkable input rather than a property
///   of files nobody measured.
/// * **it reads no clock.** `now` is a civil date the caller states.
pub fn photos_demo(
    connection: &Connection,
    samples: &[SampleFrame],
    now: &str,
    owner_party_id: &str,
) -> KitResult<PhotosDemoCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    connection.execute_batch("BEGIN IMMEDIATE").map_err(door)?;
    let counts = seed_photos_demo(connection, samples, now, owner_party_id);
    match counts {
        Ok(counts) => {
            connection.execute_batch("COMMIT").map_err(door)?;
            Ok(counts)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one generator, one reading order: people, places, the roll, the \
              faces, the album. Splitting it would hide the id arithmetic from \
              the rows it keys."
)]
fn seed_photos_demo(
    connection: &Connection,
    samples: &[SampleFrame],
    now: &str,
    owner_party_id: &str,
) -> KitResult<PhotosDemoCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let created = format!("{now}T00:00:00.000Z");
    let mut counts = PhotosDemoCounts::default();

    // --- the roster a confirm can name.
    for (index, name) in DEMO_FACE_PEOPLE.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO core_party (party_id, kind, display_name, sort_name, created_at)
                 VALUES (?, 'person', ?, ?, ?)",
                rusqlite::params![id("demo-party", index + 1), name, name, created],
            )
            .map_err(door)?;
        counts.people += 1;
    }

    // --- the places, deduped at ~11 m as `findOrCreatePlaceTx` dedupes them.
    let mut places: Vec<(f64, f64)> = Vec::new();
    for frame in &DEMO_ROLL {
        if let Some((lat, lng)) = frame.place {
            let key = (round_coord(lat), round_coord(lng));
            if !places.contains(&key) {
                places.push(key);
            }
        }
    }
    for (index, (lat, lng)) in places.iter().enumerate() {
        connection
            .execute(
                // A coordinate-shaped NAME, exactly as the vault mints one for a
                // place nobody has named. `place_phrase` refuses to print it,
                // which is the behaviour this row exists to exercise.
                "INSERT INTO core_place
                   (place_id, name, geo_lat, geo_lng, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                rusqlite::params![
                    id("demo-place", index),
                    format!("{lat:.4}, {lng:.4}"),
                    lat,
                    lng,
                    created,
                    created
                ],
            )
            .map_err(door)?;
        counts.places += 1;
    }
    let place_id_of = |frame: &DemoFrame| -> Option<String> {
        let (lat, lng) = frame.place?;
        let key = (round_coord(lat), round_coord(lng));
        places
            .iter()
            .position(|held| *held == key)
            .map(|index| id("demo-place", index))
    };

    // --- the flags scheme and the `starred` concept, minted on first use as
    // the vault mints them.
    connection
        .execute(
            "INSERT INTO core_concept_scheme
               (scheme_id, uri, title, publisher, version, created_at)
             VALUES ('demo-scheme-flags', 'https://centraid.dev/schemes/flags',
                     'Flags', 'centraid', '1', ?)",
            [&created],
        )
        .map_err(door)?;
    connection
        .execute(
            "INSERT INTO core_concept
               (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
             VALUES ('demo-concept-starred', 'demo-scheme-flags', 'starred', 'Starred', ?1, ?1)",
            [&created],
        )
        .map_err(door)?;

    // --- the roll, strictly in order: ids are minted per frame, so a shuffled
    // roll would shuffle the timeline's tie breaks and the album's positions.
    let mut asset_of: Vec<(&'static str, String)> = Vec::new();
    let mut face_index = 0_usize;
    for (index, frame) in DEMO_ROLL.iter().enumerate() {
        let sample = samples
            .iter()
            .find(|sample| sample.file == frame.file)
            .ok_or_else(|| {
                KitError::Door(format!("no sample manifest entry for {}", frame.file))
            })?;
        let asset_id = id("demo-asset", index);
        let content_id = id("demo-content", index);
        connection
            .execute(
                "INSERT INTO core_content_item
                   (content_id, content_uri, sha256, byte_size, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                rusqlite::params![
                    content_id,
                    format!("blob:{}", sample.sha256),
                    sample.sha256,
                    sample.byte_size,
                    created
                ],
            )
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO media_asset
                   (asset_id, content_id, kind, title, captured_at, tz_offset_min,
                    place_id, width, height, duration_s, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
                rusqlite::params![
                    asset_id,
                    content_id,
                    frame.kind,
                    frame.title,
                    demo_instant(now, frame),
                    DEMO_TZ_OFFSET_MIN,
                    place_id_of(frame),
                    frame.width_of(sample),
                    frame.height_of(sample),
                    frame.duration_s,
                    created
                ],
            )
            .map_err(door)?;
        counts.assets += 1;
        if !frame.phash.is_empty() {
            connection
                .execute(
                    "INSERT INTO media_asset_phash (asset_id, phash, computed_at, updated_at)
                     VALUES (?1, ?2, ?3, ?3)",
                    rusqlite::params![asset_id, frame.phash, created],
                )
                .map_err(door)?;
        }
        if frame.favorite {
            connection
                .execute(
                    "INSERT INTO core_tag
                       (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                        tagged_at, updated_at)
                     VALUES (?1, 'media.asset', ?2, 'demo-concept-starred', ?3, ?4, ?4)",
                    rusqlite::params![id("demo-tag", index), asset_id, owner_party_id, created],
                )
                .map_err(door)?;
            counts.favorites += 1;
        }
        // The face proposals: every region `proposed` and NAMELESS, because
        // nothing in v0 writes `party_id` on a proposal and a proposal of one
        // region is honest (#712).
        for (x, y, w, h, confidence) in frame.faces {
            connection
                .execute(
                    "INSERT INTO media_face_region
                       (region_id, asset_id, bbox_json, confidence, review_state,
                        created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, 'proposed', ?5, ?5)",
                    rusqlite::params![
                        id("demo-region", face_index),
                        asset_id,
                        format!(r#"{{"x":{x},"y":{y},"w":{w},"h":{h}}}"#),
                        confidence,
                        created
                    ],
                )
                .map_err(door)?;
            face_index += 1;
            counts.faces += 1;
        }
        asset_of.push((frame.file, asset_id));
    }

    // --- the album and its cover.
    let album_id = "demo-album-0";
    connection
        .execute(
            "INSERT INTO core_collection
               (collection_id, owner_party_id, name, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?4)",
            rusqlite::params![album_id, owner_party_id, DEMO_ALBUM_TITLE, created],
        )
        .map_err(door)?;
    for (position, file) in DEMO_ALBUM_FILES.iter().enumerate() {
        let asset_id = asset_of
            .iter()
            .find(|(name, _)| name == file)
            .map(|(_, asset_id)| asset_id.clone())
            .ok_or_else(|| {
                KitError::Door(format!("the album names {file}, which is not in the roll"))
            })?;
        connection
            .execute(
                "INSERT INTO core_collection_entry
                   (entry_id, collection_id, target_type, target_id, position, added_at)
                 VALUES (?1, ?2, 'media.asset', ?3, ?4, ?5)",
                rusqlite::params![
                    id("demo-entry", position),
                    album_id,
                    asset_id,
                    i64::try_from(position).unwrap_or_default(),
                    created
                ],
            )
            .map_err(door)?;
        counts.album_members += 1;
    }
    let cover = asset_of
        .iter()
        .find(|(name, _)| *name == DEMO_ALBUM_COVER)
        .map(|(_, asset_id)| asset_id.clone())
        .ok_or_else(|| KitError::Door("the album cover is not in the roll".to_owned()))?;
    connection
        .execute(
            "UPDATE core_collection SET cover_content_id =
               (SELECT content_id FROM media_asset WHERE asset_id = ?1)
             WHERE collection_id = ?2",
            rusqlite::params![cover, album_id],
        )
        .map_err(door)?;

    Ok(counts)
}

impl DemoFrame {
    /// The frame's width, from the SAMPLE rather than from the seed's own
    /// table: v0 states both and nothing checks they agree.
    #[must_use]
    pub const fn width_of(&self, sample: &SampleFrame) -> u32 {
        sample.width
    }

    #[must_use]
    pub const fn height_of(&self, sample: &SampleFrame) -> u32 {
        sample.height
    }
}

// ---------------------------------------------------------------------------
// The volume axis.
// ---------------------------------------------------------------------------

/// The declared shape of year-3 Photos volume.
///
/// **A count is not a distribution.** `near_duplicate_families` and
/// `family_size` are what give the clustering something to find; without them a
/// 50,000-asset fixture measures a table scan and calls it a duplicates screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3PhotosShape {
    /// `year3-50k-assets` (`tests/journeys.json`). v0's own profile says 90,000
    /// assets and 3,000 near-duplicate families for `year3-photos`; the 50k row
    /// is the one this lane's brief names.
    pub assets: usize,
    /// One in this many assets is trashed, so the trash shelf is non-empty and
    /// the live window has to exclude something.
    pub trashed_every: usize,
    /// One in this many is archived — in NEITHER shelf (#419).
    pub archived_every: usize,
    /// One in fifty is starred, as v0's generator stars them
    /// (`year3-vault.ts:56-59`) — **a flags-scheme tag, not a column**, so the
    /// fixture still exercises the join every Photos surface makes.
    pub starred_every: usize,
    /// Groups of visually similar frames, so `cluster_id` is not all NULL.
    pub near_duplicate_families: usize,
    pub family_size: usize,
    /// Face proposals, spread over the first assets.
    pub face_regions: usize,
    /// Places, so the grid's place join is not trivial.
    pub places: usize,
    /// Albums, and how many members each carries.
    pub albums: usize,
    pub album_members: usize,
    /// The first capture day; every asset is one day later than the last.
    pub start: &'static str,
}

/// The `year3-50k-assets` volume.
pub const YEAR3_PHOTOS: Year3PhotosShape = Year3PhotosShape {
    assets: 50_000,
    trashed_every: 250,
    archived_every: 500,
    starred_every: 50,
    near_duplicate_families: 1_500,
    family_size: 3,
    face_regions: 4_000,
    places: 400,
    albums: 40,
    album_members: 50,
    start: "2023-01-01",
};

/// What a year-3 Photos seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Year3PhotosCounts {
    pub assets: usize,
    pub live_assets: usize,
    pub trashed: usize,
    pub archived: usize,
    pub starred: usize,
    pub phashes: usize,
    pub clustered: usize,
    pub face_regions: usize,
    pub places: usize,
    pub album_entries: usize,
}

/// Seed the Photos axis of year-3 volume.
///
/// **Capture times repeat on purpose.** Assets share a `captured_at` in pairs,
/// because the keyset page's whole reason for carrying the pk is that the sort
/// key is not unique (#1020 apps seam 3) — a 50,000-asset fixture with distinct
/// timestamps cannot trip the page boundary the cursor exists for.
pub fn year3_photos(
    connection: &Connection,
    shape: Year3PhotosShape,
    seed: u64,
) -> KitResult<Year3PhotosCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    connection.execute_batch("BEGIN IMMEDIATE").map_err(door)?;
    let counts = seed_year3_photos(connection, shape, seed);
    match counts {
        Ok(counts) => {
            connection.execute_batch("COMMIT").map_err(door)?;
            Ok(counts)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one generator, one reading order; see `seed_ledger`"
)]
fn seed_year3_photos(
    connection: &Connection,
    shape: Year3PhotosShape,
    seed: u64,
) -> KitResult<Year3PhotosCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let mut random = Seeded::new(seed);
    let created = format!("{}T00:00:00.000Z", day(shape.start, 0));
    let mut counts = Year3PhotosCounts::default();

    connection
        .execute(
            "INSERT INTO core_party (party_id, kind, display_name, sort_name, created_at)
             VALUES (?1, 'person', 'Year 3 owner', 'Year 3 owner', ?2)",
            rusqlite::params![YEAR3_OWNER_PARTY, created],
        )
        .map_err(door)?;
    connection
        .execute(
            "INSERT INTO core_concept_scheme
               (scheme_id, uri, title, publisher, version, created_at)
             VALUES ('y3-scheme-flags', 'https://centraid.dev/schemes/flags',
                     'Flags', 'centraid', '1', ?)",
            [&created],
        )
        .map_err(door)?;
    connection
        .execute(
            "INSERT INTO core_concept
               (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
             VALUES ('y3-concept-starred', 'y3-scheme-flags', 'starred', 'Starred', ?1, ?1)",
            [&created],
        )
        .map_err(door)?;
    for index in 0..shape.places {
        connection
            .execute(
                "INSERT INTO core_place
                   (place_id, name, geo_lat, geo_lng, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                rusqlite::params![
                    id("place", index),
                    format!("Place {index:04}"),
                    36.0 + (index as f64) / 1_000.0,
                    -122.0 + (index as f64) / 1_000.0,
                    created
                ],
            )
            .map_err(door)?;
        counts.places += 1;
    }
    for index in 0..shape.albums {
        connection
            .execute(
                "INSERT INTO core_collection
                   (collection_id, owner_party_id, name, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                rusqlite::params![
                    id("album", index),
                    YEAR3_OWNER_PARTY,
                    format!("Album {index:03}"),
                    i64::try_from(index).unwrap_or_default(),
                    created
                ],
            )
            .map_err(door)?;
    }

    for index in 0..shape.assets {
        let asset_id = id("asset", index);
        let content_id = id("content", index);
        let sha = format!("{index:064x}");
        // TWO ASSETS PER DAY, so the keyset page has a tie to walk through.
        let captured = format!("{}T12:00:00.000Z", day(shape.start, index / 2));
        let trashed = index.is_multiple_of(shape.trashed_every);
        let archived = !trashed && index.is_multiple_of(shape.archived_every);
        connection
            .execute(
                "INSERT INTO core_content_item
                   (content_id, content_uri, sha256, byte_size, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                rusqlite::params![
                    content_id,
                    format!("blob:{sha}"),
                    sha,
                    2_000_000 + i64::try_from(random.upto(1_000_000)).unwrap_or_default(),
                    created
                ],
            )
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO media_asset
                   (asset_id, content_id, kind, title, captured_at, tz_offset_min, place_id,
                    width, height, archived_at, deleted_at, purge_at, created_at, updated_at)
                 VALUES (?1, ?2, 'photo', ?3, ?4, -420, ?5, 4032, 3024, ?6, ?7, ?8, ?9, ?9)",
                rusqlite::params![
                    asset_id,
                    content_id,
                    format!("Frame {index:06}"),
                    captured,
                    id("place", index % shape.places),
                    archived.then(|| created.clone()),
                    trashed.then(|| created.clone()),
                    trashed.then(|| format!("{}T12:00:00.000Z", day(shape.start, index / 2 + 30))),
                    created
                ],
            )
            .map_err(door)?;
        counts.assets += 1;
        if trashed {
            counts.trashed += 1;
        } else if archived {
            counts.archived += 1;
        }
        if !trashed && !archived {
            counts.live_assets += 1;
        }
        if index.is_multiple_of(shape.starred_every) {
            connection
                .execute(
                    "INSERT INTO core_tag
                       (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                        tagged_at, updated_at)
                     VALUES (?1, 'media.asset', ?2, 'y3-concept-starred', ?3, ?4, ?4)",
                    rusqlite::params![id("tag", index), asset_id, YEAR3_OWNER_PARTY, created],
                )
                .map_err(door)?;
            counts.starred += 1;
        }
        // THE PERCEPTUAL HASH, and the near-duplicate families.
        //
        // The first `families * family_size` assets are grouped: every member
        // of a family shares a base digest with one nibble flipped, which is
        // four bits — inside the threshold of six and therefore a cluster.
        // Every later asset gets a digest far from every other.
        let family = index / shape.family_size;
        let phash = if family < shape.near_duplicate_families {
            let member = index % shape.family_size;
            let base = (family as u64).wrapping_mul(0x9e37_79b9) & 0x0fff_ffff_ffff_ffff;
            format!("{:016x}", base ^ (1_u64 << (member * 4)))
        } else {
            format!(
                "{:016x}",
                (index as u64).wrapping_mul(0xff51_afd7_ed55_8ccd)
            )
        };
        connection
            .execute(
                "INSERT INTO media_asset_phash
                   (asset_id, phash, cluster_id, computed_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                rusqlite::params![
                    asset_id,
                    phash,
                    // The cluster id the sweep WOULD stamp: the family's lowest
                    // LIVE asset id. **Live, because the sweep clusters only
                    // live assets** — a family whose first member is trashed
                    // takes its second member's id, and getting that wrong is
                    // how a pre-stamped fixture starts disagreeing with the
                    // code it is supposed to be evidence for.
                    //
                    // `centraid_media::duplicates::cluster` over these same
                    // fingerprints is what proves the value
                    // (`crates/apps/photos/tests/year3.rs`).
                    (family < shape.near_duplicate_families && !trashed).then(|| {
                        let first = family * shape.family_size;
                        let lowest = (first..first + shape.family_size)
                            .find(|member| !member.is_multiple_of(shape.trashed_every))
                            .unwrap_or(first);
                        id("asset", lowest)
                    }),
                    created
                ],
            )
            .map_err(door)?;
        counts.phashes += 1;
        if family < shape.near_duplicate_families && !trashed {
            counts.clustered += 1;
        }
        if index < shape.album_members * shape.albums {
            connection
                .execute(
                    "INSERT INTO core_collection_entry
                       (entry_id, collection_id, target_type, target_id, position, added_at)
                     VALUES (?1, ?2, 'media.asset', ?3, ?4, ?5)",
                    rusqlite::params![
                        id("entry", index),
                        id("album", index % shape.albums),
                        asset_id,
                        i64::try_from(index / shape.albums).unwrap_or_default(),
                        created
                    ],
                )
                .map_err(door)?;
            counts.album_entries += 1;
        }
        if index < shape.face_regions {
            connection
                .execute(
                    "INSERT INTO media_face_region
                       (region_id, asset_id, bbox_json, confidence, review_state,
                        created_at, updated_at)
                     VALUES (?1, ?2, '{\"x\":0.1,\"y\":0.1,\"w\":0.3,\"h\":0.3}', 0.9,
                             'proposed', ?3, ?3)",
                    rusqlite::params![id("region", index), asset_id, created],
                )
                .map_err(door)?;
            counts.face_regions += 1;
        }
    }
    Ok(counts)
}
