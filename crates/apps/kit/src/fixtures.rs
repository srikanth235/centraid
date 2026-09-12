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
//! this connection, because `crates/vault`'s command path does not exist yet
//! (lane D1). The row *values* are the ones the commands produce — resolved
//! splits that sum to the amount, a full payer set including the degenerate
//! single-payer row, a group-scoped currency every expense in it agrees with —
//! so the same generator re-points at `Vault::invoke` without the fixture
//! changing. The tables it creates are the ledger subset of
//! `contracts/schema/vault-ddl.sql` with the cross-band foreign keys dropped;
//! it is a **stand-in for the vault's own DDL, not a second schema**, and the
//! receipt records the swap as a follow-up.

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

/// The ledger subset of the vault's DDL. See the module note: a stand-in until
/// `crates/vault` can be asked to create it.
pub const LEDGER_DDL: &str = "\
CREATE TABLE IF NOT EXISTS core_party (
  party_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  sort_name TEXT,
  kind TEXT NOT NULL DEFAULT 'person',
  deleted_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS core_vault (
  vault_id TEXT PRIMARY KEY,
  self_party_id TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'UTC'
) STRICT;
CREATE TABLE IF NOT EXISTS social_circle (
  circle_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'household'
) STRICT;
CREATE TABLE IF NOT EXISTS social_circle_member (
  member_id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  departed_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS tally_friend (
  friend_id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tally_group (
  group_id TEXT PRIMARY KEY,
  circle_id TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL,
  color TEXT NOT NULL,
  simplify_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (simplify_opt_in IN (0,1)),
  archived_at TEXT,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tally_expense (
  expense_id TEXT PRIMARY KEY,
  group_id TEXT,
  description TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  paid_by TEXT NOT NULL,
  split_method TEXT NOT NULL DEFAULT 'exact',
  split_params_json TEXT,
  spent_on TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  purge_at TEXT,
  settlement_currency TEXT,
  recurring_template_id TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS tally_expense_split (
  expense_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  share_minor INTEGER NOT NULL CHECK (share_minor >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (expense_id, party_id)
) STRICT;
CREATE TABLE IF NOT EXISTS tally_expense_payer (
  expense_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  paid_minor INTEGER NOT NULL CHECK (paid_minor >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (expense_id, party_id)
) STRICT;
CREATE TABLE IF NOT EXISTS tally_settlement (
  settlement_id TEXT PRIMARY KEY,
  group_id TEXT,
  from_party TEXT NOT NULL,
  to_party TEXT NOT NULL CHECK (to_party <> from_party),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  paid_on TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS tally_obligation (
  obligation_id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT,
  settled_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tally_nudge (
  nudge_id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  group_id TEXT,
  as_of_minor INTEGER NOT NULL,
  note TEXT,
  prepared_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS tally_recurring_expense (
  template_id TEXT PRIMARY KEY,
  group_id TEXT,
  description TEXT NOT NULL,
  original_amount_minor INTEGER NOT NULL,
  original_currency TEXT NOT NULL,
  settlement_currency TEXT,
  paid_by TEXT NOT NULL,
  category TEXT NOT NULL,
  rrule TEXT NOT NULL,
  anchor_start TEXT NOT NULL,
  tz TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;";

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
    connection.execute_batch(LEDGER_DDL).map_err(door)?;
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
        .prepare("INSERT INTO core_party (party_id, display_name, sort_name) VALUES (?, ?, ?)")
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
            .execute(rusqlite::params![party, name, name])
            .map_err(door)?;
        if index > 0 {
            insert_friend
                .execute(rusqlite::params![id("friend", index), party, created])
                .map_err(door)?;
        }
    }
    connection
        .execute(
            "INSERT INTO core_vault (vault_id, self_party_id, base_currency) VALUES (?, ?, ?)",
            rusqlite::params!["vault-000000", YEAR3_OWNER_PARTY, shape.currencies[0]],
        )
        .map_err(door)?;

    // --- groups: a circle, its members, and the group that decorates it.
    let mut insert_circle = connection
        .prepare("INSERT INTO social_circle (circle_id, name) VALUES (?, ?)")
        .map_err(door)?;
    let mut insert_member = connection
        .prepare(
            "INSERT INTO social_circle_member (member_id, circle_id, party_id) VALUES (?, ?, ?)",
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
            .execute(rusqlite::params![circle, format!("Group {index:04}")])
            .map_err(door)?;
        let mut roster = vec![YEAR3_OWNER_PARTY.to_owned()];
        insert_member
            .execute(rusqlite::params![
                id("member", index * shape.members_per_group),
                circle,
                YEAR3_OWNER_PARTY
            ])
            .map_err(door)?;
        for seat in 1..shape.members_per_group {
            let which = 1 + (index * (shape.members_per_group - 1) + seat - 1) % shape.parties;
            let party = id("party", which);
            insert_member
                .execute(rusqlite::params![
                    id("member", index * shape.members_per_group + seat),
                    circle,
                    party
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
                paid_by, category, rrule, anchor_start, tz, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'FREQ=MONTHLY', ?, 'Europe/London', ?, ?)",
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

    fn seeded(shape: Year3TallyShape, seed: u64) -> (Connection, Year3TallyCounts) {
        let connection = Connection::open_in_memory().expect("an in-memory database opens");
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
