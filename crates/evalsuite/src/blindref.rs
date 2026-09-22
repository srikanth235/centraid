//! THE HAND-WRITTEN REFERENCE FOR THE BLIND SET (`blind.json`).
//!
//! Same job as any reference in this crate and the same rule: **no model run
//! against the blind set means anything until this is green.** A case nobody
//! can reach by hand is not a hard case, it is an unreachable one, and the
//! difference is invisible in a candidate's score.
//!
//! It is a separate reference because the blind set is a separate corpus,
//! written against the world and NOT against the primary suite — the whole
//! point of `blind.json` is to be authored by someone who has not read
//! `suite.json`. Sharing a resolver would have meant reading one to write the
//! other.
//!
//! **It resolves rows through the app doors**, never by id and never by
//! peeking at the suite: every answer here is a board the reference opened,
//! filtered by the row's own liveness stamp. That is what makes a green run
//! evidence — the rows exist, the doors reach them, and a trashed row is never
//! among them.
//!
//! ## What this file got wrong, and what changed
//!
//! It used to transcribe its expected answers as LABEL LISTS —
//! `labelled(ctx, App::Agenda, &["Morning run", "Dinner with Neha"])` for
//! "what's on my calendar tomorrow?" — which is DEFECT #3 in read clothing: it
//! proves the rows are writable, not that they are reachable, and reachability
//! is the whole question a reference exists to settle. A case reworded from
//! "tomorrow" to "on the 20th" would have gone on passing.
//!
//! Every arm whose answer is a COMPUTED SET — a window, a status, a parent, a
//! payer, an album, a folder — now computes it. `labelled` survives only where
//! the member's own sentence names the row ("what number have I got for Neha
//! Rao?"), which is not the reference smuggling a lookup: it is the request
//! carrying its own subject.
//!
//! Two smaller things went with it. `board` now drops the rows whose own app
//! reader marks them trashed as well as the ones whose `deleted_at` is set —
//! Docs and Tally carry their bin beside their board, and trusting the two
//! markers to agree is how a trashed row becomes an answer. And a request
//! this file does not resolve is now `unhandled` rather than an empty
//! `Plan::Ids`: an empty answer MATCHES an empty expectation, so the old
//! fallthrough was a silent pass on exactly the turn a reference run exists to
//! catch.

use serde_json::{Value, json};

use centraid_evalsuite::{App, Candidate, CandidateRuntime, Context, Plan, Session, VaultRow};

/// The blind set's reference runtime.
pub struct BlindReference;

impl CandidateRuntime for BlindReference {
    fn name(&self) -> &str {
        "hand-written reference (blind set)"
    }
    fn session(&self, _session: &Session) -> Box<dyn Candidate> {
        Box::new(BlindTurn)
    }
}

struct BlindTurn;

/// Every live row of one app's board.
///
/// `row.live` is read from each row's own `deleted_at`; Docs and Tally ALSO
/// carry a marker their own reader computes, and both are checked here rather
/// than assumed to agree. A trashed row is never a correct answer.
fn board(ctx: &Context<'_>, app: App) -> Vec<VaultRow> {
    ctx.open(app)
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.live)
        .filter(|row| extra(row, "trashed") != "true" && extra(row, "deleted") != "true")
        .collect()
}

/// A day, `YYYY-MM-DD`, `offset` days from the world's Monday.
fn day(offset: i64) -> String {
    centraid_evalworld::day(offset)
}

/// Live rows of `app` and `entity` whose own salient date falls inside
/// `[from, to]` by day.
fn between(ctx: &Context<'_>, app: App, entity: &str, from: &str, to: &str) -> Plan {
    Plan::Ids(
        board(ctx, app)
            .into_iter()
            .filter(|row| row.entity == entity)
            .filter(|row| in_window(row.date.as_deref(), from, to))
            .map(|row| row.id)
            .collect(),
    )
}

fn in_window(stamp: Option<&str>, from: &str, to: &str) -> bool {
    stamp.is_some_and(|stamp| stamp.len() >= 10 && &stamp[..10] >= from && &stamp[..10] <= to)
}

