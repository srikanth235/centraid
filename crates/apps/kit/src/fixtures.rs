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

// ===========================================================================
// THE DOCS AXIS (#1020 wave 4 slot 4b).
//
// **Why the SEEDERS are here and not in the app's own test.** `sql-confinement`
// scans every `.rs` file under `crates/`, tests included, and SQL lives only
// under `crates/{ontology,vault,seat,search}` and `crates/apps/kit` (#1020
// invariant). Docs' door suite needs `share_*` rows the command surface cannot
// write — the share plane's writers are a later lane — and a staged blob row
// the upload route writes, so the statements live on this side of the line,
// exactly as [`crate::contract_vault::open_contract_vault`] does.
// ===========================================================================

/// One standing answer, as `share_authority` holds it.
///
/// A SHARE IS A STANDING ANSWER, NOT A ROSTER (#929): this row says who MAY
/// reach a subject, and `share_fulfillment` says whether it has.
#[derive(Debug, Clone)]
pub struct ShareSeed<'a> {
    pub authority_id: &'a str,
    /// `person` or `circle` for a Docs audience.
    pub principal_kind: &'a str,
    pub principal_id: &'a str,
    /// `core.document` or `docs.folder` — two namespaces, never interchangeable.
    pub subject_type: &'a str,
    pub subject_id: &'a str,
    /// `view` or `edit`.
    pub verb: &'a str,
    /// `None` is a standing grant; `Some` makes it `until-date`, which the
    /// table's own CHECK pairs with `duration`.
    pub expires_at: Option<&'a str>,
    /// Who made the grant. `NOT NULL` for every principal but a harness, by the
    /// table's own CHECK: a grant nobody made is not a grant.
    pub granted_by: &'a str,
    pub at: &'a str,
}

/// Write one standing answer.
pub fn seed_share_authority(connection: &Connection, seed: &ShareSeed<'_>) -> KitResult<()> {
    connection
        .execute(
            "INSERT INTO share_authority
               (authority_id, principal_kind, principal_id, subject_type, subject_id,
                verb, duration, expires_at, decision, granted_at, granted_by, revoked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'granted', ?9, ?10, NULL)",
            rusqlite::params![
                seed.authority_id,
                seed.principal_kind,
                seed.principal_id,
                seed.subject_type,
                seed.subject_id,
                seed.verb,
                if seed.expires_at.is_some() {
                    "until-date"
                } else {
                    "standing"
                },
                seed.expires_at,
                seed.at,
                seed.granted_by,
            ],
        )
        .map_err(|error| KitError::Door(error.to_string()))?;
    Ok(())
}

/// Revoke or time-box an answer already written, so a fold's `live` rule can be
/// exercised against the same row rather than a second one.
pub fn amend_share_authority(
    connection: &Connection,
    authority_id: &str,
    expires_at: Option<&str>,
    revoked_at: Option<&str>,
) -> KitResult<()> {
    connection
        .execute(
            "UPDATE share_authority
                SET duration = ?2, expires_at = ?3, revoked_at = ?4
              WHERE authority_id = ?1",
            rusqlite::params![
                authority_id,
                if expires_at.is_some() {
                    "until-date"
                } else {
                    "standing"
                },
                expires_at,
                revoked_at,
            ],
        )
        .map_err(|error| KitError::Door(error.to_string()))?;
    Ok(())
}

/// Bind a party to the vault that is theirs, so a delivery can be attributed.
///
/// A REVOKED BINDING NO LONGER SAYS WHICH VAULT IS THEIRS, which is why the
/// readers filter on `revoked_at IS NULL` rather than folding it out.
pub fn seed_party_vault_binding(
    connection: &Connection,
    binding_id: &str,
    party_id: &str,
    vault_id: &str,
    at: &str,
) -> KitResult<()> {
    connection
        .execute(
            "INSERT INTO share_party_vault_binding
               (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
             VALUES (?1, ?2, ?3, NULL, ?4, NULL)",
            rusqlite::params![binding_id, party_id, vault_id, at],
        )
        .map_err(|error| KitError::Door(error.to_string()))?;
    Ok(())
}

/// Record that a grant reached a peer vault.
///
/// DELIVERED IS THE DURABLE FACT, NOT THE LIVE STATE (#846): `delivered_at` is
/// what a fold reads, and `state` may have dropped back to `syncing` since.
pub fn seed_share_fulfillment(
    connection: &Connection,
    grant_id: &str,
    peer_vault_id: &str,
    state: &str,
    delivered_at: Option<&str>,
    at: &str,
) -> KitResult<()> {
    connection
        .execute(
            "INSERT INTO share_fulfillment
               (grant_id, peer_vault_id, state, updated_at, detail, delivered_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            rusqlite::params![grant_id, peer_vault_id, state, at, delivered_at],
        )
        .map_err(|error| KitError::Door(error.to_string()))?;
    Ok(())
}

/// Seed `count` standing answers over one subject, for a fan-out ceiling test.
///
/// Returns how many landed. Deterministic ids, zero-padded to six as every
/// generator in this module pads, so the rows a run writes never move.
pub fn seed_standing_answers(
    connection: &Connection,
    subject_type: &str,
    subject_id: &str,
    range: std::ops::Range<usize>,
    granted_by: &str,
    at: &str,
) -> KitResult<usize> {
    let mut seeded = 0;
    for index in range {
        seed_share_authority(
            connection,
            &ShareSeed {
                authority_id: &id("grant", index),
                principal_kind: "person",
                principal_id: &id("party", index),
                subject_type,
                subject_id,
                verb: "view",
                expires_at: None,
                granted_by,
                at,
            },
        )?;
        seeded += 1;
    }
    Ok(seeded)
}

/// Stage bytes the way `POST /_vault/blobs` does, so a claim has a row to read.
///
/// The bytes themselves belong in a content-addressed store beside this; the
/// staging ROW is what `core.add_document`'s `staged_sha` gate checks and what
/// the claim then consumes.
pub fn seed_blob_staging(
    connection: &Connection,
    staging_id: &str,
    sha256: &str,
    media_type: &str,
    byte_size: i64,
    original_name: Option<&str>,
    at: &str,
) -> KitResult<()> {
    connection
        .execute(
            "INSERT INTO blob_staging
               (staging_id, sha256, media_type, byte_size, original_name, meta_json,
                staged_by, held_by_batch, variant, variant_of, inline_content,
                staged_at, held_by_intent)
             VALUES (?1, ?2, ?3, ?4, ?5, '{}', NULL, NULL, NULL, NULL, NULL, ?6, NULL)",
            rusqlite::params![staging_id, sha256, media_type, byte_size, original_name, at],
        )
        .map_err(|error| KitError::Door(error.to_string()))?;
    Ok(())
}

/// The vault's own owner party, which every seeded grant is granted BY.
///
/// `None` on a vault nobody has been enrolled in — which is a state, not an
/// error: a fixture may deliberately be founded without an owner.
pub fn owner_party_id(connection: &Connection) -> KitResult<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok())
}

// ===========================================================================
// THE DOCS DEMO SEED, AS A GENERATOR (#1020, D-1020-DC5).
//
// v0's `packages/blueprints/apps/docs/seed.js` is 82 lines and writes through
// the real commands: two folders, three filed documents, a star, a label, and
// one document with a SECOND version so the history walk has something to walk.
// This is that scenario as a generator, and the two differences are the reason
// it is a generator rather than a port of the script:
//
// * **it holds no bytes and no path.** A document's body arrives as a
//   [`DemoDocument`] fact — a title, a folder and the markdown — so the sample
//   bodies are a checkable input rather than a property of a file nobody
//   measured. `contracts/apps/docs/sample/manifest.json` is where a caller
//   keeps a larger roll.
// * **it reads no clock.** `now` is a civil date the caller states, and every
//   instant is derived from it, so two runs of the same date write the same
//   rows.
//
// WHERE THE ROWS GO, TODAY AND LATER. Today the generator writes through the
// connection it is handed, because a fixture that ran the command path would
// need a founded vault and the command registry — which is `crates/vault`'s.
// The row VALUES are the ones the commands produce: a wrapper over a
// sha-deduped content item, one folders-scheme tag per document, a flags-scheme
// star, an occurrence chain whose newest row the wrapper points at. So the same
// generator re-points at `Vault::execute` without the fixture changing.
// ===========================================================================

/// One document of the demo drive: everything the seed knows that is not an id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DemoDocument {
    pub title: &'static str,
    /// The folder's `pref_label`, or `None` for the drive's top level.
    pub folder: Option<&'static str>,
    pub body: &'static str,
    /// A SECOND body, for the one document whose history has two versions.
    pub revised: Option<&'static str>,
    pub starred: bool,
    /// A free-form label, in the shared Tags scheme.
    pub label: Option<&'static str>,
}

/// The folders the demo drive files into, in v0's own order.
pub const DEMO_FOLDERS: [&str; 2] = ["Travel", "Home"];

/// THE DRIVE, as v0's seed writes it.
///
/// The packing list carries the second version, the star and the label, because
/// a corpus where those three facts sit on three different documents cannot show
/// a row that is all three at once — which is the row a renderer gets wrong.
pub const DEMO_DOCUMENTS: [DemoDocument; 3] = [
    DemoDocument {
        title: "Tahoe packing list",
        folder: Some("Travel"),
        body: "# Tahoe packing list\n\n- Rain shell\n- Hiking boots\n- Headlamp\n",
        revised: Some(
            "# Tahoe packing list\n\n- Rain shell\n- Hiking boots\n- Headlamp\n\
             - Tire chains (I-80 requires them after a storm)\n",
        ),
        starred: true,
        label: Some("tahoe"),
    },
    // "(sample)" in the title: a rental agreement and an insurance policy are
    // exactly the records a member must never mistake for the real thing.
    DemoDocument {
        title: "Cabin rental agreement (sample)",
        folder: Some("Travel"),
        body: "# Cabin rental agreement (sample)\n\nThis is sample demo data, \
               not a real agreement.\n",
        revised: None,
        starred: false,
        label: None,
    },
    DemoDocument {
        title: "Renters insurance policy (sample)",
        folder: Some("Home"),
        body: "# Renters insurance policy (sample)\n\nThis is sample demo data, \
               not a real policy.\n",
        revised: None,
        starred: false,
        label: None,
    },
];

/// The media type the demo bodies are read as. `text/markdown` and not
/// `text/plain`: it is what makes `core.edit_document` reachable at all, and it
/// is what the drive's `media_type` field carries.
pub const DEMO_MEDIA_TYPE: &str = "text/markdown";

/// What one demo seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DocsDemoCounts {
    pub folders: usize,
    pub documents: usize,
    pub content_items: usize,
    pub revisions: usize,
    pub tags: usize,
}

