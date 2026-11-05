//! STAGE 5, VERIFY: two independent checks that a written message still means its intent.
//!
//! (a) **Runtime grounding.** The session is solved again by the planner with the real message in
//! place of the placeholder. The runtime reads the message (a retraction ends the turn, names are
//! looked up, dates are read), so the check is that gold is unchanged, that the message does not
//! read as a retraction, that the runtime's own grounding lists the rows the intent names (the
//! `vault:` line) and reads the days its period covers (the `dates:` line). The reference calls
//! are the ones written afresh against the real message: what `#n` a row gets depends on it.
//!
//! (b) **Read-back.** A second Haiku pass reads each session's messages with no brief and says
//! what each asks (act, kind, period as dates, numbers in base units, which turn it leans on).
//! Those slots are compared with the typed intent. The share that agree is the recovery rate.

use std::path::Path;

use anyhow::{Result, bail};
use jiff::civil::Date;
use serde::Serialize;
use serde_json::{Value, json};

use crate::catalog::Catalog;
use crate::intent::{
    Intent, Lit, Measure, Reference, Scenario, Selector, Target, TurnIntent, Val, VerbArg,
};
use crate::llm::{Cache, json_of};
use crate::plan::{Heard, WorldRun};
use crate::world::World;

/// Why a turn failed a check.
pub type Why = (&'static str, String);

// ------------------------------------------------------------------ (a) grounding

/// What the runtime made of one session's real messages.
#[derive(Debug, Clone)]
pub struct Grounding {
    /// The session's turns solved afresh against the real messages (reference calls included:
    /// the runtime numbers rows by what each message makes it show).
    pub turns: Vec<Value>,
    /// What the runtime made of each message before any call.
    pub heard: Vec<Heard>,
    /// The first turn that did not hold, with why: `(turn, reason, detail)`.
    pub failed: Option<(usize, String, String)>,
}

/// Solve each session against its real messages on `world` and compare with what the placeholder
/// run recorded: the same gold (rows, values, writes) means the runtime still finds the same
/// rows and dates from the member's words. `sessions` are `(scenario, messages, original turns)`.
///
/// # Errors
///
/// If the world cannot be seeded.
pub fn ground(
    world: &World,
    catalog: &Catalog,
    scratch: &Path,
    sessions: &[(Scenario, Vec<String>, Vec<Value>)],
) -> Result<Vec<Grounding>> {
    let mut run = WorldRun::seed(world, catalog, scratch)?;
    let mut out = Vec::new();
    for (scenario, messages, original) in sessions {
        let mut scenario = scenario.clone();
        scenario.turns.truncate(messages.len());
        let solution = run.solve_with(&scenario, Some(messages))?;
        let turns: Vec<Value> = solution
            .record
            .as_ref()
            .and_then(|r| r["turns"].as_array().cloned())
            .unwrap_or_default();
        let mut failed = None;
        for (t, heard) in solution.heard.iter().enumerate() {
            if heard.ended {
                failed = Some((
                    t,
                    "grounding:retraction".to_owned(),
                    "the runtime reads the message as taking the request back".to_owned(),
                ));
                break;
            }
            if turns[t]["gold"] != original[t]["gold"] {
                failed = Some((
                    t,
                    "grounding:gold".to_owned(),
                    format!(
                        "gold changed under the real message: was {}, now {}",
                        original[t]["gold"], turns[t]["gold"]
                    ),
                ));
                break;
            }
        }
        if failed.is_none()
            && let Some(d) = solution.dropped.first()
        {
            failed = Some((
                d.turn,
                format!("grounding:{}", d.why.word()),
                d.detail.clone(),
            ));
        }
        out.push(Grounding {
            turns,
            heard: solution.heard,
            failed,
        });
    }
    Ok(out)
}

// ------------------------------------------------------------------ the slots an intent has

/// What a turn means, as slots a reader can recover.
#[derive(Debug, Clone, PartialEq)]
pub struct Expected {
    pub act: String,
    /// The kind it is about, when the words alone say it (not when it is a name or a pronoun).
    pub kind: Option<String>,
    pub period: Option<(Date, Date)>,
    pub numbers: Vec<f64>,
    /// The earlier turn (0-based) it leans on.
    pub leans: Option<(usize, crate::intent::Dep)>,
    pub decline: Option<String>,
}

fn numbers_of(sel: &Selector, out: &mut Vec<f64>) {
    for f in &sel.filters {
        if let Lit::Num(n) = f.value {
            out.push(n);
        }
    }
    if let Some(n) = sel.limit {
        out.push(n as f64);
    }
}

fn measure_numbers(m: &Measure, out: &mut Vec<f64>) {
    numbers_of(&m.sel, out);
}

fn period_of(sel: &Selector, today: Date) -> Option<(Date, Date)> {
    if sel.anchor.is_some() {
        return None;
    }
    sel.period.as_ref()?.range(today)
}

/// The slots of `turn`.
#[must_use]
pub fn expected(turn: &TurnIntent, today: Date) -> Expected {
    let named = matches!(
        turn.reference,
        Reference::Name | Reference::Nickname | Reference::Misspelling
    );
    let mut numbers = Vec::new();
    let mut e = Expected {
        act: String::new(),
        kind: None,
        period: None,
        numbers: Vec::new(),
        // only a pronoun or a handle cannot be understood alone; a carried or narrowed select
        // restates what it needs ("and photos from september 6")
        leans: if matches!(turn.reference, Reference::Pronoun | Reference::Handle) {
            turn.dep
        } else {
            None
        },
        decline: None,
    };
    let selects = |sel: &Selector, numbers: &mut Vec<f64>| {
        numbers_of(sel, numbers);
        (
            (sel.name.is_none() && !named).then(|| sel.kind.clone()),
            period_of(sel, today),
        )
    };
    match &turn.intent {
        Intent::Read { sel } => {
            "read".clone_into(&mut e.act);
            (e.kind, e.period) = selects(sel, &mut numbers);
        }
        Intent::Count { sel } => {
            "count".clone_into(&mut e.act);
            (e.kind, e.period) = selects(sel, &mut numbers);
        }
        Intent::Measure { measure } => {
            e.act.clone_from(&measure.op);
            (e.kind, e.period) = selects(&measure.sel, &mut numbers);
        }
        Intent::Compare { a, b } => {
            "compare".clone_into(&mut e.act);
            measure_numbers(a, &mut numbers);
            measure_numbers(b, &mut numbers);
        }
        Intent::Write { target, verb, arg } => {
            e.act.clone_from(verb);
            if let Target::Select { sel } = target {
                (e.kind, e.period) = selects(sel, &mut numbers);
            }
            if let VerbArg::When(_) = arg {
                // the new date is read as a slot of its own by the grounding of dates
            }
        }
        Intent::Edit { target, changes } => {
            "edit".clone_into(&mut e.act);
            if let Target::Select { sel } = target {
                (e.kind, e.period) = selects(sel, &mut numbers);
            }
            for c in changes {
                if let Val::Num(n) = c.value {
                    numbers.push(n);
                }
            }
        }
        Intent::Create { kind, fields } => {
            "create".clone_into(&mut e.act);
            e.kind = Some(kind.clone());
            for c in fields {
                if let Val::Num(n) = c.value {
                    numbers.push(n);
                }
            }
        }
        Intent::Recall { .. } => "recall".clone_into(&mut e.act),
        Intent::Ask { verb, .. } => {
            verb.as_deref().unwrap_or("read").clone_into(&mut e.act);
        }
        Intent::Decline { reason } => {
            "decline".clone_into(&mut e.act);
            e.decline = Some(reason.clone());
        }
    }
    e.numbers = numbers;
    e
}

// ------------------------------------------------------------------ (b) read-back

/// The reader's prompt for one batch of sessions.
#[must_use]
pub fn reader_prompt(
    catalog: &Catalog,
    batch: &[(String, Date, Vec<String>)],
    attempt: usize,
) -> String {
    let kinds: Vec<String> = catalog.kinds.iter().map(|k| k.name.clone()).collect();
    let verbs: Vec<String> = catalog.verbs.iter().map(|v| v.name.clone()).collect();
    let units: Vec<String> = catalog
        .kinds
        .iter()
        .flat_map(|k| {
            k.fields.iter().filter_map(|f| {
                f.unit
                    .as_ref()
                    .map(|u| format!("{} {} = {u}", k.name, f.name))
            })
        })
        .collect();
    let sessions: Vec<Value> = batch
        .iter()
        .enumerate()
        .map(|(i, (_, today, messages))| {
            json!({
                "id": format!("s{}", i + 1),
                "today": format!("{} {}", today.strftime("%A"), today),
                "messages": messages,
            })
        })
        .collect();
    let retry = if attempt > 0 {
        format!("\n(attempt {})\n", attempt + 1)
    } else {
        String::new()
    };
    format!(
        "You read messages a person typed on their phone to a personal-records assistant (tasks, calendar, people, notes, documents, photos, money, health, locker) and say what each message asks. Each session is one conversation; later messages may lean on earlier ones.\n\
\n\
For EVERY message return an object with:\n\
- \"act\": what is asked, one of: read (show/list/find rows), count (how many), sum, avg, min, max (a figure over rows), compare (two figures side by side), create (make a new row), edit (change a field of a row: rename, set a value), recall (show an earlier answer again, as it was), undo (take back the change just made: undo, revert, take that back), decline (cannot be done: unrelated to the records, wipe everything, invent a secret, or a person who is not there), or one of these actions on a row: {verbs}. An action only when the person commands a change; asking to see or list rows is read.\n\
- \"kind\": the sort of row the message is about, one of: {kinds} — or \"same\" if it only refers back to an earlier message, or \"unknown\" if a bare name does not say.\n\
- \"from\" and \"to\": the days the message restricts to, as YYYY-MM-DD (weeks run Monday to Sunday; a month is its first to last day; one day has from = to), or \"\" if it names no period.\n\
- \"numbers\": every number given as a limit, threshold or new value, converted to the base unit of the field it applies to (units: {units}); money in plain currency units; a list of numbers, [] if none.\n\
- \"leans_on\": the 1-based number of the earlier message this one needs to be understood (it uses it, it, them, that, \"and last month?\"), or null if it stands alone.\n\
- \"decline_reason\": only when act is decline: out_of_scope, unbounded_destruction, fabricated_secret or not_found; else null.\n\
\n\
Answer with JSON only: {{\"sessions\": [{{\"id\": \"s1\", \"turns\": [{{...}}, ...]}}, ...]}} with one object per message, in order.{retry}\n\
\n\
Sessions:\n{sessions}\n",
        verbs = verbs.join(", "),
        kinds = kinds.join(", "),
        units = units.join("; "),
        sessions = serde_json::to_string_pretty(&sessions).unwrap_or_default(),
    )
}

/// What the reader said about one message.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Read {
    pub act: String,
    pub kind: String,
    pub from: String,
    pub to: String,
    pub numbers: Vec<f64>,
    pub leans_on: Option<usize>,
    pub decline_reason: Option<String>,
}

