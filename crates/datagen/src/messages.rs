//! STAGES 4 AND 5, THE PIPELINE: typed intents in, phone-style messages and a keep/drop verdict out.
//!
//! 1. **Write** (Haiku): sessions are batched (JSON in, JSON out). Each turn is a [`brief`] of the
//!    typed intent, the words it must say, and how it points at rows. A batch whose answer is
//!    unusable is asked again with a larger attempt number (a different prompt, so a different
//!    cache entry); a session still unwritten after three attempts is dropped.
//! 2. **Check** (mechanical): the free-text spans really appear, the reference axis is realised
//!    (a pronoun turn does not repeat a name an earlier turn said), no sealed value or placeholder.
//! 3. **Typos** (seeded Rust, [`crate::typos`]): light, never inside a span or a date word. The
//!    val sessions also get a heavy-typo copy, the noise split.
//! 4. **Ground** ([`verify::ground`]): the reference calls replayed with the real message.
//! 5. **Read back** (Haiku, [`verify::read_back`]): a second pass recovers the intent's slots.
//!
//! A turn that fails a stage is dropped with a reason; the turns before it stay as a shorter
//! session (the turns after depend on it). Everything is a pure function of the input, the seed
//! and the cache, so a rebuild from a warm cache is byte-identical and makes no call.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use jiff::civil::Date;
use serde::Serialize;
use serde_json::{Value, json};

use crate::brief::{Briefer, TurnBrief};
use crate::catalog::Catalog;
use crate::grid::cell_of;
use crate::intent::{Reference, Scenario};
use crate::llm::{Cache, Llm, json_of, parallel};
use crate::plan::Heard;
use crate::plan::is_placeholder;
use crate::rng::Rng;
use crate::settings::Split;
use crate::source::{SESSIONS, WORLDS};
use crate::style::{self, Style};
use crate::typos::{self, Level};
use crate::verify::{self, Expected};

/// Sessions per call, by default.
pub const BATCH: usize = 12;

/// Asks of the writer and the reader for one batch before its sessions are given up.
const ATTEMPTS: usize = 3;

#[derive(Debug, Clone)]
pub struct Config {
    /// Sessions per Haiku call.
    pub batch: usize,
    /// Calls in flight (and worlds replayed at once).
    pub concurrency: usize,
    /// A cache miss is an error, not a call.
    pub offline: bool,
    /// Write each prompt the cache lacks under `<dir>/{writer,reader}/<split>/` instead of asking, and stop with
    /// an error saying how many are pending (answer them with `datagen cache-put`, then run again).
    pub collect: Option<PathBuf>,
    /// At most this many sessions per split, spread evenly over its file.
    pub limit: Option<usize>,
    /// The typo stream's seed.
    pub seed: u64,
    /// The share of sessions in each style ([`style::ALL`] order).
    pub style_shares: [f64; 5],
    /// Choose which sessions are written at all, before any message ([`crate::preselect`]); `None` writes every
    /// session of the input.
    pub preselect: Option<Preselect>,
}

/// What pre-selection is asked: the mix, and how many times its targets and floors the writer is given.
#[derive(Debug, Clone)]
pub struct Preselect {
    pub mix: crate::mix::Config,
    pub headroom: f64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            batch: BATCH,
            concurrency: 6,
            offline: false,
            collect: None,
            limit: None,
            seed: 1,
            style_shares: style::DEFAULT_SHARES,
            preselect: None,
        }
    }
}

/// The model that writes and the model that reads back, for each split (train, val, test).
///
/// A model that reads back what it wrote agrees with itself, so the build refuses a split whose reader is its writer.
/// The test split's writer is never train's: the test messages are in a voice the training messages are not.
pub struct Models<'a> {
    pub writer: [&'a dyn Llm; 3],
    pub reader: [&'a dyn Llm; 3],
}

impl Models<'_> {
    /// # Errors
    ///
    /// A split whose reader is its writer, or a test split written by train's writer.
    pub fn check(&self) -> Result<()> {
        for (i, split) in Split::ALL.iter().enumerate() {
            if self.writer[i].model() == self.reader[i].model() {
                anyhow::bail!(
                    "the {} split is read back by its own writer ({}): give it another reader",
                    split.name(),
                    self.writer[i].model()
                );
            }
        }
        if self.writer[0].model() == self.writer[2].model() {
            anyhow::bail!(
                "the test split is written by train's writer ({}): the test writer must be another model",
                self.writer[0].model()
            );
        }
        Ok(())
    }
}

/// A pair's id and whether the session is its ask side, read off the record's tags (`pair:askact:<id>`, `askact:ask`).
fn pair_role(record: &Value) -> Option<(String, bool)> {
    let tags: Vec<&str> = record["tags"]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let id = tags.iter().find_map(|t| t.strip_prefix("pair:askact:"))?;
    Some((id.to_owned(), tags.contains(&"askact:ask")))
}

fn split_index(split: &str) -> Option<usize> {
    Split::ALL.iter().position(|s| s.name() == split)
}

// ------------------------------------------------------------------ the writer's prompt

/// One session as the writer sees it.
#[derive(Debug, Clone)]
pub struct Job {
    pub id: String,
    pub today: Date,
    pub briefs: Vec<TurnBrief>,
    pub style: Style,
    /// The session is in the test split: it is written from the test split's style wording.
    pub test: bool,
}