/// Seed the Docs demo drive into `connection`.
///
/// The whole run is one transaction, as v0's seeder is: a half-seeded drive is
/// not a smaller fixture, it is a drive whose folder rail names folders that do
/// not exist.
pub fn docs_demo(
    connection: &Connection,
    now: &str,
    owner_party_id: &str,
) -> KitResult<DocsDemoCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    connection.execute_batch("BEGIN IMMEDIATE").map_err(door)?;
    match seed_docs_demo(connection, now, owner_party_id) {
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

/// The folders scheme, the flags scheme and the tags scheme, created on first
/// use — and the drive's `root` concept, which is the drive and not a folder.
fn seed_docs_schemes(connection: &Connection, created: &str) -> KitResult<(String, String)> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    for (scheme_id, uri, title) in [
        ("demo-scheme-folders", DOCS_FOLDER_SCHEME_URI, "Folders"),
        ("demo-scheme-flags", DOCS_FLAGS_SCHEME_URI, "Flags"),
        ("demo-scheme-tags", DOCS_TAGS_SCHEME_URI, "Tags"),
    ] {
        connection
            .execute(
                "INSERT INTO core_concept_scheme
                   (scheme_id, uri, title, publisher, version, created_at)
                 VALUES (?1, ?2, ?3, 'centraid', '1', ?4)",
                rusqlite::params![scheme_id, uri, title, created],
            )
            .map_err(door)?;
    }
    connection
        .execute(
            "INSERT INTO core_concept
               (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                broader_concept_id, definition, created_at, updated_at)
             VALUES ('demo-folder-root', 'demo-scheme-folders', 'root', 'Documents',
                     NULL, NULL, 'The drive top level', ?1, ?1)",
            [created],
        )
        .map_err(door)?;
    connection
        .execute(
            "INSERT INTO core_concept
               (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                broader_concept_id, definition, created_at, updated_at)
             VALUES ('demo-flag-starred', 'demo-scheme-flags', 'starred', 'Starred',
                     '[\"Favorite\"]', NULL,
                     'Owner attention: one star across every surface', ?1, ?1)",
            [created],
        )
        .map_err(door)?;
    Ok((
        "demo-folder-root".to_owned(),
        "demo-flag-starred".to_owned(),
    ))
}

/// The three scheme URIs, restated here because the kit is the app plane's
/// import-free floor. **The two `https` URIs are spelled differently from the
/// tags one and that is deliberate**: a flag or folder URI is interpolated into
/// condition SQL, where `:flags` reads as a NAMED PARAMETER (#258).
pub const DOCS_FOLDER_SCHEME_URI: &str = "https://centraid.dev/schemes/folders";
pub const DOCS_FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
pub const DOCS_TAGS_SCHEME_URI: &str = "centraid:tags:v1";

fn seed_docs_demo(
    connection: &Connection,
    now: &str,
    owner_party_id: &str,
) -> KitResult<DocsDemoCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let created = format!("{now}T00:00:00.000Z");
    let mut counts = DocsDemoCounts::default();
    let (root, starred_concept) = seed_docs_schemes(connection, &created)?;

    // --- the folders. A folder's `notation` is its own id: the notation is
    // unique within the scheme and a member-facing name is not.
    for (index, name) in DEMO_FOLDERS.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                    broader_concept_id, definition, created_at, updated_at)
                 VALUES (?1, 'demo-scheme-folders', ?1, ?2, NULL, ?3, NULL, ?4, ?4)",
                rusqlite::params![id("demo-folder", index), name, root, created],
            )
            .map_err(door)?;
        counts.folders += 1;
    }
    let folder_of = |name: &str| -> String {
        DEMO_FOLDERS
            .iter()
            .position(|folder| *folder == name)
            .map_or_else(|| root.clone(), |index| id("demo-folder", index))
    };

    // --- one shared Tags concept, for the one labelled document.
    connection
        .execute(
            "INSERT INTO core_concept
               (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                broader_concept_id, definition, created_at, updated_at)
             VALUES ('demo-tag-tahoe', 'demo-scheme-tags', 'tahoe', 'tahoe',
                     NULL, NULL, NULL, ?1, ?1)",
            [&created],
        )
        .map_err(door)?;

    let mut tag_index = 0usize;
    for (index, document) in DEMO_DOCUMENTS.iter().enumerate() {
        let document_id = id("demo-document", index);
        // --- the bytes. Text stays inline as its own `data:` URI, which is what
        // the FTS feed decodes; the sha is over the DECODED bytes, never the URI.
        let mut bodies = vec![document.body];
        if let Some(revised) = document.revised {
            bodies.push(revised);
        }
        let mut previous: Option<String> = None;
        let mut previous_revision: Option<String> = None;
        let mut head = String::new();
        let mut head_revision = String::new();
        for (version, body) in bodies.iter().enumerate() {
            let content_id = format!("{document_id}-v{version}");
            let uri = format!("data:{DEMO_MEDIA_TYPE};charset=utf-8,{}", encode_demo(body));
            connection
                .execute(
                    "INSERT INTO core_content_item
                       (content_id, content_uri, sha256, byte_size, language,
                        creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
                     VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, NULL, ?6)",
                    rusqlite::params![
                        content_id,
                        uri,
                        demo_sha(&content_id),
                        i64::try_from(body.len()).unwrap_or(i64::MAX),
                        owner_party_id,
                        created
                    ],
                )
                .map_err(door)?;
            connection
                .execute(
                    "INSERT INTO core_content_text
                       (content_id, body_text, decoder, byte_size, created_at, updated_at)
                     VALUES (?1, ?2, 'data-uri/v1', ?3, ?4, ?4)",
                    rusqlite::params![
                        content_id,
                        body,
                        i64::try_from(body.len()).unwrap_or(i64::MAX),
                        created
                    ],
                )
                .map_err(door)?;
            counts.content_items += 1;
            // --- THE OCCURRENCE. Each names the content that became current at
            // that moment and the occurrence before it (#996 R20(a)).
            let revision_id = format!("{document_id}-r{version}");
            let snapshot = previous.as_ref().map_or_else(
                || "{\"previous_content_id\":null}".to_owned(),
                |content| format!("{{\"previous_content_id\":\"{content}\"}}"),
            );
            if version == 0 {
                // The wrapper has to exist before its occurrence can key to it.
                connection
                    .execute(
                        "INSERT INTO core_document
                           (document_id, title, current_content_id, current_revision_id,
                            created_at, updated_at, deleted_at, purge_at)
                         VALUES (?1, ?2, ?3, NULL, ?4, ?4, NULL, NULL)",
                        rusqlite::params![document_id, document.title, content_id, created],
                    )
                    .map_err(door)?;
                counts.documents += 1;
            }
            connection
                .execute(
                    "INSERT INTO core_entity_revision
                       (revision_id, entity_type, entity_id, operation, snapshot_json,
                        recorded_at, undo_until, undone_at, actor_party_id, invocation_id,
                        content_id, parent_revision_id, updated_at)
                     VALUES (?1, 'core.document', ?2, 'revise', ?3, ?4, ?4, NULL,
                             ?5, NULL, ?6, ?7, ?4)",
                    rusqlite::params![
                        revision_id,
                        document_id,
                        snapshot,
                        created,
                        owner_party_id,
                        content_id,
                        previous_revision
                    ],
                )
                .map_err(door)?;
            counts.revisions += 1;
            previous = Some(content_id.clone());
            previous_revision = Some(revision_id.clone());
            head = content_id;
            head_revision = revision_id;
        }
        connection
            .execute(
                "UPDATE core_document
                    SET current_content_id = ?1, current_revision_id = ?2
                  WHERE document_id = ?3",
                rusqlite::params![head, head_revision, document_id],
            )
            .map_err(door)?;
        // --- THIS DOCUMENT'S READING OF ITS BYTES (#996 R20(b)).
        connection
            .execute(
                "INSERT INTO core_content_representation
                   (representation_id, content_id, owner_type, owner_id, media_type,
                    charset, interpretation, created_at, updated_at)
                 VALUES (?1, ?2, 'core.document', ?3, ?4, 'utf-8', 'body', ?5, ?5)",
                rusqlite::params![
                    format!("{document_id}-rep"),
                    head,
                    document_id,
                    DEMO_MEDIA_TYPE,
                    created
                ],
            )
            .map_err(door)?;
        // --- filing: exactly ONE folders-scheme tag per document.
        let filed_in = document.folder.map_or_else(|| root.clone(), folder_of);
        connection
            .execute(
                "INSERT INTO core_tag
                   (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                    confidence, tagged_at, updated_at)
                 VALUES (?1, 'core.document', ?2, ?3, ?4, NULL, ?5, ?5)",
                rusqlite::params![
                    id("demo-tag", tag_index),
                    document_id,
                    filed_in,
                    owner_party_id,
                    created
                ],
            )
            .map_err(door)?;
        tag_index += 1;
        counts.tags += 1;
        // --- the star, which is a flags-scheme tag on the WRAPPER.
        if document.starred {
            connection
                .execute(
                    "INSERT INTO core_tag
                       (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                        confidence, tagged_at, updated_at)
                     VALUES (?1, 'core.document', ?2, ?3, ?4, NULL, ?5, ?5)",
                    rusqlite::params![
                        id("demo-tag", tag_index),
                        document_id,
                        starred_concept,
                        owner_party_id,
                        created
                    ],
                )
                .map_err(door)?;
            tag_index += 1;
            counts.tags += 1;
        }
        // --- a free-form label, in the shared Tags scheme.
        if document.label.is_some() {
            connection
                .execute(
                    "INSERT INTO core_tag
                       (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                        confidence, tagged_at, updated_at)
                     VALUES (?1, 'core.document', ?2, 'demo-tag-tahoe', ?3, NULL, ?4, ?4)",
                    rusqlite::params![
                        id("demo-tag", tag_index),
                        document_id,
                        owner_party_id,
                        created
                    ],
                )
                .map_err(door)?;
            tag_index += 1;
            counts.tags += 1;
        }
    }
    Ok(counts)
}

/// `encodeURIComponent` over a demo body, so the stored URI is the one a
/// command would have written — which is also what its sha would be taken over.
fn encode_demo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A DETERMINISTIC 64-hex sha for a fixture's bytes.
///
/// **Not the real sha256, and it says so.** `core_content_item.sha256`'s CHECK
/// pins the SHAPE (64 lowercase hex characters) and the column is `UNIQUE`; what
/// a fixture needs is a distinct, reproducible value of that shape per content
/// item, and a hash function in the kit would be a second implementation of a
/// format decision that belongs to `crates/media`. A caller that needs the true
/// digest of real bytes takes it from there.
fn demo_sha(key: &str) -> String {
    // A tiny FNV-1a over the key, widened to 64 hex characters by repetition of
    // four independently seeded rounds. Stable by construction; a dependency
    // that changed its algorithm in a patch release would move the bytes.
    let round = |seed: u64| -> u64 {
        let mut hash = seed;
        for byte in key.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        hash
    };
    format!(
        "{:016x}{:016x}{:016x}{:016x}",
        round(0xcbf2_9ce4_8422_2325),
        round(0x0000_0000_0000_0001),
        round(0xffff_ffff_ffff_ffff),
        round(0x5bf0_3635_ca62_3a4d)
    )
}

/// The declared shape of year-3 Docs volume.
///
/// **A count is not a distribution.** Every field is DECLARED, and changing one
/// changes what year-3 Docs volume means repo-wide — so it moves with the
/// journey ledger's year-3 table and a version bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3DocsShape {
    /// Documents, live and trashed together.
    pub documents: usize,
    /// How many of them are in the trash.
    pub trashed: usize,
    /// How many carry a star.
    pub starred: usize,
    /// Folders, spread over `folder_depth` levels.
    pub folders: usize,
    pub folder_depth: usize,
    /// Free-form labels, and how many documents carry one.
    pub labels: usize,
    pub labelled: usize,
    /// Occurrences beyond the first, spread over the documents.
    pub extra_versions: usize,
    /// Standing share answers, and how many of them name a FOLDER.
    pub shares: usize,
    pub folder_shares: usize,
}

