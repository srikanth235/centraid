//! A SESSION: the turn loop, the session-wide `#n` / `@n` numbering, the
//! selector, the read tools, compaction and the step rules (SPEC §3, §4, §6).

use std::collections::{BTreeMap, BTreeSet};

use jiff::civil::DateTime;
use serde_json::{Map, Value, json};

use crate::dates::{self, Resolved};
use crate::meta::{self, FieldType, Kind, ROW_CAP, STEP_CAP};
use crate::render;
use crate::vaultio::Handle;
use crate::whr::{self, Cond};
use crate::world::{Key, Row, Val, World};

/// Which ablated parts of the prompt are on (SPEC §6.0.4, §6.1).
#[derive(Debug, Clone, Copy)]
pub struct Flags {
    pub directory: bool,
    pub preground: bool,
    pub tools: crate::prompt::ToolsMode,
}

impl Default for Flags {
    fn default() -> Self {
        Self {
            directory: true,
            preground: true,
            tools: crate::prompt::ToolsMode::Sig,
        }
    }
}

/// What one call produced.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub text: String,
    pub ends_turn: bool,
    pub effect: Map<String, Value>,
}

impl Outcome {
    pub(crate) fn error(text: impl Into<String>) -> Self {
        let text = text.into();
        let mut effect = Map::new();
        effect.insert("error".to_owned(), json!(text));
        Self {
            text,
            ends_turn: false,
            effect,
        }
    }

    pub(crate) fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ends_turn: false,
            effect: Map::new(),
        }
    }
}

/// One observation as the transcript holds it.
#[derive(Debug, Clone)]
pub(crate) struct Obs {
    pub turn: usize,
    pub seq: usize,
    /// A result block (`find`, `search`, `answer` rows, `open`): compacted.
    pub result: bool,
    pub handle: Option<usize>,
    pub summary: String,
    pub header: String,
    /// Lines, each tagged with the `#n` it shows.
    pub lines: Vec<(Vec<usize>, String)>,
    pub compacted: Option<BTreeSet<usize>>,
    /// A trailing note (the step cap) that is not part of the block.
    pub note: Option<String>,
    /// The header already names the rows (a recovery or `ambiguous:` line);
    /// the tagged lines render only once the block is compacted.
    pub inline: bool,
}

impl Obs {
    pub(crate) fn render(&self) -> String {
        let mut out = String::new();
        match &self.compacted {
            None => {
                out.push_str(&self.header);
                for (_, line) in &self.lines {
                    if line.is_empty() || self.inline {
                        continue;
                    }
                    out.push('\n');
                    out.push_str(line);
                }
            }
            Some(kept) => {
                let kept_names: Vec<String> = kept.iter().map(|n| format!("#{n}")).collect();
                let note = if kept_names.is_empty() {
                    "compacted".to_owned()
                } else {
                    format!("compacted; {} kept", kept_names.join(", "))
                };
                match self.handle {
                    Some(handle) => {
                        out.push_str(&format!("@{handle} · {} ({note})", self.summary));
                    }
                    None => out.push_str(&format!("{} ({note})", self.summary)),
                }
                for (numbers, line) in &self.lines {
                    if !line.is_empty() && numbers.iter().any(|n| kept.contains(n)) {
                        out.push('\n');
                        out.push_str(line);
                    }
                }
            }
        }
        if let Some(note) = &self.note {
            out.push('\n');
            out.push_str(note);
        }
        out
    }

    /// The `#n` this observation still shows.
    fn visible(&self) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        let lead = if self.compacted.is_none() {
            &self.header
        } else {
            &self.summary
        };
        if self.handle.is_none()
            && let Some(first) = lead_number(lead)
        {
            out.push(first);
        }
        for (numbers, _) in &self.lines {
            let shown = self
                .compacted
                .as_ref()
                .is_none_or(|kept| numbers.iter().any(|n| kept.contains(n)));
            if shown {
                out.extend(numbers.iter().copied());
            }
        }
        out
    }
}

/// The longest result (`find`, `search`, `answer`) whose rows are in focus
/// (`Session::focus`). A short list is on screen as a whole ("what's on
/// tomorrow" then "push training to 7"); a longer one is a search result, not
/// a subject. Four is the largest that keeps the held-out sessions' score:
/// three loses a turn (a four-task "this week" list, then "tick the gas
/// bill").
const FOCUS_RESULT_MAX: usize = 4;

/// Characters of the first call's reply the first repeat hint quotes.
pub const REPEAT_ECHO: usize = 160;

/// The second consecutive repeat's observation. A third ends the turn.
pub const REPEAT_NUDGE: &str = "error: repeated call again. Do not send it a third time: change a parameter the reply above points to, use another tool, or answer or decline with what you have.";

/// The first repeat's observation: what the identical call returned before.
/// Trainers see the same string, it is the runtime's own observation.
#[must_use]
pub fn repeat_hint(returned: &str) -> String {
    format!(
        "error: repeated call. You already made this exact call and it returned: {returned} Answer from that result, or change the call."
    )
}

/// The first line of `text`, at most `max` characters (`…` when cut), ending
/// in a full stop so a sentence can follow it.
fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    let mut out: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        out.push('…');
    }
    if !out.ends_with(['.', '…', '?', '!']) {
        out.push('.');
    }
    out
}

/// The `#n` a line opens with (`open`'s row line).
fn lead_number(text: &str) -> Option<usize> {
    text.strip_prefix('#')
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse().ok())
}

/// A result handle's content.
#[derive(Debug, Clone)]
pub(crate) struct ResultSet {
    pub kinds: Vec<Kind>,
    pub keys: Vec<Key>,
    pub value: Option<Value>,
}

/// One inverse write, recorded for `undo`.
#[derive(Debug, Clone)]
pub(crate) struct Inverse {
    pub command: String,
    pub input: Value,
    pub key: Key,
}

/// The whole session.
pub struct Session {
    pub(crate) handle: Handle,
    pub(crate) world: World,
    pub(crate) now: DateTime,
    pub(crate) me_name: String,
    pub(crate) flags: Flags,
    pub(crate) numbers: BTreeMap<Key, usize>,
    pub(crate) by_number: Vec<Key>,
    pub(crate) results: Vec<ResultSet>,
    pub(crate) observations: Vec<Obs>,
    pub(crate) references: Vec<(usize, BTreeSet<usize>)>,
    pub(crate) directory: Vec<usize>,
    pub(crate) preground: BTreeSet<usize>,
    pub(crate) turn: usize,
    pub(crate) steps: usize,
    pub(crate) seq: usize,
    pub(crate) last_call: Option<String>,
    /// What the last dispatched call returned (first line), for the repeat hint.
    pub(crate) last_text: String,
    /// Consecutive repeats of `last_call` this turn (see `REPEAT_HINT`).
    pub(crate) repeats: usize,
    pub(crate) turn_over: bool,
    /// `(turn, inverses, not undoable)`.
    pub(crate) writes: Vec<(usize, Vec<Inverse>, Vec<String>)>,
    pub(crate) undone: BTreeSet<usize>,
    /// `#n` of every row an `act` created or changed: addressable for the
    /// rest of the conversation, whatever compaction does.
    pub(crate) acted: BTreeSet<usize>,
    /// `(person, group id, currency)` of the settlements the running `act`
    /// planned, so its diff can carry the balance they moved.
    pub(crate) settling: Vec<(Key, String, String)>,
    /// The current user message, for grounding dates (`crate::ground`).
    pub(crate) message: String,
    /// Notes the runtime adds under the observation of the running call: a
    /// date it repaired, a row it resolved from context.
    pub(crate) pending_notes: Vec<String>,
    /// The slots of the running call's v2 trace, when it carries one
    /// (`crate::trace`): the guard and the bulk-write rule read them.
    pub(crate) trace: Option<crate::trace::Trace>,
}

