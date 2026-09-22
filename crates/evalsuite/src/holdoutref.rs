//! THE HAND-WRITTEN REFERENCE FOR THE HOLDOUT SET (`holdout.json`).
//!
//! Same job as every reference in this crate and the same rule: **no model run
//! against the holdout set means anything until this is green.** A case nobody
//! can reach by hand is not a hard case, it is an unreachable one, and the
//! difference is invisible in a candidate's score.
//!
//! ## What it must not do, and what `blindref` did
//!
//! It is a POSITION ORACLE — told which session and which turn it is
//! answering — and it obeys two rules the blind set's reference did not:
//!
//! 1. **Nothing is pasted in from the corpus.** Every id below is FOUND: a
//!    board opened, a window applied, a field read, a link walked. The blind
//!    set's reference transcribed its expected answers as label lists
//!    (`labelled(ctx, App::Agenda, &["Morning run", "Dinner with Neha"])`),
//!    which proves the rows are *writable*, not that they are *reachable* —
//!    and reachability is the whole question a reference exists to settle.
//! 2. **The words a WRITE carries come from the case.** DEFECT #3: a
//!    reference that spelled a description in its own source went red the
//!    moment somebody renamed the row, and the failure read as a scoring bug
//!    when it was a coupling one. `write_args` is how a case names its own
//!    subject; an `ids` answer is never read from the case.
//!
//! Every read below filters `live`. A trashed row is never a correct answer,
//! and three doors in this vault hand their trash back — Tasks, Agenda and
//! Docs — so the filter is the reference's job rather than the door's.
//!
//! ## And why it is a separate file
//!
//! The holdout set is a corpus over a DIFFERENT WORLD
//! ([`centraid_evalworld::Scenario::Second`]): a disjoint cast, disjoint
//! places, a different weekend away, its own collisions. Sharing a resolver
//! with either of the other two corpora would mean reading one to write the
//! other, and would have made the second world's whole point unreachable.

use serde_json::json;

use crate::{App, Candidate, CandidateRuntime, Context, Expected, Plan, Session, VaultRow};

/// The holdout set's reference runtime.
pub struct HoldoutReference;

impl CandidateRuntime for HoldoutReference {
    fn name(&self) -> &str {
        "hand-written reference (holdout set, world 2)"
    }

    fn session(&self, session: &Session) -> Box<dyn Candidate> {
        Box::new(HoldoutSession {
            id: session.id.clone(),
            wants: session
                .turns
                .iter()
                .map(|turn| turn.expected.clone())
                .collect(),
            turn: 0,
            held: Vec::new(),
            aside: Vec::new(),
            undoable: None,
        })
    }
}

/// One session's memory.
struct HoldoutSession {
    id: String,
    /// WHAT EACH TURN OF THIS SESSION EXPECTS — read for WRITE ARGUMENTS only.
    /// See the module note: an `ids` answer is never taken from here.
    wants: Vec<Expected>,
    turn: usize,
    /// The rows the last list answered — what "them" and "those" mean.
    held: Vec<VaultRow>,
    /// The thread that was PUT DOWN, not the one just answered. A session that
    /// steps away for a turn and comes back has two live referents, and
    /// collapsing them makes every resumption resolve to the detour.
    aside: Vec<VaultRow>,
    /// **WHAT THE LAST WRITE HANDED BACK THAT ONLY AN UNDO NEEDS.**
    ///
    /// The vault records a change before it makes one and names the recording
    /// in its result, so "put it back" is answerable: `tally.undo_expense` and
    /// `people.undo_person` both take the revision the earlier turn minted. A
    /// session that did not remember it could only re-edit the row towards its
    /// old value, which is a second change and not a rollback.
    undoable: Option<String>,
}

// ---------------------------------------------------------------------------
// Reading helpers. Every one of them goes through a door, and every one of
// them filters `live`.
// ---------------------------------------------------------------------------

/// Every LIVE row of one app's board.
///
/// `row.live` is read from each row's own `deleted_at`, and two apps carry a
/// second marker their own reader computes — Docs' `trashed` and Tally's
/// `deleted` — which is checked here as well rather than trusted to agree.
fn board(ctx: &Context<'_>, app: App) -> Vec<VaultRow> {
    ctx.open(app)
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.live)
        .filter(|row| extra(row, "trashed") != "true" && extra(row, "deleted") != "true")
        .collect()
}

/// Live rows of `app`, of `entity` where one is named.
fn of_kind(ctx: &Context<'_>, app: App, entity: &str) -> Vec<VaultRow> {
    board(ctx, app)
        .into_iter()
        .filter(|row| row.entity == entity)
        .collect()
}

/// Live rows of `app` and `entity` whose label contains `needle`,
/// case-insensitively.
fn like(ctx: &Context<'_>, app: App, entity: &str, needle: &str) -> Vec<VaultRow> {
    let needle = needle.to_lowercase();
    of_kind(ctx, app, entity)
        .into_iter()
        .filter(|row| row.label.to_lowercase().contains(&needle))
        .collect()
}

/// The ONE live row of `app` and `entity` whose label contains `needle`.
///
/// `None` when there is not exactly one — which is itself an answer, and the
/// reason several resolutions below clarify.
fn only(ctx: &Context<'_>, app: App, entity: &str, needle: &str) -> Option<VaultRow> {
    let mut found = like(ctx, app, entity, needle);
    (found.len() == 1).then(|| found.remove(0))
}

/// Live rows of `app` whose own salient date falls inside `[from, to]` by day.
fn between(ctx: &Context<'_>, app: App, entity: &str, from: &str, to: &str) -> Vec<VaultRow> {
    of_kind(ctx, app, entity)
        .into_iter()
        .filter(|row| in_window(row.date.as_deref(), from, to))
        .collect()
}