/// THE YEAR-3 DOCS PROFILE: 8,000 documents over 400 folders four levels deep,
/// with 2,000 standing share answers — half of them on folders.
///
/// The numbers a ceiling is stated at, and each one is the reason it is here:
///
/// * **8,000 documents against a 2,000-row window.** The drive's declared
///   maximum is 2,000 (`drive.limit`), so a year-3 drive is four windows deep
///   and `truncated` has to be the page's own cursor rather than a row count.
/// * **1,000 folder shares over a four-level tree.** Every drive row's share
///   decoration walks the chain above it, so the fold's cost is the window
///   times the depth — and `SHARE_FAN_OUT`'s 4,000-row cap is what that walk
///   runs into first.
/// * **2,000 labels over 4,000 documents.** `docs.labels.tags` is a
///   `(document, concept)` pair read over the window, which is why its bound is
///   `DOC_PAIR_BOUND` (500 × 32) and not the join bound.
pub const YEAR3_DOCS: Year3DocsShape = Year3DocsShape {
    documents: 8_000,
    trashed: 400,
    starred: 600,
    folders: 400,
    folder_depth: 4,
    labels: 2_000,
    labelled: 4_000,
    extra_versions: 2_000,
    shares: 2_000,
    folder_shares: 1_000,
};

/// What one year-3 Docs seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Year3DocsCounts {
    pub documents: usize,
    pub live_documents: usize,
    pub trashed: usize,
    pub starred: usize,
    pub folders: usize,
    pub content_items: usize,
    pub revisions: usize,
    pub tags: usize,
    pub shares: usize,
}

/// Seed the Docs axis of year-3 volume.
///
/// **Filing instants repeat on purpose.** Documents share a `tagged_at` in
/// pairs, because the keyset page's whole reason for carrying the pk is that the
/// sort key is not unique (#1020 apps seam 3) — an 8,000-document fixture with
/// distinct filing instants cannot trip the page boundary the cursor exists for.
pub fn year3_docs(
    connection: &Connection,
    shape: Year3DocsShape,
    seed: u64,
) -> KitResult<Year3DocsCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    connection.execute_batch("BEGIN IMMEDIATE").map_err(door)?;
    match seed_year3_docs(connection, shape, seed) {
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
fn seed_year3_docs(
    connection: &Connection,
    shape: Year3DocsShape,
    seed: u64,
) -> KitResult<Year3DocsCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let mut stream = Seeded::new(seed);
    let mut counts = Year3DocsCounts::default();
    let start = "2097-01-01";
    let created = format!("{start}T00:00:00.000Z");
    let (root, starred_concept) = seed_docs_schemes(connection, &created)?;
    connection
        .execute(
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
             VALUES (?1, 'person', 'Year Three', ?2, ?2)",
            rusqlite::params![YEAR3_OWNER_PARTY, created],
        )
        .map_err(door)?;

    // --- the folder tree. A folder's parent is one of the previous LEVEL's, so
    // the depth is a property of the arithmetic rather than of a random pick.
    let per_level = shape.folders / shape.folder_depth.max(1);
    for index in 0..shape.folders {
        let level = index / per_level.max(1);
        let parent = if level == 0 {
            root.clone()
        } else {
            id("y3-folder", (index - per_level).min(shape.folders - 1))
        };
        connection
            .execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                    broader_concept_id, definition, created_at, updated_at)
                 VALUES (?1, 'demo-scheme-folders', ?1, ?2, NULL, ?3, NULL, ?4, ?4)",
                rusqlite::params![
                    id("y3-folder", index),
                    format!("Folder {index:06}"),
                    parent,
                    created
                ],
            )
            .map_err(door)?;
        counts.folders += 1;
    }
    for index in 0..shape.labels {
        connection
            .execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                    broader_concept_id, definition, created_at, updated_at)
                 VALUES (?1, 'demo-scheme-tags', ?2, ?2, NULL, NULL, NULL, ?3, ?3)",
                rusqlite::params![id("y3-label", index), format!("label-{index:06}"), created],
            )
            .map_err(door)?;
    }

    let mut tag_index = 0usize;
    for index in 0..shape.documents {
        let document_id = id("y3-document", index);
        let content_id = format!("{document_id}-v0");
        // TWO DOCUMENTS PER FILING INSTANT, so the keyset's pk tiebreak is
        // exercised at every page boundary.
        let filed = day(start, index / 2);
        let stamped = format!("{filed}T09:00:00.000Z");
        let body = format!("# Document {index:06}\n\nFiled on {filed}.\n");
        connection
            .execute(
                "INSERT INTO core_content_item
                   (content_id, content_uri, sha256, byte_size, language,
                    creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, NULL, ?6)",
                rusqlite::params![
                    content_id,
                    format!(
                        "data:{DEMO_MEDIA_TYPE};charset=utf-8,{}",
                        encode_demo(&body)
                    ),
                    demo_sha(&content_id),
                    i64::try_from(body.len()).unwrap_or(i64::MAX),
                    YEAR3_OWNER_PARTY,
                    stamped
                ],
            )
            .map_err(door)?;
        counts.content_items += 1;
        let trashed = index < shape.trashed;
        connection
            .execute(
                "INSERT INTO core_document
                   (document_id, title, current_content_id, current_revision_id,
                    created_at, updated_at, deleted_at, purge_at)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?4, ?5, ?6)",
                rusqlite::params![
                    document_id,
                    format!("Document {index:06}"),
                    content_id,
                    stamped,
                    if trashed { Some(&stamped) } else { None },
                    if trashed {
                        Some(format!("{}T09:00:00.000Z", day(start, index / 2 + 30)))
                    } else {
                        None
                    }
                ],
            )
            .map_err(door)?;
        counts.documents += 1;
        if trashed {
            counts.trashed += 1;
        } else {
            counts.live_documents += 1;
        }
        // --- the occurrence chain: one always, a second for the first
        // `extra_versions` documents.
        let mut parent: Option<String> = None;
        let mut head = content_id.clone();
        let mut head_revision = String::new();
        let versions = 1 + usize::from(index < shape.extra_versions);
        for version in 0..versions {
            let revision_content = if version == 0 {
                content_id.clone()
            } else {
                let second = format!("{document_id}-v{version}");
                let revised = format!("# Document {index:06}\n\nRevised.\n");
                connection
                    .execute(
                        "INSERT INTO core_content_item
                           (content_id, content_uri, sha256, byte_size, language,
                            creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
                         VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, NULL, ?6)",
                        rusqlite::params![
                            second,
                            format!(
                                "data:{DEMO_MEDIA_TYPE};charset=utf-8,{}",
                                encode_demo(&revised)
                            ),
                            demo_sha(&second),
                            i64::try_from(revised.len()).unwrap_or(i64::MAX),
                            YEAR3_OWNER_PARTY,
                            stamped
                        ],
                    )
                    .map_err(door)?;
                counts.content_items += 1;
                second
            };
            let revision_id = format!("{document_id}-r{version}");
            connection
                .execute(
                    "INSERT INTO core_entity_revision
                       (revision_id, entity_type, entity_id, operation, snapshot_json,
                        recorded_at, undo_until, undone_at, actor_party_id, invocation_id,
                        content_id, parent_revision_id, updated_at)
                     VALUES (?1, 'core.document', ?2, 'revise', '{}', ?3, ?3, NULL,
                             ?4, NULL, ?5, ?6, ?3)",
                    rusqlite::params![
                        revision_id,
                        document_id,
                        stamped,
                        YEAR3_OWNER_PARTY,
                        revision_content,
                        parent
                    ],
                )
                .map_err(door)?;
            counts.revisions += 1;
            parent = Some(revision_id.clone());
            head = revision_content;
            head_revision = revision_id;
        }
        connection
            .execute(
                "UPDATE core_document
                    SET current_content_id = ?1, current_revision_id = ?2
                  WHERE document_id = ?3",
                rusqlite::params![head, head_revision, document_id],
            )
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO core_content_representation
                   (representation_id, content_id, owner_type, owner_id, media_type,
                    charset, interpretation, created_at, updated_at)
                 VALUES (?1, ?2, 'core.document', ?3, ?4, 'utf-8', 'body', ?5, ?5)",
                rusqlite::params![
                    format!("{document_id}-rep"),
                    head,
                    document_id,
                    DEMO_MEDIA_TYPE,
                    stamped
                ],
            )
            .map_err(door)?;
        // --- filing, the star and a label. One folders-scheme tag each.
        let folder = id("y3-folder", stream.upto(shape.folders.max(1)));
        for concept_id in [
            Some(folder),
            (index < shape.starred).then(|| starred_concept.clone()),
        ]
        .into_iter()
        .flatten()
        .chain(
            (index < shape.labelled)
                .then(|| id("y3-label", stream.upto(shape.labels.max(1))))
                .into_iter(),
        ) {
            connection
                .execute(
                    "INSERT INTO core_tag
                       (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                        confidence, tagged_at, updated_at)
                     VALUES (?1, 'core.document', ?2, ?3, ?4, NULL, ?5, ?5)",
                    rusqlite::params![
                        id("y3-tag", tag_index),
                        document_id,
                        concept_id,
                        YEAR3_OWNER_PARTY,
                        stamped
                    ],
                )
                .map_err(door)?;
            tag_index += 1;
            counts.tags += 1;
        }
        if index < shape.starred {
            counts.starred += 1;
        }
    }

    // --- the share plane: half the answers on documents, half on folders.
    for index in 0..shape.shares {
        let on_folder = index < shape.folder_shares;
        let party_id = format!("y3-party-{index:06}");
        connection
            .execute(
                "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                 VALUES (?1, 'person', ?2, ?3, ?3)",
                rusqlite::params![party_id, format!("Peer {index:06}"), created],
            )
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO share_authority
                   (authority_id, principal_kind, principal_id, subject_type, subject_id,
                    verb, duration, expires_at, decision, granted_at, granted_by, revoked_at)
                 VALUES (?1, 'person', ?2, ?3, ?4, 'view', 'standing', NULL, 'granted',
                         ?5, ?6, NULL)",
                rusqlite::params![
                    id("y3-grant", index),
                    party_id,
                    if on_folder {
                        "docs.folder"
                    } else {
                        "core.document"
                    },
                    if on_folder {
                        id("y3-folder", index % shape.folders.max(1))
                    } else {
                        id("y3-document", index % shape.documents.max(1))
                    },
                    created,
                    YEAR3_OWNER_PARTY
                ],
            )
            .map_err(door)?;
        counts.shares += 1;
    }
    Ok(counts)
}

/// The owner party every seeded row attributes to.
///
/// A fixture vault built from `[]` rows carries the model and nothing else, and
/// `core_content_item.creator_party_id` and `core_tag.tagged_by_party_id` both
/// key into `core_party` — so a generator that skipped this would be writing
/// rows whose attribution names nobody.
pub fn seed_owner_party(
    connection: &Connection,
    party_id: &str,
    display_name: &str,
    now: &str,
) -> KitResult<()> {
    connection
        .execute(
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
             VALUES (?1, 'person', ?2, ?3, ?3)",
            rusqlite::params![party_id, display_name, format!("{now}T00:00:00.000Z")],
        )
        .map_err(|error| KitError::Door(error.to_string()))?;
    Ok(())
}

// ===========================================================================
// THE NOTES AXES (#1020, wave 4 slot 4c, D-1020-N8)
//
// Two of them, and they answer different questions:
//
// * [`notes_demo`] is the corpus the six query folds are read over — the demo
//   seed's two notebooks and five notes, plus the rows the seed cannot make
//   because no Notes action writes them: a PINNED note outside the recent
//   window, a TRASHED note, a JOURNAL entry (People's, #834 R-journal), an
//   attachment, a link with a standoff anchor, and a tag. Every one of those is
//   a branch in `library`'s fold that a five-note seed never reaches.
// * [`year3_notes`] is the volume the declared window is stated at: 10,000
//   notes with long bodies, which is five windows deep at the manifest's 2,000
//   and twenty at the page's own 500.
//
// **Why they are here and not in `crates/apps/notes/tests`.** `sql-confinement`
// scans an app crate's tests too, and SQL lives only under
// `crates/{ontology,vault,seat,search}` and `crates/apps/kit`. Two Photos test
// files are the standing red for exactly this, and the answer is the kit rather
// than a second exemption.
// ===========================================================================

