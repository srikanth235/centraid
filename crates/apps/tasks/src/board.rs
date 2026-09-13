//! THE PROMOTION RULE, as a pure fold (#1020, D-1020-S5).
//!
//! `packages/blueprints/apps/tasks/when.ts:109`-`:164`, and the sentence that
//! is the whole of it: *an unfinished child of a completed or released parent
//! is a root of its own — completing the parent must not hide remaining work.*
//!
//! Three cases, and the third is the one a port gets wrong:
//!
//! | Row | Where it goes |
//! |---|---|
//! | open, no parent | the open board, with its children nested |
//! | open, parent OPEN | nested under the parent, and **not** a root |
//! | open, parent CLOSED **or absent from the window** | **promoted** onto the open board as a root of its own |
//! | closed, no parent | the logbook, keeping only its CLOSED children so no row is drawn twice |
//! | closed, with a parent | nowhere: it is already drawn under its parent |
//!
//! **A parent the window did not fetch counts as closed**, which is why the
//! board fetches missing parents before folding: without that read, a subtask
//! whose parent fell outside the window would be promoted to a root and the
//! member would see the same work twice.

/// The logbook is what the screen shows, so the read is the screen's size.
pub const LOGBOOK_ROWS: usize = 50;

/// The manifest's declared window for `board.limit`, and **the only bound this
/// app has** (census §A7).
pub const BOARD_MIN: usize = 20;
pub const BOARD_MAX: usize = 500;
pub const BOARD_DEFAULT: usize = 500;

/// What the fold needs from a row: its identity, its parent and its status.
pub trait FamilyRow {
    fn task_id(&self) -> &str;
    fn parent_task_id(&self) -> Option<&str>;
    fn status(&self) -> &str;
}

/// The VTODO open set — the statuses the live board may act on.
#[must_use]
pub fn is_open_status(status: &str) -> bool {
    status == "needs-action" || status == "in-process"
}

/// Is this row a root of the OPEN board?
#[must_use]
pub fn is_open_board_root<Row: FamilyRow>(task: &Row, parent: Option<&Row>) -> bool {
    if !is_open_status(task.status()) {
        return false;
    }
    if task.parent_task_id().is_none() {
        return true;
    }
    // A parent the window did not fetch, or a parent that is closed: this row
    // is a root of its own.
    parent.is_none_or(|parent| !is_open_status(parent.status()))
}

/// The two shelves.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Families<Row> {
    pub open: Vec<Row>,
    pub logbook: Vec<Row>,
}

/// Fold the fetched rows into the open board and the logbook.
///
/// `decorate` is handed a row and the children it should carry; it is the
/// caller's, so this fold holds no projection at all.
pub fn nest_task_families<Row, Decorate, Out>(rows: &[Row], decorate: Decorate) -> Families<Out>
where
    Row: FamilyRow + Clone,
    Decorate: Fn(&Row, Vec<Row>) -> Out,
{
    let children_of = |parent_id: &str| -> Vec<Row> {
        rows.iter()
            .filter(|row| row.parent_task_id() == Some(parent_id))
            .cloned()
            .collect()
    };
    let mut open = Vec::new();
    let mut logbook = Vec::new();
    for row in rows {
        let parent = row.parent_task_id().and_then(|parent_id| {
            rows.iter()
                .find(|candidate| candidate.task_id() == parent_id)
        });
        if is_open_board_root(row, parent) {
            open.push(decorate(row, children_of(row.task_id())));
            continue;
        }
        // A closed row with a parent is already drawn under it; an open row
        // with an open parent is nested rather than listed.
        if row.parent_task_id().is_some() || is_open_status(row.status()) {
            continue;
        }
        let closed_children: Vec<Row> = children_of(row.task_id())
            .into_iter()
            .filter(|child| !is_open_status(child.status()))
            .collect();
        logbook.push(decorate(row, closed_children));
    }
    Families { open, logbook }
}

