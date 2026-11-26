//! THE KIND REGISTRY (app-plane §8): one row per vault entity kind, every promise it keeps
//! declared once. The registry test fails a kind whose row is wrong against the vault's own
//! tables (`entity_kind`, `home_shape`, `source_shape`), and a kind that leaves a promise
//! unanswered. A promise that does not apply says so, with its reason.

/// What an earlier-versions page, an export and a share are handed to format.
#[derive(Debug, Clone, Copy)]
pub struct Shown<'a> {
    /// The kind's noun: "note", "transaction".
    pub noun: &'a str,
    pub title: &'a str,
    /// The kind's text, when it has one: a note's body, a document's extracted text.
    pub text: Option<&'a str>,
}

/// A finished sentence or file of plain text for one item.
pub type Formatter = fn(&Shown<'_>) -> String;

/// What a holder holds, and the `Aggregate` reads that count it, each answering one [`Held`]
/// row per kind. The count is the number a confirm names: "and its 12 notes" (N11).
///
/// [`Held`]: crate::apps::Held
#[derive(Debug, Clone, Copy)]
pub struct Holder {
    /// Kinds it holds.
    pub holds: &'static [&'static str],
    /// The reads that count what it holds, by name.
    pub counts: &'static [&'static str],
}

/// Whether a kind is held by something, and what it may be held in.
#[derive(Debug, Clone, Copy)]
pub struct Home {
    /// Kinds it may sit in (`home_shape`); empty when its home is not a place.
    pub sits_in: &'static [&'static str],
    /// Whether it may stand with no home at the top.
    pub top: bool,
    /// Whether a photo or document captured inside an item of this kind may be homed in it (S12).
    pub capture: bool,
}

/// A block a record draws below its facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Footer {
    Attachments,
    Linked,
    MentionedIn,
    Origin,
    /// "Phone says" / "Statement says": only where a store is followed.
    Says,
}

/// How a kind's earlier versions read on the versions page.
#[derive(Debug, Clone, Copy)]
pub enum Versions {
    /// The kind keeps earlier versions, and this words one.
    Kept(Formatter),
    /// It keeps none, and why.
    None(&'static str),
}

/// How a kind leaves the vault as a portable file.
#[derive(Debug, Clone, Copy)]
pub enum Export {
    /// A file of its own: the format's header (a version, D12) and its words.
    File {
        header: &'static str,
        format: Formatter,
    },
    /// It leaves inside another kind's file, or `"vault"` for the whole-vault export only.
    Within(&'static str),
}

/// What the OS share sheet is handed.
#[derive(Debug, Clone, Copy)]
pub enum Share {
    Payload(Formatter),
    /// It cannot be shared, and why.
    Never(&'static str),
}

/// Where a kind's Trash list is read.
#[derive(Debug, Clone, Copy)]
pub enum Trash {
    /// A `PagedList` read of the app's trash that names this kind.
    Listed(&'static str),
    /// A delete takes it straight out, and why.
    Purged(&'static str),
}

/// One entity kind, and what it owes a member.
#[derive(Debug, Clone, Copy)]
pub struct KindDecl {
    /// The vault's code for the kind.
    pub id: &'static str,
    /// The app whose module declares it.
    pub app: &'static str,
    /// The noun trash and Undo say: P9.
    pub noun: &'static str,
    /// Its plural, for a count.
    pub plural: &'static str,
    /// What it holds, if it is a holder: P9 (N11).
    pub holder: Option<Holder>,
    pub home: Home,
    /// P1.
    pub versions: Versions,
    /// P4.
    pub export: Export,
    /// P4.
    pub share: Share,
    /// P8, P3.
    pub footers: &'static [Footer],
    /// P9.
    pub trash: Trash,
}

/// "Earlier versions of this note": the words the versions block says.
#[must_use]
pub fn earlier_versions(shown: &Shown<'_>) -> String {
    format!("Earlier versions of this {}", shown.noun)
}

/// A title, then its text, as plain words: what a share sheet is handed.
#[must_use]
pub fn plain(shown: &Shown<'_>) -> String {
    match shown.text.filter(|text| !text.trim().is_empty()) {
        Some(text) => format!("{}\n\n{text}", shown.title),
        None => shown.title.to_owned(),
    }
}

/// A title and its text as an export file's body.
#[must_use]
pub fn exported(shown: &Shown<'_>) -> String {
    plain(shown)
}

impl KindDecl {
    /// A kind that sits at the top, keeps its versions, leaves in the whole-vault export only and
    /// is not shared. Each builder below says what it does differently.
    #[must_use]
    pub const fn new(
        id: &'static str,
        app: &'static str,
        noun: &'static str,
        plural: &'static str,
        trash: Trash,
    ) -> Self {
        Self {
            id,
            app,
            noun,
            plural,
            holder: None,
            home: Home {
                sits_in: &[],
                top: true,
                capture: false,
            },
            versions: Versions::Kept(earlier_versions),
            export: Export::Within("vault"),
            share: Share::Never("only an item is handed to the share sheet"),
            footers: &[],
            trash,
        }
    }

    /// It holds `holds`, counted by `counts`.
    #[must_use]
    pub const fn holds(
        mut self,
        holds: &'static [&'static str],
        counts: &'static [&'static str],
    ) -> Self {
        self.holder = Some(Holder { holds, counts });
        self
    }

    /// It sits in these kinds (`home_shape`).
    #[must_use]
    pub const fn sits_in(mut self, homes: &'static [&'static str]) -> Self {
        self.home.sits_in = homes;
        self
    }

    /// It cannot stand with no home.
    #[must_use]
    pub const fn not_top(mut self) -> Self {
        self.home.top = false;
        self
    }

    /// A photo or document captured inside one may be homed in it.
    #[must_use]
    pub const fn takes_captures(mut self) -> Self {
        self.home.capture = true;
        self
    }

    #[must_use]
    pub const fn footers(mut self, footers: &'static [Footer]) -> Self {
        self.footers = footers;
        self
    }

    #[must_use]
    pub const fn exports(mut self, export: Export) -> Self {
        self.export = export;
        self
    }

    #[must_use]
    pub const fn shares(mut self, share: Share) -> Self {
        self.share = share;
        self
    }
}