/// The scheme URIs the Notes fixtures name. Restated here because the kit is
/// the app plane's import-free floor, and asserted against
/// `centraid_apps_notes::journal`'s copy by that crate's own test.
pub const NOTES_JOURNAL_SCHEME_URI: &str = "https://centraid.dev/schemes/people-journal";
pub const NOTES_TAGS_SCHEME_URI: &str = "centraid:tags:v1";
/// The relations scheme, whose `references` concept a `[[wikilink]]` compiles to.
pub const NOTES_RELATIONS_SCHEME_URI: &str = "urn:duaility:relations";

/// The party every seeded note is authored by.
pub const NOTES_DEMO_OWNER: &str = "party-000000";

/// What one demo seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NotesDemoCounts {
    pub notebooks: usize,
    /// Live notes, excluding the journal entry and the trashed one.
    pub notes: usize,
    pub pinned: usize,
    pub trashed: usize,
    pub journal_entries: usize,
    pub content_items: usize,
    pub revisions: usize,
    pub attachments: usize,
    pub links: usize,
    pub tags: usize,
}

/// One seeded note, as the fixture declares it.
struct DemoNote {
    id: &'static str,
    title: &'static str,
    body: &'static str,
    format: &'static str,
    pinned: bool,
    /// The notebook it is filed into, or `None` for a loose note.
    notebook: Option<&'static str>,
    /// Days before `now` it was last updated. **Two notes share one day on
    /// purpose**: the keyset page carries the pk because the sort key is not
    /// unique, and a fixture with distinct instants cannot trip the boundary the
    /// cursor exists for.
    updated_days_ago: usize,
    trashed: bool,
    /// A People-journal entry: excluded from the library, search and the
    /// powerbox, and reachable by id (#834 R-journal).
    journal: bool,
}

/// THE DEMO CORPUS. The five notes of `notes/seed.js`, plus the six rows the
/// seed cannot write.
const DEMO_NOTES: &[DemoNote] = &[
    DemoNote {
        id: "note-000001",
        title: "Tahoe long weekend — shortlist",
        body: "## Stays\n- South Lake: walkable, closer to the good food\n- Truckee: quieter, longer drive to the water\n\n## Rough budget\nCabin ~$180/night, plus gas both ways.",
        format: "markdown",
        pinned: false,
        notebook: Some("notebook-000001"),
        updated_days_ago: 1,
        trashed: false,
        journal: false,
    },
    DemoNote {
        id: "note-000002",
        title: "Drive vs fly",
        body: "I-80 is four hours clean, six if we leave Friday after five. Reno flight lands 09:40 but door-to-door is a wash. Book by Thursday either way.",
        format: "plain",
        pinned: false,
        notebook: Some("notebook-000001"),
        // SHARES A DAY with `note-000003`: the page boundary case.
        updated_days_ago: 2,
        trashed: false,
        journal: false,
    },
    DemoNote {
        id: "note-000003",
        title: "Mom's chili, written down properly",
        body: "1. Brown 2 lb chuck in batches — crowding steams it.\n2. Onion, garlic, one poblano until soft.\n3. Chili powder 3 tbsp, cumin 1 tbsp, bloom in the fat.\n4. Crushed tomatoes, beans, a splash of coffee. Two hours low.\n\n*Do not skip the coffee.*",
        format: "markdown",
        pinned: false,
        notebook: Some("notebook-000002"),
        updated_days_ago: 2,
        trashed: false,
        journal: false,
    },
    DemoNote {
        id: "note-000004",
        title: "Weeknight mac and cheese",
        body: "Boil the pasta short. Butter, flour, milk, then sharp cheddar off the heat. Freezes well in 2-portion boxes.",
        format: "plain",
        pinned: false,
        notebook: Some("notebook-000002"),
        updated_days_ago: 4,
        trashed: false,
        journal: false,
    },
    DemoNote {
        id: "note-000005",
        title: "Scratch — books people keep recommending",
        body: "The Design of Everyday Things (again), Salt Fat Acid Heat, Project Hail Mary.",
        format: "plain",
        pinned: false,
        notebook: None,
        updated_days_ago: 6,
        trashed: false,
        journal: false,
    },
    DemoNote {
        // A PIN OUTSIDE THE RECENT WINDOW. The oldest note in the corpus, so a
        // window of one reaches it only through the pinned shelf — which is the
        // whole reason the pinned read is BESIDE the window.
        id: "note-000006",
        title: "Packing list, reusable",
        body: "- [x] Passport\n- [ ] Charger\n- [ ] Kennel booking\n- [x] Snow chains",
        format: "markdown",
        pinned: true,
        notebook: Some("notebook-000001"),
        updated_days_ago: 400,
        trashed: false,
        journal: false,
    },
    DemoNote {
        // THE TRASH SHELF.
        id: "note-000007",
        title: "Reno flights — cancelled",
        body: "Refunded on the 3rd. Nothing to do.",
        format: "plain",
        pinned: false,
        notebook: Some("notebook-000001"),
        updated_days_ago: 8,
        trashed: true,
        journal: false,
    },
    DemoNote {
        // THE JOURNAL ENTRY. Excluded from the library, the trash shelf, the tag
        // chips, search and the powerbox — and reachable by id.
        id: "note-000008",
        title: "Coffee with Marco",
        body: "He is moving to Lisbon in the spring. Ask about the flat.",
        format: "plain",
        pinned: false,
        notebook: None,
        updated_days_ago: 3,
        trashed: false,
        journal: true,
    },
];

/// The two notebooks, in the order the seed creates them.
const DEMO_NOTEBOOKS: &[(&str, &str)] = &[
    ("notebook-000001", "Travel"),
    ("notebook-000002", "Recipes"),
];

/// Seed the Notes demo corpus into `connection`.
///
/// The whole run is one transaction, as v0's seeder is: a half-seeded library is
/// not a smaller fixture, it is a library whose notebook rail names notebooks
/// that do not exist.
///
/// # Errors
///
/// [`KitError::Door`] for anything SQLite refuses.
pub fn notes_demo(
    connection: &Connection,
    now: &str,
    owner_party_id: &str,
) -> KitResult<NotesDemoCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    connection.execute_batch("BEGIN IMMEDIATE").map_err(door)?;
    match seed_notes_demo(connection, now, owner_party_id) {
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

/// A note body as the vault stores it: an inline `data:` URI over the text,
/// percent-encoded, with the sha taken over the TEXT.
///
/// The sha is the TEXT's and not the URI's, which is
/// `crates/vault/src/commands/knowledge.rs`'s rule — so a fixture built here and
/// a note written by the command land on the same content id for the same words.
fn notes_body_uri(media_type: &str, text: &str) -> String {
    format!("data:{media_type};charset=utf-8,{}", percent_encode(text))
}

/// `encodeURIComponent`'s unreserved set: letters, digits and `-_.!~*'()`.
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        let character = char::from(*byte);
        if character.is_ascii_alphanumeric() || "-_.!~*'()".contains(character) {
            out.push(character);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The media type a note's `format` reads as.
fn notes_media_type(format: &str) -> &'static str {
    match format {
        "markdown" => "text/markdown",
        "html" => "text/html",
        _ => "text/plain",
    }
}

/// Insert a note body's content item, its decoded text and the note's own
/// reading of it. Returns the content id.
///
/// **DEDUPED ON THE TEXT**: two notes with the same words share one content
/// item, and each keeps its own representation (#996 R20(b), drift ONT-28).
fn seed_note_body(
    connection: &Connection,
    note_id: &str,
    text: &str,
    format: &str,
    created: &str,
    owner_party_id: &str,
    // `minted` is how many content items this RUN has minted: a SHARED counter,
    // not a per-call one. The id is `content-<n>`, so a caller that handed in a
    // fresh zero would mint `content-000001` twice and the second insert would
    // hit the primary key. The year-3 generator did exactly that, and the UNIQUE
    // constraint is what said so.
    minted: &mut usize,
) -> KitResult<String> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let media_type = notes_media_type(format);
    let sha = text_sha256(text);
    let existing: Option<String> = connection
        .query_row(
            "SELECT content_id FROM core_content_item WHERE sha256 = ?1",
            [&sha],
            |row| row.get(0),
        )
        .ok();
    let content_id = match existing {
        Some(content_id) => content_id,
        None => {
            let content_id = format!("content-{:06}", *minted + 1);
            connection
                .execute(
                    "INSERT INTO core_content_item
                       (content_id, content_uri, sha256, byte_size, language,
                        creator_party_id, origin_device_id, deleted_at, purge_at,
                        created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, NULL, NULL, ?6, ?6)",
                    rusqlite::params![
                        content_id,
                        notes_body_uri(media_type, text),
                        sha,
                        i64::try_from(text.len()).unwrap_or(i64::MAX),
                        owner_party_id,
                        created
                    ],
                )
                .map_err(door)?;
            connection
                .execute(
                    "INSERT INTO core_content_text
                       (content_id, body_text, decoder, byte_size, created_at, updated_at)
                     VALUES (?1, ?2, 'data-uri/v1', ?3, ?4, ?4)",
                    rusqlite::params![
                        content_id,
                        text,
                        i64::try_from(text.len()).unwrap_or(i64::MAX),
                        created
                    ],
                )
                .map_err(door)?;
            *minted += 1;
            content_id
        }
    };
    connection
        .execute(
            "INSERT INTO core_content_representation
               (representation_id, content_id, owner_type, owner_id, media_type,
                charset, interpretation, created_at, updated_at)
             VALUES (?1, ?2, 'knowledge.note', ?3, ?4, 'utf-8', 'body', ?5, ?5)",
            rusqlite::params![
                format!("representation-{note_id}"),
                content_id,
                note_id,
                media_type,
                created
            ],
        )
        .map_err(door)?;
    Ok(content_id)
}

/// The sha256 of a body's TEXT, in hex. Exposed so an app crate's test can hold
/// the kit's answer against `centraid_media`'s
/// (`the_fixtures_sha_is_the_one_the_command_deduplicates_on`), which is what
/// keeps a fixture-seeded note and a command-written note one content item.
#[must_use]
pub fn fixture_text_sha256(text: &str) -> String {
    text_sha256(text)
}