/// The writer's prompt for a batch. Nothing in it comes from a sealed value: a brief is built
/// from the typed scenario, and a world is presence-only.
#[must_use]
pub fn writer_prompt(jobs: &[&Job], attempt: usize) -> String {
    let sessions: Vec<Value> = jobs
        .iter()
        .enumerate()
        .map(|(i, job)| {
            let turns: Vec<Value> = job
                .briefs
                .iter()
                .enumerate()
                .map(|(t, b)| {
                    let mut turn = json!({
                        "turn": t + 1,
                        "ask": b.ask,
                        "say_verbatim": b.spans,
                        "how": b.how,
                    });
                    // only a turn that types a secret carries the key, so every other prompt is as it was
                    if !b.typed.is_empty() {
                        turn["typed_secret"] = json!(b.typed);
                    }
                    turn
                })
                .collect();
            json!({
                "id": format!("s{}", i + 1),
                "today": format!("{} {}", job.today.strftime("%A"), job.today),
                "style": job.style.instruction(job.test),
                "turns": turns,
            })
        })
        .collect();
    let secrets = jobs
        .iter()
        .any(|job| job.briefs.iter().any(|b| !b.typed.is_empty()));
    let retry = if attempt > 0 {
        format!(
            "\n(attempt {}: answer with valid JSON only, one message per turn.)\n",
            attempt + 1
        )
    } else {
        String::new()
    };
    format!(
        "You write what a person types on their phone to the personal assistant in their pocket (it holds their tasks, calendar, people, notes, documents, photos, money, health figures and locker). I give you sessions: each is one person's conversation as a list of turns. For every turn I say what it asks; you write the message the person types.\n\
\n\
How people type on a phone:\n\
- Terse. Fragments are normal (\"overdue tasks\", \"and last month?\", \"mark it done\"). Usually 2 to 12 words, up to 20 for a long ask. No greetings, no \"please\" most of the time, no emoji.\n\
- Vary the voice from session to session: mostly lowercase and little punctuation, sometimes a full sentence, sometimes a question mark. Do not start every message the same way.\n\
- A follow-up leans on the turns before it exactly as its \"how\" says: it is short and does not restate what the earlier turns already said.\n\
- Each session has a \"style\": write every message of that session in it, keeping to the hard rules.\n\
\n\
Hard rules:\n\
- Each message asks EXACTLY what its \"ask\" says: the same rows, conditions, numbers and period. Add nothing, drop nothing.\n\
- Every string in \"say_verbatim\" must appear in the message exactly as written (letters, spelling and spacing), even if it looks misspelt.\n\
- Numbers: the exact quantity, never rounded or approximated. A natural unit is fine (45 km for 45000 m, 90 minutes for 5400 s) when it is exactly equal.\n\
- Money: plain numbers with the currency word the ask uses (\"5000 rupees\", \"5k\", \"$40\"); never the rupee sign, never lakh or crore.\n\
- Dates: say them the way a person does (\"last week\", \"yesterday\", \"march 3 to 9\", \"in august\"), spelling the words out (\"tomorrow\", never \"tmrw\"). Never write ISO dates like 2026-10-12.\n\
- When no row is named, make the kind of thing unmistakable (tasks, events, people, notes, documents, photos, transactions, workouts, steps, accounts, locker items), so it cannot be read as another kind. When a row IS named, just say its name the way a person would (\"unstar Vera Haddad\", \"rename Dinner party menu to ...\"); do not add \"the person called\" or \"the task named\".\n\
- Use plain words for fields (\"heart rate\", \"sleep\", \"due\"), never code names (no \"heart_rate\", no \"sleep_min\") and never tool or system words (\"turn\", \"vault\", \"query\", \"row\").\n\
- Never write a password, PIN or secret value.\n\
{secrets}\n\
Answer with JSON only: {{\"sessions\": [{{\"id\": \"s1\", \"messages\": [\"...\", \"...\"]}}, ...]}} with exactly one message per turn, in order.{retry}\n\
\n\
Sessions:\n{}\n",
        serde_json::to_string_pretty(&sessions).unwrap_or_default(),
        secrets = if secrets {
            "- The one exception: a turn with \"typed_secret\" lists made-up values the person types in on purpose to store them (a password, a card number, a security code, the text of a secret note). Write each exactly as given, the way a person types it in; never invent another secret.\n"
        } else {
            ""
        }
    )
}

/// The messages of an answer, per session by position; a session the answer does not cover, or
/// covers with the wrong number of messages, is `None`.
#[must_use]
pub fn parse_messages(answer: &str, sizes: &[usize]) -> Vec<Option<Vec<String>>> {
    let mut out = vec![None; sizes.len()];
    let Ok(value) = json_of(answer) else {
        return out;
    };
    for s in value["sessions"].as_array().into_iter().flatten() {
        let Some(i) = s["id"]
            .as_str()
            .and_then(|id| id.strip_prefix('s'))
            .and_then(|n| n.parse::<usize>().ok())
            .and_then(|n| n.checked_sub(1))
        else {
            continue;
        };
        let list = s["messages"].as_array().or_else(|| s["turns"].as_array());
        let Some(list) = list else { continue };
        let texts: Vec<String> = list
            .iter()
            .filter_map(|m| m.as_str().map(|t| t.trim().to_owned()))
            .collect();
        if sizes.get(i) == Some(&texts.len()) && texts.iter().all(|t| !t.is_empty()) {
            out[i] = Some(texts);
        }
    }
    out
}

/// Write every job: batches in parallel, a failed session asked again in a later batch.
fn write_all(cache: &Cache<'_>, jobs: &[Job], cfg: &Config) -> Result<Vec<Option<Vec<String>>>> {
    let mut done: Vec<Option<Vec<String>>> = vec![None; jobs.len()];
    let mut todo: Vec<usize> = (0..jobs.len()).collect();
    for attempt in 0..ATTEMPTS {
        if todo.is_empty() {
            break;
        }
        let batches: Vec<Vec<usize>> = todo
            .chunks(cfg.batch.max(1))
            .map(<[usize]>::to_vec)
            .collect();
        let answers = parallel(&batches, cfg.concurrency, |batch| {
            let picked: Vec<&Job> = batch.iter().map(|i| &jobs[*i]).collect();
            let sizes: Vec<usize> = picked.iter().map(|j| j.briefs.len()).collect();
            let prompt = writer_prompt(&picked, attempt);
            no_sealed(&prompt)?;
            Ok::<_, anyhow::Error>(parse_messages(&cache.complete(&prompt)?, &sizes))
        });
        for (batch, answer) in batches.iter().zip(answers) {
            let answer = answer.context("a writer thread panicked")??;
            for (slot, got) in batch.iter().zip(answer) {
                if got.is_some() {
                    done[*slot] = got;
                }
            }
        }
        todo.retain(|i| done[*i].is_none());
        // a pending prompt is not a failed answer: ask no retry of it
        if cache.pending() > 0 {
            break;
        }
    }
    Ok(done)
}

