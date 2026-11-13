//! `datagen drift`: has the tool contract moved under a data version, and by how much?
//!
//! The assistant's tools are the runtime's; a data version was rendered for the contract of the day
//! ([`crate::contract`]). When the tools change, the data may need nothing, a re-render, regenerated sessions or new
//! intents. [`report`] replays the reference calls of train and val (never test) through the CURRENT tools and says which,
//! in counts:
//!
//! * **contract**: the version's `tools_hash`, `prompt_hash` and `catalog_hash` against what this checkout computes;
//! * **shape**: reference calls that no longer validate against the current catalogue, by tool and argument (a tool or
//!   an argument that is gone, a required one missing, a value outside an enum);
//! * **behaviour**: reference calls that validate but, said through the runtime, no longer give the recorded gold
//!   (`assist_eval::replay`, the same path the version's own tests take, so no second judge);
//! * **coverage**: tools, arguments and kinds of the current catalogue with fewer examples in train than the floor
//!   (the manifest's per-cell floor for train, at least one).
//!
//! and a **level**, the most work any of them calls for: `wording` (the hashes differ and nothing else does: re-render
//! from the cache), `shape` or `behaviour` (regenerate those sessions) or `coverage` (new intents). The level is what
//! `crates/assist/data.json`'s `stale.level` takes when a tool change is accepted before the data is regenerated.
//!
//! Counts only, never time. The render stage's think round trip is not re-run: it needs the typed intents of the build,
//! which a published version does not carry, so the replay through the runtime stands for it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result, bail};
use centraid_assist::native::act::act_args;
use centraid_assist::native::meta::{self, Kind};
use centraid_assist::native::prompt::{ToolsMode, tools, tools_for};
use centraid_assist_eval::gold::Session;
use centraid_assist_eval::source::EvalSource;
use serde_json::Value;

use crate::contract::Contract;
use crate::source::DatagenSource;

/// The splits drift reads. The test split is never opened.
pub const READS: [&str; 2] = ["train", "val"];

/// How much work the drift calls for, least first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Nothing moved.
    None,
    /// The contract's hashes differ and nothing else does.
    Wording,
    /// Reference calls no longer validate.
    Shape,
    /// Reference calls validate but no longer give the recorded result.
    Behaviour,
    /// The catalogue has tools, arguments or kinds the data hardly shows.
    Coverage,
}

impl Level {
    /// The word `crates/assist/data.json` takes.
    #[must_use]
    pub const fn word(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Wording => "wording",
            Self::Shape => "shape",
            Self::Behaviour => "behaviour",
            Self::Coverage => "coverage",
        }
    }

    /// What to do about it.
    #[must_use]
    pub const fn advice(self) -> &'static str {
        match self {
            Self::None => "nothing to do: the data is for the contract the runtime serves",
            Self::Wording => {
                "re-render from the cache: `datagen unpack-cache` the version's LLM cache and `datagen render` it again; no model call is needed"
            }
            Self::Shape | Self::Behaviour => {
                "regenerate the sessions listed above: their reference calls no longer run as recorded, so the cache's messages stay and the intents are planned again"
            }
            Self::Coverage => {
                "write new intents for the tools, arguments and kinds listed above and build a new data version"
            }
        }
    }
}

/// One way a reference call no longer fits the current catalogue.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ShapeKey {
    pub tool: String,
    pub what: String,
}

/// What the calls of one tool may carry, from the current runtime.
#[derive(Debug, Clone, Default)]
pub struct ToolShape {
    /// The names a call may carry: the tool's own parameters and the executed form's (`create` and `edit` fold their
    /// fields into `args`, `do` takes `args`, `edit` and `do` still take a selector the runtime refuses by name later).
    pub arguments: BTreeSet<String>,
    /// The tool's own parameters, what coverage counts.
    pub properties: Vec<String>,
    /// Parameters with a closed list of values.
    pub enums: BTreeMap<String, BTreeSet<String>>,
    /// Whether the executed call carries named fields inside `args` (`create`, `edit`, `do`), counted from there too.
    pub folds: bool,
}