/// The sha256 of a body's TEXT, in hex.
///
/// The kit depends on no hashing crate, so this is the 32-bit-word reference
/// implementation of FIPS 180-4 — fifty lines, no dependency, and byte-identical
/// to `centraid_media::format::sha256_hex` over the same input (which
/// `the_fixture_sha_is_the_vaults_sha` in `crates/apps/notes` proves).
fn text_sha256(text: &str) -> String {
    const K: [u32; 64] = [
        0x428a_2f98,
        0x7137_4491,
        0xb5c0_fbcf,
        0xe9b5_dba5,
        0x3956_c25b,
        0x59f1_11f1,
        0x923f_82a4,
        0xab1c_5ed5,
        0xd807_aa98,
        0x1283_5b01,
        0x2431_85be,
        0x550c_7dc3,
        0x72be_5d74,
        0x80de_b1fe,
        0x9bdc_06a7,
        0xc19b_f174,
        0xe49b_69c1,
        0xefbe_4786,
        0x0fc1_9dc6,
        0x240c_a1cc,
        0x2de9_2c6f,
        0x4a74_84aa,
        0x5cb0_a9dc,
        0x76f9_88da,
        0x983e_5152,
        0xa831_c66d,
        0xb003_27c8,
        0xbf59_7fc7,
        0xc6e0_0bf3,
        0xd5a7_9147,
        0x06ca_6351,
        0x1429_2967,
        0x27b7_0a85,
        0x2e1b_2138,
        0x4d2c_6dfc,
        0x5338_0d13,
        0x650a_7354,
        0x766a_0abb,
        0x81c2_c92e,
        0x9272_2c85,
        0xa2bf_e8a1,
        0xa81a_664b,
        0xc24b_8b70,
        0xc76c_51a3,
        0xd192_e819,
        0xd699_0624,
        0xf40e_3585,
        0x106a_a070,
        0x19a4_c116,
        0x1e37_6c08,
        0x2748_774c,
        0x34b0_bcb5,
        0x391c_0cb3,
        0x4ed8_aa4a,
        0x5b9c_ca4f,
        0x682e_6ff3,
        0x748f_82ee,
        0x78a5_636f,
        0x84c8_7814,
        0x8cc7_0208,
        0x90be_fffa,
        0xa450_6ceb,
        0xbef9_a3f7,
        0xc671_78f2,
    ];
    let mut hash: [u32; 8] = [
        0x6a09_e667,
        0xbb67_ae85,
        0x3c6e_f372,
        0xa54f_f53a,
        0x510e_527f,
        0x9b05_688c,
        0x1f83_d9ab,
        0x5be0_cd19,
    ];
    let mut message = text.as_bytes().to_vec();
    let bit_length = (message.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_be_bytes());
    for chunk in message.chunks(64) {
        let mut words = [0u32; 64];
        for (index, word) in chunk.chunks(4).enumerate() {
            words[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let mut state = hash;
        for index in 0..64 {
            let s1 =
                state[4].rotate_right(6) ^ state[4].rotate_right(11) ^ state[4].rotate_right(25);
            let choose = (state[4] & state[5]) ^ ((!state[4]) & state[6]);
            let temp1 = state[7]
                .wrapping_add(s1)
                .wrapping_add(choose)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let s0 =
                state[0].rotate_right(2) ^ state[0].rotate_right(13) ^ state[0].rotate_right(22);
            let majority = (state[0] & state[1]) ^ (state[0] & state[2]) ^ (state[1] & state[2]);
            let temp2 = s0.wrapping_add(majority);
            state[7] = state[6];
            state[6] = state[5];
            state[5] = state[4];
            state[4] = state[3].wrapping_add(temp1);
            state[3] = state[2];
            state[2] = state[1];
            state[1] = state[0];
            state[0] = temp1.wrapping_add(temp2);
        }
        for (index, word) in state.iter().enumerate() {
            hash[index] = hash[index].wrapping_add(*word);
        }
    }
    hash.iter().map(|word| format!("{word:08x}")).collect()
}

/// The three schemes the Notes corpus needs, and their concepts.
///
/// The journal marker is People's (#834 R-journal) and it is seeded here because
/// the EXCLUSION is what the library fold is being tested on: a corpus with no
/// journal entry cannot tell an exclusion that works from one that never ran.
fn seed_notes_schemes(connection: &Connection, created: &str) -> KitResult<()> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    for (scheme_id, uri, title) in [
        (
            "demo-scheme-journal",
            NOTES_JOURNAL_SCHEME_URI,
            "People journal",
        ),
        ("demo-scheme-note-tags", NOTES_TAGS_SCHEME_URI, "Tags"),
        (
            "demo-scheme-relations",
            NOTES_RELATIONS_SCHEME_URI,
            "Link relation types",
        ),
    ] {
        connection
            .execute(
                "INSERT INTO core_concept_scheme
                   (scheme_id, uri, title, publisher, version, created_at)
                 VALUES (?1, ?2, ?3, 'centraid', '1', ?4)
                 ON CONFLICT (uri) DO NOTHING",
                rusqlite::params![scheme_id, uri, title, created],
            )
            .map_err(door)?;
    }
    for (concept_id, scheme_id, notation, label) in [
        (
            "demo-journal-entry",
            "demo-scheme-journal",
            "entry",
            "Journal entry",
        ),
        (
            "demo-tag-travel",
            "demo-scheme-note-tags",
            "travel",
            "Travel",
        ),
        (
            "demo-tag-recipes",
            "demo-scheme-note-tags",
            "recipes",
            "Recipes",
        ),
        // A non-ASCII label, because the library's tag list is sorted by
        // `localeCompare` and a byte sort is where the two diverge.
        ("demo-tag-cafe", "demo-scheme-note-tags", "café", "Café"),
        (
            "demo-relation-references",
            "demo-scheme-relations",
            "references",
            "References",
        ),
    ] {
        connection
            .execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT (scheme_id, notation) DO NOTHING",
                rusqlite::params![concept_id, scheme_id, notation, label, created],
            )
            .map_err(door)?;
    }
    Ok(())
}

#[expect(
    clippy::too_many_lines,
    reason = "one generator, one reading order; see `seed_ledger`"
)]
fn seed_notes_demo(
    connection: &Connection,
    now: &str,
    owner_party_id: &str,
) -> KitResult<NotesDemoCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let mut counts = NotesDemoCounts::default();
    let mut minted = 0usize;
    let created = format!("{now}T00:00:00.000Z");
    seed_notes_schemes(connection, &created)?;

    for (index, (collection_id, name)) in DEMO_NOTEBOOKS.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO core_collection
                   (collection_id, owner_party_id, name, cover_content_id,
                    parent_collection_id, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?5)",
                rusqlite::params![
                    collection_id,
                    owner_party_id,
                    name,
                    i64::try_from(index + 1).unwrap_or(1),
                    created
                ],
            )
            .map_err(door)?;
        counts.notebooks += 1;
    }

    let mut entry = 0usize;
    for note in DEMO_NOTES {
        let updated = format!("{}T09:00:00.000Z", day_before(now, note.updated_days_ago));
        let content_id = seed_note_body(
            connection,
            note.id,
            note.body,
            note.format,
            &created,
            owner_party_id,
            &mut minted,
        )?;
        let (deleted_at, purge_at) = if note.trashed {
            (
                Some(updated.clone()),
                Some(format!("{}T09:00:00.000Z", day_after(now, 22))),
            )
        } else {
            (None, None)
        };
        connection
            .execute(
                "INSERT INTO knowledge_note
                   (note_id, author_party_id, title, body_content_id, current_revision_id,
                    format, pinned, created_at, updated_at, deleted_at, purge_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                rusqlite::params![
                    note.id,
                    owner_party_id,
                    note.title,
                    content_id,
                    format!("revision-{}", note.id),
                    note.format,
                    i64::from(note.pinned),
                    created,
                    updated,
                    deleted_at,
                    purge_at
                ],
            )
            .map_err(door)?;
        // THE FIRST OCCURRENCE. Every note's original body is a version like any
        // other (#996 R20(a)), so the chain starts at creation and `history`
        // never has to infer one from the absence of a parent.
        connection
            .execute(
                "INSERT INTO core_entity_revision
                   (revision_id, entity_type, entity_id, operation, snapshot_json,
                    recorded_at, undo_until, undone_at, actor_party_id, invocation_id,
                    content_id, parent_revision_id, updated_at)
                 VALUES (?1, 'knowledge.note', ?2, 'revise', '{\"previous_content_id\":null}',
                         ?3, ?3, NULL, NULL, NULL, ?4, NULL, ?3)",
                rusqlite::params![
                    format!("revision-{}", note.id),
                    note.id,
                    created,
                    content_id
                ],
            )
            .map_err(door)?;
        counts.revisions += 1;
        if let Some(notebook) = note.notebook {
            entry += 1;
            connection
                .execute(
                    "INSERT INTO core_collection_entry
                       (entry_id, collection_id, target_type, target_id, position, added_at)
                     VALUES (?1, ?2, 'knowledge.note', ?3, ?4, ?5)",
                    rusqlite::params![
                        format!("entry-{entry:06}"),
                        notebook,
                        note.id,
                        i64::try_from(entry).unwrap_or(1),
                        created
                    ],
                )
                .map_err(door)?;
        }
        if note.journal {
            counts.journal_entries += 1;
            connection
                .execute(
                    "INSERT INTO core_tag
                       (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                        confidence, tagged_at, updated_at)
                     VALUES (?1, 'knowledge.note', ?2, 'demo-journal-entry', ?3, NULL, ?4, ?4)",
                    rusqlite::params![
                        format!("tag-journal-{}", note.id),
                        note.id,
                        owner_party_id,
                        created
                    ],
                )
                .map_err(door)?;
            counts.tags += 1;
        } else if note.trashed {
            counts.trashed += 1;
        } else {
            counts.notes += 1;
            if note.pinned {
                counts.pinned += 1;
            }
        }
    }

    // TAGS ON TWO LIVE NOTES AND ON THE JOURNAL ENTRY. The last one is the
    // leak the library's in-memory re-narrowing exists to stop: a journal-only
    // concept must not reach the tag chips.
    for (tag_id, note_id, concept_id) in [
        ("tag-000001", "note-000001", "demo-tag-travel"),
        ("tag-000002", "note-000003", "demo-tag-recipes"),
        ("tag-000003", "note-000003", "demo-tag-cafe"),
        ("tag-000004", "note-000008", "demo-tag-cafe"),
    ] {
        connection
            .execute(
                "INSERT INTO core_tag
                   (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                    confidence, tagged_at, updated_at)
                 VALUES (?1, 'knowledge.note', ?2, ?3, ?4, NULL, ?5, ?5)",
                rusqlite::params![tag_id, note_id, concept_id, owner_party_id, created],
            )
            .map_err(door)?;
        counts.tags += 1;
    }

    // AN ATTACHMENT on the shortlist, with its own reading of the bytes.
    let attachment_content = format!("content-{:06}", minted + 1);
    connection
        .execute(
            "INSERT INTO core_content_item
               (content_id, content_uri, sha256, byte_size, language, creator_party_id,
                origin_device_id, deleted_at, purge_at, created_at, updated_at)
             VALUES (?1, 'blob:sha256-aa', ?2, 4096, NULL, ?3, NULL, NULL, NULL, ?4, ?4)",
            rusqlite::params![
                attachment_content,
                text_sha256("the cabin's confirmation page"),
                owner_party_id,
                created
            ],
        )
        .map_err(door)?;
    minted += 1;
    counts.content_items = minted;
    connection
        .execute(
            "INSERT INTO core_attachment
               (attachment_id, target_type, target_id, content_id, role, is_primary, created_at)
             VALUES ('attachment-000001', 'knowledge.note', 'note-000001', ?1, 'receipt', 1, ?2)",
            rusqlite::params![attachment_content, created],
        )
        .map_err(door)?;
    counts.attachments += 1;
    connection
        .execute(
            "INSERT INTO core_content_representation
               (representation_id, content_id, owner_type, owner_id, media_type,
                charset, interpretation, created_at, updated_at)
             VALUES ('representation-attachment-000001', ?1, 'core.attachment',
                     'attachment-000001', 'application/pdf', NULL, 'receipt', ?2, ?2)",
            rusqlite::params![attachment_content, created],
        )
        .map_err(door)?;

    // A LINK WITH A STANDOFF ANCHOR, note→note, plus an ENDED one so the
    // `valid_to IS NULL` predicate has something to exclude.
    connection
        .execute(
            "INSERT INTO core_link
               (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                valid_from, valid_to, asserted_by, provenance_id, updated_at)
             VALUES ('link-000001', 'knowledge.note', 'note-000001', 'knowledge.note',
                     'note-000002', 'demo-relation-references', ?1, NULL, 'owner', NULL, ?1)",
            [&created],
        )
        .map_err(door)?;
    counts.links += 1;
    connection
        .execute(
            "INSERT INTO core_link_anchor
               (anchor_id, link_id, selector_json, created_at, updated_at)
             VALUES ('anchor-000001', 'link-000001',
                     '{\"exact\":\"South Lake\",\"prefix\":\"- \",\"suffix\":\":\",\"start\":11}',
                     ?1, ?1)",
            [&created],
        )
        .map_err(door)?;
    connection
        .execute(
            "INSERT INTO core_link
               (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                valid_from, valid_to, asserted_by, provenance_id, updated_at)
             VALUES ('link-000002', 'knowledge.note', 'note-000001', 'knowledge.note',
                     'note-000004', 'demo-relation-references', ?1, ?1, 'owner', NULL, ?1)",
            [&created],
        )
        .map_err(door)?;
    Ok(counts)
}