/// A parsed selector.
#[derive(Debug, Clone, Default)]
pub(crate) struct Selector {
    pub kinds: Vec<Kind>,
    pub name: Option<String>,
    pub conds: Vec<Cond>,
    pub when: Option<Resolved>,
    pub linked_to: Vec<Key>,
    pub within: Option<usize>,
    pub exclude: BTreeSet<Key>,
    pub order: Option<(String, bool)>,
    pub limit: Option<usize>,
    pub trashed: bool,
}

/// Lowercase alphanumeric words.
#[must_use]
pub fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|char: char| !char.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `name` matching: exact whole words, all of them, any order.
#[must_use]
pub fn name_matches(query: &str, name: &str) -> bool {
    let wanted = words(query);
    let have = words(name);
    !wanted.is_empty() && wanted.iter().all(|word| have.contains(word))
}

pub(crate) fn arg_str(args: &Map<String, Value>, key: &str) -> Option<String> {
    match args.get(key)? {
        Value::String(text) => Some(text.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

pub(crate) fn arg_bool(args: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(Value::String(text)) => match text.trim().to_lowercase().as_str() {
            "true" | "yes" => Ok(Some(true)),
            "false" | "no" => Ok(Some(false)),
            _ => Err(format!("error: {key} is true or false, not \"{text}\".")),
        },
        Some(other) => Err(format!("error: {key} is true or false, not {other}.")),
    }
}

fn arg_int(args: &Map<String, Value>, key: &str) -> Result<Option<i64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("error: {key} is a whole number.")),
        Some(Value::String(text)) => text
            .trim()
            .parse()
            .map(Some)
            .map_err(|_| format!("error: {key} is a whole number, not \"{text}\".")),
        Some(other) => Err(format!("error: {key} is a whole number, not {other}.")),
    }
}

/// Split a handle list: `"#3, @2"` or `["#3","@2"]`.
pub(crate) fn handle_list(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().flat_map(handle_list).collect(),
        Value::String(text) => text
            .split([',', ' '])
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect(),
        Value::Number(number) => vec![format!("#{number}")],
        _ => Vec::new(),
    }
}

pub(crate) fn tool_params(tool: &str) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = match tool {
        "search" => vec!["text", "kind"],
        "find" => Vec::new(),
        "open" => vec!["row"],
        "compute" => vec!["op", "field", "group", "rows"],
        "act" => vec!["verb", "rows", "args", "more"],
        "answer" => vec!["rows", "op", "field", "value"],
        "ask" => vec!["question", "options"],
        "decline" => vec!["reason"],
        _ => return Vec::new(),
    };
    if matches!(tool, "find" | "compute" | "act" | "answer") {
        out.extend(meta::SELECTOR_PARAMS);
    }
    out
}

impl Session {
    /// Open a session over a vault.
    pub fn open(
        path: &std::path::Path,
        now: DateTime,
        me: &str,
        flags: Flags,
    ) -> Result<Self, String> {
        let clock = crate::vaultio::SetClock::at(crate::vaultio::millis_of(now));
        // A probe handle reads the journal size, which names this session's id
        // sequence: two sessions over one file never mint the same id, and the
        // same file and clock always mint the same ones.
        let probe = Handle::open(path, clock.clone(), "nativetools:probe")?;
        let count = World::load(&probe)?.entity_count;
        drop(probe);
        let handle = Handle::open(path, clock, &format!("nativetools:session:{count}:{now}"))?;
        let world = World::load(&handle)?;
        let me_name = if me.is_empty() {
            world
                .row(&world.me_key())
                .map(|row| row.name.clone())
                .unwrap_or_default()
        } else {
            me.to_owned()
        };
        let mut session = Self {
            handle,
            world,
            now,
            me_name,
            flags,
            numbers: BTreeMap::new(),
            by_number: Vec::new(),
            results: Vec::new(),
            observations: Vec::new(),
            references: Vec::new(),
            directory: Vec::new(),
            preground: BTreeSet::new(),
            turn: 0,
            steps: 0,
            seq: 0,
            last_call: None,
            last_text: String::new(),
            repeats: 0,
            turn_over: true,
            writes: Vec::new(),
            undone: BTreeSet::new(),
            acted: BTreeSet::new(),
            settling: Vec::new(),
            message: String::new(),
            pending_notes: Vec::new(),
            trace: None,
        };
        if flags.directory {
            session.number_directory();
        }
        Ok(session)
    }

    #[must_use]
    pub fn today(&self) -> jiff::civil::Date {
        self.now.date()
    }

    /// The `#n` of a row, minting one on first sight.
    pub(crate) fn number(&mut self, key: &Key) -> usize {
        if let Some(number) = self.numbers.get(key) {
            return *number;
        }
        self.by_number.push(key.clone());
        let number = self.by_number.len();
        self.numbers.insert(key.clone(), number);
        number
    }

    /// Containers, most recently used first, capped (SPEC §6.0.4).
    pub(crate) fn directory_rows(&self) -> Vec<(Kind, Vec<Key>, usize)> {
        let mut out = Vec::new();
        for kind in Kind::ALL {
            if !kind.spec().container {
                continue;
            }
            let mut rows: Vec<&Row> = self
                .world
                .of_kind(kind)
                .filter(|row| !row.trashed)
                .collect();
            // MOST RECENT FIRST, by creation: several vault commands stamp a
            // container's `updated_at` from the host's wall clock rather than
            // the injected one, so `updated_at` would make the prompt
            // nondeterministic.
            rows.sort_by(|a, b| {
                b.created
                    .cmp(&a.created)
                    .then_with(|| a.name.cmp(&b.name))
                    .then_with(|| a.id.cmp(&b.id))
            });
            let total = rows.len();
            let shown: Vec<Key> = rows
                .iter()
                .take(meta::DIRECTORY_CAP)
                .map(|row| row.key())
                .collect();
            out.push((kind, shown, total));
        }
        out
    }

    fn number_directory(&mut self) {
        for (_, keys, _) in self.directory_rows() {
            for key in keys {
                let number = self.number(&key);
                self.directory.push(number);
            }
        }
    }

    /// Resolve `#n` to a row. Numbers are session-stable, so a row shown in an
    /// earlier, since-compacted result still names exactly one row: it is
    /// accepted. Val runs showed the rejection only ever ended in a loop (4
    /// of 4 turns that hit it failed); the generator still never emits a
    /// compacted `#n` (SPEC §3), so gold is unchanged.
    pub(crate) fn resolve_row(&self, handle: &str) -> Result<Key, String> {
        let number: usize = handle
            .trim()
            .strip_prefix('#')
            .and_then(|n| n.parse().ok())
            .ok_or_else(|| format!("error: \"{handle}\" is not a row; rows are #n."))?;
        let key = self
            .by_number
            .get(number.wrapping_sub(1))
            .ok_or_else(|| format!("error: #{number} was never shown."))?;
        if !self.world.rows.contains_key(key) {
            return Err(format!("error: #{number} no longer exists in the vault."));
        }
        Ok(key.clone())
    }