/// The tools of a tools mode and what their calls may carry.
///
/// A reference call is recorded in the form the runtime executes, not in the form the model is shown: `create` and
/// `edit` take one parameter per field in the compact catalogue but run as `args` lines (`native::legacy::fold_fields`),
/// and the sig mode's tools block lists signatures only, with no parameter schema. So the tool names are the mode's
/// (`tools_for`), the parameters are the compact schemas' they are generated from (`tools`), widened by the executed
/// form. What this cannot judge, the replay through the runtime does: a turn the runtime refuses is a shape finding.
#[derive(Debug, Clone)]
pub struct Catalogue {
    pub tools: BTreeMap<String, ToolShape>,
}

impl Catalogue {
    /// From the mode's tool names and the schemas their parameters come from.
    #[must_use]
    pub fn from_schema(names: &[String], schema: &[Value]) -> Self {
        let mut tools = BTreeMap::new();
        for name in names {
            let mut shape = ToolShape::default();
            if let Some(def) = schema
                .iter()
                .find(|t| t["function"]["name"].as_str() == Some(name.as_str()))
            {
                let properties = def["function"]["parameters"]["properties"].as_object();
                for (key, spec) in properties.into_iter().flatten() {
                    shape.arguments.insert(key.clone());
                    shape.properties.push(key.clone());
                    if let Some(list) = spec["enum"].as_array() {
                        shape.enums.insert(
                            key.clone(),
                            list.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect(),
                        );
                    }
                }
            }
            if matches!(name.as_str(), "create" | "edit" | "do") {
                shape.folds = true;
                shape.arguments.insert("args".to_owned());
            }
            if matches!(name.as_str(), "edit" | "do") {
                shape
                    .arguments
                    .extend(meta::SELECTOR_PARAMS.iter().map(|k| (*k).to_owned()));
            }
            tools.insert(name.clone(), shape);
        }
        Self { tools }
    }

    /// The current runtime's catalogue for `mode`.
    ///
    /// # Errors
    ///
    /// The `s2` mode: its tools are a frozen constant of another shape (`search`, `open`, `act`), the runtime renames its
    /// calls, and nothing can drift under it.
    pub fn of_mode(mode: ToolsMode) -> Result<Self> {
        if mode == ToolsMode::S2 {
            bail!(
                "tools mode `s2` is a frozen constant with tools of its own: there is nothing to drift under it"
            );
        }
        let names: Vec<String> = tools_for(mode)
            .iter()
            .filter_map(|t| t["function"]["name"].as_str().map(str::to_owned))
            .collect();
        Ok(Self::from_schema(&names, &tools()))
    }
}

/// The names a call carries, flat and, for a tool that folds, inside its `args` lines (read as the runtime reads them).
fn names_of(shape: &ToolShape, args: &serde_json::Map<String, Value>) -> BTreeSet<String> {
    let mut names: BTreeSet<String> = args.keys().cloned().collect();
    if shape.folds
        && let Ok(inner) = act_args(args.get("args"))
    {
        names.extend(inner.keys().map(|k| k.trim_end_matches('+').to_owned()));
    }
    names
}

