//! THE ONE FILTER AND SORT MENU (DESIGN.md, `AppPlace`): the header's filter
//! button opens a menu Rust finishes, in place of the chip row that stood under
//! the header. An app builds its sections here and puts the result on its state;
//! the shell draws it with the platform's menu and sends a pick back as
//! `FilterMenuPicked`, which the app's `update` reads with [`Pick::of`].
//!
//! The kit owns the words that are not the app's (Clear filters, the button's
//! spoken label) and the one rule the shells cannot decide: whether the button is
//! lit. That is `filtering`, and it is set by the app from its own state, because
//! only the app knows which of its sections narrow the list. A sort is not a
//! filter, so no sort ever sets it.

use centraid_api_proto::core_v1 as wire;
use wire::menu_section::Kind;

use crate::strings::{Locale, fill, shared};

/// The key an app gives its sort section. A menu with one reads "Filter and
/// sort" to a screen reader and a menu without reads "Filter".
pub const SORT: &str = "sort";

/// One option: `selected` says whether it is checked now.
#[must_use]
pub fn option(
    key: impl Into<String>,
    label: impl Into<String>,
    selected: bool,
) -> wire::MenuOption {
    wire::MenuOption {
        key: key.into(),
        label: label.into(),
        count: 0,
        selected,
    }
}

/// An option with the number of rows it holds beside its label (0 draws none).
#[must_use]
pub fn counted(
    key: impl Into<String>,
    label: impl Into<String>,
    count: u32,
    selected: bool,
) -> wire::MenuOption {
    wire::MenuOption {
        count,
        ..option(key, label, selected)
    }
}

fn section(
    key: &str,
    title: String,
    kind: Kind,
    options: Vec<wire::MenuOption>,
) -> wire::MenuSection {
    wire::MenuSection {
        key: key.to_owned(),
        title,
        kind: kind as i32,
        options,
        nested: false,
        summary: String::new(),
    }
}

/// A section where exactly one option is checked.
#[must_use]
pub fn single(key: &str, title: String, options: Vec<wire::MenuOption>) -> wire::MenuSection {
    section(key, title, Kind::Single, options)
}

/// A section where any number of options are checked.
#[must_use]
pub fn multi(key: &str, title: String, options: Vec<wire::MenuOption>) -> wire::MenuSection {
    section(key, title, Kind::Multi, options)
}

/// The section drawn as a menu of its own, with `summary` (its current value in a
/// word) beside its title. Two levels deep, never more.
#[must_use]
pub fn nested(mut section: wire::MenuSection, summary: String) -> wire::MenuSection {
    section.nested = true;
    section.summary = summary;
    section
}

/// The menu: `sections` in order, lit when `filtering`. The words that are the
/// kit's (Clear filters, the button's spoken label) are filled here.
#[must_use]
pub fn menu(locale: Locale, sections: Vec<wire::MenuSection>, filtering: bool) -> wire::FilterMenu {
    let base = if sections.iter().any(|section| section.key == SORT) {
        shared::kit_filter_sort(locale)
    } else {
        shared::kit_filter(locale)
    };
    let spoken = if filtering {
        fill(&shared::kit_filter_on(locale), &[("label", &base)])
    } else {
        base
    };
    wire::FilterMenu {
        sections,
        filtering,
        clear_label: shared::kit_clear_filters(locale),
        spoken,
    }
}

/// A menu with nothing in it is not drawn: no sections is no button.
#[must_use]
pub fn is_empty(menu: &wire::FilterMenu) -> bool {
    menu.sections
        .iter()
        .all(|section| section.options.is_empty())
}

/// A pick, read back: borrowed keys an app matches on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pick<'a> {
    pub section: &'a str,
    pub option: &'a str,
}

impl<'a> Pick<'a> {
    #[must_use]
    pub fn of(picked: &'a wire::FilterMenuPicked) -> Self {
        Self {
            section: &picked.section_key,
            option: &picked.option_key,
        }
    }
}

/// The section with `key`, for a test or a caller reading its own menu back.
#[must_use]
pub fn find<'a>(menu: &'a wire::FilterMenu, key: &str) -> Option<&'a wire::MenuSection> {
    menu.sections.iter().find(|section| section.key == key)
}

/// The keys of the options checked in `section`, in order.
#[must_use]
pub fn checked(section: &wire::MenuSection) -> Vec<&str> {
    section
        .options
        .iter()
        .filter(|option| option.selected)
        .map(|option| option.key.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_menu_with_a_sort_says_filter_and_sort() {
        let built = menu(
            Locale::En,
            vec![single(
                SORT,
                "Sort".to_owned(),
                vec![option("a", "A", true)],
            )],
            false,
        );
        assert_eq!(built.spoken, "Filter and sort");
        assert!(!built.filtering);
        assert_eq!(built.clear_label, "Clear filters");
    }

    #[test]
    fn a_menu_without_a_sort_says_filter_and_a_lit_one_says_on() {
        let built = menu(
            Locale::En,
            vec![single(
                "kind",
                "Show".to_owned(),
                vec![option("a", "A", true)],
            )],
            true,
        );
        assert_eq!(built.spoken, "Filter, on");
        assert!(built.filtering);
    }

    #[test]
    fn a_nested_section_carries_its_summary_and_checked_options_read_back() {
        let nested = nested(
            single(
                "type",
                "Type".to_owned(),
                vec![option("any", "Any type", false), option("pdf", "PDF", true)],
            ),
            "PDF".to_owned(),
        );
        assert!(nested.nested);
        assert_eq!(nested.summary, "PDF");
        assert_eq!(checked(&nested), vec!["pdf"]);
    }

    #[test]
    fn an_empty_menu_is_not_drawn() {
        assert!(is_empty(&menu(Locale::En, Vec::new(), false)));
        assert!(!is_empty(&menu(
            Locale::En,
            vec![multi(
                "t",
                "Tags".to_owned(),
                vec![counted("x", "X", 2, false)]
            )],
            false
        )));
    }
}