/// `start + count days`, for the trash shelf's purge instant.
fn day_after(start: &str, count: usize) -> String {
    day(start, count)
}

/// A CYCLIC REVISION CHAIN — the fixture the cycle refusal needs (D-1020-N2).
///
/// `parent_revision_id` has no constraint that forbids a cycle: the DDL's only
/// guard is the foreign key, so A→B→A is representable today and caught by a
/// reader. This writes exactly that, so the refusal has something to refuse —
/// and `contracts/migrations/002_revisions.sql` is the proposal that would make
/// the row unwritable instead.
///
/// # Errors
///
/// [`KitError::Door`] for anything SQLite refuses.
pub fn notes_revision_cycle(
    connection: &Connection,
    note_id: &str,
    now: &str,
) -> KitResult<(String, String)> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let created = format!("{now}T00:00:00.000Z");
    let head = format!("revision-cycle-head-{note_id}");
    let tail = format!("revision-cycle-tail-{note_id}");
    let content_id: String = connection
        .query_row(
            "SELECT body_content_id FROM knowledge_note WHERE note_id = ?1",
            [note_id],
            |row| row.get(0),
        )
        .map_err(door)?;
    for (revision_id, parent) in [(&head, &tail), (&tail, &head)] {
        connection
            .execute(
                "INSERT INTO core_entity_revision
                   (revision_id, entity_type, entity_id, operation, snapshot_json,
                    recorded_at, undo_until, undone_at, actor_party_id, invocation_id,
                    content_id, parent_revision_id, updated_at)
                 VALUES (?1, 'knowledge.note', ?2, 'revise', '{}', ?3, ?3, NULL, NULL, NULL,
                         ?4, ?5, ?3)",
                rusqlite::params![revision_id, note_id, created, content_id, parent],
            )
            .map_err(door)?;
    }
    // The version bump is the trigger escape — see `seed_year3_notes`.
    connection
        .execute(
            "UPDATE knowledge_note
                SET current_revision_id = ?1, row_version = row_version + 1
              WHERE note_id = ?2",
            rusqlite::params![head, note_id],
        )
        .map_err(door)?;
    Ok((head, tail))
}

/// The declared shape of year-3 Notes volume.
///
/// **A count is not a distribution.** Every field is DECLARED, and changing one
/// changes what year-3 Notes volume means repo-wide — so it moves with the
/// journey ledger's year-3 table and a version bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3NotesShape {
    /// Notes, live and trashed together.
    pub notes: usize,
    /// How many of them are in the trash.
    pub trashed: usize,
    /// How many carry a pin. Every one is read BESIDE the window.
    pub pinned: usize,
    /// How many are People-journal entries — excluded from the library, search
    /// and the powerbox, and the set every one of those folds re-narrows over.
    pub journal_entries: usize,
    /// Notebooks, and how many notes are filed into one.
    pub notebooks: usize,
    pub filed: usize,
    /// Free-form labels, and how many notes carry one.
    pub labels: usize,
    pub labelled: usize,
    /// Occurrences beyond the first, spread over the notes.
    pub extra_versions: usize,
    /// `[[wikilink]]` references, and how many carry a standoff anchor.
    pub links: usize,
    pub anchored: usize,
    /// The length of a LONG body, in bytes of text. Under the 64 KiB inline
    /// budget on purpose: a body over it is unwritable, so year-3 volume is the
    /// largest body the product actually holds.
    pub long_body_bytes: usize,
    /// How many notes carry one.
    pub long_bodies: usize,
}

/// THE YEAR-3 NOTES PROFILE: 10,000 notes against a 2,000-row window, 600 of
/// them carrying a 48 KiB body.
///
/// The numbers a ceiling is stated at, and each one is the reason it is here:
///
/// * **10,000 notes against a 2,000-row window.** The library's declared
///   maximum is 2,000 (`library.limit`), so a year-3 library is five windows
///   deep — and twenty pages deep at `MAX_PAGE_ROWS`, which is what makes
///   D-1020-D3-12's "walked, not clamped" divergence measurable rather than
///   theoretical.
/// * **200 pinned notes, which is `SHELF_ROWS` exactly.** The pinned shelf is
///   read beside the window at 200 rows, so a profile at the shelf's own size is
///   the case where the shelf fills and says nothing more is owed.
/// * **600 long bodies at 48 KiB.** A list row carries a 200-character preview,
///   so the fold decodes 28 MB of text to draw 120 KB of shelf. That ratio is
///   the whole reason `preview` exists, and the number is what makes it a
///   measurement rather than an argument.
/// * **1,200 journal entries.** Every one of the four excluding folds
///   re-narrows over this set in memory, so the exclusion's own cost is part of
///   the library's.
pub const YEAR3_NOTES: Year3NotesShape = Year3NotesShape {
    notes: 10_000,
    trashed: 400,
    pinned: 200,
    journal_entries: 1_200,
    notebooks: 60,
    filed: 6_000,
    labels: 300,
    labelled: 3_000,
    extra_versions: 2_000,
    links: 1_500,
    anchored: 700,
    long_body_bytes: 48 * 1024,
    long_bodies: 600,
};

/// What one year-3 Notes seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Year3NotesCounts {
    pub notes: usize,
    pub live_notes: usize,
    pub trashed: usize,
    pub pinned: usize,
    pub journal_entries: usize,
    pub notebooks: usize,
    pub content_items: usize,
    pub revisions: usize,
    pub tags: usize,
    pub links: usize,
    pub anchors: usize,
    /// Bytes of note text this fixture holds, which is what a fold that decodes
    /// every body is actually reading.
    pub body_bytes: usize,
}

/// Seed the Notes axis of year-3 volume.
///
/// **Update instants repeat on purpose.** Notes share an `updated_at` in pairs,
/// because the keyset page's whole reason for carrying the pk is that the sort
/// key is not unique (#1020 apps seam 3) — a 10,000-note fixture with distinct
/// instants cannot trip the page boundary the cursor exists for.
///
/// # Errors
///
/// [`KitError::Door`] for anything SQLite refuses.
pub fn year3_notes(
    connection: &Connection,
    shape: Year3NotesShape,
    seed: u64,
) -> KitResult<Year3NotesCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    connection.execute_batch("BEGIN IMMEDIATE").map_err(door)?;
    match seed_year3_notes(connection, shape, seed) {
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
fn seed_year3_notes(
    connection: &Connection,
    shape: Year3NotesShape,
    seed: u64,
) -> KitResult<Year3NotesCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let mut stream = Seeded::new(seed);
    let mut counts = Year3NotesCounts::default();
    let mut minted = 0usize;
    let start = "2097-01-01";
    let created = format!("{start}T00:00:00.000Z");
    seed_notes_schemes(connection, &created)?;
    connection
        .execute(
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
             VALUES (?1, 'person', 'Year Three', ?2, ?2)
             ON CONFLICT (party_id) DO NOTHING",
            rusqlite::params![YEAR3_OWNER_PARTY, created],
        )
        .map_err(door)?;

    for index in 0..shape.notebooks {
        connection
            .execute(
                "INSERT INTO core_collection
                   (collection_id, owner_party_id, name, cover_content_id,
                    parent_collection_id, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?5)",
                rusqlite::params![
                    id("notebook", index),
                    YEAR3_OWNER_PARTY,
                    format!("Notebook {index:04}"),
                    i64::try_from(index + 1).unwrap_or(1),
                    created
                ],
            )
            .map_err(door)?;
        counts.notebooks += 1;
    }

    // The LABEL concepts, so the tag chips have somewhere to resolve.
    for index in 0..shape.labels {
        connection
            .execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
                 VALUES (?1, 'demo-scheme-note-tags', ?2, ?3, ?4, ?4)",
                rusqlite::params![
                    id("concept", index),
                    format!("label-{index:04}"),
                    format!("Label {index:04}"),
                    created
                ],
            )
            .map_err(door)?;
    }

    // THE LONG BODY, written ONCE and rented by every note that carries one:
    // bodies are sha256-deduped, so 600 notes over one 48 KiB body is what the
    // product actually stores — and it is also the case a fold that decodes per
    // ROW rather than per CONTENT gets wrong.
    let long_text = "lorem ipsum dolor sit amet ".repeat(shape.long_body_bytes / 27 + 1);
    let long_text = &long_text[..shape.long_body_bytes.min(long_text.len())];

    let mut entry = 0usize;
    let mut tags = 0usize;
    for index in 0..shape.notes {
        let note_id = id("note", index);
        let long = index % (shape.notes / shape.long_bodies.max(1)).max(1) == 0
            && counts.body_bytes / shape.long_body_bytes.max(1) < shape.long_bodies;
        let body = if long {
            long_text.to_owned()
        } else {
            format!(
                "Note {index:05}\n- [ ] follow up\n- [x] filed\n\nA short body, {} words.",
                stream.upto(40) + 3
            )
        };
        let content_id = seed_note_body(
            connection,
            &note_id,
            &body,
            if index % 2 == 0 { "markdown" } else { "plain" },
            &created,
            YEAR3_OWNER_PARTY,
            &mut minted,
        )?;
        counts.body_bytes += body.len();
        // INSTANTS REPEAT IN PAIRS.
        let updated = format!("{}T09:00:00.000Z", day(start, index / 2));
        let trashed = index < shape.trashed;
        let pinned = !trashed && index >= shape.trashed && index < shape.trashed + shape.pinned;
        let journal = !trashed
            && index >= shape.trashed + shape.pinned
            && index < shape.trashed + shape.pinned + shape.journal_entries;
        connection
            .execute(
                "INSERT INTO knowledge_note
                   (note_id, author_party_id, title, body_content_id, current_revision_id,
                    format, pinned, created_at, updated_at, deleted_at, purge_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                rusqlite::params![
                    note_id,
                    YEAR3_OWNER_PARTY,
                    format!("Note {index:05}"),
                    content_id,
                    id("revision", index),
                    if index % 2 == 0 { "markdown" } else { "plain" },
                    i64::from(pinned),
                    created,
                    updated,
                    if trashed { Some(updated.clone()) } else { None },
                    if trashed {
                        Some(format!("{}T09:00:00.000Z", day(start, index / 2 + 30)))
                    } else {
                        None
                    }
                ],
            )
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO core_entity_revision
                   (revision_id, entity_type, entity_id, operation, snapshot_json,
                    recorded_at, undo_until, undone_at, actor_party_id, invocation_id,
                    content_id, parent_revision_id, updated_at)
                 VALUES (?1, 'knowledge.note', ?2, 'revise', '{\"previous_content_id\":null}',
                         ?3, ?3, NULL, NULL, NULL, ?4, NULL, ?3)",
                rusqlite::params![id("revision", index), note_id, created, content_id],
            )
            .map_err(door)?;
        counts.notes += 1;
        counts.revisions += 1;
        counts.content_items = minted;
        if trashed {
            counts.trashed += 1;
        } else {
            counts.live_notes += 1;
        }
        if pinned {
            counts.pinned += 1;
        }
        if journal {
            connection
                .execute(
                    "INSERT INTO core_tag
                       (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                        confidence, tagged_at, updated_at)
                     VALUES (?1, 'knowledge.note', ?2, 'demo-journal-entry', ?3, NULL, ?4, ?4)",
                    rusqlite::params![id("tag", tags), note_id, YEAR3_OWNER_PARTY, created],
                )
                .map_err(door)?;
            tags += 1;
            counts.tags += 1;
            counts.journal_entries += 1;
        }
        if index < shape.filed {
            entry += 1;
            connection
                .execute(
                    "INSERT INTO core_collection_entry
                       (entry_id, collection_id, target_type, target_id, position, added_at)
                     VALUES (?1, ?2, 'knowledge.note', ?3, ?4, ?5)",
                    rusqlite::params![
                        id("entry", entry),
                        id("notebook", index % shape.notebooks.max(1)),
                        note_id,
                        i64::try_from(entry).unwrap_or(1),
                        created
                    ],
                )
                .map_err(door)?;
        }
        if index < shape.labelled {
            connection
                .execute(
                    "INSERT INTO core_tag
                       (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                        confidence, tagged_at, updated_at)
                     VALUES (?1, 'knowledge.note', ?2, ?3, ?4, NULL, ?5, ?5)",
                    rusqlite::params![
                        id("tag", tags),
                        note_id,
                        id("concept", index % shape.labels.max(1)),
                        YEAR3_OWNER_PARTY,
                        created
                    ],
                )
                .map_err(door)?;
            tags += 1;
            counts.tags += 1;
        }
    }

    // THE EXTRA OCCURRENCES. Each one's parent is the note's previous head, so
    // the chain a `history` read walks is as deep as the fixture says.
    for index in 0..shape.extra_versions {
        let note = index % shape.notes.max(1);
        let note_id = id("note", note);
        let revision_id = format!("{}-v{index:06}", id("revision", note));
        let parent: String = connection
            .query_row(
                "SELECT current_revision_id FROM knowledge_note WHERE note_id = ?1",
                [&note_id],
                |row| row.get(0),
            )
            .map_err(door)?;
        let content_id: String = connection
            .query_row(
                "SELECT body_content_id FROM knowledge_note WHERE note_id = ?1",
                [&note_id],
                |row| row.get(0),
            )
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO core_entity_revision
                   (revision_id, entity_type, entity_id, operation, snapshot_json,
                    recorded_at, undo_until, undone_at, actor_party_id, invocation_id,
                    content_id, parent_revision_id, updated_at)
                 VALUES (?1, 'knowledge.note', ?2, 'revise', '{}', ?3, ?3, NULL, NULL, NULL,
                         ?4, ?5, ?3)",
                rusqlite::params![revision_id, note_id, created, content_id, parent],
            )
            .map_err(door)?;
        // **THE UPDATE BUMPS `row_version` ITSELF, AND THAT IS NOT COSMETIC.**
        // `knowledge_note_touch_updated_at` fires `WHEN NEW.row_version =
        // OLD.row_version` and stamps `updated_at` with the HOST clock — so an
        // ordinary update here would date every note with extra versions to the
        // moment the fixture was generated, and the corpus would stop being
        // byte-reproducible. `two_runs_of_one_seed_write_the_same_corpus` is
        // what found it. Bumping the version is the same escape an applier
        // takes: the writer owns the version, so the trigger stands aside.
        connection
            .execute(
                "UPDATE knowledge_note
                    SET current_revision_id = ?1, row_version = row_version + 1
                  WHERE note_id = ?2",
                rusqlite::params![revision_id, note_id],
            )
            .map_err(door)?;
        counts.revisions += 1;
    }

    for index in 0..shape.links {
        let from = id("note", index % shape.notes.max(1));
        let to = id("note", (index + 7) % shape.notes.max(1));
        if from == to {
            continue;
        }
        let link_id = id("link", index);
        connection
            .execute(
                "INSERT INTO core_link
                   (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                    valid_from, valid_to, asserted_by, provenance_id, updated_at)
                 VALUES (?1, 'knowledge.note', ?2, 'knowledge.note', ?3,
                         'demo-relation-references', ?4, NULL, 'owner', NULL, ?4)",
                rusqlite::params![link_id, from, to, created],
            )
            .map_err(door)?;
        counts.links += 1;
        if index < shape.anchored {
            connection
                .execute(
                    "INSERT INTO core_link_anchor
                       (anchor_id, link_id, selector_json, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    rusqlite::params![
                        id("anchor", index),
                        link_id,
                        format!(
                            "{{\"exact\":\"follow up\",\"prefix\":\"- [ ] \",\"suffix\":\"\",\"start\":{}}}",
                            stream.upto(40)
                        ),
                        created
                    ],
                )
                .map_err(door)?;
            counts.anchors += 1;
        }
    }
    Ok(counts)
}