/// Live rows of `app` and `entity` whose label contains `needle`.
///
/// The needle comes from the member's own sentence, not from the expectation.
fn like(ctx: &Context<'_>, app: App, entity: &str, needle: &str) -> Plan {
    let needle = needle.to_lowercase();
    Plan::Ids(
        board(ctx, app)
            .into_iter()
            .filter(|row| row.entity == entity)
            .filter(|row| row.label.to_lowercase().contains(&needle))
            .map(|row| row.id)
            .collect(),
    )
}

/// The live tasks that are neither finished nor binned, in `[from, to]`.
fn tasks_due(ctx: &Context<'_>, from: &str, to: &str) -> Plan {
    Plan::Ids(
        board(ctx, App::Tasks)
            .into_iter()
            .filter(|row| row.entity == "schedule.task")
            .filter(|row| extra(row, "status") != "completed")
            .filter(|row| in_window(row.date.as_deref(), from, to))
            .map(|row| row.id)
            .collect(),
    )
}

/// The ids of the live rows carrying these labels, IN THE ORDER NAMED.
///
/// **ONLY FOR A REQUEST THAT NAMES ITS OWN SUBJECT.** A label is how a member
/// names a row and how the suite's handles name one, so where the sentence
/// says "the cabin rental agreement" this is the same act the scorer's
/// resolution performs, from the other side of the door. Where the sentence
/// says "tomorrow", it is not: see the module note.
fn labelled(ctx: &Context<'_>, app: App, labels: &[&str]) -> Plan {
    let rows = board(ctx, app);
    let mut ids = Vec::new();
    for label in labels {
        if let Some(found) = rows.iter().find(|row| row.label == *label) {
            ids.push(found.id.clone());
        }
    }
    Plan::Ids(ids)
}

/// One live row's id, by label.
fn one(ctx: &Context<'_>, app: App, label: &str) -> Option<String> {
    board(ctx, app)
        .into_iter()
        .find(|row| row.label == label)
        .map(|row| row.id)
}

/// One live row's id, by label AND entity — for the two apps where a label
/// alone spans kinds (Tally's groups, parties and expenses share a board).
fn one_of(ctx: &Context<'_>, app: App, entity: &str, label: &str) -> Option<String> {
    board(ctx, app)
        .into_iter()
        .find(|row| row.entity == entity && row.label == label)
        .map(|row| row.id)
}

fn extra(row: &VaultRow, key: &str) -> String {
    row.extra.get(key).cloned().unwrap_or_default()
}

/// The sum of `amount_minor` over the live expenses this filter keeps.
fn expense_total(ctx: &Context<'_>, keep: impl Fn(&VaultRow) -> bool) -> (f64, f64) {
    let mut total = 0_i64;
    let mut count = 0_i64;
    for row in board(ctx, App::Tally) {
        if row.entity != "tally.expense" || extra(&row, "deleted") == "true" || !keep(&row) {
            continue;
        }
        total += extra(&row, "amount_minor").parse::<i64>().unwrap_or_default();
        count += 1;
    }
    #[expect(clippy::cast_precision_loss, reason = "minor units and row counts")]
    (total as f64, count as f64)
}

/// The calendar the world writes its diary into — discovered from an event
/// that is already on it, never guessed.
fn calendar(ctx: &Context<'_>) -> Option<String> {
    board(ctx, App::Agenda)
        .into_iter()
        .find_map(|row| row.extra.get("calendar_id").cloned())
}

/// A write, reported as a write whether or not the vault took it: the
/// PREDICATE decides, not the candidate.
fn wrote(ctx: &mut Context<'_>, command: &str, body: Value) -> Plan {
    let _ = ctx.write(command, body);
    Plan::Wrote
}

fn declined(reason: &str) -> Plan {
    Plan::Declined {
        reason: reason.to_owned(),
    }
}