/// Every way the reference calls of `sessions` no longer fit `catalogue`, counted by tool and what, and the
/// `(session, 1-based turn)` of each turn that has one: a tool that is gone, an argument no call of the tool may carry,
/// a value outside a closed list. A call the runtime is expected to refuse (`bad`) is skipped.
#[must_use]
pub fn shape(
    sessions: &[Session],
    catalogue: &Catalogue,
) -> (BTreeMap<ShapeKey, usize>, BTreeSet<(String, usize)>) {
    let mut counts: BTreeMap<ShapeKey, usize> = BTreeMap::new();
    let mut turns = BTreeSet::new();
    for session in sessions {
        for (i, turn) in session.turns.iter().enumerate() {
            for call in turn.reference.iter().filter(|c| !c.bad) {
                let mut found = Vec::new();
                match catalogue.tools.get(&call.tool) {
                    None => found.push("the tool is gone".to_owned()),
                    Some(shape) => {
                        for (name, value) in &call.args {
                            if !shape.arguments.contains(name) {
                                found.push(format!("argument `{name}` is gone"));
                            } else if let Some(allowed) = shape.enums.get(name) {
                                let said = value
                                    .as_str()
                                    .map_or_else(|| value.to_string(), str::to_owned);
                                if !allowed.contains(&said) {
                                    found.push(format!("`{name}` no longer takes `{said}`"));
                                }
                            }
                        }
                    }
                }
                for what in found {
                    *counts
                        .entry(ShapeKey {
                            tool: call.tool.clone(),
                            what,
                        })
                        .or_default() += 1;
                    turns.insert((session.id.clone(), i + 1));
                }
            }
        }
    }
    (counts, turns)
}

/// One item of the current catalogue the data shows too little.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Gap {
    /// `tool`, `argument` (of a tool) or `kind`.
    pub of: &'static str,
    pub name: String,
    pub examples: usize,
}

/// The tools, arguments and kinds of `catalogue` that `sessions` show fewer than `floor` times in reference calls
/// (`bad` calls skipped). An argument is shown by a call that carries it flat or, for `create`, `edit` and `do`, inside
/// its `args` lines, read as the runtime reads them. A kind is shown by a `kind` argument that names it.
#[must_use]
pub fn coverage(
    sessions: &[Session],
    catalogue: &Catalogue,
    kinds: &[&str],
    floor: usize,
) -> Vec<Gap> {
    let mut tool_n: BTreeMap<&str, usize> = BTreeMap::new();
    let mut arg_n: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut kind_n: BTreeMap<String, usize> = BTreeMap::new();
    for call in sessions
        .iter()
        .flat_map(|s| &s.turns)
        .flat_map(|t| &t.reference)
        .filter(|c| !c.bad)
    {
        *tool_n.entry(call.tool.as_str()).or_default() += 1;
        let Some(shape) = catalogue.tools.get(&call.tool) else {
            continue;
        };
        for name in names_of(shape, &call.args) {
            *arg_n.entry((call.tool.clone(), name)).or_default() += 1;
        }
        if let Some(kind) = call.args.get("kind").and_then(Value::as_str) {
            *kind_n.entry(kind.to_owned()).or_default() += 1;
        }
    }
    let mut gaps = Vec::new();
    for (name, shape) in &catalogue.tools {
        let n = tool_n.get(name.as_str()).copied().unwrap_or(0);
        if n < floor {
            gaps.push(Gap {
                of: "tool",
                name: name.clone(),
                examples: n,
            });
        }
        for arg in &shape.properties {
            let n = arg_n
                .get(&(name.clone(), arg.clone()))
                .copied()
                .unwrap_or(0);
            if n < floor {
                gaps.push(Gap {
                    of: "argument",
                    name: format!("{name}.{arg}"),
                    examples: n,
                });
            }
        }
    }
    for kind in kinds {
        let n = kind_n.get(*kind).copied().unwrap_or(0);
        if n < floor {
            gaps.push(Gap {
                of: "kind",
                name: (*kind).to_owned(),
                examples: n,
            });
        }
    }
    gaps.sort();
    gaps
}

/// What replaying the reference calls through the current runtime came to, as counts the report needs.
#[derive(Debug, Clone, Default)]
pub struct Replayed {
    pub sessions: usize,
    pub turns: usize,
    /// `(session, 1-based turn)` of each turn whose reference calls did not give the recorded gold.
    pub failed: Vec<(String, usize)>,
    /// `(session, 1-based turn)` of each turn the runtime refused outright (its own parser said no): not in `failed`.
    pub refused: Vec<(String, usize)>,
    /// Sessions the runtime could not run at all (a world that no longer seeds).
    pub unrunnable: Vec<String>,
}