/// ONE NOTE, exactly as a screen fixture describes it (#1020, D-1020-N5).
///
/// `contracts/screens/notes/*.bin` are `NotesEditorState` messages carrying a
/// title, a body and a format; this seeds the row that answers one, so the
/// editor contract is checked against the HANDLER and not only against a
/// renderer. It is here rather than in `crates/apps/notes/tests` for the reason
/// [`notes_demo`] is: `sql-confinement` scans an app crate's tests too.
///
/// # Errors
///
/// [`KitError::Door`] for anything SQLite refuses.
pub fn notes_editor_note(
    connection: &Connection,
    note_id: &str,
    title: &str,
    body: &str,
    format: &str,
    now: &str,
    owner_party_id: &str,
) -> KitResult<String> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let created = format!("{now}T00:00:00.000Z");
    let mut minted = 0usize;
    let content_id = seed_note_body(
        connection,
        note_id,
        body,
        format,
        &created,
        owner_party_id,
        &mut minted,
    )?;
    connection
        .execute(
            "INSERT INTO knowledge_note
               (note_id, author_party_id, title, body_content_id, current_revision_id,
                format, pinned, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, 0, ?6, ?6)",
            rusqlite::params![note_id, owner_party_id, title, content_id, format, created],
        )
        .map_err(door)?;
    Ok(content_id)
}

// ---------------------------------------------------------------------------
// THE PEOPLE AXIS OF YEAR-3 VOLUME (#1020, wave 4 slot 4c, D-1020-D3-7).
// ---------------------------------------------------------------------------

/// The declared shape of year-3 People volume.
///
/// **The gap this fills.** v0's year-3 generator writes 5,000 `core_party` rows
/// and **no `people_profile`, no `people_important_date`, no reminder and no
/// list at all** (`packages/test-kit/src/year3-vault.ts:77`-`:92`; `grep -c
/// people_profile` over the whole generator is zero). So People's stated
/// ceilings — the 20–10,000 roster window, the dashboard's 9,999-row fold, the
/// 500-row trash shelf — have no golden artifact behind them, which is the same
/// hole lane D3 found under Tally's ledger. A window nobody can seed is a window
/// nobody can hold.
///
/// **A count is not a distribution** (`year3-shape.ts:18`-`:25`): every field
/// here is *declared*, and changing one changes what year-3 People volume means
/// repo-wide, so it moves with the journey ledger's year-3 table and a version
/// bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Year3PeopleShape {
    /// CRM people — a `people_profile` over a `core_party`. Five thousand is
    /// v0's own `parties` count, so the two axes describe one vault.
    pub people: usize,
    /// In reversible trash, so the 500-row shelf has something to clamp.
    pub trashed: usize,
    /// Starred — **a flags-scheme tag on the PARTY**, not a column, so the
    /// fixture exercises the join every People surface makes.
    pub starred: usize,
    /// Owner lists, and how many people are filed into one.
    pub lists: usize,
    pub filed: usize,
    /// Important dates, and how many carry a live reminder. The dashboard's
    /// Upcoming rail is a fold over the reminders alone.
    pub important_dates: usize,
    pub reminders: usize,
    /// Logged interactions: an activity, an `about` link and an annotation each.
    pub interactions: usize,
    /// The owner's own notes on people.
    pub notes: usize,
    /// Live share bindings, which is what `linked` counts. **At most one per
    /// party** — the DDL's partial unique index says so — so this is also the
    /// number of linked people.
    pub bindings: usize,
    /// Open obligations, the cross-app table People reads and Tally owns.
    pub obligations: usize,
    /// The first day a person was added; every person is one day later.
    pub start: &'static str,
}

/// THE YEAR-3 PEOPLE PROFILE: five thousand people over a 10,000-row window,
/// with 250 in the trash and 12,000 important dates.
///
/// The numbers a ceiling is stated at, and each one is the reason it is here:
///
/// * **5,000 people against a declared 10,000-row window.** The roster's
///   maximum is the widest in the tree and nothing explains it (D-1020-PE4), so
///   the fixture sits inside it on purpose: what the year-3 run measures is the
///   walk, not the refusal.
/// * **250 trashed against a 500-row shelf.** The trash shelf is the one People
///   read whose sort column is nullable, so it cannot be continued past one
///   page (D-1020-PE5) — and a fixture of 250 proves the shelf without tripping
///   the refusal a fixture of 600 would.
/// * **12,000 important dates, 6,000 of them reminding.** The dashboard folds
///   Upcoming over every live reminder in one window, so the rail's cost is the
///   reminder count and not the person count.
/// * **20,000 interactions over 5,000 people.** The recent rail reads 30, and
///   the `IN`-bounded activity-link read that bounds it is over the whole
///   roster window — which is where the fan-out is felt.
pub const YEAR3_PEOPLE: Year3PeopleShape = Year3PeopleShape {
    people: 5_000,
    trashed: 250,
    starred: 400,
    lists: 20,
    filed: 3_000,
    important_dates: 12_000,
    reminders: 6_000,
    interactions: 20_000,
    notes: 4_000,
    bindings: 900,
    obligations: 600,
    start: "2097-01-01",
};

/// What one year-3 People seeding wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Year3PeopleCounts {
    pub parties: usize,
    pub profiles: usize,
    pub live_profiles: usize,
    pub trashed: usize,
    pub starred: usize,
    pub lists: usize,
    pub tags: usize,
    pub important_dates: usize,
    pub reminders: usize,
    pub activities: usize,
    pub links: usize,
    pub annotations: usize,
    pub bindings: usize,
    pub obligations: usize,
}