impl Candidate for BlindTurn {
    #[expect(
        clippy::too_many_lines,
        reason = "one corpus, one resolution each — splitting it would hide the list"
    )]
    fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan {
        match request {
            // ---- Agenda and the week ------------------------------------
            // A WINDOW, NOT A LIST OF LABELS. The day is what the sentence
            // names and the rows are whatever falls in it.
            "what's on my calendar tomorrow?" => {
                between(ctx, App::Agenda, "core.event", &day(1), &day(1))
            }
            "do I have anything on Wednesday?" => {
                between(ctx, App::Agenda, "core.event", &day(2), &day(2))
            }
            // These two NAME the row, which is the case the helper is for.
            "when's my cleaning?" | "what time is the dentist cleaning?" => {
                like(ctx, App::Agenda, "core.event", "cleaning")
            }
            "and what do I have to do that day?" => tasks_due(ctx, &day(2), &day(2)),
            "what does the rest of the week look like on the calendar?" => {
                between(ctx, App::Agenda, "core.event", &day(0), &day(6))
            }
            "when do we get into the cabin, and when do we have to be out?" => {
                like(ctx, App::Agenda, "core.event", "check-")
            }
            // OVERDUE IS THE OPEN PAST, read off the board's own status.
            "is anything overdue?" | "anything overdue?" => {
                tasks_due(ctx, "0000-00-00", &day(-1))
            }
            "what's due this week?" => tasks_due(ctx, &day(0), &day(6)),
            "what's due on the 18th?" => tasks_due(ctx, &day(3), &day(3)),
            "did I do the grocery run?" => like(ctx, App::Tasks, "schedule.task", "grocery run"),
            "which of my tasks have no deadline on them at all?" => Plan::Ids(
                board(ctx, App::Tasks)
                    .into_iter()
                    .filter(|row| row.entity == "schedule.task")
                    .filter(|row| extra(row, "status") != "completed")
                    .filter(|row| row.date.is_none())
                    .map(|row| row.id)
                    .collect(),
            ),
            // THE CHILDREN OF A TASK, walked down the self-referential key the
            // sentence's own anchor carries.
            "what sits under 'Plan the Tahoe trip'?" => {
                let parent = one_of(ctx, App::Tasks, "schedule.task", "Plan the Tahoe trip")
                    .unwrap_or_default();
                Plan::Ids(
                    board(ctx, App::Tasks)
                        .into_iter()
                        .filter(|row| extra(row, "parent_task_id") == parent)
                        .map(|row| row.id)
                        .collect(),
                )
            }
            "'Book the Tahoe cabin' — have I got that written down twice?" => {
                let mut ids = Vec::new();
                ids.extend(one(ctx, App::Tasks, "Book the Tahoe cabin"));
                ids.extend(one(ctx, App::Agenda, "Book the Tahoe cabin"));
                Plan::Ids(ids)
            }

            // ---- People --------------------------------------------------
            // TRASHED, NOT TICKED OFF. "I'm never going to do it" is the
            // opposite of finishing it, and a board that marked it complete
            // would have recorded the member doing something they did not do.
            "bin the sourdough task, I'm never going to do it" => {
                match one_of(ctx, App::Tasks, "schedule.task", "Learn to make sourdough") {
                    Some(task) => wrote(ctx, "schedule.delete_task", json!({ "task_id": task })),
                    None => declined("clarify"),
                }
            }
            // CANCELLED, NOT DELETED: the other attendees are owed the status,
            // and a row that vanishes tells them nothing.
            "cancel the dinner with Neha" => {
                match one_of(ctx, App::Agenda, "core.event", "Dinner with Neha") {
                    Some(event) => {
                        wrote(ctx, "schedule.cancel_event", json!({ "event_id": event }))
                    }
                    None => declined("clarify"),
                }
            }
            "log a call with Neha" => declined("clarify"),
            // THE ROLE, not the name: the sentence asks which of the Nehas
            // the roster calls a dentist.
            "which Neha is my dentist?" => Plan::Ids(
                board(ctx, App::People)
                    .into_iter()
                    .filter(|row| row.entity == "core.party" && row.label.contains("Neha"))
                    .filter(|row| extra(row, "role").to_lowercase().contains("dentist"))
                    .map(|row| row.id)
                    .collect(),
            ),
            "log that I called Neha Kulkarni this morning" => {
                match one_of(ctx, App::People, "core.party", "Neha Kulkarni") {
                    Some(party) => wrote(
                        ctx,
                        "people.log_interaction",
                        json!({ "party_id": party, "kind": "call" }),
                    ),
                    None => declined("clarify"),
                }
            }
            "what's Neha Kulkarni's mobile?" => {
                labelled(ctx, App::People, &["Neha Kulkarni — Mobile"])
            }
            "what number have I got for Neha Rao?" => {
                labelled(ctx, App::People, &["Neha Rao — Clinic"])
            }
            // AN ANCHORED WINDOW — both ends are rows the diary holds, so the
            // answer survives the trip being moved.
            "is it anybody's birthday while we're at the lake?" => {
                let events = board(ctx, App::Agenda);
                let end = |needle: &str| {
                    events
                        .iter()
                        .find(|row| row.label.contains(needle))
                        .and_then(|row| row.date.clone())
                        .unwrap_or_default()
                };
                let (from, to) = (end("check-in"), end("check-out"));
                if from.len() < 10 || to.len() < 10 {
                    return declined("clarify");
                }
                Plan::Ids(
                    board(ctx, App::People)
                        .into_iter()
                        .filter(|row| row.entity == "people.important_date")
                        .filter(|row| row.label.starts_with("Birthday"))
                        .filter(|row| in_window(row.date.as_deref(), &from[..10], &to[..10]))
                        .map(|row| row.id)
                        .collect(),
                )
            }
            "which Marco was my roommate in Portland?" => {
                let rows = board(ctx, App::People);
                Plan::Ids(
                    rows.iter()
                        .filter(|row| row.entity == "core.party")
                        .filter(|row| extra(row, "role") == "Old roommate from Portland")
                        .map(|row| row.id.clone())
                        .collect(),
                )
            }
            "do I owe Neha Rao anything?" => {
                let owed = board(ctx, App::People)
                    .into_iter()
                    .find(|row| row.entity == "core.party" && row.label == "Neha Rao")
                    .map(|row| extra(&row, "owed_to_them"))
                    .unwrap_or_default();
                Plan::Ids(
                    owed.split('\u{1f}')
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                        .collect(),
                )
            }
            "how much?" => {
                let amount = ctx
                    .history()
                    .last()
                    .and_then(|turn| match &turn.plan {
                        Plan::Ids(ids) => ids.first().cloned(),
                        _ => None,
                    })
                    .and_then(|id| ctx.field("tally.obligation", &id, "amount_minor").ok().flatten())
                    .and_then(|text| text.parse::<f64>().ok())
                    .unwrap_or_default();
                Plan::Value(amount)
            }
            "I've paid the dentist balance off — close it out" => {
                let debt = board(ctx, App::People)
                    .into_iter()
                    .find(|row| row.entity == "core.party" && row.label == "Neha Rao")
                    .map(|row| extra(&row, "owed_to_them"))
                    .unwrap_or_default()
                    .split('\u{1f}')
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                wrote(ctx, "people.settle_debt", json!({ "debt_id": debt }))
            }

            // ---- Money ---------------------------------------------------
            // b20 and b21 ask the same question in different words, and b21
            // asks it because its SECOND turn says "that": the narrowing used
            // to have no antecedent in its own session and was only resolvable
            // because this reference resolves the group by name every time.
            "what has the Tahoe trip cost us so far?"
            | "what have we spent on the Tahoe trip so far?" => {
                let group = one_of(ctx, App::Tally, "tally.group", "Tahoe Trip").unwrap_or_default();
                Plan::Value(expense_total(ctx, |row| extra(row, "group_id") == group).0)
            }
            "how much of that did I pay for myself?" => {
                let group = one_of(ctx, App::Tally, "tally.group", "Tahoe Trip").unwrap_or_default();
                let me = ctx.me().to_owned();
                Plan::Value(
                    expense_total(ctx, |row| {
                        extra(row, "group_id") == group && extra(row, "paid_by") == me
                    })
                    .0,
                )
            }
            // WHO PAID IS A FACT ON THE ROW, and the friend the sentence
            // names is a row of its own.
            "what did Marco pay for on the trip?" | "and Marco?" | "what did Neha pay for on the trip?" => {
                let who = if request.contains("Neha") { "Neha" } else { "Marco" };
                let group = one_of(ctx, App::Tally, "tally.group", "Tahoe Trip").unwrap_or_default();
                let payer = one_of(ctx, App::Tally, "core.party", who).unwrap_or_default();
                Plan::Ids(
                    board(ctx, App::Tally)
                        .into_iter()
                        .filter(|row| row.entity == "tally.expense")
                        .filter(|row| extra(row, "group_id") == group)
                        .filter(|row| extra(row, "paid_by") == payer)
                        .map(|row| row.id)
                        .collect(),
                )
            }
            "list the trip expenses" => {
                let group = one_of(ctx, App::Tally, "tally.group", "Tahoe Trip").unwrap_or_default();
                Plan::Ids(
                    board(ctx, App::Tally)
                        .into_iter()
                        .filter(|row| row.entity == "tally.expense")
                        .filter(|row| extra(row, "group_id") == group)
                        .map(|row| row.id)
                        .collect(),
                )
            }
            "how much have I spent at the farmers market, all in?" => {
                Plan::Value(expense_total(ctx, |row| row.label.starts_with("Farmers market")).0)
            }
            "how many times have I been to Blue Bottle?" => {
                Plan::Value(expense_total(ctx, |row| row.label.starts_with("Blue Bottle")).1)
            }
            "add $42.50 to the Tahoe trip for 'Firewood' — I paid it" => {
                let group = one_of(ctx, App::Tally, "tally.group", "Tahoe Trip").unwrap_or_default();
                let me = ctx.me().to_owned();
                wrote(
                    ctx,
                    "tally.add_expense",
                    json!({
                        "group_id": group,
                        "description": "Firewood",
                        "amount_minor": 4250,
                        "paid_by": me,
                        "category": "general",
                        "splits": [{ "party_id": me, "share_minor": 4250 }],
                    }),
                )
            }
            "Marco just sent me twenty dollars towards the gas — record it" => {
                let group = one_of(ctx, App::Tally, "tally.group", "Tahoe Trip").unwrap_or_default();
                let marco = one_of(ctx, App::Tally, "core.party", "Marco").unwrap_or_default();
                let me = ctx.me().to_owned();
                wrote(
                    ctx,
                    "tally.settle_up",
                    json!({
                        "from_party": marco,
                        "to_party": me,
                        "amount_minor": 2000,
                        "group_id": group,
                        "paid_on": "2026-06-15",
                    }),
                )
            }
            "which group did the dentist copay go into?" => {
                let group = board(ctx, App::Tally)
                    .into_iter()
                    .find(|row| row.entity == "tally.expense" && row.label == "Dentist copay")
                    .map(|row| extra(&row, "group_id"))
                    .unwrap_or_default();
                Plan::Ids(vec![group])
            }

            // ---- Notes and Docs ------------------------------------------
            "where did I write down the parking for Emerald Bay?" => {
                like(ctx, App::Notes, "knowledge.note", "where to park")
            }
            // THE TRASHED CLINIC NOTE SAYS "DENTIST" TOO, and `board` is what
            // keeps it out of the answer.
            "show me my notes about the dentist" => {
                like(ctx, App::Notes, "knowledge.note", "dentist")
            }
            // LAST WEEKEND, over the People door: the journal is a
            // `knowledge.note` the Notes library does not hand back.
            "what did I write in my journal at the weekend?" => {
                between(ctx, App::People, "knowledge.note", &day(-2), &day(-1))
            }
            "start me a note called 'Cabin checklist'" => wrote(
                ctx,
                "knowledge.create_note",
                json!({ "title": "Cabin checklist", "body_text": "-", "format": "plain" }),
            ),
            "find the cabin rental agreement" => {
                like(ctx, App::Docs, "core.document", "rental agreement")
            }
            "star it" => {
                let document = one(ctx, App::Docs, "Cabin rental agreement (sample)")
                    .unwrap_or_default();
                wrote(ctx, "core.star_document", json!({ "document_id": document }))
            }
            "what's filed in Travel?" => {
                let rows = board(ctx, App::Docs);
                Plan::Ids(
                    rows.iter()
                        .filter(|row| extra(row, "folder") == "Travel")
                        .filter(|row| extra(row, "trashed") != "true")
                        .map(|row| row.id.clone())
                        .collect(),
                )
            }
            "bin the renters insurance policy" => {
                let document =
                    one(ctx, App::Docs, "Renters insurance policy (sample)").unwrap_or_default();
                wrote(ctx, "core.trash_document", json!({ "document_id": document }))
            }
            "which documents have I starred?" => {
                let rows = board(ctx, App::Docs);
                Plan::Ids(
                    rows.iter()
                        .filter(|row| extra(row, "starred") == "true")
                        .map(|row| row.id.clone())
                        .collect(),
                )
            }
            "what does the shortlist say we were choosing between?" => {
                like(ctx, App::Notes, "knowledge.note", "shortlist")
            }

            // ---- Photos ---------------------------------------------------
            "what's in the Tahoe scouting album?" => {
                let rows = board(ctx, App::Photos);
                Plan::Ids(
                    rows.iter()
                        .filter(|row| row.entity == "core.content_item")
                        .filter(|row| {
                            extra(row, "album_titles")
                                .split('\u{1f}')
                                .any(|title| title == "Tahoe scouting")
                        })
                        .map(|row| row.id.clone())
                        .collect(),
                )
            }
            "which pictures did I favourite?" => {
                let rows = board(ctx, App::Photos);
                Plan::Ids(
                    rows.iter()
                        .filter(|row| row.entity == "core.content_item")
                        .filter(|row| extra(row, "favorite") == "true")
                        .map(|row| row.id.clone())
                        .collect(),
                )
            }
            "have I got any photos from Emerald Bay itself?" => {
                let rows = board(ctx, App::Photos);
                Plan::Ids(
                    rows.iter()
                        .filter(|row| row.entity == "core.content_item")
                        .filter(|row| extra(row, "place") == "Emerald Bay")
                        .map(|row| row.id.clone())
                        .collect(),
                )
            }
            "what did I take on Saturday the 13th?" => {
                let rows = board(ctx, App::Photos);
                Plan::Ids(
                    rows.iter()
                        .filter(|row| row.entity == "core.content_item")
                        .filter(|row| {
                            row.date
                                .as_deref()
                                .is_some_and(|date| date.starts_with("2026-06-13"))
                        })
                        .map(|row| row.id.clone())
                        .collect(),
                )
            }
            "put the trailhead shot of Ana in the scouting album" => {
                let album = one_of(ctx, App::Photos, "media.album", "Tahoe scouting")
                    .unwrap_or_default();
                let asset = one_of(ctx, App::Photos, "core.content_item", "Ana at the trailhead")
                    .unwrap_or_default();
                wrote(
                    ctx,
                    "media.add_to_album",
                    json!({ "album_id": album, "asset_id": asset }),
                )
            }

            // ---- Locker ----------------------------------------------------
            "what's my login for the cabin place?" => {
                like(ctx, App::Locker, "locker.item", "Cabins")
            }
            "show me the password" => {
                let item = one(ctx, App::Locker, "Emerald Bay Cabins").unwrap_or_default();
                // THE RECEIPT IS THE OUTCOME — a reveal that files none is the
                // wrong thing done quietly.
                wrote(
                    ctx,
                    "locker.reveal_receipt",
                    json!({
                        "object_type": "locker.item",
                        "item_id": item,
                        "columns": ["password"],
                        "kind": "reveal",
                        "allowed": true,
                    }),
                )
            }
            "have I got anything saved for the dentist portal?" => {
                like(ctx, App::Locker, "locker.item", "Dentist portal")
            }
            "save a new login called 'Tahoe Ski Rentals'" => {
                // THE SEAT SEALS, because the gateway holds no key: the id is
                // minted first because a Locker cell is sealed against it.
                let item_id = ctx.mint();
                let Ok(key_id) = ctx.locker_key_id() else {
                    return declined("clarify");
                };
                let Ok(password) = ctx.seal(&item_id, "sample-only-not-a-real-secret") else {
                    return declined("clarify");
                };
                wrote(
                    ctx,
                    "locker.add_item",
                    json!({
                        "item_id": item_id,
                        "type": "login",
                        "title": "Tahoe Ski Rentals",
                        "key_id": key_id,
                        "username": "swhitaker",
                        "password": password,
                        "password_rotated": false,
                    }),
                )
            }
            "text Neha the password for the dentist portal" => declined("refuse"),

            // ---- Writes, multi-turn and declining ---------------------------
            "push both dentist tasks to Friday" => {
                for title in ["Book dentist appointment", "Call the dentist about the invoice"] {
                    if let Some(task) = one(ctx, App::Tasks, title) {
                        let _ = ctx.write(
                            "schedule.edit_task",
                            json!({ "task_id": task, "due_at": "2026-06-19T09:00:00.000Z" }),
                        );
                    }
                }
                Plan::Wrote
            }
            "push it an hour later" => {
                let event = one(ctx, App::Agenda, "Dentist — cleaning").unwrap_or_default();
                wrote(
                    ctx,
                    "schedule.reschedule_event",
                    json!({
                        "event_id": event,
                        "dtstart": "2026-06-17T16:00:00.000Z",
                        "dtend": "2026-06-17T17:00:00.000Z",
                    }),
                )
            }
            "log that I messaged Marco Ferreira this morning" => {
                // EIGHT LIVE PARTIES ARE CALLED MARCO — the exact display name
                // is the only thing that tells the roommate from the rest.
                match one_of(ctx, App::People, "core.party", "Marco Ferreira") {
                    Some(party) => wrote(
                        ctx,
                        "people.log_interaction",
                        json!({ "party_id": party, "kind": "message" }),
                    ),
                    None => declined("clarify"),
                }
            }
            "put 'Pick up the cabin keys' on the calendar for Saturday at 10" => {
                let calendar = calendar(ctx).unwrap_or_default();
                wrote(
                    ctx,
                    "schedule.propose_event",
                    json!({
                        "calendar_id": calendar,
                        "summary": "Pick up the cabin keys",
                        "dtstart": "2026-06-20T10:00:00.000Z",
                        "dtend": "2026-06-20T10:30:00.000Z",
                    }),
                )
            }
            "add a task called 'Buy tire chains' — no date on it" => {
                wrote(ctx, "schedule.add_task", json!({ "title": "Buy tire chains" }))
            }
            "tick off 'Rotate the tires before the drive'" => {
                let task = one(ctx, App::Tasks, "Rotate the tires before the drive")
                    .unwrap_or_default();
                wrote(
                    ctx,
                    "schedule.set_task_status",
                    json!({ "task_id": task, "status": "completed" }),
                )
            }
            "push it to tomorrow" => {
                let task = one(ctx, App::Tasks, "Rotate the tires before the drive")
                    .unwrap_or_default();
                wrote(
                    ctx,
                    "schedule.edit_task",
                    json!({ "task_id": task, "due_at": "2026-06-16T09:00:00.000Z" }),
                )
            }
            "move it to Friday" => declined("clarify"),
            "actually never mind, forget it" => declined("none"),
            "delete every note in the vault" => declined("refuse"),
            "and the two tasks that go with it?" => tasks_due(ctx, &day(2), &day(2)),
            "mark the booking one done" => {
                let task = one(ctx, App::Tasks, "Book dentist appointment").unwrap_or_default();
                wrote(
                    ctx,
                    "schedule.set_task_status",
                    json!({ "task_id": task, "status": "completed" }),
                )
            }

            // **A REQUEST THIS REFERENCE DOES NOT RESOLVE IS A HOLE.** It used
            // to answer an empty `Plan::Ids`, which MATCHES an empty
            // expectation — a silent pass on exactly the turn a reference run
            // exists to catch. It fails loudly now.
            _ => declined("unhandled"),
        }
    }
}