fn in_window(stamp: Option<&str>, from: &str, to: &str) -> bool {
    stamp.is_some_and(|stamp| stamp.len() >= 10 && &stamp[..10] >= from && &stamp[..10] <= to)
}

fn extra(row: &VaultRow, key: &str) -> String {
    row.extra.get(key).cloned().unwrap_or_default()
}

/// The values of a `\u{1f}`-joined extra.
fn many(row: &VaultRow, key: &str) -> Vec<String> {
    extra(row, key)
        .split('\u{1f}')
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A task that is neither finished nor binned — what "still to do" means.
fn open_task(row: &VaultRow) -> bool {
    extra(row, "status") != "completed"
}

/// Sorted by the row's own date, which is what "the first one" means about a
/// day's tasks.
fn by_date(mut rows: Vec<VaultRow>) -> Vec<VaultRow> {
    rows.sort_by(|left, right| left.date.cmp(&right.date));
    rows
}

/// **AN OBLIGATION IS NOT A ROW ON ANY BOARD.**
///
/// People's own reader is the only one in the tree that reads Tally's
/// obligation table, and what it hands back is a LIST OF IDS hung on the
/// person — open ones only, because a settled debt is history and not an
/// answer. So a case whose answer is a debt is answered by naming those ids,
/// which is what the door gives and all it gives.
fn obligations(named: &[String]) -> Vec<VaultRow> {
    named
        .iter()
        .map(|id| VaultRow {
            id: id.clone(),
            entity: "tally.obligation".to_owned(),
            app: "people".to_owned(),
            label: String::new(),
            date: None,
            live: true,
            extra: std::collections::BTreeMap::new(),
        })
        .collect()
}

fn ids(rows: &[VaultRow]) -> Vec<String> {
    rows.iter().map(|row| row.id.clone()).collect()
}

fn clarify() -> Plan {
    Plan::Declined {
        reason: "clarify".to_owned(),
    }
}

fn refuse() -> Plan {
    Plan::Declined {
        reason: "refuse".to_owned(),
    }
}

fn nothing() -> Plan {
    Plan::Declined {
        reason: "none".to_owned(),
    }
}

/// A turn this reference does not resolve is a HOLE, and it fails loudly.
///
/// Never an empty `Plan::Ids`: an empty answer matches an empty expectation,
/// so a silent pass on a turn nobody wrote a resolution for is exactly the
/// failure a reference run exists to prevent.
fn unhandled() -> Plan {
    Plan::Declined {
        reason: "unhandled".to_owned(),
    }
}

/// A day, `YYYY-MM-DD`, `offset` days from the world's Monday.
fn day(offset: i64) -> String {
    centraid_evalworld::day(offset)
}

/// The total of an expense filter, and how many rows it kept.
fn expense_total(ctx: &Context<'_>, keep: impl Fn(&VaultRow) -> bool) -> (f64, f64) {
    let mut total = 0_i64;
    let mut count = 0_i64;
    for row in of_kind(ctx, App::Tally, "tally.expense") {
        if !keep(&row) {
            continue;
        }
        total += extra(&row, "amount_minor")
            .parse::<i64>()
            .unwrap_or_default();
        count += 1;
    }
    #[expect(clippy::cast_precision_loss, reason = "minor units and row counts")]
    (total as f64, count as f64)
}

/// The id of the one group whose name contains `needle`.
fn group_of(ctx: &Context<'_>, needle: &str) -> String {
    only(ctx, App::Tally, "tally.group", needle)
        .map(|row| row.id)
        .unwrap_or_default()
}

/// The calendar the world writes its diary into — discovered from an event
/// that is already on it, never guessed.
fn calendar(ctx: &Context<'_>) -> String {
    board(ctx, App::Agenda)
        .into_iter()
        .find_map(|row| row.extra.get("calendar_id").cloned())
        .unwrap_or_default()
}

impl HoldoutSession {
    /// The argument maps of this turn's expected write, in the order the case
    /// lists them — one for a `write`, several for a `write_set`.
    fn write_args(&self, turn: usize) -> Vec<&serde_json::Map<String, serde_json::Value>> {
        match self.wants.get(turn) {
            Some(Expected::Write { args, .. }) => vec![args],
            Some(Expected::WriteSet { writes, .. }) => {
                writes.iter().map(|write| &write.args).collect()
            }
            _ => Vec::new(),
        }
    }

    /// A string argument the case names for this turn's write.
    fn text_arg(&self, turn: usize, key: &str) -> Option<String> {
        self.write_args(turn)
            .into_iter()
            .find_map(|args| args.get(key).and_then(serde_json::Value::as_str))
            .map(str::to_owned)
    }

    /// A numeric argument the case names for this turn's write.
    fn number_arg(&self, turn: usize, key: &str) -> Option<i64> {
        self.write_args(turn)
            .into_iter()
            .find_map(|args| args.get(key).and_then(serde_json::Value::as_i64))
    }

    /// Every value of `key` across this turn's writes — a `write_set` that
    /// moves two rows names two ids.
    fn each_text_arg(&self, turn: usize, key: &str) -> Vec<String> {
        self.write_args(turn)
            .into_iter()
            .filter_map(|args| args.get(key).and_then(serde_json::Value::as_str))
            .map(str::to_owned)
            .collect()
    }

    /// Hold rows as the answer, so the next turn can say "those".
    fn answer(&mut self, rows: Vec<VaultRow>) -> Plan {
        let answered = ids(&rows);
        self.held = rows;
        Plan::Ids(answered)
    }

    /// Hold rows AND put them aside, for a session that steps away and comes
    /// back to them.
    fn answer_and_keep(&mut self, rows: Vec<VaultRow>) -> Plan {
        self.aside.clone_from(&rows);
        self.answer(rows)
    }

    /// A write whose result is kept, for the one thing a later turn may need
    /// from it: the id of the revision it recorded.
    fn wrote_undoably(
        &mut self,
        ctx: &mut Context<'_>,
        command: &str,
        body: serde_json::Value,
    ) -> Plan {
        match ctx.write(command, body) {
            Ok(result) => {
                self.undoable = result
                    .get("revision_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                Plan::Wrote
            }
            Err(why) => {
                if std::env::var_os("EVALSUITE_SHOW_REFUSALS").is_some() {
                    eprintln!("  refused: {command}: {why}");
                }
                unhandled()
            }
        }
    }

    /// A write, reported as a write or as a failure to reach the case at all.
    fn wrote(ctx: &mut Context<'_>, command: &str, body: serde_json::Value) -> Plan {
        match ctx.write(command, body) {
            Ok(_) => Plan::Wrote,
            Err(why) => {
                if std::env::var_os("EVALSUITE_SHOW_REFUSALS").is_some() {
                    eprintln!("  refused: {command}: {why}");
                }
                unhandled()
            }
        }
    }
}

impl Candidate for HoldoutSession {
    #[expect(
        clippy::too_many_lines,
        reason = "one corpus, one resolution each — splitting it would hide the list"
    )]
    fn turn(&mut self, _request: &str, ctx: &mut Context<'_>) -> Plan {
        let turn = self.turn;
        self.turn += 1;
        let session = self.id.clone();
        match (session.as_str(), turn) {
            // ---- Abstract temporal ------------------------------------
            ("h01", 0) => {
                let rows = between(ctx, App::Agenda, "core.event", &day(1), &day(1));
                self.answer(rows)
            }
            ("h02", 0) | ("h62", 0) => {
                let today = day(0);
                let rows: Vec<VaultRow> = of_kind(ctx, App::Tasks, "schedule.task")
                    .into_iter()
                    .filter(open_task)
                    .filter(|row| {
                        row.date
                            .as_deref()
                            .is_some_and(|due| &due[..10] < today.as_str())
                    })
                    .collect();
                self.answer(rows)
            }
            ("h03", 0) | ("h32", 0) | ("h65", 0) => {
                let rows = between(ctx, App::Agenda, "core.event", &day(0), &day(6));
                self.answer_and_keep(rows)
            }
            ("h04", 0) | ("h34", 0) => {
                let rows: Vec<VaultRow> =
                    between(ctx, App::Tasks, "schedule.task", &day(0), &day(6))
                        .into_iter()
                        .filter(open_task)
                        .collect();
                self.answer(by_date(rows))
            }
            ("h05", 0) => {
                let (from, to) = (day(-7), day(-1));
                let rows: Vec<VaultRow> = of_kind(ctx, App::Tasks, "schedule.task")
                    .into_iter()
                    .filter(|row| {
                        in_window(
                            row.extra.get("completed_at").map(String::as_str),
                            &from,
                            &to,
                        )
                    })
                    .collect();
                self.answer(rows)
            }
            ("h06", 0) => {
                let (from, to) = (day(2), day(2));
                let mut rows = between(ctx, App::Agenda, "core.event", &from, &to);
                rows.extend(
                    between(ctx, App::Tasks, "schedule.task", &from, &to)
                        .into_iter()
                        .filter(open_task),
                );
                self.answer(rows)
            }
            ("h07", 0) => {
                let rows = between(ctx, App::Agenda, "core.event", &day(7), &day(13));
                self.answer(rows)
            }
            ("h08", 0) => {
                let rows = between(ctx, App::Photos, "core.content_item", &day(-7), &day(-1));
                self.answer(rows)
            }
            // THE ANCHORED WINDOW: both ends are rows the diary holds, so the
            // answer survives the weekend being moved.
            ("h09", 0) => {
                let events = of_kind(ctx, App::Agenda, "core.event");
                let start = events
                    .iter()
                    .find(|row| row.label.ends_with("arrival"))
                    .and_then(|row| row.date.clone())
                    .unwrap_or_default();
                let end = events
                    .iter()
                    .find(|row| row.label.ends_with("departure"))
                    .and_then(|row| row.date.clone())
                    .unwrap_or_default();
                let (from, to) = (start[..10].to_owned(), end[..10].to_owned());
                let mut rows: Vec<VaultRow> = events
                    .into_iter()
                    .filter(|row| in_window(row.date.as_deref(), &from, &to))
                    .collect();
                rows.extend(
                    between(ctx, App::Tasks, "schedule.task", &from, &to)
                        .into_iter()
                        .filter(open_task),
                );
                rows.extend(between(
                    ctx,
                    App::People,
                    "people.important_date",
                    &from,
                    &to,
                ));
                self.answer(rows)
            }

            // ---- Single reads ------------------------------------------
            ("h10", 0) => {
                let rows: Vec<VaultRow> = of_kind(ctx, App::Tasks, "schedule.task")
                    .into_iter()
                    .filter(open_task)
                    .filter(|row| row.date.is_none())
                    .collect();
                self.answer(rows)
            }
            ("h11", 0) | ("h66", 1) => {
                let parent = like(ctx, App::Tasks, "schedule.task", "Organise the")
                    .first()
                    .map(|row| row.id.clone())
                    .unwrap_or_default();
                let rows: Vec<VaultRow> = of_kind(ctx, App::Tasks, "schedule.task")
                    .into_iter()
                    .filter(|row| extra(row, "parent_task_id") == parent)
                    .collect();
                self.answer(rows)
            }
            ("h12", 0) => {
                // THE JOURNAL IS BEHIND THE PEOPLE DOOR, and the Notes library
                // does not hand it back. Last weekend: Saturday and Sunday.
                let rows = between(ctx, App::People, "knowledge.note", &day(-2), &day(-1));
                self.answer(rows)
            }
            ("h13", 0) => {
                let rows = like(ctx, App::Notes, "knowledge.note", "where to park");
                self.answer(rows)
            }
            ("h14", 0) => {
                let rows: Vec<VaultRow> = of_kind(ctx, App::Docs, "core.document")
                    .into_iter()
                    .filter(|row| extra(row, "starred") == "true")
                    .collect();
                self.answer(rows)
            }
            ("h15", 0) => {
                let rows: Vec<VaultRow> = of_kind(ctx, App::Docs, "core.document")
                    .into_iter()
                    .filter(|row| extra(row, "folder") == "Voyages")
                    .collect();
                self.answer(rows)
            }
            ("h16", 0) => {
                let rows: Vec<VaultRow> = of_kind(ctx, App::Photos, "core.content_item")
                    .into_iter()
                    .filter(|row| extra(row, "favorite") == "true")
                    .collect();
                self.answer(rows)
            }
            ("h17", 0) | ("h35", 2) | ("h68", 1) => {
                let album = only(ctx, App::Photos, "media.album", "scouting")
                    .map(|row| row.label)
                    .unwrap_or_default();
                let mut rows: Vec<VaultRow> = of_kind(ctx, App::Photos, "core.content_item")
                    .into_iter()
                    .filter(|row| many(row, "album_titles").contains(&album))
                    .collect();
                if session == "h35" {
                    // "WHAT ELSE" — the album minus the frame named two turns
                    // ago, which is what `aside` is holding.
                    let named: Vec<String> = ids(&self.aside);
                    rows.retain(|row| !named.contains(&row.id));
                }
                self.answer(rows)
            }
            ("h18", 0) => {
                let place = only(ctx, App::Photos, "core.place", "Pygmy")
                    .map(|row| row.id)
                    .unwrap_or_default();
                let rows: Vec<VaultRow> = of_kind(ctx, App::Photos, "core.content_item")
                    .into_iter()
                    .filter(|row| extra(row, "place_id") == place)
                    .collect();
                self.answer(rows)
            }
            // THE DIRECTION HAS TO BE READ: People's own reader hands back the
            // obligations pointing each way, under two different keys.
            ("h19", 0) => {
                let owed: Vec<String> = of_kind(ctx, App::People, "core.party")
                    .iter()
                    .flat_map(|row| many(row, "owed_to_me"))
                    .collect();
                let rows = obligations(&owed);
                self.answer(rows)
            }
            ("h20", 0) => {
                let rows = like(
                    ctx,
                    App::People,
                    "social.contact_channel",
                    "Yusuf Bergmann — ",
                );
                self.answer(rows)
            }
            ("h21", 0) => {
                let rows: Vec<VaultRow> = between(
                    ctx,
                    App::People,
                    "people.important_date",
                    &day(16),
                    &day(46),
                )
                .into_iter()
                .filter(|row| row.label.starts_with("Birthday"))
                .collect();
                self.answer(rows)
            }
            ("h22", 0) | ("h67", 0) => {
                let rows: Vec<VaultRow> = of_kind(ctx, App::People, "core.party")
                    .into_iter()
                    .filter(|row| extra(row, "role").to_lowercase().contains("optometrist"))
                    .collect();
                self.answer_and_keep(rows)
            }
            ("h23", 0) | ("h67", 3) => {
                let rows = like(ctx, App::Notes, "knowledge.note", "what Bergmann said");
                self.answer(rows)
            }
            ("h24", 0) => {
                let rows = like(ctx, App::People, "core.activity", "Ezra Finch");
                self.answer(rows)
            }
            ("h74", 0) => {
                let rows: Vec<VaultRow> = of_kind(ctx, App::Notes, "knowledge.note")
                    .into_iter()
                    .filter(|row| many(row, "notebooks").iter().any(|name| name == "Kitchen"))
                    .collect();
                self.answer(rows)
            }
            ("h75", 0) => {
                let rows: Vec<VaultRow> = of_kind(ctx, App::Locker, "locker.item")
                    .into_iter()
                    .filter(|row| extra(row, "type") == "wifi")
                    .collect();
                self.answer(rows)
            }
            ("h76", 0) => {
                let group = of_kind(ctx, App::Tally, "tally.expense")
                    .into_iter()
                    .find(|row| row.label.to_lowercase().contains("optometrist"))
                    .map(|row| extra(&row, "group_id"))
                    .unwrap_or_default();
                let rows: Vec<VaultRow> = of_kind(ctx, App::Tally, "tally.group")
                    .into_iter()
                    .filter(|row| row.id == group)
                    .collect();
                self.answer(rows)
            }
            ("h77", 0) => {
                let rows: Vec<VaultRow> = of_kind(ctx, App::People, "social.contact_channel")
                    .into_iter()
                    .filter(|row| row.label.starts_with("Yusuf Castellanos"))
                    .filter(|row| extra(row, "kind") == "email")
                    .collect();
                self.answer(rows)
            }
            ("h78", 0) => {
                let rows = like(ctx, App::Notes, "knowledge.note", "shortlist");
                self.answer(rows)
            }

            // ---- Values --------------------------------------------------
            ("h25", 0) | ("h38", 2) | ("h65", 2) => {
                let group = group_of(ctx, "Mendocino");
                Plan::Value(expense_total(ctx, |row| extra(row, "group_id") == group).0)
            }
            ("h26", 0) => {
                let group = group_of(ctx, "Mendocino");
                let rows: Vec<VaultRow> = of_kind(ctx, App::Tally, "tally.expense")
                    .into_iter()
                    .filter(|row| extra(row, "group_id") == group)
                    .collect();
                self.answer(rows)
            }
            ("h27", 0) => {
                let group = group_of(ctx, "Mendocino");
                let me = ctx.me().to_owned();
                Plan::Value(
                    expense_total(ctx, |row| {
                        extra(row, "group_id") == group && extra(row, "paid_by") == me
                    })
                    .0,
                )
            }
            ("h28", 0) | ("h63", 1) => {
                // THE NUMBER IS THE ROW'S OWN, read through the door rather
                // than recomputed: the obligation is what the member is asking
                // about and the amount is a column of it.
                let debt = if session == "h63" {
                    self.held.first().map(|row| row.id.clone())
                } else {
                    // THE DEBT THE OWNER OWES THE OPTOMETRIST, walked off the
                    // party row: an obligation is not a row on any board, it
                    // is an id People's own reader hangs on the person.
                    of_kind(ctx, App::People, "core.party")
                        .iter()
                        .filter(|row| extra(row, "role").to_lowercase().contains("optometrist"))
                        .flat_map(|row| many(row, "owed_to_them"))
                        .next()
                };
                let amount = debt
                    .and_then(|id| {
                        ctx.field("tally.obligation", &id, "amount_minor")
                            .ok()
                            .flatten()
                    })
                    .and_then(|text| text.parse::<f64>().ok())
                    .unwrap_or_default();
                Plan::Value(amount)
            }
            ("h29", 0) => {
                let album = only(ctx, App::Photos, "media.album", "scouting")
                    .map(|row| row.label)
                    .unwrap_or_default();
                #[expect(clippy::cast_precision_loss, reason = "a count of photographs")]
                let count = of_kind(ctx, App::Photos, "core.content_item")
                    .into_iter()
                    .filter(|row| many(row, "album_titles").contains(&album))
                    .count() as f64;
                Plan::Value(count)
            }
            ("h30", 0) => {
                let owed: Vec<String> = of_kind(ctx, App::People, "core.party")
                    .iter()
                    .flat_map(|row| many(row, "owed_to_me"))
                    .collect();
                let mut total = 0_i64;
                for id in owed {
                    total += ctx
                        .field("tally.obligation", &id, "amount_minor")
                        .ok()
                        .flatten()
                        .and_then(|text| text.parse::<i64>().ok())
                        .unwrap_or_default();
                }
                #[expect(clippy::cast_precision_loss, reason = "minor units")]
                Plan::Value(total as f64)
            }
            ("h31", 0) => {
                // A CADENCE IS A COLUMN, not a row — the request names the
                // person in full because a first name is not an identifier.
                let cadence = of_kind(ctx, App::People, "core.party")
                    .into_iter()
                    .find(|row| row.label == "Ezra Finch")
                    .map(|row| extra(&row, "cadence_days"))
                    .and_then(|text| text.parse::<f64>().ok())
                    .unwrap_or_default();
                Plan::Value(cadence)
            }

            // ---- Narrowing, reference, deictic ---------------------------
            ("h32", 1) => {
                let (from, to) = (day(5), day(6));
                let rows: Vec<VaultRow> = std::mem::take(&mut self.held)
                    .into_iter()
                    .filter(|row| in_window(row.date.as_deref(), &from, &to))
                    .collect();
                self.answer(rows)
            }
            ("h33", 0) => {
                let rows = like(ctx, App::Docs, "core.document", "Optometrist");
                self.answer(rows)
            }
            ("h33", 1) => {
                let rows = like(ctx, App::Docs, "core.document", "Cottage");
                self.answer(rows)
            }
            ("h34", 1) => {
                let rows = by_date(std::mem::take(&mut self.held));
                self.answer(rows)
            }
            ("h35", 0) => {
                let rows = like(ctx, App::Photos, "core.content_item", "shingle");
                self.answer_and_keep(rows)
            }
            ("h35", 1) => {
                // THE ALBUM THE HELD FRAME IS IN — walked off the row, not
                // looked up by name.
                let titles: Vec<String> = self
                    .held
                    .first()
                    .map(|row| many(row, "album_titles"))
                    .unwrap_or_default();
                let rows: Vec<VaultRow> = of_kind(ctx, App::Photos, "media.album")
                    .into_iter()
                    .filter(|row| titles.contains(&row.label))
                    .collect();
                self.answer(rows)
            }
            ("h36", 0) => {
                let rows = like(ctx, App::Docs, "core.document", "rental agreement");
                self.answer(rows)
            }
            ("h36", 1) => {
                let document = self.text_arg(1, "id").unwrap_or_default();
                Self::wrote(
                    ctx,
                    "core.star_document",
                    json!({ "document_id": document }),
                )
            }
            ("h37", 1) => {
                let task = self.text_arg(1, "id").unwrap_or_default();
                let to = self.text_arg(1, "to").unwrap_or_default();
                Self::wrote(
                    ctx,
                    "schedule.edit_task",
                    json!({ "task_id": task, "due_at": format!("{to}T14:00:00.000Z") }),
                )
            }
            ("h37", 0) => {
                let (from, to) = (day(2), day(2));
                let rows: Vec<VaultRow> = between(ctx, App::Tasks, "schedule.task", &from, &to)
                    .into_iter()
                    .filter(open_task)
                    .collect();
                self.answer(by_date(rows))
            }

            // ---- Cross-app -----------------------------------------------
            ("h38", 0) => {
                let rows = like(ctx, App::Agenda, "core.event", "arrival");
                self.answer(rows)
            }
            ("h38", 1) => {
                let (from, to) = (day(5), day(8));
                let rows: Vec<VaultRow> = between(ctx, App::Tasks, "schedule.task", &from, &to)
                    .into_iter()
                    .filter(open_task)
                    .collect();
                self.answer(rows)
            }
            // THE ATTENDEE LIST IS THE JOIN. The summary names nobody.
            ("h39", 0) => {
                let guests: Vec<String> = like(ctx, App::Agenda, "core.event", "Glass Beach")
                    .first()
                    .map(|row| many(row, "attendee_party_ids"))
                    .unwrap_or_default();
                let rows: Vec<VaultRow> = of_kind(ctx, App::People, "core.party")
                    .into_iter()
                    .filter(|row| guests.contains(&row.id))
                    .collect();
                self.answer(rows)
            }
            ("h40", 0) => {
                let needle = "Glass Beach";
                let mut rows = like(ctx, App::Agenda, "core.event", needle);
                rows.extend(like(ctx, App::Notes, "knowledge.note", needle));
                rows.extend(like(ctx, App::Photos, "core.content_item", needle));
                rows.extend(like(ctx, App::Photos, "core.place", needle));
                // LOCKER IS NOT IN THE SEARCH PLANE, and the one row in here
                // that answers this question is the whole argument for the
                // app having a door of its own.
                rows.extend(like(ctx, App::Locker, "locker.item", needle));
                self.answer(rows)
            }
            ("h41", 0) | ("h68", 2) => {
                let needle = if session == "h41" {
                    "shingle"
                } else {
                    "Fog over"
                };
                let frame = like(ctx, App::Photos, "core.content_item", needle)
                    .into_iter()
                    .next();
                let place = frame
                    .as_ref()
                    .map(|row| extra(row, "place_id"))
                    .unwrap_or_default();
                let rows: Vec<VaultRow> = of_kind(ctx, App::Photos, "core.place")
                    .into_iter()
                    .filter(|row| row.id == place)
                    .collect();
                // THE FRAME THE QUESTION WAS ABOUT IS PUT ASIDE, because the
                // next turn says "what ELSE" and the referent of that is this
                // photograph, not the place the turn answered with.
                self.aside = frame.into_iter().collect();
                self.answer(rows)
            }
            // A NAME COLLISION IS NOT A LINK. Nothing in the ontology relates
            // `core_place` to `core_event`, so the honest answer is a question.
            ("h41", 1) => clarify(),
            ("h42", 0) => {
                // SIX apps, the sealed Locker login among them: `things` fans
                // out over the eight doors and Locker is a Kind that is not a
                // search domain. h45 next door says the same subject spans the
                // apps and includes that item; this arm used to name four apps
                // and disagree with it (DEFECTS #36).
                let needle = "ptometrist";
                let mut rows = like(ctx, App::Agenda, "core.event", needle);
                rows.extend(like(ctx, App::Tasks, "schedule.task", needle));
                rows.extend(like(ctx, App::Notes, "knowledge.note", needle));
                rows.extend(like(ctx, App::Docs, "core.document", needle));
                rows.extend(like(ctx, App::Tally, "tally.expense", needle));
                rows.extend(like(ctx, App::Locker, "locker.item", needle));
                self.answer(rows)
            }

            // ---- Declining ------------------------------------------------
            ("h43", 0) | ("h51", 0) => clarify(),
            ("h44", 0) | ("h45", 0) => clarify(),
            ("h46", 0) | ("h47", 0) | ("h48", 0) => refuse(),
            ("h49", 0) => {
                let rows = like(ctx, App::Tally, "tally.expense", "Cottage deposit");
                self.answer(rows)
            }
            ("h49", 1) => nothing(),
            // ALREADY IN THE TRASH: nothing to do and nothing to ask. A
            // runtime that clarified would be offering to delete the LIVE note.
            ("h50", 0) => nothing(),
            ("h51", 1) => {
                // BOTH HALVES COME FROM THE CASE: which party is written
                // against and which one must not be.
                let party = self
                    .each_text_arg(1, "party_id")
                    .first()
                    .cloned()
                    .unwrap_or_default();
                Self::wrote(
                    ctx,
                    "people.log_interaction",
                    json!({ "party_id": party, "kind": "call" }),
                )
            }

            // ---- Locker ----------------------------------------------------
            ("h52", 0) => {
                let rows = like(ctx, App::Locker, "locker.item", "Cottages");
                self.answer(rows)
            }
            ("h53", 0) => {
                let rows = like(ctx, App::Locker, "locker.item", "Optometrist portal");
                self.answer(rows)
            }
            ("h53", 1) => {
                let item = self.text_arg(1, "id").unwrap_or_default();
                let field = self.text_arg(1, "field").unwrap_or_default();
                // THE RECEIPT IS THE OUTCOME — a reveal that files none is the
                // wrong thing done quietly.
                Self::wrote(
                    ctx,
                    "locker.reveal_receipt",
                    json!({
                        "object_type": "locker.item",
                        "item_id": item,
                        "columns": [field],
                        "kind": "reveal",
                        "allowed": true,
                    }),
                )
            }
            // NEVER ROTATED IS THE TWO STAMPS BEING EQUAL. The vault records a
            // creation stamp and a password stamp and never a `rotated` flag,
            // so the predicate is the ontology's own answer to the question.
            ("h54", 0) => {
                let rows: Vec<VaultRow> = of_kind(ctx, App::Locker, "locker.item")
                    .into_iter()
                    .filter(|row| extra(row, "type") == "login")
                    .filter(|row| {
                        let set = extra(row, "password_set_at");
                        !set.is_empty() && set == extra(row, "created_at")
                    })
                    .collect();
                self.answer(rows)
            }
            ("h55", 0) => {
                // THE SEAT SEALS, because the gateway holds no key: the id is
                // minted first because a Locker cell is sealed against it.
                let title = self.text_arg(0, "title").unwrap_or_default();
                let kind = self
                    .text_arg(0, "type")
                    .unwrap_or_else(|| "login".to_owned());
                let item_id = ctx.mint();
                let (Ok(key_id), Ok(password)) = (
                    ctx.locker_key_id(),
                    ctx.seal(&item_id, "sample-only-not-a-real-secret"),
                ) else {
                    return unhandled();
                };
                Self::wrote(
                    ctx,
                    "locker.add_item",
                    json!({
                        "item_id": item_id,
                        "type": kind,
                        "title": title,
                        "key_id": key_id,
                        "username": "dokonjo",
                        "password": password,
                        "password_rotated": false,
                    }),
                )
            }

            // ---- Writes -----------------------------------------------------
            ("h56", 0) => {
                let title = self.text_arg(0, "title").unwrap_or_default();
                Self::wrote(ctx, "schedule.add_task", json!({ "title": title }))
            }
            ("h57", 0) => {
                let event = self.text_arg(0, "id").unwrap_or_default();
                Self::wrote(ctx, "schedule.cancel_event", json!({ "event_id": event }))
            }
            ("h58", 0) => {
                let summary = self.text_arg(0, "summary").unwrap_or_default();
                let start = self.text_arg(0, "dtstart").unwrap_or_default();
                let calendar = calendar(ctx);
                Self::wrote(
                    ctx,
                    "schedule.propose_event",
                    json!({
                        "calendar_id": calendar,
                        "summary": summary,
                        "dtstart": start,
                        "dtend": format!("{}30:00.000Z", &start[..14]),
                    }),
                )
            }
            ("h59", 0) => {
                let description = self.text_arg(0, "description").unwrap_or_default();
                let amount = self.number_arg(0, "amount_minor").unwrap_or_default();
                let group = group_of(ctx, "Mendocino");
                let me = ctx.me().to_owned();
                Self::wrote(
                    ctx,
                    "tally.add_expense",
                    json!({
                        "group_id": group,
                        "description": description,
                        "amount_minor": amount,
                        "paid_by": me,
                        "category": "general",
                        "splits": [{ "party_id": me, "share_minor": amount }],
                    }),
                )
            }
            ("h60", 0) => {
                let to = self
                    .write_args(0)
                    .first()
                    .and_then(|args| args.get("to"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                for task in self.each_text_arg(0, "id") {
                    let _ = ctx.write(
                        "schedule.edit_task",
                        json!({ "task_id": task, "due_at": format!("{to}T09:00:00.000Z") }),
                    );
                }
                Plan::Wrote
            }
            ("h61", 0) => {
                let mut named = self.each_text_arg(0, "id").into_iter();
                let (Some(task), Some(event)) = (named.next(), named.next()) else {
                    return unhandled();
                };
                let _ = ctx.write(
                    "schedule.set_task_status",
                    json!({ "task_id": task, "status": "completed" }),
                );
                let _ = ctx.write("schedule.cancel_event", json!({ "event_id": event }));
                Plan::Wrote
            }
            ("h62", 1) | ("h66", 4) => {
                let task = self.text_arg(turn, "id").unwrap_or_default();
                Self::wrote(
                    ctx,
                    "schedule.set_task_status",
                    json!({ "task_id": task, "status": "completed" }),
                )
            }
            ("h63", 0) | ("h67", 1) => {
                // THE ANSWER TO "DO I OWE THEM" IS THE DEBT, not the party:
                // the party is only who it is owed to. `h67` has the person
                // in hand from an earlier turn; `h63` names them by role.
                let held = self.held.first().map(|row| row.id.clone());
                let owing: Vec<String> = of_kind(ctx, App::People, "core.party")
                    .iter()
                    .filter(|row| match held.as_deref() {
                        Some(party) => row.id == party,
                        None => extra(row, "role").to_lowercase().contains("optometrist"),
                    })
                    .flat_map(|row| many(row, "owed_to_them"))
                    .collect();
                let rows = obligations(&owing);
                self.answer(rows)
            }
            ("h63", 2) => {
                let debt = self
                    .held
                    .first()
                    .map(|row| row.id.clone())
                    .unwrap_or_default();
                Self::wrote(ctx, "people.settle_debt", json!({ "debt_id": debt }))
            }
            ("h64", 0) => {
                let rows = like(ctx, App::Photos, "core.content_item", "headland");
                self.answer(rows)
            }
            ("h64", 1) => {
                let asset = self.text_arg(1, "id").unwrap_or_default();
                let album = self.text_arg(1, "album_id").unwrap_or_default();
                Self::wrote(
                    ctx,
                    "media.add_to_album",
                    json!({ "album_id": album, "asset_id": asset }),
                )
            }

            // ---- Deep ---------------------------------------------------
            ("h65", 1) => {
                let rows: Vec<VaultRow> = std::mem::take(&mut self.held)
                    .into_iter()
                    .filter(|row| !many(row, "attendee_party_ids").is_empty())
                    .collect();
                self.answer_and_keep(rows)
            }
            // THE THREAD THAT WAS PUT DOWN, not the money detour just answered.
            ("h65", 3) => {
                let rows: Vec<VaultRow> = self
                    .aside
                    .iter()
                    .filter(|row| row.label.to_lowercase().contains("ptometrist"))
                    .cloned()
                    .collect();
                self.answer(rows)
            }
            ("h65", 4) => {
                let event = self.text_arg(4, "id").unwrap_or_default();
                let to = self.text_arg(4, "to").unwrap_or_default();
                let end = format!("{}17:00:00.000Z", &to[..11]);
                Self::wrote(
                    ctx,
                    "schedule.reschedule_event",
                    json!({ "event_id": event, "dtstart": to, "dtend": end }),
                )
            }
            ("h65", 5) => {
                let guests: Vec<String> = self
                    .held
                    .first()
                    .map(|row| many(row, "attendee_party_ids"))
                    .unwrap_or_default();
                let rows: Vec<VaultRow> = of_kind(ctx, App::People, "core.party")
                    .into_iter()
                    .filter(|row| guests.contains(&row.id))
                    .collect();
                self.answer(rows)
            }
            ("h66", 0) => {
                let rows = like(ctx, App::Tasks, "schedule.task", "Organise the");
                self.answer(rows)
            }
            // A BAND, not a budget and not an equality: half again either way
            // around forty five is [30, 60], which is one of 15 / 45 / 120.
            ("h66", 2) => {
                let rows: Vec<VaultRow> = std::mem::take(&mut self.held)
                    .into_iter()
                    .filter(|row| {
                        extra(row, "effort_min")
                            .parse::<i64>()
                            .is_ok_and(|effort| (30..=60).contains(&effort))
                    })
                    .collect();
                self.answer(rows)
            }
            // "NO, I MEANT" — the correction re-reads the SAME children under
            // a different filter, which is why the previous answer is not the
            // set it draws from.
            ("h66", 3) => {
                let parent = like(ctx, App::Tasks, "schedule.task", "Organise the")
                    .first()
                    .map(|row| row.id.clone())
                    .unwrap_or_default();
                let rows: Vec<VaultRow> = of_kind(ctx, App::Tasks, "schedule.task")
                    .into_iter()
                    .filter(|row| extra(row, "parent_task_id") == parent)
                    .filter(|row| row.date.is_some())
                    .collect();
                self.answer(rows)
            }
            ("h67", 2) => {
                let rows = like(ctx, App::Docs, "core.document", "pre-authorisation");
                self.answer(rows)
            }
            ("h67", 4) => nothing(),
            // ALBUMS WITH PHOTOGRAPHS IN THEM. Photos' own reader hands back
            // every `core_collection` the vault holds, notebooks and folders
            // among them — so "my albums" is the collections the camera roll
            // actually files into, which is a join and not a board.
            ("h68", 0) => {
                let filed: Vec<String> = of_kind(ctx, App::Photos, "core.content_item")
                    .iter()
                    .flat_map(|row| many(row, "album_titles"))
                    .collect();
                let rows: Vec<VaultRow> = of_kind(ctx, App::Photos, "media.album")
                    .into_iter()
                    .filter(|row| filed.contains(&row.label))
                    .collect();
                self.answer(rows)
            }
            ("h68", 3) => {
                let place = self
                    .held
                    .first()
                    .map(|row| row.id.clone())
                    .unwrap_or_default();
                let named: Vec<String> = ids(&self.aside);
                let rows: Vec<VaultRow> = of_kind(ctx, App::Photos, "core.content_item")
                    .into_iter()
                    .filter(|row| extra(row, "place_id") == place)
                    // "WHAT ELSE" — the frame the previous turn was about is
                    // not part of the answer to it.
                    .filter(|row| !named.contains(&row.id))
                    .collect();
                self.answer(rows)
            }

            ("h68", 4) => {
                let rows: Vec<VaultRow> = std::mem::take(&mut self.held)
                    .into_iter()
                    .filter(|row| extra(row, "favorite") == "true")
                    .collect();
                self.answer(rows)
            }

            // ---- Undo ------------------------------------------------------
            ("h69", 0) => {
                let task = self.text_arg(0, "id").unwrap_or_default();
                Self::wrote(ctx, "schedule.restore_task", json!({ "task_id": task }))
            }
            ("h70", 0) => {
                let asset = self.text_arg(0, "id").unwrap_or_default();
                Self::wrote(ctx, "media.restore_asset", json!({ "asset_id": asset }))
            }
            ("h71", 0) => {
                let expense = self.text_arg(0, "id").unwrap_or_default();
                self.wrote_undoably(
                    ctx,
                    "tally.delete_expense",
                    json!({ "expense_id": expense }),
                )
            }
            ("h71", 1) => {
                let expense = self.text_arg(1, "id").unwrap_or_default();
                let Some(revision) = self.undoable.clone() else {
                    return unhandled();
                };
                Self::wrote(
                    ctx,
                    "tally.undo_expense",
                    json!({ "expense_id": expense, "revision_id": revision }),
                )
            }
            ("h72", 0) => {
                let party = self.text_arg(0, "party_id").unwrap_or_default();
                self.wrote_undoably(ctx, "people.trash_person", json!({ "party_id": party }))
            }
            ("h72", 1) => {
                let party = self.text_arg(1, "party_id").unwrap_or_default();
                let Some(revision) = self.undoable.clone() else {
                    return unhandled();
                };
                Self::wrote(
                    ctx,
                    "people.undo_person",
                    json!({ "party_id": party, "revision_id": revision }),
                )
            }
            ("h73", 0) => {
                let document = self.text_arg(0, "id").unwrap_or_default();
                Self::wrote(
                    ctx,
                    "core.restore_document",
                    json!({ "document_id": document }),
                )
            }

            _ => unhandled(),
        }
    }
}