fn read_of(v: &Value) -> Option<Read> {
    let text = |k: &str| v[k].as_str().unwrap_or_default().trim().to_lowercase();
    Some(Read {
        act: text("act").replace(' ', "_"),
        kind: text("kind"),
        from: text("from"),
        to: text("to"),
        numbers: v["numbers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|n| n.as_f64().or_else(|| n.as_str()?.parse().ok()))
            .collect(),
        leans_on: v["leans_on"]
            .as_u64()
            .or_else(|| v["leans_on"].as_str()?.parse().ok())
            .and_then(|n| usize::try_from(n).ok()),
        decline_reason: v["decline_reason"].as_str().map(str::to_lowercase),
    })
}

/// The reader's answer to a batch, per session (by position) the reads of its messages. A session
/// the answer does not cover, or covers with the wrong number of messages, is `None`.
///
/// # Errors
///
/// If the answer holds no JSON.
pub fn parse_reads(answer: &str, sizes: &[usize]) -> Result<Vec<Option<Vec<Read>>>> {
    let value = json_of(answer)?;
    let Some(sessions) = value["sessions"].as_array() else {
        bail!("no sessions in the answer");
    };
    let mut out = vec![None; sizes.len()];
    for s in sessions {
        let Some(i) = s["id"]
            .as_str()
            .and_then(|id| id.strip_prefix('s'))
            .and_then(|n| n.parse::<usize>().ok())
            .and_then(|n| n.checked_sub(1))
        else {
            continue;
        };
        let reads: Option<Vec<Read>> = s["turns"]
            .as_array()
            .map(|t| t.iter().filter_map(read_of).collect());
        if let (Some(reads), Some(&n)) = (reads, sizes.get(i))
            && reads.len() == n
        {
            out[i] = Some(reads);
        }
    }
    Ok(out)
}

fn same_kind(catalog: &Catalog, want: &str, got: &str) -> bool {
    got == want
        || catalog
            .kinds
            .iter()
            .any(|k| k.name == want && (k.plural == got || got.trim_end_matches('s') == want))
}

fn near(a: f64, b: f64) -> bool {
    (a.abs() - b.abs()).abs() <= 1e-6 * a.abs().max(b.abs()).max(1.0)
}

/// Do the reader's slots agree with the turn's?
///
/// # Errors
///
/// The first slot that disagrees, as `(slot, detail)`.
pub fn agree(catalog: &Catalog, want: &Expected, got: &Read, index: usize) -> Result<(), Why> {
    let act_ok = got.act == want.act
        || (want.act == "recall" && got.act == "read")
        || (want.act == "read" && got.act == "recall")
        // a person who is not in the vault is asked about like any other: only the runtime knows
        || (want.decline.as_deref() == Some("not_found") && got.act == "read");
    if !act_ok {
        return Err(("act", format!("meant {}, read back {}", want.act, got.act)));
    }
    if let Some(kind) = &want.kind
        && !matches!(got.kind.as_str(), "same" | "unknown")
        && !same_kind(catalog, kind, &got.kind)
    {
        return Err(("kind", format!("meant {kind}, read back {}", got.kind)));
    }
    if let Some((from, to)) = want.period
        && (got.from != from.to_string() || got.to != to.to_string())
    {
        return Err((
            "period",
            format!("meant {from}..{to}, read back {}..{}", got.from, got.to),
        ));
    }
    for n in &want.numbers {
        if !got.numbers.iter().any(|g| near(*n, *g)) {
            return Err(("number", format!("meant {n}, read back {:?}", got.numbers)));
        }
    }
    if let Some((from, dep)) = want.leans {
        let ok = match got.leans_on {
            None => false,
            Some(n) => {
                n == from + 1 || (matches!(dep, crate::intent::Dep::Handle) && n >= 1 && n <= index)
            }
        };
        if !ok {
            return Err((
                "leans",
                format!("meant turn {}, read back {:?}", from + 1, got.leans_on),
            ));
        }
    }
    if let Some(reason) = &want.decline
        // a not-found person read as an ordinary lookup has no reason to compare
        && !(reason == "not_found" && got.act == "read")
    {
        let got = got.decline_reason.as_deref().unwrap_or("");
        let ok = got == reason || (reason == "not_found" && got == "out_of_scope");
        if !ok {
            return Err(("decline", format!("meant {reason}, read back {got}")));
        }
    }
    Ok(())
}

/// One read-back call over a batch. `Err` is the cache's or the model's failure; a session the
/// answer does not cover is `None` and is retried by the caller.
///
/// # Errors
///
/// A cache miss when offline, or the model's failure.
pub fn read_back(
    cache: &Cache<'_>,
    catalog: &Catalog,
    batch: &[(String, Date, Vec<String>)],
    attempt: usize,
) -> Result<Vec<Option<Vec<Read>>>> {
    let prompt = reader_prompt(catalog, batch, attempt);
    let answer = cache.complete(&prompt)?;
    let sizes: Vec<usize> = batch.iter().map(|(_, _, m)| m.len()).collect();
    // An answer that cannot be read covers no session: each is asked again, as one it skipped.
    Ok(parse_reads(&answer, &sizes).unwrap_or_else(|_| vec![None; sizes.len()]))
}

// ------------------------------------------------------------------ (a) what the block says

/// The runtime's `dates:` line, as the dates it lists.
fn block_line<'a>(block: &'a str, key: &str) -> Option<&'a str> {
    block
        .lines()
        .find_map(|l| l.strip_prefix(key).map(str::trim))
}