impl From<&centraid_assist_eval::replay::ReplayReport> for Replayed {
    fn from(r: &centraid_assist_eval::replay::ReplayReport) -> Self {
        Self {
            sessions: r.sessions,
            turns: r.turns,
            failed: r
                .failed
                .iter()
                .filter(|f| f.ending != "error")
                .map(|f| (f.session.clone(), f.turn))
                .collect(),
            refused: r
                .failed
                .iter()
                .filter(|f| f.ending == "error")
                .map(|f| (f.session.clone(), f.turn))
                .collect(),
            unrunnable: r.unrunnable.iter().map(|(id, _)| id.clone()).collect(),
        }
    }
}

/// The contract's three hashes against this checkout's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HashDrift {
    pub tools: (String, String),
    pub prompt: (String, String),
    pub catalog: (String, String),
}

impl HashDrift {
    #[must_use]
    pub fn same(&self) -> bool {
        self.tools.0 == self.tools.1
            && self.prompt.0 == self.prompt.1
            && self.catalog.0 == self.catalog.1
    }
}

/// Everything drift found.
#[derive(Debug, Clone)]
pub struct Drift {
    pub version: String,
    pub hashes: HashDrift,
    pub sessions: usize,
    pub turns: usize,
    pub calls: usize,
    pub shape: BTreeMap<ShapeKey, usize>,
    pub shape_turns: usize,
    /// Behaviour failures by the tools of the failing turn's calls.
    pub behaviour: BTreeMap<String, usize>,
    pub behaviour_turns: usize,
    pub unrunnable: Vec<String>,
    pub gaps: Vec<Gap>,
    pub floor: usize,
    pub level: Level,
    /// Lines the report prints before the level: the shipped tools mode against the version's, a self-check.
    pub notes: Vec<String>,
}

/// Judge: the pure half. `hashes` is the contract against the runtime; `replayed` the replay's counts.
#[must_use]
pub fn judge(
    version: &str,
    hashes: HashDrift,
    sessions: &[Session],
    replayed: &Replayed,
    catalogue: &Catalogue,
    kinds: &[&str],
    floor: usize,
) -> Drift {
    let (mut shape_counts, mut shape_turns) = shape(sessions, catalogue);
    let by_id: BTreeMap<&str, &Session> = sessions.iter().map(|s| (s.id.as_str(), s)).collect();
    let tools_of = |id: &str, turn: usize| -> BTreeSet<&str> {
        by_id
            .get(id)
            .and_then(|s| s.turns.get(turn - 1))
            .into_iter()
            .flat_map(|t| t.reference.iter().filter(|c| !c.bad))
            .map(|c| c.tool.as_str())
            .collect()
    };
    // a turn the runtime's own parser refused is a shape finding too: it names the tools of the turn
    for (id, turn) in &replayed.refused {
        if shape_turns.insert((id.clone(), *turn)) {
            for tool in tools_of(id, *turn) {
                *shape_counts
                    .entry(ShapeKey {
                        tool: tool.to_owned(),
                        what: "the runtime refused the turn's calls".to_owned(),
                    })
                    .or_default() += 1;
            }
        }
    }
    let mut behaviour: BTreeMap<String, usize> = BTreeMap::new();
    let mut behaviour_turns = 0;
    for (id, turn) in &replayed.failed {
        // a turn that no longer validates is the shape's; the rest ran and gave another result
        if shape_turns.contains(&(id.clone(), *turn)) {
            continue;
        }
        behaviour_turns += 1;
        for tool in tools_of(id, *turn) {
            *behaviour.entry(tool.to_owned()).or_default() += 1;
        }
    }
    let train: Vec<Session> = sessions
        .iter()
        .filter(|s| s.split.as_deref() == Some("train"))
        .cloned()
        .collect();
    let gaps = coverage(&train, catalogue, kinds, floor);
    let calls = sessions
        .iter()
        .flat_map(|s| &s.turns)
        .flat_map(|t| &t.reference)
        .filter(|c| !c.bad)
        .count();
    let mut level = Level::None;
    if !hashes.same() {
        level = Level::Wording;
    }
    if !shape_counts.is_empty() {
        level = level.max(Level::Shape);
    }
    if behaviour_turns > 0 || !replayed.unrunnable.is_empty() {
        level = level.max(Level::Behaviour);
    }
    if !gaps.is_empty() {
        level = level.max(Level::Coverage);
    }
    let mut notes = Vec::new();
    if hashes.same() && !shape_counts.is_empty() {
        notes.push(
            "SELF-CHECK: every contract hash is the same, yet calls are reported as no longer fitting. An unchanged contract cannot do that: this points at a fault in this check or in the data, not at a tool change.".to_owned(),
        );
    }
    Drift {
        version: version.to_owned(),
        hashes,
        sessions: sessions.len(),
        turns: replayed
            .turns
            .max(sessions.iter().map(|s| s.turns.len()).sum()),
        calls,
        shape: shape_counts,
        shape_turns: shape_turns.len(),
        behaviour,
        behaviour_turns,
        unrunnable: replayed.unrunnable.clone(),
        gaps,
        floor,
        level,
        notes,
    }
}