    /// Resolve `@n`.
    pub(crate) fn resolve_result(&self, handle: &str) -> Result<usize, String> {
        let number: usize = handle
            .trim()
            .strip_prefix('@')
            .and_then(|n| n.parse().ok())
            .ok_or_else(|| format!("error: \"{handle}\" is not a result; results are @n."))?;
        if number == 0 || number > self.results.len() {
            return Err(format!(
                "error: @{number} was never issued; issued results: {}.",
                self.issued()
            ));
        }
        Ok(number)
    }

    fn issued(&self) -> String {
        if self.results.is_empty() {
            "none yet".to_owned()
        } else {
            (1..=self.results.len())
                .map(|n| format!("@{n}"))
                .collect::<Vec<_>>()
                .join(", ")
        }
    }

    /// A mixed `#n` / `@n` list → rows, in order, deduplicated.
    pub(crate) fn resolve_rows(&self, value: &Value) -> Result<Vec<Key>, String> {
        let mut out: Vec<Key> = Vec::new();
        let parts = handle_list(value);
        if parts.is_empty() {
            return Err(
                "error: rows is a list of #n and @n, like \"#3, #4\" or \"@2\".".to_owned(),
            );
        }
        for part in parts {
            let keys = if part.starts_with('@') {
                self.results[self.resolve_result(&part)? - 1].keys.clone()
            } else {
                vec![self.resolve_row(&part)?]
            };
            for key in keys {
                if !out.contains(&key) {
                    out.push(key);
                }
            }
        }
        Ok(out)
    }

    /// `rows`, with at most a `kind` beside it. The kind is a check on the
    /// rows, not a filter: a row of another kind is an error, never dropped.
    pub(crate) fn rows_arg(
        &self,
        args: &Map<String, Value>,
        both: &str,
    ) -> Result<Option<Vec<Key>>, String> {
        let Some(rows) = args.get("rows").filter(|value| !value.is_null()) else {
            return Ok(None);
        };
        let others = meta::SELECTOR_PARAMS.iter().any(|param| {
            *param != "kind" && args.get(*param).is_some_and(|value| !value.is_null())
        });
        if others {
            return Err(both.to_owned());
        }
        let keys = self.resolve_rows(rows)?;
        if let Some(text) = arg_str(args, "kind") {
            let kinds = self.parse_kinds(&text, false)?;
            for key in &keys {
                if !kinds.contains(&key.0) {
                    let number = self.numbers.get(key).copied().unwrap_or_default();
                    let name = key.0.name();
                    let article = if name.starts_with(['a', 'e', 'i', 'o', 'u']) {
                        "an"
                    } else {
                        "a"
                    };
                    return Err(format!(
                        "error: #{number} is {article} {name}, and kind says {}.",
                        kinds
                            .iter()
                            .map(|kind| kind.name())
                            .collect::<Vec<_>>()
                            .join(" or ")
                    ));
                }
            }
        }
        Ok(Some(keys))
    }

    fn parse_kinds(&self, text: &str, any: bool) -> Result<Vec<Kind>, String> {
        let mut kinds = Vec::new();
        for part in text
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
        {
            if part.eq_ignore_ascii_case("any") {
                if any {
                    return Ok(Kind::ALL.to_vec());
                }
                return Err(
                    "error: kind=any is only for search; name one kind or a comma list.".to_owned(),
                );
            }
            let kind = Kind::parse(part).ok_or_else(|| {
                format!("error: no kind \"{part}\". kinds: {}.", whr::kind_names())
            })?;
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        }
        if kinds.is_empty() {
            return Err(format!(
                "error: kind is empty. kinds: {}.",
                whr::kind_names()
            ));
        }
        Ok(kinds)
    }

