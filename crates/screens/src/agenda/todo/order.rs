//! DRAG TO REORDER (#1173): which positions a drop writes.
//!
//! A list's manual order is the whole-number `position` of its tasks
//! (the wire's `sort_order` is that position rounded, so a half-way place
//! between two rows would not survive a read). A drop therefore renumbers the
//! group `1, 2, 3 ...` in its new order and writes only the rows whose place
//! changed. Tasks never placed by hand carry `0`, so the first drop in a group
//! writes every row of it once, and the next writes the one or two that moved.

/// The writes a drop makes: `(task id, new position)`, in group order.
///
/// `group` is the group's roots as drawn, each with its current position;
/// `moved` is dropped just before `before` (an empty `before`, or one the group
/// does not hold, is the end of the group). A drop that changes nothing, and
/// a `moved` the group does not hold, write nothing.
#[must_use]
pub fn plan(group: &[(String, i64)], moved: &str, before: &str) -> Vec<(String, f64)> {
    if !group.iter().any(|(id, _)| id == moved) || before == moved {
        return Vec::new();
    }
    let mut order: Vec<&(String, i64)> = group.iter().filter(|(id, _)| id != moved).collect();
    let at = order
        .iter()
        .position(|(id, _)| id == before)
        .unwrap_or(order.len());
    let Some(held) = group.iter().find(|(id, _)| id == moved) else {
        return Vec::new();
    };
    order.insert(at, held);
    order
        .iter()
        .enumerate()
        .filter_map(|(index, (id, current))| {
            let place = i64::try_from(index + 1).unwrap_or(i64::MAX);
            (*current != place).then(|| (id.clone(), place as f64))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(ids: &[(&str, i64)]) -> Vec<(String, i64)> {
        ids.iter().map(|(id, at)| ((*id).to_owned(), *at)).collect()
    }

    fn writes(plan: &[(String, f64)]) -> Vec<(&str, i64)> {
        plan.iter()
            .map(|(id, at)| (id.as_str(), *at as i64))
            .collect()
    }

    #[test]
    fn the_first_drop_in_a_group_numbers_every_row() {
        let rows = group(&[("a", 0), ("b", 0), ("c", 0)]);
        // c dropped before a.
        assert_eq!(
            writes(&plan(&rows, "c", "a")),
            [("c", 1), ("a", 2), ("b", 3)]
        );
    }

    #[test]
    fn a_later_drop_writes_only_the_rows_that_changed_place() {
        let rows = group(&[("a", 1), ("b", 2), ("c", 3), ("d", 4)]);
        // b to the end: c and d each move up one, b goes last.
        assert_eq!(
            writes(&plan(&rows, "b", "")),
            [("c", 2), ("d", 3), ("b", 4)]
        );
        // d before c: two rows swap.
        assert_eq!(writes(&plan(&rows, "d", "c")), [("d", 3), ("c", 4)]);
    }

    #[test]
    fn dropping_a_row_where_it_is_writes_nothing() {
        let rows = group(&[("a", 1), ("b", 2), ("c", 3)]);
        assert!(plan(&rows, "b", "c").is_empty(), "before its own next row");
        assert!(plan(&rows, "c", "").is_empty(), "the last row to the end");
        assert!(plan(&rows, "b", "b").is_empty());
    }

    #[test]
    fn a_row_or_a_neighbour_the_group_does_not_hold() {
        let rows = group(&[("a", 1), ("b", 2)]);
        assert!(plan(&rows, "ghost", "a").is_empty());
        // An unknown neighbour is the end of the group.
        assert_eq!(writes(&plan(&rows, "a", "ghost")), [("b", 1), ("a", 2)]);
    }
}