impl Drift {
    /// What a publish refuses: coverage above zero, or any count of shape or behaviour above zero, each in words with its
    /// counts. Empty when the data fits the contract the runtime serves, as far as drift can tell. A difference of the
    /// contract's hashes alone (`wording`) is not one: it is re-rendered from the cache.
    #[must_use]
    pub fn refusals(&self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.gaps.is_empty() {
            let shown: Vec<String> = self
                .gaps
                .iter()
                .take(5)
                .map(|g| format!("{} {}: {}", g.of, g.name, g.examples))
                .collect();
            out.push(format!(
                "drift reports coverage {}: {} item(s) of the current catalogue have fewer than {} example(s) in train ({}{})",
                self.gaps.len(),
                self.gaps.len(),
                self.floor,
                shown.join("; "),
                if self.gaps.len() > shown.len() { "; ..." } else { "" }
            ));
        }
        if !self.shape.is_empty() {
            out.push(format!(
                "drift reports shape {}: {} call kind(s) no longer validate, in {} turn(s)",
                self.shape.len(),
                self.shape.len(),
                self.shape_turns
            ));
        }
        if self.behaviour_turns > 0 || !self.unrunnable.is_empty() {
            out.push(format!(
                "drift reports behaviour {}: {} turn(s) run but do not give the recorded result; {} session(s) could not run",
                self.behaviour_turns + self.unrunnable.len(),
                self.behaviour_turns,
                self.unrunnable.len()
            ));
        }
        out
    }

    /// The report, in counts.
    #[must_use]
    pub fn text(&self) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        let word = |same: bool| if same { "same" } else { "DIFFERENT" };
        let _ = writeln!(
            out,
            "drift of {}: {} sessions of train and val, {} turns, {} reference calls (the test split is not read)",
            self.version, self.sessions, self.turns, self.calls
        );
        let h = &self.hashes;
        let _ = writeln!(out, "\ncontract:");
        for (name, (was, now)) in [
            ("tools_hash", &h.tools),
            ("prompt_hash", &h.prompt),
            ("catalog_hash", &h.catalog),
        ] {
            let _ = writeln!(out, "  {name}: {}", word(was == now));
            if was != now {
                let _ = writeln!(out, "    data {was}\n    runtime {now}");
            }
        }
        let _ = writeln!(
            out,
            "\nshape: {} call kind(s) no longer validate, in {} turn(s)",
            self.shape.len(),
            self.shape_turns
        );
        for (key, n) in &self.shape {
            let _ = writeln!(out, "  {}: {} ({n} call(s))", key.tool, key.what);
        }
        let _ = writeln!(
            out,
            "\nbehaviour: {} turn(s) run but do not give the recorded result; {} session(s) could not run",
            self.behaviour_turns,
            self.unrunnable.len()
        );
        for (tool, n) in &self.behaviour {
            let _ = writeln!(out, "  {tool}: {n} turn(s)");
        }
        let _ = writeln!(
            out,
            "\ncoverage: {} item(s) of the current catalogue have fewer than {} example(s) in train",
            self.gaps.len(),
            self.floor
        );
        for gap in &self.gaps {
            let _ = writeln!(out, "  {} {}: {}", gap.of, gap.name, gap.examples);
        }
        for note in &self.notes {
            let _ = writeln!(out, "\n{note}");
        }
        let _ = writeln!(out, "\nlevel: {}", self.level.word());
        let _ = writeln!(out, "{}", self.level.advice());
        if self.level != Level::None {
            let _ = writeln!(
                out,
                "to accept it for now, set `stale` in crates/assist/data.json: {{\"since\": \"<what changed>\", \"level\": \"{}\"}}",
                self.level.word()
            );
        }
        out
    }
}