    /// Read the selector parameters of a call.
    pub(crate) fn selector(&self, args: &Map<String, Value>) -> Result<Selector, String> {
        let mut selector = Selector::default();
        if let Some(within) = arg_str(args, "within") {
            selector.within = Some(self.resolve_result(&within)?);
        }
        selector.kinds = match arg_str(args, "kind") {
            Some(text) => self.parse_kinds(&text, false)?,
            None => match selector.within {
                Some(handle) => self.results[handle - 1].kinds.clone(),
                None => {
                    return Err(format!(
                        "error: a selector needs kind (or within=@n). kinds: {}.",
                        whr::kind_names()
                    ));
                }
            },
        };
        if selector.kinds.is_empty() {
            return Err("error: that result holds no rows to select from.".to_owned());
        }
        let multi = selector.kinds.len() > 1;
        for key in args.keys() {
            if multi
                && meta::SELECTOR_PARAMS.contains(&key.as_str())
                && !meta::MULTI_KIND_PARAMS.contains(&key.as_str())
            {
                return Err(format!(
                    "error: {key} needs exactly one kind (fields are per kind). A multi-kind selector takes {}.",
                    meta::MULTI_KIND_PARAMS.join(", ")
                ));
            }
        }
        selector.name = arg_str(args, "name")
            .map(|name| name.trim().trim_matches('"').to_owned())
            .filter(|name| !name.is_empty());
        if let Some(text) = arg_str(args, "where") {
            selector.conds = whr::parse(selector.kinds[0], &text)?;
        }
        if let Some(value) = args.get("when").filter(|value| !value.is_null()) {
            let expr = dates::parse(value).map_err(|why| dates::rejection(&why))?;
            if dates::uses_row(&expr) {
                return Err(dates::rejection(
                    "anchor row is legal only inside act; a filter reads from today",
                ));
            }
            let resolved =
                dates::evaluate(&expr, self.now, None).map_err(|why| dates::rejection(&why))?;
            if let Some(kind) = selector
                .kinds
                .iter()
                .find(|kind| kind.spec().date.is_none())
            {
                return Err(format!(
                    "error: {} have no date, so when cannot filter them. Dated kinds: {}.",
                    kind.plural(),
                    Kind::ALL
                        .iter()
                        .filter(|kind| kind.spec().date.is_some())
                        .map(|kind| kind.name())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            selector.when = Some(resolved);
        }
        if let Some(value) = args.get("linked_to").filter(|value| !value.is_null()) {
            selector.linked_to = self.resolve_rows(value)?;
        }
        if let Some(value) = args.get("exclude").filter(|value| !value.is_null()) {
            selector.exclude = self.resolve_rows(value)?.into_iter().collect();
        }
        if let Some(text) = arg_str(args, "order") {
            let mut parts = text.split_whitespace();
            let field = parts.next().unwrap_or_default().to_lowercase();
            let direction = parts.next().unwrap_or("asc").to_lowercase();
            if direction != "asc" && direction != "desc" {
                return Err(format!(
                    "error: order is \"field asc\" or \"field desc\", not \"{text}\"."
                ));
            }
            let kind = selector.kinds[0];
            let valid = field == "name"
                || (field == "date" && kind.spec().date.is_some())
                || kind.spec().field(&field).is_some();
            if !valid {
                return Err(format!(
                    "error: cannot order {} by \"{field}\". order fields: name, {}.",
                    kind.plural(),
                    whr::field_list(kind)
                ));
            }
            selector.order = Some((field, direction == "desc"));
        }
        if let Some(limit) = arg_int(args, "limit")? {
            if limit < 1 {
                return Err("error: limit is a positive whole number.".to_owned());
            }
            selector.limit = Some(usize::try_from(limit).unwrap_or(usize::MAX));
        }
        selector.trashed = arg_bool(args, "trashed")?.unwrap_or(false);
        Ok(selector)
    }

    /// Whether any selector parameter was given.
    pub(crate) fn has_selector(args: &Map<String, Value>) -> bool {
        meta::SELECTOR_PARAMS
            .iter()
            .any(|param| args.get(*param).is_some_and(|value| !value.is_null()))
    }

    /// Evaluate a selector: exactly the rows the constraint selects.
    pub(crate) fn select(&self, selector: &Selector) -> Vec<Key> {
        let candidates: Vec<Key> = match selector.within {
            Some(handle) => self.results[handle - 1].keys.clone(),
            None => {
                let mut rows: Vec<&Row> = self
                    .world
                    .rows
                    .values()
                    .filter(|row| selector.kinds.contains(&row.kind))
                    .collect();
                rows.sort_by(|a, b| default_order(a, b, &selector.kinds));
                rows.iter().map(|row| row.key()).collect()
            }
        };
        let mut out: Vec<Key> = candidates
            .into_iter()
            .filter(|key| {
                let Some(row) = self.world.row(key) else {
                    return false;
                };
                selector.kinds.contains(&row.kind)
                    && row.trashed == selector.trashed
                    && !selector.exclude.contains(key)
                    && selector
                        .name
                        .as_ref()
                        .is_none_or(|name| name_matches(name, &row.name))
                    && whr::matches(&self.world, row, &selector.conds)
                    && selector
                        .when
                        .is_none_or(|when| row.date.is_some_and(|stamp| when.contains(stamp)))
                    && selector
                        .linked_to
                        .iter()
                        .all(|target| self.world.linked(key, target))
            })
            .collect();
        if let Some((field, desc)) = &selector.order {
            out.sort_by(|a, b| {
                let (Some(a), Some(b)) = (self.world.row(a), self.world.row(b)) else {
                    return std::cmp::Ordering::Equal;
                };
                let ordering = order_value(a, field).cmp(&order_value(b, field));
                // Rows without the field sort last either way.
                let missing = order_value(a, field)
                    .is_none()
                    .cmp(&order_value(b, field).is_none());
                missing
                    .then(if *desc { ordering.reverse() } else { ordering })
                    .then_with(|| a.name.cmp(&b.name))
            });
        }
        if let Some(limit) = selector.limit {
            out.truncate(limit);
        }
        out
    }

    /// A link the metadata does not have: the dead-end observation with the
    /// rows whose name mentions the target (SPEC §5 "No link").
    pub(crate) fn no_link(&mut self, selector: &Selector) -> Option<Outcome> {
        for target in &selector.linked_to {
            for kind in &selector.kinds {
                if kind.spec().link_to(target.0).is_some() {
                    continue;
                }
                let target_name = self.world.row(target).map(|row| row.name.clone())?;
                // THE SUGGESTIONS STAY INSIDE THE NARROWING: with within=@n
                // only that result's rows are offered, never the whole vault.
                let scope: Option<BTreeSet<Key>> = selector
                    .within
                    .map(|handle| self.results[handle - 1].keys.iter().cloned().collect());
                let mentions: Vec<Key> = self
                    .world
                    .of_kind(*kind)
                    .filter(|row| !row.trashed)
                    .filter(|row| {
                        scope
                            .as_ref()
                            .is_none_or(|scope| scope.contains(&row.key()))
                    })
                    .filter(|row| {
                        let have = words(&row.name);
                        words(&target_name).iter().any(|word| have.contains(word))
                    })
                    .map(Row::key)
                    .take(ROW_CAP)
                    .collect();
                let mut text =
                    format!("{} are not linked to {}.", kind.plural(), target.0.plural());
                let mut lines = Vec::new();
                let capital = capitalise(kind.plural());
                if mentions.is_empty() {
                    text.push_str(&format!(
                        " No {} {}mentions \"{target_name}\". {} links: {}.",
                        kind.name(),
                        selector
                            .within
                            .map_or_else(String::new, |handle| format!("in @{handle} ")),
                        kind.name(),
                        whr::link_names(*kind)
                    ));
                } else {
                    let numbers: Vec<String> = mentions
                        .iter()
                        .map(|key| {
                            let number = self.number(key);
                            lines
                                .push((vec![number], render::short(number, &self.world.rows[key])));
                            format!("#{number}")
                        })
                        .collect();
                    text.push_str(&format!(
                        " {capital} {}whose name mentions \"{target_name}\": {}",
                        selector
                            .within
                            .map_or_else(String::new, |handle| format!("in @{handle} ")),
                        numbers.join(", ")
                    ));
                }
                let mut outcome = Outcome::text(text.clone());
                outcome
                    .effect
                    .insert("recovery".to_owned(), json!("no_link"));
                let summary = format!("{} are not linked to {}", kind.plural(), target.0.plural());
                self.push_obs_with(true, None, summary, text, lines, &mut outcome, true);
                return Some(outcome);
            }
        }
        None
    }

    /// Record an observation and render it into the outcome.
    pub(crate) fn push_obs(
        &mut self,
        result: bool,
        handle: Option<usize>,
        summary: String,
        header: String,
        lines: Vec<(Vec<usize>, String)>,
        outcome: &mut Outcome,
    ) {
        self.push_obs_with(result, handle, summary, header, lines, outcome, false);
    }

    /// The same, for a block whose header already names its rows.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn push_obs_with(
        &mut self,
        result: bool,
        handle: Option<usize>,
        summary: String,
        header: String,
        lines: Vec<(Vec<usize>, String)>,
        outcome: &mut Outcome,
        inline: bool,
    ) {
        let obs = Obs {
            turn: self.turn,
            seq: self.seq,
            result,
            handle,
            summary,
            header,
            lines,
            compacted: None,
            note: None,
            inline,
        };
        outcome.text = obs.render();
        self.observations.push(obs);
    }

    /// Issue a result handle over rows and render its block.
    pub(crate) fn issue(
        &mut self,
        kinds: &[Kind],
        keys: Vec<Key>,
        when: Option<Resolved>,
        lead: Option<String>,
        cap: usize,
        outcome: &mut Outcome,
    ) -> usize {
        self.results.push(ResultSet {
            kinds: kinds.to_vec(),
            keys: keys.clone(),
            value: None,
        });
        let handle = self.results.len();
        let rows: Vec<Row> = keys
            .iter()
            .filter_map(|key| self.world.row(key).cloned())
            .collect();
        let row_refs: Vec<&Row> = rows.iter().collect();
        let summary = render::count_phrase(kinds, &row_refs);
        let mut header = format!("@{handle} · {summary} (showing {})", rows.len().min(cap));
        if let Some(lead) = lead {
            header = format!("{lead}\n{header}");
        }
        if kinds.len() == 1 {
            header.push_str(&format!("   {}", render::card_hint(kinds[0])));
        }
        if let Some(when) = when {
            header.push_str(&format!(" · when: {}", when.echo()));
        }
        let mut lines = Vec::new();
        for (position, row) in rows.iter().take(cap).enumerate() {
            let number = self.number(&row.key());
            lines.push((
                vec![number],
                render::row_line(number, Some(position + 1), row, self.today()),
            ));
        }
        if rows.len() > cap {
            lines.push((
                Vec::new(),
                format!(
                    "… {} more in @{handle} (narrow with name, when, where, order or limit)",
                    rows.len() - cap
                ),
            ));
        }
        self.push_obs(true, Some(handle), summary, header, lines, outcome);
        handle
    }

    /// WHETHER AN EMPTY RESULT IS A DEAD END (SPEC §8.5): the `name` by
    /// itself — kind and name, no other condition — reaches no row (live, or
    /// trashed for a trashed read). A missing link is the other dead end and
    /// is `no_link`'s. Anything else that selects nothing — a name narrowed
    /// to zero by when/where/within/exclude, a linked row with no linked rows
    /// of the kind — is a valid empty answer.
    pub(crate) fn dead_end(&self, selector: &Selector) -> bool {
        selector.name.is_some()
            && self
                .select(&Selector {
                    kinds: selector.kinds.clone(),
                    name: selector.name.clone(),
                    trashed: selector.trashed,
                    ..Selector::default()
                })
                .is_empty()
    }

    /// `0 tasks match (when: …)`: an empty result that is not a dead end.
    pub(crate) fn none_text(&self, selector: &Selector) -> String {
        let mut text = format!("0 {}", render::plural_list(&selector.kinds));
        if let Some(name) = &selector.name {
            text.push_str(&format!(" called \"{name}\""));
        }
        text.push_str(" match");
        if let Some(when) = selector.when {
            text.push_str(&format!(" (when: {})", when.echo()));
        }
        text
    }

    /// The recovery observation for a selector that matched nothing.
    pub(crate) fn empty(&mut self, selector: &Selector, outcome: &mut Outcome) {
        let plural = render::plural_list(&selector.kinds);
        let mut lines = Vec::new();
        let text = if let Some(name) = &selector.name {
            let trashed: Vec<Key> = self
                .world
                .rows
                .values()
                .filter(|row| {
                    !selector.trashed
                        && row.trashed
                        && selector.kinds.contains(&row.kind)
                        && name_matches(name, &row.name)
                })
                .map(Row::key)
                .take(ROW_CAP)
                .collect();
            if trashed.is_empty() {
                let others: Vec<Key> = self
                    .world
                    .rows
                    .values()
                    .filter(|row| {
                        !row.trashed
                            && !selector.kinds.contains(&row.kind)
                            && name_matches(name, &row.name)
                    })
                    .map(Row::key)
                    .take(ROW_CAP)
                    .collect();
                let mut text = format!("0 {plural} called \"{name}\"");
                if selector.when.is_some()
                    || !selector.conds.is_empty()
                    || !selector.linked_to.is_empty()
                {
                    text.push_str(" with those constraints");
                }
                if others.is_empty() {
                    text.push_str(&format!(
                        ". Nothing else is called \"{name}\"; search finds near spellings."
                    ));
                } else {
                    let names: Vec<String> = others
                        .iter()
                        .map(|key| {
                            let number = self.number(key);
                            let short = render::short(number, &self.world.rows[key]);
                            lines
                                .push((vec![number], render::short(number, &self.world.rows[key])));
                            short
                        })
                        .collect();
                    text.push_str(&format!(
                        ". Other kinds called \"{name}\": {}",
                        names.join(", ")
                    ));
                }
                text
            } else {
                let kind_name = selector
                    .kinds
                    .iter()
                    .map(|kind| kind.name())
                    .collect::<Vec<_>>()
                    .join(" or ");
                let names: Vec<String> = trashed
                    .iter()
                    .map(|key| {
                        let number = self.number(key);
                        let short = render::short(number, &self.world.rows[key]);
                        lines.push((vec![number], short.clone()));
                        format!("{short} · trashed")
                    })
                    .collect();
                format!(
                    "no live {kind_name} called \"{name}\"; trashed: {}",
                    names.join(", ")
                )
            }
        } else {
            let live = self
                .world
                .rows
                .values()
                .filter(|row| selector.kinds.contains(&row.kind) && row.trashed == selector.trashed)
                .count();
            let mut text = format!("0 {plural} match");
            if let Some(when) = selector.when {
                text.push_str(&format!(" (when: {})", when.echo()));
            }
            text.push_str(&format!(
                ". There are {live} {} {plural} in all.",
                if selector.trashed { "trashed" } else { "live" }
            ));
            text
        };
        outcome.effect.insert("recovery".to_owned(), json!("empty"));
        let summary = text.split(['.', ';']).next().unwrap_or_default().to_owned();
        self.push_obs_with(true, None, summary, text, lines, outcome, true);
    }

    // -----------------------------------------------------------------
    // The turn loop.
    // -----------------------------------------------------------------

    /// A new user message: compaction first, then pre-grounding.
    pub fn user(&mut self, message: &str) -> Value {
        self.turn += 1;
        self.steps = 0;
        self.last_call = None;
        self.last_text.clear();
        self.repeats = 0;
        self.turn_over = false;
        self.message = message.to_owned();
        self.pending_notes.clear();
        let mut compacted = Vec::new();
        for index in 0..self.observations.len() {
            let obs = &self.observations[index];
            // THE PREVIOUS TURN STAYS WHOLE: a follow-up ("the second one",
            // "put it on that list") picks from it. Only turns before it
            // compact.
            if !obs.result || obs.compacted.is_some() || obs.turn + 1 >= self.turn {
                continue;
            }
            let seq = obs.seq;
            let kept: BTreeSet<usize> = self
                .references
                .iter()
                .filter(|(at, _)| *at > seq)
                .flat_map(|(_, numbers)| numbers.iter().copied())
                .chain(self.acted.iter().copied())
                .filter(|number| {
                    self.observations[index]
                        .lines
                        .iter()
                        .any(|(numbers, _)| numbers.contains(number))
                })
                .collect();
            self.observations[index].compacted = Some(kept);
            compacted.push(json!({"obs": index, "text": self.observations[index].render()}));
        }
        let preground = if self.flags.preground {
            crate::search::preground(self, message)
        } else {
            None
        };
        json!({
            "turn": self.turn,
            "preground": preground,
            "compacted": compacted,
        })
    }

    /// One model call.
    pub fn call(&mut self, tool: &str, args: &Value) -> Value {
        self.step(tool, args, None, None)
    }

    /// One model call with the think block written before it. A v2 trace in it
    /// (`crate::trace::parse`) is enforced; any other think is ignored, so
    /// old-format calls behave exactly as `call`.
    pub fn call_traced(&mut self, tool: &str, args: &Value, think: Option<&str>) -> Value {
        self.step(tool, args, None, think)
    }

    /// A model message that held no readable call: a counted step whose
    /// observation is the parse error (SPEC §5).
    pub fn call_unreadable(&mut self, message: &str) -> Value {
        self.step("", &Value::Null, Some(message.to_owned()), None)
    }

    fn step(
        &mut self,
        tool: &str,
        args: &Value,
        unreadable: Option<String>,
        think: Option<&str>,
    ) -> Value {
        if self.turn == 0 {
            self.user("");
        }
        if self.turn_over {
            return json!({
                "text": "error: the turn has ended; the next call belongs to a new user message.",
                "ends_turn": true,
                "effect": {"error": "turn over"},
            });
        }
        self.steps += 1;
        self.seq += 1;
        let canonical = format!("{tool} {}", canonical_json(args));
        let before = self.observations.len();
        let mut guarded = false;
        let mut outcome = if let Some(message) = unreadable {
            Outcome::error(message)
        } else if self.last_call.as_deref() == Some(canonical.as_str()) {
            self.repeat_outcome()
        } else {
            self.repeats = 0;
            self.trace = think.and_then(crate::trace::parse);
            let outcome = if let Some(trace) = &self.trace
                && let Some(refusal) = self.trace_guard(tool, args, trace)
            {
                // A CALL THAT CONTRADICTS ITS OWN TRACE is refused like a repeat:
                // an error observation, nothing run. It does not count as the
                // last call, so the same call under a corrected trace goes through.
                guarded = true;
                let mut refused = Outcome::error(refusal);
                refused.effect.insert("trace_guard".to_owned(), json!(true));
                refused
            } else {
                let (grounded, notes) = self.ground(tool, args);
                self.pending_notes = notes;
                let outcome = self.dispatch(tool, &grounded);
                self.last_text = first_line(&outcome.text, REPEAT_ECHO);
                outcome
            };
            self.trace = None;
            outcome
        };
        self.last_call = if guarded { None } else { Some(canonical) };
        self.references.push((self.seq, referenced(args)));
        let mut trailing: Vec<String> = std::mem::take(&mut self.pending_notes);
        if !trailing.is_empty() {
            outcome.text.push('\n');
            outcome.text.push_str(&trailing.join("\n"));
        }
        let mut cap_note = None;
        if !outcome.ends_turn && self.steps >= STEP_CAP {
            let note = format!("error: step cap ({STEP_CAP}) reached; the turn ends.");
            outcome.text.push('\n');
            outcome.text.push_str(&note);
            trailing.push(note.clone());
            cap_note = Some(note);
            outcome.ends_turn = true;
            outcome.effect.insert("cap".to_owned(), json!(true));
        }
        if outcome.ends_turn {
            self.turn_over = true;
        }
        let index = if self.observations.len() > before {
            self.observations.len() - 1
        } else {
            // Every call leaves an observation, so the transcript and the
            // compaction indices line up call for call.
            self.observations.push(Obs {
                turn: self.turn,
                seq: self.seq,
                result: false,
                handle: None,
                summary: String::new(),
                header: outcome.text.clone(),
                lines: Vec::new(),
                compacted: None,
                note: None,
                inline: false,
            });
            self.observations.len() - 1
        };
        if (cap_note.is_some() || !trailing.is_empty())
            && self.observations[index].header != outcome.text
        {
            self.observations[index].note = Some(trailing.join("\n"));
        }
        outcome.effect.insert("tool".to_owned(), json!(tool));
        json!({
            "text": outcome.text,
            "ends_turn": outcome.ends_turn,
            "effect": Value::Object(outcome.effect),
            "obs": index,
            "step": self.steps,
        })
    }

    /// CONVERSATIONAL FOCUS: the `#n` of every row the previous turn and this
    /// turn have opened, acted on, or found as the whole of a result of at
    /// most `FOCUS_RESULT_MAX` rows. A by-name act that fits several rows may
    /// take the one of them that is in focus, when exactly one is. Two kinds
    /// of block do not count: an `ambiguous:` block, which lists every
    /// candidate, and a longer list, where a row is there because it met a
    /// condition and the person is not thereby talking about it ("who's
    /// weekly" lists seven people; "rosa phoned" is not about the one Rosa
    /// among them).
    pub(crate) fn focus(&self) -> BTreeSet<usize> {
        self.observations
            .iter()
            .filter(|obs| obs.turn + 1 >= self.turn && !obs.header.starts_with("ambiguous"))
            .filter(|obs| {
                obs.handle.is_none_or(|handle| {
                    self.results
                        .get(handle - 1)
                        .is_some_and(|set| set.keys.len() <= FOCUS_RESULT_MAX)
                })
            })
            .flat_map(Obs::visible)
            .collect()
    }

    /// The observation of an identical call sent again right after itself.
    /// The call is not run again (a write would land twice). Escalation, one
    /// rung per consecutive repeat: a hint that names what the first call
    /// returned; a second nudge; then the turn ends as a `loop`.
    fn repeat_outcome(&mut self) -> Outcome {
        self.repeats += 1;
        let mut outcome = match self.repeats {
            1 => Outcome::error(repeat_hint(&self.last_text)),
            2 => Outcome::error(REPEAT_NUDGE),
            _ => {
                let mut ended = Outcome::error("error: repeated call");
                ended.ends_turn = true;
                ended.effect.insert("loop".to_owned(), json!(true));
                ended
            }
        };
        outcome
            .effect
            .insert("repeat".to_owned(), json!(self.repeats));
        outcome
    }

    /// How many repeats the session has already answered if `tool args`
    /// would be one more; `None` when it would not be a repeat. The driver
    /// asks before sending, to resample a repeat instead of spending it.
    #[must_use]
    pub fn peek_repeat(&self, tool: &str, args: &Value) -> Option<usize> {
        let canonical = format!("{tool} {}", canonical_json(args));
        (!self.turn_over && self.last_call.as_deref() == Some(canonical.as_str()))
            .then_some(self.repeats)
    }

    fn dispatch(&mut self, tool: &str, args: &Value) -> Outcome {
        let Some(args) = args.as_object() else {
            return Outcome::error(format!(
                "error: could not read the call; args are an object. tools: {}.",
                meta::TOOLS.join(", ")
            ));
        };
        if !meta::TOOLS.contains(&tool) {
            return Outcome::error(format!(
                "error: could not read the call; no tool \"{tool}\". tools: {}.",
                meta::TOOLS.join(", ")
            ));
        }
        let allowed = tool_params(tool);
        for key in args.keys() {
            if !allowed.contains(&key.as_str()) {
                return Outcome::error(format!(
                    "error: {tool} has no parameter \"{key}\". {tool} parameters: {}.",
                    allowed.join(", ")
                ));
            }
        }
        let result = match tool {
            "search" => crate::search::search(self, args),
            "find" => self.find(args),
            "open" => self.open_row(args),
            "compute" => self.compute(args, false),
            "act" => self.act(args),
            "answer" => self.answer(args),
            "ask" => self.ask(args),
            "decline" => self.decline(args),
            _ => unreachable!("checked above"),
        };
        result.unwrap_or_else(Outcome::error)
    }

    fn find(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        let selector = self.selector(args)?;
        if let Some(outcome) = self.no_link(&selector) {
            return Ok(outcome);
        }
        let keys = self.select(&selector);
        let mut outcome = Outcome::text("");
        if keys.is_empty() && self.dead_end(&selector) {
            self.empty(&selector, &mut outcome);
        } else if keys.is_empty() {
            let text = self.none_text(&selector);
            self.push_obs(true, None, text.clone(), text, Vec::new(), &mut outcome);
        } else {
            let handle = self.issue(
                &selector.kinds,
                keys.clone(),
                selector.when,
                None,
                meta::lookup_shown(keys.len()),
                &mut outcome,
            );
            outcome
                .effect
                .insert("result".to_owned(), json!(format!("@{handle}")));
        }
        outcome
            .effect
            .insert("rows".to_owned(), self.keys_json(&keys));
        Ok(outcome)
    }

    /// `[{kind, id, n}]` for the scorer.
    pub(crate) fn keys_json(&self, keys: &[Key]) -> Value {
        Value::Array(
            keys.iter()
                .map(|key| {
                    json!({
                        "kind": key.0.name(),
                        "id": key.1,
                        "n": self.numbers.get(key),
                    })
                })
                .collect(),
        )
    }

    fn open_row(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        let handle = arg_str(args, "row").ok_or("error: open needs row=#n.")?;
        if handle.contains(',') || handle.starts_with('@') {
            return Err("error: open takes exactly one row, #n.".to_owned());
        }
        let key = self.resolve_row(&handle)?;
        let row = self.world.rows[&key].clone();
        let number = self.number(&key);
        let header = render::row_line(number, None, &row, self.today());
        let mut lines: Vec<(Vec<usize>, String)> = Vec::new();
        if let Some(Val::Text(body)) = row.field("body") {
            let short: String = body.chars().take(600).collect();
            lines.push((Vec::new(), format!("body: \"{short}\"")));
        }
        if row.kind == Kind::Event
            && let (Some(start), Some(Val::Num(minutes))) = (row.date, row.field("duration"))
            && let Ok(end) = start.at().checked_add(jiff::Span::new().minutes(*minutes))
        {
            lines.push((
                Vec::new(),
                format!(
                    "ends {} {}",
                    dates::day_label(end.date()),
                    dates::clock(end.time())
                ),
            ));
        }
        if row.kind == Kind::LockerItem {
            let sealed: Vec<&str> = meta::REVEAL_FIELDS
                .iter()
                .filter(|(_, column)| row.extra.contains_key(column))
                .map(|(name, _)| *name)
                .collect();
            if !sealed.is_empty() {
                lines.push((
                    Vec::new(),
                    format!("sealed: {} (reveal to show)", sealed.join(", ")),
                ));
            }
        }
        let parent = self.world.parent_of(&key);
        if let Some(parent) = &parent {
            let n = self.number(parent);
            lines.push((
                vec![n],
                format!("parent: {}", render::named(&self.world, n, parent)),
            ));
        }
        if key == self.world.me_key() {
            lines.push((Vec::new(), "this is you (me)".to_owned()));
        }
        lines.push((
            Vec::new(),
            format!("created {}", row.created.get(..10).unwrap_or(&row.created)),
        ));
        let neighbours = self.world.neighbours(&key);
        for link in key.0.spec().links {
            let keys: Vec<Key> = neighbours
                .get(&link.kind)
                .into_iter()
                .flatten()
                .filter(|other| parent.as_ref() != Some(*other))
                .filter(|other| self.world.row(other).is_some_and(|row| !row.trashed))
                .cloned()
                .collect();
            let mut numbers = Vec::new();
            let mut names = Vec::new();
            for other in keys.iter().take(meta::OPEN_LINK_CAP) {
                let n = self.number(other);
                numbers.push(n);
                names.push(format!("#{n} \"{}\"", self.world.rows[other].name));
            }
            let mut line = format!("{} ({})", link.label, keys.len());
            if !names.is_empty() {
                line.push_str(&format!(": {}", names.join(", ")));
            }
            let more = keys.len().saturating_sub(meta::OPEN_LINK_CAP);
            if more > 0 {
                line.push_str(&format!(" +{more} more"));
            }
            lines.push((numbers, line));
        }
        let mut outcome = Outcome::text("");
        let summary = render::short(number, &row);
        self.push_obs(true, None, summary, header, lines, &mut outcome);
        outcome
            .effect
            .insert("rows".to_owned(), self.keys_json(&[key]));
        Ok(outcome)
    }

    fn ask(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        let question = arg_str(args, "question").ok_or("error: ask needs question.")?;
        let options = match args.get("options").filter(|value| !value.is_null()) {
            Some(value) => self.resolve_rows(value)?,
            None => Vec::new(),
        };
        let mut text = format!("asked: \"{question}\"");
        if !options.is_empty() {
            let names: Vec<String> = options
                .iter()
                .map(|key| {
                    let n = self.number(key);
                    render::named(&self.world, n, key)
                })
                .collect();
            text.push_str(&format!(" · options: {}", names.join(", ")));
        }
        let mut outcome = Outcome::text(text);
        outcome.ends_turn = true;
        outcome.effect.insert(
            "ask".to_owned(),
            json!({"question": question, "options": self.keys_json(&options)}),
        );
        Ok(outcome)
    }

    fn decline(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        let reason = arg_str(args, "reason").unwrap_or_default();
        if !meta::DECLINE_REASONS.contains(&reason.as_str()) {
            return Err(format!(
                "error: decline reason is one of {}.",
                meta::DECLINE_REASONS.join(", ")
            ));
        }
        let mut outcome = Outcome::text(format!("declined: {reason}"));
        outcome.ends_turn = true;
        outcome
            .effect
            .insert("decline".to_owned(), json!({"reason": reason}));
        Ok(outcome)
    }

    fn answer(&mut self, args: &Map<String, Value>) -> Result<Outcome, String> {
        if let Some(value) = arg_str(args, "value") {
            if args.len() > 1 {
                return Err("error: answer value=@n stands alone.".to_owned());
            }
            let handle = self.resolve_result(&value)?;
            let value = self.results[handle - 1].value.clone().ok_or_else(|| {
                format!("error: @{handle} holds rows, not a value; answer rows=@{handle}.")
            })?;
            let mut outcome = Outcome::text(format!("answered: @{handle}"));
            outcome.ends_turn = true;
            outcome.effect.insert("value".to_owned(), value);
            return Ok(outcome);
        }
        if args.contains_key("op") {
            let mut outcome = self.compute(args, true)?;
            // A RECOVERY IS NOT AN ANSWER: the model gets the observation and
            // another step, as `find` would.
            outcome.ends_turn = !outcome.effect.contains_key("recovery");
            return Ok(outcome);
        }
        let mut outcome = Outcome::text("");
        let (kinds, keys, when, ordered) = if let Some(keys) = self.rows_arg(
            args,
            "error: answer takes rows or a selector, not both; narrow with within=@n.",
        )? {
            let mut kinds: Vec<Kind> = Vec::new();
            for key in &keys {
                if !kinds.contains(&key.0) {
                    kinds.push(key.0);
                }
            }
            (kinds, keys, None, false)
        } else {
            let selector = self.selector(args)?;
            if let Some(outcome) = self.no_link(&selector) {
                return Ok(outcome);
            }
            let keys = self.select(&selector);
            if keys.is_empty() {
                // A DEAD END (SPEC §8.5; `dead_end`) is a recovery and the
                // turn goes on. Any other empty result is the answer
                // ("nothing is due"), and the turn ends.
                if self.dead_end(&selector) {
                    self.empty(&selector, &mut outcome);
                    return Ok(outcome);
                }
                let text = format!("answered: {}", self.none_text(&selector));
                let mut outcome = Outcome::text("");
                self.push_obs(false, None, text.clone(), text, Vec::new(), &mut outcome);
                outcome.ends_turn = true;
                outcome
                    .effect
                    .insert("answer".to_owned(), json!({"rows": []}));
                return Ok(outcome);
            }
            (
                selector.kinds.clone(),
                keys,
                selector.when,
                selector.order.is_some(),
            )
        };
        let handle = self.issue(
            &kinds,
            keys.clone(),
            when,
            Some("answered:".to_owned()),
            ROW_CAP,
            &mut outcome,
        );
        outcome.ends_turn = true;
        outcome.effect.insert(
            "answer".to_owned(),
            json!({"rows": self.keys_json(&keys), "ordered": ordered, "result": format!("@{handle}")}),
        );
        Ok(outcome)
    }

    /// `compute` and `answer op=…` (SPEC §4.3).
    fn compute(&mut self, args: &Map<String, Value>, answering: bool) -> Result<Outcome, String> {
        let op = arg_str(args, "op")
            .ok_or_else(|| format!("error: compute needs op: {}.", meta::OPS.join(", ")))?;
        if !meta::OPS.contains(&op.as_str()) {
            return Err(format!(
                "error: no op \"{op}\". ops: {}.",
                meta::OPS.join(", ")
            ));
        }
        let (kinds, keys, selector) = if let Some(keys) = self.rows_arg(
            args,
            "error: take rows or a selector, not both; narrow with within=@n.",
        )? {
            let mut kinds: Vec<Kind> = Vec::new();
            for key in &keys {
                if !kinds.contains(&key.0) {
                    kinds.push(key.0);
                }
            }
            (kinds, keys, None)
        } else {
            let selector = self.selector(args)?;
            if let Some(outcome) = self.no_link(&selector) {
                return Ok(outcome);
            }
            let keys = self.select(&selector);
            (selector.kinds.clone(), keys, Some(selector))
        };
        let field = arg_str(args, "field");
        let group = arg_str(args, "group");
        if op != "count" && kinds.len() > 1 {
            return Err(format!(
                "error: {op} needs exactly one kind; fields are per kind."
            ));
        }
        let kind = kinds.first().copied().unwrap_or(Kind::Task);
        let rows: Vec<Row> = keys
            .iter()
            .filter_map(|key| self.world.row(key).cloned())
            .collect();
        let (text_value, machine) = if op == "balance" {
            if group.is_some() {
                return Err("error: balance takes no group.".to_owned());
            }
            let linked = selector
                .as_ref()
                .map(|s| s.linked_to.clone())
                .unwrap_or_default();
            crate::values::balance(self, kind, &keys, &linked)?
        } else {
            if op == "count" && field.is_some() {
                return Err("error: count takes no field.".to_owned());
            }
            if op != "count" {
                let Some(field) = field.as_deref() else {
                    return Err(format!(
                        "error: {op} needs field. {} number fields: {}.",
                        kind.name(),
                        numeric_fields(kind)
                    ));
                };
                match kind.spec().field(field).map(|f| f.ty) {
                    Some(FieldType::Number | FieldType::Money) => {}
                    Some(_) => {
                        return Err(format!(
                            "error: {op} needs a number field; {field} is not. {} number fields: {}.",
                            kind.name(),
                            numeric_fields(kind)
                        ));
                    }
                    None => return Err(whr::no_field(kind, field)),
                }
            }
            if let Some(group) = group.as_deref()
                && kind.spec().field(group).is_none()
            {
                return Err(whr::no_field(kind, group));
            }
            crate::values::fold(&op, field.as_deref(), group.as_deref(), &rows, &self.world)
        };
        self.results.push(ResultSet {
            kinds: kinds.clone(),
            keys: keys.clone(),
            value: Some(machine.clone()),
        });
        let handle = self.results.len();
        let over = match &selector {
            Some(selector) if selector.within.is_some() => {
                format!("@{}", selector.within.unwrap_or_default())
            }
            _ => render::count_phrase(&kinds, &rows.iter().collect::<Vec<_>>()),
        };
        let what = match (&field, op.as_str()) {
            (_, "count") if over.starts_with('@') => {
                format!("count of {over}, {} rows", rows.len())
            }
            (_, "count") => format!("count of {over}"),
            (_, "balance") => text_value.1.clone(),
            (Some(field), _) if over.starts_with('@') => {
                format!("{op} of {field} over {over}, {} rows", rows.len())
            }
            (Some(field), _) => format!("{op} of {field} over {over}"),
            (None, _) => op.clone(),
        };
        let mut header = if group.is_some() {
            format!(
                "@{handle} · {what} by {}: {}",
                group.clone().unwrap_or_default(),
                text_value.0
            )
        } else {
            format!("@{handle} = {} ({what})", text_value.0)
        };
        if let Some(when) = selector.as_ref().and_then(|selector| selector.when) {
            header.push_str(&format!(" · when: {}", when.echo()));
        }
        if answering {
            header = format!("answered: {header}");
        }
        let mut outcome = Outcome::text("");
        self.push_obs(
            false,
            Some(handle),
            header.clone(),
            header,
            Vec::new(),
            &mut outcome,
        );
        outcome.effect.insert("value".to_owned(), machine);
        outcome
            .effect
            .insert("result".to_owned(), json!(format!("@{handle}")));
        Ok(outcome)
    }

    /// The system prompt pieces (SPEC §6.0).
    pub fn prompt(&mut self) -> Value {
        crate::prompt::prompt(self)
    }
}

fn numeric_fields(kind: Kind) -> String {
    let names: Vec<&str> = kind
        .spec()
        .fields
        .iter()
        .filter(|field| matches!(field.ty, FieldType::Number | FieldType::Money))
        .map(|field| field.name)
        .collect();
    if names.is_empty() {
        "none".to_owned()
    } else {
        names.join(", ")
    }
}

fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn default_order(a: &Row, b: &Row, kinds: &[Kind]) -> std::cmp::Ordering {
    let kind_rank = |row: &Row| kinds.iter().position(|kind| *kind == row.kind);
    kind_rank(a)
        .cmp(&kind_rank(b))
        .then_with(|| match (a.date, b.date) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        })
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.id.cmp(&b.id))
}

fn order_value(row: &Row, field: &str) -> Option<Val> {
    match field {
        "name" => Some(Val::Text(row.name.to_lowercase())),
        "date" => row.date.map(Val::Date),
        _ => row.field(field).cloned(),
    }
}

/// Every `#n` a call's arguments name.
fn referenced(args: &Value) -> BTreeSet<usize> {
    let mut out = BTreeSet::new();
    let mut walk = vec![args];
    while let Some(value) = walk.pop() {
        match value {
            Value::String(text) => {
                for part in text.split(|c: char| c == ',' || c.is_whitespace() || c == '"') {
                    if let Some(n) = part.strip_prefix('#').and_then(|n| n.parse().ok()) {
                        out.insert(n);
                    }
                }
            }
            Value::Array(items) => walk.extend(items),
            Value::Object(map) => walk.extend(map.values()),
            _ => {}
        }
    }
    out
}

/// Keys sorted, so two spellings of one call compare equal.
#[must_use]
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|key| format!("{}:{}", json!(key), canonical_json(&map[*key])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}
