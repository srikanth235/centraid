//! THE FOLDER TREE, drawn: a rail node, the crumbs above a folder or a document,
//! and the Move sheet's "Taxes / 2026".
//!
//! **The walk from a folder up to the top is `centraid_apps_docs::folder_path`**
//! and nothing here walks a parent chain of its own: the core's answer for a
//! document's path, a folder page's crumbs and a Move sheet's labels are one
//! computation, with one cycle guard (#1135).

use centraid_api_proto::core_v1 as wire;
use centraid_apps_docs::{FolderNode, folder_path};

use super::{fold, routes};
use crate::strings::{Locale, docs as words};

/// A folder as the tree walk sees it.
#[derive(Clone, Debug)]
struct Node {
    id: String,
    name: String,
    parent: Option<String>,
}

impl FolderNode for Node {
    fn node_id(&self) -> &str {
        &self.id
    }

    fn parent_node(&self) -> Option<&str> {
        self.parent.as_deref()
    }
}

fn tree(folders: &[wire::DocsFolder]) -> Vec<Node> {
    folders
        .iter()
        .map(|folder| Node {
            id: folder.folder_id.clone(),
            name: folder.name.clone(),
            parent: Some(folder.parent_id.clone()).filter(|parent| !parent.is_empty()),
        })
        .collect()
}

fn label(locale: Locale, name: &str) -> String {
    if name.trim().is_empty() {
        words::untitled(locale)
    } else {
        name.to_owned()
    }
}

/// Every rail folder, as a node a tap opens. `parent` is the title of the page
/// that draws it: the folder page's back word.
#[must_use]
pub fn nodes(
    locale: Locale,
    folders: &[wire::DocsFolder],
    parent: &str,
) -> Vec<wire::DocsFolderNode> {
    folders
        .iter()
        .map(|folder| node(locale, folder, parent))
        .collect()
}

#[must_use]
pub fn node(locale: Locale, folder: &wire::DocsFolder, parent: &str) -> wire::DocsFolderNode {
    let name = label(locale, &folder.name);
    let count = if folder.document_count == 0 {
        words::folder_empty_count(locale)
    } else {
        fold::count_label(locale, folder.document_count)
    };
    wire::DocsFolderNode {
        folder_id: folder.folder_id.clone(),
        accessibility_label: format!("{name}, {count}"),
        route: Some(routes::folder(&folder.folder_id, &name, parent)),
        count_label: count,
        name,
    }
}

/// The crumbs of a document's folder path (the core's `path`, top first). A tap
/// opens that folder, pushed from the page titled `parent`.
#[must_use]
pub fn path_crumbs(
    locale: Locale,
    path: &[wire::DocsFolder],
    parent: &str,
) -> Vec<wire::DocsCrumb> {
    path.iter()
        .map(|folder| crumb(locale, &folder.folder_id, &folder.name, parent))
        .collect()
}

fn crumb(locale: Locale, folder_id: &str, name: &str, parent: &str) -> wire::DocsCrumb {
    let name = label(locale, name);
    wire::DocsCrumb {
        folder_id: folder_id.to_owned(),
        route: Some(routes::folder(folder_id, &name, parent)),
        name,
    }
}

/// The crumbs down to `folder_id` through the rail's parents, top first. Empty
/// at the top level.
#[must_use]
pub fn rail_crumbs(
    locale: Locale,
    folders: &[wire::DocsFolder],
    folder_id: &str,
    parent: &str,
) -> Vec<wire::DocsCrumb> {
    if folder_id.is_empty() {
        return Vec::new();
    }
    folder_path(&tree(folders), Some(folder_id))
        .iter()
        .map(|node| crumb(locale, &node.id, &node.name, parent))
        .collect()
}

/// The Move sheet: the top level, then every folder by its path, sorted.
#[must_use]
pub fn move_choices(
    locale: Locale,
    folders: &[wire::DocsFolder],
    current: &str,
) -> Vec<wire::DocsChoice> {
    let nodes = tree(folders);
    let mut choices: Vec<wire::DocsChoice> = nodes
        .iter()
        .map(|node| {
            let path = folder_path(&nodes, Some(&node.id))
                .iter()
                .map(|step| label(locale, &step.name))
                .collect::<Vec<_>>()
                .join(" / ");
            wire::DocsChoice {
                key: node.id.clone(),
                label: path,
                detail: String::new(),
                selected: node.id == current,
            }
        })
        .collect();
    choices.sort_by_key(|choice| choice.label.to_lowercase());
    choices.insert(
        0,
        wire::DocsChoice {
            key: TOP_LEVEL.to_owned(),
            label: words::move_top(locale),
            detail: String::new(),
            selected: current.is_empty(),
        },
    );
    choices
}

/// The Move sheet's key for the drive's top level (a folder id is never empty).
pub const TOP_LEVEL: &str = "top";

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(id: &str, name: &str, parent: &str) -> wire::DocsFolder {
        wire::DocsFolder {
            folder_id: id.to_owned(),
            name: name.to_owned(),
            parent_id: parent.to_owned(),
            document_count: 0,
        }
    }

    #[test]
    fn the_move_sheet_names_a_folder_by_its_path_and_a_cycle_terminates() {
        let folders = [
            folder("a", "Taxes", ""),
            folder("b", "2026", "a"),
            folder("x", "Loop", "y"),
            folder("y", "Back", "x"),
        ];
        let choices = move_choices(Locale::En, &folders, "b");
        assert_eq!(choices[0].key, "top");
        assert!(!choices[0].selected);
        let labels: Vec<&str> = choices.iter().map(|c| c.label.as_str()).collect();
        assert!(labels.contains(&"Taxes / 2026"), "{labels:?}");
        assert!(choices.iter().find(|c| c.key == "b").unwrap().selected);
    }

    #[test]
    fn crumbs_run_from_the_top_down() {
        let folders = [folder("a", "Taxes", ""), folder("b", "2026", "a")];
        let crumbs = rail_crumbs(Locale::En, &folders, "b", "Docs");
        let names: Vec<&str> = crumbs.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Taxes", "2026"]);
        assert!(rail_crumbs(Locale::En, &folders, "", "Docs").is_empty());
    }
}