/// Seed the People axis of year-3 volume into `connection`.
///
/// **Creation instants repeat on purpose.** People share a `created_at` in
/// pairs, because the keyset page's whole reason for carrying the pk is that
/// the sort key is not unique (#1020 apps seam 3) — a 5,000-person fixture with
/// distinct instants cannot trip the page boundary the cursor exists for, and
/// the roster's window is exactly such a walk.
///
/// The whole run is one transaction, as v0's seeder is (`year3-vault.ts:66`): a
/// half-seeded roster is not a smaller fixture, it is a roster whose counts do
/// not reconcile.
pub fn year3_people(
    connection: &Connection,
    shape: Year3PeopleShape,
    seed: u64,
) -> KitResult<Year3PeopleCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    connection.execute_batch("BEGIN IMMEDIATE").map_err(door)?;
    match seed_year3_people(connection, shape, seed) {
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

/// The scheme and concept ids the People axis files into, created once.
const PEOPLE_LIST_SCHEME: &str = "y3-scheme-lists";
const PEOPLE_FLAGS_SCHEME: &str = "y3-scheme-flags";
const PEOPLE_RELATIONS_SCHEME: &str = "y3-scheme-relations";
const PEOPLE_STARRED_CONCEPT: &str = "y3-concept-starred";
const PEOPLE_ABOUT_CONCEPT: &str = "y3-concept-about";
const PEOPLE_TOUCH_CONCEPT: &str = "y3-concept-touch";

#[expect(
    clippy::too_many_lines,
    reason = "one generator, one reading order; see `seed_ledger`"
)]
fn seed_year3_people(
    connection: &Connection,
    shape: Year3PeopleShape,
    seed: u64,
) -> KitResult<Year3PeopleCounts> {
    let door = |error: rusqlite::Error| KitError::Door(error.to_string());
    let mut stream = Seeded::new(seed);
    let mut counts = Year3PeopleCounts::default();
    let created = format!("{}T00:00:00.000Z", shape.start);

    connection
        .execute(
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
             VALUES (?1, 'person', 'Year Three', ?2, ?2)",
            rusqlite::params![YEAR3_OWNER_PARTY, created],
        )
        .map_err(door)?;
    counts.parties += 1;

    // --- the vocabulary: three schemes, the star, the two relation concepts
    // and the owner's lists.
    for (scheme_id, uri, title) in [
        (
            PEOPLE_LIST_SCHEME,
            "https://centraid.dev/schemes/lists",
            "Lists",
        ),
        (
            PEOPLE_FLAGS_SCHEME,
            "https://centraid.dev/schemes/flags",
            "Flags",
        ),
        (
            PEOPLE_RELATIONS_SCHEME,
            "urn:duaility:relations",
            "Link relation types",
        ),
    ] {
        connection
            .execute(
                "INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version, created_at)
                 VALUES (?1, ?2, ?3, 'centraid', '1', ?4)",
                rusqlite::params![scheme_id, uri, title, created],
            )
            .map_err(door)?;
    }
    for (concept_id, scheme_id, notation, label) in [
        (
            PEOPLE_STARRED_CONCEPT,
            PEOPLE_FLAGS_SCHEME,
            "starred",
            "Starred",
        ),
        (
            PEOPLE_ABOUT_CONCEPT,
            PEOPLE_RELATIONS_SCHEME,
            "about",
            "About",
        ),
        (
            PEOPLE_TOUCH_CONCEPT,
            PEOPLE_RELATIONS_SCHEME,
            "call",
            "Call",
        ),
    ] {
        connection
            .execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                    broader_concept_id, definition, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5, ?5)",
                rusqlite::params![concept_id, scheme_id, notation, label, created],
            )
            .map_err(door)?;
    }
    for index in 0..shape.lists {
        connection
            .execute(
                "INSERT INTO core_concept
                   (concept_id, scheme_id, notation, pref_label, alt_labels_json,
                    broader_concept_id, definition, created_at, updated_at)
                 VALUES (?1, ?2, ?1, ?3, NULL, NULL, NULL, ?4, ?4)",
                rusqlite::params![
                    id("y3-list", index),
                    PEOPLE_LIST_SCHEME,
                    format!("List {index:06}"),
                    created
                ],
            )
            .map_err(door)?;
        counts.lists += 1;
    }

    // --- the people. TWO PER CREATION INSTANT, so the keyset's pk tiebreak is
    // exercised at every page boundary of the roster's walk.
    for index in 0..shape.people {
        let party_id = id("y3-person", index);
        let added = day(shape.start, index / 2);
        let stamped = format!("{added}T09:00:00.000Z");
        connection
            .execute(
                "INSERT INTO core_party
                   (party_id, kind, display_name, sort_name, birth_date,
                    avatar_content_id, created_at, updated_at)
                 VALUES (?1, 'person', ?2, NULL, NULL, NULL, ?3, ?3)",
                rusqlite::params![party_id, format!("Person {index:06}"), stamped],
            )
            .map_err(door)?;
        counts.parties += 1;
        // A CADENCE OF ZERO IS "NO CADENCE" and is never overdue, so one person
        // in five carries one — the Reconnect fold has to have something to
        // exclude as well as something to include.
        let cadence = if index % 5 == 0 { 0 } else { 7 + (index % 90) };
        let trashed = index < shape.trashed;
        connection
            .execute(
                "INSERT INTO people_profile
                   (profile_id, party_id, role, nickname, avatar_color, cadence_days,
                    last_contacted_at, met, created_at, updated_at, deleted_at, purge_at)
                 VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, NULL, ?6, ?6, ?7, ?8)",
                rusqlite::params![
                    id("y3-profile", index),
                    party_id,
                    format!("Role {}", index % 40),
                    i64::try_from(cadence).unwrap_or_default(),
                    (index % 3 == 0).then(|| format!("{}T09:00:00.000Z", day(shape.start, index))),
                    stamped,
                    trashed.then(|| stamped.clone()),
                    trashed.then(|| format!("{}T09:00:00.000Z", day(shape.start, index + 30))),
                ],
            )
            .map_err(door)?;
        counts.profiles += 1;
        if trashed {
            counts.trashed += 1;
        } else {
            counts.live_profiles += 1;
        }
    }

    // --- the star, and the filing. Both are `core_tag` rows on the PARTY, which
    // is the join every People surface makes.
    let mut tag_index = 0usize;
    for index in 0..shape.starred.min(shape.people) {
        connection
            .execute(
                "INSERT INTO core_tag
                   (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                    confidence, tagged_at, updated_at)
                 VALUES (?1, 'core.party', ?2, ?3, ?4, NULL, ?5, ?5)",
                rusqlite::params![
                    id("y3-tag", tag_index),
                    id("y3-person", index * 7 % shape.people),
                    PEOPLE_STARRED_CONCEPT,
                    YEAR3_OWNER_PARTY,
                    created
                ],
            )
            .map_err(door)?;
        tag_index += 1;
        counts.starred += 1;
        counts.tags += 1;
    }
    for index in 0..shape.filed.min(shape.people) {
        connection
            .execute(
                "INSERT INTO core_tag
                   (tag_id, target_type, target_id, concept_id, tagged_by_party_id,
                    confidence, tagged_at, updated_at)
                 VALUES (?1, 'core.party', ?2, ?3, ?4, NULL, ?5, ?5)",
                rusqlite::params![
                    id("y3-tag", tag_index),
                    id("y3-person", index),
                    id("y3-list", index % shape.lists.max(1)),
                    YEAR3_OWNER_PARTY,
                    created
                ],
            )
            .map_err(door)?;
        tag_index += 1;
        counts.tags += 1;
    }

    // --- the important dates. Half remind, and **one in every hundred is a
    // leap day**, because `02-29` is the case the birthday rail clamps
    // (D-1020-PE7) and a fixture without one cannot show it.
    for index in 0..shape.important_dates {
        let party = index % shape.people;
        let leap = index % 100 == 0;
        let month = if leap { 2 } else { 1 + (index % 12) };
        let day_of_month = if leap { 29 } else { 1 + (index % 28) };
        let reminder = i64::from(index < shape.reminders);
        connection
            .execute(
                "INSERT INTO people_important_date
                   (date_id, party_id, label, month_day, reminder_on, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                rusqlite::params![
                    id("y3-date", index),
                    id("y3-person", party),
                    if leap { "Birthday" } else { "Anniversary" },
                    format!("{month:02}-{day_of_month:02}"),
                    reminder,
                    created
                ],
            )
            .map_err(door)?;
        counts.important_dates += 1;
        if reminder == 1 {
            counts.reminders += 1;
        }
    }

    // --- the interactions: an activity, an `about` link and an annotation each.
    // The link and annotation indexes ARE the interaction index here, and the
    // annotation index carries on past it for the owner's own notes below.
    let mut annotation_index = 0usize;
    for index in 0..shape.interactions {
        let party = stream.upto(shape.people);
        let activity_id = id("y3-activity", index);
        let at = format!(
            "{}T{:02}:00:00.000Z",
            day(shape.start, index / 20),
            index % 24
        );
        connection
            .execute(
                "INSERT INTO core_activity
                   (activity_id, actor_party_id, kind_concept_id, started_at, ended_at,
                    location_place_id, source_app_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?4)",
                rusqlite::params![activity_id, YEAR3_OWNER_PARTY, PEOPLE_TOUCH_CONCEPT, at],
            )
            .map_err(door)?;
        counts.activities += 1;
        connection
            .execute(
                "INSERT INTO core_link
                   (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                    valid_from, valid_to, asserted_by, provenance_id, updated_at)
                 VALUES (?1, 'core.activity', ?2, 'core.party', ?3, ?4, ?5, NULL, 'owner', NULL, ?5)",
                rusqlite::params![
                    id("y3-link", index),
                    activity_id,
                    id("y3-person", party),
                    PEOPLE_ABOUT_CONCEPT,
                    at
                ],
            )
            .map_err(door)?;
        counts.links += 1;
        connection
            .execute(
                "INSERT INTO knowledge_annotation
                   (annotation_id, author_party_id, target_type, target_id, selector_json,
                    body_text, created_at, updated_at)
                 VALUES (?1, ?2, 'core.activity', ?3, NULL, ?4, ?5, ?5)",
                rusqlite::params![
                    id("y3-annotation", annotation_index),
                    YEAR3_OWNER_PARTY,
                    activity_id,
                    format!("Touch {index:06}"),
                    at
                ],
            )
            .map_err(door)?;
        annotation_index += 1;
        counts.annotations += 1;
    }

    // --- the owner's own notes, on the PARTY rather than on an activity.
    for index in 0..shape.notes {
        connection
            .execute(
                "INSERT INTO knowledge_annotation
                   (annotation_id, author_party_id, target_type, target_id, selector_json,
                    body_text, created_at, updated_at)
                 VALUES (?1, ?2, 'core.party', ?3, NULL, ?4, ?5, ?5)",
                rusqlite::params![
                    id("y3-annotation", annotation_index),
                    YEAR3_OWNER_PARTY,
                    id("y3-person", index % shape.people),
                    format!("Note {index:06}"),
                    format!("{}T12:00:00.000Z", day(shape.start, index / 4))
                ],
            )
            .map_err(door)?;
        annotation_index += 1;
        counts.annotations += 1;
    }

    // --- the share plane. AT MOST ONE LIVE BINDING PER PARTY: the DDL carries a
    // partial unique index on `(party_id) WHERE revoked_at IS NULL`, which is
    // why `vault_count` is 0 or 1 and never more (finding PE-F6).
    for index in 0..shape.bindings.min(shape.people) {
        connection
            .execute(
                "INSERT INTO share_party_vault_binding
                   (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
                 VALUES (?1, ?2, ?3, NULL, ?4, NULL)",
                rusqlite::params![
                    id("y3-binding", index),
                    id("y3-person", index * 5 % shape.people),
                    id("y3-vault", index),
                    created
                ],
            )
            .map_err(door)?;
        counts.bindings += 1;
    }

    // --- the obligations. TALLY'S TABLE, and the only cross-app read in the
    // tree: an empty one would make the person sheet's debts rail unmeasurable.
    for index in 0..shape.obligations {
        let other = id("y3-person", index % shape.people);
        connection
            .execute(
                "INSERT INTO tally_obligation
                   (obligation_id, from_party, to_party, amount_minor, currency, reason,
                    incurred_on, settled_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'GBP', ?5, ?6, ?7, ?8, ?8)",
                rusqlite::params![
                    id("y3-obligation", index),
                    if index % 2 == 0 {
                        YEAR3_OWNER_PARTY.to_owned()
                    } else {
                        other.clone()
                    },
                    if index % 2 == 0 {
                        other
                    } else {
                        YEAR3_OWNER_PARTY.to_owned()
                    },
                    i64::try_from(100 + index * 7).unwrap_or_default(),
                    format!("Reason {index:04}"),
                    day(shape.start, index),
                    // ONE IN FOUR IS SETTLED, so the sheet's open-debt filter
                    // has something to exclude.
                    (index % 4 == 0).then(|| created.clone()),
                    created
                ],
            )
            .map_err(door)?;
        counts.obligations += 1;
    }

    Ok(counts)
}