/// The names of the rows a turn points at by name (a target, a link, an anchor, a container),
/// read off the world document by key: what the runtime's `vault:` line should list.
#[must_use]
pub fn named_rows(doc: &Value, turn: &TurnIntent) -> Vec<String> {
    fn sel_keys<'a>(sel: &'a Selector, keys: &mut Vec<&'a str>) {
        keys.extend(sel.link.iter().map(|l| l.key.as_str()));
        keys.extend(sel.anchor.iter().map(|l| l.key.as_str()));
    }
    let mut keys: Vec<&str> = Vec::new();
    let mut direct: Vec<&str> = Vec::new();
    match &turn.intent {
        Intent::Read { sel } | Intent::Count { sel } => sel_keys(sel, &mut keys),
        Intent::Measure { measure } => sel_keys(&measure.sel, &mut keys),
        Intent::Compare { a, b } => {
            sel_keys(&a.sel, &mut keys);
            sel_keys(&b.sel, &mut keys);
        }
        Intent::Write { target, arg, .. } => {
            match target {
                Target::Name {
                    key,
                    trashed: false,
                    ..
                } => direct.push(key),
                Target::Select { sel } => sel_keys(sel, &mut keys),
                Target::Name { .. } | Target::Turn { .. } => {}
            }
            if let VerbArg::Container(link) = arg {
                direct.push(&link.key);
            }
        }
        Intent::Edit { target, .. } => match target {
            Target::Name {
                key,
                trashed: false,
                ..
            } => direct.push(key),
            Target::Select { sel } => sel_keys(sel, &mut keys),
            Target::Name { .. } | Target::Turn { .. } => {}
        },
        _ => {}
    }
    keys.extend(direct);
    keys.into_iter()
        .filter_map(|key| {
            doc.as_object()?
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .find(|row| row["key"].as_str() == Some(key))
                .and_then(|row| row["name"].as_str().map(str::to_owned))
        })
        .collect()
}

/// Does the runtime's grounding of the message find what the intent names? The runtime lists the
/// rows the words name (`vault:`) and the days it reads off them (`dates:`). Every row the turn
/// points at by name must be listed, and when the intent has a period the line must read it: its
/// first day appears (a range the runtime reads whole must end on the intent's last day too).
///
/// # Errors
///
/// The first thing the runtime did not find.
pub fn grounded(block: &str, period: Option<(Date, Date)>, names: &[String]) -> Result<(), Why> {
    let vault = block_line(block, "vault:")
        .unwrap_or_default()
        .to_lowercase();
    for name in names {
        if !vault.contains(&name.to_lowercase()) {
            return Err((
                "grounding:name",
                format!("the runtime's `vault:` line does not list `{name}`: {vault}"),
            ));
        }
    }
    if let Some((from, to)) = period {
        let line = block_line(block, "dates:").unwrap_or_default();
        let (from, to) = (from.to_string(), to.to_string());
        let read = line.contains(&from) && (!line.contains("..") || line.contains(&to));
        if !read {
            return Err((
                "grounding:dates",
                format!("the runtime read `{line}`, the intent is {from}..{to}"),
            ));
        }
    }
    Ok(())
}