/// Run drift on the data version at `dir` (a built one, or fetched: worlds flat under `worlds/` or in `worlds/<split>/`):
/// read its contract from the manifest, open train and val only, replay their reference calls through this checkout's
/// runtime in the contract's tools mode, and judge.
///
/// # Errors
///
/// A manifest without a contract block (run `datagen restamp`), a split that cannot be read, or the runtime failing.
pub fn report(dir: &Path) -> Result<Drift> {
    report_at(dir, None)
}

/// [`report`] with the floor of coverage set by the caller instead of the manifest's train cell floor (at least one): the
/// publish guard reads the floor the version declares, and a hand-made version that declares none asks for none.
///
/// # Errors
///
/// As [`report`].
pub fn report_at(dir: &Path, floor: Option<usize>) -> Result<Drift> {
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("manifest.json"))
            .with_context(|| format!("no manifest.json in {}", dir.display()))?,
    )
    .context("manifest.json is not JSON")?;
    let Some(pinned) = Contract::of_manifest(&manifest) else {
        bail!(
            "the manifest has no contract block: run `datagen restamp --in {}` first",
            dir.display()
        );
    };
    let mode = ToolsMode::parse(&pinned.tools_mode).with_context(|| {
        format!(
            "the contract's tools mode `{}` is unknown",
            pinned.tools_mode
        )
    })?;
    let now = Contract::current(
        mode,
        &crate::catalog::Catalog::build()?.hash(),
        &pinned.tokenizer_blake3,
    );
    let hashes = HashDrift {
        tools: (pinned.tools_hash.clone(), now.tools_hash),
        prompt: (pinned.prompt_hash.clone(), now.prompt_hash),
        catalog: (pinned.catalog_hash.clone(), now.catalog_hash),
    };
    let catalogue = Catalogue::of_mode(mode)?;
    let source = DatagenSource::open_version(dir, &READS)?;
    let sessions = source.sessions()?;
    let replay = centraid_assist_eval::replay::replay(&source, &sessions, mode)?;
    let floor = floor.unwrap_or_else(|| {
        manifest["targets"]["cell_floor"]["train"]
            .as_u64()
            .map_or(1, |n| usize::try_from(n).unwrap_or(1))
            .max(1)
    });
    let kinds: Vec<&str> = Kind::ALL.iter().map(|k| k.name()).collect();
    let mut drift = judge(
        manifest["version"].as_str().unwrap_or("unknown"),
        hashes,
        &sessions,
        &Replayed::from(&replay),
        &catalogue,
        &kinds,
        floor,
    );
    let shipped = centraid_assist::record::record().current.tools_mode;
    if shipped != pinned.tools_mode {
        drift.notes.insert(
            0,
            format!(
                "tools mode: the runtime ships mode `{shipped}` (crates/assist/model.json), this version is mode `{}`. That is a contract difference, not a shape failure: the model this release ships was not trained on this version's tools block.",
                pinned.tools_mode
            ),
        );
    }
    Ok(drift)
}