/// One cache per split over the shared directory; collecting ones write their pending prompts apart.
fn open_caches<'a>(
    role: &str,
    models: &[&'a dyn Llm; 3],
    dir: &Path,
    cfg: &Config,
) -> Result<Vec<Cache<'a>>> {
    models
        .iter()
        .enumerate()
        .map(|(s, l)| {
            let cache = Cache::open(*l, dir, cfg.offline)?;
            Ok(match &cfg.collect {
                Some(c) => cache.collecting(&c.join(role).join(Split::ALL[s].name())),
                None => cache,
            })
        })
        .collect()
}

/// A collecting run stops where a stage left prompts pending: what follows would read empty answers.
fn pending_stop(role: &str, caches: &[Cache<'_>]) -> Result<()> {
    let n: usize = caches.iter().map(Cache::pending).sum();
    if n > 0 {
        anyhow::bail!(
            "pending: {n} {role} prompts written; answer them, `cache-put` them and run again"
        );
    }
    Ok(())
}

/// Locker stays presence-only: a prompt never holds a sealed placeholder (`placeholder:<key>:<field>`
/// is what a world seeds in memory) or a datagen placeholder.
///
/// # Errors
///
/// If `prompt` holds one.
pub fn no_sealed(prompt: &str) -> Result<()> {
    if prompt.contains("placeholder:") || prompt.contains("⟨m3:") {
        anyhow::bail!("a sealed or datagen placeholder reached a prompt");
    }
    Ok(())
}

// ------------------------------------------------------------------ the checks

fn fold(text: &str) -> String {
    text.replace(['\u{2019}', '\u{2018}'], "'")
        .replace(['\u{201c}', '\u{201d}'], "\"")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The mechanical checks of one message: `(reason, detail)` of the first that fails.
fn check_message(
    text: &str,
    brief: &TurnBrief,
    reference: Reference,
    earlier: &[&TurnBrief],
) -> Result<(), (String, String)> {
    let bad = |r: &str, d: String| Err((r.to_owned(), d));
    if text.chars().count() > 240 || text.contains('\n') {
        return bad(
            "hygiene",
            format!("{} characters or a line break", text.chars().count()),
        );
    }
    if is_placeholder(text) || text.contains("placeholder:") || text.contains('⟨') {
        return bad("hygiene", "a placeholder".to_owned());
    }
    let lower = text.to_lowercase();
    if lower.contains("lakh") || lower.contains("crore") || text.contains('₹') {
        // the runtime reads a number as written: it does not resolve lakh or crore, so the data must not teach them
        return bad("hygiene", "lakh, crore or the rupee sign".to_owned());
    }
    if text.contains("20") && has_iso_date(text) {
        return bad("hygiene", "an ISO date".to_owned());
    }
    let said = fold(text);
    for span in &brief.spans {
        if !said.contains(&fold(span)) {
            return bad("span", format!("`{span}` is not in the message"));
        }
    }
    if matches!(reference, Reference::Pronoun | Reference::Handle) {
        for b in earlier {
            for span in &b.spans {
                if span.chars().count() >= 4 && said.contains(&fold(span)) {
                    return bad(
                        "reference",
                        format!("a {} turn repeats `{span}`", reference.word()),
                    );
                }
            }
        }
    }
    Ok(())
}

fn has_iso_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.windows(10).any(|w| {
        w[..4].iter().all(u8::is_ascii_digit)
            && w[4] == b'-'
            && w[5..7].iter().all(u8::is_ascii_digit)
            && w[7] == b'-'
            && w[8..].iter().all(u8::is_ascii_digit)
    })
}

// ------------------------------------------------------------------ the run

#[derive(Debug, Clone, Serialize)]
pub struct DropInfo {
    pub reason: String,
    pub detail: String,
}

/// One session on its way through.
struct Item {
    split: String,
    record: Value,
    scenario: Scenario,
    today: Date,
    briefs: Vec<TurnBrief>,
    expected: Vec<Expected>,
    style: Style,
    /// The model that wrote the session's messages.
    writer: String,
    /// The act side of an ask-or-act pair says the ask side's message word for word: the index of the ask side.
    copies: Option<usize>,
    clean: Vec<String>,
    text: Vec<String>,
    /// Per turn: why it was dropped (a turn after a drop is cut and never judged).
    state: Vec<Option<DropInfo>>,
    /// Per turn: what it passed.
    passed: Vec<Vec<&'static str>>,
    /// The turns solved afresh against the real messages (stage 5a): what is written out.
    solved: Vec<Value>,
    heard: Vec<Heard>,
    noise: bool,
}

impl Item {
    /// Leading turns still alive.
    fn alive(&self) -> usize {
        self.state.iter().take_while(|s| s.is_none()).count()
    }

    fn drop_turn(&mut self, turn: usize, reason: &str, detail: String) {
        if self.state[turn].is_none() {
            self.state[turn] = Some(DropInfo {
                reason: reason.to_owned(),
                detail,
            });
        }
    }

    /// The first dropped turn that was judged (not cut), as `(turn, drop)`.
    fn first_drop(&self) -> Option<(usize, &DropInfo)> {
        self.state
            .iter()
            .enumerate()
            .find_map(|(i, s)| s.as_ref().map(|d| (i, d)))
    }
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct CellStat {
    pub seen: usize,
    pub kept: usize,
    pub reasons: BTreeMap<String, usize>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct SlotStat {
    pub asked: usize,
    pub recovered: usize,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct StyleStat {
    pub assigned: usize,
    pub written: usize,
    pub complying: usize,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Stats {
    pub sessions_in: usize,
    pub sessions_kept: usize,
    pub turns_in: usize,
    pub turns_judged: usize,
    pub turns_kept: usize,
    /// Turns lost only because an earlier turn of their session was dropped.
    pub turns_cut: usize,
    pub by_cell: BTreeMap<String, CellStat>,
    pub by_reference: BTreeMap<String, CellStat>,
    pub by_split: BTreeMap<String, CellStat>,
    pub reasons: BTreeMap<String, usize>,
    /// Turns the reader read, and those whose slots agreed with the intent.
    pub read: usize,
    pub recovered: usize,
    pub recovered_by_slot: BTreeMap<String, usize>,
    /// For every slot the reader was asked about (act, kind, period, number, leans, decline, filter, name, exclusion):
    /// how many it was asked and how many it recovered, so the recovery rate is told slot by slot.
    pub slot_recovery: BTreeMap<String, SlotStat>,
    pub noise_sessions: usize,
    pub noise_kept: usize,
    /// Per style: sessions given it, sessions a writer wrote, and those whose messages comply with it.
    pub styles: BTreeMap<String, StyleStat>,
}

pub struct Report {
    pub stats: Stats,
    pub text: String,
    pub calls: usize,
    pub hits: usize,
}

/// Load `<dir>/<split>/sessions.jsonl` of an intents run: `(split, record)` in file order.
fn load(dir: &Path, limit: Option<usize>) -> Result<Vec<(String, Value)>> {
    let mut out = Vec::new();
    for split in Split::ALL {
        let path = dir.join(split.name()).join(SESSIONS);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        // `limit` sessions spread evenly over the file (the file is ordered by grid cell, so a
        // prefix would be one corner of the grid)
        let take = limit.map_or(lines.len(), |l| l.min(lines.len()));
        for k in 0..take {
            let line = lines[k * lines.len() / take.max(1)];
            out.push((split.name().to_owned(), serde_json::from_str(line)?));
        }
    }
    Ok(out)
}

/// Pre-selection over the sessions an intents run holds: the mix on their typed intents, with the targets and floors
/// raised by the headroom. Returns what it chose and how many sessions that is.
fn preselect_records(
    catalog: &Catalog,
    loaded: &[(String, Value)],
    p: &Preselect,
) -> Result<(crate::preselect::Preselected, usize)> {
    let grid = crate::grid::Grid::build(catalog);
    let mut mix = p.mix.clone();
    mix.live = grid.live().iter().map(ToString::to_string).collect();
    mix.live_fields = crate::fields::live_labels(catalog, &grid);
    let mut features = Vec::with_capacity(loaded.len());
    for (split, record) in loaded {
        let scenario: Scenario = serde_json::from_value(record["scenario"].clone())
            .with_context(|| format!("scenario of {}", record["id"]))?;
        features.push(crate::render::features_of(
            record,
            &scenario,
            scenario.turns.len(),
            split,
            0,
        ));
    }
    let chosen = crate::preselect::choose(&features, &mix, p.headroom)?;
    let kept = chosen.keep.len();
    Ok((chosen, kept))
}

fn worlds_of(dir: &Path, items: &[Item]) -> Result<BTreeMap<String, Value>> {
    let mut worlds = BTreeMap::new();
    for item in items {
        let id = item.record["world"].as_str().unwrap_or_default().to_owned();
        if worlds.contains_key(&id) {
            continue;
        }
        let file = dir.join(WORLDS).join(format!("{id}.json"));
        let text = std::fs::read_to_string(&file).with_context(|| file.display().to_string())?;
        worlds.insert(id, serde_json::from_str(&text)?);
    }
    Ok(worlds)
}

/// Run stages 4 and 5 over the intents run in `input`, write the result to `out`.
///
/// # Errors
///
/// If the input cannot be read, a cache miss happens offline, the model fails, or `out` cannot be
/// written.
#[allow(clippy::too_many_lines)]
pub fn run(
    cfg: &Config,
    catalog: &Catalog,
    models: &Models<'_>,
    input: &Path,
    out: &Path,
) -> Result<Report> {
    models.check()?;
    // one cache directory: a key is the model and the prompt, so each split's models keep their own entries
    let cache_dir = out.join("llm-cache");
    let writers = open_caches("writer", &models.writer, &cache_dir, cfg)?;
    let readers = open_caches("reader", &models.reader, &cache_dir, cfg)?;
    let mut items: Vec<Item> = Vec::new();
    let mut loaded = load(input, cfg.limit)?;
    let preselected = match &cfg.preselect {
        Some(p) => {
            let (chosen, kept) = preselect_records(catalog, &loaded, p)?;
            let keep: std::collections::BTreeSet<usize> = chosen.keep.iter().copied().collect();
            let mut at = 0;
            loaded.retain(|_| {
                at += 1;
                keep.contains(&(at - 1))
            });
            debug_assert_eq!(loaded.len(), kept);
            Some(chosen)
        }
        None => None,
    };
    for (split, record) in loaded {
        let scenario: Scenario = serde_json::from_value(record["scenario"].clone())
            .with_context(|| format!("scenario of {}", record["id"]))?;
        let today: Date = record["today"]
            .as_str()
            .and_then(|t| t.get(..10))
            .context("a session with no `today`")?
            .parse()?;
        let briefer = Briefer { catalog, today };
        let briefs: Vec<TurnBrief> = scenario
            .turns
            .iter()
            .enumerate()
            .map(|(i, t)| briefer.turn(t, i))
            .collect();
        let expected = scenario
            .turns
            .iter()
            .map(|t| verify::expected(catalog, t, today))
            .collect();
        let n = scenario.turns.len();
        let style = style::assign(&cfg.style_shares, &scenario.id, n, cfg.seed);
        let writer = split_index(&split)
            .map(|s| models.writer[s].model().to_owned())
            .unwrap_or_default();
        items.push(Item {
            split,
            record,
            scenario,
            today,
            briefs,
            expected,
            style,
            writer,
            copies: None,
            clean: vec![String::new(); n],
            text: vec![String::new(); n],
            state: vec![None; n],
            passed: vec![Vec::new(); n],
            solved: Vec::new(),
            heard: Vec::new(),
            noise: false,
        });
    }

    // ---- ask-or-act pairs: one message, two worlds
    let mut ask_of: BTreeMap<String, usize> = BTreeMap::new();
    for (i, item) in items.iter().enumerate() {
        if let Some((id, true)) = pair_role(&item.record) {
            ask_of.insert(id, i);
        }
    }
    for item in &mut items {
        if let Some((id, false)) = pair_role(&item.record) {
            item.copies = ask_of.get(&id).copied();
        }
    }

    // ---- stage 4: write
    let jobs: Vec<Job> = items
        .iter()
        .map(|i| Job {
            id: i.scenario.id.clone(),
            today: i.today,
            briefs: i.briefs.clone(),
            style: i.style,
            test: i.split == "test",
        })
        .collect();
    let mut written: Vec<Option<Vec<String>>> = vec![None; jobs.len()];
    for (s, cache) in writers.iter().enumerate() {
        let at: Vec<usize> = (0..jobs.len())
            .filter(|i| split_index(&items[*i].split) == Some(s) && items[*i].copies.is_none())
            .collect();
        let sub: Vec<Job> = at.iter().map(|i| jobs[*i].clone()).collect();
        for (i, got) in at.iter().zip(write_all(cache, &sub, cfg)?) {
            written[*i] = got;
        }
    }
    pending_stop("writer", &writers)?;
    for (item, messages) in items.iter_mut().zip(written) {
        if item.copies.is_some() {
            continue;
        }
        let Some(messages) = messages else {
            item.drop_turn(
                0,
                "writer",
                "no usable answer after three attempts".to_owned(),
            );
            continue;
        };
        for (t, message) in messages.iter().enumerate() {
            let earlier: Vec<&TurnBrief> = item.briefs[..t].iter().collect();
            match check_message(
                message,
                &item.briefs[t],
                item.scenario.turns[t].reference,
                &earlier,
            ) {
                Ok(()) => {
                    item.clean[t].clone_from(message);
                    item.passed[t].push("check");
                }
                Err((reason, detail)) => {
                    item.drop_turn(t, &reason, detail);
                    break;
                }
            }
        }
    }

    // ---- typos, and the noise copy of val
    let master = Rng::new(cfg.seed).fork("typos");
    for item in &mut items {
        for t in 0..item.alive() {
            let mut rng = master.fork(&item.scenario.id).fork(&t.to_string());
            let level = if item.style == Style::Typos {
                Level::Heavy
            } else {
                Level::Light
            };
            item.text[t] = typos::apply(&item.clean[t], &item.briefs[t].spans, &mut rng, level);
        }
    }
    for i in 0..items.len() {
        let Some(a) = items[i].copies else { continue };
        let (clean, text, alive) = (
            items[a].clean.clone(),
            items[a].text.clone(),
            items[a].alive(),
        );
        if alive == 0 {
            items[i].drop_turn(0, "pair", "its ask side was dropped".to_owned());
            continue;
        }
        for t in 0..alive.min(items[i].state.len()) {
            let earlier: Vec<&TurnBrief> = items[i].briefs[..t].iter().collect();
            let checked = check_message(
                &clean[t],
                &items[i].briefs[t],
                items[i].scenario.turns[t].reference,
                &earlier,
            );
            match checked {
                Ok(()) => {
                    items[i].clean[t].clone_from(&clean[t]);
                    items[i].text[t].clone_from(&text[t]);
                    items[i].passed[t].push("check");
                }
                Err((reason, detail)) => {
                    items[i].drop_turn(t, &reason, detail);
                    break;
                }
            }
        }
        // the act side holds only the turns its ask side kept
        for t in alive..items[i].state.len() {
            items[i].drop_turn(t, "pair", "its ask side was cut here".to_owned());
        }
    }
    let mut noise: Vec<Item> = Vec::new();
    for item in items.iter().filter(|i| i.split == "val" && i.alive() > 0) {
        let n = item.alive();
        let mut copy = Item {
            split: "noise".to_owned(),
            record: item.record.clone(),
            scenario: item.scenario.clone(),
            today: item.today,
            briefs: item.briefs.clone(),
            expected: item.expected.clone(),
            style: item.style,
            writer: item.writer.clone(),
            copies: None,
            clean: item.clean.clone(),
            text: vec![String::new(); item.text.len()],
            state: item.state.clone(),
            passed: item.passed.clone(),
            solved: Vec::new(),
            heard: Vec::new(),
            noise: true,
        };
        let id = format!("{}~noise", item.scenario.id);
        copy.record["id"] = json!(id);
        for t in 0..n {
            let mut rng = master.fork(&id).fork(&t.to_string());
            copy.text[t] = typos::apply(
                &item.clean[t],
                &item.briefs[t].spans,
                &mut rng,
                Level::Heavy,
            );
        }
        noise.push(copy);
    }
    items.extend(noise);

    // ---- stage 5a: ground
    let worlds = worlds_of(input, &items)?;
    let mut by_world: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, item) in items.iter().enumerate() {
        if item.alive() > 0 {
            by_world
                .entry(item.record["world"].as_str().unwrap_or_default().to_owned())
                .or_default()
                .push(i);
        }
    }
    let groups: Vec<(String, Vec<usize>)> = by_world.into_iter().collect();
    let grounded = parallel(&groups, cfg.concurrency, |(world, idx)| {
        let doc = &worlds[world];
        let scratch = tempfile::tempdir()?;
        let world = crate::world::World::from_doc(doc)?;
        let sessions: Vec<_> = idx
            .iter()
            .map(|i| {
                let item = &items[*i];
                let n = item.alive();
                (
                    item.scenario.clone(),
                    item.text[..n].to_vec(),
                    item.record["turns"]
                        .as_array()
                        .map_or_else(Vec::new, |t| t[..n].to_vec()),
                )
            })
            .collect();
        verify::ground(&world, catalog, scratch.path(), &sessions)
    });
    for ((world, idx), result) in groups.iter().zip(grounded) {
        let result = result.context("a grounding thread panicked")??;
        let doc = &worlds[world];
        for (i, g) in idx.iter().zip(result) {
            let item = &mut items[*i];
            let n = item.alive();
            let upto = g.failed.as_ref().map_or(n, |(t, _, _)| *t);
            for t in 0..upto.min(n) {
                if let Err((reason, detail)) = verify::grounded(
                    &g.heard[t].block,
                    item.expected[t].period,
                    &verify::named_rows(doc, &item.scenario.turns[t]),
                ) {
                    item.drop_turn(t, reason, detail);
                    break;
                }
                item.passed[t].push("grounding");
            }
            if let Some((t, reason, detail)) = g.failed {
                item.drop_turn(t, &reason, detail);
            }
            if std::env::var_os("DATAGEN_DEBUG").is_some() {
                for (t, h) in g.heard.iter().enumerate() {
                    eprintln!(
                        "{} t{}: {}\n{}\n",
                        item.scenario.id,
                        t + 1,
                        item.text[t],
                        h.block
                    );
                }
            }
            item.solved = g.turns;
            item.heard = g.heard;
        }
    }

    // ---- stage 5b: read back (clean split sessions only; the noise copy is grounded, not read)
    let mut stats = Stats::default();
    let readable: Vec<usize> = (0..items.len())
        .filter(|i| !items[*i].noise && items[*i].alive() > 0)
        .collect();
    let mut reads: BTreeMap<usize, Vec<verify::Read>> = BTreeMap::new();
    for (s, cache) in readers.iter().enumerate() {
        let mut todo: Vec<usize> = readable
            .iter()
            .copied()
            .filter(|i| split_index(&items[*i].split) == Some(s))
            .collect();
        for attempt in 0..ATTEMPTS {
            if todo.is_empty() {
                break;
            }
            let batches: Vec<Vec<usize>> = todo
                .chunks(cfg.batch.max(1))
                .map(<[usize]>::to_vec)
                .collect();
            let answers = parallel(&batches, cfg.concurrency, |batch| {
                let jobs: Vec<(String, Date, Vec<String>)> = batch
                    .iter()
                    .map(|i| {
                        let item = &items[*i];
                        (
                            item.scenario.id.clone(),
                            item.today,
                            item.text[..item.alive()].to_vec(),
                        )
                    })
                    .collect();
                for (_, _, messages) in &jobs {
                    for m in messages {
                        no_sealed(m)?;
                    }
                }
                let asks = verify::Asks::of(batch.iter().flat_map(|i| &items[*i].expected));
                verify::read_back(cache, catalog, &jobs, attempt, asks)
            });
            for (batch, answer) in batches.iter().zip(answers) {
                let answer = answer.context("a reader thread panicked")??;
                for (i, got) in batch.iter().zip(answer) {
                    if let Some(got) = got {
                        reads.insert(*i, got);
                    }
                }
            }
            todo.retain(|i| !reads.contains_key(i));
            if cache.pending() > 0 {
                break;
            }
        }
    }
    pending_stop("reader", &readers)?;
    for i in readable {
        let item = &mut items[i];
        let Some(got) = reads.remove(&i) else {
            item.drop_turn(
                0,
                "readback_unavailable",
                "the reader gave no usable answer".to_owned(),
            );
            continue;
        };
        for (t, read) in got.iter().enumerate() {
            stats.read += 1;
            for s in verify::slots(catalog, &item.expected[t], read, t) {
                let stat = stats.slot_recovery.entry(s.name.to_owned()).or_default();
                stat.asked += 1;
                stat.recovered += usize::from(s.ok);
            }
            match verify::agree(catalog, &item.expected[t], read, t) {
                Ok(()) => {
                    stats.recovered += 1;
                    item.passed[t].push("readback");
                }
                Err((slot, detail)) => {
                    *stats.recovered_by_slot.entry(slot.to_owned()).or_default() += 1;
                    item.drop_turn(t, &format!("readback:{slot}"), detail);
                    // later turns still count toward the recovery rate, but are cut from the session
                }
            }
        }
    }

    stats_of(&mut stats, &items);
    write_out(input, out, &items, &stats, cfg.seed)?;
    let (mut calls, mut hits) = (0, 0);
    for cache in writers.iter().chain(&readers) {
        let (c, h) = cache.counts();
        calls += c;
        hits += h;
    }
    let mut text = report_text(&stats, &items);
    if let Some(chosen) = &preselected {
        text = format!("{}\n{text}", chosen.text());
        std::fs::write(
            out.join(crate::preselect::FILE),
            serde_json::to_string_pretty(chosen)?,
        )?;
    }
    std::fs::write(out.join("report.txt"), &text)?;
    let names = |l: &[&dyn Llm; 3]| -> Value {
        Split::ALL
            .iter()
            .zip(l)
            .map(|(s, l)| (s.name().to_owned(), json!(l.model())))
            .collect::<serde_json::Map<_, _>>()
            .into()
    };
    std::fs::write(
        out.join("models.json"),
        serde_json::to_string_pretty(&json!({
            "writers": names(&models.writer),
            "readers": names(&models.reader),
            "style_shares_target": style::ALL
                .iter()
                .zip(cfg.style_shares)
                .map(|(s, w)| (s.name().to_owned(), json!(w)))
                .collect::<serde_json::Map<_, _>>(),
            "styles": stats.styles,
            "read_back_recovery_by_slot": stats.slot_recovery,
        }))?,
    )?;
    Ok(Report {
        stats,
        text,
        calls,
        hits,
    })
}

fn stats_of(stats: &mut Stats, items: &[Item]) {
    for item in items {
        let judged_until = item.first_drop().map_or(item.state.len(), |(t, _)| t + 1);
        if item.noise {
            stats.noise_sessions += 1;
            stats.noise_kept += usize::from(item.alive() > 0 && item.first_drop().is_none());
            continue;
        }
        stats.sessions_in += 1;
        let style = stats
            .styles
            .entry(item.style.name().to_owned())
            .or_default();
        style.assigned += 1;
        if item.clean.iter().all(|c| !c.is_empty()) {
            style.written += 1;
            style.complying += usize::from(style::complies(item.style, &item.clean));
        }
        stats.turns_in += item.state.len();
        // a turn after the first drop was never judged: cut
        stats.turns_cut += item.state.len() - judged_until;
        stats.sessions_kept += usize::from(item.alive() > 0);
        for (t, turn) in item.scenario.turns.iter().enumerate().take(judged_until) {
            let cell = cell_of(turn).to_string();
            let dropped = item.state[t].as_ref();
            stats.turns_judged += 1;
            stats.turns_kept += usize::from(dropped.is_none());
            let bump = |c: &mut CellStat| {
                c.seen += 1;
                match dropped {
                    None => c.kept += 1,
                    Some(d) => *c.reasons.entry(reason_key(&d.reason)).or_default() += 1,
                }
            };
            bump(stats.by_cell.entry(cell).or_default());
            bump(
                stats
                    .by_reference
                    .entry(turn.reference.word().to_owned())
                    .or_default(),
            );
            bump(stats.by_split.entry(item.split.clone()).or_default());
            if let Some(d) = dropped {
                *stats.reasons.entry(reason_key(&d.reason)).or_default() += 1;
            }
        }
    }
}

fn reason_key(reason: &str) -> String {
    reason.to_owned()
}

fn write_out(
    input: &Path,
    out: &Path,
    items: &[Item],
    stats: &Stats,
    typo_seed: u64,
) -> Result<()> {
    let mut by_split: BTreeMap<&str, String> = BTreeMap::new();
    let mut dropped = String::new();
    for item in items {
        let n = item.alive();
        if n > 0 {
            let mut record = item.record.clone();
            if !item.solved.is_empty() {
                record["turns"] = Value::Array(item.solved.clone());
            }
            if let Some(turns) = record["turns"].as_array_mut() {
                turns.truncate(n);
                for (t, turn) in turns.iter_mut().enumerate() {
                    turn["user"] = json!(item.text[t]);
                    turn["verify"] = json!({
                        "keep": true,
                        "passed": item.passed[t],
                        "reason": "ok",
                    });
                }
            }
            if let Some(scenario) = record["scenario"]["turns"].as_array_mut() {
                scenario.truncate(n);
            }
            {
                let mut tags: Vec<Value> = record["tags"].as_array().cloned().unwrap_or_default();
                tags.push(json!(format!("style:{}", item.style.name())));
                if !item.writer.is_empty() {
                    tags.push(json!(format!("writer:{}", item.writer)));
                }
                record["tags"] = Value::Array(tags);
            }
            if n < item.state.len() {
                let mut tags: Vec<Value> = record["tags"].as_array().cloned().unwrap_or_default();
                if !tags.contains(&json!("truncated")) {
                    tags.push(json!("truncated"));
                }
                record["tags"] = Value::Array(tags);
            }
            let line = by_split.entry(split_dir(&item.split)).or_default();
            line.push_str(&serde_json::to_string(&record)?);
            line.push('\n');
        }
        if let Some((t, d)) = item.first_drop() {
            let row = json!({
                "split": item.split,
                "session": item.record["id"],
                "turn": t + 1,
                "cell": cell_of(&item.scenario.turns[t]).to_string(),
                "reference": item.scenario.turns[t].reference.word(),
                "reason": d.reason,
                "detail": d.detail,
                "message": item.text[t],
                "cut_after": item.state.len() - t - 1,
            });
            dropped.push_str(&serde_json::to_string(&row)?);
            dropped.push('\n');
        }
    }
    for dir in ["train", "val", "test", "noise"] {
        let d = out.join(dir);
        std::fs::create_dir_all(&d)?;
        std::fs::write(
            d.join(SESSIONS),
            by_split.get(dir).map_or("", String::as_str),
        )?;
    }
    std::fs::write(out.join("dropped.jsonl"), dropped)?;
    // the worlds travel with the sessions so the run opens as an EvalSource
    let wdir = out.join(WORLDS);
    std::fs::create_dir_all(&wdir)?;
    let mut ids: Vec<&str> = items
        .iter()
        .filter_map(|i| i.record["world"].as_str())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    for id in ids {
        std::fs::copy(
            input.join(WORLDS).join(format!("{id}.json")),
            wdir.join(format!("{id}.json")),
        )?;
    }
    // what the intents run says of itself travels on, so the data version can name its seeds and catalog
    let intents: Value = std::fs::read_to_string(input.join("manifest.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let manifest = json!({
        "stage": "messages+verify",
        "input": input.file_name().map(|n| n.to_string_lossy().into_owned()),
        "catalog_hash": intents["catalog_hash"],
        "seeds": {"master": intents["master_seed"], "typos": typo_seed},
        "stats": stats,
    });
    std::fs::write(
        out.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    Ok(())
}

fn split_dir(split: &str) -> &'static str {
    match split {
        "train" => "train",
        "val" => "val",
        "test" => "test",
        _ => "noise",
    }
}

fn pct(n: usize, d: usize) -> String {
    if d == 0 {
        "-".to_owned()
    } else {
        format!("{:.0}%", 100.0 * n as f64 / d as f64)
    }
}

fn table(title: &str, rows: &BTreeMap<String, CellStat>) -> String {
    let mut out = format!("\n{title}\n");
    for (name, c) in rows {
        let _ = write!(
            out,
            "  {name}: kept {} / {} ({} dropped)",
            c.kept,
            c.seen,
            pct(c.seen - c.kept, c.seen)
        );
        if !c.reasons.is_empty() {
            let why: Vec<String> = c.reasons.iter().map(|(r, n)| format!("{r} {n}")).collect();
            let _ = write!(out, "  [{}]", why.join(", "));
        }
        out.push('\n');
    }
    out
}

fn report_text(stats: &Stats, items: &[Item]) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "messages + verify: {} sessions in, {} kept (>= 1 turn); {} turns judged, {} kept ({}), {} cut behind a drop",
        stats.sessions_in,
        stats.sessions_kept,
        stats.turns_judged,
        stats.turns_kept,
        pct(stats.turns_kept, stats.turns_judged),
        stats.turns_cut
    );
    let _ = writeln!(
        out,
        "read-back recovery: {} / {} turns read agree with their intent ({})",
        stats.recovered,
        stats.read,
        pct(stats.recovered, stats.read)
    );
    if !stats.recovered_by_slot.is_empty() {
        let slots: Vec<String> = stats
            .recovered_by_slot
            .iter()
            .map(|(s, n)| format!("{s} {n}"))
            .collect();
        let _ = writeln!(out, "  disagreements by slot: {}", slots.join(", "));
    }
    for (name, s) in &stats.styles {
        let _ = writeln!(
            out,
            "  style {name}: {} sessions given it, {} written, {} of them keep to it ({})",
            s.assigned,
            s.written,
            s.complying,
            pct(s.complying, s.written)
        );
    }
    for (slot, s) in &stats.slot_recovery {
        let _ = writeln!(
            out,
            "  recovery of {slot}: {} / {} ({})",
            s.recovered,
            s.asked,
            pct(s.recovered, s.asked)
        );
    }
    let _ = writeln!(
        out,
        "noise split (heavy typos of val): {} sessions, {} kept whole",
        stats.noise_sessions, stats.noise_kept
    );
    let why: Vec<String> = stats
        .reasons
        .iter()
        .map(|(r, n)| format!("{r} {n}"))
        .collect();
    let _ = writeln!(out, "drop reasons: {}", why.join(", "));
    out.push_str(&table("by split (turns)", &stats.by_split));
    out.push_str(&table("by reference axis (turns)", &stats.by_reference));
    out.push_str(&table("by grid cell (turns)", &stats.by_cell));
    out.push_str("\nexamples (clean splits, every 9th kept session):\n");
    for item in items
        .iter()
        .filter(|i| !i.noise && i.alive() > 0)
        .step_by(9)
        .take(14)
    {
        let _ = writeln!(out, "  {}", item.record["id"].as_str().unwrap_or_default());
        for t in 0..item.alive() {
            let _ = writeln!(out, "    {}", item.text[t]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brief(spans: &[&str]) -> TurnBrief {
        TurnBrief {
            typed: Vec::new(),
            ask: String::new(),
            spans: spans.iter().map(|s| (*s).to_owned()).collect(),
            how: String::new(),
        }
    }

    #[test]
    fn a_span_must_appear_whatever_its_case() {
        let b = brief(&["Fix the bike light 83"]);
        assert!(
            check_message("rename fix the BIKE light 83 now", &b, Reference::Name, &[]).is_ok()
        );
        let (why, _) =
            check_message("rename the bike light", &b, Reference::Name, &[]).expect_err("missing");
        assert_eq!(why, "span");
    }

    #[test]
    fn a_pronoun_turn_does_not_repeat_a_name_an_earlier_turn_said() {
        let earlier = brief(&["Vera Adler"]);
        let now = brief(&[]);
        let err = check_message("star vera adler", &now, Reference::Pronoun, &[&earlier])
            .expect_err("repeats");
        assert_eq!(err.0, "reference");
        assert!(check_message("star her", &now, Reference::Pronoun, &[&earlier]).is_ok());
        // a name turn may say it again
        assert!(check_message("star vera adler", &now, Reference::Name, &[&earlier]).is_ok());
    }

    #[test]
    fn placeholders_iso_dates_and_runs_on_are_refused() {
        let b = brief(&[]);
        for bad in [
            "⟨m3:train-00-0001:t1⟩",
            "tasks due 2026-10-12",
            "line one\nline two",
            "placeholder:k0:password",
        ] {
            assert!(
                check_message(bad, &b, Reference::Select, &[]).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn an_answer_is_read_by_position_and_a_wrong_count_is_no_answer() {
        let answer = r#"```json
{"sessions": [{"id": "s2", "messages": ["a", "b"]}, {"id": "s1", "messages": ["only one"]}]}
```"#;
        let got = parse_messages(answer, &[2, 2]);
        assert_eq!(got[0], None);
        assert_eq!(got[1], Some(vec!["a".to_owned(), "b".to_owned()]));
        assert_eq!(parse_messages("not json", &[1]), vec![None]);
    }

    #[test]
    fn the_writer_prompt_carries_the_brief_and_nothing_sealed() {
        let job = Job {
            id: "x".to_owned(),
            today: "2026-10-12".parse().expect("date"),
            briefs: vec![brief(&["Office wifi"])],
            style: Style::Dictated,
            test: false,
        };
        let prompt = writer_prompt(&[&job], 0);
        assert!(prompt.contains("Office wifi"));
        assert!(prompt.contains(Style::Dictated.instruction(false)));
        assert!(!prompt.contains(Style::Dictated.instruction(true)));
        assert!(no_sealed(&prompt).is_ok());
        assert!(no_sealed("password is placeholder:k0:password").is_err());
    }
}
