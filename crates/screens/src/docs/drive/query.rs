//! THE DRIVE'S REQUEST: the shelf, the three filters and the order are the
//! core's REQUEST (`docs.drive`), so changing any of them reads again. This
//! holds the filters the member chose, the keys their sheets send, and the
//! words each is drawn in.

use centraid_api_proto::core_v1 as wire;
use wire::docs_query::{Modified, Sort, TypeFilter};

use crate::strings::{Locale, docs as words};

/// A filter sheet's "any" row.
pub const ANY: &str = "any";

type Words = fn(Locale) -> String;

/// The Type sheet: its key, the filter, the core's name for it and the words.
pub const TYPES: [(&str, TypeFilter, Words); 8] = [
    ("pdf", TypeFilter::Pdf, words::type_pdf),
    ("image", TypeFilter::Image, words::type_image),
    ("word", TypeFilter::Word, words::type_word),
    ("spreadsheet", TypeFilter::Spreadsheet, words::type_spreadsheet),
    ("markdown", TypeFilter::Markdown, words::type_markdown),
    ("text", TypeFilter::Text, words::type_text),
    ("audio", TypeFilter::Audio, words::type_audio),
    ("video", TypeFilter::Video, words::type_video),
];

/// The Modified sheet: its key, the filter, the core's name for it and the words.
pub const MODIFIED: [(&str, Modified, &str, Words); 4] = [
    ("today", Modified::Today, "today", words::modified_today),
    ("7d", Modified::Last7Days, "last_7_days", words::modified_last_7_days),
    ("30d", Modified::Last30Days, "last_30_days", words::modified_last_30_days),
    ("year", Modified::ThisYear, "this_year", words::modified_this_year),
];

/// The sort sheet: its key, the sort and its direction, and the two words
/// ("Name", "A to Z") the chip and the row say.
pub const SORTS: [(&str, Sort, bool, Words, Words); 6] = [
    (
        "changed_desc",
        Sort::Changed,
        false,
        words::sort_changed,
        words::sort_newest,
    ),
    (
        "changed_asc",
        Sort::Changed,
        true,
        words::sort_changed,
        words::sort_oldest,
    ),
    ("name_asc", Sort::Name, true, words::sort_name, words::sort_a_to_z),
    ("name_desc", Sort::Name, false, words::sort_name, words::sort_z_to_a),
    ("kind_asc", Sort::Kind, true, words::sort_kind, words::sort_a_to_z),
    (
        "size_desc",
        Sort::Size,
        false,
        words::sort_size,
        words::sort_largest,
    ),
];

/// The filters and the order, as the member chose them. Carried across
/// shelves; "Clear filters" resets the three filters and keeps the order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Query {
    pub type_filter: TypeFilter,
    pub modified: Modified,
    /// One label, matched exactly; empty is none.
    pub label: String,
    pub sort: Sort,
    /// False is descending: newest changed, Z→A, largest first.
    pub ascending: bool,
}

impl Default for Query {
    fn default() -> Self {
        Self {
            type_filter: TypeFilter::Unspecified,
            modified: Modified::Unspecified,
            label: String::new(),
            sort: Sort::Changed,
            ascending: false,
        }
    }
}

impl Query {
    /// Whether any of the three filters is set.
    #[must_use]
    pub fn filtering(&self) -> bool {
        self.type_filter != TypeFilter::Unspecified
            || self.modified != Modified::Unspecified
            || !self.label.is_empty()
    }

    pub fn clear_filters(&mut self) {
        self.type_filter = TypeFilter::Unspecified;
        self.modified = Modified::Unspecified;
        self.label.clear();
    }

    /// The Type sheet's pick.
    pub fn pick_type(&mut self, key: &str) {
        self.type_filter = TYPES
            .iter()
            .find(|(k, _, _)| *k == key)
            .map_or(TypeFilter::Unspecified, |(_, filter, _)| *filter);
    }

    /// The Modified sheet's pick.
    pub fn pick_modified(&mut self, key: &str) {
        self.modified = MODIFIED
            .iter()
            .find(|(k, _, _, _)| *k == key)
            .map_or(Modified::Unspecified, |(_, filter, _, _)| *filter);
    }

    /// The sort sheet's pick; false for a key that is not one.
    pub fn pick_sort(&mut self, key: &str) -> bool {
        let Some((_, sort, ascending, _, _)) = SORTS.iter().find(|(k, ..)| *k == key) else {
            return false;
        };
        self.sort = *sort;
        self.ascending = *ascending;
        true
    }

    /// The sort sheet's key for the order in force.
    #[must_use]
    pub fn sort_key(&self) -> &'static str {
        match (self.sort, self.ascending) {
            (Sort::Name, true) => "name_asc",
            (Sort::Name, false) => "name_desc",
            (Sort::Kind, _) => "kind_asc",
            (Sort::Size, _) => "size_desc",
            (_, true) => "changed_asc",
            (_, false) => "changed_desc",
        }
    }

    /// The core's name for the Type filter, or `None` for any.
    #[must_use]
    pub fn type_param(&self) -> Option<String> {
        TYPES
            .iter()
            .find(|(_, filter, _)| *filter == self.type_filter)
            .map(|(key, _, _)| (*key).to_owned())
    }

    /// The core's name for the Modified filter, or `None` for any.
    #[must_use]
    pub fn modified_param(&self) -> Option<String> {
        MODIFIED
            .iter()
            .find(|(_, filter, _, _)| *filter == self.modified)
            .map(|(_, _, param, _)| (*param).to_owned())
    }

    /// The core's name for the order.
    #[must_use]
    pub fn sort_param(&self) -> &'static str {
        match self.sort {
            Sort::Name => "name",
            Sort::Kind => "kind",
            Sort::Size => "size",
            _ => "changed",
        }
    }

    /// The wire message a view reads.
    #[must_use]
    pub fn wire(&self) -> wire::DocsQuery {
        wire::DocsQuery {
            r#type: self.type_filter as i32,
            modified: self.modified as i32,
            label: self.label.clone(),
            sort: self.sort as i32,
            ascending: self.ascending,
        }
    }
}