/// The open board's order: **due first, then priority, then title**.
///
/// Priority is Todoist's — higher is more urgent, and `0` is unset, so it
/// sorts last (`board.ts:460`-`:471`).
///
/// **NULLS LAST, THEN BY PRIMARY KEY** (#1020, lane V's nullable-sort finding,
/// adopted here and by People). v0 leaves a full tie to `toSorted`'s
/// stability, which is the order the read happened to return — a fact about
/// the page, not about the data. The pk tiebreak only fires where v0's answer
/// was arbitrary, and it makes the board's order reproducible.
#[must_use]
pub fn by_urgency(
    left: (Option<&str>, i64, &str, &str),
    right: (Option<&str>, i64, &str, &str),
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (left_due, left_priority, left_title, left_id) = left;
    let (right_due, right_priority, right_title, right_id) = right;
    match (left_due, right_due) {
        (None, Some(_)) => return Ordering::Greater,
        (Some(_), None) => return Ordering::Less,
        (Some(left_due), Some(right_due)) if left_due != right_due => {
            return left_due.cmp(right_due);
        }
        _ => {}
    }
    right_priority
        .cmp(&left_priority)
        .then_with(|| left_title.cmp(right_title))
        .then_with(|| left_id.cmp(right_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Row {
        id: &'static str,
        parent: Option<&'static str>,
        status: &'static str,
    }

    impl FamilyRow for Row {
        fn task_id(&self) -> &str {
            self.id
        }
        fn parent_task_id(&self) -> Option<&str> {
            self.parent
        }
        fn status(&self) -> &str {
            self.status
        }
    }

    const fn row(id: &'static str, parent: Option<&'static str>, status: &'static str) -> Row {
        Row { id, parent, status }
    }

    fn fold(rows: &[Row]) -> (Vec<&'static str>, Vec<&'static str>, Vec<Vec<&'static str>>) {
        let families = nest_task_families(rows, |task, children| {
            (
                task.id,
                children
                    .into_iter()
                    .map(|child| child.id)
                    .collect::<Vec<_>>(),
            )
        });
        (
            families.open.iter().map(|(id, _)| *id).collect(),
            families.logbook.iter().map(|(id, _)| *id).collect(),
            families
                .open
                .iter()
                .map(|(_, children)| children.clone())
                .chain(
                    families
                        .logbook
                        .iter()
                        .map(|(_, children)| children.clone()),
                )
                .collect(),
        )
    }

    #[test]
    fn an_open_parent_keeps_its_children_nested() {
        let rows = [
            row("parent", None, "needs-action"),
            row("child", Some("parent"), "needs-action"),
        ];
        let (open, logbook, children) = fold(&rows);
        assert_eq!(open, ["parent"], "the child is not a second root");
        assert!(logbook.is_empty());
        assert_eq!(children, [vec!["child"]]);
    }

    #[test]
    fn an_unfinished_child_of_a_completed_parent_is_promoted() {
        let rows = [
            row("parent", None, "completed"),
            row("open-child", Some("parent"), "needs-action"),
            row("done-child", Some("parent"), "completed"),
        ];
        let (open, logbook, children) = fold(&rows);
        assert_eq!(
            open,
            ["open-child"],
            "completing the parent must not hide it"
        );
        assert_eq!(logbook, ["parent"]);
        // THE LOGBOOK PARENT KEEPS ONLY ITS CLOSED CHILDREN, so no row is
        // drawn twice.
        assert_eq!(children[1], vec!["done-child"]);
    }

    #[test]
    fn a_cancelled_parent_releases_its_children_too() {
        let rows = [
            row("parent", None, "cancelled"),
            row("child", Some("parent"), "in-process"),
        ];
        let (open, logbook, _) = fold(&rows);
        assert_eq!(open, ["child"]);
        assert_eq!(logbook, ["parent"]);
    }

    #[test]
    fn a_parent_outside_the_window_promotes_its_child_rather_than_hiding_it() {
        let rows = [row("orphan", Some("absent"), "needs-action")];
        let (open, logbook, _) = fold(&rows);
        assert_eq!(open, ["orphan"], "a parent nobody fetched counts as closed");
        assert!(logbook.is_empty());
    }

    #[test]
    fn a_closed_child_is_never_a_logbook_entry_of_its_own() {
        let rows = [
            row("parent", None, "needs-action"),
            row("done-child", Some("parent"), "completed"),
        ];
        let (open, logbook, children) = fold(&rows);
        assert_eq!(open, ["parent"]);
        assert!(logbook.is_empty(), "it is already drawn under its parent");
        assert_eq!(children, [vec!["done-child"]]);
    }

    #[test]
    fn the_open_order_is_due_first_then_priority_then_title() {
        let mut rows = [
            (None, 0_i64, "no date", "t4"),
            (Some("2026-03-05"), 1, "later", "t3"),
            (Some("2026-03-01"), 1, "soonest", "t1"),
            (Some("2026-03-05"), 5, "urgent", "t2"),
        ];
        rows.sort_by(|left, right| by_urgency(*left, *right));
        let titles: Vec<&str> = rows.iter().map(|(_, _, title, _)| *title).collect();
        assert_eq!(titles, ["soonest", "urgent", "later", "no date"]);
    }

    #[test]
    fn an_undated_task_sorts_last_and_ties_break_on_the_primary_key() {
        let mut rows = [
            (None, 0_i64, "same", "t9"),
            (None, 0, "same", "t1"),
            (Some("2026-03-01"), 0, "dated", "t5"),
        ];
        rows.sort_by(|left, right| by_urgency(*left, *right));
        let ids: Vec<&str> = rows.iter().map(|(_, _, _, id)| *id).collect();
        assert_eq!(ids, ["t5", "t1", "t9"]);
    }
}
